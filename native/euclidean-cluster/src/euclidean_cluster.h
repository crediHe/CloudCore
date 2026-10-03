#pragma once
/**
 * 欧式聚类分割（Euclidean Cluster Extraction）纯 C++ 算法本体。
 *
 * 语义对齐 PCL `pcl::EuclideanClusterExtraction`：距离 ≤ 阈值的两点同类（连通分量），
 * 一个簇 = 空间中按阈值连通的一片点。文章参考：doc/点云处理欧式聚类分割/。
 *
 * 与 PCL 的关键差异（判据与实测见 README-REF.md）：
 * - **只输出全部原始连通分量**（labels 1..K），不在算法内做 min/max 簇大小过滤——
 *   过滤放渲染侧。理由：聚类的关键参数是距离阈值，用户改"最小点数"时只想立刻看到
 *   画面变化，而聚类本身要 O(n log n)；分成两半后，改 min/max 只花几毫秒。
 * - **候选语义与其余模块一致**：每块可带 index（顶点下标子集，分割产物），邻居搜索
 *   跨块进行（块边界只是人为切分，不是空间边界）。
 *
 * 设计（两处刻意选择，别改回去）：
 * - **静态 KD 树**（最长轴中点分裂 / 叶 16 点）：半径查询 O(log n + k)。
 *   刻意**不用**半径滤波那套"网格 + 27 邻域"：格边长 = 阈值时，阈值远大于点距
 *   （用户随手就会踩到的输入）会让单格塞进上万点，查询退化成平方级。
 * - **并行并查集**而不是 BFS/DFS 生长：连通分量与生长顺序无关，于是每个候选点的半径
 *   查询彼此独立（可并行），邻居对只做一次 union（只与候选号更大的邻居 union，无序对
 *   恰好处理一次）。父指针 CAS + 路径减半 + **小根优先**（根 = 分量内最小候选号）
 *   ⇒ 结果与线程数无关、完全确定。
 * - **标签编号**按候选序首遇分配（块主序），跨运行、跨线程数都逐位可复现。
 */
#include <cstdint>
#include <vector>

namespace euclidean_cluster {

/** 单块候选源（与其余原生模块同构）。 */
struct ChunkSource {
  const float* positions = nullptr;
  std::uint32_t vertexCount = 0;
  /** 候选子集（顶点下标，顶点缓冲空间）；为 null 表示全量顶点。 */
  const std::uint32_t* index = nullptr;
  std::uint32_t indexCount = 0;
};

struct EntitySource {
  std::vector<ChunkSource> chunks;
};

struct ClusterParams {
  /** 聚类距离阈值（与坐标同单位；**含等号**：距离 == 阈值算同类）。≤ 0 → 无邻居。 */
  double tolerance = 0.0;
};

struct EntityResult {
  /** 逐候选标签（块主序）1..K；K = clusterSizes.size()。无候选时为空。 */
  std::vector<std::int32_t> labels;
  /** 各簇点数（索引 = 标签 - 1）。 */
  std::vector<std::uint32_t> clusterSizes;
};

/**
 * 单个实体的欧式聚类。
 *
 * @param entity      候选源（各块 positions 必须有 ≥ vertexCount 个点；index 若给出必须全部 < vertexCount）
 * @param params      参数（只用 tolerance）
 * @param threadCount 查询阶段线程数；0 = 硬件并发数，1 = 强制串行（单测用它钉"线程无关"）
 *
 * 契约防御：index 越界、候选数 > UINT32_MAX 一律返回空结果（调用方按"长度不符"干净失败），
 * 不读越界内存。
 */
EntityResult clusterEntity(const EntitySource& entity, const ClusterParams& params, unsigned threadCount = 0);

}  // namespace euclidean_cluster
