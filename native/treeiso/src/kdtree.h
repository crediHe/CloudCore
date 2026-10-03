#pragma once
/**
 * 自写 k-d 树（native/treeiso 内部工具，不依赖第三方库）。
 *
 * 语义对齐参考实现（CloudCompare qTreeIso 插件）所依赖的 knncpp：
 * - 查询返回「平方距离」升序的 k 个近邻（knncpp::EuclideanDistance 在插件
 *   里返回平方距离，插件代码多处显式 sqrt / 按 m² 阈值比较，见 treeiso.cc）。
 * - 叶桶大小 16（knncpp setBucketSize(16)）。
 * - 确定性：分裂取最长轴中位数；等距离并列时按下标升序稳定排序截取，
 *   保证同输入两次运行结果完全一致（插件用 rand()/OpenMP，本身不确定）。
 *
 * 仅内部使用；算法本体见 treeiso.cc / cutpursuit.cc。
 */
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace treeiso {

/** 运行期维度 k-d 树（点数 n、维度 dim，坐标连续存储，stride = dim）。 */
class KdTree {
 public:
  /** 从坐标数组建树（pts 尺寸 n*dim；建树只重排内部下标，不改 pts）。 */
  KdTree(const float* pts, std::uint32_t n, int dim) : pts_(pts), dim_(dim), index_(n) {
    for (std::uint32_t i = 0; i < n; ++i) index_[i] = i;
    if (n > 0) build(0, n);
  }

  /** 查询点 q 的 k 个近邻（k ≤ 点集规模时返回满行）：
   *  outIdx / outSq 与输入点集下标一一对应，平方距离升序、并列按下标升序。 */
  void knn(const float* q, std::uint32_t k,
           std::vector<std::uint32_t>& outIdx, std::vector<float>& outSq) const {
    outIdx.clear();
    outSq.clear();
    if (index_.empty() || k == 0) return;
    if (k > index_.size()) k = static_cast<std::uint32_t>(index_.size());

    cand_.clear();
    bestSq_ = std::numeric_limits<float>::infinity();
    searchRec(0, q, k);

    if (cand_.size() > static_cast<std::size_t>(k)) {
      std::sort(cand_.begin(), cand_.end(), [](const Cand& a, const Cand& b) {
        if (a.sq != b.sq) return a.sq < b.sq;
        return a.idx < b.idx;
      });
      cand_.resize(k);
    }
    outIdx.reserve(cand_.size());
    outSq.reserve(cand_.size());
    for (const Cand& c : cand_) {
      outIdx.push_back(c.idx);
      outSq.push_back(c.sq);
    }
  }

 private:
  struct Cand {
    std::uint32_t idx;
    float sq;
  };
  struct Node {
    // 叶节点：lo..hi（左闭右开）为桶；内节点：axis 分裂轴、split 分裂值
    std::uint32_t lo, hi, left, right;
    std::int8_t axis;  // -1 = 叶
    float split;
  };

  void build(std::uint32_t lo, std::uint32_t hi) {
    const std::uint32_t count = hi - lo;
    const std::uint32_t nodeIdx = static_cast<std::uint32_t>(nodes_.size());
    nodes_.push_back(Node{lo, hi, 0, 0, -1, 0.0f});
    if (count <= kLeafBucket) return;  // 叶

    // 最长轴
    float minV[kMaxDim], maxV[kMaxDim];
    for (int d = 0; d < dim_; ++d) {
      minV[d] = std::numeric_limits<float>::infinity();
      maxV[d] = -std::numeric_limits<float>::infinity();
    }
    for (std::uint32_t i = lo; i < hi; ++i) {
      const float* p = pts_ + static_cast<std::size_t>(index_[i]) * dim_;
      for (int d = 0; d < dim_; ++d) {
        minV[d] = std::min(minV[d], p[d]);
        maxV[d] = std::max(maxV[d], p[d]);
      }
    }
    int axis = 0;
    float extent = -1.0f;
    for (int d = 0; d < dim_; ++d) {
      const float e = maxV[d] - minV[d];
      if (e > extent) {
        extent = e;
        axis = d;
      }
    }
    const std::uint32_t mid = lo + count / 2;
    std::nth_element(index_.begin() + lo, index_.begin() + mid, index_.begin() + hi,
                     [this, axis](std::uint32_t a, std::uint32_t b) {
                       const float va = pts_[static_cast<std::size_t>(a) * dim_ + axis];
                       const float vb = pts_[static_cast<std::size_t>(b) * dim_ + axis];
                       if (va != vb) return va < vb;
                       return a < b;  // 等值按下标，保证建树确定性
                     });
    const float split = pts_[static_cast<std::size_t>(index_[mid]) * dim_ + axis];
    // nth_element 保证 [lo,mid) 全 ≤ split、[mid,hi) 全 ≥ split；等值散在两侧。
    // 右子树从第一个「严格大于 split」的位置起，保证两侧都非空 → 递归深度 O(log n)
    std::uint32_t rightStart = mid;
    while (rightStart < hi) {
      const float v = pts_[static_cast<std::size_t>(index_[rightStart]) * dim_ + axis];
      if (v == split) {
        ++rightStart;
      } else {
        break;
      }
    }
    if (rightStart == hi) {
      // 后半全与 split 相等（含整段全等的退化输入）→ 直接作叶（暴力桶，结果仍精确）
      return;
    }
    nodes_[nodeIdx].axis = static_cast<std::int8_t>(axis);
    nodes_[nodeIdx].split = split;
    nodes_[nodeIdx].left = static_cast<std::uint32_t>(nodes_.size());
    build(lo, mid);
    nodes_[nodeIdx].right = static_cast<std::uint32_t>(nodes_.size());
    build(rightStart, hi);
  }

  // 递归 kNN：先深探近侧，分裂面距查询点超过当前最差才剪掉远侧（等距不剪）。
  void searchRec(std::uint32_t nodeIdx, const float* q, std::uint32_t k) const {
    const Node& nd = nodes_[nodeIdx];
    if (nd.axis < 0) {
      for (std::uint32_t i = nd.lo; i < nd.hi; ++i) {
        const std::uint32_t pIdx = index_[i];
        const float* p = pts_ + static_cast<std::size_t>(pIdx) * dim_;
        float sq = 0.0f;
        for (int d = 0; d < dim_; ++d) {
          const float dd = q[d] - p[d];
          sq += dd * dd;
        }
        if (sq <= bestSq_) {
          cand_.push_back(Cand{pIdx, sq});
          if (cand_.size() > k) {
            std::nth_element(cand_.begin(), cand_.begin() + k, cand_.end(),
                             [](const Cand& a, const Cand& b) { return a.sq < b.sq; });
            cand_.resize(k);
            float worst = -1.0f;
            for (const Cand& c : cand_) worst = std::max(worst, c.sq);
            bestSq_ = worst;
          }
        }
      }
      return;
    }
    const float qv = q[nd.axis];
    const std::uint32_t nearIdx = qv < nd.split ? nd.left : nd.right;
    const std::uint32_t farIdx = qv < nd.split ? nd.right : nd.left;
    searchRec(nearIdx, q, k);
    const float gap = qv - nd.split;
    if (gap * gap <= bestSq_) {
      searchRec(farIdx, q, k);
    }
  }

  static constexpr std::uint32_t kLeafBucket = 16;
  static constexpr int kMaxDim = 3;

  const float* pts_;
  int dim_;
  std::vector<std::uint32_t> index_;
  std::vector<Node> nodes_;
  // knn 查询的临时缓冲（查询不改树结构，只改缓冲内容）
  mutable std::vector<Cand> cand_;
  mutable float bestSq_;
};

}  // namespace treeiso
