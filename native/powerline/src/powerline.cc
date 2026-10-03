/**
 * 电力线（导线）提取算法本体。接口与设计判据见 powerline.h 顶部注释，
 * 实测记录与「别改回去」的理由见 README-REF.md。
 *
 * 两阶段的分工与代价层级：
 *   extractCandidates：离地筛 + KD 树 + 逐点 PCA（重，与点数同阶）
 *   traceLines      ：连通 + 抛物线剥离 + 补全（轻，只吃「池子」）
 * 「线性度下限 / 最大倾角」这两个最容易反复试的参数刻意**不在这两阶段里**——
 * 它们由渲染侧拿 stage 1 回传的逐点特征做精筛（见 powerline.h 的 ExtractEntityResult）。
 */
#include "powerline.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "kdtree.h"

namespace powerline {
namespace {

// ===========================================================================
// 0. 常量（不出 UI 的那些；UI 旋钮见 powerline.h 的 *Params 与计划的参数表）
// ===========================================================================

/** 阶段 1 的宽松闸门：宽到「宁可多留」，精筛在渲染侧（见文件头）。 */
constexpr double kLooseLinearity = 0.5;
/** |v1.z| ≤ 0.5 ⇒ 主方向与水平面夹角 ≤ 30°。 */
constexpr double kLooseVerticality = 0.5;
constexpr std::uint32_t kLooseMinNeighbors = 3;
/**
 * 池子上限：超限**拒绝**而不是截断（截断会让用户看到"少了半根线"且无从察觉），
 * 错误文案引导调高最小离地高（同 LOD 树内存预算拒绝的先例）。
 */
constexpr std::uint64_t kMaxPoolPoints = 4000000;
/** 少于该候选数不开多线程（建线程的开销大于收益；同 euclidean-cluster）。 */
constexpr std::uint64_t kParallelMinPoints = 200000;

/** 连通的方向门限（°）：局部主方向夹角超过它的两点不连——交叉线由此天然断开。 */
constexpr double kConnectAngleGateDeg = 15.0;
/** 端点补全的横向偏移门限（m）：两条线必须在**同一条直线上**才算同一根线的两段。 */
constexpr double kLateralTolerance = 0.5;
/** 方位角投票的分箱宽度（°）；180/3 = 60 箱。 */
constexpr double kAzimuthBinDeg = 3.0;
constexpr int kAzimuthBins = 60;
/** 每次剥离尝试的候选方位角峰数（票数最高的前几个，逐个试拟合取最优）。 */
constexpr int kAzimuthPeaks = 3;
constexpr int kRansacIterations = 384;
/**
 * 三点样本的 s 跨度下限（占片内 s 跨度的比例）。
 *
 * ⚠ 这条是抛物线 RANSAC 能不能用的**关键**：抛物线要外推到整片跨度，样本跨度太小则
 * `a` 的噪声被 (S/d)² 放大——实测 d/S = 0.2 时端部误差 ≈ 25σ（σ ≈ 点噪声），完全不可用；
 * 要求 d/S ≥ 0.35 后误差回到 σ 量级（≤ residualTolerance）。别为了"提高内点率"放宽它。
 */
constexpr double kSampleSpanFraction = 0.35;
/** 三点两两 |Δs| 下限（m）：Vandermonde 的条件数与 (s1−s2)(s2−s3)(s1−s3) 同阶。 */
constexpr double kSampleMinDeltaS = 0.5;
/**
 * 横向切分的空隙阈值（m）：内点按 t 排序后，相邻两点 t 差超过它就切开。
 * 取 0.30 是因为相邻导线间距 0.3–0.5 m（切得开）、而单根线自身的横向散布 ≤ 0.2 m（切不开）。
 */
constexpr double kLateralGapM = 0.30;
/** 横向拟合残差 RMS 上限（m）：挡住"散点组成的厚带"被当成一根线。 */
constexpr double kWireLateralRms = 0.35;
constexpr std::uint32_t kMaxStripsPerComponent = 64;
/** 端点切向估计用几个邻点（两端各取这么多点做主方向）。 */
constexpr std::uint32_t kTangentNeighbors = 8;

// ===========================================================================
// 1. 基础工具
// ===========================================================================

inline double deg2rad(double d) { return d * 3.14159265358979323846 / 180.0; }

/** 确定性 PRNG（xorshift64*）：同种子恒同序列 ⇒ RANSAC 可逐位复现。 */
struct Rng {
  std::uint64_t s;
  explicit Rng(std::uint64_t seed) : s(seed ? seed : 0x9E3779B97F4A7C15ull) {}
  std::uint32_t next() {
    s ^= s >> 12;
    s ^= s << 25;
    s ^= s >> 27;
    return static_cast<std::uint32_t>((s * 0x2545F4914F6CDD1Dull) >> 32);
  }
  /** [0, n) 的均匀下标；n == 0 交 0（调用方保证非空）。 */
  std::uint32_t below(std::uint32_t n) { return n == 0 ? 0 : next() % n; }
};

/**
 * 找根：路径减半（逐字移植自 euclidean-cluster）。
 *
 * 单调性保证无环：parent 指针永远指向**更小的**下标（见 unite 的小根优先），
 * 于是任何一条链都严格递减、必然终止于某个自指的根；并发下读到"稍旧"的父指针
 * 也仍在同一条向根的链上，故不需要加锁。
 */
inline std::uint32_t findRoot(std::atomic<std::uint32_t>* parent, std::uint32_t start) {
  std::uint32_t x = start;
  for (;;) {
    std::uint32_t p = parent[x].load(std::memory_order_relaxed);
    if (p == x) return x;
    const std::uint32_t gp = parent[p].load(std::memory_order_relaxed);
    if (gp == p) return p;
    parent[x].compare_exchange_weak(p, gp, std::memory_order_relaxed);
    x = gp;
  }
}

/**
 * 合并：小根优先（根 = 分量内最小候选号）⇒ 结果是"每个分量一棵以最小号为根的树"，
 * 与线程数、union 顺序**完全无关**（这正是后面能逐位复现的前提）。
 */
inline void unite(std::atomic<std::uint32_t>* parent, std::uint32_t a, std::uint32_t b) {
  for (;;) {
    std::uint32_t ra = findRoot(parent, a);
    std::uint32_t rb = findRoot(parent, b);
    if (ra == rb) return;
    if (ra < rb) std::swap(ra, rb);
    std::uint32_t expected = ra;
    if (parent[ra].compare_exchange_strong(expected, rb, std::memory_order_relaxed)) return;
  }
}

/** 单线程版找根（端点补全的「线 → 合并组」并查集用；这里没有并发，不必原子）。 */
inline std::uint32_t findWireRoot(std::vector<std::uint32_t>& parent, std::uint32_t start) {
  std::uint32_t x = start;
  while (parent[x] != x) {
    parent[x] = parent[parent[x]];  // 路径减半
    x = parent[x];
  }
  return x;
}

/** 3×3 线性方程组，高斯消元 + 部分主元；奇异返回 false。 */
bool solve3x3(double m[3][3], double b[3], double x[3]) {
  for (int col = 0; col < 3; ++col) {
    int piv = col;
    for (int r = col + 1; r < 3; ++r) {
      if (std::abs(m[r][col]) > std::abs(m[piv][col])) piv = r;
    }
    if (std::abs(m[piv][col]) < 1e-14) return false;
    if (piv != col) {
      for (int c = 0; c < 3; ++c) std::swap(m[col][c], m[piv][c]);
      std::swap(b[col], b[piv]);
    }
    const double inv = 1.0 / m[col][col];
    for (int r = col + 1; r < 3; ++r) {
      const double f = m[r][col] * inv;
      if (f == 0.0) continue;
      for (int c = col; c < 3; ++c) m[r][c] -= f * m[col][c];
      b[r] -= f * b[col];
    }
  }
  for (int r = 2; r >= 0; --r) {
    double acc = b[r];
    for (int c = r + 1; c < 3; ++c) acc -= m[r][c] * x[c];
    x[r] = acc / m[r][r];
  }
  return true;
}

/**
 * 循环 Jacobi 特征分解（数值食谱 11.1）。
 *
 * 逐字移植自 `native/registration/src/registration.cc`（那里 N = 3/4/6 三处实例化，
 * 本模块只用 N = 3）。⚠ 上游约定**照旧**：特征值**不排序**、特征向量是**列**、
 * 输入 `a` 被**原地**对角化。调用方要自己挑最大分量（见 principalAxis）。
 */
template <int N>
bool jacobiEigenValuesAndVectors(double a[N][N], double v[N][N], double d[N]) {
  for (int i = 0; i < N; ++i)
    for (int j = 0; j < N; ++j) v[i][j] = (i == j) ? 1.0 : 0.0;

  double b[N];
  double z[N];
  for (int ip = 0; ip < N; ++ip) {
    b[ip] = d[ip] = a[ip][ip];
    z[ip] = 0.0;
  }

  constexpr unsigned kMaxIterationCount = 50;
  for (unsigned iter = 1; iter <= kMaxIterationCount; ++iter) {
    double sm = 0.0;
    for (int ip = 0; ip < N - 1; ++ip)
      for (int iq = ip + 1; iq < N; ++iq) sm += std::abs(a[ip][iq]);
    if (sm == 0.0) return true;

    double tresh = 0.0;
    if (iter < 4) tresh = sm / static_cast<double>(5 * N * N);

    for (int ip = 0; ip < N - 1; ++ip) {
      for (int iq = ip + 1; iq < N; ++iq) {
        const double pq = std::abs(a[ip][iq]) * 100;
        if (iter > 4 && static_cast<float>(std::abs(d[ip]) + pq) == static_cast<float>(std::abs(d[ip])) &&
            static_cast<float>(std::abs(d[iq]) + pq) == static_cast<float>(std::abs(d[iq]))) {
          a[ip][iq] = 0.0;
        } else if (std::abs(a[ip][iq]) > tresh) {
          double h = d[iq] - d[ip];
          double t = 0.0;
          if (static_cast<float>(std::abs(h) + pq) == static_cast<float>(std::abs(h))) {
            t = a[ip][iq] / h;
          } else {
            const double theta = h / (2 * a[ip][iq]);
            t = 1 / (std::abs(theta) + std::sqrt(1 + theta * theta));
            if (theta < 0) t = -t;
          }

          const double c = 1 / std::sqrt(t * t + 1);
          const double s = t * c;
          const double tau = s / (1 + c);
          h = t * a[ip][iq];
          z[ip] -= h;
          z[iq] += h;
          d[ip] -= h;
          d[iq] += h;
          a[ip][iq] = 0.0;

          auto rotate = [&h, s, tau](double& aij, double& akl) {
            const double g = aij;
            h = akl;
            aij = g - s * (h + g * tau);
            akl = h + s * (g - h * tau);
          };
          for (int j = 0; j + 1 <= ip; ++j) rotate(a[j][ip], a[j][iq]);
          for (int j = ip + 1; j + 1 <= iq; ++j) rotate(a[ip][j], a[j][iq]);
          for (int j = iq + 1; j < N; ++j) rotate(a[ip][j], a[iq][j]);
          for (int j = 0; j < N; ++j) rotate(v[j][ip], v[j][iq]);
        }
      }
    }

    for (int ip = 0; ip < N; ++ip) {
      b[ip] += z[ip];
      d[ip] = b[ip];
      z[ip] = 0.0;
    }
  }

  return false;
}

/** 邻域的 PCA 结果：最大特征值方向 + 线型度 linearity = (λ1−λ2)/λ1。 */
struct PcaResult {
  double dir[3] = {1.0, 0.0, 0.0};
  double linearity = 0.0;
  bool valid = false;
};

/** 对一组坐标算 3×3 协方差 + Jacobi，取最大特征值那一列作主方向（全 double）。 */
PcaResult principalAxis(const std::vector<Point>& pts, const std::vector<std::uint32_t>& hits) {
  PcaResult out;
  if (hits.size() < 3) return out;  // 少于 3 点无法定义协方差的秩

  double mx = 0.0;
  double my = 0.0;
  double mz = 0.0;
  for (const std::uint32_t s : hits) {
    mx += static_cast<double>(pts[s].x);
    my += static_cast<double>(pts[s].y);
    mz += static_cast<double>(pts[s].z);
  }
  const double inv = 1.0 / static_cast<double>(hits.size());
  mx *= inv;
  my *= inv;
  mz *= inv;

  double a[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
  for (const std::uint32_t s : hits) {
    const double dx = static_cast<double>(pts[s].x) - mx;
    const double dy = static_cast<double>(pts[s].y) - my;
    const double dz = static_cast<double>(pts[s].z) - mz;
    a[0][0] += dx * dx;
    a[0][1] += dx * dy;
    a[0][2] += dx * dz;
    a[1][1] += dy * dy;
    a[1][2] += dy * dz;
    a[2][2] += dz * dz;
  }
  a[1][0] = a[0][1];
  a[2][0] = a[0][2];
  a[2][1] = a[1][2];
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) a[i][j] *= inv;
  }

  double v[3][3];
  double d[3];
  if (!jacobiEigenValuesAndVectors<3>(a, v, d)) {
    // 50 轮未收敛（实际只在极端病态时发生）：当作无方向，宁可漏也算得出来
    return out;
  }

  // 挑最大 / 次大特征值（Jacobi **不排序**，必须自己挑）
  int i1 = 0;
  for (int i = 1; i < 3; ++i) {
    if (d[i] > d[i1]) i1 = i;
  }
  int i2 = -1;
  for (int i = 0; i < 3; ++i) {
    if (i == i1) continue;
    if (i2 < 0 || d[i] > d[i2]) i2 = i;
  }
  if (!(d[i1] > 0.0)) return out;
  out.dir[0] = v[0][i1];
  out.dir[1] = v[1][i1];
  out.dir[2] = v[2][i1];
  const double l2 = d[i2] > 0.0 ? d[i2] : 0.0;
  out.linearity = (d[i1] - l2) / d[i1];
  out.valid = true;
  return out;
}

/** 地面参考面双线性采样（格心原点、越界钳到边缘格）。镜像 utils/groundGrid.ts#sampleGround。 */
bool sampleGround(const GroundGrid& g, double x, double y, double& out) {
  if (g.values == nullptr || g.cols <= 0 || g.rows <= 0 || !(g.cellSize > 0.0)) return false;
  const double fx = (x - g.originX) / g.cellSize;
  const double fy = (y - g.originY) / g.cellSize;
  double cx = fx < 0.0 ? 0.0 : (fx > static_cast<double>(g.cols - 1) ? static_cast<double>(g.cols - 1) : fx);
  double cy = fy < 0.0 ? 0.0 : (fy > static_cast<double>(g.rows - 1) ? static_cast<double>(g.rows - 1) : fy);
  const int c0 = static_cast<int>(cx);
  const int r0 = static_cast<int>(cy);
  const int c1 = c0 + 1 < g.cols ? c0 + 1 : c0;
  const int r1 = r0 + 1 < g.rows ? r0 + 1 : r0;
  const double du = cx - static_cast<double>(c0);
  const double dv = cy - static_cast<double>(r0);
  const double v00 = static_cast<double>(g.values[static_cast<std::size_t>(r0) * g.cols + c0]);
  const double v01 = static_cast<double>(g.values[static_cast<std::size_t>(r0) * g.cols + c1]);
  const double v10 = static_cast<double>(g.values[static_cast<std::size_t>(r1) * g.cols + c0]);
  const double v11 = static_cast<double>(g.values[static_cast<std::size_t>(r1) * g.cols + c1]);
  const double top = v00 + (v01 - v00) * du;
  const double bot = v10 + (v11 - v10) * du;
  out = top + (bot - top) * dv;
  return true;
}

/** 候选总数（各块 indexCount / vertexCount 之和；hasIndex 语义见 powerline.h）。 */
std::uint64_t countCandidates(const EntitySource& entity) {
  std::uint64_t total = 0;
  for (const ChunkSource& c : entity.chunks) total += c.hasIndex ? c.indexCount : c.vertexCount;
  return total;
}

/** 契约防御（同 euclidean-cluster 的 badIndex 预检）：index 越界一律交空结果。 */
bool indexInRange(const EntitySource& entity) {
  for (const ChunkSource& c : entity.chunks) {
    if (!c.hasIndex) continue;
    for (std::uint32_t k = 0; k < c.indexCount; ++k) {
      if (c.index[k] >= c.vertexCount) return false;
    }
  }
  return true;
}

/** 按硬件并发数决定线程数（0 = 自动；候选太少则不并行）。 */
unsigned resolveThreads(unsigned requested, std::uint64_t total) {
  unsigned threads = requested;
  if (threads == 0) {
    threads = std::thread::hardware_concurrency();
    if (threads == 0) threads = 1;
  }
  if (total < kParallelMinPoints) threads = 1;
  return threads;
}

/** 按**槽位**区间切段并行跑一段代码（槽位 = KD 树里的连续内存，遍历它 = 顺序访问坐标）。 */
template <typename Fn>
void parallelRanges(std::uint32_t n, unsigned threads, Fn&& body) {
  if (threads <= 1 || n == 0) {
    body(static_cast<std::uint32_t>(0), n);
    return;
  }
  std::vector<std::thread> pool;
  pool.reserve(threads);
  const std::uint64_t step = (static_cast<std::uint64_t>(n) + threads - 1) / threads;
  for (unsigned t = 0; t < threads; ++t) {
    const std::uint64_t begin = std::min<std::uint64_t>(t * step, n);
    const std::uint64_t end = std::min<std::uint64_t>(begin + step, n);
    if (begin >= end) break;
    pool.emplace_back([&body, begin, end] {
      body(static_cast<std::uint32_t>(begin), static_cast<std::uint32_t>(end));
    });
  }
  for (std::thread& th : pool) th.join();
}

// ===========================================================================
// 2. 阶段 2 的内部结构
// ===========================================================================

/** 竖直平面坐标系：把点转到 (s 沿走向, t 横向, z 高程)。 */
struct Frame {
  double cosP = 1.0;
  double sinP = 0.0;
  double cx = 0.0;
  double cy = 0.0;
};

inline void toST(const Frame& f, const Point& p, double& s, double& t) {
  const double dx = static_cast<double>(p.x) - f.cx;
  const double dy = static_cast<double>(p.y) - f.cy;
  s = dx * f.cosP + dy * f.sinP;
  t = -dx * f.sinP + dy * f.cosP;
}

/**
 * 垂直平面内的抛物线模型：z = alpha·v² + beta·v + gamma，其中 v = (s − sBar) / halfSpan。
 *
 * **为什么归一化**：s 的量级是百米、s² 是万级，直接解 Vandermonde 条件数很差；
 * 用样本自己的 s̄ 与半跨度归一后 v ∈ [−1, 1]，解与求值都是良好条件的（全 double）。
 */
struct Parabola {
  double alpha = 0.0;
  double beta = 0.0;
  double gamma = 0.0;
  double sBar = 0.0;
  double halfSpan = 1.0;
  bool valid = false;

  double eval(double s) const {
    const double v = (s - sBar) / halfSpan;
    return alpha * v * v + beta * v + gamma;
  }
};

/** 用 3 个点解抛物线（v 归一化到样本自己的跨度上）。 */
bool fitParabola3(const double s[3], const double z[3], Parabola& out) {
  double sBar = (s[0] + s[1] + s[2]) / 3.0;
  double half = 0.0;
  for (int i = 0; i < 3; ++i) half = std::max(half, std::abs(s[i] - sBar));
  if (!(half > 1e-9)) return false;
  double m[3][3];
  double b[3];
  double x[3];
  for (int i = 0; i < 3; ++i) {
    const double v = (s[i] - sBar) / half;
    m[i][0] = v * v;
    m[i][1] = v;
    m[i][2] = 1.0;
    b[i] = z[i];
  }
  if (!solve3x3(m, b, x)) return false;
  out.alpha = x[0];
  out.beta = x[1];
  out.gamma = x[2];
  out.sBar = sBar;
  out.halfSpan = half;
  out.valid = true;
  return true;
}

/** 最小二乘重解抛物线（内点集上；同样归一化，正规方程 3×3）。 */
bool refitParabola(const std::vector<double>& s, const std::vector<double>& z,
                   const std::vector<std::uint32_t>& idx, Parabola& out) {
  if (idx.size() < 3) return false;
  double sMin = s[idx[0]];
  double sMax = s[idx[0]];
  for (const std::uint32_t i : idx) {
    sMin = std::min(sMin, s[i]);
    sMax = std::max(sMax, s[i]);
  }
  const double sBar = (sMin + sMax) * 0.5;
  const double half = (sMax - sMin) * 0.5;
  if (!(half > 1e-9)) return false;

  double m[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
  double b[3] = {0, 0, 0};
  for (const std::uint32_t i : idx) {
    const double v = (s[i] - sBar) / half;
    const double basis[3] = {v * v, v, 1.0};
    for (int r = 0; r < 3; ++r) {
      for (int c = 0; c < 3; ++c) m[r][c] += basis[r] * basis[c];
      b[r] += basis[r] * z[i];
    }
  }
  double x[3];
  if (!solve3x3(m, b, x)) return false;
  out.alpha = x[0];
  out.beta = x[1];
  out.gamma = x[2];
  out.sBar = sBar;
  out.halfSpan = half;
  out.valid = true;
  return true;
}

/** 一条待定的电力线（剥离阶段的产物，尚未做端点补全与编号）。 */
struct WireDraft {
  std::vector<std::uint32_t> ords;  // 候选号（未排序；补全与统计时再按 s 排）
  double phi = 0.0;
};

/** 方位角投票的一个峰（phi ∈ [0, π)，mod π 语义：φ 与 φ+180° 同一条线）。 */
struct AzimuthPeak {
  double phi = 0.0;
  double weight = 0.0;
};

/**
 * 局部主方向 → 方位角分箱投票，取前 kAzimuthPeaks 个峰。
 *
 * 权重 = linearity × 水平分量（|d| 的水平投影长度）：竖直方向（水平分量 ≈ 0）没有可靠方位角，
 * 让它少投票；线型度高的点（真导线）多投票。**不退回「票数 argmax」**——票数最高的方位角
 * 未必拟合得最好，故调用方对每个峰都真跑一次 RANSAC 取最优（见 stripComponent）。
 */
std::vector<AzimuthPeak> voteAzimuth(const std::vector<double>& dir, const std::vector<double>& lin,
                                     const std::vector<std::uint8_t>& hasDir,
                                     const std::vector<std::uint32_t>& active) {
  std::vector<double> bins(kAzimuthBins, 0.0);
  const double binWidth = deg2rad(kAzimuthBinDeg);
  const double pi = 3.14159265358979323846;
  for (const std::uint32_t ord : active) {
    if (hasDir[ord] == 0) continue;
    const double dx = dir[ord * 3];
    const double dy = dir[ord * 3 + 1];
    const double h = std::sqrt(dx * dx + dy * dy);
    if (!(h > 1e-6) || !(lin[ord] > 0.0)) continue;
    double phi = std::atan2(dy, dx);
    if (phi < 0.0) phi += pi;
    if (phi >= pi) phi -= pi;
    int bin = static_cast<int>(phi / binWidth);
    if (bin < 0) bin = 0;
    if (bin >= kAzimuthBins) bin = kAzimuthBins - 1;
    bins[bin] += lin[ord] * h;
  }

  // 局部极大（圆周窗口 ±2 箱）+ 非极大抑制（峰间距 ≥ 4 箱 = 12°）
  std::vector<AzimuthPeak> peaks;
  for (int b = 0; b < kAzimuthBins; ++b) {
    if (!(bins[b] > 0.0)) continue;
    bool isMax = true;
    for (int k = -2; k <= 2 && isMax; ++k) {
      if (k == 0) continue;
      int nb = (b + k + kAzimuthBins) % kAzimuthBins;
      if (bins[nb] > bins[b]) isMax = false;
    }
    if (!isMax) continue;

    // 细化：窗口 ±5 箱内的加权圆均值（用倍角把 mod π 的圆周性处理掉）
    double sumSin = 0.0;
    double sumCos = 0.0;
    double w = 0.0;
    for (int k = -5; k <= 5; ++k) {
      const int nb = (b + k + kAzimuthBins) % kAzimuthBins;
      const double bw = bins[nb];
      if (!(bw > 0.0)) continue;
      const double mid = (static_cast<double>(nb) + 0.5) * binWidth;
      sumSin += bw * std::sin(2.0 * mid);
      sumCos += bw * std::cos(2.0 * mid);
      w += bw;
    }
    AzimuthPeak peak;
    peak.phi = 0.5 * std::atan2(sumSin, sumCos);
    if (peak.phi < 0.0) peak.phi += pi;
    if (peak.phi >= pi) peak.phi -= pi;
    peak.weight = w;
    peaks.push_back(peak);
  }

  std::sort(peaks.begin(), peaks.end(), [](const AzimuthPeak& a, const AzimuthPeak& b) {
    if (a.weight != b.weight) return a.weight > b.weight;
    return a.phi < b.phi;  // 权重并列时按角度定序（确定性）
  });
  if (static_cast<int>(peaks.size()) > kAzimuthPeaks) peaks.resize(kAzimuthPeaks);
  return peaks;
}

/**
 * 横向切分：把内点按 t 的空隙切开（相邻 t 差 > kLateralGapM 就断开）。
 *
 * 这是「平行导线各成一条」的**唯一**手段：同一跨上的各相导线 z(s) 完全相同（同塔、同垂度），
 * 抛物线残差判据**分不开它们**，只能靠横向位置区分。切完还要过一道横向直线拟合的 RMS 闸——
 * 挡的是"散点凑成的厚带"恰好没有 0.3 m 空隙的情形。
 */
void splitLateral(const std::vector<Point>& pts, const std::vector<uint32_t>& slotOf,
                  const std::vector<std::uint32_t>& inliers, const Frame& frame, std::uint32_t minPoints,
                  std::vector<std::vector<std::uint32_t>>& clusters) {
  if (inliers.empty()) return;
  struct Item {
    double t;
    double s;
    std::uint32_t ord;
  };
  std::vector<Item> items(inliers.size());
  for (std::size_t i = 0; i < inliers.size(); ++i) {
    double s = 0.0;
    double t = 0.0;
    toST(frame, pts[slotOf[inliers[i]]], s, t);
    items[i] = Item{t, s, inliers[i]};
  }
  std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
    if (a.t != b.t) return a.t < b.t;
    return a.ord < b.ord;  // 并列时按候选号（确定性）
  });

  std::size_t begin = 0;
  for (std::size_t i = 1; i <= items.size(); ++i) {
    const bool cut = (i == items.size()) || (items[i].t - items[i - 1].t > kLateralGapM);
    if (!cut) continue;
    const std::size_t count = i - begin;
    if (count >= minPoints) {
      // 横向直线拟合 t = a·s + b（一次修剪的稳健化），残差 RMS 过闸才算一根线
      std::vector<std::uint32_t> idx;
      idx.reserve(count);
      for (std::size_t k = begin; k < i; ++k) idx.push_back(static_cast<std::uint32_t>(k));
      for (int round = 0; round < 2; ++round) {
        double sSum = 0.0;
        double tSum = 0.0;
        for (const std::uint32_t k : idx) {
          sSum += items[k].s;
          tSum += items[k].t;
        }
        const double n = static_cast<double>(idx.size());
        const double sm = sSum / n;
        const double tm = tSum / n;
        double suu = 0.0;
        double sut = 0.0;
        for (const std::uint32_t k : idx) {
          const double u = items[k].s - sm;
          suu += u * u;
          sut += u * (items[k].t - tm);
        }
        const double slope = suu > 0.0 ? sut / suu : 0.0;
        double acc = 0.0;
        for (const std::uint32_t k : idx) {
          const double u = items[k].s - sm;
          const double r = (items[k].t - tm) - slope * u;
          acc += r * r;
        }
        const double rms = std::sqrt(acc / n);
        if (round == 0) {
          const double limit = std::max(3.0 * rms, kLateralGapM);
          std::vector<std::uint32_t> kept;
          kept.reserve(idx.size());
          for (const std::uint32_t k : idx) {
            const double u = items[k].s - sm;
            const double r = (items[k].t - tm) - slope * u;
            if (std::abs(r) <= limit) kept.push_back(k);
          }
          if (kept.size() >= minPoints) {
            idx.swap(kept);
            continue;
          }
        }
        if (rms <= kWireLateralRms) {
          std::vector<std::uint32_t> cluster;
          cluster.reserve(idx.size());
          for (const std::uint32_t k : idx) cluster.push_back(items[k].ord);
          clusters.push_back(std::move(cluster));
        }
        break;
      }
    }
    begin = i;
  }
}

/**
 * 逐连通片剥离导线：反复「方位角投票 → 垂直平面抛物线段 RANSAC → 横向切分」。
 *
 * 不变量：每轮至少移走 minPoints 个内点，故循环必然终止（且有 kMaxStripsPerComponent 硬上限）。
 * **内点无论有没有被横向切分成簇，都从 active 里移走**——否则下一轮会重新拟合出同一个抛物线、
 * 反复失败却不减少点数（死循环）。
 */
void stripComponent(const std::vector<Point>& pts, const std::vector<uint32_t>& slotOf,
                    const std::vector<double>& dir, const std::vector<double>& lin,
                    const std::vector<std::uint8_t>& hasDir, const std::vector<std::uint32_t>& compOrds,
                    const TraceParams& params, std::vector<WireDraft>& out) {
  const std::uint32_t minPoints = params.minLinePoints;
  const double tol = params.residualTolerance;
  if (compOrds.size() < minPoints) return;

  std::vector<std::uint32_t> active = compOrds;

  Rng rng(0x5DEECE66Dull);  // 固定种子：每次剥离都从头开始，逐位可复现

  for (std::uint32_t iter = 0; iter < kMaxStripsPerComponent; ++iter) {
    if (active.size() < minPoints) break;

    // 片内质心（旋转原点，数值稳定用）
    Frame frame;
    double cx = 0.0;
    double cy = 0.0;
    for (const std::uint32_t ord : active) {
      cx += static_cast<double>(pts[slotOf[ord]].x);
      cy += static_cast<double>(pts[slotOf[ord]].y);
    }
    const double invN = 1.0 / static_cast<double>(active.size());
    frame.cx = cx * invN;
    frame.cy = cy * invN;

    std::vector<AzimuthPeak> peaks = voteAzimuth(dir, lin, hasDir, active);
    if (peaks.empty()) break;

    // 每个候选方位角都真拟合一次，取内点最多的（**不是**票数 argmax，见 voteAzimuth 注释）
    std::vector<std::uint32_t> bestIdx;  // active 的**下标**（不是候选号：删除时避免 O(n²) 查找）
    double bestPhi = peaks[0].phi;
    for (const AzimuthPeak& peak : peaks) {
      frame.cosP = std::cos(peak.phi);
      frame.sinP = std::sin(peak.phi);

      std::vector<double> s(active.size(), 0.0);
      std::vector<double> z(active.size(), 0.0);
      double sMin = 0.0;
      double sMax = 0.0;
      for (std::size_t i = 0; i < active.size(); ++i) {
        double t = 0.0;
        const Point& p = pts[slotOf[active[i]]];
        toST(frame, p, s[i], t);
        z[i] = static_cast<double>(p.z);
        if (i == 0) {
          sMin = sMax = s[i];
        } else {
          sMin = std::min(sMin, s[i]);
          sMax = std::max(sMax, s[i]);
        }
      }
      const double span = sMax - sMin;
      if (!(span > 2.0 * kSampleMinDeltaS)) continue;  // 跨度太小：抛物线退化成直线，跳过

      std::uint32_t bestCount = 0;
      Parabola best;
      const std::uint32_t n = static_cast<std::uint32_t>(active.size());
      for (int it = 0; it < kRansacIterations; ++it) {
        const std::uint32_t i0 = rng.below(n);
        const std::uint32_t i1 = rng.below(n);
        const std::uint32_t i2 = rng.below(n);
        if (i0 == i1 || i1 == i2 || i0 == i2) continue;
        const double ss[3] = {s[i0], s[i1], s[i2]};
        const double zz[3] = {z[i0], z[i1], z[i2]};
        const double lo = std::min(ss[0], std::min(ss[1], ss[2]));
        const double hi = std::max(ss[0], std::max(ss[1], ss[2]));
        if (hi - lo < kSampleSpanFraction * span) continue;  // 见 kSampleSpanFraction 注释
        if (hi - lo < kSampleMinDeltaS) continue;

        Parabola model;
        if (!fitParabola3(ss, zz, model)) continue;
        std::uint32_t count = 0;
        for (std::uint32_t i = 0; i < n; ++i) {
          if (std::abs(z[i] - model.eval(s[i])) <= tol) ++count;
        }
        if (count > bestCount) {
          bestCount = count;
          best = model;
        }
      }
      if (bestCount == 0 || !best.valid) continue;

      // 内点最小二乘精修（两轮：重解 → 重收内点 → 再重解）
      std::vector<std::uint32_t> inliers;
      Parabola refined = best;
      for (int round = 0; round < 2; ++round) {
        inliers.clear();
        for (std::uint32_t i = 0; i < n; ++i) {
          if (std::abs(z[i] - refined.eval(s[i])) <= tol) inliers.push_back(i);
        }
        if (inliers.size() < minPoints) break;
        if (!refitParabola(s, z, inliers, refined)) break;
      }
      if (inliers.size() < minPoints) continue;
      if (!refined.valid) continue;

      if (bestIdx.empty() || inliers.size() > bestIdx.size()) {
        bestIdx = inliers;
        bestPhi = peak.phi;
      }
    }
    if (bestIdx.size() < minPoints) break;

    // 横向切分（平行导线各成一条）：切分按候选号走，故先摊平一份
    frame.cosP = std::cos(bestPhi);
    frame.sinP = std::sin(bestPhi);
    std::vector<std::uint32_t> bestOrds;
    bestOrds.reserve(bestIdx.size());
    for (const std::uint32_t i : bestIdx) bestOrds.push_back(active[i]);
    std::vector<std::vector<std::uint32_t>> clusters;
    splitLateral(pts, slotOf, bestOrds, frame, minPoints, clusters);
    for (std::vector<std::uint32_t>& cluster : clusters) {
      WireDraft draft;
      draft.ords = std::move(cluster);
      draft.phi = bestPhi;
      out.push_back(std::move(draft));
    }

    // 内点整体移出 active（无论是否成簇）——保证进展，见函数头注释
    std::vector<std::uint8_t> drop(active.size(), 0);
    for (const std::uint32_t i : bestIdx) drop[i] = 1;
    std::vector<std::uint32_t> nextActive;
    nextActive.reserve(active.size());
    for (std::size_t i = 0; i < active.size(); ++i) {
      if (drop[i] == 0) nextActive.push_back(active[i]);
    }
    active.swap(nextActive);
  }
}

// ===========================================================================
// 3. 阶段 1：extractCandidates
// ===========================================================================

bool extractEntity(const ExtractParams& params, const GroundGrid& grid, const EntitySource& entity,
                   ExtractEntityResult& result, std::string& error, unsigned threadCount) {
  const std::uint64_t total = countCandidates(entity);
  if (total > 0xffffffffull) {
    error = "候选点数超过 uint32 空间";
    return false;
  }
  if (!indexInRange(entity)) {
    error = "index 越界（契约破损）";
    return false;
  }

  // 1) 离地筛：块主序平铺「离地点」，同时记录每点的 (块, 顶点) 以便回填 kept
  std::vector<Point> pts;
  std::vector<std::uint32_t> chunkOf;
  std::vector<std::uint32_t> vertexOf;
  std::vector<float> hagOf;
  const std::uint32_t chunkCount = static_cast<std::uint32_t>(entity.chunks.size());
  result.chunks.assign(chunkCount, ExtractChunkResult{});
  for (std::uint32_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t count = src.hasIndex ? src.indexCount : src.vertexCount;
    for (std::uint32_t k = 0; k < count; ++k) {
      const std::uint32_t v = src.hasIndex ? src.index[k] : k;
      const float* p = src.positions + static_cast<std::size_t>(v) * 3;
      double ground = 0.0;
      if (!sampleGround(grid, p[0], p[1], ground)) continue;  // 无地面参考面：全落选（不至于静默出线）
      const double hag = static_cast<double>(p[2]) - ground;
      if (!(hag >= params.minHeight)) continue;  // NaN 也走这里
      const std::uint32_t ord = static_cast<std::uint32_t>(pts.size());
      pts.push_back(Point{p[0], p[1], p[2], ord});
      chunkOf.push_back(c);
      vertexOf.push_back(v);
      hagOf.push_back(static_cast<float>(hag));
    }
  }
  result.offGroundCount = pts.size();
  if (pts.empty()) return true;

  // 2) KD 树 + 逐点协方差/PCA（**全 double**，与分块方式无关）
  KdTree tree;
  tree.build(pts);
  const std::uint32_t n = static_cast<std::uint32_t>(pts.size());
  std::vector<double> linearity(n, 0.0);
  std::vector<double> verticality(n, 0.0);
  std::vector<std::uint32_t> neighborCount(n, 0);
  const double r2 = params.radius * params.radius;
  const unsigned threads = resolveThreads(threadCount, pts.size());

  parallelRanges(n, threads, [&](std::uint32_t begin, std::uint32_t end) {
    std::vector<std::uint32_t> hits;
    for (std::uint32_t s = begin; s < end; ++s) {
      tree.radiusSearch(pts, s, r2, hits);
      const std::uint32_t ord = pts[s].code;  // 树重排过，必须回填到候选号上（确定性）
      neighborCount[ord] = static_cast<std::uint32_t>(hits.size());
      const PcaResult pca = principalAxis(pts, hits);
      if (pca.valid) {
        linearity[ord] = pca.linearity;
        verticality[ord] = std::abs(pca.dir[2]);
      }
    }
  });

  // 3) 宽松闸 → 池子（块主序，故 kept 天然升序）
  std::vector<std::uint32_t> pool;
  pool.reserve(pts.size() / 4 + 1);
  for (std::uint32_t ord = 0; ord < n; ++ord) {
    if (!(linearity[ord] >= kLooseLinearity)) continue;
    if (!(verticality[ord] <= kLooseVerticality)) continue;
    if (neighborCount[ord] < kLooseMinNeighbors) continue;
    if (static_cast<std::uint64_t>(pool.size()) >= kMaxPoolPoints) {
      error = "离地点池超过 400 万上限，请调高最小离地高（或改用更小的区域）";
      return false;
    }
    pool.push_back(ord);
  }
  result.poolCount = pool.size();
  result.linearity.resize(pool.size());
  result.verticality.resize(pool.size());
  result.hag.resize(pool.size());
  result.neighborCount.resize(pool.size());
  for (std::size_t i = 0; i < pool.size(); ++i) {
    const std::uint32_t ord = pool[i];
    result.chunks[chunkOf[ord]].kept.push_back(vertexOf[ord]);
    result.linearity[i] = static_cast<float>(linearity[ord]);
    result.verticality[i] = static_cast<float>(verticality[ord]);
    result.hag[i] = hagOf[ord];
    result.neighborCount[i] = neighborCount[ord];
  }
  return true;
}

// ===========================================================================
// 4. 阶段 2：traceLines
// ===========================================================================

/** 一条线的最终统计（补全合并之后按整条线重算）。 */
struct LineStats {
  std::uint32_t pointCount = 0;
  double length = 0.0;
  double sag = 0.0;
  double azimuthDeg = 0.0;
  double rms = 0.0;
};

/** 逐条线的统计：方位角取水平主方向、长度取两端点三维距离、垂度取相对弦线的最大下偏。 */
LineStats computeLineStats(const std::vector<Point>& pts, const std::vector<std::uint32_t>& slotOf,
                           const std::vector<std::uint32_t>& ords) {
  LineStats st;
  st.pointCount = static_cast<std::uint32_t>(ords.size());
  if (ords.size() < 2) return st;

  double mx = 0.0;
  double my = 0.0;
  for (const std::uint32_t ord : ords) {
    mx += static_cast<double>(pts[slotOf[ord]].x);
    my += static_cast<double>(pts[slotOf[ord]].y);
  }
  const double inv = 1.0 / static_cast<double>(ords.size());
  mx *= inv;
  my *= inv;

  double cxx = 0.0;
  double cxy = 0.0;
  double cyy = 0.0;
  for (const std::uint32_t ord : ords) {
    const double dx = static_cast<double>(pts[slotOf[ord]].x) - mx;
    const double dy = static_cast<double>(pts[slotOf[ord]].y) - my;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  const double pi = 3.14159265358979323846;
  double theta = 0.5 * std::atan2(2.0 * cxy, cxx - cyy);
  if (theta < 0.0) theta += pi;
  if (theta >= pi) theta -= pi;
  st.azimuthDeg = theta * 180.0 / pi;

  Frame frame;
  frame.cosP = std::cos(theta);
  frame.sinP = std::sin(theta);
  frame.cx = mx;
  frame.cy = my;

  std::vector<std::pair<double, std::uint32_t>> byS;
  byS.reserve(ords.size());
  for (const std::uint32_t ord : ords) {
    double s = 0.0;
    double t = 0.0;
    toST(frame, pts[slotOf[ord]], s, t);
    byS.emplace_back(s, ord);
  }
  std::sort(byS.begin(), byS.end(), [](const std::pair<double, std::uint32_t>& a,
                                       const std::pair<double, std::uint32_t>& b) {
    if (a.first != b.first) return a.first < b.first;
    return a.second < b.second;
  });

  const Point& p0 = pts[slotOf[byS.front().second]];
  const Point& p1 = pts[slotOf[byS.back().second]];
  const double dx = static_cast<double>(p1.x) - p0.x;
  const double dy = static_cast<double>(p1.y) - p0.y;
  const double dz = static_cast<double>(p1.z) - p0.z;
  st.length = std::sqrt(dx * dx + dy * dy + dz * dz);

  const double s0 = byS.front().first;
  const double s1 = byS.back().first;
  if (s1 - s0 > 1e-9) {
    const double z0 = static_cast<double>(p0.z);
    const double z1 = static_cast<double>(p1.z);
    double sag = 0.0;
    for (const std::pair<double, std::uint32_t>& item : byS) {
      const double zc = z0 + (z1 - z0) * (item.first - s0) / (s1 - s0);
      const double drop = zc - static_cast<double>(pts[slotOf[item.second]].z);
      sag = std::max(sag, drop);
    }
    st.sag = sag > 0.0 ? sag : 0.0;
  }

  // 二次模型的最小二乘残差 RMS（在归一化坐标里解，条件数无忧）
  const double sMid = (s0 + s1) * 0.5;
  const double sHalf = (s1 - s0) * 0.5;
  if (sHalf > 1e-9) {
    double m[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
    double b[3] = {0, 0, 0};
    for (const std::pair<double, std::uint32_t>& item : byS) {
      const double v = (item.first - sMid) / sHalf;
      const double basis[3] = {v * v, v, 1.0};
      const double z = static_cast<double>(pts[slotOf[item.second]].z);
      for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) m[r][c] += basis[r] * basis[c];
        b[r] += basis[r] * z;
      }
    }
    double x[3];
    if (solve3x3(m, b, x)) {
      double acc = 0.0;
      for (const std::pair<double, std::uint32_t>& item : byS) {
        const double v = (item.first - sMid) / sHalf;
        const double r = static_cast<double>(pts[slotOf[item.second]].z) - (x[0] * v * v + x[1] * v + x[2]);
        acc += r * r;
      }
      st.rms = std::sqrt(acc / static_cast<double>(byS.size()));
    }
  }
  return st;
}

TraceEntityResult traceEntity(const TraceParams& params, const EntitySource& entity, unsigned threadCount) {
  TraceEntityResult result;
  const std::uint64_t total = countCandidates(entity);
  result.candidateTotal = total;
  if (total > 0xffffffffull) return TraceEntityResult{};  // 契约防御：交空结果（干净失败）
  if (!indexInRange(entity)) return TraceEntityResult{};
  if (total == 0) return result;

  const std::uint32_t n = static_cast<std::uint32_t>(total);
  std::vector<Point> pts(n);
  {
    std::size_t w = 0;
    for (const ChunkSource& c : entity.chunks) {
      if (c.hasIndex) {
        for (std::uint32_t k = 0; k < c.indexCount; ++k, ++w) {
          const float* p = c.positions + static_cast<std::size_t>(c.index[k]) * 3;
          pts[w] = Point{p[0], p[1], p[2], static_cast<std::uint32_t>(w)};
        }
      } else {
        for (std::uint32_t v = 0; v < c.vertexCount; ++v, ++w) {
          const float* p = c.positions + static_cast<std::size_t>(v) * 3;
          pts[w] = Point{p[0], p[1], p[2], static_cast<std::uint32_t>(w)};
        }
      }
    }
  }

  KdTree tree;
  tree.build(pts);
  // 槽位 → 候选号的反查（树重排后按候选号取坐标只能走这张表）
  std::vector<std::uint32_t> slotOf(n, 0);
  for (std::uint32_t s = 0; s < n; ++s) slotOf[pts[s].code] = s;

  // 1) 局部方向（PCA）：连通的角度门限与方位角投票都要用
  std::vector<double> dir(static_cast<std::size_t>(n) * 3, 0.0);
  std::vector<double> lin(n, 0.0);
  std::vector<std::uint8_t> hasDir(n, 0);
  const double dirRadius = params.dirRadius > 0.0 ? params.dirRadius : params.connectRadius;
  const double dirR2 = dirRadius * dirRadius;
  const unsigned threads = resolveThreads(threadCount, total);
  parallelRanges(n, threads, [&](std::uint32_t begin, std::uint32_t end) {
    std::vector<std::uint32_t> hits;
    for (std::uint32_t s = begin; s < end; ++s) {
      tree.radiusSearch(pts, s, dirR2, hits);
      const std::uint32_t ord = pts[s].code;
      const PcaResult pca = principalAxis(pts, hits);
      if (!pca.valid) continue;
      dir[ord * 3] = pca.dir[0];
      dir[ord * 3 + 1] = pca.dir[1];
      dir[ord * 3 + 2] = pca.dir[2];
      lin[ord] = pca.linearity;
      hasDir[ord] = 1;
    }
  });

  // 2) 连通 + 并行并查集（大半径粘住平行/交叉线，方向门限把交叉线断开）
  std::unique_ptr<std::atomic<std::uint32_t>[]> parent(new std::atomic<std::uint32_t>[n]);
  for (std::uint32_t i = 0; i < n; ++i) parent[i].store(i, std::memory_order_relaxed);
  const double connectR2 = params.connectRadius * params.connectRadius;
  const double cosGate = params.connectRadius > 0.0 ? std::cos(deg2rad(kConnectAngleGateDeg)) : 1.0;

  parallelRanges(n, threads, [&](std::uint32_t begin, std::uint32_t end) {
    std::vector<std::uint32_t> hits;
    for (std::uint32_t s = begin; s < end; ++s) {
      tree.radiusSearch(pts, s, connectR2, hits);
      const std::uint32_t g = pts[s].code;
      for (const std::uint32_t hit : hits) {
        const std::uint32_t h = pts[hit].code;
        if (h <= g) continue;  // 无序对只处理一次
        if (hasDir[g] != 0 && hasDir[h] != 0) {
          const double dot = dir[g * 3] * dir[h * 3] + dir[g * 3 + 1] * dir[h * 3 + 1] +
                             dir[g * 3 + 2] * dir[h * 3 + 2];
          if (std::abs(dot) < cosGate) continue;  // 夹角 > 门限：交叉线在此断开
        }
        unite(parent.get(), g, h);
      }
    }
  });

  // 3) 分量（按候选序首遇编号 ⇒ 与线程数、union 顺序无关）
  std::vector<std::int32_t> compOf(n, 0);
  std::vector<std::vector<std::uint32_t>> comps;
  {
    std::vector<std::int32_t> rootComp(n, 0);
    std::int32_t k = 0;
    for (std::uint32_t g = 0; g < n; ++g) {
      const std::uint32_t r = findRoot(parent.get(), g);
      std::int32_t comp = rootComp[r];
      if (comp == 0) {
        comp = ++k;
        rootComp[r] = comp;
        comps.emplace_back();
      }
      compOf[g] = comp;
      comps[static_cast<std::size_t>(comp) - 1].push_back(g);
    }
  }

  // 4) 逐片剥离（跳过点数不够的片——纯噪声片占了绝大多数，这一步是性能关键）
  std::vector<WireDraft> wires;
  for (const std::vector<std::uint32_t>& comp : comps) {
    stripComponent(pts, slotOf, dir, lin, hasDir, comp, params, wires);
  }

  // 5) 端点补全（球面搜索 + 共线门限；同一对端点只连一次、按得分取优）
  const std::size_t wireCount = wires.size();
  std::vector<std::uint32_t> mergeParent(wireCount);
  for (std::uint32_t i = 0; i < wireCount; ++i) mergeParent[i] = i;
  std::vector<std::uint32_t> gapCount(wireCount, 0);
  if (wireCount > 1) {
    struct End {
      std::uint32_t wire = 0;
      double px = 0.0;
      double py = 0.0;
      double pz = 0.0;
      double tx = 0.0;  // 向外切向
      double ty = 0.0;
      double tz = 0.0;
      bool used = false;
    };
    std::vector<End> ends;
    ends.reserve(wireCount * 2);
    for (std::uint32_t i = 0; i < wireCount; ++i) {
      WireDraft& w = wires[i];
      if (w.ords.size() < 2) {
        // 退化：单点线不可能过 minLinePoints（≥ 2），但防御性跳过
        continue;
      }
      Frame frame;
      frame.cosP = std::cos(w.phi);
      frame.sinP = std::sin(w.phi);
      std::vector<std::pair<double, std::uint32_t>> byS;
      byS.reserve(w.ords.size());
      for (const std::uint32_t ord : w.ords) {
        double s = 0.0;
        double t = 0.0;
        toST(frame, pts[slotOf[ord]], s, t);
        byS.emplace_back(s, ord);
      }
      std::sort(byS.begin(), byS.end(), [](const std::pair<double, std::uint32_t>& a,
                                           const std::pair<double, std::uint32_t>& b) {
        if (a.first != b.first) return a.first < b.first;
        return a.second < b.second;
      });
      w.ords.clear();
      for (const std::pair<double, std::uint32_t>& item : byS) w.ords.push_back(item.second);

      const std::uint32_t last = static_cast<std::uint32_t>(w.ords.size() - 1);
      // 两端各取一个"内侧邻点"：端点切向 = 端点 − 邻点（向外）。邻点取不满 8 个就用另一端
      const std::uint32_t headInner = kTangentNeighbors < last ? kTangentNeighbors : last;
      const std::uint32_t tailInner = last > kTangentNeighbors ? last - kTangentNeighbors : 0;
      for (int side = 0; side < 2; ++side) {
        const std::uint32_t a = side == 0 ? 0u : last;  // 端点
        const std::uint32_t b = side == 0 ? headInner : tailInner;
        const Point& pa = pts[slotOf[w.ords[a]]];
        const Point& pb = pts[slotOf[w.ords[b]]];
        double vx = static_cast<double>(pa.x) - pb.x;
        double vy = static_cast<double>(pa.y) - pb.y;
        double vz = static_cast<double>(pa.z) - pb.z;
        const double len = std::sqrt(vx * vx + vy * vy + vz * vz);
        if (!(len > 1e-9)) continue;
        vx /= len;
        vy /= len;
        vz /= len;
        End e;
        e.wire = i;
        e.px = pa.x;
        e.py = pa.y;
        e.pz = pa.z;
        e.tx = vx;
        e.ty = vy;
        e.tz = vz;
        ends.push_back(e);
      }
    }

    struct Junction {
      std::size_t a = 0;
      std::size_t b = 0;
      double score = 0.0;
    };
    std::vector<Junction> junctions;
    const double angleGate = deg2rad(params.gapAngleDeg);
    const double cosGap = std::cos(angleGate);
    /** 判定一对有向端点 (ia → ib) 是否可连，可连则记入 junctions。 */
    const auto addJunction = [&](std::size_t ia, std::size_t ib) {
      const End& ea = ends[ia];
      const End& eb = ends[ib];
      if (ea.wire == eb.wire) return;  // 同一根线的两端不互连
      const double dx = eb.px - ea.px;
      const double dy = eb.py - ea.py;
      const double dz = eb.pz - ea.pz;
      const double dist = std::sqrt(dx * dx + dy * dy + dz * dz);
      if (!(dist > 0.0) || dist > params.gapRadius) return;
      const double invD = 1.0 / dist;
      const double ux = dx * invD;
      const double uy = dy * invD;
      const double uz = dz * invD;
      // 连接向量须顺着 A 的外向切向、逆着 B 的外向切向
      const double dotA = ux * ea.tx + uy * ea.ty + uz * ea.tz;
      const double dotB = ux * eb.tx + uy * eb.ty + uz * eb.tz;
      if (dotA < cosGap || dotB > -cosGap) return;
      // 横向偏移：对端端点到「过本端端点、方向 = 本端切向」的直线距离（两条线必须共线）。
      // 取两侧的较大值：只查一侧的话，"平行但不共线"的两段（例如相邻导线的断口）会被连上。
      const double projA = dx * ea.tx + dy * ea.ty + dz * ea.tz;
      const double lx = dx - projA * ea.tx;
      const double ly = dy - projA * ea.ty;
      const double lz = dz - projA * ea.tz;
      const double lateralA = std::sqrt(lx * lx + ly * ly + lz * lz);
      const double projB = -(dx * eb.tx + dy * eb.ty + dz * eb.tz);
      const double mx = dx + projB * eb.tx;
      const double my = dy + projB * eb.ty;
      const double mz = dz + projB * eb.tz;
      const double lateralB = std::sqrt(mx * mx + my * my + mz * mz);
      const double lateral = std::max(lateralA, lateralB);
      if (lateral > kLateralTolerance) return;
      const double angleA = std::acos(std::min(1.0, std::max(-1.0, dotA)));
      const double angleB = std::acos(std::min(1.0, std::max(-1.0, -dotB)));
      Junction jn;
      jn.a = ia;
      jn.b = ib;
      jn.score = lateral + dist * 0.5 * (angleA + angleB);
      junctions.push_back(jn);
    };

    // 端点配对走 KD 树：朴素双重循环是 O(E²)，而残片多的大场景里 E 可达上万。
    // 半径留 5 cm 余量——端点坐标存进 KD 树时降到 float，边界上的对可能被舍掉。
    if (!ends.empty()) {
      std::vector<Point> endPts(ends.size());
      for (std::size_t i = 0; i < ends.size(); ++i) {
        endPts[i] = Point{static_cast<float>(ends[i].px), static_cast<float>(ends[i].py),
                          static_cast<float>(ends[i].pz), static_cast<std::uint32_t>(i)};
      }
      KdTree endTree;
      endTree.build(endPts);
      const double searchR = params.gapRadius + 0.05;
      const double searchR2 = searchR * searchR;
      std::vector<std::uint32_t> hits;
      // 遍历**槽位**即可覆盖全部端点（树重排了 endPts，故用槽位而非候选号）
      for (std::uint32_t s = 0; s < static_cast<std::uint32_t>(endPts.size()); ++s) {
        endTree.radiusSearch(endPts, s, searchR2, hits);
        const std::uint32_t g = endPts[s].code;
        for (const std::uint32_t hit : hits) {
          const std::uint32_t h = endPts[hit].code;
          if (h == g) continue;
          addJunction(g, h);  // 两个方向都判（门限是有向的）
          addJunction(h, g);
        }
      }
    }
    std::sort(junctions.begin(), junctions.end(), [](const Junction& a, const Junction& b) {
      if (a.score != b.score) return a.score < b.score;
      if (a.a != b.a) return a.a < b.a;
      return a.b < b.b;
    });
    for (const Junction& jn : junctions) {
      if (ends[jn.a].used || ends[jn.b].used) continue;
      const std::uint32_t ra = mergeParent[findWireRoot(mergeParent, ends[jn.a].wire)];
      const std::uint32_t rb = mergeParent[findWireRoot(mergeParent, ends[jn.b].wire)];
      if (ra == rb) continue;
      ends[jn.a].used = true;
      ends[jn.b].used = true;
      const std::uint32_t keep = std::min(ra, rb);
      const std::uint32_t drop = std::max(ra, rb);
      mergeParent[drop] = keep;
      gapCount[keep] += gapCount[drop] + 1;
      gapCount[drop] = 0;
      mergeParent[keep] = keep;
    }
  }

  // 6) 汇总成线 → 统计 → 过闸 → 编号（按各线最小候选号 = 候选序首遇，块主序）
  struct FinalLine {
    std::vector<std::uint32_t> ords;
    LineStats stats;
    std::uint32_t gapCount = 0;
    std::uint32_t firstOrd = 0;
  };
  std::vector<FinalLine> finals;
  {
    std::vector<std::vector<std::uint32_t>> grouped(wireCount);
    for (std::uint32_t i = 0; i < wireCount; ++i) {
      grouped[findWireRoot(mergeParent, i)].insert(grouped[findWireRoot(mergeParent, i)].end(),
                                                    wires[i].ords.begin(), wires[i].ords.end());
    }
    for (std::uint32_t i = 0; i < wireCount; ++i) {
      if (grouped[i].empty()) continue;
      FinalLine line;
      line.ords = std::move(grouped[i]);
      std::sort(line.ords.begin(), line.ords.end());
      line.ords.erase(std::unique(line.ords.begin(), line.ords.end()), line.ords.end());
      if (line.ords.size() < params.minLinePoints) continue;
      line.stats = computeLineStats(pts, slotOf, line.ords);
      if (line.stats.length < params.minLineLength) continue;
      line.gapCount = gapCount[i];
      line.firstOrd = line.ords.front();
      finals.push_back(std::move(line));
    }
  }
  std::sort(finals.begin(), finals.end(), [](const FinalLine& a, const FinalLine& b) {
    if (a.firstOrd != b.firstOrd) return a.firstOrd < b.firstOrd;
    return a.ords.size() > b.ords.size();
  });

  result.labels.assign(n, 0);
  result.lines.clear();
  result.lines.reserve(finals.size());
  std::uint64_t counted = 0;
  for (std::size_t i = 0; i < finals.size(); ++i) {
    const std::uint32_t id = static_cast<std::uint32_t>(i) + 1;
    for (const std::uint32_t ord : finals[i].ords) result.labels[ord] = static_cast<std::int32_t>(id);
    counted += finals[i].ords.size();
    TraceLineInfo info;
    info.id = id;
    info.pointCount = finals[i].stats.pointCount;
    info.length = finals[i].stats.length;
    info.sag = finals[i].stats.sag;
    info.azimuthDeg = finals[i].stats.azimuthDeg;
    info.rms = finals[i].stats.rms;
    info.gapCount = finals[i].gapCount;
    result.lines.push_back(info);
  }
  result.noiseCount = static_cast<std::uint64_t>(n) - counted;
  return result;
}

}  // namespace

// ===========================================================================
// 5. 对外入口
// ===========================================================================

bool extractCandidates(const ExtractParams& params, const GroundGrid& grid,
                       const std::vector<EntitySource>& entities, ExtractResult& out, std::string& error,
                       unsigned threadCount) {
  out.entities.clear();
  error.clear();
  out.entities.resize(entities.size());
  for (std::size_t e = 0; e < entities.size(); ++e) {
    if (!extractEntity(params, grid, entities[e], out.entities[e], error, threadCount)) {
      out.entities.clear();
      return false;
    }
  }
  return true;
}

void traceLines(const TraceParams& params, const std::vector<EntitySource>& entities, TraceResult& out,
                unsigned threadCount) {
  out.entities.clear();
  out.entities.reserve(entities.size());
  for (const EntitySource& entity : entities) {
    out.entities.push_back(traceEntity(params, entity, threadCount));
  }
}

}  // namespace powerline
