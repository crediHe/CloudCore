import { candidateCountOfChunk } from './radiusFilter'

/**
 * 统计滤波（Statistical Outlier Removal）的渲染侧契约镜像 + JS 纯函数工具。
 *
 * C++ 算法本体见 native/statistical-filter/src/statistical_filter.cc；N-API 绑定壳的
 * 请求/响应契约见 native/statistical-filter/src/addon.cc 顶部注释。**任何入参/出参
 * 语义改动必须两处同步**。
 *
 * 核心语义（与 C++ 一致，对齐 PCL StatisticalOutlierRemoval）：
 * - 单实体 = 多块；候选点集 = 各块 index 条目的顶点下标（带 index 的分割产物），
 *   无 index = 该块全量顶点（0..vertexCount-1）。
 * - 逐点取其 neighbors(K) 个最近邻（不含自身；坐标相同的不同候选照常计数）的平均
 *   距离；邻居不足 K 时按实际邻居数平均。
 * - 全体候选的平均距离分布 → 均值 μ 与**总体**标准差 σ（除以点数 N）；平均距离
 *   严格大于 μ + max(stddevMul, 0) × σ 的点判为统计离群剔除（边界相等保留）。
 * - kept / removed 一律为「顶点缓冲空间」的下标（不是可见条目序号）：可直接喂
 *   pointcloudStore 的 buildIndexedGeometry 换索引渲染，与 ChunkSelection 语义对齐。
 *
 * 与半径滤波（utils/radiusFilter.ts）的互补定位：半径滤波按"固定半径内邻居数"判
 * 孤立（阈值是绝对尺度），本滤波按"邻居距离的全局统计分布"判离群（阈值随点云自身
 * 密度自适应）。采集密度不均匀的点云建议先用本滤波粗去噪、再半径滤波精处理——
 * 稀疏但有效的区域不会被半径滤波误杀（见 SideToolBar 提示与产品文档）。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组，与半径滤波同构）。 */
export interface SorFilterChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（递增，顶点缓冲空间）。null = 候选为全量顶点。 */
  index: Uint32Array | null
}

/** 单实体滤波源。 */
export interface SorFilterEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: SorFilterChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface SorFilterRequest {
  /** 最近邻个数 K（不含自身）；0 = 全部保留。 */
  neighbors: number
  /** 标准差倍数 λ；判定阈值 = μ + λσ（负数按 0 处理）。 */
  stddevMul: number
  entities: SorFilterEntitySource[]
}

/** 单实体结果：kept[c] = 第 c 块保留顶点下标（递增，与输入 chunks 对齐）。 */
export interface SorFilterEntityResult {
  entityId: number
  kept: Uint32Array[]
}

/** native 模块导出契约（statistical_filter.node）。 */
export interface SorFilterAddon {
  compute: (request: SorFilterRequest, callback: (err: Error | null, results?: SorFilterEntityResult[]) => void) => void
}

export { candidateCountOfChunk }

/**
 * 统计滤波 O(n²) 暴力参考实现（语义逐条镜像 C++ filterEntity）。
 *
 * 仅供单元测试对照 native 产物正确性用，生产禁止调用（大点云下不可用）。
 * 输出与 addon 同构：逐块 kept（顶点下标，递增序 = 候选遍历序）。
 * 与 C++ 的差异刻意选择不同实现路径（距离全排序而非环扩张 + 堆），降低同错概率。
 */
export function sorFilterBruteForce(
  chunks: SorFilterChunkSource[],
  neighbors: number,
  stddevMul: number
): Uint32Array[] {
  // 镜像 C++ 边界分支：neighbors == 0 全部保留
  if (neighbors === 0) {
    return chunks.map((chunk) => {
      const n = candidateCountOfChunk(chunk)
      const kept = new Uint32Array(n)
      for (let i = 0; i < n; i++) {
        kept[i] = chunk.index ? chunk.index[i] : i
      }
      return kept
    })
  }
  const mul = Math.max(stddevMul, 0)

  // 平铺候选全集：邻居搜索在全集上做（块边界只是人为切分，必须跨块计数）
  const total = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
  const chunkStart: number[] = []
  let acc = 0
  for (const c of chunks) {
    chunkStart.push(acc)
    acc += candidateCountOfChunk(c)
  }
  if (total === 0) return chunks.map(() => new Uint32Array(0))
  const uChunk = new Uint32Array(total)
  const uVertex = new Uint32Array(total)
  const uX = new Float64Array(total)
  const uY = new Float64Array(total)
  const uZ = new Float64Array(total)
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    const n = candidateCountOfChunk(chunk)
    const base = chunkStart[c]
    for (let i = 0; i < n; i++) {
      const v = chunk.index ? chunk.index[i] : i
      const idx = base + i
      uChunk[idx] = c
      uVertex[idx] = v
      uX[idx] = chunk.positions[v * 3]
      uY[idx] = chunk.positions[v * 3 + 1]
      uZ[idx] = chunk.positions[v * 3 + 2]
    }
  }

  // 逐候选点：对全集中其他候选求距离并全排序，取前 min(K, 邻居数) 平均
  // （q === t 即 C++ 的"候选编码相同 = 自身"；不同候选即使坐标重合也照常计数）
  const maxNeighbors = total - 1
  const k = Math.min(neighbors, maxNeighbors)
  const avgDist = new Float64Array(total)
  const dists = new Float64Array(maxNeighbors)
  for (let t = 0; t < total; t++) {
    let m = 0
    for (let q = 0; q < total; q++) {
      if (q === t) continue
      const dx = uX[t] - uX[q]
      const dy = uY[t] - uY[q]
      const dz = uZ[t] - uZ[q]
      dists[m++] = dx * dx + dy * dy + dz * dz
    }
    dists.sort() // 升序全排：与 C++ 的堆 + 剪枝不同路径，作为独立参考
    let sum = 0
    for (let i = 0; i < k; i++) sum += dists[i]
    avgDist[t] = k === 0 ? 0 : sum / k
  }

  // 总体均值 μ 与总体标准差 σ（除以 N；与 C++ 一致）
  let muSum = 0
  for (let t = 0; t < total; t++) muSum += avgDist[t]
  const mu = muSum / total
  let sqSum = 0
  for (let t = 0; t < total; t++) {
    const d = avgDist[t] - mu
    sqSum += d * d
  }
  const sigma = Math.sqrt(sqSum / total)
  const threshold = mu + mul * sigma

  // avg > μ + λσ 判剔除（严格大于，边界相等保留，与 C++ 一致）
  const isKept = new Uint8Array(total)
  for (let t = 0; t < total; t++) {
    isKept[t] = avgDist[t] > threshold ? 0 : 1
  }

  // 按块回填（候选块序内自增 → 每块 kept 顶点下标递增，与 C++ 输出一致）
  const keptByChunk: Uint32Array[] = []
  for (let c = 0; c < chunks.length; c++) {
    const start = chunkStart[c]
    const end = c + 1 < chunks.length ? chunkStart[c + 1] : total
    let n = 0
    for (let t = start; t < end; t++) {
      if (isKept[t]) n++
    }
    const kept = new Uint32Array(n)
    n = 0
    for (let t = start; t < end; t++) {
      if (isKept[t]) kept[n++] = uVertex[t]
    }
    keptByChunk.push(kept)
  }
  return keptByChunk
}
