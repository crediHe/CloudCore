import { loadNativeModule } from './nativeLoader'
import type { RadiusFilterChunkSource } from './radiusFilter'
import { candidateCountOfChunk } from './radiusFilter'
import { buildLabelColorTable, buildLabelColors, labelColor, LABEL_NOISE_SRGB } from './labelColors'
import { bucketByLabels } from './labelBuckets'

/**
 * 欧式聚类分割（PCL `pcl::EuclideanClusterExtraction` 语义）渲染侧契约镜像。
 *
 * C++ 算法本体见 native/euclidean-cluster/src/euclidean_cluster.cc（KD 树 + 并行并查集），
 * N-API 绑定壳的请求/响应契约见 native/euclidean-cluster/src/addon.cc 顶部注释；
 * **任何入参/出参语义改动必须两处同步**。文章出处与与 PCL 的差异见
 * doc/点云处理欧式聚类分割/ 与 native/euclidean-cluster/README-REF.md。
 *
 * 与 filter / csf 那类「保留 / 剔除」模块的关键差异：
 * - 输出是**逐候选的簇标签**（labels 1..K，与「块主序候选全集」一一对应），
 *   外加一张轻量 `clusterSizes`（第 k 簇点数）。
 * - **native 不做 min/max 簇大小过滤**：返回值是全部原始连通分量，过滤在渲染侧
 *   （本文件的 isClusterKept / summarizeClusters / bucketClusters）。理由：聚类的
 *   灵魂参数是距离阈值，改阈值必须重算；而"最小点数 / 最大点数"是筛噪声的二次
 *   调节，用户会来回试——放渲染侧后改它**不用重算**（O(K)，秒回）。
 * - 阈值是**含等号**语义（距离 == 阈值算同类，同 PCL），坐标升 double 后比较平方距离，
 *   故本文件的 euclideanClusterBruteForce 与 native 输出可断言**逐位相等**。
 *
 * 文件内 `euclideanClusterBruteForce` 仅供单测对照，**生产禁止 import**（O(n²)）。
 */

/** 单块候选源：与半径滤波的块源结构完全相同（零拷贝引用渲染缓冲）。 */
export type EuclideanClusterChunkSource = RadiusFilterChunkSource

/** 单实体输入。 */
export interface EuclideanClusterEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: EuclideanClusterChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface EuclideanClusterRequest {
  /** 聚类距离阈值（与坐标同单位；含等号）。≤ 0 → 每候选自成一簇。 */
  tolerance: number
  /**
   * 可选：查询阶段线程数（0 / 缺省 = 硬件并发数，1 = 串行）。
   * 生产路径**不传**——它存在的意义是单测能断言"结果与线程数无关"（同输入逐位相等）。
   */
  threadCount?: number
  entities: EuclideanClusterEntitySource[]
}

/** 单实体结果。 */
export interface EuclideanClusterEntityResult {
  entityId: number
  /** 逐候选（块主序）标签，取值 1..K；K = clusterSizes.length。 */
  labels: Int32Array
  /** clusterSizes[k-1] = 第 k 簇点数（Σ = 候选总数）。 */
  clusterSizes: Uint32Array
}

/** native 模块导出契约（euclidean_cluster.node）。 */
export interface EuclideanClusterAddon {
  compute: (
    request: EuclideanClusterRequest,
    callback: (err: Error | null, results?: EuclideanClusterEntityResult[]) => void
  ) => void
}

/** 组件有效点数下限默认值（滤碎噪声；native/PCL 都强调过"严禁 0"）。 */
export const DEFAULT_CLUSTER_MIN_POINTS = 10

/** 最大点数默认值：0 = 不限（滤"背景超大连通片"时才需要设）。 */
export const DEFAULT_CLUSTER_MAX_POINTS = 0

/** 未入选点的预览灰（sRGB 字节；入选簇才上色，其余一律这个灰）。 */
export const CLUSTER_NOISE_SRGB = LABEL_NOISE_SRGB

/**
 * 调用 native 欧式聚类（uv 线程池异步；Promise 化，compute 同步抛错一并收敛）。
 * @returns 逐实体结果（与请求 entities 同序）
 */
export async function computeEuclideanClusters(
  request: EuclideanClusterRequest
): Promise<EuclideanClusterEntityResult[]> {
  const addon = await loadNativeModule<EuclideanClusterAddon>('euclidean_cluster')
  return new Promise<EuclideanClusterEntityResult[]>((resolve, reject) => {
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

/**
 * 默认聚类距离阈值 = 平均点距 × 3（量级参考，非精确统计）。
 *
 * 为什么是 3 倍点距：阈值按点距的量级取，"连续表面不断开"要求 ≫ 点距，
 * "相邻物体不粘连"要求 ≪ 物体间隙。3 倍点距在常规扫描密度下落在两者之间，
 * 是让用户"一眼看到欠/过分割、再往两边调"的合理起点（与 filterStore 的 ×2 同思路，
 * 但聚类对断连更敏感，故取大一点）。
 */
export function defaultClusterTolerance(spacing: number): number {
  // 退化输入（非正 / 非有限）返回 0.1m：只保证"是个正数、量级对 TLS 扫描合理"，
  // 真正的量级来自调用方传进来的 estimateMeanPointSpacing（见 euclideanClusterStore）
  if (!Number.isFinite(spacing) || spacing <= 0) return 0.1
  return Math.max(0.001, spacing * 3)
}

/**
 * 簇是否入选（min/max 是**渲染侧策略**，不是算法语义，见文件头）。
 * @param size 簇点数
 * @param minPoints 下限（含；UI 收敛到 ≥ 1）
 * @param maxPoints 上限（含；≤ 0 = 不限）
 */
export function isClusterKept(size: number, minPoints: number, maxPoints: number): boolean {
  if (size < minPoints) return false
  if (maxPoints > 0 && size > maxPoints) return false
  return true
}

/** 一次聚类的总览数字（工具栏结果行 / 日志用；O(K)，不扫点）。 */
export interface ClusterSummary {
  /** 原始聚类数 K（native 返回的全部连通分量，未过滤）。 */
  clusterCount: number
  /** 入选聚类数。 */
  keptCount: number
  /** 入选聚类的点数合计。 */
  keptPoints: number
  /** 残点数（未入选聚类的点数合计）。 */
  noisePoints: number
  /** 最大簇点数（原始，未过滤）——提示"阈值太大把整片连成一坨了"。 */
  largestClusterPoints: number
  /** 最大入选簇点数。 */
  largestKeptPoints: number
}

/** 汇总 native 的簇大小表（纯函数；参数改动时重算，不碰点数组）。 */
export function summarizeClusters(clusterSizes: Uint32Array, minPoints: number, maxPoints: number): ClusterSummary {
  let keptCount = 0
  let keptPoints = 0
  let totalPoints = 0
  let largestClusterPoints = 0
  let largestKeptPoints = 0
  for (let i = 0; i < clusterSizes.length; i++) {
    const size = clusterSizes[i]
    totalPoints += size
    if (size > largestClusterPoints) largestClusterPoints = size
    if (isClusterKept(size, minPoints, maxPoints)) {
      keptCount++
      keptPoints += size
      if (size > largestKeptPoints) largestKeptPoints = size
    }
  }
  return {
    clusterCount: clusterSizes.length,
    keptCount,
    keptPoints,
    noisePoints: totalPoints - keptPoints,
    largestClusterPoints,
    largestKeptPoints,
  }
}

/** 单个入选聚类的分桶结果。 */
export interface ClusterBucket {
  /** native 输出的簇号（1..K）。 */
  label: number
  /** 与输入 chunks 逐块对齐的顶点下标（顶点缓冲空间，递增；零拷贝可建索引几何）。 */
  chunkIndices: (Uint32Array | null)[]
  /** 该簇点数。 */
  pointCount: number
}

/**
 * 把逐候选 labels 按块 + 按簇切成「每簇逐块顶点下标」，同时收拢残点（纯函数，可单测）。
 *
 * 分桶本体在 `utils/labelBuckets.ts#bucketByLabels`（与电力线提取共用同一份两趟计数排序
 * ——两份拷贝必然漂移）；这里只剩"哪些簇入选"这一条本算法特有的判据（isClusterKept）
 * 与「逐块桶 + 簇点数」的结果整形。
 *
 * @param chunks       与 native 请求一致的块源（只用 index 语义与顶点数，positions 不读）
 * @param labels       native 返回的逐候选标签（块主序；1..K）
 * @param clusterSizes native 返回的簇大小表（用于 min/max 过滤；不做逐点重数）
 * @param minPoints    簇点数下限（含）
 * @param maxPoints    簇点数上限（含；≤ 0 = 不限）
 * @returns 入选簇（label 升序）与残点桶；无入选簇时 clusters 为空、noiseChunkIndices 覆盖全部候选
 */
export function bucketClusters(
  chunks: EuclideanClusterChunkSource[],
  labels: Int32Array,
  clusterSizes: Uint32Array,
  minPoints: number,
  maxPoints: number
): { clusters: ClusterBucket[]; noiseChunkIndices: (Uint32Array | null)[] | null } {
  // K = 最大标签（native 保证标签连续 1..K，且按候选序首遇分配）
  let k = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > k) k = labels[i]
  }
  if (clusterSizes.length !== k) {
    throw new Error(`欧式聚类簇大小表与标签不一致（sizes ${clusterSizes.length} / 标签最大值 ${k}），契约异常`)
  }
  const { buckets, noiseChunkIndices } = bucketByLabels(chunks, labels, k, (label) =>
    isClusterKept(clusterSizes[label - 1], minPoints, maxPoints)
  )
  return {
    clusters: buckets.map((b) => ({
      label: b.label,
      chunkIndices: b.chunkIndices,
      pointCount: clusterSizes[b.label - 1],
    })),
    noiseChunkIndices,
  }
}

/**
 * 簇号 → sRGB 字节色（黄金角相位；实现与单木分割共用 `utils/labelColors.ts#labelColor`，
 * 两份拷贝必然漂移，故只留一份）。
 *
 * 为什么按**簇号**定色而不是按"入选顺序"：参数只改 min/max 时簇号不变，于是
 * 颜色不跳、肉眼能对着画面调参数（入选/未入选只影响是否上色，不影响已上色的值）。
 *
 * @param label 1..K（native 的簇号）
 */
export function clusterColor(label: number): { r: number; g: number; b: number } {
  return labelColor(label)
}

/**
 * 预览着色：逐块生成 **逐顶点线性 RGB 字节**（长度 = 该块顶点数 × 3，可直接装成
 * BufferAttribute('color')）。入选簇按 clusterColor 上色，其余（未入选簇 + 非候选顶点）
 * 一律 CLUSTER_NOISE_SRGB 灰。
 *
 * 逐块循环本身在 `utils/labelColors.ts#buildLabelColors`（与单木分割预览共用）——
 * 这里只剩"哪些簇上色"这一条本算法特有的判据（isClusterKept）。
 *
 * 注意长度按**顶点数**而不是候选数：预览是"把整片点云染色"，几何体的 index 不参与
 * （点云预览不像滤波预览那样按 index 隐藏点）——于是非候选顶点（带 index 的块里
 * 被其它工具剔除过的点）显示为灰。
 *
 * 颜色用 sRGB→线性换算，与分割后 `setEntityLabelColor` 落到材质上的分割色同源，
 * 故**预览色就是拆出来的实体的颜色**。
 */
export function buildClusterColors(
  chunks: EuclideanClusterChunkSource[],
  labels: Int32Array,
  clusterSizes: Uint32Array,
  minPoints: number,
  maxPoints: number
): (Uint8Array | null)[] {
  // 逐簇一次性算好线性色（同簇所有点同色；K 可能很大，别在点循环里算）
  const colorBytes = buildLabelColorTable(clusterSizes.length)
  return buildLabelColors(chunks, labels, colorBytes, (label) =>
    isClusterKept(clusterSizes[label - 1], minPoints, maxPoints)
  )
}

/**
 * 欧式聚类 O(n²) 暴力参考实现（语义逐条镜像 C++ clusterEntity）。
 *
 * 仅供单元测试对照 native 产物正确性用，**生产禁止调用**（大点云下不可用）。
 * 输出与 addon 同构（labels + clusterSizes），标签编号同样是"候选序首遇"，
 * 并查集同样是"只与候选号更大的邻居 union + 小根优先"，故与 native **逐位相等**。
 */
export function euclideanClusterBruteForce(
  chunks: EuclideanClusterChunkSource[],
  tolerance: number
): { labels: Int32Array; clusterSizes: Uint32Array } {
  const total = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
  if (total === 0) return { labels: new Int32Array(0), clusterSizes: new Uint32Array(0) }

  // 镜像 C++ 的 tolerance ≤ 0（含 NaN）分支：无邻居，每候选自成一簇
  if (!(tolerance > 0)) {
    const labels = new Int32Array(total)
    const clusterSizes = new Uint32Array(total)
    for (let i = 0; i < total; i++) {
      labels[i] = i + 1
      clusterSizes[i] = 1
    }
    return { labels, clusterSizes }
  }

  // 平铺候选（块主序 = 候选序；坐标升 double，Float32Array 读出的 double 精确等于 float 值）
  const uX = new Float64Array(total)
  const uY = new Float64Array(total)
  const uZ = new Float64Array(total)
  let offset = 0
  for (const chunk of chunks) {
    const n = candidateCountOfChunk(chunk)
    const index = chunk.index
    for (let i = 0; i < n; i++) {
      const v = index ? index[i] : i
      uX[offset + i] = chunk.positions[v * 3]
      uY[offset + i] = chunk.positions[v * 3 + 1]
      uZ[offset + i] = chunk.positions[v * 3 + 2]
    }
    offset += n
  }

  // 并查集（小根优先 = 根恒为该分量最小候选号 ⇒ 结果与 union 顺序无关）
  const parent = new Uint32Array(total)
  for (let i = 0; i < total; i++) parent[i] = i
  const findRoot = (start: number): number => {
    let x = start
    for (;;) {
      const p = parent[x]
      if (p === x) return x
      const gp = parent[p]
      if (gp === p) return p
      parent[x] = gp // 路径减半
      x = gp
    }
  }
  const union = (a: number, b: number) => {
    let ra = findRoot(a)
    let rb = findRoot(b)
    if (ra === rb) return
    if (ra < rb) {
      const t = ra
      ra = rb
      rb = t
    }
    parent[ra] = rb // 大根挂到小根
  }

  const radiusSq = tolerance * tolerance
  for (let t = 0; t < total; t++) {
    const xt = uX[t]
    const yt = uY[t]
    const zt = uZ[t]
    for (let q = t + 1; q < total; q++) {
      const dx = xt - uX[q]
      const dy = yt - uY[q]
      const dz = zt - uZ[q]
      if (dx * dx + dy * dy + dz * dz <= radiusSq) union(t, q)
    }
  }

  // 标签：候选序首遇分配（与 C++ 同）
  const labels = new Int32Array(total)
  const rootLabel = new Int32Array(total)
  let k = 0
  for (let g = 0; g < total; g++) {
    const r = findRoot(g)
    let label = rootLabel[r]
    if (label === 0) {
      label = ++k
      rootLabel[r] = label
    }
    labels[g] = label
  }
  const clusterSizes = new Uint32Array(k)
  for (let g = 0; g < total; g++) clusterSizes[labels[g] - 1]++
  return { labels, clusterSizes }
}
