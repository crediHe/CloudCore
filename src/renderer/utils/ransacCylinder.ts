import { candidateCountOfChunk, estimateMeanPointSpacing } from './radiusFilter'
import { RANSAC_DEFAULT_MAX_ITERATIONS } from './ransacPlane'

/**
 * RANSAC 圆柱拟合的渲染侧契约镜像 + JS 纯函数工具。
 *
 * C++ 算法本体见 native/ransac-cylinder/src/ransac_cylinder.cc；N-API 绑定壳的请求/响应
 * 契约见 native/ransac-cylinder/src/addon.cc 顶部注释。**任何入参/出参语义改动必须两处同步**。
 * 算法语义、轴方向的来源与已知局限见 native/ransac-cylinder/README-REF.md。
 *
 * 核心语义（与 C++ 一致，对齐 PCL SACSegmentation 的 SACMODEL_CYLINDER + SAC_RANSAC）：
 * - 单实体 = 多块；候选点集 = 各块 index 条目的顶点下标（带 index 的分割产物），
 *   无 index = 该块全量顶点。与 ransac-plane 逐条同构。
 * - 采样式找模型（采样集 ≤ 65536 点）+ **全量判归属**：内点是对全部候选点判定的结果。
 * - inliers 一律为「顶点缓冲空间」的下标，可直接喂 pointcloudStore 换索引渲染。
 * - 回包比模板多一个 `cylinder` 模型字段（与 ransac-plane 的 `plane` 同类，是本仓库第二类
 *   破模板契约）：RANSAC 的产物核心是模型本身——渲染侧要画圆柱线框、要报圆柱度、要显示
 *   自动估计出的轴方向，都只能从这里拿。
 *
 * **本模块与 ransac-plane 最大的语义差异是轴方向**：平面没有「轴」这一自由度，圆柱有。
 * 两条来源：
 * - `axis` 入参显式给定（对齐 PCL `setAxis`，是**约束**而非初值，回包 axisEstimated=false）；
 * - 由**法线**自动估计（对齐 PCL `SACSegmentationFromNormals`：法线 ⊥ 轴 ⇒ 成对法线叉积定轴），
 *   此时每块都要带 `normals`，回包 axisEstimated=true + `axisScore`。
 *
 * 法线取自实体上的 `normalCode` 属性（`Edit ▸ Normals` 的产物，2 字节量化码，布局与顶点一一对应），
 * 由 `pointcloudStore.getNormalCodeChunks` 零拷贝取出。**没有法线的实体走这条路会被硬拒**
 * （native 抛 TypeError），UI 侧则提前把「用实体法向量」模式下的预览禁用掉。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组，与半径滤波同构）。 */
export interface RansacCylinderChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（递增，顶点缓冲空间）。null = 候选为全量顶点。 */
  index: Uint32Array | null
  /**
   * 法向量量化码（**顶点缓冲空间**：长度 = 该块顶点数，不是候选数；与实体 `normalCode`
   * 属性同布局，故可直接把属性数组塞进来）。null / 省略 = 该块没法线。
   * 仅 `axis` 为 null（自动估计）时读取；给了 axis 时可整个省掉（零开销）。
   */
  normals?: Uint16Array | null
}

/** 单实体拟合源。 */
export interface RansacCylinderEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: RansacCylinderChunkSource[]
}

/**
 * 轴方向约束（显示坐标空间；无需归一化，C++ 侧会归一化并把符号统一到「最大绝对值分量为正」）。
 * 零向量非法（C++ 判未找到）。
 */
export interface RansacCylinderAxis {
  x: number
  y: number
  z: number
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface RansacCylinderRequest {
  /** 点到圆柱面的绝对距离 ≤ 它判内点（|垂距 − 半径| ≤ 阈值，与坐标同单位；非正数按 0）。 */
  distanceThreshold: number
  /** 假设循环最大轮数；自适应早停会提前结束（回包报实际轮数）。0 = 不迭代。 */
  maxIterations: number
  /** 是否对最优内点集做精修（对齐 PCL setOptimizeCoefficients）。 */
  optimizeCoefficients: boolean
  /** 采样集点数上限；0 / undefined = 自动（C++ 内部上限 65536）。非 UI 参数，仅供诊断。 */
  sampleSize?: number
  /** 半径下限（文章的 RadiusLimits）；≤ 0 = 不限制。越界的假设整轮丢弃。 */
  minRadius?: number
  /** 半径上限；≤ 0 = 不限制。 */
  maxRadius?: number
  /**
   * 轴方向：null/undefined = **由各块的 normals 自动估计**（回包 axisEstimated=true）。
   * 此时每个 chunk 都必须带 normals，否则 native 同步抛 TypeError。
   */
  axis?: RansacCylinderAxis | null
  entities: RansacCylinderEntitySource[]
}

/** 圆柱面上的正交标架（(u, v, a) 右手系，由轴向确定性导出）：画线框与端面圆用。 */
export interface RansacCylinderBasis {
  /** u ⊥ a 的单位向量。 */
  ux: number
  uy: number
  uz: number
  /** v = a × u 的单位向量。 */
  vx: number
  vy: number
  vz: number
}

/** 圆柱模型与拟合质量。 */
export interface RansacCylinderModel {
  /** 几何中心（在轴上；= 内点轴向范围的中点，显示坐标空间）。 */
  cx: number
  cy: number
  cz: number
  /** 单位轴方向（符号约定：最大绝对值分量为正）。 */
  ax: number
  ay: number
  az: number
  /** 半径（内点到轴的垂距，圆柱半径 —— 不是到中心点的距离）。 */
  radius: number
  /** 沿轴的半高（内点在轴向的跨度之半）。 */
  halfHeight: number
  /** 最终内点数（**全量候选**上的统计，不是采样集上的）。 */
  inlierCount: number
  /** 采样集点数（诊断：判断小圆柱是否可能被采样漏掉）。 */
  sampleCount: number
  /** 假设循环实际执行的轮数（自适应早停生效时小于 maxIterations）。 */
  iterationsUsed: number
  /** 内点到圆柱面的均方根距离（圆柱度指标）。 */
  rms: number
  /** 内点到圆柱面的最大绝对偏差。 */
  maxDeviation: number
  /** 轴方向是否由 native 从法线自动估计（false = 用户显式给定，此时方向未被精修改动）。 */
  axisEstimated: boolean
  /**
   * 轴候选得分 = 票数占比 × 一致法线各向异性比 ∈ [0, 1]（显式轴时恒 0）。
   *
   * **这是轴路径唯一的可见指标**：平面主导的点云里，胜出候选的得分会贴着闸门（0.02）走，
   * 说明法线里几乎没有圆柱面、结果是碰巧凑的——渲染侧据此提示，用户应改用手动轴或先框选局部。
   */
  axisScore: number
  basis: RansacCylinderBasis
}

/**
 * 「用实体法向量」模式下判定「这片点云有法线可用」的覆盖率下限（computed / 候选总数）。
 *
 * 取 0.5 而不是 1：法线估计**本来就会留空码**（邻域点数不足、Quadric 在退化邻域无解，
 * Auto 半径偏小时尤其明显），要求 100% 会让大量正常数据被挡在门外。反过来放得太低
 * （如 0.1）则会让「只有零星点有法线」的实体走进投票——那种输入下轴方向纯属噪声。
 * 这个常量是**合成场景 + 经验**定的策略值，真机数据下要调就调它一处（UI 提示里也会报实际覆盖率）。
 */
export const CYLINDER_MIN_NORMAL_COVERAGE = 0.5

/** 单实体结果：inliers[c] = 第 c 块内点顶点下标（递增，与输入 chunks 对齐）。 */
export interface RansacCylinderEntityResult {
  entityId: number
  /** 逐块内点顶点下标（递增）。cylinder 为 null 时各项均为空数组。 */
  inliers: Uint32Array[]
  /** 拟合出的圆柱；null = 未找到（候选 < 3 / 不迭代 / 采样集里没有圆柱面 / 无支撑圆柱）。 */
  cylinder: RansacCylinderModel | null
}

/** native 模块导出契约（ransac_cylinder.node）。 */
export interface RansacCylinderAddon {
  compute: (
    request: RansacCylinderRequest,
    callback: (err: Error | null, results?: RansacCylinderEntityResult[]) => void
  ) => void
}

export { candidateCountOfChunk }

/** 最大迭代次数默认值（与平面拟合同源：文章明确「不要用 PCL 默认的 50，先设 1000」）。 */
export const CYLINDER_DEFAULT_MAX_ITERATIONS = RANSAC_DEFAULT_MAX_ITERATIONS

/**
 * 交互默认参数（确定初值用）。
 *
 * 距离阈值 = 平均点距 × 2（与平面拟合、半径滤波、CSF 分类阈值同一套量级依据：点云量纲
 * 五花八门，按点距估比按文章给的绝对量级稳）。
 * 半径上下限默认 0 = **不限制**——半径无法从点数/包围盒推出来，猜一个只会让假设全被滤掉；
 * 这是留白的约束（文章的 RadiusLimits 本就是可选参数），用户知道大概半径时可显著提速。
 */
export function estimateCylinderDefaults(
  count: number,
  extent: { x: number; y: number; z: number }
): {
  distanceThreshold: number
  maxIterations: number
  optimizeCoefficients: boolean
  minRadius: number
  maxRadius: number
} {
  return {
    distanceThreshold: estimateMeanPointSpacing(count, extent) * 2,
    maxIterations: CYLINDER_DEFAULT_MAX_ITERATIONS,
    optimizeCoefficients: true,
    minRadius: 0,
    maxRadius: 0,
  }
}

/**
 * 用给定圆柱判定全部候选点，返回逐块内点顶点下标（递增）——**C++ classifyAll 判定式的纯函数镜像**。
 *
 * 单测拿 native 回传的 `cylinder` 调它、与 native 回传的 `inliers` 断言**逐位相等**，一条断言
 * 同时验证了：契约字段语义、索引空间（顶点缓冲而非候选序号）、递增性、逐块对齐。
 *
 * 逐位可复现的前提（改代码时别破坏）：
 * - 垂距的**求值顺序必须与 C++ `perpDistance` 完全一致**（先 u = p − c，再叉积，再平方和开方，
 *   左结合无重排）；`std::fabs` ↔ `Math.abs`、`std::sqrt` ↔ `Math.sqrt` 对 double 都是精确/正确
 *   舍入操作，故同序同值。
 * - 判据 `|perp − radius| ≤ 阈值`，阈值钳制同 C++：非正数按 0。
 * - 坐标为 float32 值（读自 Float32Array，JS 侧自动升为 double），与 C++ 读 float 转 double 一致。
 * - 候选遍历序 = 块序 → 块内候选序，与 C++ `for i in 0..n-1` 一致。
 *
 * 与「生产禁止调用」的 O(n²) 参考实现不同，本函数是 O(n)、本身没有性能问题；只是生产路径
 * **不该**调它——native 在全量 pass 里已顺带产出同一份结果，再算一遍纯属浪费。它是契约验证器。
 *
 * 注意：**刻意不做** RANSAC 搜索的逐位镜像（与 ransac-plane 同一取舍）。圆柱的假设循环还多一层
 * 前置：轴方向要先从法线投票 + 特征分解里定出来，逐位对齐更不可能；故只镜像可精确复现的最后一步（判定）。
 */
export function classifyCylinder(
  chunks: RansacCylinderChunkSource[],
  cylinder: { cx: number; cy: number; cz: number; ax: number; ay: number; az: number; radius: number },
  distanceThreshold: number
): Uint32Array[] {
  const threshold = distanceThreshold > 0 ? distanceThreshold : 0
  const { cx, cy, cz, ax, ay, az, radius } = cylinder
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
      // 以下求值顺序与 C++ perpDistance 逐行对应（见上方注释）：左结合、不重排
      const vx = x - cx
      const vy = y - cy
      const vz = z - cz
      const wx = vy * az - vz * ay
      const wy = vz * ax - vx * az
      const wz = vx * ay - vy * ax
      const perp = Math.sqrt(wx * wx + wy * wy + wz * wz)
      if (Math.abs(perp - radius) > threshold) continue
      scratch[k++] = vertex
    }
    out.push(scratch.subarray(0, k))
  }
  return out
}
