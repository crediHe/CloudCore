#pragma once
/**
 * RANSAC 圆柱拟合（Random Sample Consensus）纯 C++ 算法本体。
 *
 * 语义对齐 PCL `pcl::SACSegmentationFromNormals<PointXYZ, Normal>` 的
 * `SACMODEL_CYLINDER` + `SAC_RANSAC` 组合，见 native/ransac-cylinder/README-REF.md
 * （含与上游的差异清单，其中**轴方向来源**是最实质的一处）。
 * 文章参考：doc/点云处理RANSAC圆柱拟合/。
 *
 * ## 与 PCL 最实质的差异：轴方向从哪来
 *
 * PCL 的圆柱最小样本是「**2 点 + 两点的法线**」：法线垂直于轴 ⇒ 轴方向 = n₁ × n₂，
 * 方向已知后 2 点才能定出圆。本模块**已对齐这个语义**：法线由调用方随每个 chunk 传入
 * （`ChunkSource::normalCodes`，即实体上 `normalCode` 属性的原样视图），不再自己估。
 *
 * 无约束的「5 点定圆柱」在数学上可行，但要解 6 次多项式方程（Beder 2006 /
 * Zsombor-Murray & El Fashny 2006），从零实现风险过高。而 3 点的投影**总能**共圆，
 * 不构成对轴方向的任何约束——于是轴方向这一自由度必须由别处提供。
 *
 * 本实现的选择（对齐文章明确列出的 `Axis` 参数）：
 *
 *   **轴方向是 run 级常量**（显式给定或由法线自动估计），最小样本 = **3 点**。
 *   给定 a 后：3 点投影到 ⊥ a 的平面恰好定一个圆（2×2 线性求解，闭式），
 *   圆 → 半径 + 轴点，假设成立。假设循环内**不再采样方向**，故早停公式
 *   `N = log(1−p)/log(1−w³)` 与 3 点样本严格匹配。
 *
 * 自动估计（`hasAxis = false`）：在**调用方给的法线**上求轴方向。圆柱面任意点的法线都 ⊥ 轴
 * ⇒ 取一致法线的二阶矩 Σnnᵀ 的**最小特征向量**即轴方向（精确，且对叠加的各向同性污染不敏感：
 * 它给所有特征值加同一个常数，不转动特征向量；法线的正负号也无妨，叉积与 nnᵀ 都对符号不敏感）。
 * 实现在 .cc 的「轴方向估计」一节：两两叉积投票（RANSAC，固定种子）粗定方向 →
 * 按 |n·a| 容差收缩一致集、Σnnᵀ 精修两轮。
 *
 * **候选排序用「票数占比 × 一致法线各向异性比」而不是票数**——这是 2026-09 实测后改的，
 * 旧判据 `argmax(票数)` 在「大片平面 + 少量圆柱」的场景里**系统性选错轴**：平面上的法线只有
 * 一个方向，于是**任何与该法线垂直的方向**都免费拿到全部平面法线的票，真轴反而票少。
 * 各向异性比对平面 ≈ 0、对柱面径向法线 ≈ 1（见 .cc 的 kMinAxisScore 注释与实测表），
 * 乘上去即可把「免费票」清零。
 *
 * 被否决的方案（别改回去）：对「投影协方差」用各向异性目标
 * `f(a) = (λ₁−λ₂)²/(λ₁+λ₂)²`。它算得又快又准（对完美圆柱恰为 0，且每个方向 O(1)），
 * 但**目标函数的全局最小值不在真轴上**——轴向方差泄漏进投影面，恰好抵消本征径向
 * 特征值差，伪零点落在真轴前约 4.5°（实测 17° 偏差、20000 点只收到 852 个内点）。
 * 详见 .cc 里那段长注释：任何「投影协方差特征值之差」式的目标都有这个伪零点。
 * 注意这与本节新的各向异性比**不是一回事**：后者作用在**法线二阶矩**上（不是投影坐标），
 * 且只用来**给候选打分**（不构成目标函数、不参与优化），故没有伪零点问题。
 *
 * ## 流程（与 ransac_plane 同构）
 *
 *   轴方向（显式给定或由法线估计）→ 采样 → 假设循环（自适应早停）
 *        → 全量 pass1（内点 + 矩累加量）→ 精修（内点法线重估轴方向 + Kåsa 圆拟合）
 *        → 全量 pass2 → 取内点更多的一版
 *
 * - **精修**（对齐 PCL `setOptimizeCoefficients(true)`）分两步，都以**内点集**为输入：
 *   ① 轴方向重估（同一个法线二阶矩估计器，但只在**已判为内点**的采样点上取法线；
 *      显式给定时**不动**方向——文章把 Axis 当约束）；
 *   ② 给定方向后在投影平面内做 Kåsa 代数圆拟合（闭式 3×3 线性求解）。
 *   最小二乘不是共识最大化，精修后内点数**可能变少**，故两版都完整算出，最后取内点
 *   更多的一版——确定性比较，不是启发式。
 * - **两次全量扫描**是「有效分割」的关键：若只在采样集上判内点，1 亿点的云最终只会被
 *   分出 6.5 万个点。

 *
 * ## 为什么扫描要顺带累加三阶矩
 *
 * 精修的第 ② 步（任意方向下的 Kåsa 圆拟合）需要 x³ / x²y / xy² / y³ 这些**三阶**
 * 累加量。若在扫描时只按当时的 (e₁, e₂) 基累加，轴方向一变基就变，就得**再扫一遍全量**
 * 数据。改为累加**以扫描模型的轴点为原点的二、三阶矩张量**（2 阶 6 个 + 3 阶 10 个独立
 * 分量），则**任意**正交基下的 (Sx, Sy, Sxx, Sxy, Syy, Sxz, Syz) 都能闭式收缩得到，
 * 精修不再需要额外扫描。代价只有「每个**内点**多约 40 flop」。
 *
 * ## 确定性（预览能稳住的基础）
 *
 * - 采样与三点选取都用固定种子 + mulberry32（32 位状态，与 JS `Math.imul` 同构）。
 * - 假设循环**单线程**顺序执行：最优跟踪是有状态的，并行会改变迭代顺序。
 * - 两次全量扫描按块并行，但每块的输出（内点下标数组）由该块独立产出 ⇒ 块内递增序与
 *   线程数无关；全局浮点归约（矩累加量 / RMS / 轴向范围）在**逐块累加器**上做，最后按
 *   块序串行归并 ⇒ 归约顺序也与线程数无关。
 *
 * 因此**同输入同参数的结果逐位可复现**——用户调阈值时画面稳定、只增不减地长出来。
 *
 * ## 已知局限（写进 README-REF.md 与 UI 提示，避免被误判为 bug）
 *
 * - **自动估计依赖「法线里确实有圆柱面」**，且圆柱法线要在采样集里占到能被成对抽中的比例。
 *   投票的最小样本是「两条法线的叉积」，抽中「管壁 × 管壁」的概率 ≈ p²（p = 圆柱法线占比），
 *   故 kMinVoteIterations 以下限的形式给足了预算（见 .cc）；但 p ≲ 5% 仍大概率一次都抽不到
 *   ——这时**判未找到**（得分闸门 kMinAxisScore 拦住噪声候选），而不是给出一个坏方向。
 *   缓解手段：先框选局部、或先剥掉主导平面再拟合。
 * - **传入的法线必须与点云一致**。法线是调用方给的，模块不做任何交叉校验：若实体上的法线
 *   来自另一个坐标系（例如显示坐标与原始坐标混用），轴方向会静默变歪。量化码的精度损失
 *   （level 6 ≈ 0.3–0.5°/轴）可忽略——Σnnᵀ 是平均估计器，误差按 1/√N 收缩。
 * - 均匀采样 RANSAC 找不出占比过低的圆柱（与平面模块同源，PCL 亦然）。
 * - **短粗圆柱（长度 ≲ 直径）不影响轴估计**（法线与长径比无关，这是选法线的主要理由之一）；
 *   但**窄圆弧**（只扫到 ~30° 周长）会给出一致集各向异性比 ≈ 0.02 的弱信号，能过闸门但余量不大。
 * - 显式轴（`hasAxis = true`）时本模块不校验轴方向是否合理：平面在给定轴下**总能**被拟合成
 *   一个超大半径的圆柱，只有 `maxRadius` 能挡——渲染侧默认不限半径，用户需自行约束。
 *
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 */
#include <cstdint>
#include <vector>

namespace ransac_cylinder {

/** 自动采样集规模（0 = 自动时的取值）：约 1e5 轮 × 6.5e4 点 ≈ 0.1–0.2 s 单线程。 */
constexpr std::uint32_t kAutoSampleSize = 65536;
/** 默认置信概率（PCL SACSegmentation 的 probability 默认值）。 */
constexpr double kDefaultConfidence = 0.99;
/** PRNG 固定种子（确定性的一部分；改它等于换一组采样，结果随之变化）。 */
constexpr std::uint32_t kRandomSeed = 20260912u;

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
  /**
   * 法向量量化码（**顶点缓冲空间**，长度 = vertexCount，与渲染侧 `normalCode` 属性同布局；
   * 2 字节/点，编解码规则见 normal_compressor.h）。候选点的法线 = normalCodes[index[k]]，
   * 无 index 时 = normalCodes[k]。NULL 码（32768）= 该点无法线。
   *
   * nullptr = 这个块**没有法线**。`hasAxis = false`（自动估计）时要求**每个块**都非空，
   * 否则 fitEntity 直接返回未找到（addon 侧已提前抛 TypeError，这里是纵深防御）；
   * `hasAxis = true` 时不读它，可以整个省掉（显式轴模式下法线零开销）。
   */
  const std::uint16_t* normalCodes = nullptr;
};

/** 单实体：多块（块边界只是人为切分，采样与判定都跨块，块划分只影响输出分组）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 拟合参数。 */
struct RansacParams {
  /** 距离阈值：点到圆柱面的绝对距离 ≤ 它判内点（与坐标同单位；负数防御为 0）。 */
  double distanceThreshold = 0.0;
  /** 最大迭代次数；0 = 不迭代（直接判为未找到圆柱）。 */
  std::uint32_t maxIterations = 1000;
  /**
   * 是否对最优内点集做精修（对齐 PCL setOptimizeCoefficients）：
   * 轴方向重估（自动模式）+ Kåsa 圆拟合。
   */
  bool optimizeCoefficients = true;
  /** 采样集点数上限；0 = 自动（kAutoSampleSize）。 */
  std::uint32_t sampleSize = 0;
  /** 自适应早停的置信概率（对齐 PCL 的 probability 语义，0.99）。 */
  double confidence = kDefaultConfidence;
  /**
   * 半径下限 / 上限（对齐 PCL setRadiusLimits 与文章的 RadiusLimits）。
   * ≤ 0 = 该侧不限制；两者都 ≤ 0 = 完全不限。假设的半径越界即整轮丢弃——
   * 文章明确「强噪声场景必须优先设置半径约束，否则极易拟合出虚假圆柱」。
   */
  double minRadius = 0.0;
  double maxRadius = 0.0;
  /**
   * 轴方向约束（对齐 PCL setAxis 与文章的 Axis）：false = 由法线自动估计（此时每个
   * ChunkSource 都必须带 normalCodes），true = 用下面的向量。
   * 方向是**约束而非初值**——显式给定时精修不会改动它（文章语义）；想要「以给定方向为
   * 初值再优化」请用自动模式。不必归一化，C++ 侧会归一化并统一符号。
   */
  bool hasAxis = false;
  double axisX = 0.0;
  double axisY = 0.0;
  double axisZ = 1.0;
};

/** 圆柱模型与拟合质量。 */
struct CylinderModel {
  /** 圆柱几何中心 = 内点轴向范围的中点（在轴上，显示坐标空间）。 */
  double cx = 0.0;
  double cy = 0.0;
  double cz = 0.0;
  /** 单位轴方向（显示坐标空间；符号约定见 .cc 的 orientAxis）。 */
  double ax = 0.0;
  double ay = 0.0;
  double az = 1.0;
  /** 半径（> 0）。 */
  double radius = 0.0;
  /** 内点在轴向上的跨距之半（画圆柱长度用；内点过少时为 0，渲染侧兜底）。 */
  double halfHeight = 0.0;
  /** 最终内点数（全量候选上的统计，不是采样集上的）。 */
  std::uint64_t inlierCount = 0;
  /** 采样集点数（诊断：判断小圆柱是否可能被采样漏掉）。 */
  std::uint64_t sampleCount = 0;
  /** 假设循环实际执行的轮数（自适应早停生效时小于 maxIterations）。 */
  std::uint32_t iterationsUsed = 0;
  /** 内点到圆柱面的均方根距离（圆柱度指标）。 */
  double rms = 0.0;
  /** 内点到圆柱面的最大绝对距离。 */
  double maxDeviation = 0.0;
  /** 轴方向是否来自自动估计（false = 用了请求里的显式方向，供渲染侧显示与诊断）。 */
  bool axisEstimated = false;
  /**
   * 胜出候选的得票得分 = 票数占比 × 一致法线各向异性比 ∈ [0, 1]（见 .cc 的
   * kMinAxisScore 注释）。显式轴时无意义，恒 0。**这是轴路径唯一的可见指标**：
   * 偏低（接近 0.02 的闸门）说明法线里几乎没有圆柱面，结果不可信，渲染侧据此提示。
   */
  double axisScore = 0.0;
};

/** 实体级结果。 */
struct EntityResult {
  /** 是否找到圆柱；false 时 cylinder 与 inlierByChunk 均无意义（inlierByChunk 为空块）。 */
  bool found = false;
  CylinderModel cylinder;
  /** 每块内点顶点下标（递增序，与输入 chunks 对齐）。 */
  std::vector<std::vector<std::uint32_t>> inlierByChunk;
};

/**
 * 对单实体执行 RANSAC 圆柱拟合并输出内点集合。
 * @param entity      实体候选源（多块）
 * @param params      距离阈值 / 迭代次数 / 精修开关 / 采样上限 / 半径约束 / 轴方向
 * @param threadCount 两次全量扫描的并行线程数；0 = 按硬件并发自动（候选过少时自动退回单线程）
 * @returns 圆柱模型 + 每块内点顶点下标（递增）；未找到圆柱时 found = false
 */
EntityResult fitEntity(const EntitySource& entity, const RansacParams& params,
                       unsigned threadCount = 0);

}  // namespace ransac_cylinder
