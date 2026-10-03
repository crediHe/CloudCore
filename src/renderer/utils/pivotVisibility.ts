/**
 * 旋转中心符号的可见性档位（纯数据 + 纯函数，零 three/DOM 依赖）。
 *
 * 对位 CloudCompare 的 `ccGLWindowInterface::PivotVisibility`
 * （CloudCompare-master libs/qCC_glWindow/include/ccGLWindowInterface.h:135）：
 *   PIVOT_HIDE → 'hide'、PIVOT_SHOW_ON_MOVE → 'onMove'、PIVOT_ALWAYS_SHOW → 'always'，
 * 默认值取 CC 同款 `PIVOT_SHOW_ON_MOVE`（同文件 src 的 297 行）。
 *
 * 与 utils/viewDirections.ts 同一形状（类型 + 数据 + 纯函数），供 store 与
 * UI 组件 import——这样 viewerStore / ViewToolBar 都不必在运行时碰 three。
 * 符号本身的绘制在 three/viewingPivot.ts。
 */

export type PivotVisibility = 'hide' | 'onMove' | 'always'

/** 默认档（CC 默认 SHOW_ON_MOVE：只在拖动旋转时浮现）。 */
export const DEFAULT_PIVOT_VISIBILITY: PivotVisibility = 'onMove'

/**
 * 循环顺序（工具栏按钮每点一次前进一档）。
 * 从默认档 onMove 出发先给"更显眼"的 always——用户的诉求本就是"想看清楚它"，
 * 第一次点击就该看见变化；再 off，再回到 onMove。
 */
export const PIVOT_VISIBILITY_CYCLE: readonly PivotVisibility[] = ['onMove', 'always', 'hide']

/** 各档的中文标签（工具栏 title 用）。 */
export const PIVOT_VISIBILITY_LABELS: Record<PivotVisibility, string> = {
  hide: '隐藏',
  onMove: '仅旋转时显示',
  always: '始终显示',
}

/** 按 PIVOT_VISIBILITY_CYCLE 前进一档。 */
export function nextPivotVisibility(mode: PivotVisibility): PivotVisibility {
  const index = PIVOT_VISIBILITY_CYCLE.indexOf(mode)
  return PIVOT_VISIBILITY_CYCLE[(index + 1) % PIVOT_VISIBILITY_CYCLE.length]
}
