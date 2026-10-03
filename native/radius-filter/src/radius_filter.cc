#include "radius_filter.h"

#include <cmath>
#include <thread>
#include <unordered_map>
#include <utility>

namespace radius_filter {

namespace {

/** 网格格坐标（三轴均为已 floor 到格边长的整数格号）。 */
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

/** 扫描实体全部候选点坐标求范围（格坐标跨度），返回格跨度数组（每轴 [min, max]）。 */
struct CellSpan {
  std::int64_t minIx;
  std::int64_t maxIx;
  std::int64_t minIy;
  std::int64_t maxIy;
  std::int64_t minIz;
  std::int64_t maxIz;
};

}  // namespace

EntityResult filterEntity(const EntitySource& entity, const FilterParams& params,
                          unsigned threadCount) {
  EntityResult result;
  const std::size_t chunkCount = entity.chunks.size();
  result.keptByChunk.resize(chunkCount);

  if (params.radius <= 0.0 || entity.chunks.empty()) {
    return result;  // 参数无效：全部剔除（keptByChunk 全空）
  }
  const double radius = params.radius;
  const double radiusSq = radius * radius;
  const std::uint32_t minNeighbors = params.minNeighbors;
  if (minNeighbors == 0) {
    // 阈值 0 = 全部保留：kept = 候选全集（保序，逐块填）
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

  // ---- 1) 扫描候选坐标范围 → 格号跨度（串行一次，内存顺序读） ----
  CellSpan span{0, 0, 0, 0, 0, 0};
  bool first = true;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      // 坐标在解析/分割阶段已过滤 NaN/Inf，此处不再防御（损坏数据行为未定义）。
      const auto ix = static_cast<std::int64_t>(std::floor(x / radius));
      const auto iy = static_cast<std::int64_t>(std::floor(y / radius));
      const auto iz = static_cast<std::int64_t>(std::floor(z / radius));
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
  if (first) return result;  // 无有效候选

  // ---- 2) 构建网格（串行）：格坐标相对 min 偏移后入桶，桶内存候选编码 ----
  GridMap grid;
  grid.reserve(totalCandidates);
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      const CellKey key{
          static_cast<std::int64_t>(std::floor(x / radius)) - span.minIx,
          static_cast<std::int64_t>(std::floor(y / radius)) - span.minIy,
          static_cast<std::int64_t>(std::floor(z / radius)) - span.minIz,
      };
      grid[key].push_back(encodeCandidate(static_cast<std::uint32_t>(c), i));
    }
  }

  // ---- 3) 并行查询：候选点全局序号 [0, total) 连续分段，每线程处理一段 ----
  unsigned T = threadCount;
  if (T == 0) T = std::thread::hardware_concurrency();
  if (T == 0) T = 1;
  // 点数过少时线程调度开销不划算，退回单线程
  if (totalCandidates < 200000) T = 1;
  T = std::min(T, static_cast<unsigned>(chunkCount > 0 ? 64u : 1u));

  // threadKept[t][c] = 线程 t 在块 c 内判定保留的顶点下标（各自保序）
  std::vector<std::vector<std::vector<std::uint32_t>>> threadKept(
      T, std::vector<std::vector<std::uint32_t>>(chunkCount));

  const auto processRange = [&](std::uint64_t begin, std::uint64_t end, unsigned threadId) {
    auto& localKept = threadKept[threadId];
    // 定位起点所在块（候选序号按块连续；此后逐点步进，越过块尾时切换）
    std::size_t chunk = 0;
    while (chunk + 1 < chunkCount && chunkStart[chunk + 1] <= begin) ++chunk;
    std::uint64_t local = begin - chunkStart[chunk];
    for (std::uint64_t g = begin; g < end; ++g) {
      // 越过当前块候选尾时前进到下一块（候选段必不越实体尾，无需再判 g）
      for (;;) {
        const std::uint64_t chunkN = entity.chunks[chunk].index
                                         ? entity.chunks[chunk].indexCount
                                         : entity.chunks[chunk].vertexCount;
        if (local < chunkN) break;
        ++chunk;
        local = 0;
      }
      const ChunkSource& src = entity.chunks[chunk];
      const std::uint32_t local32 = static_cast<std::uint32_t>(local);

      // 该点坐标
      const std::uint32_t vertex = src.index ? src.index[local32] : local32;
      const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
      const double px = p[0];
      const double py = p[1];
      const double pz = p[2];
      const auto ix = static_cast<std::int64_t>(std::floor(px / radius)) - span.minIx;
      const auto iy = static_cast<std::int64_t>(std::floor(py / radius)) - span.minIy;
      const auto iz = static_cast<std::int64_t>(std::floor(pz / radius)) - span.minIz;

      // 邻居计数（不含自身），≥ minNeighbors 提前判保留
      std::uint32_t count = 0;
      bool keep = false;
      const std::uint64_t selfCode = encodeCandidate(static_cast<std::uint32_t>(chunk), local32);
      for (std::int64_t dz = -1; dz <= 1 && !keep; ++dz) {
        for (std::int64_t dy = -1; dy <= 1 && !keep; ++dy) {
          for (std::int64_t dx = -1; dx <= 1 && !keep; ++dx) {
            const auto it = grid.find(CellKey{ix + dx, iy + dy, iz + dz});
            if (it == grid.end()) continue;
            const Bucket& bucket = it->second;
            for (const std::uint64_t code : bucket) {
              if (code == selfCode) continue;  // 自身不算邻居
              const std::uint32_t qChunk = static_cast<std::uint32_t>(code >> CHUNK_SHIFT);
              const std::uint32_t qLocal = static_cast<std::uint32_t>(code & 0xffffffffu);
              const ChunkSource& qsrc = entity.chunks[qChunk];
              const std::uint32_t qVertex = qsrc.index ? qsrc.index[qLocal] : qLocal;
              const float* qp = qsrc.positions + static_cast<std::size_t>(qVertex) * 3;
              const double ddx = px - qp[0];
              const double ddy = py - qp[1];
              const double ddz = pz - qp[2];
              if (ddx * ddx + ddy * ddy + ddz * ddz <= radiusSq) {
                if (++count >= minNeighbors) {
                  keep = true;
                  break;
                }
              }
            }
          }
        }
      }
      if (keep) {
        localKept[chunk].push_back(vertex);
      }
      ++local;
    }
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

  // ---- 4) 保序拼接：块 c 的 kept = 各线程（按全局段顺序）依次追加 ----
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

}  // namespace radius_filter
