/**
 * 点云「另存为」的共享契约（主进程 / preload / 渲染进程共用）。
 *
 * 与 native 模块那套「契约镜像」不同：这里两端都是 TypeScript，故**同一份类型**
 * 双方直接 import，不需要两边各维护一份。
 *
 * 写入流程刻意做成**分块流式**（begin → chunk × N → end），与读侧
 * （get-file-info → read-chunk × N）严格对称：一次 IPC 只搬一批点，
 * 1 亿点也不会出现单条消息几 GB 的峰值。
 */

/** 支持的输出格式（LAZ 压缩需引 LASzip / laz-perf，不在范围内）。 */
export type SaveFormat = 'ply' | 'las'

/** 三维向量（double 精度语义）。 */
export interface SaveVec3 {
  x: number
  y: number
  z: number
}

/** 原始坐标（未减全局基准点）包围盒。 */
export interface SaveBBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/**
 * LAS 1.2 分类字段的可表示上限。
 *
 * 格式 0-5 的分类只有低 5 位（高 3 位是 synthetic / keypoint / withheld 标记），
 * 读侧同样按 `& 0x1f` 掩码还原（见 renderer/stores/pointcloudStore.ts 的 parseLasChunk）。
 * 实体含 >31 的分类时写 LAS 会**静默丢高位**，故写侧直接拒绝并建议改用 PLY
 * （PLY 的分类是完整 uchar，无损）。
 */
export const LAS_12_MAX_CLASSIFICATION = 31

/** 保存会话启动参数（渲染侧 → 主进程）。 */
export interface SaveBeginRequest {
  /** 目标文件绝对路径（系统保存对话框返回）。 */
  path: string
  format: SaveFormat
  /** 待写入总点数：渲染侧 O(块数) 即可算出，故头部一次写对，无需收尾回填。 */
  pointCount: number
  /** 全局共享基准点：**原始坐标 = 显示坐标 + 它**（见 pointcloudStore 的 basePoint）。 */
  basePoint: SaveVec3
  /** 原始坐标包围盒（LAS 的 scale / offset 规划用；精确包围盒在收尾时回填）。 */
  bbox: SaveBBox
  /** 实体是否带颜色：LAS 据此选点格式（有 → 3，无 → 0）。 */
  hasColor: boolean
}

/** 保存会话启动结果。 */
export interface SaveBeginResult {
  /** 会话 id：后续 chunk / end / abort 都要带上，过期会话的包会被拒绝。 */
  sessionId: string
}

/**
 * 一批点（渲染侧 → 主进程）。
 *
 * `positions` 是**显示坐标**（已减基准点）：主进程写盘时加回 basePoint 再编码
 * （PLY 写 double、LAS 写 int32×scale+offset），这一步是"大文件不糊"的关键。
 * `colors` 是**已转好 sRGB 的 8 位字节**（渲染侧转，省 3/4 的 IPC 载荷）。
 * 三个可空字段为 null 表示该实体没有这个属性，主进程按 0（颜色按中性灰）写。
 */
export interface SaveChunkRequest {
  sessionId: string
  /** 本批点数（= positions.length / 3）。 */
  pointCount: number
  positions: Float32Array
  /** sRGB 编码的 8 位颜色（长度 = 3 × pointCount）。 */
  colors: Uint8Array | null
  /** 分类（长度 = pointCount）。 */
  classification: Uint8Array | null
  /** 树 ID（长度 = pointCount；LAS 写入 Point Source ID 字段）。 */
  treeIds: Uint16Array | null
}

/** 保存收尾请求。 */
export interface SaveEndRequest {
  sessionId: string
}

/** 保存收尾结果。 */
export interface SaveEndResult {
  path: string
  /** 实际写入点数。 */
  points: number
  /** 文件总字节数。 */
  bytes: number
}

/** 放弃保存（用户取消或中途失败）：关闭句柄并删除半成品文件。 */
export interface SaveAbortRequest {
  sessionId: string
}
