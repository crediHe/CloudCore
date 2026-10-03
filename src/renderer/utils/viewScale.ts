/**
 * 3D 视图「屏幕恒定尺寸」的纯数学：右下角缩放距离标尺 + 旋转中心符号。
 *
 * 纯函数、零依赖（不碰 three/DOM，仅复用 cameraProjection 的正切），
 * 供浮层模块 viewOverlays.ts、测量拾取 measure.ts、旋转中心 viewingPivot.ts
 * 与单测复用。两者共用同一个世界/像素换算本源（见下）。
 *
 * 标尺部分（仿 CloudCompare drawScale）：
 *
 * CC 语义（CloudCompare libs/qCC_glWindow/src/ccGLWindowInterface.cpp）：
 *  - 标尺只在正射模式显示（源码中 drawScale 有 assert(!perspectiveView)）——
 *    透视下"像素对应多少世界单位"随深度变化，无单一换算；
 *  - 换算：世界单位/像素 = 2·有效半高/画布高（正射有效半高 = top/zoom，
 *    three 约定 updateProjectionMatrix 用 1/zoom 缩放 bounds）；
 *  - 取整：把"视口宽 25% 对应的世界宽度"按 granularity=10^k/2 向下取整
 *    （RoundScale，CC 源码 4334 行起，6 行），避免小数过多；
 *  - 标签：纯数字、不带单位（点云单位未知，米/毫米均可能）。
 */

import { tanHalfFov } from './cameraProjection'

/** CC RoundScale：把等效宽度取整为 granularity=10^k/2 的倍数（k=⌊log₁₀w⌋）。 */
export function roundScale(equivalentWidth: number): number {
  const k = Math.floor(Math.log(equivalentWidth) / Math.log(10))
  const granularity = Math.pow(10, k) / 2
  return Math.floor(Math.max(equivalentWidth / granularity, 1)) * granularity
}

/**
 * 数值标签格式化：按数量级推导所需小数位（最多 1−k 位），
 * toFixed 后裁掉末尾 0，规避 0.05 这类浮点乘积累积出的长尾（0.65000000000000003）。
 * 非法输入（非有限/≤0）返回空串，调用方此时应隐藏标尺。
 */
export function formatScaleValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const k = Math.floor(Math.log(value) / Math.log(10))
  const decimals = Math.max(0, 1 - k)
  const fixed = value.toFixed(decimals)
  return decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed
}

/**
 * 正射模式下的世界单位/像素换算。
 * 有效可视范围 = bounds/zoom（vertical half = top/zoom）对应画布高的一半，
 * 故 wpp = 2·(top/zoom)/cssHeight。zoom≤0 为非法输入（同 perspectiveDistanceFromOrtho 约定）。
 */
export function worldPerPixelOrtho(orthoTop: number, zoom: number, cssHeightPx: number): number {
  return (2 * orthoTop) / (zoom * cssHeightPx)
}

/**
 * 透视模式下"深度 d 处 1 CSS 像素对应的世界长度"。
 * 深度 d 处可见半高 = d·tan(fov/2)，对应画布高的一半，故 wpp = 2·d·tan(fov/2)/cssHeight。
 * 注意与正射不同，该值随深度变化——调用方（测量拾取）须给出目标处的估计深度。
 */
export function worldPerPixelPerspective(fovDeg: number, depth: number, cssHeightPx: number): number {
  return (2 * depth * tanHalfFov(fovDeg)) / cssHeightPx
}

// ---------------------------------------------------------------------------
// 旋转中心（pivot）符号的屏幕尺寸
// ---------------------------------------------------------------------------

/**
 * 旋转中心符号的环半径占"最短视口边"的比例（CC 常量，源码行 77）。
 * 该值 0.8 为 CC 原值：800px 的视口下环半径约 320px，观感上环几乎铺满视口——
 * 这是 CC 的原本面貌，嫌大只改这一个数。
 */
export const PIVOT_RING_RADIUS_PERCENT = 0.8

/**
 * 旋转中心球体的屏幕半径（CSS 像素）。
 * CC drawPivot 用 `ccSphere(10.0 / symbolRadius)` 建球，乘上总缩放后世界半径
 * = 10 × 世界单位每像素，即屏幕上恒为 10px 半径——与相机距离、视口尺寸无关。
 */
export const PIVOT_BALL_RADIUS_PX = 10

/** 旋转中心符号的环屏幕半径（CSS 像素）= 0.8 × min(宽, 高) / 2。 */
export function pivotRingRadiusPx(cssWidthPx: number, cssHeightPx: number): number {
  return (PIVOT_RING_RADIUS_PERCENT * Math.min(cssWidthPx, cssHeightPx)) / 2
}

/** 标尺绘制参数：世界长度 value、数字标签 label、CSS 像素宽度 widthCssPx。 */
export interface ScaleBarSpec {
  value: number
  label: string
  widthCssPx: number
}

/**
 * 计算右下角缩放距离标尺（仅正射模式调用，透视下返回 null——CC 同款约束）。
 * 目标宽度 = 视口宽 25%（CC 的 scaleMaxW）；取整后按 wpp 反算实际像素宽，
 * 取值离散化使宽度落在目标宽度的约 50%~100% 区间内（与 CC 一致）。
 * @param cssWidthPx 容器 CSS 像素宽
 * @param cssHeightPx 容器 CSS 像素高
 * @param orthoTop 正射相机 top（zoom=1 时半高）
 * @param zoom 正射相机 zoom（滚轮缩放）
 */
export function computeOrthoScaleBar(
  cssWidthPx: number,
  cssHeightPx: number,
  orthoTop: number,
  zoom: number,
): ScaleBarSpec | null {
  if (!(orthoTop > 0) || !(zoom > 0) || !(cssWidthPx > 0) || !(cssHeightPx > 0)) return null
  const wpp = worldPerPixelOrtho(orthoTop, zoom, cssHeightPx)
  const value = roundScale(cssWidthPx * 0.25 * wpp)
  return { value, label: formatScaleValue(value), widthCssPx: value / wpp }
}
