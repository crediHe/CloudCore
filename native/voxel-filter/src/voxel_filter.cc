#include "voxel_filter.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace voxel_filter {

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

  if (params.leafSize <= 0.0 || entity.chunks.empty()) {
    // 边界：退化体素边长（leaf→0 是"每格 1 点"的连续极限）→ 全部保留（逐块候选全集）
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
  const double leaf = params.leafSize;

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
      const auto ix = static_cast<std::int64_t>(std::floor(x / leaf));
      const auto iy = static_cast<std::int64_t>(std::floor(y / leaf));
      const auto iz = static_cast<std::int64_t>(std::floor(z / leaf));
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

  // ---- 2) 构建网格（串行）：格坐标相对 min 偏移后入桶 ----
  // 遍历序 = 「块序升序 → 块内候选升序」→ 每桶成员序 = 全局候选升序。
  // 这是求和（pass3 重心）的位级确定性契约，JS 暴力参考按同序累加，两处同步。
  GridMap grid;
  grid.reserve(totalCandidates);
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = src.index ? src.indexCount : src.vertexCount;
    for (std::uint32_t i = 0; i < n; ++i) {
      double x, y, z;
      candidateXyz(src, i, &x, &y, &z);
      const CellKey key{
          static_cast<std::int64_t>(std::floor(x / leaf)) - span.minIx,
          static_cast<std::int64_t>(std::floor(y / leaf)) - span.minIy,
          static_cast<std::int64_t>(std::floor(z / leaf)) - span.minIz,
      };
      grid[key].push_back(encodeCandidate(static_cast<std::uint32_t>(c), i));
    }
  }

  // ---- 3) 收集占用格列表（map 遍历序任意，但只读桶、代表点逐格唯一，不影响结果） ----
  // 桶为 unordered_map 节点，构建结束后不再插入，引用稳定可安全持有。
  std::vector<const Bucket*> cells;
  cells.reserve(grid.size());
  for (const auto& kv : grid) {
    cells.push_back(&kv.second);
  }
  if (cells.empty()) return result;

  // ---- 4) 并行选代表点：cell 段切分，每线程处理一段 ----
  unsigned T = threadCount;
  if (T == 0) T = std::thread::hardware_concurrency();
  if (T == 0) T = 1;
  // 点数过少时线程调度开销不划算，退回单线程
  if (totalCandidates < 200000) T = 1;
  T = std::min(T, 64u);

  // keptFlags[全局候选序号]：代表点在各自格内唯一（每候选只属于一格），
  // 不同线程写不同字节，无数据竞争；pass5 按块升序压缩即得递增 kept。
  std::vector<std::uint8_t> keptFlags(totalCandidates, 0);

  const auto processCells = [&](std::size_t begin, std::size_t end) {
    for (std::size_t bi = begin; bi < end; ++bi) {
      const Bucket& bucket = *cells[bi];
      // 按桶内存储序（= 全局候选升序）累加重心和 → 与 JS 参考同序，位级一致
      double sumX = 0.0, sumY = 0.0, sumZ = 0.0;
      for (const std::uint64_t code : bucket) {
        const std::uint32_t c = static_cast<std::uint32_t>(code >> CHUNK_SHIFT);
        const std::uint32_t local = static_cast<std::uint32_t>(code & 0xffffffffu);
        const ChunkSource& src = entity.chunks[c];
        const std::uint32_t vertex = src.index ? src.index[local] : local;
        const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
        sumX += p[0];
        sumY += p[1];
        sumZ += p[2];
      }
      const double inv = 1.0 / static_cast<double>(bucket.size());
      const double cx = sumX * inv;
      const double cy = sumY * inv;
      const double cz = sumZ * inv;

      // 同序二次扫描：取距重心平方距离最小者；严格 < → 距离并列取先出现者（候选更小）
      double bestDistSq = 0.0;
      std::uint64_t bestCode = 0;
      bool hasBest = false;
      for (const std::uint64_t code : bucket) {
        const std::uint32_t c = static_cast<std::uint32_t>(code >> CHUNK_SHIFT);
        const std::uint32_t local = static_cast<std::uint32_t>(code & 0xffffffffu);
        const ChunkSource& src = entity.chunks[c];
        const std::uint32_t vertex = src.index ? src.index[local] : local;
        const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
        const double dx = cx - p[0];
        const double dy = cy - p[1];
        const double dz = cz - p[2];
        const double distSq = dx * dx + dy * dy + dz * dz;
        if (!hasBest || distSq < bestDistSq) {
          bestDistSq = distSq;
          bestCode = code;
          hasBest = true;
        }
      }
      const std::uint32_t bestChunk = static_cast<std::uint32_t>(bestCode >> CHUNK_SHIFT);
      const std::uint32_t bestLocal = static_cast<std::uint32_t>(bestCode & 0xffffffffu);
      keptFlags[chunkStart[bestChunk] + bestLocal] = 1;
    }
  };

  if (T == 1) {
    processCells(0, cells.size());
  } else {
    std::vector<std::thread> pool;
    pool.reserve(T);
    const std::size_t step = (cells.size() + T - 1) / T;
    for (unsigned t = 0; t < T; ++t) {
      const std::size_t begin = t * step;
      const std::size_t end = std::min(begin + step, cells.size());
      if (begin >= end) break;
      pool.emplace_back([&, begin, end] { processCells(begin, end); });
    }
    for (auto& th : pool) th.join();
  }

  // ---- 5) 保序压缩：块 c 的 kept = 按候选升序扫 keptFlags（天然递增，无需排序） ----
  std::uint64_t totalKept = 0;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint64_t start = chunkStart[c];
    const std::uint64_t n = src.index ? src.indexCount : src.vertexCount;
    auto& kept = result.keptByChunk[c];
    for (std::uint64_t i = 0; i < n; ++i) {
      if (keptFlags[start + i]) {
        kept.push_back(src.index ? src.index[i] : static_cast<std::uint32_t>(i));
      }
    }
    totalKept += kept.size();
  }
  result.keptTotal = totalKept;
  return result;
}

}  // namespace voxel_filter
