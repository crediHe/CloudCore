import { srgbU8ToLinear } from './srgb'

/**
 * 高程着色（Elevation 着色模式 + 属性面板高程分布图）的纯函数层。
 *
 * 三条口径，改动前务必先读：
 *  - **高程取显示坐标的 z**：内存里的 positions 是显示坐标（原始 − globalShift），
 *    Group 带 `rotation.x = -π/2`，故高程就是局部 z；而实体的 `rec.bbox` 是**原始**坐标。
 *    换算只允许经过 `elevationAxis()` 一处——否则色带整体偏移一个 globalShift.z，
 *    而画面照样出颜色、不报错。
 *  - **颜色是线性字节**：顶点色属性必须写线性值（three r152+ 色彩管理，直接写 sRGB 码
 *    会发白发淡），故色带先按 sRGB 码定义、构建时经 srgbU8ToLinear 转成线性字节，
 *    与 utils/classColors.ts 的 buildScalarColors 同一口径。
 *  - **分箱与色带共用一个索引**：`ELEVATION_BINS` 既是直方图的箱数、也是色带的项数，
 *    两者对 t 的取整方式逐字相同，于是「带内点数」与「非端点色的点数」恒等
 *    （手柄吸附到箱边界，见 ElevationChart）。
 *
 * 本模块不碰 three / DOM / store，可在 node 环境直接单测。
 */

/** 分箱数 = 色带项数（0..255 箱，同一条 t → 索引的取整规则）。 */
export const ELEVATION_BINS = 256

/**
 * 色带锚点（**sRGB** 0-255，满饱和度彩虹，对齐 CloudCompare 的默认 Blue>Green>Red）。
 *
 * 为什么坚持满饱和：颜色属性是 8 位**线性**量化，若色带某段所有通道都低（深蓝黑等），
 * 线性空间下会被压成几个台阶、肉眼可见（同 three/lodRenderer.ts 的注释所指）；
 * 而本表每两个相邻锚点的插值结果**至少有一个通道停在 255**（蓝段压蓝、青段压绿、
 * 黄段压红），于是线性字节恒有 255 这一通道，量化误差只落在另两个通道上，不可察。
 */
export const ELEVATION_RAMP_ANCHORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 255], // 最低（纯蓝）
  [0, 128, 255], // 蓝青
  [0, 255, 255], // 青
  [0, 255, 128], // 青绿
  [0, 255, 0], // 绿（中段）
  [128, 255, 0], // 黄绿
  [255, 255, 0], // 黄
  [255, 128, 0], // 橙
  [255, 0, 0], // 最高（纯红）
] as const

/** 锚点插值成 256 项 sRGB 字节表（长度 256 × 3；UI 图例与 LUT 构建共用）。 */
export function buildElevationRampSrgb(): Uint8Array {
  const anchors = ELEVATION_RAMP_ANCHORS
  const last = anchors.length - 1
  const out = new Uint8Array(ELEVATION_BINS * 3)
  for (let k = 0; k < ELEVATION_BINS; k++) {
    const t = (k / (ELEVATION_BINS - 1)) * last
    const i = Math.min(Math.floor(t), last - 1)
    const f = t - i
    const a = anchors[i]
    const b = anchors[i + 1]
    out[k * 3] = Math.round(a[0] + (b[0] - a[0]) * f)
    out[k * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * f)
    out[k * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f)
  }
  return out
}

/**
 * 色带 LUT（长度 256 × 3 的**线性**字节，喂给顶点色属性用）。
 * 纯函数（同输入恒同输出），模块内的缓存见 getElevationLut。
 */
export function buildElevationLut(): Uint8Array {
  const srgb = buildElevationRampSrgb()
  const lut = new Uint8Array(ELEVATION_BINS * 3)
  for (let i = 0; i < srgb.length; i++) {
    lut[i] = Math.round(srgbU8ToLinear(srgb[i]) * 255)
  }
  return lut
}

let elevationLutCache: Uint8Array | null = null

/** 模块级缓存的色带 LUT（只建一次，所有实体共用；同 utils/normalEstimate 的 LUT 惯例）。 */
export function getElevationLut(): Uint8Array {
  if (!elevationLutCache) elevationLutCache = buildElevationLut()
  return elevationLutCache
}

/**
 * 色带的 CSS 渐变串（属性面板的色带条直接用，免去组件里再插一次值）。
 * 取锚点而非 256 项表：浏览器自己做插值，串更短。
 */
export const ELEVATION_RAMP_CSS =
  'linear-gradient(90deg, ' +
  ELEVATION_RAMP_ANCHORS.map(
    ([r, g, b], i) => `rgb(${r} ${g} ${b}) ${((i / (ELEVATION_RAMP_ANCHORS.length - 1)) * 100).toFixed(1)}%`
  ).join(', ') +
  ')'

/** 高程轴（**显示坐标** z 的满量程）。 */
export interface ElevationAxis {
  min: number
  max: number
}

/**
 * 高程分布直方图（属性面板图表用）：轴 + 箱计数 + 计入点数。
 * 轴恒为**满量程**（见 elevationAxis），与手柄拖出来的范围无关——分箱跟着范围走的话，
 * 拖动时整张图会跟着缩放（手柄在动、柱子在跳）。
 */
export interface ElevationHistogram {
  /** 满量程轴（显示坐标）；手柄吸附与读数都以它为准 */
  axis: ElevationAxis
  /** 箱计数，长度 ELEVATION_BINS，箱主序（低 → 高） */
  bins: Uint32Array
  /** 实际计入的点数（= 可见点数 − NaN 点数） */
  total: number
}

/**
 * 实体的高程轴：由**原始坐标**包围盒减去全局平移得到显示坐标区间（唯一的换算点）。
 * @param bbox 实体包围盒（原始坐标，rec.bbox / SceneEntity.bbox）
 * @param globalShift 全局平移（显示坐标 = 原始坐标 − globalShift）
 */
export function elevationAxis(bbox: { minZ: number; maxZ: number }, globalShift: { z: number }): ElevationAxis {
  return { min: bbox.minZ - globalShift.z, max: bbox.maxZ - globalShift.z }
}

/**
 * 把"用户拖出来的范围"规整成可用的色带范围（图表与着色都调它，故两侧显示恒一致）。
 *
 * 规整规则（顺序即优先级）：
 *  - `null` / 非有限值 → 满量程（= 「正常的 Z 最高最低着色」，也是默认态）；
 *  - 轴退化（跨度为 0 或非有限）→ 原样返回（着色会退化到单一颜色，不产生 NaN）；
 *  - 倒置（min > max）→ 互换；
 *  - 完全落在轴外 → 满量程（宁可回到默认，也不要一片纯端色）；
 *  - 部分越界 → 钳到轴内；
 *  - 跨度不足一箱 → 以中心为准扩到一箱再夹回轴内（保证 hi > lo，除零与纯色两头都避掉）。
 */
export function normalizeElevationRange(
  axis: ElevationAxis,
  requested: { min: number; max: number } | null
): ElevationAxis {
  const full: ElevationAxis = { min: axis.min, max: axis.max }
  const span = axis.max - axis.min
  if (!(span > 0) || !Number.isFinite(span)) return full
  if (!requested) return full
  if (!Number.isFinite(requested.min) || !Number.isFinite(requested.max)) return full

  const rawLo = Math.min(requested.min, requested.max)
  const rawHi = Math.max(requested.min, requested.max)
  if (rawHi < axis.min || rawLo > axis.max) return full

  let lo = Math.max(axis.min, rawLo)
  let hi = Math.min(axis.max, rawHi)
  const minSpan = span / ELEVATION_BINS
  if (hi - lo < minSpan) {
    const center = (lo + hi) / 2
    lo = center - minSpan / 2
    hi = center + minSpan / 2
    if (lo < axis.min) {
      lo = axis.min
      hi = axis.min + minSpan
    }
    if (hi > axis.max) {
      hi = axis.max
      lo = axis.max - minSpan
    }
  }
  return { min: lo, max: hi }
}

/**
 * 高程直方图：把可见点集的 z 分箱累加进 `out`（长度 ELEVATION_BINS，调用方负责清零）。
 *
 * **可见点集**口径与 getNormalStats / getClassificationStats 一致：带 index 的块按索引条目
 * 取顶点、无 index 的块取全量顶点。这条是「滤波产物显示母云分布」那类事故的防线——
 * 分割/滤波产物与母云共享同一份 position 缓冲，只有按 index 取才是它自己的点。
 *
 * 轴外点（只可能出现在预览期，预览索引恒为已提交集合的子集）钳进端点箱，保证
 * 计数之和 = 可见点数；**NaN 点跳过**（顶点着色器同样不画它，计入只会虚增端点箱）。
 * 闭区间语义：z === axis.max 落最后一箱。
 *
 * @returns 实际计入的点数（= 可见点数 − NaN 点数）
 */
export function histogramOfZ(
  positions: Float32Array,
  index: Uint32Array | null,
  axis: ElevationAxis,
  out: Uint32Array
): number {
  const span = axis.max - axis.min
  const n = index ? index.length : Math.floor(positions.length / 3)
  if (!(span > 0)) {
    // 退化轴（水平云 / 单点云）：全部计进首箱，图表仍画得出来
    let counted = 0
    for (let i = 0; i < n; i++) {
      const z = positions[(index ? index[i] : i) * 3 + 2]
      if (z !== z) continue
      out[0]++
      counted++
    }
    return counted
  }
  let counted = 0
  for (let i = 0; i < n; i++) {
    const z = positions[(index ? index[i] : i) * 3 + 2]
    if (z !== z) continue // NaN：无效点
    const t = (z - axis.min) / span
    // 与 fillElevationColors 逐字相同的取整（两处必须同改，否则"带内点数"与上色对不上）
    const b = t >= 1 ? ELEVATION_BINS - 1 : t > 0 ? (t * ELEVATION_BINS) | 0 : 0
    out[b]++
    counted++
  }
  return counted
}

/**
 * 逐点填高程色（**全顶点**，与 index 无关——颜色是"每顶点"数据，由 index/drawRange 决定
 * 显示哪批，同 ensureScalarColorAttrs 的惯例）。
 *
 * 范围外的点压成端点色（clamp，对齐 CloudCompare 的 SF 显示参数：不隐藏、不变灰）；
 * NaN 的 z 落到首箱（= 最低色），不会写坏缓冲。
 *
 * @param out 长度必须 ≥ 顶点数 × 3
 */
export function fillElevationColors(
  positions: Float32Array,
  lo: number,
  hi: number,
  lut: Uint8Array,
  out: Uint8Array
): void {
  const n = Math.floor(positions.length / 3)
  const span = hi - lo
  const inv = span > 0 ? 1 / span : 0
  for (let i = 0; i < n; i++) {
    const z = positions[i * 3 + 2]
    const t = (z - lo) * inv
    const b = t >= 1 ? ELEVATION_BINS - 1 : t > 0 ? (t * ELEVATION_BINS) | 0 : 0
    const src = b * 3
    const dst = i * 3
    out[dst] = lut[src]
    out[dst + 1] = lut[src + 1]
    out[dst + 2] = lut[src + 2]
  }
}

/**
 * 直方图落在 `[lo, hi]` 内的点数（= 色带范围内点数，属性面板读数用）。
 * 手柄吸附到轴箱边界（见 ElevationChart），故这里的箱级判定与逐点判定一致。
 */
export function countInRange(bins: Uint32Array, axis: ElevationAxis, lo: number, hi: number): number {
  const span = axis.max - axis.min
  if (!(span > 0)) return bins[0]
  const first = binIndexOf(lo, axis, span)
  const last = binIndexOf(hi, axis, span)
  let total = 0
  for (let b = first; b <= last; b++) total += bins[b]
  return total
}

/** 值 → 轴箱号（与 histogramOfZ 同一取整规则；越界钳到端点箱）。 */
export function binIndexOf(z: number, axis: ElevationAxis, span?: number): number {
  const s = span ?? axis.max - axis.min
  if (!(s > 0)) return 0
  const t = (z - axis.min) / s
  return t >= 1 ? ELEVATION_BINS - 1 : t > 0 ? (t * ELEVATION_BINS) | 0 : 0
}
