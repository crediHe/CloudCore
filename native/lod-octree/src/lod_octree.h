#pragma once
/**
 * LOD 八叉树构建（纯 C++ 算法本体，不依赖 N-API，可独立演进与单测）。
 *
 * 目标（对标 CloudCompare `libs/qCC_db/src/ccPointCloudLOD.cpp`）：为渲染侧
 * 「每帧只画固定预算的点」提供一棵支持**球-视锥剔除**与**由粗到密渐进加密**的
 * 实体级八叉树。CC 每帧硬上限 1<<19 点（`ccPointCloud.cpp:2799`
 * MAX_POINT_COUNT_PER_LOD_RENDER_PASS），靠八叉树挑选该画哪些点，整云从不常驻显存；
 * 本模块负责那套机制里"树"的部分，遍历与 gather 在渲染侧（阶段 3）。
 *
 * == 与 CC 的对应关系 ==
 *
 * 对齐的部分（阶段 3 的遍历逻辑直接照搬 CC 的两轮配额）：
 *  - 扁平节点表 + 唯一索引数组 `pointIds` + **每节点** `displayedPointCount`
 *    的渐进加密模型（CC `ccPointCloudLOD.cpp:683 addNPointsToIndexMap`）；
 *  - 父节点的索引区间恰好被子节点划分（区间不重叠、并集等于父区间），
 *    与 CC 的 `Node::firstCodeIndex` 同构——这是"整子树跳过"与"游程取点"的前提；
 *  - 子节点按卦限位寻址（bit0=x, bit1=y, bit2=z，与 CCCoreLib::DgmOctree
 *    的 cell code 低 3 位同序），位掩码 + 基址即可定位；
 *  - 节点携带几何中心与尺度，供视锥剔除。
 *
 * **刻意不同的部分**（每条都在此写明理由，改之前先读 CC 对应实现）：
 *  - 差异 1（树的粒度）：**一个实体一棵树**（跨该实体全部 chunk），不是每块一棵。
 *    实体的可见点集本来就跨块（框选/滤波产物各自按块给 index），实体级树才能做
 *    实体级的预算分配——否则预算要在几百棵树之间二次分配，节点级剔除也无法跨块
 *    合并，颗粒度反而更粗。
 *  - 差异 2（剔除体）：CC 的 `Node::center` 是**节点内点的质心**、`radius` 是到质心的
 *    最大距离（贴合但要多扫一遍点，总代价 O(点数×深度)）；本模块给的是**节点立方体**
 *    的几何中心与边长（O(1) 从父节点折半推出）。代价是球-视锥测试偏保守（边缘会多画
 *    一点），换来建树成本与内存的确定性——1 亿点量级下这笔账更划算。
 *  - 差异 3（不做 CC 的第二遍细分）：CC 先按阈值细分、再挑"最宽层"把 >16 点的浅叶子
 *    再切一刀（`ccPointCloudLOD.cpp:287-346`），目的是让各层叶子大小均匀。本模块
 *    自顶向下按卦限**稳定划分**（不显式算 Morton 码），叶子大小天然由阈值决定；
 *    渲染侧按"剩余点数占比"逐层分配预算、不依赖层内叶子均匀，故省去第二遍。
 *  - 差异 4（索引空间）：CC 的 `firstCodeIndex` 指向 `pointsAndTheirCellCodes`
 *    （8 B/点的常驻表，内含坐标副本的索引）。本模块把 `pointIds` 直接钉在
 *    **原始顶点缓冲空间**（打包 (chunk, vertexIndex)，见下），不额外持有任何
 *    常驻表，也与其他 6 个原生模块"返回值一律是顶点缓冲空间下标"的约定一致。
 *
 * == 数据布局 ==
 *
 * 节点表按**层序（BFS）**排布：同层节点在数组中连续，且任一节点的子节点也连续
 * （处理某一层时，按节点下标顺序逐个把子节点追加到数组末尾）。于是给定
 * `nodeChildBase` + `nodeChildMask` 就能定位子节点：
 * 第 m 个置位的 bit 对应 `nodeChildBase + popcount(mask & ((1<<m)-1))`。
 * 子节点按卦限位**升序**排列（稳定划分的副产物：先扫位 0 的桶）。
 *
 * `pointIds` 是唯一的点索引数组：节点 n 的点占据
 * `[nodePointStart[n], nodePointStart[n] + nodePointCount[n])` 一段**连续区间**，
 * 父区间恰好被子节点划分（互不重叠、并集等于父区间）。根的区间 = 全部候选点。
 *
 * 元素是**打包 id**：`(chunkIndex << vertexShift) | vertexIndex`，其中
 * `vertexIndex` 是**顶点缓冲下标**（带 index 的分割产物在构建期已解引用）。
 * 打包位宽由块数决定（`chunkBits` / `vertexShift` 随结果返回），所以渲染侧读一个
 * Uint32 就同时拿到"读哪个块的缓冲"和"读哪一行"——不需要二分块边界表，
 * 也不需要再解一次 index，少一整套下标空间（见方案风险 1）。
 *
 * == 叶子的"块主序"不变量（gather 快慢的关键）==
 *
 * `pointIds` 的初始序是候选自然序（= 块主序：秩按块递增）。各层划分都是**稳定**
 * 划分，于是有归纳：
 *
 *   若节点 P 的区间是块主序的（每块的点连续成一段），则按卦限稳定划分后的每个
 *   子区间也是块主序的——因为桶内顺序 = "P 区间里各块的先后" 去掉不属于本桶的点，
 *   即 `[块0∩桶][块1∩桶][块2∩桶]…`。根区间天然块主序，归纳成立。
 *
 * 注意结论只对**子区间（= 后续还要被划分的节点）**成立：P 自己被划分后，它的区间
 * 变成 `[桶0][桶1]…`，块号在桶之间重复，故**内部节点的区间不保证块主序**。
 * 而叶子永不被划分，所以：
 *
 *   **任一叶子的区间都是块主序的，每块在其中最多出现一段，段数 ≤ 该叶覆盖的块数。**
 *
 * 渲染侧 gather 因此可以按段切源缓冲：段内顺序读 `pointIds` + 在**单块**坐标缓冲内
 * 随机读（500K 点/块 ≈ 6 MB，落 L3），而不是每点切一次块（跨块乱跳时每点一次
 * cache miss，1 亿点量级直接毁掉帧率）。实例化时段的切换总次数 ≈ 叶子数 × 覆盖块数。
 * 代价是**不能**用"块号单调递增的光标"扫一遍了事（段边界处块号会回退），
 * 每点仍需一次 `id >>> vertexShift` 解出块号做比较。
 *
 * == 剔除 vs 密度 ==
 *
 * 渲染侧拿到 `nodeChildMask == 0` 的节点即为叶子，其区间就是"可取的点池"；
 * 内部节点的区间仅供"整子树跳过/整子树命中"判断，不要直接取点（会与子节点重复）。
 * 叶子点数上限是 `maxPointsPerCell`，但**不保证**达到——共点（重复坐标）或
 * 节点数触顶时叶子会更大，渲染侧按占比分配即可。
 */
#include <atomic>
#include <cstdint>
#include <functional>
#include <vector>

namespace lod_octree {

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

/** 单实体：多块（块边界只是人为切分，树必须建在实体全局）。 */
struct EntitySource {
  std::vector<ChunkSource> chunks;
};

/** 建树参数。 */
struct BuildParams {
  /** 细分阈值：节点点数 > 该值才继续分（默认 256，对齐 ccPointCloudLOD 的 maxCountPerCell）。 */
  std::uint32_t maxPointsPerCell = 256;
  /** 深度上限（默认 12）：重复坐标无法再分时的硬保险，防节点表爆炸。 */
  std::uint32_t maxLevel = 12;
};

/** 单实体建树结果（全部为顶点缓冲空间的打包 id，语义见文件头）。 */
struct EntityResult {
  std::int32_t entityId = 0;
  /** 节点数（= 各数组长度）；0 表示该实体没有可建树的候选点。 */
  std::uint32_t nodeCount = 0;
  /** 树内的点数（= pointIds 长度）。**可能小于候选总数**：非有限坐标与被丢弃的越界 index 条目已剔除。 */
  std::uint32_t pointCount = 0;
  /** 打包 id 的 chunk 字段位宽（1..16）：chunk = id >> vertexShift。 */
  std::uint8_t chunkBits = 0;
  /** vertexShift = 32 - chunkBits：vertexIndex = id & ((1u<<vertexShift)-1)。 */
  std::uint8_t vertexShift = 0;
  /** 实体包围盒（显示坐标）：minX,minY,minZ,maxX,maxY,maxZ；无点时全 0。 */
  float bounds[6] = {0, 0, 0, 0, 0, 0};

  // ---- 节点表（长度均 = nodeCount，按层序排列，子节点连续）----
  std::vector<std::uint32_t> nodeChildBase;  // 首个子节点在节点表中的下标
  std::vector<std::uint8_t> nodeChildMask;   // bit k = 第 k 个卦限有子节点；0 = 叶子
  std::vector<std::uint32_t> nodePointStart; // pointIds 中的起始下标
  std::vector<std::uint32_t> nodePointCount; // 本节点（子树）的点数 = 子节点区间之和
  std::vector<float> nodeCenter;             // 3×nodeCount，节点立方体几何中心
  std::vector<float> nodeSize;               // 节点立方体边长（视锥剔除用）
  std::vector<std::uint8_t> nodeLevel;       // 层号（根 = 0）

  /** 唯一索引数组：元素是打包 id（见文件头"数据布局"）。 */
  std::vector<std::uint32_t> pointIds;
};

/**
 * 进度回调（算法层，参数是**本实体**的进度）。
 * @param localProgress 0..1
 * @param level         刚完成的层号（0 起）
 */
using ProgressFn = std::function<void(double localProgress, std::uint32_t level)>;

/** 取消标志（算法每层、每 2^20 点查询一次；置位后抛 std::runtime_error）。 */
using CancelFlag = std::atomic<bool>;

/**
 * 对单实体建 LOD 八叉树。
 *
 * @throws std::range_error    打包位宽装不下某块顶点数（块数过多或单块过大）
 * @throws std::runtime_error  被取消（cancelled 置位）
 * @throws std::bad_alloc      内存不足
 */
EntityResult buildEntity(const EntitySource& entity, std::int32_t entityId, const BuildParams& params,
                         const CancelFlag& cancelled, const ProgressFn& onProgress);

}  // namespace lod_octree
