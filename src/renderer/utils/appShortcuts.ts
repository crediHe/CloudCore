/**
 * 应用级快捷键表（**纯数据 + 纯匹配**，不碰 DOM / three / store）。
 *
 * 为什么单独成文件，而不是把组合键直接写进监听器：
 * 1. **菜单右侧的按键提示与本表同源**（`hintOf`）——提示与实际行为不可能各写一份而对不上，
 *    这是仓库里 `ALGORITHM_MODALS` 那张入口表同一个思路；
 * 2. 匹配是纯函数，可在 node 环境直接单测（无需 jsdom / 引擎 / store mock）。修饰键的
 *    "严格相等"语义（`Ctrl+S` 不该被 `Ctrl+Shift+S` 触发、`Delete` 不该被 `Backspace`
 *    触发）只钉在这一处就够。
 *
 * 绑定动作的落地在 composables/useAppShortcuts（那里才碰 store 与引擎）。
 * `composables/useLocalShortcut` 是"组件内局部快捷键"的通用工具，与本题无关；
 * 只有其中的 `isTypingInInput` 被复用，避免两处各判一次"焦点在输入框"。
 */

/** 一次按键。结构类型 —— `KeyboardEvent` 天然满足，单测里传普通对象即可。 */
export interface KeyStrokeEvent {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** 期望的按键组合（`key` 一律小写书写，如 'o' / 'escape' / 'delete' / '1'）。 */
export interface ShortcutStroke {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

/** 快捷键动作 id（useAppShortcuts 的 switch 按它分派）。 */
export type ShortcutId =
  | 'open'
  | 'saveAs'
  | 'merge'
  | 'exitModal'
  | 'deleteSelection'
  | 'fitAll'
  | 'fitSelected'
  | 'viewFront'
  | 'viewBack'
  | 'viewLeft'
  | 'viewRight'
  | 'viewTop'
  | 'viewBottom'

export interface ShortcutSpec {
  id: ShortcutId
  /** 菜单 / tooltip 上显示的按键文案。 */
  hint: string
  stroke: ShortcutStroke
}

/**
 * 全表（顺序 = 匹配顺序；当前无重叠项，先到先得）。
 *
 * 取舍说明：
 * - 六个标准视角取 `Ctrl+1..6`（顺序与左竖工具栏一致：前后左右上下），与
 *   CloudCompare 的 `1..6` 对应但加了 Ctrl —— 裸数字键在将来做快捷键录制、
 *   或用户切换输入法时太容易被误触。
 * - `Esc` 只退算法模态（`exitOtherModals`），不退出应用。
 * - 单键 `F` = 缩放到选中（多数三维软件的惯例），`Home` = 缩放到全部。
 * - 不用 `Backspace` 当删除：Windows 上它是"返回上一级"的肌肉记忆，误删代价大。
 */
export const APP_SHORTCUTS: readonly ShortcutSpec[] = [
  { id: 'open', hint: 'Ctrl+O', stroke: { key: 'o', ctrl: true } },
  { id: 'saveAs', hint: 'Ctrl+S', stroke: { key: 's', ctrl: true } },
  { id: 'merge', hint: 'Ctrl+M', stroke: { key: 'm', ctrl: true } },
  { id: 'exitModal', hint: 'Esc', stroke: { key: 'escape' } },
  { id: 'deleteSelection', hint: 'Delete', stroke: { key: 'delete' } },
  { id: 'fitAll', hint: 'Home', stroke: { key: 'home' } },
  { id: 'fitSelected', hint: 'F', stroke: { key: 'f' } },
  { id: 'viewFront', hint: 'Ctrl+1', stroke: { key: '1', ctrl: true } },
  { id: 'viewBack', hint: 'Ctrl+2', stroke: { key: '2', ctrl: true } },
  { id: 'viewLeft', hint: 'Ctrl+3', stroke: { key: '3', ctrl: true } },
  { id: 'viewRight', hint: 'Ctrl+4', stroke: { key: '4', ctrl: true } },
  { id: 'viewTop', hint: 'Ctrl+5', stroke: { key: '5', ctrl: true } },
  { id: 'viewBottom', hint: 'Ctrl+6', stroke: { key: '6', ctrl: true } },
]

const HINTS = new Map<ShortcutId, string>(APP_SHORTCUTS.map((s) => [s.id, s.hint]))

/** 按键提示文案（菜单右侧显示用）；未登记的组合返回空串。 */
export function hintOf(id: ShortcutId): string {
  return HINTS.get(id) ?? ''
}

/**
 * 某个按键事件是否命中这个组合。
 *
 * **四个修饰键全部按"严格相等"判定**（缺失即 false）：不严格的话 `Ctrl+Shift+S`
 * 会同时命中 `Ctrl+S`（保存），用户按"另存为"却触发覆盖保存是最难查的那类 bug。
 * `metaKey`（Windows 键）一律要求未按下：按住它时让给系统，不抢。
 */
export function matchShortcutEvent(event: KeyStrokeEvent, stroke: ShortcutStroke): boolean {
  return (
    event.key.toLowerCase() === stroke.key &&
    event.ctrlKey === !!stroke.ctrl &&
    event.shiftKey === !!stroke.shift &&
    event.altKey === !!stroke.alt &&
    event.metaKey === false
  )
}

/** 在表里找命中的动作；无命中返回 null。 */
export function findShortcut(event: KeyStrokeEvent): ShortcutId | null {
  for (const spec of APP_SHORTCUTS) {
    if (matchShortcutEvent(event, spec.stroke)) return spec.id
  }
  return null
}
