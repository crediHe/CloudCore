#pragma once
/**
 * 法向量估计（局部平面 LS / 二次曲面 Quadric）与自动邻域半径（GuessBestRadius）
 * 的纯 C++ 算法本体。
 *
 * 语义对齐 CloudCompare：ccNormalVectors::ComputeCloudNormals（ccNormalVectors.cpp:254）+
 * ccOctree::GuessBestRadius（ccOctree.cpp:781）+ ccNormalCompressor（定点编解码）。
 * 差异（八叉树 → 均匀哈希网格、固定种子 PRNG、无 TRI 模型、无进度回调等）见 README-REF.md。
 *
 * 设计（与 native/radius-filter 同构，便于对照维护）：
 * - 候选语义与渲染侧分割产物一致：每块点云可以是「全量顶点」（index == nullptr），
 *   也可以是「顶点下标子集」（带 index 的分割产物）；邻居搜索覆盖全部候选点（可跨块）。
 * - 邻居搜索用均匀哈希网格：格边长 = 基准半径，查询半径放大时按 ceil(r / 格边长) 扩格数扫。
 *   球查询是精确的（逐点 d² ≤ r² 判定），网格只是取邻居的手段，与 CC 的八叉树无结果差异。
 * - 输出是「每候选一个量化码」的**并行数组**（`codesByChunk[c][k]` 对应第 c 块第 k 个候选），
 *   不是其余模块的「顶点缓冲空间子集」——这是本模块的契约特点，TS 镜像里 scatter 成顶点空间。
 *
 * 本文件不依赖 N-API / node-addon-api，可独立单测与演进。
 */
#include <cstdint>
#include <vector>

namespace normal_estimate {

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

/**
 * 局部模型。镜像 CCCoreLib::LOCAL_MODEL_TYPES 中我们支持的两项：
 * LS = 最小二乘平面（最小特征值特征向量），QUADRIC = 局部二次「高度函数」。
 * CC 的 TRI（邻域三角化）不做。
 */
enum LocalModel : std::uint32_t {
  LS = 0,
  QUADRIC = 1,
};

/**
 * 定向方式。**常量值逐一对齐** ccNormalVectors::Orientation（ccNormalVectors.h:65-81），
 * 渲染侧下拉直接按同一套数字传参。未列出的取值（PREVIOUS / *_SENSOR_ORIGIN）本模块不支持，
 * 传进来按 UNDEFINED 处理（不过定向）——它们分别依赖「上一轮法向量」与「关联传感器」，
 * 二者在我们的数据模型里都不存在。
 */
enum NormOrientation : std::uint32_t {
  PLUS_X = 0,              //!< N.x 恒正
  MINUS_X = 1,             //!< N.x 恒负
  PLUS_Y = 2,              //!< N.y 恒正
  MINUS_Y = 3,             //!< N.y 恒负
  PLUS_Z = 4,              //!< N.z 恒正
  MINUS_Z = 5,             //!< N.z 恒负
  PLUS_BARYCENTER = 6,     //!< 背离实体重心（CC 注释：opposite to the cloud barycenter）
  MINUS_BARYCENTER = 7,    //!< 朝向实体重心
  PLUS_ORIGIN = 8,         //!< 背离坐标原点
  MINUS_ORIGIN = 9,        //!< 朝向坐标原点
  PREVIOUS = 10,           //!< [不支持] 沿用上一轮法向量
  PLUS_SENSOR_ORIGIN = 11,  //!< [不支持] 背离传感器原点
  MINUS_SENSOR_ORIGIN = 12, //!< [不支持] 朝向传感器原点
  UNDEFINED = 255,         //!< 不做定向（法向量符号由拟合过程任意给出）
};

/** 估计参数。 */
struct NormalParams {
  /** 邻域球半径（与坐标同单位；坐标已减基准点，平移不变）。<= 0 = 全部点留空码。 */
  double radius = 0.0;
  /** 局部模型。 */
  LocalModel model = LS;
  /** 定向方式（NormOrientation 取值；UNDEFINED = 不过定向）。 */
  std::uint32_t orientation = UNDEFINED;
};

/** 实体级估计结果。 */
struct EntityResult {
  /** 每块的量化码（与输入 chunks 对齐，长度 = 该块候选数）。 */
  std::vector<std::vector<std::uint16_t>> codesByChunk;
  /** 成功算出法向量的点数（不含空码）。 */
  std::uint64_t computed = 0;
  /** 空码点数（邻域点数始终不足或拟合退化）。computed + nullCount == 候选总数。 */
  std::uint64_t nullCount = 0;
  /**
   * 空码中「半径一路放大到 16 倍仍不足」的点数（nullCount 的子集）。
   * 这个数占大头 ⇒ 半径对该云明显偏小（渲染侧据此写一条可诊断的日志）。
   */
  std::uint64_t capped = 0;
};

/**
 * 对单实体估计法向量。
 * @param entity      实体候选源（多块）
 * @param params      半径 / 局部模型 / 定向方式
 * @param threadCount 并行线程数；0 = 按硬件并发自动（候选点过少时退回单线程）
 * @returns 每块量化码（与 chunks 对齐）+ 统计
 *
 * 逐点独立（邻居搜索只看几何、结果与线程划分无关），因此**同输入必得同输出**。
 */
EntityResult estimateEntity(const EntitySource& entity, const NormalParams& params,
                            unsigned threadCount = 0);

/**
 * 自动半径的固定种子。CC 用 std::random_device 播种（每次结果都不同、不可复现），
 * 我们换成固定种子——同一片云每次得到同一个半径是**刻意**的（可测试、可复现），
 * 不是 bug。取值与 native/ransac-plane 的 kRandomSeed 一致，沿用同一惯例。
 */
constexpr std::uint32_t kRandomSeed = 20260911u;

/** 自动半径参数（默认值 = CC BestRadiusParams{16, 4, 6, 0.97}，见 ccOctree.h）。 */
struct RadiusParams {
  /** PRNG 种子（见 kRandomSeed 说明）。 */
  std::uint32_t seed = kRandomSeed;
  /** 目标邻域点数（球内平均装多少个点）。 */
  std::uint32_t aimedPopulationPerCell = 16;
  /** 命中判据的半宽：|均值 − 目标| < 本值即认为半径合适。 */
  std::uint32_t aimedPopulationRange = 4;
  /** 「人口充足」的样本下限（用于算 aboveMinRatio）。 */
  std::uint32_t minCellPopulation = 6;
  /** 「密度足够均匀」判据：人口 ≥ 下限的样本占比达本值即可收工。 */
  double minAboveMinRatio = 0.97;
};

/** 自动半径结果（统计量只为日志/界面展示，不参与半径推导）。 */
struct RadiusResult {
  /** 推荐半径；实体为空或退化时为 0。 */
  double radius = 0.0;
  /** 实际尝试轮数（CC 上限 10）。 */
  std::uint32_t attempts = 0;
  /** 采样点数（CC = min(200, N/10)）。 */
  std::uint32_t sampledCount = 0;
  /** 最后一轮的邻域人口均值 / 标准差 / 「人口 ≥ 下限」占比。 */
  double meanPopulation = 0.0;
  double stdDevPopulation = 0.0;
  double aboveMinRatio = 0.0;
};

/**
 * 自动估算邻域半径（CC ccOctree::GuessBestRadius 的语义移植）。
 * @param entity      实体候选源（多块；采样在候选全集上均匀取）
 * @param params      目标人口 / 命中半宽 / 密度判据 / 种子
 * @param threadCount 并行线程数；0 = 自动
 * @returns 推荐半径与末轮统计
 *
 * 只对**候选点**统计（与实体其余模块口径一致）；点数 < 100 时 CC 直接返回「朴素半径」
 * （最长包围盒边 / min(100, max(1, N/100))）不再采样，本函数同此。
 */
RadiusResult guessRadius(const EntitySource& entity, const RadiusParams& params,
                         unsigned threadCount = 0);

}  // namespace normal_estimate
