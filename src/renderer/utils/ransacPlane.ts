import { candidateCountOfChunk, estimateMeanPointSpacing } from './radiusFilter'

/**
 * RANSAC 平面拟合的渲染侧契约镜像 + JS 纯函数工具。
 *
 * C++ 算法本体见 native/ransac-plane/src/ransac_plane.cc；N-API 绑定壳的请求/响应
 * 契约见 native/ransac-plane/src/addon.cc 顶部注释。**任何入参/出参语义改动必须两处同步**。
 * 算法语义与已知局限见 native/ransac-plane/README-REF.md。
 *
 * 核心语义（与 C++ 一致，对齐 PCL SACSegmentation 的 SACMODEL_PLANE + SAC_RANSAC）：
 * - 单实体 = 多块；候选点集 = 各块 index 条目的顶点下标（带 index 的分割产物），
 *   无 index = 该块全量顶点（0..vertexCount-1）。
 * - 采样式找模型（采样集 ≤ 65536 点）+ **全量判归属**：最终内点是对全部候选点判定的结果，
 *   不是采样集上的那批。故 1 亿点的云也能被完整分出平面，而不是只分出 6.5 万个点。
 * - inliers 一律为「顶点缓冲空间」的下标（不是可见条目序号）：可直接喂
 *   pointcloudStore 的 buildIndexedGeometry 换索引渲染，与 ChunkSelection 语义对齐。
 * - **本模块是继 lod-octree 之后第二处破模板的契约**：回包比其余 6 个算法模块多一个
 *   `plane` 模型字段（它们只有索引数组）。RANSAC 的产物核心是模型本身——渲染侧要画
 *   平面片、要报平面度（RMS / 最大偏差），都只能从这里拿。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组，与半径滤波同构）。 */
export interface RansacPlaneChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（递增，顶点缓冲空间）。null = 候选为全量顶点。 */
  index: Uint32Array | null
}

/** 单实体拟合源。 */
export interface RansacPlaneEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: RansacPlaneChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface RansacPlaneRequest {
  /** 点到平面的绝对距离 ≤ 它判内点（与坐标同单位；非正数按 0 处理 = 无内点）。 */
  distanceThreshold: number
  /** 假设循环最大轮数；自适应早停会提前结束（回包报实际轮数）。0 = 不迭代。 */
  maxIterations: number
  /** 是否对最优内点集做最小二乘精修（对齐 PCL setOptimizeCoefficients）。 */
  optimizeCoefficients: boolean
  /** 采样集点数上限；0 / undefined = 自动（C++ 内部上限 65536）。非 UI 参数，仅供诊断。 */
  sampleSize?: number
  entities: RansacPlaneEntitySource[]
}

/** 平面片画布：以 center 为中心、(u,v) 为平面内正交单位基的矩形（显示坐标）。 */
export interface RansacPlaneQuad {
  cx: number
  cy: number
  cz: number
  /** 平面内正交单位基（(u, v, n) 右手系，由法向确定性导出）。 */
  ux: number
  uy: number
  uz: number
  vx: number
  vy: number
  vz: number
  /** 沿 u / v 的半跨度（内点在该基上的实际跨度之半，无外扩）。内点过少时为 0，渲染侧兜底。 */
  halfU: number
  halfV: number
}

/** 平面模型与拟合质量。 */
export interface RansacPlaneModel {
  /** 单位法向 + 平面方程 n·p + d = 0（显示坐标空间）。 */
  nx: number
  ny: number
  nz: number
  d: number
  /** 最终内点数（**全量候选**上的统计，不是采样集上的）。 */
  inlierCount: number
  /** 采样集点数（诊断：判断小平面是否可能被采样漏掉）。 */
  sampleCount: number
  /** 假设循环实际执行的轮数（自适应早停生效时小于 maxIterations）。 */
  iterationsUsed: number
  /** 内点到平面的均方根距离（平面度指标）。 */
  rms: number
  /** 内点到平面的最大绝对距离。 */
  maxDeviation: number
  quad: RansacPlaneQuad
}

/** 单实体结果：inliers[c] = 第 c 块内点顶点下标（递增，与输入 chunks 对齐）。 */
export interface RansacPlaneEntityResult {
  entityId: number
  /** 逐块内点顶点下标（递增）。plane 为 null 时各项均为空数组。 */
  inliers: Uint32Array[]
  /** 拟合出的平面；null = 未找到（候选 < 3 / 不迭代 / 全共线 / 无支撑平面）。 */
  plane: RansacPlaneModel | null
}

/** native 模块导出契约（ransac_plane.node）。 */
export interface RansacPlaneAddon {
  compute: (
    request: RansacPlaneRequest,
    callback: (err: Error | null, results?: RansacPlaneEntityResult[]) => void
  ) => void
}

export { candidateCountOfChunk }

/** 最大迭代次数默认值（文章明确「不要用 PCL 默认的 50，先设 1000」）。 */
export const RANSAC_DEFAULT_MAX_ITERATIONS = 1000

/**
 * 交互默认参数（确定初值用）。
 *
 * 距离阈值 = 平均点距 × 2：与仓库既有惯例一致（半径滤波的初始半径 ×2、CSF 的分类阈值 ×2）。
 * 文章给的量级参考（工业 0.001–0.01m、地面 0.05–0.2m）依赖单位与采集密度，按点距估更稳，
 * 且点云扫描仪的量纲单位五花八门（毫米 / 米 / 英尺都有）。
 *
 * 仅为初值：阈值调大能把更稀疏的平面纳入内点，调小则更严格（平面度更好但可能漏点）。
 */
export function estimateRansacDefaults(
  count: number,
  extent: { x: number; y: number; z: number }
): { distanceThreshold: number; maxIterations: number; optimizeCoefficients: boolean } {
  return {
    distanceThreshold: estimateMeanPointSpacing(count, extent) * 2,
    maxIterations: RANSAC_DEFAULT_MAX_ITERATIONS,
    optimizeCoefficients: true,
  }
}

/**
 * 用给定平面判定全部候选点，返回逐块内点顶点下标（递增）——**C++ classifyAll 的纯函数镜像**。
 *
 * 单测拿 native 回传的 `plane` 调它、与 native 回传的 `inliers` 断言**逐位相等**，一条断言
 * 同时验证了：契约字段语义、索引空间（顶点缓冲而非候选序号）、递增性、逐块对齐。
 *
 * 逐位可复现的前提（改代码时别破坏）：
 * - 判定式 `nx*x + ny*y + nz*z + d` 的**求值顺序必须与 C++ 完全一致**（左结合、无重排），
 *   IEEE-754 double 下同序同值；`std::fabs` ↔ `Math.abs` 对 double 是精确操作。
 * - 坐标为 float32 值（读自 Float32Array，JS 侧自动升为 double），与 C++ 读 float 再
 *   转 double 的结果一致。
 * - 候选遍历序 = 块序 → 块内候选序，与 C++ `for i in 0..n-1` 一致。
 * - 阈值钳制同 C++：非正数按 0（此时仅**恰好落在平面上**的点判内点）。
 *
 * 与 `radiusFilterBruteForce` 那类「生产禁止调用」的 O(n²) 参考实现不同，本函数是 O(n)、
 * 本身没有性能问题；只是生产路径**不该**调它——native 在 pass2 里已顺带产出同一份结果，
 * 再算一遍纯属浪费。它是契约验证器，不是实现。
 *
 * 注意：这里**不做** RANSAC 搜索的逐位镜像。早停判据含 `Math.log`，libm 与 JS 引擎存在
 * 1 ulp 级差异，会让「停在第几轮」不可逐位复现——镜像一个注定对不齐的搜索没有意义。
 * 故改为镜像可精确复现的最后一步（判定），这是刻意取舍，不是偷懒。
 */
export function classifyPlane(
  chunks: RansacPlaneChunkSource[],
  plane: { nx: number; ny: number; nz: number; d: number },
  distanceThreshold: number
): Uint32Array[] {
  const threshold = distanceThreshold > 0 ? distanceThreshold : 0
  const { nx, ny, nz, d } = plane
  const out: Uint32Array[] = []
  for (const chunk of chunks) {
    const n = candidateCountOfChunk(chunk)
    const scratch = new Uint32Array(n)
    let k = 0
    for (let i = 0; i < n; i++) {
      const vertex = chunk.index ? chunk.index[i] : i
      const i3 = vertex * 3
      const x = chunk.positions[i3]
      const y = chunk.positions[i3 + 1]
      const z = chunk.positions[i3 + 2]
      // 求值顺序与 C++ 一致（见上方注释）：左结合、不重排
      const dist = nx * x + ny * y + nz * z + d
      if (Math.abs(dist) > threshold) continue
      scratch[k++] = vertex
    }
    out.push(scratch.subarray(0, k))
  }
  return out
}
