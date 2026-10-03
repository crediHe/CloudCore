#pragma once
/**
 * 半径滤波（Radius Outlier Removal）纯 C++ 算法本体。
 *
 * 语义与 PCL RadiusOutlierRemoval 一致：点在其「搜索半径」内的邻居数（不含自身）
 * 少于「最小邻居点数」即判为孤立噪声剔除。文章参考：doc/半径滤波/。
 *
 * 设计（性能优先）：
 * - 均匀网格空间索引：格边长 = 搜索半径，每格桶内只存"候选点编码"，坐标仍留在
 *   调用方传入的原始缓冲中（零拷贝贴数据）。
 * - 候选语义与渲染侧分割产物一致：每块点云可以是"全量顶点"（index == nullptr），
 *   也可以是"顶点下标子集"（带 index 的分割产物）——网格与邻居搜索都只覆盖候选点，
 *   输出 kept 一律为顶点下标（递增，顺序 = 候选遍历序）。
 * - 查询提前短路：邻居计数 ≥ minNeighbors 立即判保留；遍历顺序"自己格优先"，
 *   密集主体点通常在自己格内凑够数。
 * - 查询多线程并行：候选点按全局序号连续分段交给硬件线程池，各段结果保序拼接。
 *
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 */
#include <cstdint>
#include <vector>

namespace radius_filter {

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
struct FilterParams {
  /** 搜索半径（与坐标同单位；坐标已减基准点，平移不变）。 */
  double radius = 0.0;
  /** 最小邻居点数（不含自身）；0 = 全部保留。 */
  std::uint32_t minNeighbors = 0;
};

/** 实体级滤波结果。 */
struct EntityResult {
  /** 每块 kept 顶点下标（递增序，与输入 chunks 对齐）。 */
  std::vector<std::vector<std::uint32_t>> keptByChunk;
  /** 保留点总数。 */
  std::uint64_t keptTotal = 0;
};

/**
 * 对单实体执行半径滤波。
 * @param entity      实体候选源（多块）
 * @param params      半径 / 最小邻居数
 * @param threadCount 并行线程数；0 = 按硬件并发自动（总候选点过少时自动退回单线程）
 * @returns 每块 kept 顶点下标（递增）与总保留数
 */
EntityResult filterEntity(const EntitySource& entity, const FilterParams& params,
                          unsigned threadCount = 0);

}  // namespace radius_filter
