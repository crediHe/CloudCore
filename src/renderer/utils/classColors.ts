import { srgbU8ToLinear } from './srgb'

/**
 * 点云分类着色（Scalar field 着色模式的默认色带）与分类命名。
 * 纯函数，便于单元测试。
 *
 * 色表与输出字节的语义分工：
 *  - CLASS_COLORS 保持"显示语义的 sRGB 码"（0-255），UI 图例 / 属性面板
 *    统计色块直接拿来当 CSS 颜色显示不串味；
 *  - buildScalarColors 输出的是喂给 three 顶点色属性的**线性字节**
 *    （three r185 默认色彩管理：属性值按线性采样、输出端 sRGB 编码，
 *    直接写 sRGB 码会发白发淡，见 utils/srgb.ts），故内部先解码再量化。
 *
 * 名称与配色以项目分类表为准（0-21 为行业自定义语义，与 ASPRS 标准表
 * 含义不同，如 10 屋顶 / 14 河流 / 15 导线 / 16 电力塔）：统计、设值
 * 快捷列表、着色同源同色，避免"图例色 ≠ 渲染色"。
 */

/**
 * 项目分类 0-21 的标准配色（0-255 整数 **sRGB**，显示语义）。
 * 表外分类（22-255）由 userClassColor 确定性生成色兜底，见该函数注释。
 */
export const CLASS_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 255, 255], // 0  未定义点
  [255, 0, 0], // 1  未分类点
  [0, 255, 0], // 2  地面点
  [0, 0, 255], // 3  低植被
  [255, 255, 0], // 4  中等植被
  [255, 0, 255], // 5  高植被
  [0, 255, 255], // 6  建筑物
  [128, 0, 0], // 7  低点
  [0, 128, 0], // 8  关键点
  [0, 0, 128], // 9  水体
  [128, 128, 0], // 10 屋顶
  [128, 0, 128], // 11 保留字段
  [0, 128, 128], // 12 孤立点
  [192, 192, 192], // 13 铁轨
  [128, 128, 128], // 14 河流
  [255, 165, 0], // 15 导线
  [128, 0, 64], // 16 电力塔
  [64, 128, 0], // 17 电力线
  [0, 64, 128], // 18 道路面
  [128, 64, 0], // 19 杆状物
  [0, 102, 204], // 20 交通标志
  [255, 102, 0], // 21 堆方体点
] as const

/** 项目分类 0-21 的标准名称（与 CLASS_COLORS 按类号对齐）。 */
export const CLASS_NAMES: readonly string[] = [
  '未定义点', // 0
  '未分类点', // 1
  '地面点', // 2
  '低植被', // 3
  '中等植被', // 4
  '高植被', // 5
  '建筑物', // 6
  '低点', // 7
  '关键点', // 8
  '水体', // 9
  '屋顶', // 10
  '保留字段', // 11
  '孤立点', // 12
  '铁轨', // 13
  '河流', // 14
  '导线', // 15
  '电力塔', // 16
  '电力线', // 17
  '道路面', // 18
  '杆状物', // 19
  '交通标志', // 20
  '堆方体点', // 21
]

/**
 * 分类值 → 显示名：0-21 查标准名称表；22-63 为保留区、64-255 为
 * 用户自定义区，带编号兜底（LAS 1.4 格式 6-10 的完整 8 位分类字节，
 * 不截断不串名，见 pointcloudStore.parseLasChunk）。
 */
export function className(value: number): string {
  if (value < CLASS_NAMES.length) return CLASS_NAMES[value]
  return value <= 63 ? `保留 ${value}` : `自定义 ${value}`
}

/**
 * 分类值 → CSS 背景色（UI 色块用，属性面板统计行 / 右键设值快捷列表）：
 * 0-21 查色表、22-255 走确定性生成色，与 scalar 着色同源同色（图例色 = 渲染色）。
 */
export function classColorCss(value: number): string {
  const [r, g, b] = value < CLASS_COLORS.length ? CLASS_COLORS[value] : userClassColor(value)
  return `rgb(${r} ${g} ${b})`
}

/** 色相旋转黄金角（度）：任意取色数量都能把相邻类的色相差拉开。 */
const GOLDEN_ANGLE_DEG = 137.50776405003785
/** 生成色（分类 22-255）的固定饱和度与明度（0-1）：鲜艳但不过曝。 */
const USER_CLASS_SATURATION = 0.8
const USER_CLASS_VALUE = 0.95

/**
 * 项目色表（0-21）之外的确定性补充色（22-63 为 LAS 保留区、64-255 为
 * 用户自定义区，LAS 1.4 格式 6-10 的完整 8 位分类字节可携带）。
 * 色相以 32 为原点按黄金角旋转生成（保留既存 32+ 取色的稳定性）：
 * 每个值一色、跨值不串色、可复现（同一分类值永远同色，UI 图例可稳定取用）。
 * 返回 sRGB 显示码（0-255 整数），与 CLASS_COLORS 同一语义。
 */
export function userClassColor(value: number): [number, number, number] {
  const hue = ((((value - 32) * GOLDEN_ANGLE_DEG) % 360) + 360) % 360
  const s = USER_CLASS_SATURATION
  const v = USER_CLASS_VALUE
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  let rgb: [number, number, number]
  if (hue < 60) rgb = [c, x, 0]
  else if (hue < 120) rgb = [x, c, 0]
  else if (hue < 180) rgb = [0, c, x]
  else if (hue < 240) rgb = [0, x, c]
  else if (hue < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)]
}

/**
 * 由分类数组生成逐点顶点色（**线性** 0-255 字节，长度 n*3；normalized 属性
 * 归一化后即 three 顶点色要求的线性值，见模块注释）。
 * 分类值在色表范围内查显式色表（CLASS_COLORS 覆盖 0-21）；
 * 超出范围（即 22-255，LAS 1.4 格式 6-10 的完整 8 位分类字节不在此截断，
 * 见 pointcloudStore.parseLasChunk）走 userClassColor 确定性生成色兜底。
 * 8 位量化线性值对暗色的误差 ≤1/255（离散色阶，人眼不可察），换来与
 * rgb 路径一致的 Float32 四分之一内存；追求无量化损耗可改 Float32Array。
 */
export function buildScalarColors(
  classification: Uint8Array,
  palette: ReadonlyArray<readonly [number, number, number]> = CLASS_COLORS
): Uint8Array {
  const colors = new Uint8Array(classification.length * 3)
  for (let i = 0; i < classification.length; i++) {
    const v = classification[i]
    const [r, g, b] = v < palette.length ? palette[v] : userClassColor(v)
    colors[i * 3] = Math.round(srgbU8ToLinear(r) * 255)
    colors[i * 3 + 1] = Math.round(srgbU8ToLinear(g) * 255)
    colors[i * 3 + 2] = Math.round(srgbU8ToLinear(b) * 255)
  }
  return colors
}
