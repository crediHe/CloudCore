/**
 * 树木基础信息（树高 / 最低点 / 代表点 / 冠幅 / 胸径）的纯函数实现。
 *
 * 输入是**点云实体的可见点集**（逐块 `positions` + `index`，语义与
 * `pointcloudStore.getFilterSourceChunks` 完全一致），输出是 `TreeMetrics`
 * （= `sceneStore` 的 `TreeObject` 存储形态）。**不依赖 THREE、不依赖任何 store**：
 * 逐块遍历由调用方驱动（store 负责让出主线程与进度条），故可在 node 环境直接单测。
 *
 * 六条口径（都是刻意的，且被单测钉住）：
 *
 * 1. **坐标系**：内部一律用**显示坐标**（输入什么样就什么样），只在组装结果时把两个点加回
 *    `globalShift`——于是 `TreeMetrics` 里的坐标与 `SceneEntity.bbox` 同口径（文件原始坐标），
 *    调用方不必再换算一次（也就没有"两处换算不同步"的机会）。
 * 2. **z 向上**：分块几何是 Z-up 局部空间（Group 的 `rotation.x = -π/2` 只在渲染时用），
 *    故"高"是 z 差、"水平"是 xy。
 * 3. **两趟扫描**：趟 1（`accumulateZ`）求 z 的极值与分位样本；`finishPass1` 才能定出
 *    冠层底与胸径切片各自的 z 区间；趟 2（`accumulateCrown`）收冠层跨度与切片点。
 *    顺序颠倒必然算错（区间还没定），故 API 就是三段式、没有"一趟搞定"的入口。
 * 4. **抽样只影响两处**：基准分位数与胸径切片点——按 `max(1, 候选总数 / SAMPLE_CAP)` 取等距步长，
 *    且计数器**跨块共享**，于是样本在"存储序"上均匀铺开，而不是挤在前几块里
 *    （同 three/lodTraversal.ts 步长取点的理由：前缀是空间上的一小块）。
 *    极值、冠层跨度、切片点数一律**精确**统计，不受抽样影响。
 * 5. **不编造数字**：圆拟合被接受判据拒绝时 `dbh` 报 0（不是"大概算了个值"），代表点退回
 *    切片质心并把 `quality.dbhMethod` 记成 `'centroid'`；切片为空则 `representative = null`。
 *    使用者据此判断"这个数能不能用"，而不是去猜。
 * 6. **基准点与基准高程**：`baseQuantile = 0`（默认）时基准就是真正的最低点，树高 = maxZ − minZ，
 *    与直觉一致；`> 0` 时基准上移到该分位（抗"去地面残留的孤立低点"），树高随之从新基准量起，
 *    `basePoint` 的 x/y 仍取最低点、z 取基准（这一处细节写在 basePoint 的字段注释里）。
 * 7. **确定性**：抽样步长由候选总数推出、圆拟合的 RANSAC 用固定种子，且抽样计数器**跨块共享**
 *    （按存储序计数，而不是每块各自从 0 开始）⇒ 同一片点云、同一组参数永远得到逐位相同的结果，
 *    而且**换个分块方式结果不变**（同 registration / lodOctree 的分块不变性先例）。
 */

/** 三维点（`TreeMetrics` 里的坐标一律是**文件原始坐标**，与 SceneEntity.bbox 同口径）。 */
export interface TreePoint {
  x: number
  y: number
  z: number
}

/** 计算参数（对话框四个输入；单位见字段注释）。 */
export interface TreeMetricsOptions {
  /** 胸径测量高度：相对**基准点**往上的米数（惯例 1.3 m）。 */
  dbhHeight: number
  /** 胸径切片厚度 [m]：切片 = |z − (baseZ + dbhHeight)| ≤ 厚度/2。 */
  sliceThickness: number
  /** 冠层比例（0-1）：冠层 = 基准往上 (1 − 比例) × 树高 以上的点（默认 0.3 = 顶部 30%）。 */
  crownRatio: number
  /** 基准分位数（0-1）：0 = 用最低点当基准；> 0 时用该分位的 z（抗离群低点）。上限 0.5。 */
  baseQuantile: number
}

/** 默认参数（树高/胸径/冠幅的林业惯例值，对话框初值）。 */
export const DEFAULT_TREE_METRICS_OPTIONS: TreeMetricsOptions = {
  dbhHeight: 1.3,
  sliceThickness: 0.1,
  crownRatio: 0.3,
  baseQuantile: 0,
}

/** 抽样上限：分位样本与切片点各自最多这么多（步长按候选总数推导，见模块注释第 4 条）。 */
export const SAMPLE_CAP = 8192

/** 圆拟合最少内点数：少于它不采纳圆（稀疏 ALS 单木的切片常常只有几个点）。 */
export const MIN_FIT_POINTS = 8

/** 采纳圆的半径上下限 [m]（0.02 m = 4 cm 胸径的幼树；1 m = 200 cm 的大树）。 */
export const MIN_DBH_RADIUS = 0.02
export const MAX_DBH_RADIUS = 1.0

/** 采纳圆的 rms 上限 [m]：超过它说明切片点压根不在一段树干上（树枝 / 邻树 / 灌木）。 */
export const MAX_FIT_RMS = 0.1

/** 剔除离群点的绝对下限 [m]（rms 很小时不能把阈值收到 0，否则把真点剔光）。 */
const MIN_TRIM_DISTANCE = 0.02

/** 稳健剔除的轮数上限（每轮重拟合一次）。 */
const MAX_TRIM_ROUNDS = 3

/** 胸径来源：圆拟合采纳 / 质心兜底（拟合被拒）/ 无切片。 */
export type DbhMethod = 'circle' | 'centroid' | 'none'

/** 计算质量的可见量（面板一行摘要，供判断数字可不可信）。 */
export interface TreeQuality {
  /** 胸径的来源（见 DbhMethod；'centroid' 时 dbh 恒为 0）。 */
  dbhMethod: DbhMethod
  /** 参与圆拟合的切片点数（抽样后；0 = 该高度没有点）。 */
  dbhSlicePoints: number
  /** 圆拟合最终采纳的内点数（method = 'circle' 时才有意义）。 */
  dbhInliers: number
  /** 圆拟合的 rms [m]（0 = 未拟合）。 */
  dbhRms: number
  /** 冠层点数（精确值，不受抽样影响）。 */
  crownPoints: number
}

/**
 * 一棵树的全部基础信息（= `SceneEntity.treeObject` 的存储形态）。
 * 长度单位一律 m，唯独 `dbh` 是 **cm**（沿用 CloudCompare / 林业的胸径惯例，也是既有字段的单位）。
 */
export interface TreeMetrics {
  /** 树高 [m]（最高点 − 基准高程）。 */
  height: number
  /** 胸径 [cm]（0 = 未采纳圆拟合，见 quality.dbhMethod）。 */
  dbh: number
  /** 冠幅 [m] = max(冠幅 X, 冠幅 Y)。 */
  crownWidth: number
  /** 冠幅 X 向跨度 [m]（冠层点的 x 极差）。 */
  crownWidthX: number
  /** 冠幅 Y 向跨度 [m]。 */
  crownWidthY: number
  /** 冠层底高 [m]：相对**基准点**的米数（= (1 − 冠层比例) × 树高）。 */
  crownBaseHeight: number
  /** 本次使用的胸径测量高度 [m]（存档，便于日后核对读数是在哪个高度量的）。 */
  dbhHeight: number
  /**
   * 基准点（文件原始坐标）：树高与胸径的起算点。
   * x/y 取**最低点**那个点的坐标，z 取基准高程——`baseQuantile = 0` 时三者就是同一个真正的最低点；
   * 分位基准（> 0）时 z 会略高于最低点、x/y 仍是它的位置。
   */
  basePoint: TreePoint
  /** 代表点（文件原始坐标）：胸径切片圆拟合的圆心（z = 基准 + 胸径高度）；无切片时为 null。 */
  representative: TreePoint | null
  /**
   * **冠层圈的落点**（文件原始坐标，供 3D 标记用）：x/y 取冠层点的**包围盒中心**，
   * z 取冠层底高程；冠层无点时 null。
   *
   * 中心取包围盒中心而不是质心，是为了与 `crownWidthX/Y` **严格同源**——两者出自同一对极值，
   * 于是画出来的椭圆必然关于自身对称、不会出现"圈住了但偏一边"的观感。也因此它**不占任何
   * 新增累加统计**（`finishTree` 里由已有量组装）。
   */
  crownCenter: TreePoint | null
  /** 计算质量（见 TreeQuality）。 */
  quality: TreeQuality
}

/**
 * 「这片点云算不算树」——**判据的唯一实现**（属性面板的 Tree object 区与批量计算的目标筛选共用）。
 *
 * 口径：可见点的分类**全部**落在 {4 中等植被, 5 高植被} 且至少一个点。
 * 刻意是严格口径（混进任何别的类就不算）——"分割完 → 右键标记为 4/5"那一步的动作**整体重写**分类，
 * 天然满足它；没满足就说明这片云还没被标成树（或还混着地面/建筑物残点），此时显示树高/胸径只会误导。
 * 日后若要放宽（如"≥ 95% 点 ∈ {4,5}"），是这一处的单点改动。
 *
 * @param stats 分类分布（`pointcloudStore.getClassificationStats` 的结果：类号升序的 {value, count}）
 *              未加载为 null、无分类属性为空数组，两者都不算树
 */
export function isTreeClassification(stats: readonly { value: number; count: number }[] | null): boolean {
  if (!stats || stats.length === 0) return false
  return stats.every((s) => (s.value === 4 || s.value === 5) && s.count > 0)
}

/** 累加器（逐块喂；字段全部 public 便于单测直接断言中间状态）。 */
export interface TreeAccumulator {
  /** 抽样步长（由候选总数推导，跨块共享计数器）。 */
  stride: number
  /** 趟 1：已见过的候选点数（步长计数的分母）。 */
  seen: number
  /** 趟 1：有效（z 非 NaN）点数。 */
  validCount: number
  /** 趟 1：z 极值（无有效点时为 ±Infinity，由 validCount 判断）。 */
  minZ: number
  maxZ: number
  /** 趟 1：最低点的 x/y（显示坐标；无有效点时为 NaN）。 */
  baseX: number
  baseY: number
  /** 趟 1：等距抽取的 z 样本（供基准分位数用，≤ SAMPLE_CAP 个）。 */
  zSamples: number[]
  /** finishPass1 产物：基准高程 / 冠层底高程 / 切片 z 区间（显示坐标）。 */
  baseZ: number
  crownBaseZ: number
  sliceMinZ: number
  sliceMaxZ: number
  /** 趟 2：冠层点的 xy 极值与点数（精确）。 */
  crownMinX: number
  crownMaxX: number
  crownMinY: number
  crownMaxY: number
  crownPoints: number
  /** 趟 2：切片点的 xy（抽样后）与切片内实际点数（精确）。 */
  sliceX: number[]
  sliceY: number[]
  slicePoints: number
}

/**
 * 建累加器。
 * @param candidateTotal 候选点总数（= 各块可见点数之和，调用方从 sources 算得出）。
 *                       只为推导抽样步长，不参与其它计算。
 */
export function createTreeAccumulator(candidateTotal: number): TreeAccumulator {
  return {
    // 向上取整：保证样本数**不超过** SAMPLE_CAP（向下取整会给出 ≤ SAMPLE_CAP 的步长、
    // 于是样本数反而 ≥ SAMPLE_CAP，1e6 点的大云能多抽一成）
    stride: Math.max(1, Math.ceil(candidateTotal / SAMPLE_CAP)),
    seen: 0,
    validCount: 0,
    minZ: Infinity,
    maxZ: -Infinity,
    baseX: NaN,
    baseY: NaN,
    zSamples: [],
    baseZ: 0,
    crownBaseZ: 0,
    sliceMinZ: 0,
    sliceMaxZ: 0,
    crownMinX: Infinity,
    crownMaxX: -Infinity,
    crownMinY: Infinity,
    crownMaxY: -Infinity,
    crownPoints: 0,
    sliceX: [],
    sliceY: [],
    slicePoints: 0,
  }
}

/**
 * 参数规整（钳到可用区间；对话框输入与直接调用都走它，故非法值有确定行为）。
 * 导出是给 `treeInfoStore` 用的：对话框把用户输入规整后再存，于是**界面上显示的永远是实际会用的值**
 * （否则输入 0 厚度会被静默换成 0.001，用户看到的与算出来的不一致）。
 */
export function normalizeTreeMetricsOptions(options: TreeMetricsOptions): TreeMetricsOptions {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
  return {
    dbhHeight: clamp(options.dbhHeight, 0, 20, DEFAULT_TREE_METRICS_OPTIONS.dbhHeight),
    sliceThickness: clamp(options.sliceThickness, 0.001, 5, DEFAULT_TREE_METRICS_OPTIONS.sliceThickness),
    crownRatio: clamp(options.crownRatio, 0.01, 1, DEFAULT_TREE_METRICS_OPTIONS.crownRatio),
    baseQuantile: clamp(options.baseQuantile, 0, 0.5, 0),
  }
}

/**
 * 趟 1：累加单块候选点的 z 极值与分位样本（可见点集语义，见模块注释）。
 *
 * NaN 的 z 跳过（顶点着色器同样不画它）；x/y 与 z 一起由解析器产出，正常路径不会
 * 出现"z 有效而 xy 是 NaN"，故只查 z（同 utils/elevation.ts#histogramOfZ 的取舍）。
 */
export function accumulateZ(acc: TreeAccumulator, positions: Float32Array, index: Uint32Array | null): void {
  const n = index ? index.length : Math.floor(positions.length / 3)
  for (let i = 0; i < n; i++) {
    const base = (index ? index[i] : i) * 3
    const z = positions[base + 2]
    const take = acc.seen % acc.stride === 0
    acc.seen++
    if (z !== z) continue
    if (z < acc.minZ) {
      acc.minZ = z
      acc.baseX = positions[base]
      acc.baseY = positions[base + 1]
    }
    if (z > acc.maxZ) acc.maxZ = z
    acc.validCount++
    if (take) acc.zSamples.push(z)
  }
}

/**
 * 趟 1 收尾：由 z 极值 / 分位样本定出基准高程，并据它算出冠层底与胸径切片的 z 区间。
 *
 * 树高恒从**基准高程**量起：`baseQuantile > 0` 时基准上移、树高随之变短（那正是分位基准的用途——
 * 把"去地面残留的孤立低点"从树高里剔掉）。冠层底与切片区间同理，全部相对基准。
 *
 * 分位数取自等距样本的**升序**第 ⌈q·n⌉ 个（离散定义；样本量为 1 或 q 极小时退化为最小值）。
 */
export function finishPass1(acc: TreeAccumulator, options: TreeMetricsOptions): void {
  const opt = normalizeTreeMetricsOptions(options)
  acc.seen = 0 // 趟 2 的抽样计数器重新起算（每趟各自从 0 开始，与趟 1 的相位无关）
  if (acc.validCount === 0) {
    acc.baseZ = NaN
    acc.crownBaseZ = NaN
    acc.sliceMinZ = NaN
    acc.sliceMaxZ = NaN
    return
  }
  if (opt.baseQuantile <= 0) {
    acc.baseZ = acc.minZ
  } else {
    const sorted = acc.zSamples.slice().sort((a, b) => a - b)
    const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil(opt.baseQuantile * sorted.length) - 1))
    // 分位不得越过最高点（否则树高为负）；钳到 maxZ 让退化输入仍有确定行为
    acc.baseZ = Math.min(sorted[k], acc.maxZ)
  }
  const height = acc.maxZ - acc.baseZ
  acc.crownBaseZ = acc.baseZ + (1 - opt.crownRatio) * height
  const half = opt.sliceThickness / 2
  acc.sliceMinZ = acc.baseZ + opt.dbhHeight - half
  acc.sliceMaxZ = acc.baseZ + opt.dbhHeight + half
}

/**
 * 趟 2：累加单块候选点的冠层跨度与胸径切片点（须先 `finishPass1`）。
 *
 * 冠层跨度与切片点数是**精确**统计；只有切片点按步长抽样保留（供圆拟合）。
 * 切片判据用闭区间（`≥ minZ && ≤ maxZ`），与直方图的闭区间惯例一致。
 */
export function accumulateCrown(acc: TreeAccumulator, positions: Float32Array, index: Uint32Array | null): void {
  const n = index ? index.length : Math.floor(positions.length / 3)
  for (let i = 0; i < n; i++) {
    const base = (index ? index[i] : i) * 3
    const z = positions[base + 2]
    if (z !== z) continue
    const take = acc.seen % acc.stride === 0
    acc.seen++
    if (z >= acc.crownBaseZ) {
      const x = positions[base]
      const y = positions[base + 1]
      if (x < acc.crownMinX) acc.crownMinX = x
      if (x > acc.crownMaxX) acc.crownMaxX = x
      if (y < acc.crownMinY) acc.crownMinY = y
      if (y > acc.crownMaxY) acc.crownMaxY = y
      acc.crownPoints++
    }
    if (z >= acc.sliceMinZ && z <= acc.sliceMaxZ) {
      acc.slicePoints++
      if (take) {
        acc.sliceX.push(positions[base])
        acc.sliceY.push(positions[base + 1])
      }
    }
  }
}

/** Kåsa 代数圆拟合的结果。 */
export interface KasaCircleFit {
  cx: number
  cy: number
  /** 半径 [m]。 */
  r: number
  /** 逐点到圆的距离 rms [m]。 */
  rms: number
}

/**
 * Kåsa 代数圆拟合（最小二乘，闭式解）。
 *
 * 模型 `(x−cx)² + (y−cy)² = r²` 展开成 `x² + y² = 2cx·x + 2cy·y + (r² − cx² − cy²)`，
 * 于是对 `(2cx, 2cy, c)` 是**线性**最小二乘，三点即可定解、无需迭代。
 *
 * 两条实现细节：
 * - **先平移到样本质心再解**：中心化后 Σx = Σy = 0，法方程解耦成"一个 2×2 行列式 + `c = Σz/n`"，
 *   既省一半运算，也让"点共线"的判据变成**无量纲**的相对判据——未中心化时行列式随坐标原点的
 *   量级变化，大地坐标（1e6 量级）上完全正常的圆也会算出病态值。
 * - **`r² = c + cx² + cy²`（不是 `− c`）**：这个符号在 native/ransac-cylinder 的 Kåsa 精修里踩过
 *   （见该模块 README-REF 的教训②，写错会让"系数优化"整条路径静默失效），单测用"已知圆"钉住方向。
 *
 * @param xs 切片点 x（长度 = ys）
 * @returns 点少于 3 个 / 全重合 / 全共线时返回 null（调用方据此走兜底）
 */
export function fitCircleKasa(xs: ArrayLike<number>, ys: ArrayLike<number>): KasaCircleFit | null {
  const n = xs.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let sxx = 0
  let sxy = 0
  let syy = 0
  let sxz = 0
  let syz = 0
  let sz = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx
    const y = ys[i] - my
    const z = x * x + y * y
    sxx += x * x
    sxy += x * y
    syy += y * y
    sxz += x * z
    syz += y * z
    sz += z
  }
  // 中心化后的法方程： [Sxx Sxy 0; Sxy Syy 0; 0 0 n] · (2cx', 2cy', c)ᵀ = (Sxz, Syz, Sz)ᵀ
  // ⇒ det = n·(Sxx·Syy − Sxy²)、c = Sz/n；D 就是点集协方差矩阵的行列式（×n²），
  //   共线时 D = 0，故用无量纲的 D ≤ 1e-12·tr² 判退化。
  const d = sxx * syy - sxy * sxy
  const trace = sxx + syy
  if (!(d > 1e-12 * trace * trace)) return null
  const cxl = (sxz * syy - syz * sxy) / (2 * d)
  const cyl = (sxx * syz - sxy * sxz) / (2 * d)
  const rSq = sz / n + cxl * cxl + cyl * cyl
  if (!(rSq > 0)) return null
  const r = Math.sqrt(rSq)
  const cx = cxl + mx
  const cy = cyl + my
  let sum = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx
    const dy = ys[i] - cy
    const dd = Math.sqrt(dx * dx + dy * dy) - r
    sum += dd * dd
  }
  return { cx, cy, r, rms: Math.sqrt(sum / n) }
}

/** RANSAC 迭代轮数（无离群点时几十轮就够，取 256 对齐 native/ransac-cylinder 的投票轮数量级）。 */
const CIRCLE_RANSAC_ITERATIONS = 256

/**
 * RANSAC 的**固定**种子：同一切片永远得到同一个结果。
 * 刻意不用 `Math.random()`——可复现优先于"每次多试几轮也许更好"，也是单测能断言确定性的前提。
 * 取值只是个日期，无其它含义。
 */
const CIRCLE_RANSAC_SEED = 20260926

/**
 * RANSAC 的内点带：**固定 5 mm**（不是半径的比例值）。这个常数不是随手定的——
 * 一段长 L 的点列被半径为 r 的圆"吞掉"时，圆与点列的最大偏差 ≈ L²/(16r)（弦高的一半），
 * 内点带若大于它，一个**大假圆**就能把真圆的一整圈点算成自己的内点。
 * 实测（半径 0.15 m 的树干 + 1.35 m 外一团低枝，见 spec）：带 = max(0.015, 8% r) 时
 * 假圆 r = 0.76 收到 55 个内点、真圆只有 40 个 ⇒ **选出假圆，胸径从 30 cm 变成 152 cm**。
 * 固定 5 mm 后，要吞掉 L = 0.3 m 的一圈点需要 r ≥ L²/(16 × 0.005) = 1.125 m，
 * 而假设半径又被限制在采纳区间内（见下）⇒ 该假圆在几何上不可能出现。
 * L 越大（树干越粗）越安全：所需半径按 L² 增长，早就超出 200 cm 胸径的上限。
 */
const RANSAC_BAND = 0.005

/** 确定性 LCG（常量取自 Numerical Recipes 的 32 位版本）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * 稳健圆拟合 = **RANSAC 定初始模型 → Kåsa 在内点上重解 → 2σ 迭代剔除收尾**（≤ MAX_TRIM_ROUNDS 轮）。
 *
 * 为什么不是"直接 Kåsa + 2σ 剔除"：初始拟合被离群点拉偏后，内点与外点的残差**不可分**——
 * 实测（40 个内点 + 12 个远外点）内外残差分别是 0.30 m / 0.45 m，而阈值 = max(0.02, 2·rms) = 0.68 m，
 * 于是**一个都剔不掉**、下一轮阈值还随 rms 一起膨胀（这正是本仓库在 native/ransac-cylinder 里
 * 记过的同类坑：判据不变时换个更好的输入毫无改善）。RANSAC 用"三点定圆 + 数内点"绕过它：
 * 无噪数据上三点精确决定圆，故真圆必然是候选之一，与离群点比例无关（50% 离群点 / 256 轮 ≈ 99.9% 命中）。
 *
 * 打分是**字典序**（先比内点数，再比内点的残差平方和）：内点数相同时选更贴合的。
 * 这在细枝切片上必要——那里几十个大圆都能把点"框"进内点带，只有真圆残差最小。
 * 搜索域 = 采纳区间（`[MIN_DBH_RADIUS, MAX_DBH_RADIUS]`，区间外的圆永远不会被采纳，
 * 让它参与竞争只会有害）；内点带固定 5 mm（理由见 `RANSAC_BAND`）。
 *
 * @returns 拟合结果 + 内点数（= 最终重解所用的点数）；点太少 / 共线 / 无有效假设时返回 null
 */
export function fitCircleRobust(xs: number[], ys: number[]): { fit: KasaCircleFit; inliers: number } | null {
  const n = xs.length
  if (n < 3) return null
  const rng = makeRng(CIRCLE_RANSAC_SEED)
  let bestCount = -1
  let bestCost = Infinity
  let bestIndices: number[] | null = null
  for (let iter = 0; iter < CIRCLE_RANSAC_ITERATIONS; iter++) {
    // 抽三个不同的下标（重复就重抽；n ≥ 3 时 32 次里抽不满的概率可忽略，抽不满就跳过本轮）
    const pick: number[] = []
    for (let tries = 0; tries < 32 && pick.length < 3; tries++) {
      const i = Math.floor(rng() * n)
      if (i >= 0 && i < n && !pick.includes(i)) pick.push(i)
    }
    if (pick.length < 3) continue
    const hyp = fitCircleKasa([xs[pick[0]], xs[pick[1]], xs[pick[2]]], [ys[pick[0]], ys[pick[1]], ys[pick[2]]])
    if (!hyp || !Number.isFinite(hyp.cx) || !Number.isFinite(hyp.cy)) continue
    // 只搜"能被采纳"的圆：区间外的假设即便收满内点也会在 finishTree 里被丢掉，
    // 让它参与竞争只会挤掉真正的答案（见 RANSAC_BAND 注释里的那个反例）
    if (hyp.r < MIN_DBH_RADIUS || hyp.r > MAX_DBH_RADIUS) continue
    const band = RANSAC_BAND
    let count = 0
    let cost = 0
    const idx: number[] = []
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - hyp.cx
      const dy = ys[i] - hyp.cy
      const dev = Math.abs(Math.sqrt(dx * dx + dy * dy) - hyp.r)
      if (dev <= band) {
        count++
        cost += dev * dev
        idx.push(i)
      }
    }
    if (count > bestCount || (count === bestCount && cost < bestCost)) {
      bestCount = count
      bestCost = cost
      bestIndices = idx
    }
  }
  if (!bestIndices || bestIndices.length < 3) return null
  let idx = bestIndices
  let fit = fitCircleKasa(
    idx.map((i) => xs[i]),
    idx.map((i) => ys[i])
  )
  if (!fit) return null
  // 收尾：2σ 迭代剔除。此时初始模型已落在真圆上，阈值不再被离群点膨胀，这一轮才真正有效。
  for (let round = 0; round < MAX_TRIM_ROUNDS; round++) {
    const limit = Math.max(MIN_TRIM_DISTANCE, 2 * fit.rms)
    const kept: number[] = []
    for (const i of idx) {
      const dx = xs[i] - fit.cx
      const dy = ys[i] - fit.cy
      if (Math.abs(Math.sqrt(dx * dx + dy * dy) - fit.r) <= limit) kept.push(i)
    }
    if (kept.length === idx.length || kept.length < 3) break // 没有可剔的 / 剔到解不出圆
    const next = fitCircleKasa(
      kept.map((i) => xs[i]),
      kept.map((i) => ys[i])
    )
    if (!next) break
    idx = kept
    fit = next
  }
  return { fit, inliers: idx.length }
}

/**
 * 组装结果（须先跑完趟 1 与趟 2）。无有效点返回 null（调用方当作"不可算"）。
 *
 * 圆拟合的采纳判据（三条全过才采纳，否则 `dbhMethod = 'centroid'`、`dbh = 0`）：
 * 内点数 ≥ MIN_FIT_POINTS、半径 ∈ [MIN_DBH_RADIUS, MAX_DBH_RADIUS]、rms ≤ MAX_FIT_RMS。
 * 切片为空（矮树 / 稀疏云）时 `dbhMethod = 'none'`、代表点 null。
 *
 * @param globalShift 显示坐标 → 文件原始坐标的平移（= `rec.globalShift`）。**只作用在
 *                    basePoint / representative 两个点上**，其余量都是差值，平移无关。
 */
export function finishTree(
  acc: TreeAccumulator,
  options: TreeMetricsOptions,
  globalShift: { x: number; y: number; z: number }
): TreeMetrics | null {
  const opt = normalizeTreeMetricsOptions(options)
  if (acc.validCount === 0) return null
  const height = acc.maxZ - acc.baseZ
  const crownWidthX = acc.crownPoints > 0 ? acc.crownMaxX - acc.crownMinX : 0
  const crownWidthY = acc.crownPoints > 0 ? acc.crownMaxY - acc.crownMinY : 0

  let dbh = 0
  let dbhMethod: DbhMethod = 'none'
  let dbhInliers = 0
  let dbhRms = 0
  let representative: TreePoint | null = null
  if (acc.slicePoints > 0) {
    // 兜底值：切片质心（拟合被拒时仍给一个"树干在哪"的位置；它比 null 有用，
    // 但质量行会明说这是质心不是圆心）
    let cx = 0
    let cy = 0
    for (let i = 0; i < acc.sliceX.length; i++) {
      cx += acc.sliceX[i]
      cy += acc.sliceY[i]
    }
    cx /= acc.sliceX.length
    cy /= acc.sliceY.length
    dbhMethod = 'centroid'
    representative = { x: cx + globalShift.x, y: cy + globalShift.y, z: acc.baseZ + opt.dbhHeight + globalShift.z }

    const robust = fitCircleRobust(acc.sliceX, acc.sliceY)
    if (robust) {
      const { fit, inliers } = robust
      dbhRms = fit.rms
      dbhInliers = inliers
      const accepted =
        inliers >= MIN_FIT_POINTS && fit.r >= MIN_DBH_RADIUS && fit.r <= MAX_DBH_RADIUS && fit.rms <= MAX_FIT_RMS
      if (accepted) {
        dbh = 2 * fit.r * 100 // cm
        dbhMethod = 'circle'
        // 圆心高程仍取切片中心高程（圆是 xy 平面上的拟合，z 由切片定义）
        representative = {
          x: fit.cx + globalShift.x,
          y: fit.cy + globalShift.y,
          z: acc.baseZ + opt.dbhHeight + globalShift.z,
        }
      }
    }
  }

  return {
    height,
    dbh,
    crownWidth: Math.max(crownWidthX, crownWidthY),
    crownWidthX,
    crownWidthY,
    crownBaseHeight: acc.crownBaseZ - acc.baseZ,
    dbhHeight: opt.dbhHeight,
    basePoint: { x: acc.baseX + globalShift.x, y: acc.baseY + globalShift.y, z: acc.baseZ + globalShift.z },
    representative,
    // 冠层圈（3D 标记）的落点：包围盒中心 + 冠层底高程。全取自已有累加量，零额外遍历。
    crownCenter:
      acc.crownPoints > 0
        ? {
            x: (acc.crownMinX + acc.crownMaxX) / 2 + globalShift.x,
            y: (acc.crownMinY + acc.crownMaxY) / 2 + globalShift.y,
            z: acc.crownBaseZ + globalShift.z,
          }
        : null,
    quality: {
      dbhMethod,
      dbhSlicePoints: acc.slicePoints,
      dbhInliers,
      dbhRms,
      crownPoints: acc.crownPoints,
    },
  }
}
