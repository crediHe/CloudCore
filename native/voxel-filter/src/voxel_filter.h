#pragma once
/**
 * 体素滤波（Voxel Grid Filter 下采样）纯 C++ 算法本体。
 *
 * 语义对齐 PCL pcl::VoxelGrid（文章参考：doc/点云处理体素滤波/）：把点云空间按
 * 「体素边长」划成均匀立方体网格，每个体素内的点输出一个代表点，实现降采样。
 * 与 PCL 的差异：PCL 输出体素重心（新坐标），本模块受应用「索引空间」架构约束
 * （点数据从不重建，只按顶点下标做子集/拆分，见 pointcloudStore 注释），因此输出
 * 体素内**距重心最近的真实原始点**作为代表（重心本身非原始点不可输出；体素内
 * 仅 1 个点时天然保留自身）。视觉上≈重心位置，颜色等属性天然随原始点保留。
 *
 * 设计（镜像 radius_filter，性能优先）：
 * - 均匀网格空间索引：格边长 = 体素边长，每格桶内只存"候选点编码"，坐标仍留在
 *   调用方传入的原始缓冲中（零拷贝贴数据）。
 * - 候选语义与渲染侧分割产物一致：每块点云可以是"全量顶点"（index == nullptr），
 *   也可以是"顶点下标子集"（带 index 的分割产物）——网格划分只覆盖候选点，
 *   输出 kept 一律为顶点下标（递增，顺序 = 候选遍历序）。
 * - **求和顺序位级确定性契约**：桶成员遍历顺序 = 「块序升序 → 块内候选升序」
 *   （构建桶时即按此序 push），重心 = 按该序的 double 累加和 ÷ 计数。JS 暴力参考
 *   （src/renderer/utils/voxelFilter.ts）用同一顺序累加 → 重心与 C++ 位级一致，
 *   对照测试不会因 ulp 级舍入差出现近并列抖动。任何改动必须两处同步。
 * - 平局规则：代表点 = 距重心平方距离**最小**者，严格 < 更新 → 距离并列时取
 *   遍历序先者（候选序号更小者）。
 * - 代表点挑选并行：桶构建串行（同 radius），占用格（cell）列表收集后按段交给
 *   硬件线程池，各 cell 代表点唯一（每点只属于一个格）→ 无跨线程写竞争。
 *
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 */
#include <cstdint>
#include <vector>

namespace voxel_filter {

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

/** 单实体：多块（块边界只是人为切分，网格建在实体全局）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 滤波参数。 */
struct FilterParams {
  /** 体素边长（与坐标同单位；坐标已减基准点，平移不变）。 */
  double leafSize = 0.0;
};

/** 实体级滤波结果。 */
struct EntityResult {
  /** 每块 kept 顶点下标（递增序，与输入 chunks 对齐；每格至多 1 个代表点）。 */
  std::vector<std::vector<std::uint32_t>> keptByChunk;
  /** 保留点总数（= 占用的体素数）。 */
  std::uint64_t keptTotal = 0;
};

/**
 * 对单实体执行体素滤波。
 * @param entity      实体候选源（多块）
 * @param params      体素边长
 * @param threadCount 并行线程数；0 = 按硬件并发自动（总候选点过少时自动退回单线程）
 * @returns 每块 kept 顶点下标（递增）与总保留数
 *
 * 边界：leafSize <= 0（退化格）→ **全部保留**（与 radius_filter 的 radius<=0 全剔除
 * 有意不同：leaf→0 是"每格 1 点"的连续极限，全保留避免退化输入清空点云，由渲染侧
 * "没有需要剔除的点"守卫给出友好提示）。
 */
EntityResult filterEntity(const EntitySource& entity, const FilterParams& params,
                          unsigned threadCount = 0);

}  // namespace voxel_filter
