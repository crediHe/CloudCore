import { onMounted, onUnmounted } from 'vue'

/**
 * 快捷键组合键解析结果
 */
interface ParsedShortcut {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

/**
 * 将快捷键字符串解析为按键组合。
 * 支持格式如："Ctrl+K"、"Ctrl+Shift+S"、"Alt+F"
 */
function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  return {
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts.find((part) => !['ctrl', 'control', 'shift', 'alt'].includes(part)) ?? '',
  }
}

/**
 * 判断当前按键事件是否匹配快捷键。
 */
function matchShortcut(event: KeyboardEvent, parsed: ParsedShortcut): boolean {
  if (event.ctrlKey !== parsed.ctrl) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.altKey !== parsed.alt) return false
  return event.key.toLowerCase() === parsed.key
}

/**
 * 判断当前焦点是否在输入类元素中。
 * 在输入框中不应触发局部快捷键，避免干扰正常输入。
 *
 * 导出给 composables/useAppShortcuts 复用：应用级快捷键同样不能在重命名输入框 /
 * 设置页输入项里抢键，判据（含 contenteditable）只留这一处。
 */
export function isTypingInInput(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target || !target.tagName) return false
  const tagName = target.tagName.toLowerCase()
  const isContentEditable = target.isContentEditable
  return isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

/**
 * 渲染进程局部快捷键组合式函数。
 *
 * 局部快捷键仅在当前窗口聚焦时生效，严禁使用 Electron globalShortcut。
 * 组件卸载时会自动移除事件监听。
 */
export function useLocalShortcut(
  shortcut: string,
  callback: (event: KeyboardEvent) => void,
  options: { allowInInput?: boolean } = {}
) {
  const parsed = parseShortcut(shortcut)

  const handler = (event: KeyboardEvent) => {
    // 默认在输入框中不触发快捷键
    if (!options.allowInInput && isTypingInInput(event)) {
      return
    }

    if (matchShortcut(event, parsed)) {
      event.preventDefault()
      callback(event)
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handler)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handler)
  })
}
