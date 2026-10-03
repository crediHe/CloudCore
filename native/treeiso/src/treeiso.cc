/**
 * TreeIso 三阶段实现（对照 CloudCompare qTreeIso 插件行为语义自行编写，
 * 逐函数注释给出参考出处与有意差异；许可说明见 README-REF.md）。
 *
 * 数据约定（与插件标量场逐点等价，但全程在「候选点」上进行）：
 * - 候选点 = index 非空时其条目、否则全量顶点，数量 N；坐标连续存于
 *   cand（N×3，已减均值平移，仅数值稳定用——欧氏距离与差分不受影响）；
 * - 体素抽稀（decimate）：每轴 cell = floor((v−min)/res)+1，cell 三元组去重
 *   保序（首现），观测 = 每 cell 首个点的原坐标（复刻参考 decimate_vec +
 *   unique_index_by_rows 的组合语义：逐行 cell 号 + 首现行号 + 逐行组号）；
 * - 所有 kNN「查询数 X」与插件一致：查询结果含自身（0 距首位），实际取排除
 *   自身后的前 X−1 条为邻居（参考代码循环自 j=1 起跳第 0 列）。本 k-d 树在
 *   并列距离时按下标升序稳定截取；完全同坐标的多点理论上会把对方挤掉一条
 *   邻居——真实树木点云中浮点重复率极低，注释为有意差异（比参考更确定）。
 */
#include "cutpursuit.h"
#include "kdtree.h"
#include "treeiso.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <numeric>
#include <utility>
#include <vector>

namespace treeiso {

namespace {

// ============================================================
// 小工具
// ============================================================

/** 下标稳定升序排列（按 vals 值）。 */
std::vector<std::uint32_t> stableOrderByValue(const std::vector<std::int32_t>& vals) {
  std::vector<std::uint32_t> idx(vals.size());
  std::iota(idx.begin(), idx.end(), 0u);
  std::stable_sort(idx.begin(), idx.end(), [&vals](std::uint32_t a, std::uint32_t b) {
    if (vals[a] != vals[b]) return vals[a] < vals[b];
    return a < b;
  });
  return idx;
}

/**
 * 按值分组的唯一组（复刻参考 unique_group 语义）：
 * groups[i] = 值为 uniq[i] 的全部「下标」，组与值均升序。
 * 调用方用它既做「逐点组」（vals = 逐点标签）也做「簇单元组」（vals = 每簇
 * 代表点标签，groups[i] 元素即簇下标）——两粒度下 distinct 值集一致，索引
 * 按值序对齐（参考实现的 groupVGroup / clusterVGroup 即依此保持一致）。
 */
void uniqueGroup(const std::vector<std::int32_t>& vals,
                 std::vector<std::vector<std::uint32_t>>& groups,
                 std::vector<std::int32_t>& uniq) {
  groups.clear();
  uniq.clear();
  const std::size_t n = vals.size();
  if (n == 0) return;
  const std::vector<std::uint32_t> order = stableOrderByValue(vals);
  std::size_t runStart = 0;
  for (std::size_t i = 1; i <= n; ++i) {
    if (i == n || vals[order[i]] != vals[order[runStart]]) {
      groups.push_back(std::vector<std::uint32_t>(order.begin() + static_cast<std::ptrdiff_t>(runStart),
                                                  order.begin() + static_cast<std::ptrdiff_t>(i)));
      uniq.push_back(vals[order[runStart]]);
      runStart = i;
    }
  }
}

/** 对「行集」逐行体素抽稀。pts 为全量连续坐标（stride 3）；rows 为行集
 *  （空指针 = 全量行 0..count−1）；res ≤ 0 → 不抽稀。见文件头「数据约定」。 */
struct Decimate {
  std::vector<std::uint32_t> repOfRow;  // 行集内逐行 → 观测下标
  std::vector<std::uint32_t> reps;      // 观测 → 行集内行下标（该 cell 首现）
  std::size_t nObs() const { return reps.size(); }
};

Decimate voxelDecimate(const float* pts, const std::uint32_t* rows, std::size_t count,
                       float res) {
  Decimate out;
  if (count == 0) return out;
  out.repOfRow.resize(count);
  if (res <= 0.0f) {
    out.reps.resize(count);
    for (std::size_t i = 0; i < count; ++i) {
      out.reps[i] = static_cast<std::uint32_t>(i);
      out.repOfRow[i] = static_cast<std::uint32_t>(i);
    }
    return out;
  }
  auto rowOf = [rows](std::size_t k) {
    return rows ? rows[k] : static_cast<std::uint32_t>(k);
  };
  float minV[3] = {std::numeric_limits<float>::infinity(),
                   std::numeric_limits<float>::infinity(),
                   std::numeric_limits<float>::infinity()};
  for (std::size_t k = 0; k < count; ++k) {
    const float* p = pts + static_cast<std::size_t>(rowOf(k)) * 3;
    for (int d = 0; d < 3; ++d) minV[d] = std::min(minV[d], p[d]);
  }
  // cell 三元组（floor((v−min)/res)+1 复刻参考；键仅作分组，+1 无几何意义）
  std::map<std::array<std::int64_t, 3>, std::uint32_t> cellToObs;
  for (std::size_t k = 0; k < count; ++k) {
    const float* p = pts + static_cast<std::size_t>(rowOf(k)) * 3;
    std::array<std::int64_t, 3> key;
    for (int d = 0; d < 3; ++d) {
      key[d] = static_cast<std::int64_t>(std::floor((p[d] - minV[d]) / res)) + 1;
    }
    const auto it = cellToObs.find(key);
    if (it == cellToObs.end()) {
      const std::uint32_t obs = static_cast<std::uint32_t>(out.reps.size());
      cellToObs.emplace(key, obs);
      out.reps.push_back(static_cast<std::uint32_t>(k));
      out.repOfRow[k] = obs;
    } else {
      out.repOfRow[k] = it->second;
    }
  }
  return out;
}

/** 有向边 CSR（无向化与自环剔除在 cut-pursuit 引擎内归并）。 */
struct GraphCSR {
  std::vector<std::uint32_t> firstEdge;  // n+1
  std::vector<std::uint32_t> adj;
  std::vector<float> w;
};

/** XY 包围盒（复刻参考 BBox：仅 XY 两维，面积可 0）。 */
struct BBox2D {
  float minX = 0, minY = 0, maxX = 0, maxY = 0;
  float area() const { return (maxX - minX) * (maxY - minY); }
  static BBox2D fromPts(const float* pts, const std::vector<std::uint32_t>& idx) {
    BBox2D b;
    b.minX = b.minY = std::numeric_limits<float>::infinity();
    b.maxX = b.maxY = -std::numeric_limits<float>::infinity();
    for (std::uint32_t i : idx) {
      const float* p = pts + static_cast<std::size_t>(i) * 3;
      b.minX = std::min(b.minX, p[0]);
      b.minY = std::min(b.minY, p[1]);
      b.maxX = std::max(b.maxX, p[0]);
      b.maxY = std::max(b.maxY, p[1]);
    }
    return b;
  }
  /** 交叠比 = 交集面积 / 较小面积（复刻参考 BBox::overlap_ratio）。 */
  static float overlapRatio(const BBox2D& a, const BBox2D& b) {
    const float ix = std::max(0.0f, std::min(a.maxX, b.maxX) - std::max(a.minX, b.minX));
    const float iy = std::max(0.0f, std::min(a.maxY, b.maxY) - std::min(a.minY, b.minY));
    const float minArea = std::min(a.area(), b.area());
    if (minArea <= 0.0f) return 0.0f;  // 退化盒：参考实现产生 NaN，防御按 0
    return (ix * iy) / minArea;
  }
};

template <typename T>
std::size_t argMax(const std::vector<T>& vals) {
  std::size_t best = 0;
  for (std::size_t i = 1; i < vals.size(); ++i) {
    if (vals[i] > vals[best]) best = i;
  }
  return best;
}

/** 众数（频次最高；平手取较小值——参考实现平手次序不定，确定性差异）。 */
std::int32_t modeOf(const std::vector<std::int32_t>& vals) {
  std::map<std::int32_t, std::size_t> freq;
  for (std::int32_t v : vals) ++freq[v];
  std::int32_t best = 0;
  std::size_t bestFreq = 0;
  for (const auto& kv : freq) {
    if (kv.second > bestFreq) {
      bestFreq = kv.second;
      best = kv.first;
    }
  }
  return best;
}

/** 中位数。取副本计算不改调用方数组——参考实现 median_col 就地重排入参，
 *  重复调用结果恰一致（重排不改变值集），以副本免除实现细节依赖。 */
float medianOf(std::vector<float> vals) {
  if (vals.empty()) return 0.0f;
  const std::size_t mid = vals.size() / 2;
  std::nth_element(vals.begin(), vals.begin() + static_cast<std::ptrdiff_t>(mid), vals.end());
  if (vals.size() % 2 == 1) return vals[mid];
  const float lo = *std::max_element(vals.begin(), vals.begin() + static_cast<std::ptrdiff_t>(mid));
  return 0.5f * (lo + vals[mid]);
}

// ============================================================
// 阶段 1：Init —— 3D 图割超分割
// ============================================================
/**
 * 参考 Init_seg_pcd 语义：
 *   decimate_vec(pc, res1)+unique_index_by_rows → ia/ic；pc_sub = 每 cell 首现
 *   点原坐标；K = minNN1−1；perform_cut_pursuit(K, 3, λ1) —— d0 图割，loss
 *   维度 3（参考以列向量 3D 传参）；标签经 ic 回映到全部候选点。
 * 「检测/去除地面」弹窗省略：调用方保证输入为去地面后的纯树木点云
 * （应用侧流程：先 CSF 去地面，再对 offGround 云执行本分割）。
 * @return 逐候选 init 组件标签（值 0..rV−1）。
 */
std::vector<std::int32_t> initStage(const float* cand, std::size_t n, const TreeIsoParams& p) {
  std::vector<std::int32_t> label(n, 0);
  const Decimate dec = voxelDecimate(cand, nullptr, n, p.decimateRes1);
  const std::size_t m = dec.nObs();
  if (m == 0) return label;
  // 观测坐标连续化（每 cell 首现候选点原坐标）
  std::vector<float> obs(m * 3);
  for (std::size_t o = 0; o < m; ++o) {
    const float* p3 = cand + static_cast<std::size_t>(dec.reps[o]) * 3;
    obs[o * 3 + 0] = p3[0];
    obs[o * 3 + 1] = p3[1];
    obs[o * 3 + 2] = p3[2];
  }
  // 观测 kNN 建边（查询 minNN1 个含自身；排除自身后至多 minNN1−1 条/点）
  const std::uint32_t X = p.minNN1 > 0 ? p.minNN1 : 1u;
  KdTree tree(obs.data(), static_cast<std::uint32_t>(m), 3);
  GraphCSR g;
  g.firstEdge.assign(m + 1, 0);
  std::vector<std::uint32_t> nnI;
  std::vector<float> nnD;
  for (std::uint32_t v = 0; v < m; ++v) {  // pass 1：数度数
    tree.knn(obs.data() + static_cast<std::size_t>(v) * 3, X, nnI, nnD);
    std::uint32_t deg = 0;
    for (std::size_t j = 0; j < nnI.size(); ++j) {
      if (nnI[j] != v) ++deg;
    }
    g.firstEdge[v + 1] = deg;
  }
  for (std::size_t v = 0; v < m; ++v) g.firstEdge[v + 1] += g.firstEdge[v];
  g.adj.resize(g.firstEdge[m]);
  g.w.resize(g.firstEdge[m]);
  std::vector<std::uint32_t> cursor = g.firstEdge;
  for (std::uint32_t v = 0; v < m; ++v) {  // pass 2：填邻接（重复查询免存中间表）
    tree.knn(obs.data() + static_cast<std::size_t>(v) * 3, X, nnI, nnD);
    for (std::size_t j = 0; j < nnI.size(); ++j) {
      if (nnI[j] == v) continue;
      const float d = std::sqrt(nnD[j]) + 1e-6f;  // nnD 为平方距离
      const float w = std::exp(-(d * d)) * p.regStrength1;
      g.adj[cursor[v]] = nnI[j];
      g.w[cursor[v]] = w;
      ++cursor[v];
    }
  }
  // d0 图割（loss 3D = 观测坐标）
  std::vector<std::int32_t> comp;
  cutPursuit(obs.data(), static_cast<std::uint32_t>(m), 3, g.firstEdge, g.adj, g.w, 20, comp);
  for (std::size_t i = 0; i < n; ++i) {
    label[i] = comp[dec.repOfRow[i]];
  }
  return label;
}

// ============================================================
// 阶段 2：Intermediate —— 2D 图割间隙闭合
// ============================================================
/** 中间阶段输出（final 复用其中 init 簇分组与簇质心，避免重复计算）。 */
struct InterStageOut {
  std::vector<std::int32_t> label;                        // 逐候选中间组件标签
  std::vector<std::vector<std::uint32_t>> initGroups;     // init 簇（值升序，点下标）
  std::vector<float> clusterCentroid;                     // init 簇 3D 均值（nC×3，同序）
};

/**
 * 参考 Intermediate_seg_pcd 语义（逐条对应，见代码注释）：
 * 以 init 簇为单元：簇内抽稀（res2）取 cell 首现点为观测；簇质心 = 簇内全部
 * 点 3D 均值（复刻 mean_col）；质心 kNN（minNN2，含自身）定邻居簇表；
 * 簇对距离表 = 两簇「抽稀点集间最小平方距离」（在自身抽稀点上建树、查对方
 * 全部观测点的 1NN 取最小；重合簇得 0 → 等价参考未写格的默认 0 值）；
 * 观测级 3D kNN（minNN2，含自身）：邻居须处该观测所属簇的质心邻居表内、
 *   且簇对距离 < maxGap（平方距离 m²）才连边，权 = 10/((d+0.001)/0.01)·λ2；
 * d0 图割 loss 维度 2（观测取 x、y 两维，与参考以全坐标阵传 D=2 一致）；
 * 标签经簇内 cell（ic）回映到全部候选点。
 */
InterStageOut interStage(const float* cand, std::size_t n,
                         const std::vector<std::int32_t>& initLabel, const TreeIsoParams& p) {
  InterStageOut out;
  out.label.assign(n, 0);
  std::vector<std::int32_t> initUniq;
  uniqueGroup(initLabel, out.initGroups, initUniq);
  const std::size_t nC = out.initGroups.size();
  if (nC == 0) return out;
  const std::uint32_t X = p.minNN2 > 0 ? p.minNN2 : 1u;

  // —— 簇质心、簇内抽稀观测（全局观测序 = 簇序拼接）、逐点回映表 ——
  out.clusterCentroid.assign(nC * 3, 0.0f);
  std::vector<std::size_t> obsStart(nC), obsCount(nC);
  std::vector<std::uint32_t> obsOfPoint(n);  // 候选点 → 全局观测
  std::vector<Decimate> decs(nC);
  std::size_t nObs = 0;
  for (std::size_t c = 0; c < nC; ++c) {
    const std::vector<std::uint32_t>& gp = out.initGroups[c];
    double sx = 0.0, sy = 0.0, sz = 0.0;
    for (std::uint32_t i : gp) {
      const float* p3 = cand + static_cast<std::size_t>(i) * 3;
      sx += p3[0];
      sy += p3[1];
      sz += p3[2];
    }
    const float inv = 1.0f / static_cast<float>(gp.size());
    out.clusterCentroid[c * 3 + 0] = static_cast<float>(sx) * inv;
    out.clusterCentroid[c * 3 + 1] = static_cast<float>(sy) * inv;
    out.clusterCentroid[c * 3 + 2] = static_cast<float>(sz) * inv;
    // 簇内抽稀（min 按簇内点集，与参考 per-cluster decimate_vec 一致）
    decs[c] = voxelDecimate(cand, gp.data(), gp.size(), p.decimateRes2);
    obsStart[c] = nObs;
    obsCount[c] = decs[c].nObs();
    for (std::size_t k = 0; k < gp.size(); ++k) {
      obsOfPoint[gp[k]] = static_cast<std::uint32_t>(obsStart[c] + decs[c].repOfRow[k]);
    }
    nObs += obsCount[c];
  }
  std::vector<float> obsBuf(nObs * 3);
  std::vector<std::uint32_t> clusterOfObs(nObs);
  for (std::size_t c = 0; c < nC; ++c) {
    const std::vector<std::uint32_t>& gp = out.initGroups[c];
    for (std::size_t o = 0; o < obsCount[c]; ++o) {
      const float* p3 = cand + static_cast<std::size_t>(gp[decs[c].reps[o]]) * 3;
      const std::size_t gi = obsStart[c] + o;
      obsBuf[gi * 3 + 0] = p3[0];
      obsBuf[gi * 3 + 1] = p3[1];
      obsBuf[gi * 3 + 2] = p3[2];
      clusterOfObs[gi] = static_cast<std::uint32_t>(c);
    }
  }

  // —— 质心 kNN 邻居表（含自身；0 位自身簇、j≥1 为真邻居簇）——
  KdTree kdCent(out.clusterCentroid.data(), static_cast<std::uint32_t>(nC), 3);
  const std::uint32_t nK = std::min(X, static_cast<std::uint32_t>(nC));  // 含自身列数
  std::vector<std::vector<std::uint32_t>> centNN(nC);
  std::vector<float> nnDummy;  // 质心 kNN 只用到索引表（距离另有簇对距离表）
  for (std::uint32_t c = 0; c < nC; ++c) {
    kdCent.knn(out.clusterCentroid.data() + static_cast<std::size_t>(c) * 3, nK, centNN[c],
               nnDummy);
  }

  // —— 簇对距离表：簇 c 与第 j 个质心近邻簇的抽稀点集间最小平方距离 ——
  std::vector<std::vector<float>> nnDists(nC, std::vector<float>(nK, 0.0f));
  std::vector<std::uint32_t> qI;
  std::vector<float> qD;
  for (std::size_t c = 0; c < nC; ++c) {
    if (obsCount[c] == 0) continue;
    KdTree kdSelf(obsBuf.data() + obsStart[c] * 3, static_cast<std::uint32_t>(obsCount[c]), 3);
    for (std::uint32_t j = 1; j < nK; ++j) {
      const std::uint32_t nc = centNN[c][j];
      float best = std::numeric_limits<float>::infinity();
      for (std::size_t o = 0; o < obsCount[nc]; ++o) {
        const std::size_t idx = obsStart[nc] + o;
        kdSelf.knn(obsBuf.data() + idx * 3, 1, qI, qD);
        if (!qD.empty() && qD[0] < best) best = qD[0];
      }
      nnDists[c][j] = best;  // 重合簇得 0（同参考未填格默认 0 → 大权边）
    }
  }

  // —— 观测级 kNN 建边（同簇无边；邻居簇须在质心邻居表内且表距 < maxGap）——
  GraphCSR g;
  g.firstEdge.assign(nObs + 1, 0);
  KdTree kdObs(obsBuf.data(), static_cast<std::uint32_t>(nObs), 3);
  std::vector<std::uint32_t> nnI;
  std::vector<float> nnD;
  for (std::uint32_t o = 0; o < nObs; ++o) {  // pass 1：数度数
    kdObs.knn(obsBuf.data() + static_cast<std::size_t>(o) * 3, X, nnI, nnD);
    std::uint32_t deg = 0;
    const std::uint32_t oc = clusterOfObs[o];
    for (std::size_t j = 0; j < nnI.size(); ++j) {
      const std::uint32_t u = nnI[j];
      if (u == o) continue;
      const std::uint32_t uc = clusterOfObs[u];
      if (uc == oc) continue;
      const auto it = std::find(centNN[oc].begin(), centNN[oc].end(), uc);
      if (it == centNN[oc].end()) continue;  // 邻居簇不在质心近邻表内 → 无边
      const std::size_t pos = static_cast<std::size_t>(it - centNN[oc].begin());
      if (nnDists[oc][pos] < p.maxGap) ++deg;
    }
    g.firstEdge[o + 1] = deg;
  }
  for (std::size_t o = 0; o < nObs; ++o) g.firstEdge[o + 1] += g.firstEdge[o];
  g.adj.resize(g.firstEdge[nObs]);
  g.w.resize(g.firstEdge[nObs]);
  std::vector<std::uint32_t> cursor = g.firstEdge;
  for (std::uint32_t o = 0; o < nObs; ++o) {  // pass 2：填邻接
    kdObs.knn(obsBuf.data() + static_cast<std::size_t>(o) * 3, X, nnI, nnD);
    const std::uint32_t oc = clusterOfObs[o];
    for (std::size_t j = 0; j < nnI.size(); ++j) {
      const std::uint32_t u = nnI[j];
      if (u == o) continue;
      const std::uint32_t uc = clusterOfObs[u];
      if (uc == oc) continue;
      const auto it = std::find(centNN[oc].begin(), centNN[oc].end(), uc);
      if (it == centNN[oc].end()) continue;
      const std::size_t pos = static_cast<std::size_t>(it - centNN[oc].begin());
      const float nnDist = nnDists[oc][pos];
      if (nnDist >= p.maxGap) continue;
      const float w = 10.0f / ((nnDist + 0.001f) / 0.01f) * p.regStrength2;
      g.adj[cursor[o]] = u;
      g.w[cursor[o]] = w;
      ++cursor[o];
    }
  }

  // —— 2D 图割（观测取 x、y；cut-pursuit 引擎按行 stride=dim 前缀读取，
  //    直接传 dim=2 即只用前两列）——
  std::vector<std::int32_t> comp;
  // obsBuf 连续 stride 3；引擎约定数据行 stride = dim，此处 y2 需 stride 2 →
  // 单独打包 x/y 两列
  std::vector<float> obs2(nObs * 2);
  for (std::size_t o = 0; o < nObs; ++o) {
    obs2[o * 2 + 0] = obsBuf[o * 3 + 0];
    obs2[o * 2 + 1] = obsBuf[o * 3 + 1];
  }
  cutPursuit(obs2.data(), static_cast<std::uint32_t>(nObs), 2, g.firstEdge, g.adj, g.w, 20,
             comp);
  for (std::size_t i = 0; i < n; ++i) {
    out.label[i] = comp[obsOfPoint[i]];
  }
  return out;
}

// ============================================================
// 阶段 3：Final —— 树冠—树干迭代合并
// ============================================================
/**
 * 参考 Final_seg_pcd 语义（逐点标签承载「组」、init 簇单元承载 3D 质心集合）：
 *   1) 每个 init 簇内对中间标签众数投票（mode_col；平手取较小值——参考次序
 *      不定，确定性差异）；此后簇内逐点标签恒均匀（合并按整簇整组改写）；
 *   2) 簇单元分组按「每簇代表点（首点）标签」升序；簇数 ≤ 1 不进主循环；
 *   3) 主循环 while (toMergeIds ≠ 0 && toMergeIds ≠ prev)（首轮恒入）：每轮
 *      顶部 iter>1 时 prev = 上一轮候选数（参考把该更新放循环体内 iter>1 分
 *      支——终止 = 候选数归零或与前轮相同，而非「无合并发生」）；
 *      每轮重算簇单元分组（点级组与簇级组 distinct 值集一致、按值序索引
 *      对齐——见 uniqueGroup 注；参考每轮以逐点组做特征、以簇单元组取质心，
 *      两边索引一致才可混用）；组特征：2D/3D 质心、z 底、z 长、XY 盒；
 *      组 2D 质心 kNN（minNN3，含自身）→ σ = 各组第 1 真邻居距的均值（m²）；
 *      组相对高度 |(zFeat − minZ(NN)) / lenFeat| > 阈值判「树冠块」：首轮
 *      另需长度比 > 1.5（相对中位）才并入候选、始终收进 candidates+度量列；
 *      首轮 candidates 空 → 整体收敛 break；首轮无长冠块 → 取长度比最大者
 *      强并入（arg_max）；后续轮 relHt 过阈即入候选；
 *      候选 × 保留组 2D 质心 kNN（k = min(minNN3, nRemain)）逐对打分（见
 *      scoreOptions）；分数降序（论证见下），top ≤ 0 防续；比率 > 0.7 的相似
 *      邻居：唯一 → 并入之；多个 → 并入 min3D 最小者；无 → 该候选跳过；
 *      并入 = 候选组全部逐点标签改写为保留组标签值；
 *   4) 循环外无条件按值升序重编号 1..K（与参考 final_segs 值域一致，
 *      便于同云逐点对照）。
 *
 * 打分（per 候选组 t × 保留邻居组 r，复刻参考行内表达式）：
 *   垂直：s1 = zR+lenR−zT、s2 = zT+lenT−zR；vOv = min/max，负 → 0（不交叠）；
 *   水平：hOv = XY 盒交叠比（0 面积盒 → 0；参考 NaN 未定义 → 防御）；
 *   min3D = 候选组与保留组「所含 init 簇 3D 质心」间的最小平方距离——对保留
 *     组质心建树、查候选组每个质心 1NN 取最小（复刻参考单向查询）；
 *   min2D = 两组所含 init 簇质心 2D 均值的平面距离；
 *   score = exp(−(1−hOv)² − vW·(1−vOv)² − (min(min3D,min2D)/σ)²)。
 *
 * sort_indexes 方向论证：参考以 score_highest = scoreSort[0] 为「最高分」、
 *   以 ratio = score/最高分 > 0.7 过滤相似邻居、多者再按 min3D argmin 挑选
 *   ——结构仅在降序下自洽（升序时过滤恒真、argmin 与分数脱钩）。按降序
 *   实现，ratio 语义 = 与最高相似度的相对接近度；并列分数按下标升序稳定
 *   （参考并列次序不定 → 确定性差异）。
 */
namespace {

/** Final 打分所需的候选-保留组信息。 */
struct MergeOption {
  std::uint32_t remainGroup;  // 保留组（组下标，同 clusterVG 值序）
  float score;
  float min3D;
};

/** 对候选组 t 与全部保留邻居组逐对打分（NN 序）。 */
std::vector<MergeOption> scoreOptions(const float* cent,
                                      const std::vector<std::vector<std::uint32_t>>& clusterVG,
                                      const std::vector<float>& zFeat,
                                      const std::vector<float>& lenFeat,
                                      const std::vector<BBox2D>& box, float sigmaD,
                                      std::uint32_t t, const std::vector<std::uint32_t>& nnRemain,
                                      const TreeIsoParams& p) {
  std::vector<MergeOption> out;
  out.reserve(nnRemain.size());
  const std::vector<std::uint32_t>& tClusters = clusterVG[t];
  std::vector<std::uint32_t> qI;
  std::vector<float> qD;
  for (std::uint32_t r : nnRemain) {
    // —— 垂直叠长比 ——
    const float s1 = zFeat[r] + lenFeat[r] - zFeat[t];
    const float s2 = zFeat[t] + lenFeat[t] - zFeat[r];
    const float hi = std::max(s1, s2);
    float vOv = hi > 0.0f ? std::min(s1, s2) / hi : 0.0f;
    vOv = vOv > 0.0f ? vOv : 0.0f;  // 参考 clamp：无交叠（负）按 0
    // —— 水平交叠比 ——
    const float hOv = BBox2D::overlapRatio(box[t], box[r]);
    // —— min3D：候选组簇质心 → 保留组簇质心树 1NN 的最小平方距（单向复刻）——
    const std::vector<std::uint32_t>& rClusters = clusterVG[r];
    std::vector<float> rBuf(rClusters.size() * 3);
    for (std::size_t k = 0; k < rClusters.size(); ++k) {
      const float* c3 = cent + static_cast<std::size_t>(rClusters[k]) * 3;
      rBuf[k * 3 + 0] = c3[0];
      rBuf[k * 3 + 1] = c3[1];
      rBuf[k * 3 + 2] = c3[2];
    }
    float min3D = std::numeric_limits<float>::infinity();
    if (!rBuf.empty()) {
      KdTree kdR(rBuf.data(), static_cast<std::uint32_t>(rClusters.size()), 3);
      for (std::uint32_t c : tClusters) {
        kdR.knn(cent + static_cast<std::size_t>(c) * 3, 1, qI, qD);
        if (!qD.empty()) min3D = std::min(min3D, qD[0]);
      }
    }
    // —— min2D：两组簇质心 2D 均值差 ——
    double mxT = 0.0, myT = 0.0, mxR = 0.0, myR = 0.0;
    for (std::uint32_t c : tClusters) {
      mxT += cent[static_cast<std::size_t>(c) * 3 + 0];
      myT += cent[static_cast<std::size_t>(c) * 3 + 1];
    }
    for (std::uint32_t c : rClusters) {
      mxR += cent[static_cast<std::size_t>(c) * 3 + 0];
      myR += cent[static_cast<std::size_t>(c) * 3 + 1];
    }
    const double invT = 1.0 / static_cast<double>(tClusters.size());
    const double invR = 1.0 / static_cast<double>(rClusters.size());
    const double dx = mxR * invR - mxT * invT;
    const double dy = myR * invR - myT * invT;
    const float min2D = static_cast<float>(std::sqrt(dx * dx + dy * dy));
    // —— 综合分 ——
    const float span = std::min(min3D, min2D);
    const float dNorm = sigmaD > 0.0f ? span / sigmaD : 0.0f;
    const float score =
        std::exp(-(1.0f - hOv) * (1.0f - hOv) -
                 p.verticalWeight * (1.0f - vOv) * (1.0f - vOv) - dNorm * dNorm);
    out.push_back(MergeOption{r, score, min3D});
  }
  return out;
}

}  // namespace

std::vector<std::int32_t> finalStage(const float* cand, std::size_t n,
                                     std::vector<std::int32_t> segs,  // 逐候选当前标签（拷贝）
                                     const std::vector<std::vector<std::uint32_t>>& initGroups,
                                     const std::vector<float>& clusterCentroid,
                                     const TreeIsoParams& p) {
  // —— 1) 每 init 簇众数投票 ——
  for (const std::vector<std::uint32_t>& gp : initGroups) {
    std::vector<std::int32_t> vals(gp.size());
    for (std::size_t k = 0; k < gp.size(); ++k) vals[k] = segs[gp[k]];
    const std::int32_t m = modeOf(vals);
    for (std::uint32_t i : gp) segs[i] = m;
  }
  // —— 2) 簇单元分组（每簇代表 = 首点；此后簇内逐点标签恒均匀）——
  std::vector<std::int32_t> clusterVal(initGroups.size());
  for (std::size_t c = 0; c < initGroups.size(); ++c) {
    clusterVal[c] = segs[initGroups[c][0]];
  }
  std::vector<std::vector<std::uint32_t>> clusterVG;  // 簇单元（元素 = 簇下标）
  std::vector<std::int32_t> clusterUniq;              // 每单元标签值（升序）
  uniqueGroup(clusterVal, clusterVG, clusterUniq);

  if (clusterVG.size() <= 1) {
    // 无簇间差异（单组件）：直接重编号
  } else {
    // —— 3) 迭代合并主循环 ——
    std::size_t nToMerge = 1;  // 仿参考首轮恒入
    std::int32_t nPrevMerge = -1;
    std::size_t iter = 1;
    while (nToMerge != 0 && static_cast<std::int32_t>(nToMerge) != nPrevMerge) {
      if (iter > 1) nPrevMerge = static_cast<std::int32_t>(nToMerge);

      // 每轮由「当前逐点标签」重建簇单元（relabel 只整组改写，故每轮只需对
      // 代表点采样 + 重分组）
      for (std::size_t c = 0; c < initGroups.size(); ++c) {
        clusterVal[c] = segs[initGroups[c][0]];
      }
      uniqueGroup(clusterVal, clusterVG, clusterUniq);
      const std::size_t nGroups = clusterVG.size();
      if (nGroups <= 1) break;  // 参考此态 kNN 第 1 列越界，防御收敛

      // —— 组特征 ——
      std::vector<float> gMean(nGroups * 3), zFeat(nGroups), lenFeat(nGroups);
      std::vector<BBox2D> gBox(nGroups);
      std::vector<std::uint32_t> groupPts;  // 缓冲：逐组累计点下标
      for (std::size_t g = 0; g < nGroups; ++g) {
        const std::vector<std::uint32_t>& cls = clusterVG[g];
        groupPts.clear();
        for (std::uint32_t c : cls) {
          for (std::uint32_t i : initGroups[c]) groupPts.push_back(i);
        }
        double sx = 0.0, sy = 0.0, sz = 0.0;
        float zMin = std::numeric_limits<float>::infinity();
        float zMax = -std::numeric_limits<float>::infinity();
        for (std::uint32_t i : groupPts) {
          const float* p3 = cand + static_cast<std::size_t>(i) * 3;
          sx += p3[0];
          sy += p3[1];
          sz += p3[2];
          zMin = std::min(zMin, p3[2]);
          zMax = std::max(zMax, p3[2]);
        }
        const float inv = 1.0f / static_cast<float>(groupPts.size());
        gMean[g * 3 + 0] = static_cast<float>(sx) * inv;
        gMean[g * 3 + 1] = static_cast<float>(sy) * inv;
        gMean[g * 3 + 2] = static_cast<float>(sz) * inv;
        zFeat[g] = zMin;
        lenFeat[g] = zMax - zMin;
        gBox[g] = BBox2D::fromPts(cand, groupPts);
      }

      // —— 组 2D 质心 kNN（含自身）与 σ ——
      std::vector<float> gCent2(nGroups * 2);
      for (std::size_t g = 0; g < nGroups; ++g) {
        gCent2[g * 2 + 0] = gMean[g * 3 + 0];
        gCent2[g * 2 + 1] = gMean[g * 3 + 1];
      }
      const std::uint32_t Xg =
          std::min(p.minNN3 > 0 ? p.minNN3 : 1u, static_cast<std::uint32_t>(nGroups));
      KdTree kdG(gCent2.data(), static_cast<std::uint32_t>(nGroups), 2);
      std::vector<std::vector<std::uint32_t>> gNN(nGroups);
      std::vector<std::vector<float>> gNND(nGroups);
      for (std::uint32_t g = 0; g < nGroups; ++g) {
        kdG.knn(gCent2.data() + static_cast<std::size_t>(g) * 2, Xg, gNN[g], gNND[g]);
      }
      float sigmaD = 0.0f;
      for (std::size_t g = 0; g < nGroups; ++g) sigmaD += gNND[g][1];  // 第 1 真邻居
      sigmaD /= static_cast<float>(nGroups);

      // —— 候选判定（树冠块）——
      std::vector<std::uint32_t> toMerge;
      std::vector<std::uint32_t> cands;
      std::vector<float> candMetrics;
      for (std::uint32_t g = 0; g < nGroups; ++g) {
        float minZ = zFeat[g];  // NN 含自身
        for (std::uint32_t nn : gNN[g]) minZ = std::min(minZ, zFeat[nn]);
        float relHt = 0.0f;
        if (lenFeat[g] > 0.0f) {
          relHt = (zFeat[g] - minZ) / lenFeat[g];
        }
        // 零长（扁平）组参考实现除 0 得 ±inf/NaN 进候选，防御按 0 跳过（输入
        // 已去地面、扁平残层少见；行为差异注释）
        if (std::abs(relHt) > p.relHeightLengthRatio) {
          if (iter == 1) {
            const float lenRatio = lenFeat[g] / medianOf(lenFeat);  // 副本取中位数
            if (lenRatio > 1.5f) toMerge.push_back(g);
            cands.push_back(g);
            candMetrics.push_back(lenRatio);
          } else {
            toMerge.push_back(g);
          }
        }
      }
      if (iter == 1) {
        if (cands.empty()) break;  // 首轮无树冠块：整体收敛（参考语义）
        if (toMerge.empty()) {
          // 首轮无「长 > 1.5 中位」冠块 → 强取长度比最大者合并（参考 arg_max）
          toMerge.push_back(cands[static_cast<std::uint32_t>(argMax(candMetrics))]);
        }
      }
      if (toMerge.empty()) break;

      // —— 保留组集合 ——
      std::vector<bool> isMerge(nGroups, false);
      for (std::uint32_t t : toMerge) isMerge[t] = true;
      std::vector<std::uint32_t> remain;
      for (std::uint32_t g = 0; g < nGroups; ++g) {
        if (!isMerge[g]) remain.push_back(g);
      }
      if (remain.empty()) break;  // 全为候选（参考 remain 空时查询 k=0 崩，防御）

      // 保留组 2D 质心 kd 树，候选组逐组查邻居
      const std::uint32_t nRemain = static_cast<std::uint32_t>(remain.size());
      std::vector<float> rCent2(nRemain * 2);
      for (std::uint32_t r = 0; r < nRemain; ++r) {
        const std::uint32_t g = remain[r];
        rCent2[r * 2 + 0] = gCent2[g * 2 + 0];
        rCent2[r * 2 + 1] = gCent2[g * 2 + 1];
      }
      const std::uint32_t Xr = std::min(p.minNN3 > 0 ? p.minNN3 : 1u, nRemain);
      KdTree kdRem(rCent2.data(), nRemain, 2);
      std::vector<std::uint32_t> nnI2;
      std::vector<float> nnD2;

      // —— 逐候选：对保留邻居打分 → 相似过滤 → 选并入目标 → 整组改写 ——
      for (std::uint32_t t : toMerge) {
        kdRem.knn(gCent2.data() + static_cast<std::size_t>(t) * 2, Xr, nnI2, nnD2);
        std::vector<std::uint32_t> remainNN(nnI2.size());
        for (std::size_t j = 0; j < nnI2.size(); ++j) remainNN[j] = remain[nnI2[j]];
        const std::vector<MergeOption> opts =
            scoreOptions(clusterCentroid.data(), clusterVG, zFeat, lenFeat, gBox, sigmaD, t,
                         remainNN, p);
        if (opts.empty()) continue;
        // 分数降序、并列按下标（finalStage 头注的确定性差异）
        std::vector<MergeOption> sorted = opts;
        std::stable_sort(sorted.begin(), sorted.end(),
                         [](const MergeOption& a, const MergeOption& b) {
                           if (a.score != b.score) return a.score > b.score;
                           return a.remainGroup < b.remainGroup;
                         });
        const float top = sorted[0].score;
        if (!(top > 0.0f)) continue;  // 全 0/NaN（参考 score_highest == 0 → 跳过）
        // ratio > 0.7 的相对接近邻居（复刻参考过滤；降序下才有筛选意义）
        std::size_t nPass = 0;
        for (std::size_t j = 0; j < sorted.size(); ++j) {
          if (sorted[j].score / top > 0.7f) ++nPass;
        }
        if (nPass == 0) continue;  // 无任何相似邻居（参考 else 分支）
        // 唯一相似 → 并入之；多个相似 → 其中 min3D 最小者（参考在过滤集内
        // arg_min_col(min3DSpacingsFiltered)）
        std::uint32_t target;
        if (nPass == 1) {
          target = sorted[0].remainGroup;
        } else {
          std::size_t best = 0;
          for (std::size_t j = 1; j < sorted.size() && sorted[j].score / top > 0.7f; ++j) {
            if (sorted[j].min3D < sorted[best].min3D) best = j;
          }
          target = sorted[best].remainGroup;
        }
        // 并入：候选组全部点改写为保留组标签值（值 = clusterUniq[target]，
        // 与参考 groupU[filteredRemainIds[…]] 同值）
        const std::int32_t targetVal = clusterUniq[target];
        for (std::uint32_t c : clusterVG[t]) {
          for (std::uint32_t ipt : initGroups[c]) segs[ipt] = targetVal;
        }
      }
      nToMerge = toMerge.size();  // 参考语义：以候选数而非成功合并数记（头注 3）
      ++iter;
    }
  }

  // —— 4) 无条件重编号 1..K（以逐点 segs 为准）——
  std::vector<std::int32_t> label(n, 0);
  std::vector<std::vector<std::uint32_t>> ptGroups;
  std::vector<std::int32_t> ptUniq;
  uniqueGroup(segs, ptGroups, ptUniq);
  for (std::size_t g = 0; g < ptGroups.size(); ++g) {
    const std::int32_t v = static_cast<std::int32_t>(g) + 1;
    for (std::uint32_t i : ptGroups[g]) label[i] = v;
  }
  return label;
}

}  // namespace

// ============================================================
// 对外入口
// ============================================================
std::vector<std::int32_t> treeIsoSegment(const TreeIsoCloud& in, const TreeIsoParams& p) {
  const std::size_t vertN = in.positions.size() / 3;
  if (in.positions.empty() || vertN == 0) return {};
  const bool indexed = !in.index.empty();
  if (indexed) {
    for (std::uint32_t v : in.index) {
      if (v >= vertN) return {};  // 非法索引 → 拒绝
    }
  }
  const std::size_t n = indexed ? in.index.size() : vertN;
  // 候选坐标连续化 + 均值平移（数值稳定；欧氏距离与差分不受影响）
  std::vector<float> cand(n * 3);
  {
    double sx = 0.0, sy = 0.0, sz = 0.0;
    for (std::size_t k = 0; k < n; ++k) {
      const std::size_t v = indexed ? in.index[k] : static_cast<std::uint32_t>(k);
      const float* p3 = in.positions.data() + v * 3;
      sx += p3[0];
      sy += p3[1];
      sz += p3[2];
    }
    const double inv = 1.0 / static_cast<double>(n);
    const float cx = static_cast<float>(sx * inv);
    const float cy = static_cast<float>(sy * inv);
    const float cz = static_cast<float>(sz * inv);
    for (std::size_t k = 0; k < n; ++k) {
      const std::size_t v = indexed ? in.index[k] : static_cast<std::uint32_t>(k);
      const float* p3 = in.positions.data() + v * 3;
      cand[k * 3 + 0] = p3[0] - cx;
      cand[k * 3 + 1] = p3[1] - cy;
      cand[k * 3 + 2] = p3[2] - cz;
    }
  }
  // —— 三阶段串联 ——
  const std::vector<std::int32_t> initLabel = initStage(cand.data(), n, p);
  InterStageOut inter = interStage(cand.data(), n, initLabel, p);
  return finalStage(cand.data(), n, std::move(inter.label), inter.initGroups,
                    inter.clusterCentroid, p);
}

}  // namespace treeiso
