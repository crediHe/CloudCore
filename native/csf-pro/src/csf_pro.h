#pragma once
/**
 * csf-pro（精准地面分割 CSF，液体贴合语义）纯 C++ 算法本体。
 *
 * 语义逐式复刻项目内老代码 doc/CSF地面识别算法/code/（该代码源自论文实现的
 * 早期移植，布料"湿"而贴身；老应用实际跑的是工具版 csf_native.cc，本实现
 * 的收敛判据与 4b 行并行均取自它）——与 native/csf-lidar（CloudCompare qCSF
 * 机载语义）的差异是布料模型本身，不是参数：
 * - 布料粒子每轮恒受重力下落，碰撞只**抬升**到邻域点云最高倒置点、从不 pin，
 *   因此布料"垂坠贴合"地形曲面，丘陵/山脉斜坡不会像刚性 pin 布料那样被
 *   边缘架起成桥 → 坡面误判率低（代价：收敛慢，需要进度条）。
 * - 支撑面采样 = 每粒子圆形邻域查询（半径 clothResolution×1.5 内全部候选点
 *   的倒置高度最大值）——抗噪、抗空洞，代价是每轮 O(粒子 × 域内点数)。
 * - 内部约束 = 四邻域平均 × rigid（rigid = (rigidness/3)×0.5），边界粒子不参与
 *   但保持被抬升高度；收敛 = 连续 3 轮"碰撞后整轮位移" < max(convergenceEps,
 *   布料分辨率×0.15)，每轮碰撞阶段按行分给硬件线程并行。
 * - 分类 = 布料面双线性插值，|倒置点高 − 布面高| <= classThreshold 判地面。
 *
 * 与 csf-lidar 相同的工程适配：多块实体合并候选、index 子集候选、
 * 全程 double 运算（float 输入升 double 无损），为 JS 逐式镜像（单元测试）
 * 提供位级一致的运算顺序基准。
 *
 * 参考文章：doc/CSF地面识别算法/。
 */

#include <atomic>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <vector>

namespace csfpro {

/** 单块候选源：坐标缓冲（显示坐标）+ 可选顶点下标列表（同 csf-lidar 约定）。 */
struct ChunkSource {
  /** 全量顶点坐标，3 个 float/点。 */
  const float* positions = nullptr;
  /** positions 中的顶点数。 */
  std::uint32_t vertexCount = 0;
  /** 候选顶点下标列表（递增）。nullptr = 候选为全部顶点（0..vertexCount-1）。 */
  const std::uint32_t* index = nullptr;
  /** index 条目数（index == nullptr 时忽略，候选数 = vertexCount）。 */
  std::uint32_t indexCount = 0;
};

/** 单实体：多块（布料必须覆盖实体全局 XY 范围，与块切分无关）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 分割参数（默认值对齐老代码 CSFParams / 老界面默认）。 */
struct ClassifyParams {
  /** 布料网格间距（与坐标同单位；老界面默认 0.6，渲染侧进入模式即用该值）。 */
  double clothResolution = 0.6;
  /** 布料刚性 1..3（老界面默认 2）。 */
  int rigidness = 2;
  /** 最大迭代次数（老代码默认 500；贴地收敛通常先触发）。 */
  int iterations = 500;
  /** 时间步（老代码默认 0.65，重力每轮 = timeStep×0.65，与平方模型不同）。 */
  double timeStep = 0.65;
  /** 分类阈值：点到布料模拟地表的高度差小于它判为地面（老界面默认 0.4）。 */
  double classThreshold = 0.4;
  /** 收敛阈值下限（老代码 convergence_eps = 1e-3；实际生效容差 = max(该值, 布料分辨率×0.15)）。 */
  double convergenceEps = 1e-3;
};

/** 实体级分割结果（与 csf-lidar 同款）。 */
struct EntityResult {
  /** 每块地面点顶点下标（递增序，与输入 chunks 对齐）；非地面 = 候选补集。 */
  std::vector<std::vector<std::uint32_t>> groundByChunk;
  /** 地面点总数。 */
  std::uint64_t groundTotal = 0;
};

/** 布料网格粒子数超上限时抛出的异常提示（引导调大布料分辨率）。 */
class ClothTooLargeError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

/**
 * 对单实体执行老算法液体语义 CSF 地面分割。
 * @param entity 实体候选源（多块，布料覆盖全局 XY 范围）
 * @param params 布料分辨率 / 刚性 / 迭代 / 时间步 / 分类阈值 / 收敛阈值
 * @param cancel 取消标志：Execute 线程每轮迭代检查，置位后抛 std::runtime_error
 *   （消息含"已取消"）提前退出
 * @param onIteration 每轮迭代结束后回调（iteration 从 1 起）；供 addon 层报进度
 * @throws ClothTooLargeError 布料网格粒子数超过 kMaxClothParticles（见 csf_pro.cc）
 * @throws std::runtime_error 取消 / 支撑网格过大
 */
EntityResult classifyEntity(
    const EntitySource& entity, const ClassifyParams& params,
    const std::atomic<bool>& cancel, const std::function<void(int iteration)>& onIteration = {});

}  // namespace csfpro
