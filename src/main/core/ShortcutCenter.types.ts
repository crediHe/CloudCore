/**
 * 快捷键中心类型定义
 */

/** 快捷键回调函数签名 */
export type ShortcutCallback = () => void

/** 单个快捷键注册项 */
export interface ShortcutRegistration {
  /** 快捷键字符串，例如 "Ctrl+Shift+S" */
  accelerator: string
  /** 触发时执行的回调 */
  callback: ShortcutCallback
  /** 快捷键描述，用于日志与调试 */
  description?: string
}
