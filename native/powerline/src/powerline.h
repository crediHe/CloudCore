#pragma once
/**
 * 电力线（导线）提取·纯 C++ 算法接口（不含 N-API）。
 *
 * 分两阶段导出，理由见 README-REF.md 的「两阶段分工」一节：
 *
 *  1) extractCandidates —— **重**：离地筛（HAG）+ KD 树 + 逐点 PCA。
 *     产出「池子」（线性度够高的候选）+ **逐池点的特征并行数组**。
 *     特征回传给渲染侧，是为了让「线性度下限 / 最大倾角」这类**精筛阈值**能在渲染侧即时重算
 *     （拖滑杆不必重跑 native；同 euclidean-cluster 的 tolerance vs minPoints 分级先例）。
 *
 *  2) traceLines —— **轻**：局部方向 → 角度门限连通（并行并查集）→ 逐连通片
 *     「方位角投票 → 垂直平面抛物线段 RANSAC 剥离 → 横向切分」→ 端点球面补全 → 编号。
 *     为什么不是「距离 + 角度门限直接聚类」：相邻导线间距 0.3–0.5 m、单根导线沿程缺口 1–3 m，
 *     任何单一距离阈值都不可能同时「分开平行线」和「不切断单根线」。故先大半径连通成片、
 *     再用「导线是竖直平面内的悬链线」这一结构先验把片内的线一根根剥离出来。
 *
 * 入参语义与其余 12 个模块一致：`positions: Float32Array` + 可选 `index: Uint32Array | null`
 * （候选子集，null = 全部顶点），坐标是**显示坐标**（原始 − 全局基准点）。
 * ⚠ 唯一契约差异：**长度 0 的 `index` = 零候选**（其余模块因 `Data()` 给空指针而与
 * 「没有 index」等价 = 全量顶点）。理由见下面 `ChunkSource::hasIndex` 的注释。
 */
#include <cstdint>
#include <string>
#include <vector>

namespace powerline {

/** 单个输入块（裸指针，生命周期由调用方 pin 住）。 */
struct ChunkSource {
  const float* positions = nullptr;
  std::uint32_t vertexCount = 0;
  /**
   * 是否**显式**给了候选子集。⚠ 本模块与其余 12 个模块在这条上**刻意不同**：
   * 那边以"裸指针是否为 null"判有无 index，于是「长度 0 的 index」经 N-API 后
   * （`Data()` 给空指针）与「没有 index」等价，native 按**全量顶点**算候选，
   * 而渲染侧 `candidateCountOfChunk` 算 0 —— 这是个只在特定调用路径下才露头的
   * 静默错位（该语义已在 normal-estimate 模块上实测确认）。
   *
   * 电力线这边非改不可：精筛（线性度/倾角）会把某些块的池子**整个刷空**，
   * 若那时退化成"全量顶点"，整块地面/植被都会被当成导线候选去连线（画面直接崩坏）。
   * 故这里显式区分二者：`hasIndex && indexCount == 0` = 该块**零候选**。
   * 顺带让 native 与渲染侧 `candidateCountOfChunk` 的语义对齐（那边本来就把
   * 长度 0 当 0 个候选）。差异记录在 README-REF.md「与其余模块的契约差异」。
   */
  bool hasIndex = false;
  const std::uint32_t* index = nullptr;  // 仅 hasIndex 时有效
  std::uint32_t indexCount = 0;
};

/** 单个输入实体。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

// ===========================================================================
// 阶段 1：候选提取
// ===========================================================================

/**
 * 地面参考面（规则网格，行主序）。
 *
 * 约定：格 (col, row) 的格心在 `(originX + col * cellSize, originY + row * cellSize)`，
 * 取值 = 该处地面高程（显示坐标 z）；`values[row * cols + col]`。
 * **不得含 NaN**（空洞在渲染侧已填平）——本模块对 NaN 不做特殊处理，采样到 NaN 会让该点
 * 直接落选（`hag >= minHeight` 为假），是「静默丢点」，故由渲染侧的构建函数保证。
 * 镜像：`src/renderer/utils/groundGrid.ts`（采样式必须逐位一致）。
 */
struct GroundGrid {
  const float* values = nullptr;
  int cols = 0;
  int rows = 0;
  double cellSize = 1.0;
  double originX = 0.0;
  double originY = 0.0;
};

struct ExtractParams {
  /** 离地高下限（m）：HAG < 该值的点直接落选。 */
  double minHeight = 4.0;
  /** PCA 邻域半径（m）：须装下导线沿程 5–8 个点。 */
  double radius = 1.0;
};

/** 逐块「池子」：该块入选点的顶点缓冲下标（**升序**，顶点空间）。 */
struct ExtractChunkResult {
  std::vector<std::uint32_t> kept;
};

/**
 * 单实体的候选提取结果。
 *
 * `features.*` 的下标空间 = **池点序（块主序）**，长度 = Σ `chunks[c].kept.length`；
 * 于是渲染侧能把它们逐块摊回顶点空间的 Float32Array（带 index 的块散写、无 index 的块零拷贝）。
 * 块主序 = 与分块方式无关的规范顺序（连续切分下，1/3/7 块得到同一序列）——这是「分块不变性」的前提。
 */
struct ExtractEntityResult {
  std::vector<ExtractChunkResult> chunks;
  std::vector<float> linearity;         // (λ1−λ2)/λ1，λ1 ≥ λ2 ≥ λ3
  std::vector<float> verticality;       // |v1.z|：主方向与水平面的夹角正弦
  std::vector<float> hag;               // 离地高（m）
  std::vector<std::uint32_t> neighborCount;
  std::uint64_t offGroundCount = 0;     // 过 HAG 闸的点数（= 建 KD 树与算 PCA 的规模）
  std::uint64_t poolCount = 0;          // 过宽松闸的点数（= features 长度）
};

struct ExtractResult {
  std::vector<ExtractEntityResult> entities;
};

/**
 * 阶段 1 入口。失败（池子超上限 / 候选数超 uint32 空间）时返回 false 并写 `error`，
 * **不返回半成品**（渲染侧据错误回调提示「请调高最小离地高」，同 LOD 树预算拒绝的先例）。
 *
 * @param threadCount 0 = 硬件并发数；1 = 强制串行（单测钉「结果与线程数无关」用，同 euclidean-cluster）。
 */
bool extractCandidates(const ExtractParams& params, const GroundGrid& grid,
                       const std::vector<EntitySource>& entities, ExtractResult& out, std::string& error,
                       unsigned threadCount = 0);

// ===========================================================================
// 阶段 2：连线
// ===========================================================================

struct TraceParams {
  /** 连通半径（m）：**故意放大**到能粘住平行线/交叉线，由后续抛物线剥离拆开。 */
  double connectRadius = 3.0;
  /** 抛物线残差容差（m）：|z − z_model(s)| ≤ 该值算内点。 */
  double residualTolerance = 0.35;
  /** 一条线的最少点数；不足则整条降级为残点。 */
  std::uint32_t minLinePoints = 20;
  /** 一条线的最短长度（m，两端点三维距离）；城市场景假阳性的主闸门。 */
  double minLineLength = 20.0;
  /** 端点补全的球面搜索半径（m）。 */
  double gapRadius = 10.0;
  /** 端点补全的角度门限（°）：连接向量与两侧切向的夹角上限。 */
  double gapAngleDeg = 12.0;
  /** 局部方向估计的邻域半径（m）；≤ 0 时取 connectRadius。 */
  double dirRadius = 2.0;
};

/** 一条电力线的统计量（渲染侧结果行/属性用）。 */
struct TraceLineInfo {
  std::uint32_t id = 0;             // 1..K，按候选序首遇（块主序）分配
  std::uint32_t pointCount = 0;
  double length = 0.0;              // 两端点三维距离（m）
  double sag = 0.0;                 // 相对弦线的最大下垂（m，恒 ≥ 0）
  double azimuthDeg = 0.0;          // 水平走向方位角 [0, 180)
  double rms = 0.0;                 // 二次模型的最小二乘残差 RMS（m）
  std::uint32_t gapCount = 0;       // 端点补全合并进来的段数
};

struct TraceEntityResult {
  std::vector<std::int32_t> labels;  // **逐候选**（块主序）1..K；0 = 未成线（残点）
  std::vector<TraceLineInfo> lines;
  std::uint64_t candidateTotal = 0;
  std::uint64_t noiseCount = 0;
};

struct TraceResult {
  std::vector<TraceEntityResult> entities;
};

/**
 * 阶段 2 入口。契约破损（候选数超 uint32 空间 / index 越界）时交空 labels（干净失败）。
 * @param threadCount 0 = 硬件并发数；1 = 强制串行（同 extractCandidates）。
 */
void traceLines(const TraceParams& params, const std::vector<EntitySource>& entities, TraceResult& out,
                unsigned threadCount = 0);

}  // namespace powerline
