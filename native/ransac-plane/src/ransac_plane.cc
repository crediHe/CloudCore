#include "ransac_plane.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <thread>
#include <utility>
#include <vector>

namespace ransac_plane {

namespace {

/**
 * mulberry32 PRNG：32 位状态、纯 uint32 算术（乘法的回绕即取低 32 位）。
 * 选它而非 splitmix64 是为了与 JS `Math.imul` 版本逐位同构——渲染侧单测可以镜像同一序列。
 * 输出 nextDouble() = nextU32() / 2^32 ∈ [0,1)。
 */
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

  double nextDouble() { return static_cast<double>(nextU32()) / 4294967296.0; }
};

/** 平面：单位法向 n + 平面方程 n·p + d = 0（显示坐标空间）。 */
struct Plane {
  double nx = 0.0;
  double ny = 0.0;
  double nz = 1.0;
  double d = 0.0;
};

/**
 * 三点共线的拒绝阈值：|e1 × e2| ≤ kMinSine × |e1||e2| 即判退化（等价于 sin∠(e1,e2) ≤ kMinSine）。
 *
 * 该量同时是法向量的相对误差放大倍数（法向 ≈ 面积倒数），1e-4 对应法向相对误差 ≤ 1e-4，
 * 远大于距离阈值判据所需的精度；更宽松（1e-9 之类）会让近共线三元组产出噪声法向，
 * 白跑一轮计数循环。
 */
constexpr double kMinSine = 1e-4;

/** 候选点数（index == nullptr = 全量顶点）。 */
inline std::uint32_t chunkCandidateCount(const ChunkSource& src) {
  return src.index ? src.indexCount : src.vertexCount;
}

/** 由候选全局序号取坐标（xyz 输出）；local = 块内候选序号，不是顶点下标。 */
inline void candidateXyz(const ChunkSource& src, std::uint32_t local, double* x, double* y,
                         double* z) {
  const std::uint32_t vertex = src.index ? src.index[local] : local;
  const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
  *x = static_cast<double>(p[0]);
  *y = static_cast<double>(p[1]);
  *z = static_cast<double>(p[2]);
}

/**
 * 法向符号约定：绝对值最大的分量为正。
 *
 * 平面无向，法向 ±n 描述同一平面，但**输出必须确定**——否则特征向量的 ± 歧义会泄漏到
 * 契约（同一份数据两次运行的法向可能翻向），单测与 3D 法线箭头都会跟着抖。同时取
 * (n, d) 一起取反，平面方程不变。
 */
inline void orientPlane(Plane* pl) {
  const double ax = std::fabs(pl->nx);
  const double ay = std::fabs(pl->ny);
  const double az = std::fabs(pl->nz);
  double lead = pl->nx;
  if (ay > ax && ay >= az) {
    lead = pl->ny;
  } else if (az > ax && az > ay) {
    lead = pl->nz;
  }
  if (lead < 0.0) {
    pl->nx = -pl->nx;
    pl->ny = -pl->ny;
    pl->nz = -pl->nz;
    pl->d = -pl->d;
  }
}

/**
 * 平面内正交单位基：(u, v, n) 右手系，且**确定性**（同一法向必得同一组基）。
 *
 * 取与 n 最不平行的坐标轴 e（|n| 分量最小的那个），u = normalize(n × e)，v = n × u。
 * 坐标轴的选择保证 n × e 不为零（n 不可能同时与三轴共线）；u ⊥ n 且 |u| = 1 ⇒
 * |v| = |n||u| = 1，v ⊥ n，且 u × v = n。
 */
inline void planeBasis(const Plane& pl, double* u, double* v) {
  const double ax = std::fabs(pl.nx);
  const double ay = std::fabs(pl.ny);
  const double az = std::fabs(pl.nz);
  double ex = 0.0;
  double ey = 0.0;
  double ez = 0.0;
  if (ax <= ay && ax <= az) {
    ex = 1.0;
  } else if (ay <= az) {
    ey = 1.0;
  } else {
    ez = 1.0;
  }
  double cx = pl.ny * ez - pl.nz * ey;
  double cy = pl.nz * ex - pl.nx * ez;
  double cz = pl.nx * ey - pl.ny * ex;
  const double len = std::sqrt(cx * cx + cy * cy + cz * cz);
  if (len > 0.0) {
    cx /= len;
    cy /= len;
    cz /= len;
  }
  u[0] = cx;
  u[1] = cy;
  u[2] = cz;
  // v = n × u（n、u 均为单位且正交 ⇒ v 自动单位）
  v[0] = pl.ny * cz - pl.nz * cy;
  v[1] = pl.nz * cx - pl.nx * cz;
  v[2] = pl.nx * cy - pl.ny * cx;
}

/**
 * 3×3 对称矩阵的循环 Jacobi 特征分解（闭式、无外部依赖）。
 *
 * 每轮对非对角元做一次 Givens 旋转把它消为零，反复扫描至非对角范数相对对角可忽略。
 * 3×3 下约 8–12 轮即收敛到机器精度。a **会被破坏**；v 的**每一列**是一个单位特征向量，
 * 与 w 的特征值一一对应（列序 = 输出序，未排序）。
 */
void jacobiEigen3(double a[3][3], double w[3], double v[3][3]) {
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      v[i][j] = (i == j) ? 1.0 : 0.0;
    }
  }
  for (int sweep = 0; sweep < 32; ++sweep) {
    const double off = std::fabs(a[0][1]) + std::fabs(a[0][2]) + std::fabs(a[1][2]);
    const double diag = std::fabs(a[0][0]) + std::fabs(a[1][1]) + std::fabs(a[2][2]);
    // 全零矩阵（内点全重合）时 off 与 diag 同为 0，此处即退出，不引入除零
    if (off <= 1e-18 * (diag > 0.0 ? diag : 1.0)) break;
    for (int p = 0; p < 2; ++p) {
      for (int q = p + 1; q < 3; ++q) {
        if (a[p][q] == 0.0) continue;
        // 标准 Jacobi 旋转参数（Numerical Recipes 形式：t 取与 theta 同号的小根）
        const double theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
        const double sign = theta >= 0.0 ? 1.0 : -1.0;
        const double t = sign / (std::fabs(theta) + std::sqrt(theta * theta + 1.0));
        const double c = 1.0 / std::sqrt(t * t + 1.0);
        const double s = t * c;
        const double app = a[p][p];
        const double aqq = a[q][q];
        const double apq = a[p][q];
        a[p][p] = app - t * apq;
        a[q][q] = aqq + t * apq;
        a[p][q] = 0.0;
        a[q][p] = 0.0;
        const int r = 3 - p - q;  // 第三轴
        const double arp = a[r][p];
        const double arq = a[r][q];
        a[r][p] = c * arp - s * arq;
        a[p][r] = a[r][p];
        a[r][q] = s * arp + c * arq;
        a[q][r] = a[r][q];
        // 累积特征向量：V ← V J
        for (int k = 0; k < 3; ++k) {
          const double vkp = v[k][p];
          const double vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  w[0] = a[0][0];
  w[1] = a[1][1];
  w[2] = a[2][2];
}

/** 单块的扫描产出（内点下标 + 该块的浮点累加量，供串行归并）。 */
struct ChunkScan {
  /** 内点顶点下标（递增：候选遍历序 → 顶点下标，index 自身递增由契约保证）。 */
  std::vector<std::uint32_t> inliers;
  /** 以参考点 r 为原点的和：dx,dy,dz, dxx,dyy,dzz, dxy,dxz,dyz。 */
  double s[9] = {};
  double sqSum = 0.0;   // Σ 距离²
  double maxAbs = 0.0;  // max |距离|
  /** 内点在平面内基上的投影范围（画布跨度）。 */
  double uMin = std::numeric_limits<double>::infinity();
  double uMax = -std::numeric_limits<double>::infinity();
  double vMin = std::numeric_limits<double>::infinity();
  double vMax = -std::numeric_limits<double>::infinity();
};

/** 一次全量扫描的归并结果。 */
struct ScanResult {
  std::vector<std::vector<std::uint32_t>> inlierByChunk;
  std::uint64_t count = 0;
  /** 协方差参考点（平面距原点最近点 -d·n）：以它为原点累积可避免大坐标下的抵消。 */
  double rx = 0.0;
  double ry = 0.0;
  double rz = 0.0;
  double s[9] = {};
  double sqSum = 0.0;
  double maxAbs = 0.0;
  double uMin = 0.0;
  double uMax = 0.0;
  double vMin = 0.0;
  double vMax = 0.0;
  bool spanned = false;  // 是否有内点（无内点时 u/v 范围无意义）
};

/**
 * 全量扫描：用给定平面判定**全部**候选点，逐块产出内点下标，并顺带累积
 * 协方差累加量、RMS/最大偏差、平面内投影范围。
 *
 * 并行：按块区间均分（块大小由加载器按固定块长切分，量级相近，故按块数均分即近似均衡）。
 * 确定性：每块的输出由该块独立产出（块内递增序与线程数无关）；全局浮点归约在**串行**遍历
 * 逐块累加量时完成，归约顺序 = 块序，与线程数无关。
 */
ScanResult classifyAll(const EntitySource& entity, const Plane& pl, double threshold,
                       unsigned threadCount) {
  const std::size_t chunkCount = entity.chunks.size();
  ScanResult out;
  out.inlierByChunk.resize(chunkCount);

  // 参考点：平面上距原点最近的点（内点距它 ~ 平面上点距，量级小 ⇒ 协方差条件数好）
  const double rx = -pl.d * pl.nx;
  const double ry = -pl.d * pl.ny;
  const double rz = -pl.d * pl.nz;
  out.rx = rx;
  out.ry = ry;
  out.rz = rz;

  double u[3];
  double v[3];
  planeBasis(pl, u, v);

  std::vector<ChunkScan> perChunk(chunkCount);
  const auto scanChunk = [&](std::size_t c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = chunkCandidateCount(src);
    ChunkScan& acc = perChunk[c];
    // 预留上限刻意保守（平面可能只占候选的很小一部分，逐块 n/4 会白占内存）
    acc.inliers.reserve(std::min<std::size_t>(n / 4, 1u << 16));
    for (std::uint32_t i = 0; i < n; ++i) {
      double x;
      double y;
      double z;
      candidateXyz(src, i, &x, &y, &z);
      const double dist = pl.nx * x + pl.ny * y + pl.nz * z + pl.d;
      const double absDist = std::fabs(dist);
      if (absDist > threshold) continue;
      acc.inliers.push_back(src.index ? src.index[i] : i);
      const double dx = x - rx;
      const double dy = y - ry;
      const double dz = z - rz;
      acc.s[0] += dx;
      acc.s[1] += dy;
      acc.s[2] += dz;
      acc.s[3] += dx * dx;
      acc.s[4] += dy * dy;
      acc.s[5] += dz * dz;
      acc.s[6] += dx * dy;
      acc.s[7] += dx * dz;
      acc.s[8] += dy * dz;
      acc.sqSum += dist * dist;
      if (absDist > acc.maxAbs) acc.maxAbs = absDist;
      const double tu = x * u[0] + y * u[1] + z * u[2];
      const double tv = x * v[0] + y * v[1] + z * v[2];
      if (tu < acc.uMin) acc.uMin = tu;
      if (tu > acc.uMax) acc.uMax = tu;
      if (tv < acc.vMin) acc.vMin = tv;
      if (tv > acc.vMax) acc.vMax = tv;
    }
  };

  unsigned threads = threadCount;
  if (threads == 0) threads = std::thread::hardware_concurrency();
  if (threads == 0) threads = 1;
  if (out.inlierByChunk.size() < 2) threads = 1;
  threads = std::min<unsigned>(threads, static_cast<unsigned>(chunkCount > 0 ? chunkCount : 1u));
  threads = std::min<unsigned>(threads, 64u);

  if (threads <= 1) {
    for (std::size_t c = 0; c < chunkCount; ++c) scanChunk(c);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(threads);
    const std::size_t step = (chunkCount + threads - 1) / threads;
    for (unsigned t = 0; t < threads; ++t) {
      const std::size_t begin = t * step;
      const std::size_t end = std::min(begin + step, chunkCount);
      if (begin >= end) break;
      pool.emplace_back([&, begin, end] {
        for (std::size_t c = begin; c < end; ++c) scanChunk(c);
      });
    }
    for (auto& th : pool) th.join();
  }

  // 串行归并（顺序 = 块序 ⇒ 与线程数无关）
  double uMin = std::numeric_limits<double>::infinity();
  double uMax = -std::numeric_limits<double>::infinity();
  double vMin = std::numeric_limits<double>::infinity();
  double vMax = -std::numeric_limits<double>::infinity();
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkScan& part = perChunk[c];
    out.inlierByChunk[c] = std::move(part.inliers);
    out.count += out.inlierByChunk[c].size();
    for (int k = 0; k < 9; ++k) out.s[k] += part.s[k];
    out.sqSum += part.sqSum;
    if (part.maxAbs > out.maxAbs) out.maxAbs = part.maxAbs;
    if (!part.inliers.empty()) {
      out.spanned = true;
      if (part.uMin < uMin) uMin = part.uMin;
      if (part.uMax > uMax) uMax = part.uMax;
      if (part.vMin < vMin) vMin = part.vMin;
      if (part.vMax > vMax) vMax = part.vMax;
    }
  }
  out.uMin = uMin;
  out.uMax = uMax;
  out.vMin = vMin;
  out.vMax = vMax;
  return out;
}

/** 由扫描累加量组装平面模型（含画布跨度的原坐标还原）。 */
PlaneModel buildModel(const Plane& pl, const ScanResult& scan, std::uint64_t sampleCount,
                      std::uint32_t iterationsUsed) {
  PlaneModel model;
  model.nx = pl.nx;
  model.ny = pl.ny;
  model.nz = pl.nz;
  model.d = pl.d;
  model.inlierCount = scan.count;
  model.sampleCount = sampleCount;
  model.iterationsUsed = iterationsUsed;
  model.rms = scan.count > 0 ? std::sqrt(scan.sqSum / static_cast<double>(scan.count)) : 0.0;
  model.maxDeviation = scan.count > 0 ? scan.maxAbs : 0.0;

  double u[3];
  double v[3];
  planeBasis(pl, u, v);
  model.quad.ux = u[0];
  model.quad.uy = u[1];
  model.quad.uz = u[2];
  model.quad.vx = v[0];
  model.quad.vy = v[1];
  model.quad.vz = v[2];
  if (scan.spanned) {
    // 画布中心 = -d·n + u·cu + v·cv（仍在平面上：n·u = n·v = 0、n·n = 1）
    const double cu = (scan.uMin + scan.uMax) / 2.0;
    const double cv = (scan.vMin + scan.vMax) / 2.0;
    model.quad.cx = u[0] * cu + v[0] * cv - pl.d * pl.nx;
    model.quad.cy = u[1] * cu + v[1] * cv - pl.d * pl.ny;
    model.quad.cz = u[2] * cu + v[2] * cv - pl.d * pl.nz;
    model.quad.halfU = (scan.uMax - scan.uMin) / 2.0;
    model.quad.halfV = (scan.vMax - scan.vMin) / 2.0;
  } else {
    model.quad.cx = -pl.d * pl.nx;
    model.quad.cy = -pl.d * pl.ny;
    model.quad.cz = -pl.d * pl.nz;
    model.quad.halfU = 0.0;
    model.quad.halfV = 0.0;
  }
  return model;
}

/**
 * 最小二乘精修：内点集协方差矩阵的最小特征向量即拟合平面法向（对齐 PCL
 * setOptimizeCoefficients 的语义）。
 *
 * 退化拒绝（返回 false，调用方保留 RANSAC 平面）：
 * - 内点重合（最大特征值 ≤ 0）；
 * - 内点共线（中间特征值相对最大特征值可忽略）——此时平面绕该直线自由旋转，法向不唯一，
 *   任何解都是任意的，不如直接用 RANSAC 的三点平面。
 */
bool refinePlane(const ScanResult& scan, Plane* out) {
  if (scan.count < 3) return false;
  const double inv = 1.0 / static_cast<double>(scan.count);
  const double mx = scan.s[0] * inv;
  const double my = scan.s[1] * inv;
  const double mz = scan.s[2] * inv;
  double c[3][3];
  c[0][0] = scan.s[3] * inv - mx * mx;
  c[1][1] = scan.s[4] * inv - my * my;
  c[2][2] = scan.s[5] * inv - mz * mz;
  c[0][1] = scan.s[6] * inv - mx * my;
  c[0][2] = scan.s[7] * inv - mx * mz;
  c[1][2] = scan.s[8] * inv - my * mz;
  c[1][0] = c[0][1];
  c[2][0] = c[0][2];
  c[2][1] = c[1][2];

  double w[3];
  double v[3][3];
  jacobiEigen3(c, w, v);

  int kMin = 0;
  if (w[1] < w[kMin]) kMin = 1;
  if (w[2] < w[kMin]) kMin = 2;
  double wMax = 0.0;
  double wMid = 0.0;
  for (int k = 0; k < 3; ++k) {
    if (k == kMin) continue;
    if (w[k] > wMax) {
      wMid = wMax;
      wMax = w[k];
    } else if (w[k] > wMid) {
      wMid = w[k];
    }
  }
  if (!(wMax > 0.0)) return false;
  if (!(wMid > wMax * 1e-12)) return false;  // 共线（或近乎共线）：法向不唯一

  double nx = v[0][kMin];
  double ny = v[1][kMin];
  double nz = v[2][kMin];
  const double len = std::sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0.0)) return false;
  nx /= len;
  ny /= len;
  nz /= len;

  // 质心还原到原坐标（累积量以参考点为原点）
  const double gx = scan.rx + mx;
  const double gy = scan.ry + my;
  const double gz = scan.rz + mz;
  out->nx = nx;
  out->ny = ny;
  out->nz = nz;
  out->d = -(nx * gx + ny * gy + nz * gz);
  orientPlane(out);
  return true;
}

}  // namespace

EntityResult fitEntity(const EntitySource& entity, const RansacParams& params,
                       unsigned threadCount) {
  EntityResult result;
  const std::size_t chunkCount = entity.chunks.size();
  result.inlierByChunk.resize(chunkCount);

  const double threshold = params.distanceThreshold > 0.0 ? params.distanceThreshold : 0.0;

  // ---- 候选前缀和：全局候选序号 → (块, 块内候选序号) ----
  std::vector<std::uint64_t> prefix(chunkCount + 1, 0);
  for (std::size_t c = 0; c < chunkCount; ++c) {
    prefix[c + 1] = prefix[c] + chunkCandidateCount(entity.chunks[c]);
  }
  const std::uint64_t totalCandidates = prefix[chunkCount];

  std::uint64_t sampleSize = params.sampleSize > 0 ? params.sampleSize : kAutoSampleSize;
  if (sampleSize > totalCandidates) sampleSize = totalCandidates;

  // 候选不足三点定面 / 不迭代 / 采样集不足三点：直接判未找到（渲染侧按空结果提示）
  if (totalCandidates < 3 || sampleSize < 3 || params.maxIterations == 0) {
    return result;
  }

  // ---- ① 采样集：随机取点（有放回；重复抽样在 6.5e4/1e8 量级下期望 <1 次，不值得去重） ----
  const std::uint32_t sampleCount = static_cast<std::uint32_t>(sampleSize);
  std::vector<double> sx(sampleCount);
  std::vector<double> sy(sampleCount);
  std::vector<double> sz(sampleCount);
  {
    Mulberry32 rng(kRandomSeed);
    for (std::uint32_t i = 0; i < sampleCount; ++i) {
      std::uint64_t g =
          static_cast<std::uint64_t>(rng.nextDouble() * static_cast<double>(totalCandidates));
      if (g >= totalCandidates) g = totalCandidates - 1;  // nextDouble() < 1 保证不会越界，此为兜底
      const std::size_t c =
          static_cast<std::size_t>(std::upper_bound(prefix.begin(), prefix.end(), g) - prefix.begin() - 1);
      const std::uint32_t local = static_cast<std::uint32_t>(g - prefix[c]);
      candidateXyz(entity.chunks[c], local, &sx[i], &sy[i], &sz[i]);
    }
  }

  // ---- ② 假设循环：单线程顺序执行（最优跟踪有状态，并行会改变迭代顺序 ⇒ 破坏确定性） ----
  Plane best;
  std::uint64_t bestCount = 0;
  std::uint32_t iterationsUsed = 0;
  const double logOneMinusConf = std::log(1.0 - params.confidence);
  Mulberry32 pick(kRandomSeed ^ 0x9E3779B9u);  // 与采样用不同子序列，避免三点落在关联位置上

  for (std::uint32_t iter = 0; iter < params.maxIterations; ++iter) {
    iterationsUsed = iter + 1;
    const auto pickIndex = [&]() {
      std::uint32_t v = static_cast<std::uint32_t>(pick.nextDouble() * sampleCount);
      return v < sampleCount ? v : sampleCount - 1;
    };
    const std::uint32_t i0 = pickIndex();
    std::uint32_t i1 = pickIndex();
    while (i1 == i0) i1 = pickIndex();
    std::uint32_t i2 = pickIndex();
    while (i2 == i0 || i2 == i1) i2 = pickIndex();

    // 三点定平面；共线 / 重合三元组跳过本轮
    const double e1x = sx[i1] - sx[i0];
    const double e1y = sy[i1] - sy[i0];
    const double e1z = sz[i1] - sz[i0];
    const double e2x = sx[i2] - sx[i0];
    const double e2y = sy[i2] - sy[i0];
    const double e2z = sz[i2] - sz[i0];
    double nx = e1y * e2z - e1z * e2y;
    double ny = e1z * e2x - e1x * e2z;
    double nz = e1x * e2y - e1y * e2x;
    const double area2 = std::sqrt(nx * nx + ny * ny + nz * nz);
    const double len1 = std::sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
    const double len2 = std::sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
    if (!(len1 > 0.0) || !(len2 > 0.0)) continue;
    if (!(area2 > kMinSine * len1 * len2)) continue;
    nx /= area2;
    ny /= area2;
    nz /= area2;
    Plane cand;
    cand.nx = nx;
    cand.ny = ny;
    cand.nz = nz;
    cand.d = -(nx * sx[i0] + ny * sy[i0] + nz * sz[i0]);
    orientPlane(&cand);

    // 采样集内点计数（提前退出：剩余点**全算上**也无法严格超过当前最优 → 该假设必败）。
    // 注意判据必须是 count + 剩余数 <= bestCount：写成 <= bestCount + 1 会在"最多只能追平"
    // 时提前退出，把真正更优的假设丢掉。且此判据下胜出假设的计数必为精确值
    // （它每一步都满足 count + 剩余 > bestCount，不可能触发退出）。
    std::uint64_t count = 0;
    for (std::uint32_t k = 0; k < sampleCount; ++k) {
      if (count + static_cast<std::uint64_t>(sampleCount - k) <= bestCount) break;
      const double dist = cand.nx * sx[k] + cand.ny * sy[k] + cand.nz * sz[k] + cand.d;
      if (std::fabs(dist) <= threshold) ++count;
    }
    if (count > bestCount) {
      bestCount = count;
      best = cand;
    }

    // ---- 自适应早停：标准 RANSAC 终止条件 N = log(1-p) / log(1-w³) ----
    // w = 当前最优内点比例（采样集上的估计，是总体比例的无偏估计）
    if (bestCount >= 3) {
      const double w = static_cast<double>(bestCount) / static_cast<double>(sampleCount);
      const double w3 = w * w * w;
      if (w3 >= 1.0) break;  // 采样集全为内点：已不可能更好
      const double logNoWin = std::log(1.0 - w3);
      if (logNoWin < 0.0) {
        const double required = logOneMinusConf / logNoWin;
        if (static_cast<double>(iterationsUsed) >= required) break;
      }
    }
  }

  if (bestCount < 3) {
    // 未找到平面：常见于全共线点云、阈值远小于点云噪声、或数据里根本没有面
    return result;
  }

  // ---- ③ 全量 pass1：RANSAC 平面判内点 + 累积协方差 ----
  const ScanResult scan0 = classifyAll(entity, best, threshold, threadCount);

  PlaneModel model = buildModel(best, scan0, sampleCount, iterationsUsed);
  ScanResult chosen = scan0;

  // ---- ④⑤ 精修 + 全量 pass2；两版完整算出后取内点更多的一版 ----
  // 最小二乘不是共识最大化，精修后内点数理论上可能变少；两版都算齐（内点 + RMS + 画布）
  // 才能无条件取优。多一趟 O(N) 扫描换"结果永不因精修变差"，值。
  if (params.optimizeCoefficients) {
    Plane refined;
    if (refinePlane(scan0, &refined)) {
      const ScanResult scan1 = classifyAll(entity, refined, threshold, threadCount);
      if (scan1.count > scan0.count) {
        model = buildModel(refined, scan1, sampleCount, iterationsUsed);
        chosen = scan1;
      }
    }
  }

  result.found = true;
  result.plane = model;
  result.inlierByChunk = std::move(chosen.inlierByChunk);
  return result;
}

}  // namespace ransac_plane
