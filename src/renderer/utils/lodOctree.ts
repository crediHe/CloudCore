/**
 * LOD 八叉树的渲染侧契约镜像 + 树导航纯函数。
 *
 * C++ 算法本体见 native/lod-octree/src/lod_octree.h / .cc；N-API 绑定壳的请求/响应
 * 契约见 native/lod-octree/src/addon.cc 顶部注释。**任何入参/出参语义改动必须两处
 * 同步**（沿用其余 6 个 util 的约定）。
 *
 * 定位：与其余 6 个「算法模态」模块不同，本模块服务的是**渲染**——为「每帧只画固定
 * 预算的点」（对标 CloudCompare 的 1<<19 点/帧上限）提供支持球-视锥剔除与由粗到密
 * 渐进加密的实体级八叉树。不产生新实体、不改语义层，只被 three 层消费。
 *
 * 核心语义（与 C++ 一致）：
 * - **一个实体一棵树**（跨该实体全部 chunk），不是每块一棵：实体的可见点集本就跨块
 *   （框选/滤波产物的 index 各自按块给），实体级树才能做实体级预算分配。
 * - **点索引是打包 id**：`id = (chunk << vertexShift) | vertexIndex`，其中
 *   `vertexIndex` 是**顶点缓冲下标**（带 index 的分割产物在建树期已解引用）。
 *   读一个 Uint32 就同时拿到「读哪个块的缓冲」与「读哪一行」，无需块边界表、
 *   无需再解一次 index。
 * - 节点表按**层序**排列且子节点连续：`nodeChildMask` 的 bit k（k = 卦限位，
 *   bit0=x, bit1=y, bit2=z，与 CCCoreLib::DgmOctree 的 cell code 低 3 位同序）
 *   对应 `nodeChildBase + popcount(mask & ((1<<k)-1))`。mask = 0 即叶子。
 * - 任一节点占据 `pointIds` 上一段连续区间 `[nodePointStart, +nodePointCount)`，
 *   父区间恰好被子节点划分（互不重叠、并集等于父区间）。
 * - **叶子的区间是块主序的**（每块最多一段），gather 因此可按段切源缓冲——段内只
 *   随机读单块坐标缓冲（缓存友好）。内部节点的区间不保证块主序，不要直接取点。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组）。 */
export interface LodOctreeChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（顶点缓冲空间）。null = 候选为全量顶点（0..vertexCount-1）。 */
  index: Uint32Array | null
}

/** 单实体建树源（该实体全部 chunk）。 */
export interface LodOctreeEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: LodOctreeChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface LodOctreeRequest {
  entities: LodOctreeEntitySource[]
  /** 细分阈值：节点点数 > 该值才继续分。默认 256（对齐 ccPointCloudLOD 的 maxCountPerCell）。 */
  maxPointsPerCell?: number
  /** 深度上限：共点（重复坐标）无法再分时的硬保险，默认 12，硬上限 24。 */
  maxLevel?: number
}

/** 进度（AsyncProgressWorker 按层回报，中间值可能被 uv_async 合并）。 */
export interface LodOctreeProgress {
  /** 整体进度 0..1。 */
  overall: number
  /** 当前实体序（1 起）。 */
  entity: number
  entityTotal: number
  /** 刚完成的层号（0 起）。 */
  level: number
}

/** 单实体建树结果（与 addon.cc 的 OnOK 字段一一对应）。 */
export interface LodOctreeEntityResult {
  entityId: number
  /** 节点数（= 各节点数组长度）；**0 表示该实体没有可建树的点**（渲染侧跳过 LOD）。 */
  nodeCount: number
  /** 树内点数（= pointIds.length）。可能小于候选总数：非有限坐标与越界 index 条目已剔除。 */
  pointCount: number
  /** 打包 id 的 chunk 字段位宽（1..16）：chunk = id >>> vertexShift。 */
  chunkBits: number
  /** vertexShift = 32 - chunkBits：vertexIndex = id & ((1 << vertexShift) - 1)。 */
  vertexShift: number
  /** 实体包围盒（显示坐标）：minX,minY,minZ,maxX,maxY,maxZ。 */
  bounds: Float32Array
  /** 以下节点表等长（= nodeCount）。 */
  nodeChildBase: Uint32Array
  nodeChildMask: Uint8Array
  nodePointStart: Uint32Array
  nodePointCount: Uint32Array
  /** 3×nodeCount，节点立方体几何中心（视锥剔除用）。 */
  nodeCenter: Float32Array
  /** 节点立方体边长。 */
  nodeSize: Float32Array
  nodeLevel: Uint8Array
  /** 打包 id（顶点缓冲空间），块主序 + 子树连续。 */
  pointIds: Uint32Array
}

/** native 模块导出契约（lod_octree.node）。 */
export interface LodOctreeAddon {
  compute: (
    request: LodOctreeRequest,
    onProgress: (progress: LodOctreeProgress) => void,
    callback: (err: Error | null, results?: LodOctreeEntityResult[]) => void
  ) => void
  /** 取消当前活跃建树（幂等；被新 compute 顶替时也走错误回调）。 */
  cancel: () => void
}

/** 默认参数（与 C++ BuildParams 的默认值一致，渲染侧显式传参时用）。 */
export const LOD_OCTREE_DEFAULTS = { maxPointsPerCell: 256, maxLevel: 12 } as const

/** 卦限位（与 C++ OctantOf 同序）：bit0 = x ≥ 中心，bit1 = y，bit2 = z。 */
export const LOD_OCTANTS = 8

/**
 * 打包位宽：块数决定 chunk 字段位数（与 C++ `PackedCodec::ForChunks` **同一公式**，
 * 单块也留 1 位以免出现 shift == 32）。
 *
 * 用途：显示层在**还没拿到八叉树**时（建树中）也要填 staging 并支持拾取反查，
 * 那条回退路径得自己编码打包 id。两处公式必须一致——否则回退期填进槽位的 id
 * 与树就绪后填的 id 编码不同，`LodDisplay.bufferShift` 也就失去意义。
 */
export function lodChunkBitsFor(chunkCount: number): number {
  let maxChunk = chunkCount > 0 ? chunkCount - 1 : 0
  let bits = 0
  while (maxChunk !== 0) {
    bits++
    maxChunk >>>= 1
  }
  return bits === 0 ? 1 : bits
}

/** 打包 id：`(chunk << vertexShift) | vertexIndex`（与 C++ `PackedCodec::pack` 同式）。 */
export function lodPackId(chunk: number, vertexIndex: number, vertexShift: number): number {
  return ((chunk << vertexShift) | vertexIndex) >>> 0
}

/** 打包 id → 块号（读哪个 chunk 的坐标缓冲）。 */
export function lodDecodeChunk(id: number, vertexShift: number): number {
  return id >>> vertexShift
}

/** 打包 id → 顶点缓冲下标（读该块坐标缓冲的哪一行）。 */
export function lodDecodeVertex(id: number, vertexShift: number): number {
  return id & ((1 << vertexShift) - 1)
}

/** 节点是否叶子（无子节点）。 */
export function lodIsLeaf(result: LodOctreeEntityResult, node: number): boolean {
  return result.nodeChildMask[node] === 0
}

/**
 * 取节点在指定卦限的子节点下标；不存在返回 -1。
 * 子节点按卦限升序紧密排列，故下标 = 基址 + 该 bit 之前置位数（popcount）。
 */
export function lodChildNode(result: LodOctreeEntityResult, node: number, octant: number): number {
  const mask = result.nodeChildMask[node]
  const bit = 1 << octant
  if ((mask & bit) === 0) return -1
  let rank = 0
  for (let k = 0; k < octant; k++) {
    if (mask & (1 << k)) rank++
  }
  return result.nodeChildBase[node] + rank
}

/**
 * 节点立方体是否与球-视锥测试的保守包围球相交（供遍历剔除用）。
 * 取外接球：半径 = 边长 × √3/2；中心是立方体几何中心。
 */
export function lodNodeBoundingRadius(nodeSize: number): number {
  return nodeSize * 0.8660254037844386 // √3 / 2
}
