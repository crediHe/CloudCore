/**
 * 自写 d0 图割求解器实现（接口语义见 cutpursuit.h）。
 */
#include "cutpursuit.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace treeiso {

namespace {

constexpr int kMaxObsDim = 3;

/** 确定性伪随机（xorshift64*），分裂种子稳定可复现。 */
class DetRng {
 public:
  explicit DetRng(std::uint64_t seed) : s_(seed != 0 ? seed : 0x9e3779b97f4a7c15ULL) {}
  std::uint64_t next() {
    std::uint64_t x = s_;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    s_ = x;
    return x * 0x2545F4914F6CDD1DULL;
  }

 private:
  std::uint64_t s_;
};

/** 无向化后的边：a < b，w = 两个方向有向边权之和（割惩罚按无向对累计）。 */
struct UEdge {
  std::uint32_t a, b;
  float w;
};

/** 无向边邻接（邻接表）：nbrStart[i]..nbrStart[i+1] 为顶点 i 的邻接段。 */
struct Adjacency {
  std::vector<std::uint32_t> nbrStart;
  std::vector<std::uint32_t> nbr;
  std::vector<float> w;
};

void squareDist(const float* y, std::uint32_t v, int dim, const float* q, double* out) {
  const float* p = y + static_cast<std::size_t>(v) * dim;
  double s = 0.0;
  for (int d = 0; d < dim; ++d) {
    const double dd = static_cast<double>(p[d]) - q[d];
    s += dd * dd;
  }
  *out = s;
}

/** 由有向 CSR 归并无向边（重复对合并为权和），供内部图维护使用。 */
std::vector<UEdge> buildUndirectedEdges(const std::vector<std::uint32_t>& firstEdge,
                                        const std::vector<std::uint32_t>& adj,
                                        const std::vector<float>& weights,
                                        std::uint32_t n) {
  std::vector<std::pair<std::uint64_t, float>> raw;  // key = (a<<32)|b, a<b
  raw.reserve(adj.size());
  for (std::size_t u = 0; u < n; ++u) {
    for (std::uint32_t e = firstEdge[u]; e < firstEdge[u + 1]; ++e) {
      const std::uint32_t v = adj[e];
      if (v == u) continue;  // 自环对割惩罚无意义，丢弃
      const std::uint32_t a = std::min(u, static_cast<std::size_t>(v));
      const std::uint32_t b = std::max(u, static_cast<std::size_t>(v));
      raw.push_back({(static_cast<std::uint64_t>(a) << 32) | b, weights[e]});
    }
  }
  std::sort(raw.begin(), raw.end(),
            [](const auto& x, const auto& y) { return x.first < y.first; });
  std::vector<UEdge> out;
  for (std::size_t i = 0; i < raw.size();) {
    std::size_t j = i;
    double sum = 0.0;
    while (j < raw.size() && raw[j].first == raw[i].first) {
      sum += raw[j].second;
      ++j;
    }
    if (sum > 0.0f) {
      out.push_back({static_cast<std::uint32_t>(raw[i].first >> 32),
                     static_cast<std::uint32_t>(raw[i].first & 0xFFFFFFFFu),
                     static_cast<float>(sum)});
    }
    i = j;
  }
  return out;
}

Adjacency buildAdjacency(const std::vector<UEdge>& edges, std::uint32_t n) {
  Adjacency a;
  a.nbrStart.assign(static_cast<std::size_t>(n) + 1, 0);
  for (const UEdge& e : edges) {
    ++a.nbrStart[e.a + 1];
    ++a.nbrStart[e.b + 1];
  }
  for (std::size_t i = 0; i < n; ++i) {
    a.nbrStart[i + 1] += a.nbrStart[i];
  }
  std::vector<std::uint32_t> cursor = a.nbrStart;  // 拷贝起始偏移作游标
  a.nbr.resize(a.nbrStart[n]);
  a.w.resize(a.nbrStart[n]);
  for (const UEdge& e : edges) {
    a.nbr[cursor[e.a]] = e.b;
    a.w[cursor[e.a]] = e.w;
    ++cursor[e.a];
    a.nbr[cursor[e.b]] = e.a;
    a.w[cursor[e.b]] = e.w;
    ++cursor[e.b];
  }
  return a;
}

/** 分量对归约键（min<<32|max）。 */
inline std::uint64_t compPairKey(std::uint32_t a, std::uint32_t b) {
  if (a > b) std::swap(a, b);
  return (static_cast<std::uint64_t>(a) << 32) | b;
}

/** d0 图割执行引擎（单次运行状态）。 */
class CutPursuitEngine {
 public:
  CutPursuitEngine(const float* y, std::uint32_t n, int dim,
                   const std::vector<std::uint32_t>& firstEdge,
                   const std::vector<std::uint32_t>& adj,
                   const std::vector<float>& weights)
      : y_(y), n_(n), dim_(dim) {
    edges_ = buildUndirectedEdges(firstEdge, adj, weights, n_);
    adj_ = buildAdjacency(edges_, n_);
    sideAll_.assign(n_, 0);  // 分裂期二值缓冲，按绝对顶点下标访问
  }

  void run(int itMax) {
    // 初始：单分量（对齐参考实现 set_components(1, nullptr) 的起步）
    compOfV_.assign(n_, 0);
    compVerts_.clear();
    compVerts_.push_back(std::vector<std::uint32_t>(n_));
    for (std::uint32_t v = 0; v < n_; ++v) compVerts_[0][v] = v;
    compCnt_.assign(1, static_cast<double>(n_));
    compMean_.resize(static_cast<std::size_t>(1) * dim_);
    for (int d = 0; d < dim_; ++d) {
      double s = 0.0;
      for (std::uint32_t v = 0; v < n_; ++v) {
        s += y_[static_cast<std::size_t>(v) * dim_ + d];
      }
      compMean_[d] = static_cast<float>(s / n_);
    }
    sat_.assign(1, false);

    for (int it = 0; it < itMax; ++it) {
      bool changed = false;

      // —— 分裂阶段：对本轮开始时的分量快照逐个尝试一次 ——
      const std::size_t compSnap = compVerts_.size();
      for (std::size_t c = 0; c < compSnap; ++c) {
        if (sat_[c] || compVerts_[c].size() < 2) continue;
        if (trySplit(static_cast<std::uint32_t>(c))) {
          changed = true;
        } else {
          // 本轮无可获益分裂 → 标记饱和（被合并吸收后才重试）
          sat_[c] = true;
        }
      }

      // —— 合并阶段：跑到无可获益合并为止 ——
      if (mergeToFixedPoint()) changed = true;

      if (!changed) break;
    }
  }

  /** 稠密重编号（按分量最小顶点升序）后返回逐顶点分量。 */
  std::vector<std::int32_t> renumbered() const {
    const std::size_t cCount = compVerts_.size();
    std::vector<std::uint32_t> minV(cCount, std::numeric_limits<std::uint32_t>::max());
    for (std::size_t c = 0; c < cCount; ++c) {
      if (compVerts_[c].empty()) continue;  // 空壳分量（已被吸收）
      for (std::uint32_t v : compVerts_[c]) minV[c] = std::min(minV[c], v);
    }
    std::vector<std::size_t> order(cCount);
    for (std::size_t i = 0; i < cCount; ++i) order[i] = i;
    std::sort(order.begin(), order.end(), [&minV](std::size_t a, std::size_t b) {
      if (minV[a] != minV[b]) return minV[a] < minV[b];
      return a < b;
    });
    std::vector<std::int32_t> rank(cCount);
    for (std::size_t i = 0; i < cCount; ++i) rank[order[i]] = static_cast<std::int32_t>(i);
    std::vector<std::int32_t> out(n_);
    for (std::uint32_t v = 0; v < n_; ++v) out[v] = rank[compOfV_[v]];
    return out;
  }

 private:
  static constexpr int kMaxFlipsPasses = 40;
  static constexpr int kMaxAlternations = 4;

  bool alive(std::uint32_t c) const {
    return c < compVerts_.size() && !compVerts_[c].empty();
  }

  /** 尝试把分量 c 二分为 c 与新建分量。仅当整体能量严格下降才接受。 */
  bool trySplit(std::uint32_t c) {
    const std::vector<std::uint32_t>& cv = compVerts_[c];
    const std::size_t cSize = cv.size();
    if (cSize < 2) return false;
    const float* muOld = compMean_.data() + static_cast<std::size_t>(c) * dim_;

    // 当前分量能量（数据项；同分量内无割，跨分量边界割与分裂结果无关——分裂只
    // 把 c 改成 {c, 新分量}，对外的割惩罚 [x≠y] 恒为 1，双方抵消）
    double fOld = 0.0;
    for (std::uint32_t v : cv) {
      double d2;
      squareDist(y_, v, dim_, muOld, &d2);
      fOld += d2;
    }

    // k-means++ 取 2 个观测种子（确定性 RNG，种子仅依赖分量 id）
    DetRng rng(0x9e3779b97f4a7c15ULL ^
               (static_cast<std::uint64_t>(c) + 1) * 0x9E3779B97F4A7C15ULL);
    float seeds[2][kMaxObsDim];
    const std::uint32_t s0 = cv[rng.next() % cSize];
    for (int d = 0; d < dim_; ++d) seeds[0][d] = y_[static_cast<std::size_t>(s0) * dim_ + d];
    double totalD2 = 0.0;
    for (std::uint32_t v : cv) {
      double d2;
      squareDist(y_, v, dim_, seeds[0], &d2);
      totalD2 += d2;
    }
    if (totalD2 <= 0.0) {
      // 分量内观测全部重合：数据项无法获益，分裂只会增加割惩罚
      return false;
    }
    const double pick = static_cast<double>(rng.next() >> 11) / 9007199254740992.0 * totalD2;
    std::uint32_t s1 = s0;
    double acc = 0.0;
    for (std::uint32_t v : cv) {
      double d2;
      squareDist(y_, v, dim_, seeds[0], &d2);
      acc += d2;
      if (acc >= pick) {
        s1 = v;
        break;
      }
    }
    if (s1 == s0) s1 = cv[cSize - 1];
    if (s1 == s0) return false;  // 除 s0 外全重合，无第二个可辨种子
    for (int d = 0; d < dim_; ++d) seeds[1][d] = y_[static_cast<std::size_t>(s1) * dim_ + d];

    // Lloyd 交替「指派 → 重算均值」让两质心初步成形
    std::vector<std::uint8_t>& side = sideAll_;  // 按绝对顶点下标索引
    float mu[2][kMaxObsDim];
    std::memcpy(mu[0], seeds[0], sizeof(float) * dim_);
    std::memcpy(mu[1], seeds[1], sizeof(float) * dim_);
    auto assignNearest = [&]() {
      for (std::uint32_t v : cv) {
        double d0, d1;
        squareDist(y_, v, dim_, mu[0], &d0);
        squareDist(y_, v, dim_, mu[1], &d1);
        side[v] = (d1 < d0) ? 1 : 0;
      }
    };
    auto updateMeans = [&]() -> bool {
      double sum0[kMaxObsDim] = {0.0}, sum1[kMaxObsDim] = {0.0};
      double n0 = 0.0, n1 = 0.0;
      for (std::uint32_t v : cv) {
        const float* p = y_ + static_cast<std::size_t>(v) * dim_;
        if (side[v] == 1) {
          for (int d = 0; d < dim_; ++d) sum1[d] += p[d];
          n1 += 1.0;
        } else {
          for (int d = 0; d < dim_; ++d) sum0[d] += p[d];
          n0 += 1.0;
        }
      }
      if (n0 == 0.0 || n1 == 0.0) return false;
      for (int d = 0; d < dim_; ++d) {
        mu[0][d] = static_cast<float>(sum0[d] / n0);
        mu[1][d] = static_cast<float>(sum1[d] / n1);
      }
      return true;
    };
    assignNearest();
    for (int i = 0; i < 2; ++i) {  // Lloyd 交替
      if (!updateMeans()) return false;
      assignNearest();
    }
    if (!updateMeans()) return false;

    // 逐点局部翻转（数据项 + 分量内边割，均值固定），收敛后换均值再翻几轮
    auto flipPass = [&]() -> bool {
      bool any = false;
      for (std::uint32_t v : cv) {
        const std::uint8_t cur = side[v];
        double bestCost = 0.0;
        std::uint8_t bestSide = cur;
        for (int kOpt = 0; kOpt < 2; ++kOpt) {
          const std::uint8_t k = static_cast<std::uint8_t>(kOpt);
          double d2;
          squareDist(y_, v, dim_, mu[k], &d2);
          double cost = d2;
          for (std::uint32_t e = adj_.nbrStart[v]; e < adj_.nbrStart[v + 1]; ++e) {
            const std::uint32_t u = adj_.nbr[e];
            if (compOfV_[u] != static_cast<std::int32_t>(c)) continue;
            // 分量外邻居的割惩罚与 v 归哪侧无关（见上注释），不计入比较
            if (side[u] != k) cost += adj_.w[e];
          }
          if (kOpt == 0) {
            bestCost = cost;
          } else if (cost < bestCost) {
            bestCost = cost;
            bestSide = k;
          }
        }
        if (bestSide != cur) {
          side[v] = bestSide;
          any = true;
        }
      }
      return any;
    };
    for (int alt = 0; alt < kMaxAlternations; ++alt) {
      for (int pass = 0; pass < kMaxFlipsPasses; ++pass) {
        if (!flipPass()) break;
      }
      if (alt + 1 < kMaxAlternations) {
        if (!updateMeans()) return false;
      }
    }

    // 汇总两侧能量（数据项 + 分量内部分割），严格下降才接受
    double n0 = 0.0, n1 = 0.0;
    for (std::uint32_t v : cv) {
      if (side[v] == 1) n1 += 1.0;
      else n0 += 1.0;
    }
    if (n0 == 0.0 || n1 == 0.0) return false;
    double fNew = 0.0;
    for (std::uint32_t v : cv) {
      double d2;
      squareDist(y_, v, dim_, mu[side[v]], &d2);
      fNew += d2;
    }
    double cut = 0.0;
    for (std::uint32_t v : cv) {
      for (std::uint32_t e = adj_.nbrStart[v]; e < adj_.nbrStart[v + 1]; ++e) {
        const std::uint32_t u = adj_.nbr[e];
        if (u < v && compOfV_[u] == static_cast<std::int32_t>(c) && side[u] != side[v]) {
          cut += adj_.w[e];
        }
      }
    }
    if (fNew + cut >= fOld) return false;  // 未严格下降 → 不分裂

    // 接受：属 1 的顶点迁入新建分量，属 0 的留在 c
    const std::size_t newId = compVerts_.size();
    std::vector<std::uint32_t> stay;
    std::vector<std::uint32_t> move;
    stay.reserve(static_cast<std::size_t>(n0));
    move.reserve(static_cast<std::size_t>(n1));
    std::vector<std::uint32_t>& keep = compVerts_[c];
    for (std::uint32_t v : keep) {
      if (side[v] == 1) {
        move.push_back(v);
        compOfV_[v] = static_cast<std::int32_t>(newId);
      } else {
        stay.push_back(v);
      }
    }
    keep.swap(stay);
    compVerts_.push_back(std::move(move));
    float* muC = compMean_.data() + static_cast<std::size_t>(c) * dim_;
    std::memcpy(muC, mu[0], sizeof(float) * dim_);
    compMean_.insert(compMean_.end(), mu[1], mu[1] + dim_);
    compCnt_[c] = n0;
    compCnt_.push_back(n1);
    sat_[c] = false;
    sat_.push_back(false);
    return true;
  }

  /** 分量 (a,b) 当前归约边权和（不邻接返回 0）。 */
  float reducedWeight(std::uint32_t a, std::uint32_t b) const {
    const auto it = cutCurrent_.find(compPairKey(a, b));
    return it == cutCurrent_.end() ? 0.0f : it->second;
  }

  /** 两相邻分量合并获益（对齐参考实现 Cp_d0_dist::compute_merge_candidate）。 */
  double mergeGain(std::uint32_t a, std::uint32_t b, float wBar) const {
    const float* muA = compMean_.data() + static_cast<std::size_t>(a) * dim_;
    const float* muB = compMean_.data() + static_cast<std::size_t>(b) * dim_;
    double diffSq = 0.0;
    for (int d = 0; d < dim_; ++d) {
      const double dd = static_cast<double>(muA[d]) - muB[d];
      diffSq += dd * dd;
    }
    const double wa = compCnt_[a];
    const double wb = compCnt_[b];
    return static_cast<double>(wBar) - (wa * wb / (wa + wb)) * diffSq;
  }

  /** 合并阶段：维护归约边表，获益 >0 的对按最大获益贪心合并至不动点。 */
  bool mergeToFixedPoint() {
    bool anyOverall = false;
    while (true) {
      // 归约边表：当前分量间所有无向边的权和（从原始边全量重建；
      // 合并只改顶点归属，不改原始边，因此边表可增量维护）
      cutCurrent_.clear();
      cutCurrent_.reserve(edges_.size() / 4 + 16);
      for (const UEdge& e : edges_) {
        const std::uint32_t ca = static_cast<std::uint32_t>(compOfV_[e.a]);
        const std::uint32_t cb = static_cast<std::uint32_t>(compOfV_[e.b]);
        if (ca == cb) continue;
        const std::uint64_t key = compPairKey(ca, cb);
        auto it = cutCurrent_.find(key);
        if (it == cutCurrent_.end()) cutCurrent_.emplace(key, e.w);
        else it->second += e.w;
      }
      if (cutCurrent_.empty()) break;

      // 获益大顶堆（获益出堆时按最新均值/边权惰性重算；
      // 被吸收分量产生的陈旧条目在 alive/邻接校验处失效跳过）
      using GainEntry = std::pair<double, std::uint64_t>;  // (获益, 分量对 key)
      std::vector<GainEntry> heap;
      heap.reserve(cutCurrent_.size());
      for (const auto& kv : cutCurrent_) {
        const std::uint32_t a = static_cast<std::uint32_t>(kv.first >> 32);
        const std::uint32_t b = static_cast<std::uint32_t>(kv.first & 0xFFFFFFFFu);
        const double gain = mergeGain(a, b, kv.second);
        if (gain > 0.0) heap.push_back({gain, kv.first});
      }
      std::make_heap(heap.begin(), heap.end(),
                     [](const GainEntry& x, const GainEntry& y) { return x.first < y.first; });

      bool anyMerged = false;
      while (!heap.empty()) {
        std::pop_heap(heap.begin(), heap.end(),
                      [](const GainEntry& x, const GainEntry& y) { return x.first < y.first; });
        const GainEntry top = heap.back();
        heap.pop_back();
        const std::uint32_t a = static_cast<std::uint32_t>(top.second >> 32);
        const std::uint32_t b = static_cast<std::uint32_t>(top.second & 0xFFFFFFFFu);
        if (!alive(a) || !alive(b)) continue;            // 一方已被吸收：陈旧条目
        const float wBar = reducedWeight(a, b);
        if (wBar <= 0.0f) continue;                      // 已不再邻接：陈旧条目
        if (mergeGain(a, b, wBar) <= 0.0) continue;      // 均值已变：获益不成立
        mergeInto(a, b);                                 // 吸收；cutCurrent_ 已增量更新
        anyMerged = true;
      }
      if (!anyMerged) break;
      anyOverall = true;
    }
    return anyOverall;
  }

  /** a 吸收 b（调用方保证 a<b）。同步维护归约边表、均值、饱和标记。 */
  void mergeInto(std::uint32_t a, std::uint32_t b) {
    // 1) 归约边表增量更新：b 的外部邻边并入 a；a—b 之间变内部，删除
    std::vector<std::uint32_t>& vb = compVerts_[b];
    for (std::uint32_t v : vb) {
      for (std::uint32_t e = adj_.nbrStart[v]; e < adj_.nbrStart[v + 1]; ++e) {
        const std::uint32_t u = adj_.nbr[e];
        const std::uint32_t cu = static_cast<std::uint32_t>(compOfV_[u]);
        if (cu == b) continue;  // 同分量内部边，不参与归约表
        if (cu == a) {
          // 吸收后变内部边：从 a—b 键里扣掉（最后整体删除该键）
          const auto it = cutCurrent_.find(compPairKey(a, b));
          it->second -= adj_.w[e];
        } else {
          // b—c 边改为 a—c 边：扣旧键、加新键
          const auto itOld = cutCurrent_.find(compPairKey(b, cu));
          itOld->second -= adj_.w[e];
          const std::uint64_t keyNew = compPairKey(a, cu);
          const auto itNew = cutCurrent_.find(keyNew);
          if (itNew == cutCurrent_.end()) cutCurrent_.emplace(keyNew, adj_.w[e]);
          else itNew->second += adj_.w[e];
        }
      }
    }
    const auto itAB = cutCurrent_.find(compPairKey(a, b));
    if (itAB != cutCurrent_.end() && itAB->second <= 0.0f) cutCurrent_.erase(itAB);

    // 2) 顶点归属与壳清理
    std::vector<std::uint32_t>& va = compVerts_[a];
    va.insert(va.end(), vb.begin(), vb.end());
    for (std::uint32_t v : vb) compOfV_[v] = static_cast<std::int32_t>(a);
    vb.clear();

    // 3) 均值与计数：加权合并到 a
    float* muA = compMean_.data() + static_cast<std::size_t>(a) * dim_;
    const float* muB = compMean_.data() + static_cast<std::size_t>(b) * dim_;
    const double wa = compCnt_[a];
    const double wb = compCnt_[b];
    for (int d = 0; d < dim_; ++d) {
      muA[d] = static_cast<float>((wa * muA[d] + wb * muB[d]) / (wa + wb));
    }
    compCnt_[a] = wa + wb;
    compCnt_[b] = 0.0;
    // 吸收了新质量后 a 需重新接受分裂尝试；b 已死不会再被访问
    sat_[a] = false;
    sat_[b] = false;
  }

  const float* y_;
  std::uint32_t n_;
  int dim_;

  std::vector<UEdge> edges_;
  Adjacency adj_;

  std::vector<std::int32_t> compOfV_;
  std::vector<std::vector<std::uint32_t>> compVerts_;
  std::vector<double> compCnt_;
  std::vector<float> compMean_;  // nComp*dim，与 compVerts_ 同长度对齐（空壳保留）
  std::vector<std::uint8_t> sat_;

  std::unordered_map<std::uint64_t, float> cutCurrent_;  // 合并阶段归约边表
  std::vector<std::uint8_t> sideAll_;                    // 分裂期二值缓冲
};

}  // namespace

void cutPursuit(const float* y, std::uint32_t n, int dim,
                const std::vector<std::uint32_t>& firstEdge,
                const std::vector<std::uint32_t>& adj,
                const std::vector<float>& weights,
                int itMax, std::vector<std::int32_t>& comp) {
  if (n == 0) {
    comp.clear();
    return;
  }
  if (dim < 1 || dim > kMaxObsDim) {
    comp.assign(n, 0);
    return;
  }
  CutPursuitEngine engine(y, n, dim, firstEdge, adj, weights);
  engine.run(itMax > 0 ? itMax : 20);
  comp = engine.renumbered();
}

}  // namespace treeiso
