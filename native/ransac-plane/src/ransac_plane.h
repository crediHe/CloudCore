#pragma once
/**
 * RANSAC 平面拟合（Random Sample Consensus）纯 C++ 算法本体。
 *
 * 语义对齐 PCL `pcl::SACSegmentation<PointXYZ>` 的 `SACMODEL_PLANE` + `SAC_RANSAC`
 * 组合，见 native/ransac-plane/README-REF.md（含与上游的差异清单）。
 * 文章参考：doc/点云处理RANSAC平面拟合/。
 *
 * ## 两段式（本实现与文章/PCL 最实质的差异，也是能跑大点云的原因）
 *
 * 文章与 PCL 的教科书流程是「每轮迭代都对**全部**点算一次点到平面距离」。1 亿点 × 1000 轮
 * 是 10^11 次距离计算，任何实现都扛不住。故本实现拆成两段：
 *
 *   ① 采样集求假设：从候选点里随机取至多 kAutoSampleSize 个点，假设循环只在这个采样集上
 *      计内点。平面由 3 点决定，内点占比在随机子集上是总体比例的无偏估计，故自适应早停
 *      公式依然成立；采样集只做「找模型」，不做「定归属」。
 *   ② 全量判内点：拿到模型后再对**全部**候选点扫一遍，输出逐块内点下标。
 *
 * 于是复杂度从 O(轮数 × N) 降到 O(轮数 × S + N)，且结果质量不受采样影响。
 *
 * ## 流程
 *
 *   采样 → 假设循环（自适应早停）→ 全量 pass1（内点 + 协方差）→ Jacobi 精修
 *        → 全量 pass2（精修平面的内点 + RMS + 平面片画布）→ 取内点更多的一版
 *
 * - **精修**（对齐 PCL `setOptimizeCoefficients(true)`）是内点集上的最小二乘（协方差最小
 *   特征向量）重解。最小二乘不是共识最大化，精修后内点数**可能变少**，故两版都完整算出
 *   （内点 + RMS + 画布），最后取内点更多的一版——确定性比较，不是启发式。
 * - **两次全量扫描**是「有效分割」的关键：若只在采样集上判内点，1 亿点的云最终只会被分出
 *   6.5 万个点。
 *
 * ## 确定性（预览能稳住的基础）
 *
 * - 采样用固定种子 + mulberry32（32 位状态，与 JS `Math.imul` 同构，测试可镜像）。
 * - 假设循环**单线程**顺序执行：最优跟踪是有状态的，并行会改变迭代顺序。
 * - 两次全量扫描按块并行，但每块的输出（内点下标数组）由该块独立产出 ⇒ 块内递增序与
 *   线程数无关；全局浮点归约（协方差 / RMS）在**逐块累加器**上做，最后按块序串行归并
 *   ⇒ 归约顺序也与线程数无关。
 *
 * 因此**同输入同参数的结果逐位可复现**——用户调阈值时画面稳定、只增不减地长出来，而不是
 * 每预览一次跳一个新结果。
 *
 * ## 已知局限（写进 README-REF.md 与 UI 提示，避免被误判为 bug）
 *
 * 均匀采样 RANSAC 找不出占比过低的平面：采样集 65536 点时，占比 0.1% 的平面只落约 65 个
 * 采样点，三点全落在其上的概率可忽略。PCL 同样如此。缓解手段是先框选局部再拟合、或先剥掉
 * 占比大的平面。
 *
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 */
#include <cstdint>
#include <vector>

namespace ransac_plane {

/** 自动采样集规模（0 = 自动时的取值）：约 1e5 轮 × 6.5e4 点 ≈ 0.1–0.2 s 单线程。 */
constexpr std::uint32_t kAutoSampleSize = 65536;
/** 默认置信概率（PCL SACSegmentation 的 probability 默认值）。 */
constexpr double kDefaultConfidence = 0.99;
/** PRNG 固定种子（确定性的一部分；改它等于换一组采样，结果随之变化）。 */
constexpr std::uint32_t kRandomSeed = 20260911u;

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

/** 单实体：多块（块边界只是人为切分，采样与判定都跨块，块划分只影响输出分组）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 拟合参数。 */
struct RansacParams {
  /** 距离阈值：点到平面的绝对距离 ≤ 它判内点（与坐标同单位；负数防御为 0）。 */
  double distanceThreshold = 0.0;
  /** 最大迭代次数；0 = 不迭代（直接判为未找到平面）。 */
  std::uint32_t maxIterations = 1000;
  /** 是否对最优内点集做最小二乘精修（对齐 PCL setOptimizeCoefficients）。 */
  bool optimizeCoefficients = true;
  /** 采样集点数上限；0 = 自动（kAutoSampleSize）。 */
  std::uint32_t sampleSize = 0;
  /** 自适应早停的置信概率（对齐 PCL 的 probability 语义，0.99）。 */
  double confidence = kDefaultConfidence;
};

/** 平面片画布：以 center 为中心、(u,v) 为平面内正交单位基的矩形（显示坐标）。 */
struct PlaneQuad {
  double cx = 0.0;
  double cy = 0.0;
  double cz = 0.0;
  double ux = 1.0;
  double uy = 0.0;
  double uz = 0.0;
  double vx = 0.0;
  double vy = 1.0;
  double vz = 0.0;
  /** 沿 u / v 的半跨度（内点在该基上的实际跨度之半，无外扩）。 */
  double halfU = 0.0;
  double halfV = 0.0;
};

/** 平面模型与拟合质量。 */
struct PlaneModel {
  /** 单位法向 + 平面方程 n·p + d = 0（显示坐标空间）。 */
  double nx = 0.0;
  double ny = 0.0;
  double nz = 1.0;
  double d = 0.0;
  /** 最终内点数（全量候选上的统计，不是采样集上的）。 */
  std::uint64_t inlierCount = 0;
  /** 采样集点数（诊断：判断小平面是否可能被采样漏掉）。 */
  std::uint64_t sampleCount = 0;
  /** 假设循环实际执行的轮数（自适应早停生效时小于 maxIterations）。 */
  std::uint32_t iterationsUsed = 0;
  /** 内点到平面的均方根距离（平面度指标）。 */
  double rms = 0.0;
  /** 内点到平面的最大绝对距离。 */
  double maxDeviation = 0.0;
  /** 平面片画布（内点跨度；内点过少时半跨度为 0，画布尺寸由渲染侧兜底）。 */
  PlaneQuad quad;
};

/** 实体级结果。 */
struct EntityResult {
  /** 是否找到平面；false 时 plane 与 inlierByChunk 均无意义（inlierByChunk 为空块）。 */
  bool found = false;
  PlaneModel plane;
  /** 每块内点顶点下标（递增序，与输入 chunks 对齐）。 */
  std::vector<std::vector<std::uint32_t>> inlierByChunk;
};

/**
 * 对单实体执行 RANSAC 平面拟合并输出内点集合。
 * @param entity      实体候选源（多块）
 * @param params      距离阈值 / 迭代次数 / 精修开关 / 采样上限
 * @param threadCount 两次全量扫描的并行线程数；0 = 按硬件并发自动（候选过少时自动退回单线程）
 * @returns 平面模型 + 每块内点顶点下标（递增）；未找到平面时 found = false
 */
EntityResult fitEntity(const EntitySource& entity, const RansacParams& params,
                       unsigned threadCount = 0);

}  // namespace ransac_plane
