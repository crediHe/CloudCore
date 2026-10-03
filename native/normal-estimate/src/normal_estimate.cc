#include "normal_estimate.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "normal_compressor.h"

namespace normal_estimate {

namespace {

/** 半径放大因子（CC：2^(1/4)）与放大上限（16 倍）。 */
constexpr double kRadiusGrowth = 1.189207115;
constexpr double kRadiusMaxFactor = 16.0;

/** 各模型的邻域点数下限（含查询点自身），CC ccNormalVectors.cpp:40-45 的硬常量。 */
constexpr std::uint32_t kMinPointsLS = 3;
constexpr std::uint32_t kMinPointsQuadric = 6;

// ============================================================================
// 空间网格原语：照抄 native/radius-filter/src/radius_filter.cc:12-64（模块间无共享库，
// 按仓库惯例复制一份；改这里不必回头改那边，但语义要一致）。
// ============================================================================

/** 网格格坐标（三轴均为已 floor 到格边长的整数格号）。 */
struct CellKey {
  std::int64_t ix;
  std::int64_t iy;
  std::int64_t iz;
  bool operator==(const CellKey& o) const {
    return ix == o.ix && iy == o.iy && iz == o.iz;
  }
};

/** 格坐标哈希（FNV-1a 混合）。 */
struct CellKeyHash {
  std::size_t operator()(const CellKey& k) const {
    std::uint64_t h = 1469598103934665603ull;
    h = (h ^ static_cast<std::uint64_t>(k.ix)) * 1099511628211ull;
    h = (h ^ static_cast<std::uint64_t>(k.iy)) * 1099511628211ull;
    h = (h ^ static_cast<std::uint64_t>(k.iz)) * 1099511628211ull;
    return static_cast<std::size_t>(h ^ (h >> 32));
  }
};

using Bucket = std::vector<std::uint64_t>;
using GridMap = std::unordered_map<CellKey, Bucket, CellKeyHash>;

/**
 * 候选点全局编码：高 32 位 = 块下标，低 32 位 = 该块内候选序号。
 * 桶内只存编码，坐标仍读自块原始缓冲（零拷贝）。
 */
constexpr unsigned CHUNK_SHIFT = 32;

inline std::uint64_t encodeCandidate(std::uint32_t chunk, std::uint32_t local) {
  return (static_cast<std::uint64_t>(chunk) << CHUNK_SHIFT) | local;
}

/** 候选总数（index 为空 = 全量顶点）。 */
inline std::uint32_t candidateCountOfChunk(const ChunkSource& src) {
  return src.index ? src.indexCount : src.vertexCount;
}

/** 由候选取该点坐标（xyz 输出，double）。 */
inline void candidateXyz(const ChunkSource& src, std::uint32_t local, double* x, double* y,
                         double* z) {
  const std::uint32_t vertex = src.index ? src.index[local] : local;
  const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
  *x = static_cast<double>(p[0]);
  *y = static_cast<double>(p[1]);
  *z = static_cast<double>(p[2]);
}

/** 均匀空间哈希网格：格边长固定，格号按全局最小值偏移（省格号位宽）。 */
struct Grid {
  GridMap map;
  double cellSize = 1.0;
  std::int64_t minIx = 0;
  std::int64_t minIy = 0;
  std::int64_t minIz = 0;
};

/** 格号（已减偏移）。 */
inline std::int64_t cellCoord(double v, double cellSize, std::int64_t offset) {
  return static_cast<std::int64_t>(std::floor(v / cellSize)) - offset;
}

/** 覆盖半径 r 需要的格数（每轴 ±span）。 */
inline std::int64_t spanOf(double r, double cellSize) {
  const std::int64_t s = static_cast<std::int64_t>(std::ceil(r / cellSize));
  return s < 1 ? 1 : s;
}

/**
 * 建网格（串行，两次内存顺序扫描：先定格号跨度、再入桶）。cellSize <= 0 时返回空网格。
 */
Grid buildGrid(const EntitySource& entity, double cellSize) {
  Grid grid;
  grid.cellSize = cellSize;
  if (!(cellSize > 0.0)) return grid;

  bool first = true;
  std::int64_t minIx = 0;
  std::int64_t maxIx = 0;
  std::int64_t minIy = 0;
  std::int64_t maxIy = 0;
  std::int64_t minIz = 0;
  std::int64_t maxIz = 0;
  std::size_t total = 0;
  for (const ChunkSource& src : entity.chunks) {
    const std::uint32_t n = candidateCountOfChunk(src);
    total += n;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      const auto ix = static_cast<std::int64_t>(std::floor(x / cellSize));
      const auto iy = static_cast<std::int64_t>(std::floor(y / cellSize));
      const auto iz = static_cast<std::int64_t>(std::floor(z / cellSize));
      if (first) {
        minIx = maxIx = ix;
        minIy = maxIy = iy;
        minIz = maxIz = iz;
        first = false;
      } else {
        minIx = std::min(minIx, ix);
        maxIx = std::max(maxIx, ix);
        minIy = std::min(minIy, iy);
        maxIy = std::max(maxIy, iy);
        minIz = std::min(minIz, iz);
        maxIz = std::max(maxIz, iz);
      }
    }
  }
  if (first) return grid;  // 无候选点

  grid.minIx = minIx;
  grid.minIy = minIy;
  grid.minIz = minIz;
  grid.map.reserve(total / 4 + 1);
  for (std::size_t c = 0; c < entity.chunks.size(); ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = candidateCountOfChunk(src);
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      grid.map[CellKey{cellCoord(x, cellSize, minIx), cellCoord(y, cellSize, minIy),
                       cellCoord(z, cellSize, minIz)}]
          .push_back(encodeCandidate(static_cast<std::uint32_t>(c), i));
    }
  }
  return grid;
}

/**
 * 球邻域查询：把 d² ≤ radius² 的候选点坐标（3 double/点）重填进 coords（含查询点自身）。
 *
 * 每轴扫 ±span 个格，格内逐点精确判距——球查询是精确的，网格只是取邻居的手段。
 * 半径放大时**整球重查**（对齐 CC `findNeighborsInASphereStartingFromCell` 的重复调用）：
 * 半径变大后，原先落在球外、但位于已访问格内的点可能进入球内，因此不能只扫新增的格环。
 *
 * @return 球内的点数
 */
std::uint32_t collectSphere(const Grid& grid, const EntitySource& entity, double px, double py,
                            double pz, double radius, std::vector<double>& coords) {
  coords.clear();
  if (grid.map.empty()) return 0;
  const double r2 = radius * radius;
  const std::int64_t cx = cellCoord(px, grid.cellSize, grid.minIx);
  const std::int64_t cy = cellCoord(py, grid.cellSize, grid.minIy);
  const std::int64_t cz = cellCoord(pz, grid.cellSize, grid.minIz);
  const std::int64_t span = spanOf(radius, grid.cellSize);
  std::uint32_t found = 0;
  for (std::int64_t dz = -span; dz <= span; ++dz) {
    for (std::int64_t dy = -span; dy <= span; ++dy) {
      for (std::int64_t dx = -span; dx <= span; ++dx) {
        const auto it = grid.map.find(CellKey{cx + dx, cy + dy, cz + dz});
        if (it == grid.map.end()) continue;
        for (const std::uint64_t code : it->second) {
          const auto qChunk = static_cast<std::uint32_t>(code >> CHUNK_SHIFT);
          const auto qLocal = static_cast<std::uint32_t>(code & 0xffffffffu);
          double qx, qy, qz;
          candidateXyz(entity.chunks[qChunk], qLocal, &qx, &qy, &qz);
          const double ddx = qx - px;
          const double ddy = qy - py;
          const double ddz = qz - pz;
          if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) {
            coords.push_back(qx);
            coords.push_back(qy);
            coords.push_back(qz);
            ++found;
          }
        }
      }
    }
  }
  return found;
}

// ============================================================================
// 线性代数小工具
// ============================================================================

/**
 * 对称 3×3 的雅可比特征分解：输出特征值升序 d[0..2] 与对应单位特征向量（v 的**列**）。
 *
 * 收敛判据用相对阈值（非对角元和 ≤ 1e-18 × 对角元和），对任意量级的协方差矩阵都稳定；
 * 固定最多 32 轮扫描，保证确定性。全零矩阵直接跳过——特征向量保持单位阵（与 CCCoreLib 同），
 * 于是退化邻域也得到一个合法单位法向而非 NaN。
 */
void jacobiEigen3(double a[3][3], double d[3], double v[3][3]) {
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      v[i][j] = (i == j) ? 1.0 : 0.0;
    }
  }

  for (int sweep = 0; sweep < 32; ++sweep) {
    const double off = std::fabs(a[0][1]) + std::fabs(a[0][2]) + std::fabs(a[1][2]);
    const double diag = std::fabs(a[0][0]) + std::fabs(a[1][1]) + std::fabs(a[2][2]);
    if (off <= 1e-18 * (diag + 1e-300)) break;

    for (int p = 0; p < 2; ++p) {
      for (int q = p + 1; q < 3; ++q) {
        const double apq = a[p][q];
        if (apq == 0.0) continue;
        const double theta = (a[q][q] - a[p][p]) / (2.0 * apq);
        const double t =
            (theta >= 0 ? 1.0 : -1.0) / (std::fabs(theta) + std::sqrt(theta * theta + 1.0));
        const double c = 1.0 / std::sqrt(t * t + 1.0);
        const double s = t * c;
        // A ← Jᵀ A J（J 只在 p/q 两行两列上非平凡）
        for (int k = 0; k < 3; ++k) {
          const double akp = a[k][p];
          const double akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (int k = 0; k < 3; ++k) {
          const double apk = a[p][k];
          const double aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (int k = 0; k < 3; ++k) {
          const double vkp = v[k][p];
          const double vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  for (int i = 0; i < 3; ++i) d[i] = a[i][i];

  // 升序排序（同时置换特征向量列）——3 个元素的选择排序
  int order[3] = {0, 1, 2};
  for (int i = 0; i < 2; ++i) {
    int best = i;
    for (int j = i + 1; j < 3; ++j) {
      if (d[order[j]] < d[order[best]]) best = j;
    }
    std::swap(order[i], order[best]);
  }
  double dSorted[3];
  double vSorted[3][3];
  for (int i = 0; i < 3; ++i) {
    dSorted[i] = d[order[i]];
    for (int k = 0; k < 3; ++k) vSorted[k][i] = v[k][order[i]];
  }
  for (int i = 0; i < 3; ++i) {
    d[i] = dSorted[i];
    for (int k = 0; k < 3; ++k) v[k][i] = vSorted[k][i];
  }
}

/** 归一化（0 向量 / 非有限值返回 false）。 */
bool normalize3(double n[3]) {
  const double len = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (!(len > 0.0) || !std::isfinite(len)) return false;
  n[0] /= len;
  n[1] /= len;
  n[2] /= len;
  return true;
}

/** 邻域重心 + 协方差矩阵。coords = 3 个 double/点。 */
void covarianceOf(const std::vector<double>& coords, std::uint32_t count, double g[3],
                  double c[3][3]) {
  g[0] = g[1] = g[2] = 0.0;
  for (std::uint32_t i = 0; i < count; ++i) {
    g[0] += coords[i * 3];
    g[1] += coords[i * 3 + 1];
    g[2] += coords[i * 3 + 2];
  }
  const double inv = 1.0 / static_cast<double>(count);
  g[0] *= inv;
  g[1] *= inv;
  g[2] *= inv;

  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) c[i][j] = 0.0;
  }
  for (std::uint32_t i = 0; i < count; ++i) {
    const double dx = coords[i * 3] - g[0];
    const double dy = coords[i * 3 + 1] - g[1];
    const double dz = coords[i * 3 + 2] - g[2];
    c[0][0] += dx * dx;
    c[0][1] += dx * dy;
    c[0][2] += dx * dz;
    c[1][1] += dy * dy;
    c[1][2] += dy * dz;
    c[2][2] += dz * dz;
  }
  c[1][0] = c[0][1];
  c[2][0] = c[0][2];
  c[2][1] = c[1][2];
}

// ============================================================================
// 局部模型（语义对齐 ccNormalVectors.cpp:387-443）
// ============================================================================

/**
 * LS：邻域协方差矩阵最小特征值对应的特征向量（总最小二乘平面法向）。
 * 点数不足 3 返回 false（CC ComputeNormalWithLS 同）。符号任意（CC 同：方向由定向环节决定）。
 */
bool fitLS(const std::vector<double>& coords, std::uint32_t count, double n[3]) {
  if (count < kMinPointsLS) return false;
  double g[3];
  double c[3][3];
  covarianceOf(coords, count, g, c);
  double d[3];
  double v[3][3];
  jacobiEigen3(c, d, v);
  n[0] = v[0][0];
  n[1] = v[1][0];
  n[2] = v[2][0];
  return normalize3(n);
}

/**
 * Quadric：局部二次「高度函数」w = h0 + h1·u + h2·v + h3·u² + h4·uv + h5·v²，
 * 法向 = 该曲面在查询点处的梯度 (h1 + 2h3·qu + h4·qv, h2 + 2h5·qv + h4·qu, −1)，旋回全局后归一化。
 * 局部系：原点 = 邻域重心，Z = LS 平面法向、X/Y 为面内正交基（右手系）——语义对齐
 * ccNormalVectors::ComputeNormalWithQuadric + CCCoreLib::Neighbourhood::getQuadric。
 * 点数不足 6 返回 false（CC Neighbourhood::getQuadric 同）。
 *
 * @param q 查询点（全局/显示坐标）
 */
bool fitQuadric(const std::vector<double>& coords, std::uint32_t count, const double q[3],
                double n[3]) {
  if (count < kMinPointsQuadric) return false;

  double g[3];
  double c[3][3];
  covarianceOf(coords, count, g, c);
  double d[3];
  double v[3][3];
  jacobiEigen3(c, d, v);
  double zAxis[3] = {v[0][0], v[1][0], v[2][0]};
  if (!normalize3(zAxis)) return false;

  // 面内基：取一个与 zAxis 不平行的坐标轴做叉乘（|z.x| < 0.9 用 X 轴，否则用 Y 轴）
  const bool useX = std::fabs(zAxis[0]) < 0.9;
  const double helper[3] = {useX ? 1.0 : 0.0, useX ? 0.0 : 1.0, 0.0};
  double xAxis[3] = {helper[1] * zAxis[2] - helper[2] * zAxis[1],
                     helper[2] * zAxis[0] - helper[0] * zAxis[2],
                     helper[0] * zAxis[1] - helper[1] * zAxis[0]};
  if (!normalize3(xAxis)) return false;
  const double yAxis[3] = {zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
                           zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
                           zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0]};

  // 局部坐标量级归一（否则 u² 项在粗半径下会把 6×6 正规方程搞到病态）
  double scale = 0.0;
  for (std::uint32_t i = 0; i < count; ++i) {
    const double dx = coords[i * 3] - g[0];
    const double dy = coords[i * 3 + 1] - g[1];
    const double dz = coords[i * 3 + 2] - g[2];
    scale = std::max(scale, std::fabs(dx * xAxis[0] + dy * xAxis[1] + dz * xAxis[2]));
    scale = std::max(scale, std::fabs(dx * yAxis[0] + dy * yAxis[1] + dz * yAxis[2]));
  }
  if (!(scale > 0.0)) return false;  // 邻域在面内退化成一点

  // 6×6 正规方程：基函数 [1, u, v, u², uv, v²]（u/v/w 均已除 scale）
  double a[6][6] = {{0}};
  double b[6] = {0, 0, 0, 0, 0, 0};
  for (std::uint32_t i = 0; i < count; ++i) {
    const double dx = coords[i * 3] - g[0];
    const double dy = coords[i * 3 + 1] - g[1];
    const double dz = coords[i * 3 + 2] - g[2];
    const double u = (dx * xAxis[0] + dy * xAxis[1] + dz * xAxis[2]) / scale;
    const double w = (dx * yAxis[0] + dy * yAxis[1] + dz * yAxis[2]) / scale;
    const double hh = (dx * zAxis[0] + dy * zAxis[1] + dz * zAxis[2]) / scale;
    const double phi[6] = {1.0, u, w, u * u, u * w, w * w};
    for (int r = 0; r < 6; ++r) {
      for (int col = r; col < 6; ++col) a[r][col] += phi[r] * phi[col];
      b[r] += phi[r] * hh;
    }
  }
  for (int r = 0; r < 6; ++r) {
    for (int col = 0; col < r; ++col) a[r][col] = a[col][r];
  }

  // 高斯消元（列主元）；主元阈值相对矩阵量级，病态则放弃该点（法向量留空码）
  double h[6] = {0, 0, 0, 0, 0, 0};
  {
    double maxAbs = 0.0;
    for (int r = 0; r < 6; ++r) {
      for (int col = 0; col < 6; ++col) maxAbs = std::max(maxAbs, std::fabs(a[r][col]));
    }
    if (!(maxAbs > 0.0)) return false;
    const double tol = 1e-12 * maxAbs;
    for (int col = 0; col < 6; ++col) {
      int piv = col;
      double best = std::fabs(a[col][col]);
      for (int r = col + 1; r < 6; ++r) {
        if (std::fabs(a[r][col]) > best) {
          best = std::fabs(a[r][col]);
          piv = r;
        }
      }
      if (!(best > tol)) return false;
      if (piv != col) {
        for (int cc = 0; cc < 6; ++cc) std::swap(a[piv][cc], a[col][cc]);
        std::swap(b[piv], b[col]);
      }
      const double inv = 1.0 / a[col][col];
      for (int r = col + 1; r < 6; ++r) {
        const double f = a[r][col] * inv;
        if (f == 0.0) continue;
        for (int cc = col; cc < 6; ++cc) a[r][cc] -= f * a[col][cc];
        b[r] -= f * b[col];
      }
    }
    for (int r = 5; r >= 0; --r) {
      double s = b[r];
      for (int cc = r + 1; cc < 6; ++cc) s -= a[r][cc] * h[cc];
      h[r] = s / a[r][r];
    }
  }

  // 查询点在局部系的面内坐标（梯度分量与 scale 无关：h3/h4/h5 与 u/v 的量纲互为倒数）
  const double qdx = q[0] - g[0];
  const double qdy = q[1] - g[1];
  const double qdz = q[2] - g[2];
  const double qu = (qdx * xAxis[0] + qdy * xAxis[1] + qdz * xAxis[2]) / scale;
  const double qv = (qdx * yAxis[0] + qdy * yAxis[1] + qdz * yAxis[2]) / scale;
  const double gradU = h[1] + (2.0 * h[3] * qu) + (h[4] * qv);
  const double gradV = h[2] + (2.0 * h[5] * qv) + (h[4] * qu);

  // 旋回全局：n = gradU·X + gradV·Y − 1·Z
  n[0] = gradU * xAxis[0] + gradV * yAxis[0] - zAxis[0];
  n[1] = gradU * xAxis[1] + gradV * yAxis[1] - zAxis[1];
  n[2] = gradU * xAxis[2] + gradV * yAxis[2] - zAxis[2];
  return normalize3(n);
}

// ============================================================================
// 定向（语义对齐 ccNormalVectors::UpdateNormalOrientations，ccNormalVectors.cpp:130-252）
// ============================================================================

/**
 * 由定向枚举构造参考向量（返回 false = 该项不支持/不需要定向）。
 * @param p    查询点（显示坐标）
 * @param bary 候选集重心（仅 PLUS/MINUS_BARYCENTER 用到）
 */
bool orientationReference(std::uint32_t orientation, const double p[3], const double bary[3],
                          double pref[3]) {
  switch (orientation) {
    case PLUS_X:
      pref[0] = 1;
      pref[1] = 0;
      pref[2] = 0;
      return true;
    case MINUS_X:
      pref[0] = -1;
      pref[1] = 0;
      pref[2] = 0;
      return true;
    case PLUS_Y:
      pref[0] = 0;
      pref[1] = 1;
      pref[2] = 0;
      return true;
    case MINUS_Y:
      pref[0] = 0;
      pref[1] = -1;
      pref[2] = 0;
      return true;
    case PLUS_Z:
      pref[0] = 0;
      pref[1] = 0;
      pref[2] = 1;
      return true;
    case MINUS_Z:
      pref[0] = 0;
      pref[1] = 0;
      pref[2] = -1;
      return true;
    case PLUS_BARYCENTER:  // 背离重心
      pref[0] = p[0] - bary[0];
      pref[1] = p[1] - bary[1];
      pref[2] = p[2] - bary[2];
      return true;
    case MINUS_BARYCENTER:  // 朝向重心
      pref[0] = bary[0] - p[0];
      pref[1] = bary[1] - p[1];
      pref[2] = bary[2] - p[2];
      return true;
    case PLUS_ORIGIN:  // 背离显示坐标原点
      pref[0] = p[0];
      pref[1] = p[1];
      pref[2] = p[2];
      return true;
    case MINUS_ORIGIN:  // 朝向显示坐标原点
      pref[0] = -p[0];
      pref[1] = -p[1];
      pref[2] = -p[2];
      return true;
    default:
      return false;  // PREVIOUS / *_SENSOR_ORIGIN / UNDEFINED / 未知值
  }
}

/** 需要候选集重心做参考向量的定向项。 */
inline bool needsBarycenter(std::uint32_t orientation) {
  return orientation == PLUS_BARYCENTER || orientation == MINUS_BARYCENTER;
}

// ============================================================================
// 自动半径用的小工具（PRNG 与 native/ransac-plane 同款：mulberry32，纯 uint32 算术）
// ============================================================================

struct Mulberry32 {
  std::uint32_t a;
  explicit Mulberry32(std::uint32_t seed) : a(seed) {}

  std::uint32_t nextU32() {
    a = a + 0x6D2B79F5u;
    std::uint32_t t = a;
    t = (t ^ (t >> 15)) * (1u | t);
    t = t + ((t ^ (t >> 7)) * (61u | t));
    return t ^ (t >> 14);
  }
};

/** 候选总点数与 AABB（全候选；无点时 valid 为 false）。 */
struct EntityBounds {
  bool valid = false;
  std::uint64_t total = 0;
  double minX = 0;
  double minY = 0;
  double minZ = 0;
  double maxX = 0;
  double maxY = 0;
  double maxZ = 0;
};

EntityBounds boundsOf(const EntitySource& entity) {
  EntityBounds b;
  for (const ChunkSource& src : entity.chunks) {
    const std::uint32_t n = candidateCountOfChunk(src);
    b.total += n;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      if (!b.valid) {
        b.minX = b.maxX = x;
        b.minY = b.maxY = y;
        b.minZ = b.maxZ = z;
        b.valid = true;
      } else {
        b.minX = std::min(b.minX, x);
        b.maxX = std::max(b.maxX, x);
        b.minY = std::min(b.minY, y);
        b.maxY = std::max(b.maxY, y);
        b.minZ = std::min(b.minZ, z);
        b.maxZ = std::max(b.maxZ, z);
      }
    }
  }
  return b;
}

/** 由全局候选序号定位坐标（采样用；候选序号按块连续）。 */
void candidateXyzAt(const EntitySource& entity, const std::vector<std::uint64_t>& chunkStart,
                    std::uint64_t ordinal, double* x, double* y, double* z) {
  std::size_t chunk = 0;
  while (chunk + 1 < entity.chunks.size() && chunkStart[chunk + 1] <= ordinal) ++chunk;
  candidateXyz(entity.chunks[chunk], static_cast<std::uint32_t>(ordinal - chunkStart[chunk]), x, y,
               z);
}

}  // namespace

// ============================================================================
// 法向量估计
// ============================================================================

EntityResult estimateEntity(const EntitySource& entity, const NormalParams& params,
                            unsigned threadCount) {
  EntityResult result;
  const std::size_t chunkCount = entity.chunks.size();
  result.codesByChunk.resize(chunkCount);

  // ---- 0) 每块候选数 + 空码预填（算不出的点不写 = 保持空码）----
  std::vector<std::uint64_t> chunkStart(chunkCount + 1, 0);
  std::uint64_t total = 0;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    chunkStart[c] = total;
    const std::uint32_t n = candidateCountOfChunk(entity.chunks[c]);
    total += n;
    result.codesByChunk[c].assign(n, NULL_NORM_CODE);
  }
  chunkStart[chunkCount] = total;
  if (total == 0) return result;
  if (!(params.radius > 0.0)) {  // 含 NaN
    result.nullCount = total;
    result.capped = total;
    return result;
  }

  const double radius = params.radius;
  const std::uint32_t kMin = (params.model == QUADRIC) ? kMinPointsQuadric : kMinPointsLS;

  const Grid grid = buildGrid(entity, radius);

  // ---- 定向参考重心（候选集；只在需要时算一次）----
  double bary[3] = {0, 0, 0};
  if (needsBarycenter(params.orientation)) {
    double sx = 0;
    double sy = 0;
    double sz = 0;
    for (const ChunkSource& src : entity.chunks) {
      const std::uint32_t n = candidateCountOfChunk(src);
      for (std::uint32_t i = 0; i < n; ++i) {
        double x, y, z;
        candidateXyz(src, i, &x, &y, &z);
        sx += x;
        sy += y;
        sz += z;
      }
    }
    bary[0] = sx / static_cast<double>(total);
    bary[1] = sy / static_cast<double>(total);
    bary[2] = sz / static_cast<double>(total);
  }

  // ---- 1) 并行：候选点按全局序号连续分段，每线程处理一段 ----
  unsigned T = threadCount;
  if (T == 0) T = std::thread::hardware_concurrency();
  if (T == 0) T = 1;
  if (total < 200000) T = 1;  // 点数过少时线程调度开销不划算
  T = std::min(T, 64u);
  T = std::min<unsigned>(T, static_cast<unsigned>(total));

  std::vector<std::uint64_t> threadComputed(T, 0);
  std::vector<std::uint64_t> threadNull(T, 0);
  std::vector<std::uint64_t> threadCapped(T, 0);

  // 每线程写自己那一段的 (chunk, local)：区间不重叠 ⇒ 无竞争（结果与线程数无关）
  const auto processRange = [&](std::uint64_t begin, std::uint64_t end, unsigned threadId) {
    std::vector<double> coords;  // 邻域坐标暂存（3 double/点，跨点复用）
    std::uint64_t computed = 0;
    std::uint64_t nullCount = 0;
    std::uint64_t capped = 0;

    std::size_t chunk = 0;
    while (chunk + 1 < chunkCount && chunkStart[chunk + 1] <= begin) ++chunk;
    std::uint64_t local = begin - chunkStart[chunk];

    for (std::uint64_t g = begin; g < end; ++g) {
      for (;;) {
        const std::uint64_t chunkN = candidateCountOfChunk(entity.chunks[chunk]);
        if (local < chunkN) break;
        ++chunk;
        local = 0;
      }
      const ChunkSource& src = entity.chunks[chunk];
      const auto local32 = static_cast<std::uint32_t>(local);
      double px, py, pz;
      candidateXyz(src, local32, &px, &py, &pz);

      // 球邻域 + 半径放大：CC 是 k < kMin 时 r *= 2^(1/4)、上限 16r，每次整球重查
      double cur = radius;
      std::uint32_t count = collectSphere(grid, entity, px, py, pz, cur, coords);
      while (count < kMin && cur < kRadiusMaxFactor * radius) {
        cur *= kRadiusGrowth;
        count = collectSphere(grid, entity, px, py, pz, cur, coords);
      }

      double n[3] = {0, 0, 0};
      bool ok = false;
      if (count >= kMin) {
        if (params.model == QUADRIC) {
          const double q[3] = {px, py, pz};
          ok = fitQuadric(coords, count, q, n);
        } else {
          ok = fitLS(coords, count, n);
        }
      }

      if (!ok) {
        ++nullCount;          // 触顶后仍不足（或拟合退化）
        if (count < kMin) ++capped;
      } else {
        std::uint16_t code = compressNormal(n);
        // 定向：在「码」上做（CC 是解码→判号→重新压缩；因为 Compress(−n) == Compress(n) ^ INVERT_XOR
        // ——只有 3 个符号位不同、箱细分只取决于绝对值——等价于异或符号位，且与手动 Invert 同路径）
        const double p[3] = {px, py, pz};
        double pref[3];
        if (orientationReference(params.orientation, p, bary, pref)) {
          double dn[3];
          decompressNormal(code, dn);  // 用解码向量判号，与 CC 同（量级不影响符号判定）
          if ((dn[0] * pref[0] + dn[1] * pref[1] + dn[2] * pref[2]) < 0.0) {
            code = invertNormalCode(code);
          }
        }
        result.codesByChunk[chunk][local32] = code;
        ++computed;
      }
      ++local;
    }

    threadComputed[threadId] = computed;
    threadNull[threadId] = nullCount;
    threadCapped[threadId] = capped;
  };

  if (T <= 1) {
    processRange(0, total, 0);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(T);
    const std::uint64_t step = (total + T - 1) / T;
    for (unsigned t = 0; t < T; ++t) {
      const std::uint64_t begin = t * step;
      const std::uint64_t end = std::min(begin + step, total);
      if (begin >= end) break;
      pool.emplace_back([&, begin, end, t] { processRange(begin, end, t); });
    }
    for (auto& th : pool) th.join();
  }

  for (unsigned t = 0; t < T; ++t) {
    result.computed += threadComputed[t];
    result.nullCount += threadNull[t];
    result.capped += threadCapped[t];
  }
  return result;
}

// ============================================================================
// 自动半径（语义对齐 ccOctree::GuessBestRadius，ccOctree.cpp:781-946）
// ============================================================================

RadiusResult guessRadius(const EntitySource& entity, const RadiusParams& params,
                         unsigned threadCount) {
  (void)threadCount;  // 采样只有 CC 的 min(200, N/10) 次球查询，串行足够
  RadiusResult result;

  const EntityBounds bounds = boundsOf(entity);
  if (!bounds.valid) return result;  // 无候选点

  const double largestDim =
      std::max(std::max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
               bounds.maxZ - bounds.minZ);
  const std::uint64_t n = bounds.total;
  const std::uint64_t divisor = std::min<std::uint64_t>(100, std::max<std::uint64_t>(1, n / 100));
  const double naive = largestDim / static_cast<double>(divisor);
  result.radius = naive;
  if (!(naive > 0.0) || !std::isfinite(naive)) return result;  // 尺寸退化
  if (n < 100) return result;                                  // CC：小云不再采样

  std::vector<std::uint64_t> chunkStart(entity.chunks.size() + 1, 0);
  for (std::size_t c = 0; c < entity.chunks.size(); ++c) {
    chunkStart[c + 1] = chunkStart[c] + candidateCountOfChunk(entity.chunks[c]);
  }

  const std::uint32_t sampleCount =
      static_cast<std::uint32_t>(std::min<std::uint64_t>(200, n / 10));
  result.sampledCount = sampleCount;

  Mulberry32 rng(params.seed);
  double aimedPop = static_cast<double>(params.aimedPopulationPerCell);
  double radius = naive;
  double lastRadius = radius;
  double lastMeanPop = 0.0;
  double bestRadius = naive;

  for (std::uint32_t attempt = 0; attempt < 10; ++attempt) {
    result.attempts = attempt + 1;

    const Grid grid = buildGrid(entity, radius);
    double totalCount = 0.0;
    double totalSquareCount = 0.0;
    std::uint32_t aboveMinPopCount = 0;
    std::vector<double> coords;

    for (std::uint32_t i = 0; i < sampleCount; ++i) {
      const std::uint64_t ordinal =
          static_cast<std::uint64_t>(rng.nextU32()) % static_cast<std::uint64_t>(n);
      double px, py, pz;
      candidateXyzAt(entity, chunkStart, ordinal, &px, &py, &pz);
      const double nn = static_cast<double>(collectSphere(grid, entity, px, py, pz, radius, coords));
      totalCount += nn;
      totalSquareCount += nn * nn;
      if (nn >= static_cast<double>(params.minCellPopulation)) ++aboveMinPopCount;
    }

    const double meanPop = totalCount / static_cast<double>(sampleCount);
    const double stdDevPop = std::sqrt(
        std::fabs(totalSquareCount / static_cast<double>(sampleCount) - meanPop * meanPop));
    const double aboveMinPopRatio = static_cast<double>(aboveMinPopCount) / sampleCount;
    result.meanPopulation = meanPop;
    result.stdDevPopulation = stdDevPop;
    result.aboveMinRatio = aboveMinPopRatio;

    if (std::fabs(meanPop - aimedPop) < static_cast<double>(params.aimedPopulationRange)) {
      bestRadius = radius;  // 命中：当前半径可用
      if (aboveMinPopRatio < params.minAboveMinRatio) {
        // 密度不均：目标抬到 16 + 2σ 再迭代（CC 原样，目标 >= 16）
        aimedPop = static_cast<double>(params.aimedPopulationPerCell) + 2.0 * stdDevPop;
      } else {
        result.radius = bestRadius;
        return result;
      }
    }

    double newRadius = radius;
    if (attempt == 0) {
      bestRadius = radius;
      if (!(meanPop > 0.0)) break;
      // 邻居数 ∝ 球面面积 ∝ r²（CC 注释：points proportional to the SURFACE）
      newRadius = radius * std::sqrt(aimedPop / meanPop);
    } else {
      // CC 原样：这里把「人口与目标的偏差」直接和「半径」比大小（量纲不一致）——通常等价于
      // 「取最新一轮」；保留原语义以免与 CC 行为漂移，见 README-REF.md。
      if (std::fabs(meanPop - aimedPop) < std::fabs(bestRadius - aimedPop)) bestRadius = radius;

      const double denom = meanPop - lastMeanPop;
      if (denom == 0.0) break;
      // (r², 人口) 平面上的线性外推
      const double slope = (radius * radius - lastRadius * lastRadius) / denom;
      const double newSquareRadius = lastRadius * lastRadius + (aimedPop - lastMeanPop) * slope;
      if (newSquareRadius > 0.0) {
        newRadius = std::sqrt(newSquareRadius);
      } else {
        break;  // 无法再改进（CC 同）
      }
    }

    lastRadius = radius;
    lastMeanPop = meanPop;
    radius = newRadius;
    if (!(radius > 0.0) || !std::isfinite(radius)) break;  // 防御：异常半径不再迭代
  }

  result.radius = bestRadius;
  return result;
}

}  // namespace normal_estimate
