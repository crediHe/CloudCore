import { candidateCountOfChunk } from './radiusFilter'
import type { RadiusFilterChunkSource } from './radiusFilter'

/**
 * 「逐标签分桶」共享原语（纯函数、零副作用，同 utils/labelColors.ts 的定位）。
 *
 * 消费方：`utils/euclideanCluster.ts#bucketClusters`（欧式聚类）与
 * `utils/powerline.ts#bucketLines`（电力线）——两者的产出形态一样
 * （「容器 + N 个 `XXX <号>` 子实体」），分桶写法也必须一样（**两份拷贝必然漂移**）。
 *
 * 算法是**两趟计数排序**（不是 `Map<label, number[][]>` 那种逐标签建数组）：
 * 一趟按 (标签, 块) 定长，一趟散写。单木分割的 K 是几十，用 Map 无所谓；而聚类的
 * K 可能是几十万（阈值小的时候满屏碎簇），逐 label 建 JS 数组在那里是平方级的开销。
 *
 * 语义约定（与 addon 契约一致）：
 * - `labels` 逐候选、**块主序**，长度必须 = Σ 各块候选数；
 * - 候选号 → 顶点下标走 `index ? index[i] : i`；桶里装的是**顶点下标**（顶点缓冲空间），
 *   可直接喂 `splitEntityMany`；
 * - 未入选标签的点与 `label ≤ 0` 的点**一律进残点桶**（调用方决定要不要建残点实体）。
 */

/** 分桶用的块源（只需 positions 的长度与 index；与半径滤波块源同构）。 */
export type LabelChunkSource = RadiusFilterChunkSource

/** 单个入选标签的分桶结果。 */
export interface LabelBucket {
  /** native 输出的标签（1..K）。 */
  label: number
  /** 与输入 chunks **逐块对齐**的顶点下标（顶点缓冲空间，递增；空块给 null）。 */
  chunkIndices: (Uint32Array | null)[]
}

/** 分桶产物。 */
export interface LabelBucketResult {
  /** 入选标签的分桶（**标签升序**）。 */
  buckets: LabelBucket[]
  /**
   * 逐标签点数（下标 = 标签，长度 = labelCount + 1，0 号恒 0）。
   *
   * 由分桶自身的计数得出，故与 native 另给的簇大小表互为校验（对不上即契约破损）。
   */
  labelCounts: Uint32Array
  /** 残点桶（逐块；候选全部分桶时给 null）。 */
  noiseChunkIndices: (Uint32Array | null)[] | null
}

/**
 * 按标签把逐候选标签切成「每标签逐块顶点下标」+ 残点桶。
 *
 * @param chunks     与 native 请求一致的块源（只读 index 语义与顶点数，positions 不读）
 * @param labels     native 返回的逐候选标签（块主序）
 * @param labelCount K（调用方从 native 的标签最大值/大小表得出并校验）
 * @param keepLabel  该标签是否入选（未入选的标签**整标签不进分桶**，其点全部并入残点）
 * @throws 标签数与候选数不一致 / 标签越界（> labelCount）——契约破损，宁可抛也别写坏数据
 */
export function bucketByLabels(
  chunks: LabelChunkSource[],
  labels: Int32Array,
  labelCount: number,
  keepLabel: (label: number) => boolean
): LabelBucketResult {
  const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
  if (labels.length !== candidateTotal) {
    throw new Error(`标签数与候选数不一致（labels ${labels.length} / 候选 ${candidateTotal}），契约异常`)
  }
  const blockCount = chunks.length
  // 入选表 + 越界预检合并进同一趟（标签本来就全扫一遍，不另起循环）
  const kept: boolean[] = new Array(labelCount + 1)
  for (let label = 1; label <= labelCount; label++) kept[label] = keepLabel(label)

  // 逐块候选数（两趟的公共前缀和）
  const perChunk = chunks.map((c) => candidateCountOfChunk(c))
  // 第一趟：数每标签每块的候选数 counts[(label - 1) * blockCount + c]
  const counts = new Uint32Array(labelCount * blockCount)
  let offset = 0
  for (let c = 0; c < blockCount; c++) {
    const n = perChunk[c]
    for (let i = 0; i < n; i++) {
      const label = labels[offset + i]
      if (label > labelCount) {
        throw new Error(`标签越界（label ${label} > ${labelCount}），契约异常`)
      }
      if (label > 0 && kept[label]) counts[(label - 1) * blockCount + c]++
    }
    offset += n
  }
  // 逐标签点数（顺带把 counts 求和；与 native 的大小表该相等）
  const labelCounts = new Uint32Array(labelCount + 1)
  for (let label = 1; label <= labelCount; label++) {
    let sum = 0
    for (let c = 0; c < blockCount; c++) sum += counts[(label - 1) * blockCount + c]
    labelCounts[label] = sum
  }
  // 定长分配（只给入选标签）+ 写游标（就地当游标用，即"分配后清零即游标"）
  const flat: (Uint32Array | null)[] = new Array(counts.length).fill(null)
  const cursor = new Uint32Array(counts.length)
  for (let label = 1; label <= labelCount; label++) {
    if (!kept[label]) continue
    for (let c = 0; c < blockCount; c++) {
      const idx = (label - 1) * blockCount + c
      if (counts[idx] > 0) flat[idx] = new Uint32Array(counts[idx])
    }
  }
  // 残点桶（逐块）
  const noise: number[][] = chunks.map(() => [])
  let noiseCount = 0

  // 第二趟：散写
  offset = 0
  for (let c = 0; c < blockCount; c++) {
    const n = perChunk[c]
    const index = chunks[c].index
    const bucket = noise[c]
    for (let i = 0; i < n; i++) {
      const label = labels[offset + i]
      const v = index ? index[i] : i
      const slot = label > 0 && kept[label] ? (label - 1) * blockCount + c : -1
      const arr = slot >= 0 ? flat[slot] : null
      if (arr) arr[cursor[slot]++] = v
      else bucket.push(v)
    }
    noiseCount += bucket.length
    offset += n
  }

  // 收口：逐标签给「逐块 Uint32Array | null」（空块给 null，与 splitByClassification 空块占位一致）
  const buckets: LabelBucket[] = []
  for (let label = 1; label <= labelCount; label++) {
    if (!kept[label]) continue
    const chunkIndices: (Uint32Array | null)[] = []
    for (let c = 0; c < blockCount; c++) chunkIndices.push(flat[(label - 1) * blockCount + c])
    buckets.push({ label, chunkIndices })
  }
  return {
    buckets,
    labelCounts,
    noiseChunkIndices: noiseCount > 0 ? noise.map((arr) => (arr.length > 0 ? new Uint32Array(arr) : null)) : null,
  }
}

/**
 * 残点 = 「源候选集」减去若干入选子集的并集（纯函数）。
 *
 * 与 `noiseChunkIndices` 的分工：后者只覆盖**喂给 native 的那批候选**（电力线的池子），
 * 而残点实体按语义是「源点云减各产物」——池子之外的源点（地面、植被、建筑）也得在里面。
 *
 * 用逐块 `Uint8Array` 掩码而不是 k 路归并：块内顶点数由读盘分块决定（量级 50 万），
 * 一块掩码几百 KB、用完即弃；而 k 路归并要在"若干条线的下标各不相交"这条**外部不变量**
 * 上做文章，一旦哪天不成立就是静默丢点。O(块顶点数 + 各子集点数)，与并集条数无关。
 *
 * @param chunks           源实体的块源（index = 源候选；null = 全量顶点）
 * @param subsetChunkLists 各子集的逐块下标（**每条子集一个数组**，长度须 = chunks.length）
 * @returns 逐块残点下标；残点为空给 null（调用方据此不建残点实体）
 */
export function residualChunkIndices(
  chunks: LabelChunkSource[],
  subsetChunkLists: (Uint32Array | null)[][]
): (Uint32Array | null)[] | null {
  let total = 0
  const out: (Uint32Array | null)[] = []
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    const vertexCount = chunk.positions.length / 3
    const mask = new Uint8Array(vertexCount)
    for (const perChunk of subsetChunkLists) {
      const arr = perChunk[c]
      if (!arr) continue
      for (let i = 0; i < arr.length; i++) mask[arr[i]] = 1
    }
    const universeLen = chunk.index ? chunk.index.length : vertexCount
    const keep: number[] = []
    for (let i = 0; i < universeLen; i++) {
      const v = chunk.index ? chunk.index[i] : i
      if (!mask[v]) keep.push(v)
    }
    total += keep.length
    out.push(keep.length > 0 ? new Uint32Array(keep) : null)
  }
  return total > 0 ? out : null
}
