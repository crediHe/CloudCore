import { globalShortcut } from 'electron'
import { logger } from './LoggerManager'
import type { ShortcutCallback, ShortcutRegistration } from './ShortcutCenter.types'

/**
 * 全局快捷键管理中心（单例）
 *
 * 所有全局快捷键必须通过此类注册，严禁在主进程中直接调用 globalShortcut。
 * 应用在退出前必须调用 unregisterAll()，防止快捷键残留。
 */
export class ShortcutCenter {
  private static instance: ShortcutCenter | null = null
  private readonly registry = new Map<string, ShortcutRegistration>()

  private constructor() {}

  static getInstance(): ShortcutCenter {
    if (!ShortcutCenter.instance) {
      ShortcutCenter.instance = new ShortcutCenter()
    }
    return ShortcutCenter.instance
  }

  /**
   * 注册一个全局快捷键
   *
   * @param accelerator 快捷键字符串，例如 "Ctrl+Shift+S"
   * @param callback 触发时执行的回调
   * @param description 快捷键描述，可选
   * @returns 是否注册成功
   */
  register(accelerator: string, callback: ShortcutCallback, description?: string): boolean {
    // 禁止重复注册同一快捷键，防止静默覆盖导致行为不可预期
    if (this.registry.has(accelerator)) {
      logger.warn(`[ShortcutCenter] 快捷键 "${accelerator}" 已被注册，请先注销再重新注册。`)
      return false
    }

    // 使用 Electron globalShortcut 注册系统级快捷键
    const success = globalShortcut.register(accelerator, () => {
      try {
        callback()
      } catch (err) {
        logger.error(`[ShortcutCenter] 快捷键 "${accelerator}" 回调执行失败：`, err)
      }
    })

    if (!success) {
      logger.error(`[ShortcutCenter] 快捷键 "${accelerator}" 注册失败，可能已被系统或其他应用占用。`)
      return false
    }

    this.registry.set(accelerator, { accelerator, callback, description })
    logger.info(`[ShortcutCenter] 已注册快捷键 "${accelerator}"${description ? `（${description}）` : ''}`)
    return true
  }

  /**
   * 注销指定全局快捷键
   */
  unregister(accelerator: string): void {
    globalShortcut.unregister(accelerator)
    this.registry.delete(accelerator)
    logger.info(`[ShortcutCenter] 已注销快捷键 "${accelerator}"`)
  }

  /**
   * 注销所有全局快捷键
   */
  unregisterAll(): void {
    globalShortcut.unregisterAll()
    this.registry.clear()
    logger.info('[ShortcutCenter] 已注销所有全局快捷键')
  }

  /**
   * 获取当前已注册快捷键列表
   */
  getRegisteredAccelerators(): string[] {
    return Array.from(this.registry.keys())
  }
}

export const shortcutCenter = ShortcutCenter.getInstance()
