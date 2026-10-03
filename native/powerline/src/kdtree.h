#pragma once
/**
 * 静态 KD 树（本模块内部工具，不依赖第三方库）。
 *
 * 逐字移植自 native/euclidean-cluster/src/euclidean_cluster.cc 里那份（最长轴中点分裂、
 * 叶固定 16 点、坐标升 double 再比较）——那一份已在生产与单测里跑过，**不要"顺手优化"**：
 * - 坐标升 double 再算距离：与渲染侧的 JS 对照实现（Float64Array）逐位一致；
 * - `nth_element` 保证左区间全 ≤ pts[mid]、右区间全 ≥ pts[mid]；
 * - 各轴跨度全 0（整段全等点）时就地作叶——否则中点分裂会无限递归。
 *
 * ⚠ 与 treeiso/src/kdtree.h 那份**不是**同一个：那份只提供 knn、且按维度数组寻址；
 * 本模块要的是半径查询 + 结构体连续存储（PCAS 要按槽位顺序访问坐标）。
 */
#include <algorithm>
#include <cstdint>
#include <vector>

namespace powerline {

/** KD 树工作点（16 B/点）；`code` = 候选号（块主序），重排后是槽位 → 候选号唯一的回填依据。 */
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

/** 叶容量：叶内线性扫描，16 是"树深 / 节点数 / 叶扫描量"的常规折中。 */
constexpr std::uint32_t kLeafSize = 16;

/**
 * 静态 KD 树（建树串行、查询只读可并行）。
 *
 * 建树**串行**：nth_element 主导，1e7 点约 1 秒级；查询阶段才是大头，而它可完美并行
 *（每个查询彼此独立）。节点表扁平存数组，查询递归（树深 ≈ log₂(N/16)）。
 */
class KdTree {
 public:
  /** 建树；会重排 pts（槽位号只在树内有效）。 */
  void build(std::vector<Point>& pts) {
    nodes_.clear();
    const std::uint32_t n = static_cast<std::uint32_t>(pts.size());
    if (n == 0) return;
    nodes_.reserve(n / 4 + 4);  // 叶 ≤ N/8，内部节点 ≈ 叶数 - 1
    buildRange(pts, 0, n);
  }

  /** 收集落在以 slots[slot] 为中心、半径 r（平方 r2）内的**槽位号**（槽位 → 候选号查 pts[slot].code）。 */
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

    // 各轴跨度（O(区间)，只在内部节点做）
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
        const double dx = static_cast<double>(p.x) - tx;
        const double dy = static_cast<double>(p.y) - ty;
        const double dz = static_cast<double>(p.z) - tz;
        // 含等号：距离 == 半径算邻居（与其余模块的「含等号」语义一致）
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

}  // namespace powerline
