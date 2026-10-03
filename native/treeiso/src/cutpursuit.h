#pragma once
/**
 * 自写 d0 图割求解器（native/treeiso 内部引擎，纯 C++，不依赖第三方库）。
 *
 * 求解 Landrieu & Obozinski (2017) 的 cut-pursuit 同类目标：
 *
 *   F(x) = Σ_v ‖y_v − x_v‖² + Σ_{(u→v)∈E} w_uv·[x_u ≠ x_v]
 *
 * x 为各连通分量上的常量值（分量均值）；边权 w 由调用方构好（TreeIso 的
 * Init / Intermediate 两阶段分别把 λ1 / λ2 乘进边权里，与参考实现一致，
 * 见 treeiso.cc）。观测 y 与边方向语义、分量拟合/合并判据全部对齐
 * CloudCompare qTreeIso 插件所用的 Cp_d0_dist：
 * - 分量值 = 分量内观测的加权均值（单位顶点权 → 算术均值）；
 * - 合并判据：两相邻分量 u、v 合并获益
 *   gain = w̄_uv − (w_u·w_v/(w_u+w_v))·Σ_d (μ_u,d − μ_v,d)² > 0 才合并
 *   （w̄ = 两分量间所有有向边权之和；w 为分量点数；μ 按观测维度计算）；
 * - 分裂：对分量做 k 均值种子（k-means++，K=2）后逐点二值指派
 *   （数据项 + 分量内边割），整体严格降低 F 才接受；
 * - 迭代至不动点（无任何可获益分裂/合并），上限 itMax 轮（对齐 CC 的
 *   set_cp_param(1e-4, 20, 1000) 的 it_max=20）。
 *
 * 与 CC 实现的差异（独立实现的有意取舍，注释于各函数）：
 * - 确定性：CC 用 rand() 与 OpenMP，逐次运行结果可漂移；本实现固定种子，
 *   同输入两次运行结果一致；
 * - 合并/分裂的接受判断用 double 计算（CC 全程 float，大分量点数乘积会
 *   损失精度导致边界的误合并/误分裂）；质量只优不劣；
 * - 分裂的逐点指派用贪心局部翻转逼近 CC 的 maxflow 精确二值最小割，
 *   仅在能量几乎持平的边角情况有差异。
 *
 * 组件标签最终按「分量内最小顶点下标」升序重编号为 0..rV-1（确定性）。
 */
#include <cstdint>
#include <vector>

namespace treeiso {

/**
 * 执行 d0 图割。
 * @param y 观测值（n*dim，连续存储；执行期间外部必须保持稳定）
 * @param n 顶点数
 * @param dim 观测维度（2 或 3）
 * @param firstEdge/adj/weights 有向边 CSR（firstEdge 长 n+1，第 i 顶点出边
 *   邻接 adj[firstEdge[i]..firstEdge[i+1])，权 weights 同序；允许 u→v 与
 *   v→u 同时存在，割惩罚按方向分别累计）
 * @param itMax 迭代上限（对齐 CC 的 cp_param it_max，传 20）
 * @param comp 输出：逐顶点分量标签，密集 0..rV-1
 */
void cutPursuit(const float* y, std::uint32_t n, int dim,
                const std::vector<std::uint32_t>& firstEdge,
                const std::vector<std::uint32_t>& adj,
                const std::vector<float>& weights,
                int itMax, std::vector<std::int32_t>& comp);

}  // namespace treeiso
