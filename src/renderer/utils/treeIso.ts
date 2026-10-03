import { loadNativeModule } from './nativeLoader'
import type { RadiusFilterChunkSource } from './radiusFilter'
import { candidateCountOfChunk } from './radiusFilter'
import { buildLabelColorTable, buildLabelColors } from './labelColors'

/**
 * TreeIso 单木分割（Xi & Hopkinson 2022 三阶段图切分）渲染侧契约镜像。
 *
 * C++ 算法本体见 native/treeiso/src/treeiso.cc（语义对齐 CloudCompare qTreeIso，
 * 许可与出处见 native/treeiso/README-REF.md）；N-API 绑定壳的请求/响应契约见
 * native/treeiso/src/addon.cc 顶部注释。**任何入参/出参语义改动必须两处同步**。
 *
 * 与 csf / radiusFilter 的关键差异：
 * - 输出不是「保留/去除」而是**逐候选组件标签**：labels 与「块主序候选全集」
 *   一一对应（候选 = 块带 index 时其条目、否则全量顶点），值为 1..K。
 * - native 输出的都是真实组件（点数过少的残片不设阈），「残点归拢」是渲染侧
 *   按 minPoints 的纯函数策略（bucketCandidateLabels）。
 * - 输入假设已去除地面（CSF 之后），分割对象为选中实体/树项的全部可见点。
 *
 * 树高/胸径/冠幅等 Tree object 指标由 `Trees ▸ Compute tree info…` 计算（`utils/treeMetrics.ts`
 * 是算法本体，`stores/treeInfoStore.ts` 是会话）——本文件只负责分割链路与分桶，不掺指标。
 */

/** 单块候选源：与半径滤波的块源结构完全相同（零拷贝引用渲染缓冲）。 */
export type TreeIsoChunkSource = RadiusFilterChunkSource

/** 单实体输入。 */
export interface TreeIsoEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: TreeIsoChunkSource[]
}

/**
 * TreeIso 三阶段参数（与 addon.cc 的 params 字段及 treeiso.h 默认值一一对应，
 * 单位对齐 CloudCompare qTreeIso 对话框；数字字段全必填）。
 */
export interface TreeIsoParams {
  // —— Init（初始 3D 图割超分割）——
  /** 体素抽稀分辨率（m）；越小保留细节越多，点数与耗时上升。 */
  decimateRes1: number
  /** kNN 查询数（含自身；建图取前 minNN1−1 条）。 */
  minNN1: number
  /** 图割边权乘子 λ1（边权 exp(−d²)·λ1；越大超分割越整）。 */
  regStrength1: number
  // —— Intermediate（自底向上间隙闭合）——
  /** 各 init 簇内体素抽稀分辨率（m）。 */
  decimateRes2: number
  /** 质心/抽稀点 kNN 查询数（含自身）。 */
  minNN2: number
  /** 簇间可连边最大空隙（平方距离 m²）。 */
  maxGap: number
  /** 边权乘子 λ2。 */
  regStrength2: number
  // —— Final（树冠—树干合并）——
  /** 组级 kNN 查询数（插件无独立 UI，运行时取 minNN2 同值即可）。 */
  minNN3: number
  /** 相对高度判「树冠块」阈值（0-1，越大树冠判定越苛刻）。 */
  relHeightLengthRatio: number
  /** 合并打分中垂直重叠的权重。 */
  verticalWeight: number
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface TreeIsoRequest {
  params: TreeIsoParams
  entities: TreeIsoEntitySource[]
}

/** 单实体结果：labels 与候选全集（块主序）一一对应，值 1..K（K = 最终树木数）。 */
export interface TreeIsoEntityResult {
  entityId: number
  labels: Int32Array
}

/** native 模块导出契约（treeiso.node）。 */
export interface TreeIsoAddon {
  compute: (request: TreeIsoRequest, callback: (err: Error | null, results?: TreeIsoEntityResult[]) => void) => void
}

/** 渲染侧默认参数（对齐 treeiso.h 的 TreeIsoParams 默认值，即 qTreeIso 对话框惯例）。 */
export const TREEISO_DEFAULTS: TreeIsoParams = {
  decimateRes1: 0.05,
  minNN1: 5,
  regStrength1: 1,
  decimateRes2: 0.1,
  minNN2: 10,
  maxGap: 2,
  regStrength2: 10,
  minNN3: 10,
  relHeightLengthRatio: 0.5,
  verticalWeight: 0.5,
}

/**
 * 调用 native 单木分割（uv 线程池异步；Promise 化，compute 同步抛错一并收敛）。
 * @returns 逐实体结果（与请求 entities 同序）
 */
export async function computeTreeIso(request: TreeIsoRequest): Promise<TreeIsoEntityResult[]> {
  const addon = await loadNativeModule<TreeIsoAddon>('treeiso')
  return new Promise<TreeIsoEntityResult[]>((resolve, reject) => {
    try {
      addon.compute(request, (err, results) => {
        if (err) reject(err)
        else resolve(results ?? [])
      })
    } catch (e) {
      reject(e) // compute 入参非法时绑定层同步抛错（不走回调）
    }
  })
}

/** 单个树组件的分桶结果：该 label 在每块的顶点下标（递增；该块无此树 = null）。 */
export interface TreeIsoLabelBucket {
  /** native 输出的组件号（1..K）。 */
  label: number
  /** 与输入 chunks 逐块对齐的顶点下标（顶点缓冲空间，递增；零拷贝可建索引几何）。 */
  chunkIndices: (Uint32Array | null)[]
  /** 该树点数（≥ minPoints）。 */
  pointCount: number
}

/**
 * 把 native 输出的逐候选 labels 按块切回并按 label 分桶（纯函数，可单测）。
 *
 * 候选语义与 addon 契约一致：labels 长度 = Σ块（带 index 取条目数、否则全量顶点数），
 * 块主序推进。桶元素 = 顶点下标（顶点缓冲空间）——带 index 块把候选序映射回
 * 下标、无 index 块候选序即下标本身。输出结构与 splitByClassification 内部的
 * chunkIndicesByClass 同构，可直接照其流程逐桶建零拷贝索引几何。
 *
 * 残点归拢：点数 < minPoints 的组件整体并入残点桶（不逐点拆组件）——native 层
 * 输出均为真实组件，碎片组件通常整片是噪点/树外残留。
 *
 * @param chunks    与 native 请求一致的块源（仅用 index 语义，positions 不读）
 * @param labels    native 返回的逐候选标签（块主序；1..K）
 * @param minPoints 组件有效点数下限（点数低于它的组件归拢残点）
 * @returns 有效树组件（label 升序）与残点桶；全部点数不足时 treeBuckets 为空、
 *   noiseChunkIndices 覆盖全部候选
 */
export function bucketCandidateLabels(
  chunks: TreeIsoChunkSource[],
  labels: Int32Array,
  minPoints: number
): { treeBuckets: TreeIsoLabelBucket[]; noiseChunkIndices: (Uint32Array | null)[] | null } {
  assertLabelLength(chunks, labels)

  // pass 1：统计每个 label 的候选总数（labels 块主序 = 候选序）
  const labelCounts = countLabels(chunks, labels)
  const keptLabels = [...labelCounts.entries()]
    .filter(([, count]) => count >= minPoints)
    .map(([label]) => label)
    .sort((a, b) => a - b)

  // pass 2：逐候选派发——kept 组件逐块收集顶点下标（number[] 攒够转 Uint32Array，
  // 逐桶即转避免峰值翻倍）；残点组件（label 不在 kept 集合）并入残点数组
  const keptSet = new Set(keptLabels)
  const perLabelPerChunk = new Map<number, number[][]>() // label → [chunk][顶点下标…]
  for (const label of keptLabels) {
    perLabelPerChunk.set(
      label,
      chunks.map(() => [])
    )
  }
  const noise: number[][] = chunks.map(() => [])
  let noiseCount = 0
  let offset = 0
  for (let c = 0; c < chunks.length; c++) {
    const n = candidateCountOfChunk(chunks[c])
    const index = chunks[c].index
    const dest = noise[c]
    for (let k = 0; k < n; k++) {
      const label = labels[offset + k]
      const v = index ? index[k] : k
      const bucket = keptSet.has(label) ? perLabelPerChunk.get(label)![c] : dest
      bucket.push(v)
    }
    noiseCount += dest.length
    offset += n
  }

  // 收口：逐 label 转 Uint32Array（空块给 null，与 splitByClassification 空块占位一致）
  const treeBuckets: TreeIsoLabelBucket[] = keptLabels.map((label) => {
    const perChunk = perLabelPerChunk.get(label)!
    const chunkIndices = perChunk.map((arr) => (arr.length > 0 ? new Uint32Array(arr) : null))
    const pointCount = perChunk.reduce((s, arr) => s + arr.length, 0)
    return { label, chunkIndices, pointCount }
  })
  const hasNoise = noiseCount > 0
  const noiseChunkIndices = hasNoise ? noise.map((arr) => (arr.length > 0 ? new Uint32Array(arr) : null)) : null
  return { treeBuckets, noiseChunkIndices }
}

/**
 * 契约校验：labels 长度须等于候选总数（块主序），返回候选总数。
 * 分桶 / 计数 / 预览三处共用同一份判据与文案（散开写必然有一处漏掉）。
 */
function assertLabelLength(chunks: TreeIsoChunkSource[], labels: Int32Array): number {
  const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
  if (labels.length !== candidateTotal) {
    throw new Error(`TreeIso 结果标签数与候选数不一致（labels ${labels.length} / 候选 ${candidateTotal}），契约异常`)
  }
  return candidateTotal
}

/**
 * 逐 label 统计候选数（**块主序**扫描；label ≤ 0 不计——它不是组件号）。
 *
 * 这就是 `bucketCandidateLabels` 的 pass 1，抽出来是因为**预览侧也要同一份计数**：
 * 预览的"哪些组件算树"必须与分割时的分桶判据**同源**，否则画面上的树数与拆出来的
 * 树数会对不上（预览看着 12 棵、拆完 11 个实体 = 最糟的那种不一致）。
 */
export function countLabels(chunks: TreeIsoChunkSource[], labels: Int32Array): Map<number, number> {
  assertLabelLength(chunks, labels)
  const counts = new Map<number, number>()
  let offset = 0
  for (const chunk of chunks) {
    const n = candidateCountOfChunk(chunk)
    for (let k = 0; k < n; k++) {
      const label = labels[offset + k]
      if (label > 0) counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    offset += n
  }
  return counts
}

/** 有效组件集合：候选数 ≥ minPoints（**含端点**，与分桶判据一致）。 */
export function keptLabelSet(counts: Map<number, number>, minPoints: number): Set<number> {
  const kept = new Set<number>()
  for (const [label, count] of counts) {
    if (count >= minPoints) kept.add(label)
  }
  return kept
}

/** 一次单木分割的总览数字（工具栏结果行 / 日志用；O(K)，不扫点）。 */
export interface TreeIsoSummary {
  /** native 输出的组件数（未过滤；不等于最终树数）。 */
  componentCount: number
  /** 有效树数（候选数 ≥ minPoints 的组件数）。 */
  treeCount: number
  /** 有效树的点数合计。 */
  treePoints: number
  /** 残点数（会落进 `<源名>.noise` 实体的点数合计）。 */
  noisePoints: number
  /** 最大一棵树的点数（0 = 无树）。 */
  largestTreePoints: number
}

/**
 * 汇总组件计数表（预览/分割共用；纯 O(K)）。
 *
 * 残点按**最终归属**算：候选总数 − 有效树点数，而不是"未达标组件求和"——
 * 于是契约破损时出现的 label ≤ 0 候选也被算进残点（它们确实会进 `.noise` 实体）。
 */
export function summarizeTreeLabels(
  counts: Map<number, number>,
  minPoints: number,
  candidateTotal: number
): TreeIsoSummary {
  let treeCount = 0
  let treePoints = 0
  let largestTreePoints = 0
  for (const count of counts.values()) {
    if (count < minPoints) continue
    treeCount++
    treePoints += count
    if (count > largestTreePoints) largestTreePoints = count
  }
  return {
    componentCount: counts.size,
    treeCount,
    treePoints,
    noisePoints: Math.max(0, candidateTotal - treePoints),
    largestTreePoints,
  }
}

/**
 * 预览着色：逐块生成**逐顶点线性 RGB 字节**（长度 = 该块顶点数 × 3，可直接装成
 * BufferAttribute('color')）。有效树按 `labelColor(标签)` 上色，其余（归拢残点的
 * 碎片组件 + 非候选顶点）一律 `LABEL_NOISE_SRGB` 灰。
 *
 * 与 `utils/euclideanCluster.ts#buildClusterColors` 共用 `labelColors` 的逐块循环，
 * 差别只有一条判据：这里"上不上色"由 `kept` 集合定（tags 定色 ⇒ 拖动最小点数时
 * **颜色不跳**，只是某些树从有色变灰）。颜色换算与 `setEntityLabelColor` 同式
 * （sRGB 字节 → 线性），故**预览色与拆出来的实体色一致**。
 *
 * 容器目标（原地重建）逐实体调用本函数：`kept` 用**全局**计数算出的集合，
 * 于是跨实体的同一棵树同色；`labels` 是该实体自己那一段（见 `sliceEntityLabels`）。
 *
 * @param chunks 该实体（或单实体目标）的块源，与 native 请求同序
 * @param labels 与 chunks 的**候选序**一一对应的标签（不是并集的全量 labels）
 * @param kept   有效组件集合（buildTreeColors 只给它们上色）
 */
export function buildTreeColors(
  chunks: TreeIsoChunkSource[],
  labels: Int32Array,
  kept: Set<number>,
  labelBase = 1
): (Uint8Array | null)[] {
  // 色表按 kept 里最大的标签定长（未入选的标签不进表 ⇒ 越界判据同时兜住"不在表内"）
  let maxLabel = 0
  for (const label of kept) {
    if (label > maxLabel) maxLabel = label
  }
  // labelBase：标签 → **物体编号**的位移（预览色必须与产物色同源，见 TreeIsoCache.labelBase）
  return buildLabelColors(chunks, labels, buildLabelColorTable(maxLabel, labelBase), (label) => kept.has(label))
}

/** 容器目标的 native 输入并集 + 「把 labels 切回各实体」的布局表。 */
export interface TreeIsoEntityUnion {
  /** 并集块源：positions 取首实体（组内实体共享同一源缓冲），index = 各实体候选逐块 concat。 */
  chunks: TreeIsoChunkSource[]
  /**
   * 逐块 → 逐实体：该实体在该块贡献的候选数（0 = 未贡献）。
   * 与并集 chunks 的候选序**同一顺序**：块 c 的候选 = 依次各实体的 `counts[c][e]` 个。
   */
  countsByChunk: number[][]
}

/**
 * 把多个实体的块源并成一份 native 输入（容器目标「原地重建」用），并回布局表。
 *
 * 为什么必须与布局表一起产出：native 的 labels 是**块主序**的一维数组，而预览要给
 * 每个成员实体各装一份颜色、分割要按实体摊平——**切回来的偏移必须与并起来的顺序
 * 严格互逆**。两者写在一处才可能保证互逆（分成两段手写偏移必然漂移）。
 *
 * ⚠ 既有语义（刻意不改）：某实体某块的 index 为 null 或长度为 0 时**不进并集**
 * （记 0 个候选）。与 native 的「无 index = 全量顶点」不同——并集是逐实体 index 的
 * concat，没有 index 就无从表达。当前不可达（容器成员必为 splitEntityMany 产物，
 * 恒有 index）；真要支持得物化一份 `0..vertexCount−1`，代价是每块 4 字节/点。
 *
 * @returns 块数不一致（契约防御）或输入为空 → null（调用方按"目标失效"处理）
 */
export function buildEntityUnion(perEntity: TreeIsoChunkSource[][]): TreeIsoEntityUnion | null {
  if (perEntity.length === 0) return null
  const blockCount = perEntity[0].length
  if (perEntity.some((chunks) => chunks.length !== blockCount)) return null
  const chunks: TreeIsoChunkSource[] = []
  const countsByChunk: number[][] = []
  for (let c = 0; c < blockCount; c++) {
    const indexParts: Uint32Array[] = []
    const counts: number[] = []
    for (const chunksOfEntity of perEntity) {
      const idx = chunksOfEntity[c].index
      if (idx && idx.length > 0) {
        indexParts.push(idx)
        counts.push(idx.length)
      } else {
        counts.push(0)
      }
    }
    chunks.push({ positions: perEntity[0][c].positions, index: concatUint32(indexParts) })
    countsByChunk.push(counts)
  }
  return { chunks, countsByChunk }
}

/**
 * 从并集 labels 里切出**单个实体**那一段（块序，与该实体自己的 chunks 对齐），
 * 可直接喂给 `buildTreeColors`。切法严格按 `countsByChunk` 走（块外序 + 块内实体序），
 * 故与 `buildEntityUnion` 的拼接顺序互逆。
 */
export function sliceEntityLabels(labels: Int32Array, countsByChunk: number[][], entityIndex: number): Int32Array {
  let total = 0
  for (const counts of countsByChunk) total += counts[entityIndex] ?? 0
  const out = new Int32Array(total)
  let w = 0
  let offset = 0
  for (const counts of countsByChunk) {
    for (let e = 0; e < counts.length; e++) {
      const n = counts[e]
      if (e === entityIndex) {
        out.set(labels.subarray(offset, offset + n), w)
        w += n
      }
      offset += n
    }
  }
  return out
}

/** 逐块并集（并集块源用；各输入自身递增即可，无跨输入序要求）。 */
function concatUint32(parts: Uint32Array[]): Uint32Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint32Array(total)
  let w = 0
  for (const p of parts) {
    out.set(p, w)
    w += p.length
  }
  return out
}
