#pragma once
/**
 * CSF（布料模拟滤波，Cloth Simulation Filtering）纯 C++ 算法本体。
 *
 * 语义与 CloudCompare 的 qCSF 插件（plugins/core/Standard/qCSF，GPL-2+，见
 * native/csf-lidar/README-REF.md 的出处与许可证说明）保持一致：对每个实体独立
 * 铺一块布料网格，模拟布料在重力下贴合"倒置地形"，再把点按到布料面的
 * 高度差分类为 地面 / 非地面。参考文章：doc/CSF地面识别算法/。
 *
 * 移植时逐条保留 CC 的工程化细节（这些决定结果一致性）：
 * - 坐标模型：网格铺在水平面上，高度轴为"倒置"后的 -z（heightAxis 指示
 *   输入坐标里哪个轴是竖直向上的，默认 2 = z-up，与 LAS 一致）。
 * - 布料网格：AABB 外扩 clothBuffer(=2) 格；粒子初始在倒置最高点上方
 *   clothYHeight(=0.05)；重力 = -gravity*dt^2 一次加足，Verlet 积分带
 *   DAMPING=0.01（Particle::timeStep）。
 * - 高度场光栅化：每点四舍五入归属最近粒子格，格内记录"最近点高度"；
 *   空格用四向扫描线补齐，兜底沿邻接表 BFS（RasterTerrain）。
 * - 约束满足：刚性的实现是"预计算几何级数位移系数表"（SingleMove1 /
 *   DoubleMove1，按 rigidness 索引，>14 封顶），每轮对每粒子沿邻接表
 *   串行单遍修正——等价于 CC 相对论文的多轮松弛优化，必须照抄数值。
 * - 碰撞：粒子高度低于所在格高度场即夹紧并 pin（terrainCollision）。
 * - 收敛早停：每轮最大位移 maxDiff != 0 且 < 0.005 提前跳出（CC 原式，
 *   含"全部 pin 住时 maxDiff==0 会跑满迭代"的原样行为）。
 * - 陡坡后处理（smoothSlope，CC 对话框的 post-processing 复选框）：对
 *   movable 粒子按 4 邻域 BFS 找连通块，块 >100 才处理；把紧邻已 pin 且
 *   地形高差 < smoothThreshold(0.3) 的悬空粒子拉到地面并 pin（find
 *   UnmovablePoint + handle_slop_connected 的 BFS 扩散，heightThreshold
 *   =9999 实际无效，原样保留）。
 * - 分类：点所在格四角粒子高度双线性插值 vs class_threshold
 *   （Cloud2CloudDist，非"到三角网距离"）。
 *
 * 数据模型与半径滤波一致：候选语义（index 子集 / 全量顶点）、逐块输出
 * 顶点下标（递增）。布料覆盖实体全部候选的 XY 范围，与块切分无关。
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 *
 * v1 为忠实串行移植（单线程、double 语义），未做并行化与 SoA 内存优化
 * ——先保证与参考实现可逐点对照，后续再优化。
 */
#include <cstdint>
#include <vector>

namespace csf {

/** 单块候选源：坐标缓冲（显示坐标，已减共享基准点）+ 可选顶点下标列表。 */
struct ChunkSource {
  /** 全量顶点坐标，3 个 float/点（与 three.js position attribute 布局一致）。 */
  const float* positions = nullptr;
  /** positions 中的顶点数。 */
  std::uint32_t vertexCount = 0;
  /**
   * 候选顶点下标列表（递增）。nullptr = 候选为全部顶点（0..vertexCount-1）。
   * 带 index 的分割产物必须传 index：候选 = 其条目指向的顶点，而非全量缓冲。
   * 布料高度场与分类均只覆盖候选点（分割产物上做地面分割时语义自洽）。
   */
  const std::uint32_t* index = nullptr;
  /** index 条目数（index == nullptr 时忽略，候选数 = vertexCount）。 */
  std::uint32_t indexCount = 0;
};

/** 单实体：多块（块边界只是人为切分，布料必须覆盖实体全局 XY 范围）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 分割参数（镜像 CloudCompare qCSF 的 CSF::Parameters 默认值）。 */
struct ClassifyParams {
  /** 布料网格间距（与坐标同单位；须与地形尺度匹配）。 */
  double clothResolution = 1.0;
  /** 布料刚性 1..3（CC 对话框三档）；>14 时按表封顶处理，与 CC 一致。 */
  int rigidness = 2;
  /** 最大迭代次数（默认 500；收敛早停通常先触发）。 */
  int iterations = 500;
  /** 模拟时间步（默认 0.65，平方后乘重力）。 */
  double timeStep = 0.65;
  /** 分类阈值：点到布料模拟地表的高度差小于它判为地面。 */
  double classThreshold = 0.5;
  /** 是否启用陡坡后处理（CC 对话框 "post-processing" 复选框，默认关）。 */
  bool smoothSlope = false;
  /** 输入坐标的竖直向上轴（0/1/2）；默认 2（z-up，LAS 高程）。 */
  std::uint8_t heightAxis = 2;
};

/** 实体级分割结果。 */
struct EntityResult {
  /**
   * 每块地面点顶点下标（递增序，与输入 chunks 对齐）；
   * 非地面 = 候选全集补集（渲染侧按 splitKeptRemoved 同款归并推导）。
   */
  std::vector<std::vector<std::uint32_t>> groundByChunk;
  /** 地面点总数。 */
  std::uint64_t groundTotal = 0;
};

/**
 * 对单实体执行 CSF 地面分割。
 * @param entity 实体候选源（多块，布料覆盖全局 XY 范围）
 * @param params 布料分辨率 / 刚性 / 迭代 / 分类阈值 / 后处理
 * @throws std::runtime_error 布料网格粒子数超过实现上限（见 csf.cc 内
 *   kMaxClothParticles；建议调大 clothResolution 或裁剪区域）
 */
EntityResult classifyEntity(const EntitySource& entity, const ClassifyParams& params);

}  // namespace csf
