/**
 * 欧式聚类分割实现：静态 KD 树 + 并行并查集。
 *
 * 流程：平铺候选 → 建 KD 树 → 并行半径查询（与候选号更大的邻居 union）→ 按候选序首遇编号。
 * 语义说明与设计判据见 euclidean_cluster.h 顶部注释。
 */
#include "euclidean_cluster.h"

#include <algorithm>
#include <atomic>
#include <memory>
#include <thread>
#include <utility>

namespace euclidean_cluster {

namespace {

/** KD 树叶容量：叶内线性扫描，16 是"树深 / 节点数 / 叶扫描量"的常规折中。 */
constexpr std::uint32_t kLeafSize = 16;

/** 候选数低于它就别开线程（线程调度 + 并查集竞争的开销盖过收益）。 */
constexpr std::size_t kParallelMinPoints = 200000;

/**
 * KD 树工作点（结构体数组，16 B/点）。
 *
 * ⚠ 存的是**坐标副本**而不是指向源缓冲的指针：源是分块 + index 间接的，KD 树要
 * 随机访问且建树时要**重排**（nth_element），必须落在连续内存上。
 * `code` = 候选号（块主序），重排后它是槽位 → 候选号唯一的回填依据。
 */
struct Point {
  float x;
  float y;
  float z;
  std::uint32_t code;
};

inline float axisOf(const Point& p, int axis) {
  return axis == 0 ? p.x : (axis == 1 ? p.y : p.z);
}

/** KD 树节点；axis < 0 = 叶（点落在 points 的 [begin, end) 槽位区间）。 */
struct Node {
  std::uint32_t begin = 0;
  std::uint32_t end = 0;
  std::int32_t axis = -1;
  float split = 0.0f;
  std::uint32_t left = 0;
  std::uint32_t right = 0;
};

/**
 * 静态 KD 树（最长轴中点分裂，叶固定容量）。
 *
 * 建树**串行**：nth_element 主导，实测 1e7 点约 1 秒级——相对下面的查询阶段是小头，
 * 而查询阶段可以完美并行（每个候选点的查询彼此独立）。若将来建树成为瓶颈，
 * 并行化的位置是"顶层劈开后各子树各自建局部节点表再合并"（节点表 push_back 不是线程安全的）。
 * 节点表扁平存数组，查询递归（树深 ≈ log₂(N/16)，1e8 点也只有 23 层）。
 */
class KdTree {
 public:
  /** 建树；会重排 pts（槽位号只在树内有效）。 */
  void build(std::vector<Point>& pts) {
    nodes_.clear();
    const std::uint32_t n = static_cast<std::uint32_t>(pts.size());
    if (n == 0) return;
    // 叶 ≤ N/8（区间 17 会劈成 8+9），内部节点 ≈ 叶数 - 1 ⇒ N/4 + 4 稳够
    nodes_.reserve(n / 4 + 4);
    buildRange(pts, 0, n);
  }

  /** 收集落在 (tx,ty,tz) 半径 r（平方 r2）内的**槽位号**（槽位 → 候选号查 pts[slot].code）。 */
  void radiusSearch(const std::vector<Point>& pts, std::uint32_t slot, double r2,
                    std::vector<std::uint32_t>& out) const {
    const Point& p = pts[slot];
    out.clear();
    searchNode(pts, 0, static_cast<double>(p.x), static_cast<double>(p.y), static_cast<double>(p.z), r2, out);
  }

 private:
  std::uint32_t buildRange(std::vector<Point>& pts, std::uint32_t begin, std::uint32_t end) {
    const std::uint32_t idx = static_cast<std::uint32_t>(nodes_.size());
    nodes_.emplace_back();
    nodes_[idx].begin = begin;
    nodes_[idx].end = end;
    if (end - begin <= kLeafSize) return idx;  // axis 保持 -1 = 叶

    // 各轴跨度（O(区间)，只在内部节点做，总代价 O(n log n) 但系数极低）
    float lo[3];
    float hi[3];
    lo[0] = hi[0] = pts[begin].x;
    lo[1] = hi[1] = pts[begin].y;
    lo[2] = hi[2] = pts[begin].z;
    for (std::uint32_t s = begin + 1; s < end; ++s) {
      const Point& p = pts[s];
      if (p.x < lo[0]) lo[0] = p.x; else if (p.x > hi[0]) hi[0] = p.x;
      if (p.y < lo[1]) lo[1] = p.y; else if (p.y > hi[1]) hi[1] = p.y;
      if (p.z < lo[2]) lo[2] = p.z; else if (p.z > hi[2]) hi[2] = p.z;
    }
    int axis = 0;
    double best = -1.0;
    for (int a = 0; a < 3; ++a) {
      const double span = static_cast<double>(hi[a]) - static_cast<double>(lo[a]);
      if (span > best) {
        best = span;
        axis = a;
      }
    }
    // 全部点重合（跨度 0）：中点分裂无意义，就地作叶——否则会无限递归
    if (best <= 0.0) return idx;

    const std::uint32_t mid = begin + (end - begin) / 2;
    std::nth_element(pts.begin() + begin, pts.begin() + mid, pts.begin() + end,
                     [axis](const Point& a, const Point& b) { return axisOf(a, axis) < axisOf(b, axis); });
    // nth_element 保证：左区间全部 ≤ pts[mid]、右区间全部 ≥ pts[mid]
    nodes_[idx].axis = axis;
    nodes_[idx].split = axisOf(pts[mid], axis);
    const std::uint32_t left = buildRange(pts, begin, mid);
    const std::uint32_t right = buildRange(pts, mid, end);
    nodes_[idx].left = left;
    nodes_[idx].right = right;
    return idx;
  }

  void searchNode(const std::vector<Point>& pts, std::uint32_t ni, double tx, double ty, double tz, double r2,
                  std::vector<std::uint32_t>& out) const {
    const Node& n = nodes_[ni];
    if (n.axis < 0) {
      for (std::uint32_t s = n.begin; s < n.end; ++s) {
        const Point& p = pts[s];
        // 坐标升 double 再算：与 JS 对照实现（Float64Array）逐位一致；且不用 float 累加
        const double dx = static_cast<double>(p.x) - tx;
        const double dy = static_cast<double>(p.y) - ty;
        const double dz = static_cast<double>(p.z) - tz;
        // 含等号：距离 == 阈值算同类（PCL 同）
        if (dx * dx + dy * dy + dz * dz <= r2) out.push_back(s);
      }
      return;
    }
    const double d = (n.axis == 0 ? tx : (n.axis == 1 ? ty : tz)) - static_cast<double>(n.split);
    if (d <= 0.0) {
      searchNode(pts, n.left, tx, ty, tz, r2, out);
      if (d * d <= r2) searchNode(pts, n.right, tx, ty, tz, r2, out);
    } else {
      searchNode(pts, n.right, tx, ty, tz, r2, out);
      if (d * d <= r2) searchNode(pts, n.left, tx, ty, tz, r2, out);
    }
  }

  std::vector<Node> nodes_;
};

/**
 * 找根：路径减半。
 *
 * 单调性保证无环：parent 指针永远指向**更小的**下标（见 unite 的小根优先），
 * 于是任何一条链都严格递减、必然终止于某个自指的根；并发下读到"稍旧"的父指针
 * 也仍在同一条向根的链上，故不需要加锁。
 */
inline std::uint32_t findRoot(std::atomic<std::uint32_t>* parent, std::uint32_t start) {
  std::uint32_t x = start;
  for (;;) {
    // p 必须是非 const 左值：compare_exchange_weak 的 expected 形参要在失败时被写回
    std::uint32_t p = parent[x].load(std::memory_order_relaxed);
    if (p == x) return x;
    const std::uint32_t gp = parent[p].load(std::memory_order_relaxed);
    if (gp == p) return p;
    parent[x].compare_exchange_weak(p, gp, std::memory_order_relaxed);  // 失败 = 有并发改动，忽略即可
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
    if (ra < rb) std::swap(ra, rb);  // 现在 ra > rb：把大根挂到小根下
    std::uint32_t expected = ra;
    if (parent[ra].compare_exchange_strong(expected, rb, std::memory_order_relaxed)) return;
    // CAS 失败：ra 在这一瞬被别人挂走了，重来一轮（不变量不变）
  }
}

/** 候选总数（各块 indexCount / vertexCount 之和）。 */
std::uint64_t countCandidates(const EntitySource& entity) {
  std::uint64_t total = 0;
  for (const ChunkSource& c : entity.chunks) total += c.index ? c.indexCount : c.vertexCount;
  return total;
}

}  // namespace

EntityResult clusterEntity(const EntitySource& entity, const ClusterParams& params, unsigned threadCount) {
  EntityResult result;
  const std::uint64_t total = countCandidates(entity);
  if (total == 0) return result;
  // 契约防御（同 treeiso 的 badIndex 预检）：候选数超 uint32 槽位空间，或 index 越界，
  // 一律交空结果——调用方拿到的 labels 长度与期望不符即干净失败，绝不读越界内存。
  if (total > 0xffffffffull) return result;
  for (const ChunkSource& c : entity.chunks) {
    if (!c.index) continue;
    for (std::uint32_t k = 0; k < c.indexCount; ++k) {
      if (c.index[k] >= c.vertexCount) return EntityResult{};
    }
  }
  const std::uint32_t n = static_cast<std::uint32_t>(total);

  // 1) 平铺候选：块主序拼接，候选号 = 写入位置（与 labels 的下标空间一致）
  std::vector<Point> pts(n);
  std::size_t w = 0;
  for (const ChunkSource& c : entity.chunks) {
    if (c.index) {
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

  const double tol = params.tolerance;
  // 2) tolerance ≤ 0（含 NaN）：没有"距离 ≤ 阈值"的邻居，每个候选自成一簇。
  //    刻意不把"距离恰好 0"算同类——0 阈值是退化输入，语义要可预测（UI 另把阈值下限钳到 > 0）。
  if (!(tol > 0.0)) {
    result.labels.resize(n);
    result.clusterSizes.assign(n, 1);
    for (std::uint32_t g = 0; g < n; ++g) result.labels[g] = static_cast<std::int32_t>(g) + 1;
    return result;
  }

  // 3) 建树 + 并行半径查询 → 并查集
  KdTree tree;
  tree.build(pts);
  const double r2 = tol * tol;

  std::unique_ptr<std::atomic<std::uint32_t>[]> parent(new std::atomic<std::uint32_t>[n]);
  for (std::uint32_t i = 0; i < n; ++i) parent[i].store(i, std::memory_order_relaxed);

  unsigned threads = threadCount;
  if (threads == 0) {
    threads = std::thread::hardware_concurrency();
    if (threads == 0) threads = 1;
  }
  if (total < kParallelMinPoints) threads = 1;

  // 按**槽位**区间切段（不是候选号）：槽位是 KD 树里的连续内存，遍历它 = 顺序访问坐标
  const auto processRange = [&](std::uint32_t begin, std::uint32_t end) {
    std::vector<std::uint32_t> hits;
    for (std::uint32_t s = begin; s < end; ++s) {
      tree.radiusSearch(pts, s, r2, hits);
      const std::uint32_t g = pts[s].code;
      for (const std::uint32_t hit : hits) {
        const std::uint32_t h = pts[hit].code;
        // 只与候选号更大的邻居 union：无序对 (g,h) 恰好被处理一次（h == g 是自己，跳过）
        if (h > g) unite(parent.get(), g, h);
      }
    }
  };

  if (threads <= 1) {
    processRange(0, n);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(threads);
    const std::uint64_t step = (static_cast<std::uint64_t>(n) + threads - 1) / threads;
    for (unsigned t = 0; t < threads; ++t) {
      const std::uint64_t begin = std::min<std::uint64_t>(t * step, n);
      const std::uint64_t end = std::min<std::uint64_t>(begin + step, n);
      if (begin >= end) break;
      pool.emplace_back([&processRange, begin, end] { processRange(static_cast<std::uint32_t>(begin), static_cast<std::uint32_t>(end)); });
    }
    for (std::thread& th : pool) th.join();
  }

  // 4) 按**候选序**首遇编号（块主序 ⇒ 标签确定、与线程数和树形无关）
  result.labels.assign(n, 0);
  std::vector<std::int32_t> rootLabel(n, 0);  // 根候选号 → 标签（0 = 尚未分配）
  std::int32_t k = 0;
  for (std::uint32_t g = 0; g < n; ++g) {
    const std::uint32_t r = findRoot(parent.get(), g);
    std::int32_t label = rootLabel[r];
    if (label == 0) {
      label = ++k;
      rootLabel[r] = label;
    }
    result.labels[g] = label;
  }
  result.clusterSizes.assign(static_cast<std::size_t>(k), 0);
  for (std::uint32_t g = 0; g < n; ++g) ++result.clusterSizes[static_cast<std::size_t>(result.labels[g] - 1)];
  return result;
}

}  // namespace euclidean_cluster
