import { loadNativeModule } from './nativeLoader'
import type { RadiusFilterChunkSource } from './radiusFilter'
import { candidateCountOfChunk } from './radiusFilter'
import { buildLabelColorTable, buildLabelColors, labelColor, LABEL_NOISE_SRGB } from './labelColors'
import { bucketByLabels } from './labelBuckets'
import type { LabelBucket } from './labelBuckets'
import type { GroundGridData } from './groundGrid'

/**
 * 电力线（导线）提取渲染侧契约镜像。
 *
 * C++ 算法本体见 native/powerline/src/powerline.cc，N-API 绑定壳的请求/响应契约见
 * native/powerline/src/addon.cc 顶部注释；**任何入参/出参语义改动必须两处同步**。
 * 无上游对照（CloudCompare 没有电力线提取），设计判断与实测记录见
 * native/powerline/README-REF.md。
 *
 * 与其余模块的关键差异：
 *
 * 1. **两个导出**（同 registration / normal-estimate 的先例）：`extractCandidates` 是重活
 *    （离地筛 + KD 树 + 逐点 PCA），`traceLines` 是轻活（局部方向 → 连通 → 抛物线剥离 →
 *    端点补全）。分开的理由是**参数代价分级**：改「最小离地高 / 邻域半径」要重跑前者，
 *    而改「线性度 / 倾角 / 连接半径 / 最短线长」只跑后者（池子只有几千〜几万点）。
 *    `extractCandidates` 把**逐池点特征**回传给渲染侧，精筛（线性度、倾角）就地完成。
 * 2. **⚠ `index` 语义不同**：`new Uint32Array(0)` = **该块零候选**（其余 12 个模块因
 *    `Data()` 给空指针而与「没有 index」等价 = 全量顶点）。精筛会把某些块的池子整个刷空，
 *    那时若退化成"全量顶点"，整块地面/植被都会被当成导线候选去连线。见
 *    native/powerline/src/powerline.h 的 `ChunkSource::hasIndex`。
 * 3. 回包是**逐候选标签 + 线统计表**（同 euclidean-cluster 的形态，理由也一样：K 可能很大，
 *    下标子集形态要重建 K 个数组）。
 *
 * 坐标一律是**显示坐标**（原始 − 全局基准点），与其余模块一致。
 */

/** 单块候选源（与半径滤波块源同构；index 语义见文件头第 2 条）。 */
export type PowerlineChunkSource = RadiusFilterChunkSource

/** 单实体输入。 */
export interface PowerlineEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: PowerlineChunkSource[]
}

/** 阶段 1 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface PowerlineExtractRequest {
  /** 离地高（HAG）下限（m）。 */
  minHeight: number
  /** PCA 邻域半径（m）：须装下导线沿程 5–8 个点。 */
  radius: number
  /** 地面参考面（见 utils/groundGrid.ts#buildGroundGrid）。 */
  groundGrid: GroundGridData
  /**
   * 可选：线程数（0 / 缺省 = 硬件并发数，1 = 串行）。
   * 生产路径**不传**——它存在的意义是单测能断言"结果与线程数无关"（同 euclidean-cluster）。
   */
  threadCount?: number
  entities: PowerlineEntitySource[]
}

/** 逐池点特征（块主序；长度 = Σ chunks[c].kept.length）。 */
export interface PowerlineFeatures {
  /** (λ1 − λ2) / λ1：主方向的"细长程度"，导线接近 1。 */
  linearity: Float32Array
  /** |v1.z|：主方向与水平面夹角的正弦。 */
  verticality: Float32Array
  /** 离地高（m；**注意是 float 存下来的**，比较阈值时用 native 的双精度原值才逐位一致）。 */
  hag: Float32Array
  /** 邻域点数（含自身）。 */
  neighborCount: Uint32Array
}

/** 阶段 1 单实体结果。 */
export interface PowerlineExtractEntityResult {
  entityId: number
  /** 逐块「池子」：该块入选点的顶点缓冲下标（升序）。 */
  chunks: { kept: Uint32Array }[]
  features: PowerlineFeatures
  stats: {
    /** 过 HAG 闸的点数（= 建 KD 树与算 PCA 的规模）。 */
    offGroundCount: number
    /** 过宽松闸的点数（= features 长度）。 */
    poolCount: number
  }
}

/** 阶段 2 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface PowerlineTraceRequest {
  /** 连通半径（m）：**故意放大**到能粘住平行线/交叉线，由后续抛物线剥离拆开。 */
  connectRadius: number
  /** 抛物线残差容差（m）。 */
  residualTolerance: number
  /** 一条线的最少点数（含）。 */
  minLinePoints: number
  /** 一条线的最短长度（m，含）：城市场景假阳性的主闸门。 */
  minLineLength: number
  /** 端点补全的球面搜索半径（m）。 */
  gapRadius: number
  /** 端点补全的角度门限（°）。 */
  gapAngleDeg: number
  /** 局部方向估计的邻域半径（m）。 */
  dirRadius: number
  threadCount?: number
  /** index = **精筛后**的候选（顶点空间）；`new Uint32Array(0)` = 该块零候选。 */
  entities: PowerlineEntitySource[]
}

/** 一条电力线的统计量。 */
export interface PowerlineLineInfo {
  /** 1..K，按候选序首遇（块主序）分配——**与 labels 的取值一一对应**。 */
  id: number
  pointCount: number
  /** 两端点三维距离（m）。 */
  length: number
  /** 相对弦线的最大下垂（m，恒 ≥ 0）。 */
  sag: number
  /** 水平走向方位角 [0, 180)。 */
  azimuthDeg: number
  /** 二次模型的最小二乘残差 RMS（m）。 */
  rms: number
  /** 端点补全合并进来的段数（0 = 这一条没补过口）。 */
  gapCount: number
}

/** 阶段 2 单实体结果。 */
export interface PowerlineTraceEntityResult {
  entityId: number
  /** **逐候选**（块主序）1..K；0 = 未成线（残点）。 */
  labels: Int32Array
  lines: PowerlineLineInfo[]
  stats: {
    candidateTotal: number
    lineCount: number
    noiseCount: number
  }
}

/** native 模块导出契约（powerline.node；两个导出）。 */
export interface PowerlineAddon {
  extractCandidates: (
    request: PowerlineExtractRequest,
    callback: (err: Error | null, results?: PowerlineExtractEntityResult[]) => void
  ) => void
  traceLines: (
    request: PowerlineTraceRequest,
    callback: (err: Error | null, results?: PowerlineTraceEntityResult[]) => void
  ) => void
}

// ===========================================================================
// 常量（不出 UI 的那些；UI 旋钮见 PowerlineParams）
// ===========================================================================

/**
 * native 侧**宽松闸门**的常量（`kLooseLinearity` / `kLooseVerticality` / 邻居数下限）——
 * 池子是这三条筛出来的。渲染侧的精筛滑杆**必须夹在池子之内**，否则滑到池外会静默无效
 * （画面没变、用户以为参数没生效）。UI 的夹取函数见 clampLinearityMin / clampMaxSlopeDeg。
 */
export const POWERLINE_LOOSE_MIN_LINEARITY = 0.5
export const POWERLINE_LOOSE_MAX_SLOPE_DEG = 30 // asin(0.5) = 30°（|v1.z| ≤ 0.5）
export const POWERLINE_LOOSE_MIN_NEIGHBORS = 3

/** 池子点数上限（native 侧同值）：超限走错误回调，提示"调高最小离地高"。 */
export const POWERLINE_POOL_MAX_POINTS = 4_000_000

/** 连线方向门限（°）：连通时两候选的局部方向夹角上限。 */
export const POWERLINE_CONNECT_ANGLE_GATE_DEG = 15

/** 端点补全的横向偏移上限（m，两条待接线必须共线）。 */
export const POWERLINE_LATERAL_TOLERANCE = 0.5

/**
 * 一次分割允许的最大线数：超过就拒绝分割（同 MAX_SPLIT_CLUSTERS 的理由——
 * 每条线一个实体 + 一个分组，K 太大时场景树与 three 对象都会被拖垮）。
 * 预览不受此限（预览只是染色）。
 */
export const MAX_SPLIT_LINES = 500

/** 未成线（残点）与非候选点的预览灰（sRGB 字节）。 */
export const LINE_NOISE_SRGB = LABEL_NOISE_SRGB

// ===========================================================================
// 参数与默认值
// ===========================================================================

/** UI 上的全部旋钮（默认值见 defaultPowerlineParams）。 */
export interface PowerlineParams {
  /** 【重】离地高下限（m）：改它要重跑 native #1。 */
  minHeight: number
  /** 【重】PCA 邻域半径（m）：改它要重跑 native #1。 */
  radius: number
  /** 【即时】线性度下限：渲染侧精筛，改它不碰 native #1（但仍要重跑 #2）。 */
  linearityMin: number
  /** 【即时】最大倾角（°）。 */
  maxSlopeDeg: number
  /** 【轻】连通半径（m）：以下全部只影响 native #2。 */
  connectRadius: number
  residualTolerance: number
  minLinePoints: number
  minLineLength: number
  gapRadius: number
  gapAngleDeg: number
  dirRadius: number
}

/** 【重】档参数：只有这两个改动才需要重跑 `extractCandidates`。 */
export const POWERLINE_EXTRACT_KEYS = ['minHeight', 'radius'] as const

/** 两个参数集在【重】档上是否有差异（store 的 watch 用它决定要不要重跑 native #1）。 */
export function extractParamsChanged(a: PowerlineParams, b: PowerlineParams): boolean {
  return POWERLINE_EXTRACT_KEYS.some((k) => a[k] !== b[k])
}

/**
 * 默认 PCA 邻域半径 = 平均点距 × 10（夹在 0.5–5 m）。
 *
 * 为什么是 10 倍点距：半径里要装下导线沿程 5–8 个点才算得出稳定方向（ALS 4–8 点/m²
 * 时点距 0.3–0.5 m，×10 恰好 3–5 m）；而下限 0.5 m 是"再稀疏也得有邻居"，
 * 上限 5 m 是"别把地面和导线糊进一个邻域"（丘陵林下点密，×10 会失控）。
 * 退化输入（非有限 / ≤ 0）给 1 m：只保证"是个正数、量级对 ALS 合理"。
 */
export function defaultPowerlineRadius(spacing: number): number {
  if (!Number.isFinite(spacing) || spacing <= 0) return 1
  return Math.min(5, Math.max(0.5, spacing * 10))
}

/** 默认参数（`spacing` = 平均点距，见 radiusFilter#estimateMeanPointSpacing）。 */
export function defaultPowerlineParams(spacing?: number): PowerlineParams {
  return {
    minHeight: 4,
    radius: defaultPowerlineRadius(spacing ?? Number.NaN),
    linearityMin: 0.85,
    maxSlopeDeg: 25,
    connectRadius: 3,
    residualTolerance: 0.35,
    minLinePoints: 20,
    minLineLength: 20,
    gapRadius: 10,
    gapAngleDeg: 12,
    dirRadius: 2,
  }
}

/** 线性度滑杆的夹取（见 POWERLINE_LOOSE_MIN_LINEARITY 的说明）。 */
export function clampLinearityMin(value: number): number {
  if (!Number.isFinite(value)) return POWERLINE_LOOSE_MIN_LINEARITY
  return Math.min(1, Math.max(POWERLINE_LOOSE_MIN_LINEARITY, value))
}

/** 倾角滑杆的夹取（见 POWERLINE_LOOSE_MAX_SLOPE_DEG 的说明）。 */
export function clampMaxSlopeDeg(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(POWERLINE_LOOSE_MAX_SLOPE_DEG, Math.max(0, value))
}

// ===========================================================================
// native 调用
// ===========================================================================

/** 调用 native 候选提取（uv 线程池异步；Promise 化，同步抛错一并收敛）。 */
export async function extractPowerlineCandidates(
  request: PowerlineExtractRequest
): Promise<PowerlineExtractEntityResult[]> {
  const addon = await loadNativeModule<PowerlineAddon>('powerline')
  return new Promise<PowerlineExtractEntityResult[]>((resolve, reject) => {
    try {
      addon.extractCandidates(request, (err, results) => {
        if (err) reject(err)
        else resolve(results ?? [])
      })
    } catch (e) {
      reject(e) // 入参非法时绑定层同步抛错（不走回调）
    }
  })
}

/** 调用 native 连线（同上）。 */
export async function tracePowerlineLines(request: PowerlineTraceRequest): Promise<PowerlineTraceEntityResult[]> {
  const addon = await loadNativeModule<PowerlineAddon>('powerline')
  return new Promise<PowerlineTraceEntityResult[]>((resolve, reject) => {
    try {
      addon.traceLines(request, (err, results) => {
        if (err) reject(err)
        else resolve(results ?? [])
      })
    } catch (e) {
      reject(e)
    }
  })
}

/** 组装阶段 1 请求（字段映射只此一处，避免 store 与单测各写一份）。 */
export function buildExtractRequest(
  params: PowerlineParams,
  groundGrid: GroundGridData,
  entityId: number,
  chunks: PowerlineChunkSource[],
  threadCount?: number
): PowerlineExtractRequest {
  const request: PowerlineExtractRequest = {
    minHeight: params.minHeight,
    radius: params.radius,
    groundGrid,
    entities: [{ entityId, chunks }],
  }
  if (threadCount !== undefined) request.threadCount = threadCount
  return request
}

/** 组装阶段 2 请求（同上）。 */
export function buildTraceRequest(
  params: PowerlineParams,
  entityId: number,
  chunks: PowerlineChunkSource[],
  threadCount?: number
): PowerlineTraceRequest {
  const request: PowerlineTraceRequest = {
    connectRadius: params.connectRadius,
    residualTolerance: params.residualTolerance,
    minLinePoints: params.minLinePoints,
    minLineLength: params.minLineLength,
    gapRadius: params.gapRadius,
    gapAngleDeg: params.gapAngleDeg,
    dirRadius: params.dirRadius,
    entities: [{ entityId, chunks }],
  }
  if (threadCount !== undefined) request.threadCount = threadCount
  return request
}

// ===========================================================================
// 渲染侧纯函数
// ===========================================================================

/** 倾角（°）→ 垂直度阈值（|v1.z| 的上限）。 */
export function slopeSin(maxSlopeDeg: number): number {
  return Math.sin((maxSlopeDeg * Math.PI) / 180)
}

/**
 * **精筛**：第 i 个池点是否留下（线性度 ≥ 下限、倾角 ≤ 上限、邻居数够）。
 *
 * 与 native 宽松闸门的关系：宽松闸（0.5 / 30° / 3）在 native 里已经施加过一次，
 * 精筛是**在池子上再收一道**，故调用方必须用 clampLinearityMin / clampMaxSlopeDeg
 * 夹取，保证精筛阈值落在宽松闸之内（否则滑杆有一段永远无效）。
 *
 * @param features     native 回传的逐池点特征
 * @param i            池点号（块主序）
 * @param maxVerticality |v1.z| 上限（= slopeSin(maxSlopeDeg)；循环里预先算好，别逐点算 sin）
 */
export function candidateKeptLinear(
  features: PowerlineFeatures,
  i: number,
  linearityMin: number,
  maxVerticality: number
): boolean {
  if (!(features.linearity[i] >= linearityMin)) return false
  if (!(Math.abs(features.verticality[i]) <= maxVerticality)) return false
  return features.neighborCount[i] >= POWERLINE_LOOSE_MIN_NEIGHBORS
}

/** 同上，但传角度（°）——单点调用/单测用；批量路径请用 candidateKeptLinear。 */
export function candidateKept(
  features: PowerlineFeatures,
  i: number,
  linearityMin: number,
  maxSlopeDeg: number
): boolean {
  return candidateKeptLinear(features, i, linearityMin, slopeSin(maxSlopeDeg))
}

/**
 * 精筛 → 逐块候选下标（顶点缓冲空间，升序）。
 *
 * 与 native 请求的块**逐块对齐**（含空数组）：空数组表示"该块零候选"，
 * 而**不是**"全量顶点"（见文件头第 2 条）——组装 trace 请求时必须原样传下去。
 */
export function refineChunkIndices(
  extract: PowerlineExtractEntityResult,
  linearityMin: number,
  maxSlopeDeg: number
): Uint32Array[] {
  const maxVerticality = slopeSin(maxSlopeDeg)
  const out: Uint32Array[] = []
  let offset = 0
  for (const chunk of extract.chunks) {
    const kept = chunk.kept
    const selected: number[] = []
    for (let k = 0; k < kept.length; k++) {
      if (candidateKeptLinear(extract.features, offset + k, linearityMin, maxVerticality)) selected.push(kept[k])
    }
    offset += kept.length
    out.push(new Uint32Array(selected))
  }
  return out
}

/**
 * 逐线分桶（线号 → 逐块顶点下标 + 残点桶）。
 *
 * 与 `bucketClusters` 共用 `utils/labelBuckets.ts#bucketByLabels` 的两趟计数排序。
 * 注意这里的"入选"判据**恒为真**：`minLinePoints` / `minLineLength` 是 native 的
 * **算法内闸门**（参与递归剥离与端点补全后的收口，不是渲染侧的二次过滤），
 * 回包的每一条线都已经过闸（见 powerline.cc 第 6 步）。
 */
export function bucketLines(
  chunks: PowerlineChunkSource[],
  labels: Int32Array,
  lineCount: number
): { lines: LabelBucket[]; noiseChunkIndices: (Uint32Array | null)[] | null } {
  const { buckets, noiseChunkIndices } = bucketByLabels(chunks, labels, lineCount, () => true)
  return { lines: buckets, noiseChunkIndices }
}

/** 一条线的总览数字（工具栏结果行 / 日志用；O(K)，不扫点）。 */
export interface PowerlineSummary {
  /** native 输出的线数 K。 */
  lineCount: number
  /** 成线点数合计。 */
  linePoints: number
  /** 残点数（候选总数 − 成线点数）——**不含**池子之外的点。 */
  noisePoints: number
  /** 最长一条线的长度（m）。 */
  longestLine: number
  /** 成线总长度（m）：同一根线的总长，能一眼看出"拆成了几段"。 */
  totalLength: number
  /** 补过口的线数（gapCount > 0）——端点补全真的生效了的直接证据。 */
  gapLines: number
}

/** 汇总 native 的线统计表（纯函数；参数改动时重算，不碰点数组）。 */
export function summarizeLines(lines: PowerlineLineInfo[], candidateTotal: number): PowerlineSummary {
  let linePoints = 0
  let longestLine = 0
  let totalLength = 0
  let gapLines = 0
  for (const line of lines) {
    linePoints += line.pointCount
    if (line.length > longestLine) longestLine = line.length
    totalLength += line.length
    if (line.gapCount > 0) gapLines++
  }
  return {
    lineCount: lines.length,
    linePoints,
    noisePoints: Math.max(0, candidateTotal - linePoints),
    longestLine,
    totalLength,
    gapLines,
  }
}

/**
 * 线号 → sRGB 字节色（黄金角相位；与单木分割/欧式聚类共用 `utils/labelColors.ts#labelColor`）。
 *
 * 为什么按**线号**定色：`minLineLength` / `minLinePoints` 一改，线号不变（native 按候选序
 * 首遇编号），于是颜色不跳、肉眼能对着画面调参数。
 */
export function lineColor(id: number): { r: number; g: number; b: number } {
  return labelColor(id)
}

/**
 * 预览着色：逐块生成 **逐顶点线性 RGB 字节**（长度 = 该块顶点数 × 3，可直接装成
 * BufferAttribute('color')）。成线点按 lineColor 上色，其余（残点 + 非候选顶点）一律灰。
 *
 * 逐块循环本身在 `utils/labelColors.ts#buildLabelColors`（与欧式聚类/单木分割共用）。
 * 长度按**顶点数**而不是候选数：预览是"把整片点云染色"，几何体的 index 不参与。
 */
export function buildLineColors(
  chunks: PowerlineChunkSource[],
  labels: Int32Array,
  lineCount: number
): (Uint8Array | null)[] {
  const colorBytes = buildLabelColorTable(lineCount)
  return buildLabelColors(chunks, labels, colorBytes, () => true)
}

/** 精筛后的候选总数（组装 trace 请求前算一次，用于结果行与契约核对）。 */
export function refinedCandidateCount(chunks: PowerlineChunkSource[]): number {
  return chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
}
