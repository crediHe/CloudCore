#pragma once
/**
 * 统计滤波（Statistical Outlier Removal）纯 C++ 算法本体。
 *
 * 语义与 PCL pcl::StatisticalOutlierRemoval 一致：逐点求其 K（neighbors）个最近邻
 * 的平均距离，统计全体候选点的距离均值 μ 与总体标准差 σ，平均距离超过
 * μ + stddevMul × σ 的点判为统计离群噪声剔除。文章参考：doc/点云处理统计滤波/。
 *
 * 与半径滤波（native/radius-filter）的互补定位：半径滤波按"固定半径内的邻居数"
 * 判孤立，阈值是绝对尺度；本滤波按"邻居距离的全局统计分布"判离群，阈值随点云
 * 自身密度自适应——采集密度不均匀的点云建议先做统计滤波粗去噪，再做半径滤波，
 * 稀疏但有效的区域不会被半径滤波误杀。
 *
 * 设计（性能优先，语义精确）：
 * - 均匀网格仅作空间索引加速（格边长 s 由包围盒与点数按密度退化阶梯粗估，纯内部
 *   性能参数，不影响结果）；桶内只存"候选点编码"，坐标仍留在调用方传入的原始
 *   缓冲中（零拷贝贴数据）。
 * - 每点精确 top-K 最近邻：自中心格逐环（ring）向外扩张，候选点平方距离进容量为
 *   K 的 max-heap；堆满 K 后，凡"整格最小可能距离 ≥ 堆顶"的格整格剪枝，某一层
 *   全部在界格的最小可能距离 ≥ 堆顶即终止——输出与穷举精确 KNN 逐位一致，无
 *   近似误差（剪枝不改变判定，只省距离计算）。
 * - 邻居不足 K（孤点 / 云太小 / 搜索到云边界仍凑不满）时按实际找到的邻居数平均，
 *   与 PCL nearestKSearch 返回实际个数的行为一致。
 * - 候选语义与渲染侧分割产物一致：每块点云可以是"全量顶点"（index == nullptr），
 *   也可以是"顶点下标子集"（带 index 的分割产物）——邻居搜索只覆盖候选点，输出
 *   kept 一律为顶点下标（递增，顺序 = 候选遍历序）。
 * - 多趟并行：先并行算每点平均距离（保序存临时缓冲），归约 μ 后二次归约总体
 *   标准差 σ（避免方差公式相减的灾难性抵消），再并行按阈值判定。
 *
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 */
#include <cstdint>
#include <vector>

namespace sor_filter {

/** 单块候选源：坐标缓冲（显示坐标，已减共享基准点）+ 可选顶点下标列表。 */
struct ChunkSource {
  /** 全量顶点坐标，3 个 float/点（与 three.js position attribute 布局一致）。 */
  const float* positions = nullptr;
  /** positions 中的顶点数。 */
  std::uint32_t vertexCount = 0;
  /**
   * 候选顶点下标列表（递增）。nullptr = 候选为全部顶点（0..vertexCount-1）。
   * 带 index 的分割产物必须传 index：候选 = 其条目指向的顶点，而非全量缓冲。
   */
  const std::uint32_t* index = nullptr;
  /** index 条目数（index == nullptr 时忽略，候选数 = vertexCount）。 */
  std::uint32_t indexCount = 0;
};

/** 单实体：多块（块边界只是人为切分，邻居必须跨块搜索，因此网格建在实体全局）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 滤波参数。 */
struct SorParams {
  /** 最近邻个数 K（不含自身）；K = 0 防御为全部保留。 */
  std::uint32_t neighbors = 10;
  /** 标准差倍数 λ；判定阈值 = μ + λσ。负数防御为 0（阈值 = μ）。 */
  double stddevMul = 1.0;
};

/** 实体级滤波结果。 */
struct EntityResult {
  /** 每块 kept 顶点下标（递增序，与输入 chunks 对齐）。 */
  std::vector<std::vector<std::uint32_t>> keptByChunk;
  /** 保留点总数。 */
  std::uint64_t keptTotal = 0;
};

/**
 * 对单实体执行统计滤波。
 * @param entity      实体候选源（多块）
 * @param params      neighbors K / 标准差倍数 λ
 * @param threadCount 并行线程数；0 = 按硬件并发自动（总候选点过少时自动退回单线程）
 * @returns 每块 kept 顶点下标（递增）与总保留数
 */
EntityResult filterEntity(const EntitySource& entity, const SorParams& params,
                          unsigned threadCount = 0);

}  // namespace sor_filter
