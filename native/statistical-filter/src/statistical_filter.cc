#include "statistical_filter.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace sor_filter {

namespace {

/** 网格格坐标（三轴均为已 floor 到格边长的整数格号，相对 span.min 的偏移）。 */
struct CellKey {
  std::int64_t ix;
  std::int64_t iy;
  std::int64_t iz;
  bool operator==(const CellKey& o) const {
    return ix == o.ix && iy == o.iy && iz == o.iz;
  }
};

/** 格坐标哈希（FNV-1a 混合，桶规模来自点云而非对抗输入，足够均匀）。 */
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

/** 由候选全局编码取该点坐标（xyz 输出）。 */
inline void candidateXyz(const ChunkSource& src, std::uint32_t local, double* x, double* y,
                         double* z) {
  const std::uint32_t vertex = src.index ? src.index[local] : local;
  const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
  *x = static_cast<double>(p[0]);
  *y = static_cast<double>(p[1]);
  *z = static_cast<double>(p[2]);
}

/** 网格跨度（格号闭区间，含 min 偏移前的最小格号，供 key 反解坐标区间）。 */
struct CellSpan {
  std::int64_t minIx;
  std::int64_t maxIx;
  std::int64_t minIy;
  std::int64_t maxIy;
  std::int64_t minIz;
  std::int64_t maxIz;
};

/** 轴跨度宽度（key 合法域 [0, width)）。 */
inline std::int64_t spanWidthIx(const CellSpan& s) { return s.maxIx - s.minIx + 1; }
inline std::int64_t spanWidthIy(const CellSpan& s) { return s.maxIy - s.minIy + 1; }
inline std::int64_t spanWidthIz(const CellSpan& s) { return s.maxIz - s.minIz + 1; }

/**
 * 网格格边长粗估（点距量级，纯性能参数——仅影响索引粒度与环查询层数，不影响结果）。
 *
 * 按"最薄轴能否支撑一层间距"阶梯下探维度：先按体积密度估 3D 网格距（cbrt(体积/点数)）；
 * 若最小轴延伸小于该间距，云实质是面状，退化为面密度（sqrt(面积/点数)）；再薄则退化为
 * 线密度（长度/点数）。与渲染侧 estimateMeanPointSpacing 同思路；中间量非正（面/线退化）
 * 时直接走下一阶梯，输出兜底 ≥ 1（与坐标同量级的最小格距不会为 0，防除零）。
 */
double estimateCellSize(std::uint64_t count, double extentX, double extentY, double extentZ) {
  double e[3] = {std::fabs(extentX), std::fabs(extentY), std::fabs(extentZ)};
  std::sort(e, e + 3, std::greater<double>());
  if (count < 2 || e[0] <= 0.0) return 1.0;
  const double s3 = std::cbrt((e[0] * e[1] * e[2]) / static_cast<double>(count));
  if (e[1] > 0.0 && s3 > 0.0 && e[2] >= s3) return std::max(s3, 1.0);
  if (e[1] > 0.0) {
    const double s2 = std::sqrt((e[0] * e[1]) / static_cast<double>(count));
    if (s2 > 0.0 && e[1] >= s2) return std::max(s2, 1.0);
  }
  const double s1 = e[0] / static_cast<double>(count);
  return s1 > 0.0 ? s1 : 1.0;
}

}  // namespace

EntityResult filterEntity(const EntitySource& entity, const SorParams& params,
                          unsigned threadCount) {
  EntityResult result;
  const std::size_t chunkCount = entity.chunks.size();
  result.keptByChunk.resize(chunkCount);

  const std::uint32_t neighborsK = params.neighbors;
  if (neighborsK == 0 || entity.chunks.empty()) {
    // 参数无效（K = 0）：全部保留（keptByChunk = 候选全集，逐块填）
    for (std::size_t c = 0; c < chunkCount; ++c) {
      const ChunkSource& src = entity.chunks[c];
      const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
      auto& kept = result.keptByChunk[c];
      kept.reserve(n);
      for (std::uint32_t i = 0; i < n; ++i) {
        kept.push_back(src.index ? src.index[i] : i);
      }
      result.keptTotal += kept.size();
    }
    return result;
  }
  const double stddevMul = std::max(params.stddevMul, 0.0);  // 负数防御为 0（阈值 = μ）

  // ---- 0) 收集每块候选数（全局候选起点前缀表）与实体候选总数 ----
  std::vector<std::uint64_t> chunkStart(chunkCount + 1, 0);
  std::uint64_t totalCandidates = 0;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    chunkStart[c] = totalCandidates;
    totalCandidates += entity.chunks[c].index ? entity.chunks[c].indexCount
                                              : entity.chunks[c].vertexCount;
  }
  chunkStart[chunkCount] = totalCandidates;
  if (totalCandidates == 0) return result;

  // ---- 1) 扫描候选坐标范围（串行一次，内存顺序读）→ 包围盒与格号跨度 ----
  double minX = 0.0, minY = 0.0, minZ = 0.0;
  double maxX = 0.0, maxY = 0.0, maxZ = 0.0;
  CellSpan span{0, 0, 0, 0, 0, 0};
  bool first = true;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      // 坐标在解析/分割阶段已过滤 NaN/Inf，此处不再防御（损坏数据行为未定义）。
      if (first) {
        minX = maxX = x;
        minY = maxY = y;
        minZ = maxZ = z;
        first = false;
      } else {
        minX = std::min(minX, x);
        maxX = std::max(maxX, x);
        minY = std::min(minY, y);
        maxY = std::max(maxY, y);
        minZ = std::min(minZ, z);
        maxZ = std::max(maxZ, z);
      }
    }
  }
  if (first) return result;  // 无有效候选

  // ---- 2) 格边长 + 格号跨度（floor 到格边长；越界防御见 estimateCellSize） ----
  const double cell = estimateCellSize(totalCandidates, maxX - minX, maxY - minY, maxZ - minZ);
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      const auto ix = static_cast<std::int64_t>(std::floor(x / cell));
      const auto iy = static_cast<std::int64_t>(std::floor(y / cell));
      const auto iz = static_cast<std::int64_t>(std::floor(z / cell));
      if (first) {
        span = CellSpan{ix, ix, iy, iy, iz, iz};
        first = false;
      } else {
        span.minIx = std::min(span.minIx, ix);
        span.maxIx = std::max(span.maxIx, ix);
        span.minIy = std::min(span.minIy, iy);
        span.maxIy = std::max(span.maxIy, iy);
        span.minIz = std::min(span.minIz, iz);
        span.maxIz = std::max(span.maxIz, iz);
      }
    }
  }

  // ---- 3) 构建网格（串行）：格坐标相对 min 偏移后入桶，桶内存候选编码 ----
  GridMap grid;
  grid.reserve(totalCandidates);
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      const CellKey key{
          static_cast<std::int64_t>(std::floor(x / cell)) - span.minIx,
          static_cast<std::int64_t>(std::floor(y / cell)) - span.minIy,
          static_cast<std::int64_t>(std::floor(z / cell)) - span.minIz,
      };
      grid[key].push_back(encodeCandidate(static_cast<std::uint32_t>(c), i));
    }
  }

  // 并行分块（与半径滤波同门槛：点数过少退回单线程，cap 64）
  unsigned T = threadCount;
  if (T == 0) T = std::thread::hardware_concurrency();
  if (T == 0) T = 1;
  if (totalCandidates < 200000) T = 1;
  T = std::min(T, static_cast<unsigned>(chunkCount > 0 ? 64u : 1u));

  // 每点平均最近邻距离（候选全局序号序，double 精度；判定与归约共用）
  std::vector<double> avgDist(totalCandidates, 0.0);

  /**
   * 单点精确 top-K 最近邻平均距离（返回邻居数不足 K 时的实际平均，见头文件）。
   * 自中心格逐环扩张：环 = 与本格"切比雪夫距离"恰为 ring 的格子壳。堆满 K 后
   * 整格剪枝（格最小可能距离 ≥ 堆顶，桶内不可能有更近点）与整层终止（本层无一格
   * 可能更近时，更外层格距单调更远）；未扫格的距离都 ≥ 第 K 小 → 结果精确无近似。
   */
  const auto nearestKMean = [&](std::uint32_t chunk, std::uint32_t local, std::vector<double>& heap) -> double {
    const ChunkSource& src = entity.chunks[chunk];
    const std::uint32_t vertex = src.index ? src.index[local] : local;
    const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
    const double px = p[0];
    const double py = p[1];
    const double pz = p[2];
    const auto cx = static_cast<std::int64_t>(std::floor(px / cell)) - span.minIx;
    const auto cy = static_cast<std::int64_t>(std::floor(py / cell)) - span.minIy;
    const auto cz = static_cast<std::int64_t>(std::floor(pz / cell)) - span.minIz;
    const std::int64_t wIx = spanWidthIx(span);
    const std::int64_t wIy = spanWidthIy(span);
    const std::int64_t wIz = spanWidthIz(span);
    const std::uint64_t selfCode = encodeCandidate(chunk, local);

    heap.clear();
    bool full = false;
    double topSq = 0.0;  // full 时 = 堆顶（第 K 小距离平方）

    for (std::int64_t ring = 0;; ++ring) {
      // 本层（ring 壳）在界格逐格处理：先做格级剪枝（整格最小可能距离 ≥ 堆顶），
      // 再逐候选点距离筛堆
      bool hasInBounds = false;       // 本层存在在界格（即尚有未扫点）
      bool mayContainCloser = false;  // 本层存在可能进堆的在界格（未剪）
      for (std::int64_t dx = -ring; dx <= ring; ++dx) {
        for (std::int64_t dy = -ring; dy <= ring; ++dy) {
          for (std::int64_t dz = -ring; dz <= ring; ++dz) {
            const std::int64_t adx = dx < 0 ? -dx : dx;
            const std::int64_t ady = dy < 0 ? -dy : dy;
            const std::int64_t adz = dz < 0 ? -dz : dz;
            const std::int64_t cheb = std::max(std::max(adx, ady), adz);
            if (cheb != ring) continue;  // 只处理本环壳层
            const std::int64_t gx = cx + dx;
            const std::int64_t gy = cy + dy;
            const std::int64_t gz = cz + dz;
            if (gx < 0 || gx >= wIx || gy < 0 || gy >= wIy || gz < 0 || gz >= wIz) continue;
            hasInBounds = true;
            // 格世界区间 [low, low+cell)；点距格立方体最近距离平方（保守下界）
            const double gx0 = (span.minIx + gx) * cell;
            const double gy0 = (span.minIy + gy) * cell;
            const double gz0 = (span.minIz + gz) * cell;
            const double xd = px < gx0 ? gx0 - px : (px >= gx0 + cell ? px - (gx0 + cell) : 0.0);
            const double yd = py < gy0 ? gy0 - py : (py >= gy0 + cell ? py - (gy0 + cell) : 0.0);
            const double zd = pz < gz0 ? gz0 - pz : (pz >= gz0 + cell ? pz - (gz0 + cell) : 0.0);
            const double cellMinSq = xd * xd + yd * yd + zd * zd;
            if (full && cellMinSq >= topSq) continue;  // 整格剪枝：桶内不可能更近
            mayContainCloser = true;
            const auto it = grid.find(CellKey{gx, gy, gz});
            if (it == grid.end()) continue;
            for (const std::uint64_t code : it->second) {
              if (code == selfCode) continue;  // 自身不算邻居
              const std::uint32_t qChunk = static_cast<std::uint32_t>(code >> CHUNK_SHIFT);
              const std::uint32_t qLocal = static_cast<std::uint32_t>(code & 0xffffffffu);
              const ChunkSource& qsrc = entity.chunks[qChunk];
              const std::uint32_t qVertex = qsrc.index ? qsrc.index[qLocal] : qLocal;
              const float* qp = qsrc.positions + static_cast<std::size_t>(qVertex) * 3;
              const double ddx = px - qp[0];
              const double ddy = py - qp[1];
              const double ddz = pz - qp[2];
              const double distSq = ddx * ddx + ddy * ddy + ddz * ddz;
              if (full) {
                if (distSq >= topSq) continue;  // 比当前第 K 小不更近，不进堆
                // 弹出旧堆顶（第 K 小），back 暂存后覆写为新距离再插回
                std::pop_heap(heap.begin(), heap.end());
                heap.back() = distSq;
                std::push_heap(heap.begin(), heap.end());
                topSq = heap.front();
              } else {
                heap.push_back(distSq);
                std::push_heap(heap.begin(), heap.end());
                if (static_cast<std::uint32_t>(heap.size()) == neighborsK) {
                  full = true;
                  topSq = heap.front();
                }
              }
            }
          }
        }
      }
      if (!hasInBounds) break;                 // 无更多未扫格（云边界之外）
      if (full && !mayContainCloser) break;    // 本层无一格可能更近：更外层格距单调更远
    }

    // 平均 = 堆内距离和 / 实际邻居数（邻居不足 K 时按实际，与 PCL 行为一致）
    double sum = 0.0;
    for (const double d : heap) sum += d;
    const std::size_t cnt = heap.size();
    return cnt == 0 ? 0.0 : sum / static_cast<double>(cnt);
  };

  // ---- 4) 并行 pass1：每点平均距离 + μ 分子归约 ----
  std::vector<double> threadSum(T, 0.0);
  std::vector<double> threadSumSq(T, 0.0);
  // 堆缓冲每线程复用（reserve 一次避免每点分配）
  std::vector<std::vector<double>> threadHeap(T);

  const auto processRange = [&](std::uint64_t begin, std::uint64_t end, unsigned tid) {
    auto& heap = threadHeap[tid];
    heap.reserve(neighborsK);
    double localSum = 0.0;
    std::size_t chunk = 0;
    while (chunk + 1 < chunkCount && chunkStart[chunk + 1] <= begin) ++chunk;
    std::uint64_t local = begin - chunkStart[chunk];
    for (std::uint64_t g = begin; g < end; ++g) {
      for (;;) {
        const std::uint64_t chunkN = entity.chunks[chunk].index
                                         ? entity.chunks[chunk].indexCount
                                         : entity.chunks[chunk].vertexCount;
        if (local < chunkN) break;
        ++chunk;
        local = 0;
      }
      const double avg = nearestKMean(static_cast<std::uint32_t>(chunk),
                                      static_cast<std::uint32_t>(local), heap);
      avgDist[g] = avg;
      localSum += avg;
      ++local;
    }
    threadSum[tid] = localSum;
  };

  if (T == 1) {
    processRange(0, totalCandidates, 0);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(T);
    const std::uint64_t step = (totalCandidates + T - 1) / T;
    for (unsigned t = 0; t < T; ++t) {
      const std::uint64_t begin = t * step;
      const std::uint64_t end = std::min(begin + step, totalCandidates);
      if (begin >= end) break;
      pool.emplace_back([&, begin, end, t] { processRange(begin, end, t); });
    }
    for (auto& th : pool) th.join();
  }
  for (unsigned t = 1; t < T; ++t) threadSum[0] += threadSum[t];
  const double mu = threadSum[0] / static_cast<double>(totalCandidates);

  // ---- 5) 并行 pass2：σ² 分子归约（对 μ 差值平方，避免方差公式相减的抵消） ----
  const auto reduceSqRange = [&](std::uint64_t begin, std::uint64_t end, unsigned tid) {
    double s = 0.0;
    for (std::uint64_t g = begin; g < end; ++g) {
      const double d = avgDist[g] - mu;
      s += d * d;
    }
    threadSumSq[tid] = s;
  };
  if (T == 1) {
    reduceSqRange(0, totalCandidates, 0);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(T);
    const std::uint64_t step = (totalCandidates + T - 1) / T;
    for (unsigned t = 0; t < T; ++t) {
      const std::uint64_t begin = t * step;
      const std::uint64_t end = std::min(begin + step, totalCandidates);
      if (begin >= end) break;
      pool.emplace_back([&, begin, end, t] { reduceSqRange(begin, end, t); });
    }
    for (auto& th : pool) th.join();
  }
  for (unsigned t = 1; t < T; ++t) threadSumSq[0] += threadSumSq[t];
  const double sigma = std::sqrt(threadSumSq[0] / static_cast<double>(totalCandidates));
  const double threshold = mu + stddevMul * sigma;

  // ---- 6) 并行 pass3：avg > μ + λσ 判剔除，其余判保留（严格大于，与 PCL 一致） ----
  // threadKept[t][c] = 线程 t 在块 c 内判定保留的顶点下标（各自保序）
  std::vector<std::vector<std::vector<std::uint32_t>>> threadKept(
      T, std::vector<std::vector<std::uint32_t>>(chunkCount));

  const auto judgeRange = [&](std::uint64_t begin, std::uint64_t end, unsigned tid) {
    auto& localKept = threadKept[tid];
    std::size_t chunk = 0;
    while (chunk + 1 < chunkCount && chunkStart[chunk + 1] <= begin) ++chunk;
    std::uint64_t local = begin - chunkStart[chunk];
    for (std::uint64_t g = begin; g < end; ++g) {
      for (;;) {
        const std::uint64_t chunkN = entity.chunks[chunk].index
                                         ? entity.chunks[chunk].indexCount
                                         : entity.chunks[chunk].vertexCount;
        if (local < chunkN) break;
        ++chunk;
        local = 0;
      }
      if (!(avgDist[g] > threshold)) {  // 判保留（边界相等保留，同 PCL 严格大于剔除）
        const ChunkSource& src = entity.chunks[chunk];
        const std::uint32_t vertex =
            src.index ? src.index[static_cast<std::uint32_t>(local)] : static_cast<std::uint32_t>(local);
        localKept[chunk].push_back(vertex);
      }
      ++local;
    }
  };

  if (T == 1) {
    judgeRange(0, totalCandidates, 0);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(T);
    const std::uint64_t step = (totalCandidates + T - 1) / T;
    for (unsigned t = 0; t < T; ++t) {
      const std::uint64_t begin = t * step;
      const std::uint64_t end = std::min(begin + step, totalCandidates);
      if (begin >= end) break;
      pool.emplace_back([&, begin, end, t] { judgeRange(begin, end, t); });
    }
    for (auto& th : pool) th.join();
  }

  // ---- 7) 保序拼接：块 c 的 kept = 各线程（按全局段顺序）依次追加 ----
  std::size_t totalKept = 0;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    auto& kept = result.keptByChunk[c];
    for (unsigned t = 0; t < T; ++t) {
      const auto& part = threadKept[t][c];
      kept.insert(kept.end(), part.begin(), part.end());
    }
    totalKept += kept.size();
  }
  result.keptTotal = totalKept;
  return result;
}

}  // namespace sor_filter
