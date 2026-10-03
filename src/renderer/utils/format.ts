/**
 * 属性面板数值格式化（格式仿 CloudCompare Properties）。
 * 全部为纯函数，便于单元测试。
 */

/** 固定小数位格式化；NaN/Infinity 防御，非法值显示占位符。 */
export function fmtFixed(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

/** 千分位（如 38,620,446）。 */
export function fmtThousands(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : '—'
}

/**
 * **可空**数值的可编辑字段显示（如 Tree object 三个输入框、树心点三格）：
 * `null` / `undefined` / NaN 一律空串——输入框留空 + `placeholder="—"` 表达"没有这个数"，
 * 而**不是**显示 0.00（"没算过"与"算出来是 0"是两种状态，显示成一样的会误导）。
 * 非空值按 `digits` 位小数显示（默认 2 位；**存储仍是全精度**，只有显示被舍入）。
 */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return ''
  return v.toFixed(digits)
}

/**
 * 单轴包围盒尺寸行：`X: 140.023 (-56.540 : 83.483)`
 * @param size 该轴跨度（max−min，3 位小数）
 * @param min 该轴范围下界（显示坐标，3 位小数）
 * @param max 该轴范围上界（显示坐标，3 位小数）
 */
export function fmtAxisDimensionLine(axis: string, size: number, min: number, max: number, digits = 3): string {
  return `${axis}: ${fmtFixed(size, digits)} (${fmtFixed(min, digits)} : ${fmtFixed(max, digits)})`
}

/** 三个轴拼接成一行：`X: 1.2345  Y: 6.7890  Z: 1.2345`（默认 4 位小数）。 */
export function fmtAxisCenter(c: { x: number; y: number; z: number }, digits = 4): string {
  return `X: ${fmtFixed(c.x, digits)}  Y: ${fmtFixed(c.y, digits)}  Z: ${fmtFixed(c.z, digits)}`
}

/** 显示坐标系包围盒中心（默认 4 位小数）。 */
export function fmtShiftedCenter(c: { x: number; y: number; z: number }): string {
  return fmtAxisCenter(c, 4)
}

/** 全局（文件原始坐标）包围盒中心（默认 6 位小数）。 */
export function fmtGlobalCenter(c: { x: number; y: number; z: number }): string {
  return fmtAxisCenter(c, 6)
}

/**
 * 全局平移（CC 显示的是取负后的偏移）：
 * `(-490482.00;-3385748.00;0.00)` —— 分号分隔、2 位小数、外层括号。
 */
export function fmtGlobalShift(s: { x: number; y: number; z: number }): string {
  return `(${fmtFixed(-s.x, 2)};${fmtFixed(-s.y, 2)};${fmtFixed(-s.z, 2)})`
}
