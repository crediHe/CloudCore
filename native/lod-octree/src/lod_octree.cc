/**
 * LOD 八叉树构建实现（设计说明、与 CloudCompare 的差异、数据布局见 lod_octree.h）。
 *
 * 建树流程（层序推进，便于回报进度与检查取消）：
 *   0) 枚举候选：逐块解引用 index、剔除越界条目与非有限坐标，打包成 (chunk, vertex) id，
 *      同时求实体包围盒（一次 O(点数) 顺序扫）。
 *   1) 根节点 = 包围盒外接**立方体**（各轴取最大跨度），后续每一级立方体折半。
 *   2) 对每一层：逐个节点按卦限**稳定划分**自己的点区间（计数 → 前缀和 → 分散），
 *      子节点按卦限升序追加到节点表末尾（于是子区间连续、节点表层序排列）。
 *      只有一个卦限非空时数据不动，只把立方体缩到该卦限继续下钻。
 *   3) 收起：节点数触顶 / 点数 ≤ 阈值 / 到 maxLevel 的节点保持为叶子。
 *
 * 时间复杂度 O(点数 × 树的实际深度)（每层对全部点做一次计数 + 一次分散），
 * 与 CC 的 ccPointCloudLODThread 同阶；空间 O(点数)（ids + 划分用的 scratch）。
 */
#include "lod_octree.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace lod_octree {
namespace {

/** 默认值（与 BuildParams 的默认值一致，集中在此便于文档引用）。 */
constexpr std::uint32_t kDefaultMaxPointsPerCell = 256;
constexpr std::uint32_t kDefaultMaxLevel = 12;
/** 深度上限的硬保险（更深的树对渲染没有意义，且共点云会沿单链一路下钻）。 */
constexpr std::uint32_t kMaxLevelLimit = 24;
/** 取消检查粒度（点）。 */
constexpr std::uint32_t kCancelCheckStride = 1u << 20;
/** 节点预算 = 点数/阈值 × 该系数 + 常数：共点退化时防止节点表爆炸，触顶后剩下的节点保持为叶子。 */
constexpr std::uint64_t kNodeBudgetSlack = 4;
constexpr std::uint64_t kNodeBudgetFloor = 1024;

/**
 * 打包 id 的位宽约定：`id = (chunk << shift) | vertex`。
 * shift 取"能装下最大块号"的最小位数（单块也留 1 位，避免出现 shift == 32 的未定义行为）。
 */
struct PackedCodec {
  unsigned shift = 31;
  std::uint32_t mask = 0x7fffffffu;

  static PackedCodec ForChunks(std::size_t chunkCount, std::uint32_t maxVertexCount) {
    std::uint32_t maxChunk = chunkCount > 0 ? static_cast<std::uint32_t>(chunkCount - 1) : 0;
    unsigned bits = 0;
    while (maxChunk != 0) {
      ++bits;
      maxChunk >>= 1;
    }
    if (bits == 0) bits = 1;

    PackedCodec codec;
    codec.shift = 32 - bits;
    codec.mask = (1u << codec.shift) - 1u;
    // mask + 1 = 单块能寻址的顶点数上限；超了就装不下，宁可报错也不静默截断
    if (static_cast<std::uint64_t>(maxVertexCount) > static_cast<std::uint64_t>(codec.mask) + 1u) {
      throw std::range_error("lod_octree: 打包 id 位宽不足（分块数 " + std::to_string(chunkCount) +
                             " × 单块顶点数 " + std::to_string(maxVertexCount) + " 超过 2^32）");
    }
    return codec;
  }

  std::uint32_t pack(std::uint32_t chunk, std::uint32_t vertex) const {
    return (chunk << shift) | vertex;
  }
};

/** 单块视图（候选数已按 index 是否为空归一）。 */
struct ChunkView {
  const float* positions = nullptr;
  std::uint32_t vertexCount = 0;
  const std::uint32_t* index = nullptr;
  std::uint32_t candidateCount = 0;
};

/** 在建节点表（结构体数组 → 末尾整体转成 SoA，见下方 ToResult）。 */
struct NodeTable {
  std::vector<std::uint32_t> childBase;
  std::vector<std::uint8_t> childMask;
  std::vector<std::uint32_t> pointStart;
  std::vector<std::uint32_t> pointCount;
  std::vector<float> center;  // 3×
  std::vector<float> size;
  std::vector<std::uint8_t> level;

  std::uint32_t count() const { return static_cast<std::uint32_t>(pointStart.size()); }

  std::uint32_t add(std::uint8_t nodeLevel, double cx, double cy, double cz, double cellSize,
                    std::uint32_t start, std::uint32_t cnt) {
    const std::uint32_t index = count();
    childBase.push_back(0);
    childMask.push_back(0);
    pointStart.push_back(start);
    pointCount.push_back(cnt);
    center.push_back(static_cast<float>(cx));
    center.push_back(static_cast<float>(cy));
    center.push_back(static_cast<float>(cz));
    size.push_back(static_cast<float>(cellSize));
    level.push_back(nodeLevel);
    return index;
  }
};

/** 打包 id → 坐标指针（chunk 字段即 views 下标，构造期已保证不越界）。 */
inline const float* PointOf(const std::vector<ChunkView>& views, const PackedCodec& codec,
                            std::uint32_t id) {
  const ChunkView& view = views[id >> codec.shift];
  return view.positions + static_cast<std::size_t>(id & codec.mask) * 3;
}

/**
 * 卦限位：bit0 = x ≥ 中心，bit1 = y，bit2 = z。
 * 与 CCCoreLib::DgmOctree 的 cell code 低 3 位同序（CC 用 `code & 7` 当 childIndexes 下标）。
 * 恰好在中心面上（含各轴最大值）的点归 + 侧，于是"点始终留在自己的节点立方体内"。
 */
inline unsigned OctantOf(const float* p, double cx, double cy, double cz) {
  return (p[0] >= cx ? 1u : 0u) | (p[1] >= cy ? 2u : 0u) | (p[2] >= cz ? 4u : 0u);
}

/** 卦限对应的子立方体中心偏移（子边长 = 父边长/2，故中心偏移 = 父边长/4）。 */
inline double ChildOffset(std::size_t axis, unsigned octant, double cellSize) {
  return (octant >> axis) & 1u ? cellSize / 4 : -cellSize / 4;
}

}  // namespace

EntityResult buildEntity(const EntitySource& entity, std::int32_t entityId, const BuildParams& params,
                         const CancelFlag& cancelled, const ProgressFn& onProgress) {
  EntityResult result;
  result.entityId = entityId;

  const std::uint32_t maxLevel =
      std::min(params.maxLevel > 0 ? params.maxLevel : kDefaultMaxLevel, kMaxLevelLimit);
  const std::uint32_t maxPointsPerCell =
      params.maxPointsPerCell > 0 ? params.maxPointsPerCell : kDefaultMaxPointsPerCell;

  // 被取消时统一从这里抛出（AsyncWorker 的 OnError 转成 JS 错误回调）
  const auto checkCancel = [&cancelled]() {
    if (cancelled.load(std::memory_order_relaxed)) {
      throw std::runtime_error("已取消：LOD 建树被中止");
    }
  };

  // ---- 0) 逐块视图 + 打包位宽 ----
  std::vector<ChunkView> views;
  views.reserve(entity.chunks.size());
  std::uint32_t maxVertexCount = 0;
  std::size_t candidateTotal = 0;
  for (const ChunkSource& cs : entity.chunks) {
    ChunkView view;
    view.positions = cs.positions;
    view.vertexCount = cs.vertexCount;
    view.index = cs.index;
    view.candidateCount = cs.index != nullptr ? cs.indexCount : cs.vertexCount;
    views.push_back(view);
    maxVertexCount = std::max(maxVertexCount, cs.vertexCount);
    candidateTotal += view.candidateCount;
  }
  if (views.empty() || candidateTotal == 0) {
    return result;  // 空实体：nodeCount = 0，渲染侧据此跳过 LOD
  }
  const PackedCodec codec = PackedCodec::ForChunks(views.size(), maxVertexCount);

  // ---- 枚举候选：打包 id + 实体包围盒 ----
  std::vector<std::uint32_t> ids;
  ids.reserve(candidateTotal);
  double minBound[3] = {std::numeric_limits<double>::infinity(),
                        std::numeric_limits<double>::infinity(),
                        std::numeric_limits<double>::infinity()};
  double maxBound[3] = {-std::numeric_limits<double>::infinity(),
                        -std::numeric_limits<double>::infinity(),
                        -std::numeric_limits<double>::infinity()};
  const std::uint32_t chunkCount = static_cast<std::uint32_t>(views.size());
  for (std::uint32_t chunk = 0; chunk < chunkCount; ++chunk) {
    const ChunkView& view = views[chunk];
    for (std::uint32_t k = 0; k < view.candidateCount; ++k) {
      const std::uint32_t vertex = view.index != nullptr ? view.index[k] : k;
      // 越界 index 条目：丢弃而不是越界读（宁可少画一个点，不可读脏内存）
      if (view.index != nullptr && vertex >= view.vertexCount) continue;
      const float* p = view.positions + static_cast<std::size_t>(vertex) * 3;
      if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || !std::isfinite(p[2])) continue;
      for (std::size_t axis = 0; axis < 3; ++axis) {
        const double v = p[axis];
        if (v < minBound[axis]) minBound[axis] = v;
        if (v > maxBound[axis]) maxBound[axis] = v;
      }
      ids.push_back(codec.pack(chunk, vertex));
      if (ids.size() % kCancelCheckStride == 0) checkCancel();
    }
  }

  const std::uint32_t pointTotal = static_cast<std::uint32_t>(ids.size());
  result.pointCount = pointTotal;
  if (pointTotal == 0) {
    return result;  // 候选全被剔除（非有限坐标等）：同样按空实体处理
  }
  for (std::size_t axis = 0; axis < 3; ++axis) {
    result.bounds[axis] = static_cast<float>(minBound[axis]);
    result.bounds[3 + axis] = static_cast<float>(maxBound[axis]);
  }

  // ---- 1) 根立方体：各轴取最大跨度，外扩一丁点避免极值点正好落在边界上 ----
  double center[3];
  double cubeSize = 0;
  for (std::size_t axis = 0; axis < 3; ++axis) {
    center[axis] = (minBound[axis] + maxBound[axis]) / 2;
    cubeSize = std::max(cubeSize, maxBound[axis] - minBound[axis]);
  }
  if (!(cubeSize > 0)) cubeSize = 1;  // 单点 / 共点：给个非零边长
  cubeSize *= 1.0 + 1e-6;

  NodeTable table;
  table.add(0, center[0], center[1], center[2], cubeSize, 0, pointTotal);

  // 节点数护栏：正常点云远用不到，共点退化时靠它把树截断成"更大的叶子"
  const std::uint64_t nodeBudget =
      static_cast<std::uint64_t>(pointTotal) / maxPointsPerCell * kNodeBudgetSlack + kNodeBudgetFloor;

  std::vector<std::uint32_t> scratch;
  std::uint32_t levelBegin = 0;
  std::uint32_t levelEnd = 1;
  std::uint32_t lastLevel = 0;

  // ---- 2) 逐层划分（同层节点在 [levelBegin, levelEnd) 连续，子节点追加在其后）----
  for (std::uint32_t level = 0; level < maxLevel && levelBegin < levelEnd; ++level) {
    lastLevel = level;
    checkCancel();
    const std::uint32_t nextBegin = levelEnd;  // 子节点从上一层末尾开始追加 → 天然连续
    for (std::uint32_t node = levelBegin; node < levelEnd; ++node) {
      const std::uint32_t count = table.pointCount[node];
      if (count <= maxPointsPerCell) continue;              // 已是叶子
      if (table.count() + 8 > nodeBudget) continue;         // 触顶：保持叶子

      const std::uint32_t start = table.pointStart[node];
      const std::uint32_t end = start + count;
      const double cx = table.center[node * 3];
      const double cy = table.center[node * 3 + 1];
      const double cz = table.center[node * 3 + 2];
      const double cellSize = table.size[node];
      const std::uint8_t childLevel = static_cast<std::uint8_t>(level + 1);
      const double childSize = cellSize / 2;

      // 计数：先扫一遍定 8 个卦限的规模（也用于判"是否需要真的搬数据"）
      std::uint32_t bucket[8] = {0, 0, 0, 0, 0, 0, 0, 0};
      for (std::uint32_t i = start; i < end; ++i) {
        ++bucket[OctantOf(PointOf(views, codec, ids[i]), cx, cy, cz)];
      }
      unsigned nonEmpty = 0;
      unsigned onlyBucket = 0;
      for (unsigned k = 0; k < 8; ++k) {
        if (bucket[k] != 0) {
          ++nonEmpty;
          onlyBucket = k;
        }
      }

      if (nonEmpty == 1) {
        // 全部落进同一个卦限：数据不需要移动，只把立方体缩到该卦限继续下钻。
        // 共点云会沿这条单链走到 maxLevel 或节点预算触顶，届时自然成为（较大的）叶子。
        const std::uint32_t child =
            table.add(childLevel, cx + ChildOffset(0, onlyBucket, cellSize),
                      cy + ChildOffset(1, onlyBucket, cellSize),
                      cz + ChildOffset(2, onlyBucket, cellSize), childSize, start, count);
        table.childBase[node] = child;
        table.childMask[node] = static_cast<std::uint8_t>(1u << onlyBucket);
        continue;
      }

      // 稳定划分：用 scratch 中转后整体写回。**稳定性是"块主序不变量"的来源**——
      // 同块的点（初始序相邻）被划分后仍在彼此的相对次序上，于是任一节点的区间
      // 都保持"同块的点连续成段"，渲染侧 gather 才能按段切缓冲。
      if (scratch.size() < count) scratch.resize(count);
      std::memcpy(scratch.data(), ids.data() + start, static_cast<std::size_t>(count) * sizeof(std::uint32_t));
      std::uint32_t cursor[8];
      std::uint32_t acc = 0;
      for (unsigned k = 0; k < 8; ++k) {
        cursor[k] = start + acc;
        acc += bucket[k];
      }
      for (std::uint32_t i = 0; i < count; ++i) {
        const std::uint32_t id = scratch[i];
        ids[cursor[OctantOf(PointOf(views, codec, id), cx, cy, cz)]++] = id;
      }

      // 子节点按卦限升序追加；区间依次首尾相接 = 恰好划分父区间
      const std::uint32_t childBase = table.count();
      std::uint32_t childStart = start;
      std::uint8_t childMask = 0;
      for (unsigned k = 0; k < 8; ++k) {
        if (bucket[k] == 0) continue;
        table.add(childLevel, cx + ChildOffset(0, k, cellSize), cy + ChildOffset(1, k, cellSize),
                  cz + ChildOffset(2, k, cellSize), childSize, childStart, bucket[k]);
        childStart += bucket[k];
        childMask = static_cast<std::uint8_t>(childMask | (1u << k));
      }
      table.childBase[node] = childBase;
      table.childMask[node] = childMask;
    }
    levelBegin = nextBegin;
    levelEnd = table.count();
    if (onProgress) {
      onProgress(static_cast<double>(level + 1) / static_cast<double>(maxLevel + 1), level);
    }
  }

  // ---- 3) 收起：节点表规模有限，shrink 的拷贝代价可忽略；pointIds 在未丢点时为 no-op ----
  table.childBase.shrink_to_fit();
  table.childMask.shrink_to_fit();
  table.pointStart.shrink_to_fit();
  table.pointCount.shrink_to_fit();
  table.center.shrink_to_fit();
  table.size.shrink_to_fit();
  table.level.shrink_to_fit();
  ids.shrink_to_fit();

  result.nodeCount = table.count();
  result.chunkBits = static_cast<std::uint8_t>(32 - codec.shift);
  result.vertexShift = static_cast<std::uint8_t>(codec.shift);
  result.nodeChildBase = std::move(table.childBase);
  result.nodeChildMask = std::move(table.childMask);
  result.nodePointStart = std::move(table.pointStart);
  result.nodePointCount = std::move(table.pointCount);
  result.nodeCenter = std::move(table.center);
  result.nodeSize = std::move(table.size);
  result.nodeLevel = std::move(table.level);
  result.pointIds = std::move(ids);

  if (onProgress) onProgress(1.0, lastLevel);
  return result;
}

}  // namespace lod_octree
