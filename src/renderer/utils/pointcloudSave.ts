/**
 * 点云「另存为」的渲染侧纯函数：把分块几何体摊成"一批可写盘的点"。
 *
 * 分工：**渲染侧只做"取哪些点 + 颜色转码"**，文件格式（头部 / 坐标编码）全在主进程
 * （src/main/core/plyWriter.ts、lasWriter.ts）。两侧共用
 * shared/types/pointcloud-save.ts 的同一份类型，不需要契约镜像。
 *
 * 三件必须记牢的事：
 * 1. 坐标是**显示坐标**（原始 − 全局基准点），主进程写盘时加回基准点。这里不做。
 * 2. 可见子集由 `index` 决定 —— 分割 / 滤波 / 配准产物与源实体**共享同一份顶点缓冲**，
 *    直接按 positions 全量取会把整片源点云写出去。
 * 3. 颜色有**两种内存形态**（见 SaveChunkSource.colors），都要转成 sRGB 字节再进文件。
 */

import { linearToSrgbU8, linearU8ToSrgbU8 } from './srgb'

/** 一块几何体的可保存数据（全是零拷贝视图，调用方不得改写）。 */
export interface SaveChunkSource {
  /** 显示坐标（顶点缓冲空间；长度 = 顶点数 × 3）。 */
  positions: Float32Array
  /** 可见子集下标（顶点缓冲空间；null = 全部顶点）。 */
  index: Uint32Array | null
  /**
   * 颜色 attribute 的底层数组，两种形态：
   * - `Float32Array`：加载来的原始色（**线性**空间 0-1）；
   * - `Uint8Array`：分割产物纯色 / 预览色（**线性**空间字节，attribute normalized = true）。
   * null = 该实体无颜色（导出侧按中性灰占位）。
   */
  colors: Float32Array | Uint8Array | null
  /** 分类（长度 = 顶点数）。null = 该实体无分类属性（导出写 0）。 */
  classification: Uint8Array | null
  /** 树 ID（长度 = 顶点数）。null = 无（导出写 0）。 */
  treeIds: Uint16Array | null
  /**
   * 树 ID **覆盖值**：非 null 时该批每点都写这个值，忽略 `treeIds`。
   *
   * 用途是"另存为一个物体"时把实体的**编号**（`SceneEntity.labelNo`）写进每点 treeid，
   * 让"哪棵树"随文件走（CC 里能按 Point Source ID 分色，本仓库读回来也认得出）。
   * 为什么是覆盖而不是原地改写属性：分割产物与母云**共享同一份顶点缓冲**，写属性会
   * 污染兄弟实体（与配准烘焙要写时复制同一个道理）；覆盖只是逐批的临时数组，
   * 零常驻内存（见 pointcloudStore.getSaveBatch）。
   */
  treeIdOverride?: number | null
}

/** 一批待写盘的点（坐标是显示坐标；颜色已是 sRGB 字节）。 */
export interface SaveBatch {
  pointCount: number
  /** 显示坐标。可能是源数组本身或其子视图（整块快路径，零拷贝），**不可改写**。 */
  positions: Float32Array
  /** sRGB 颜色的 8 位字节（长度 = 3 × pointCount）；源无颜色时为 null。 */
  colors: Uint8Array | null
  classification: Uint8Array | null
  treeIds: Uint16Array | null
}

/**
 * 某块几何体的**可见点数**：有 index 时 = index 条目数，无 index 时 = 顶点数。
 *
 * 与渲染侧 geometryVisibleIndex 同一语义（分割 / 滤波产物的可见子集由 index 圈定）。
 */
export function visibleCountOf(index: Uint32Array | null, vertexCount: number): number {
  return index ? index.length : vertexCount
}

/**
 * 一串分类字节里的最大值（无分类属性时传 null → 0）。
 *
 * 用于 LAS 可用性判定：LAS 1.2 的分类只有低 5 位（≤ 31），实体含更大分类值时
 * 写 LAS 会静默丢高位，故保存前先扫一遍，越界就明确拒绝并建议改用 PLY。
 * 紧循环 over Uint8Array：1 亿点约几十毫秒，只在保存开始时做一次。
 */
export function maxClassificationOf(classification: Uint8Array | null): number {
  if (!classification) return 0
  let max = 0
  for (let i = 0; i < classification.length; i++) {
    if (classification[i] > max) max = classification[i]
  }
  return max
}

/**
 * 摊出第 [start, start + count) 个**可见点**构成的一批数据。
 *
 * 整块无 index 且区间覆盖全部顶点时，positions / classification / treeIds 直接返回
 * **源数组的视图**（零拷贝；颜色无论如何都要转码，必然重新分配）。
 *
 * @throws 当区间越界时（调用方按 chunkVisibleCount 分批，正常路径不会触发）
 */
export function buildSaveBatch(src: SaveChunkSource, start: number, count: number): SaveBatch {
  const { positions, index, colors, classification, treeIds } = src
  const total = visibleCountOf(index, Math.floor(positions.length / 3))
  if (start < 0 || count < 0 || start + count > total) {
    throw new Error(`保存分块区间越界：[${start}, ${start + count}) 超出可见点数 ${total}`)
  }

  // 整块快路径：无 index 且区间即全量 ⇒ 坐标/分类/树ID 直接用源数组（IPC 时会拷贝一次，
  // 但这里省掉一次 JS 侧的整块 memcpy）
  const whole = !index && start === 0 && count === Math.floor(positions.length / 3)
  const outPositions = whole ? positions : new Float32Array(count * 3)
  const outClassification = classification ? (whole ? classification : new Uint8Array(count)) : null
  // 编号覆盖优先：逐点常量填充（数量级 1 字节/点，一批临时数组，随批释放）
  const treeIdOverride = src.treeIdOverride ?? null
  const outTreeIds =
    treeIdOverride !== null
      ? new Uint16Array(count).fill(treeIdOverride)
      : treeIds
        ? whole
          ? treeIds
          : new Uint16Array(count)
        : null
  const outColors = colors ? new Uint8Array(count * 3) : null
  const fromBytes = colors instanceof Uint8Array

  for (let k = 0; k < count; k++) {
    const v = index ? index[start + k] : start + k
    if (!whole) {
      outPositions[k * 3] = positions[v * 3]
      outPositions[k * 3 + 1] = positions[v * 3 + 1]
      outPositions[k * 3 + 2] = positions[v * 3 + 2]
      if (outClassification && classification) outClassification[k] = classification[v]
      // 覆盖模式下 outTreeIds 已整体填好常量，不再逐点搬运
      if (outTreeIds && treeIds && treeIdOverride === null) outTreeIds[k] = treeIds[v]
    }
    if (outColors && colors) {
      const o = v * 3
      // 分支提到循环外会写成三份循环；这里是可预测分支，V8 不会有惩罚
      outColors[k * 3] = fromBytes ? linearU8ToSrgbU8(colors[o] as number) : linearToSrgbU8(colors[o] as number)
      outColors[k * 3 + 1] = fromBytes
        ? linearU8ToSrgbU8(colors[o + 1] as number)
        : linearToSrgbU8(colors[o + 1] as number)
      outColors[k * 3 + 2] = fromBytes
        ? linearU8ToSrgbU8(colors[o + 2] as number)
        : linearToSrgbU8(colors[o + 2] as number)
    }
  }

  return {
    pointCount: count,
    positions: outPositions,
    colors: outColors,
    classification: outClassification,
    treeIds: outTreeIds,
  }
}

/** 单批点数：与读侧的 chunkSize 对齐（见 pointcloudStore 的 readPointCloud 默认值）。 */
export const SAVE_BATCH_POINTS = 500000

/**
 * 默认保存文件名：用实体名（去掉源扩展名）换上新扩展名。
 *
 * 实体名可能含 Windows 非法字符（分割产物名带源名与后缀），一律替换成下划线；
 * 清洗后**只剩一串下划线**（名字本身就全是非法字符，如 `///`）时兜底 `cloud`——
 * 那种文件名读起来毫无信息量，不如给个直白的中性名。
 */
export function defaultSaveName(entityName: string, ext: string): string {
  const base = entityName.replace(/\.(ply|las|laz|pcd|xyz|txt)$/i, '')
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').trim()
  return `${/^_+$/.test(safe) ? 'cloud' : safe || 'cloud'}.${ext}`
}
