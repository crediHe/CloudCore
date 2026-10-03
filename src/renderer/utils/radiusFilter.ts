import type { EntityBBox } from '../stores/sceneStore'

/**
 * 半径滤波的渲染侧契约镜像 + JS 纯函数工具。
 *
 * C++ 算法本体见 native/radius-filter/src/radius_filter.cc；N-API 绑定壳的请求/
 * 响应契约见 native/radius-filter/src/addon.cc 顶部注释。**任何入参/出参语义改动
 * 必须两处同步**。
 *
 * 核心语义（与 C++ 一致）：
 * - 单实体 = 多块；候选点集 = 各块 index 条目的顶点下标（带 index 的分割产物），
 *   无 index = 该块全量顶点（0..vertexCount-1）。
 * - 点在「搜索半径」内的邻居数（不含自身）≥ minNeighbors 判保留，否则剔除。
 * - kept / removed 一律为「顶点缓冲空间」的下标（不是可见条目序号）：可直接喂
 *   pointcloudStore 的 buildIndexedGeometry 换索引渲染，与 ChunkSelection 语义对齐。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组，见 pointcloudStore.getFilterSourceChunks）。 */
export interface RadiusFilterChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（递增，顶点缓冲空间）。null = 候选为全量顶点。 */
  index: Uint32Array | null
}

/** 单实体滤波源。 */
export interface RadiusFilterEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: RadiusFilterChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface RadiusFilterRequest {
  /** 搜索半径（与坐标同单位；平移/旋转不改变距离，显示坐标直接用）。 */
  radius: number
  /** 最小邻居点数（不含自身）；0 = 全部保留。 */
  minNeighbors: number
  entities: RadiusFilterEntitySource[]
}

/** 单实体结果：kept[c] = 第 c 块保留顶点下标（递增，与输入 chunks 对齐）。 */
export interface RadiusFilterEntityResult {
  entityId: number
  kept: Uint32Array[]
}

/** native 模块导出契约（radius_filter.node）。 */
export interface RadiusFilterAddon {
  compute: (
    request: RadiusFilterRequest,
    callback: (err: Error | null, results?: RadiusFilterEntityResult[]) => void
  ) => void
}

/** 候选点总数（无 index = 全量顶点数；有 index = 条目数）。 */
export function candidateCountOfChunk(chunk: RadiusFilterChunkSource): number {
  return chunk.index ? chunk.index.length : chunk.positions.length / 3
}

/** 空侧包围盒：全 0。调用方（splitEntity）按子集 length > 0 过滤后再合并，0 盒不会污染。 */
const EMPTY_BBOX: EntityBBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }

/**
 * 从 C++ 输出的 kept 推导 removed 补集与两侧显示坐标包围盒（纯函数，可单测）。
 *
 * 单次双指针归并，O(候选总数)：候选集（顶点空间，递增）逐值与 kept（递增）对齐，
 * 命中累积 kept 侧包围盒、未命中记入 removed 并累积 removed 侧包围盒。
 *
 * @param positions  块内全量顶点坐标（3 float/点）
 * @param candidates 候选顶点下标（递增）或 null（候选 = 全量顶点 0..count-1）
 * @param kept       C++ 输出的保留顶点下标（递增；契约保证为 candidates 子集）
 * @returns removed 补集（递增，顶点缓冲空间）与两侧显示坐标包围盒；空侧盒为全 0
 */
export function splitKeptRemoved(
  positions: Float32Array,
  candidates: Uint32Array | null,
  kept: Uint32Array
): { removed: Uint32Array; keptBBox: EntityBBox; removedBBox: EntityBBox } {
  const universeLen = candidates ? candidates.length : positions.length / 3
  if (universeLen < kept.length) {
    throw new Error('splitKeptRemoved：kept 数量超过候选总数，输入契约被破坏')
  }
  const removed = new Uint32Array(universeLen - kept.length)
  let ri = 0
  let ki = 0
  let inMinX = Infinity,
    inMinY = Infinity,
    inMinZ = Infinity
  let inMaxX = -Infinity,
    inMaxY = -Infinity,
    inMaxZ = -Infinity
  let outMinX = Infinity,
    outMinY = Infinity,
    outMinZ = Infinity
  let outMaxX = -Infinity,
    outMaxY = -Infinity,
    outMaxZ = -Infinity

  for (let u = 0; u < universeLen; u++) {
    const v = candidates ? candidates[u] : u
    if (ki < kept.length && kept[ki] === v) {
      // 命中保留点：累积 kept 侧包围盒
      const i3 = v * 3
      const x = positions[i3],
        y = positions[i3 + 1],
        z = positions[i3 + 2]
      if (x < inMinX) inMinX = x
      if (y < inMinY) inMinY = y
      if (z < inMinZ) inMinZ = z
      if (x > inMaxX) inMaxX = x
      if (y > inMaxY) inMaxY = y
      if (z > inMaxZ) inMaxZ = z
      ki++
    } else {
      // kept 严格递增，若当前值小于 v，说明它不在此刻之前任何候选位（候选集也递增），
      // 即 kept 含候选集外的顶点——契约被破坏（正常不可能，防御性抛出）
      if (ki < kept.length && kept[ki] < v) {
        throw new Error(`splitKeptRemoved：kept 顶点 ${kept[ki]} 不在候选集内`)
      }
      removed[ri++] = v
      const i3 = v * 3
      const x = positions[i3],
        y = positions[i3 + 1],
        z = positions[i3 + 2]
      if (x < outMinX) outMinX = x
      if (y < outMinY) outMinY = y
      if (z < outMinZ) outMinZ = z
      if (x > outMaxX) outMaxX = x
      if (y > outMaxY) outMaxY = y
      if (z > outMaxZ) outMaxZ = z
    }
  }
  if (ki !== kept.length) {
    throw new Error('splitKeptRemoved：kept 含候选集外的顶点，输入契约被破坏')
  }

  return {
    removed,
    keptBBox:
      ki === 0 ? EMPTY_BBOX : { minX: inMinX, minY: inMinY, minZ: inMinZ, maxX: inMaxX, maxY: inMaxY, maxZ: inMaxZ },
    removedBBox:
      ri === 0
        ? EMPTY_BBOX
        : { minX: outMinX, minY: outMinY, minZ: outMinZ, maxX: outMaxX, maxY: outMaxY, maxZ: outMaxZ },
  }
}

/**
 * 半径滤波 O(n²) 暴力参考实现（语义逐条镜像 C++ filterEntity）。
 *
 * 仅供单元测试对照 native 产物正确性用，生产禁止调用（大点云下不可用）。
 * 输出与 addon 同构：逐块 kept（顶点下标，递增序 = 候选遍历序）。
 */
export function radiusFilterBruteForce(
  chunks: RadiusFilterChunkSource[],
  radius: number,
  minNeighbors: number
): Uint32Array[] {
  // 镜像 C++ 边界分支：radius <= 0 全部剔除；minNeighbors == 0 全部保留
  if (radius <= 0) {
    return chunks.map(() => new Uint32Array(0))
  }
  if (minNeighbors === 0) {
    return chunks.map((chunk) => {
      const n = candidateCountOfChunk(chunk)
      const kept = new Uint32Array(n)
      for (let i = 0; i < n; i++) {
        kept[i] = chunk.index ? chunk.index[i] : i
      }
      return kept
    })
  }

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
  const radiusSq = radius * radius
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

  // 逐候选点对全集中其他点计数（q === t 即 C++ 的"候选编码相同 = 自身"；
  // 不同候选即使坐标重合也照常计数，语义一致）；达到阈值提前停（与 C++ 一致）
  const isKept = new Uint8Array(total)
  for (let t = 0; t < total; t++) {
    let count = 0
    for (let q = 0; q < total && count < minNeighbors; q++) {
      if (q === t) continue
      const dx = uX[t] - uX[q]
      const dy = uY[t] - uY[q]
      const dz = uZ[t] - uZ[q]
      if (dx * dx + dy * dy + dz * dz <= radiusSq) count++
    }
    isKept[t] = count >= minNeighbors ? 1 : 0
  }

  // 按块回填（候选块序内自增 → 每块 kept 顶点下标递增，与 C++ 输出一致）
  const keptByChunk: Uint32Array[] = []
  for (let c = 0; c < chunks.length; c++) {
    const start = chunkStart[c]
    const end = c + 1 < chunks.length ? chunkStart[c + 1] : total
    let k = 0
    for (let t = start; t < end; t++) {
      if (isKept[t]) k++
    }
    const kept = new Uint32Array(k)
    k = 0
    for (let t = start; t < end; t++) {
      if (isKept[t]) kept[k++] = uVertex[t]
    }
    keptByChunk.push(kept)
  }
  return keptByChunk
}

/**
 * 平均点距粗估（确定滤波初始半径的量级用）。
 *
 * 按"最薄轴能否支撑一层间距"阶梯下探维度：先按体积密度估 3D 网格距（cbrt(体积/点数)）；
 * 若最小轴延伸小于该间距，云实质是面状，退化为面密度（sqrt(面积/点数)）；再薄则退化为
 * 线密度（长度/点数）。输出数量级 ≈ 典型相邻点距离，与坐标同单位（显示坐标 = 原始坐标
 * - 基准，距离不变）。
 *
 * 仅为交互默认值提供量级参考，非精确统计；初始半径 = 本值 × 2（见 filterStore）。
 * 极端退化输入（点数 < 2 / 各轴延伸均为 0）返回 1，保证默认半径非 0（0 半径 = 全剔除）。
 */
export function estimateMeanPointSpacing(count: number, extent: { x: number; y: number; z: number }): number {
  if (count < 2) return 1
  const ex = Math.abs(extent.x)
  const ey = Math.abs(extent.y)
  const ez = Math.abs(extent.z)
  const e = [ex, ey, ez].sort((a, b) => b - a)
  if (e[0] <= 0) return 1
  const s3 = Math.cbrt((e[0] * e[1] * e[2]) / count)
  if (e[1] > 0 && e[2] >= s3) return s3
  if (e[1] > 0) {
    const s2 = Math.sqrt((e[0] * e[1]) / count)
    if (e[1] >= s2) return s2
  }
  const s1 = e[0] / count
  return s1 > 0 ? s1 : 1
}
