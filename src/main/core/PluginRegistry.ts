import type { App, IpcMain } from 'electron'
import type log from 'electron-log/main'
import type { WindowManager } from './WindowManager'
import type { ShortcutCenter } from './ShortcutCenter'
import type { TrayManager } from './TrayManager'

/**
 * 插件上下文。
 *
 * 由 PluginRegistry 在初始化阶段注入给每个插件，
 * 包含主进程运行所需的核心依赖与生命周期钩子。
 */
export interface PluginContext {
  /** Electron 应用实例 */
  app: App
  /** 主进程 IPC 实例 */
  ipcMain: IpcMain
  /** 窗口管理器单例 */
  windowManager: WindowManager
  /** 全局快捷键管理中心 */
  shortcutCenter: ShortcutCenter
  /** 系统托盘管理器 */
  trayManager: TrayManager
  /** 已初始化的 electron-log 实例 */
  logger: typeof log
  /** 注册需要在应用 Ready 之后执行的回调 */
  onReady: (callback: () => void) => void
}

/**
 * 应用插件接口。
 *
 * 所有主进程业务模块都应实现该接口，并通过 PluginRegistry 注册。
 */
export interface AppPlugin {
  /** 插件名称，仅用于日志与调试 */
  name: string
  /** 初始化逻辑，由 PluginRegistry 统一调用 */
  initialize: (context: PluginContext) => void
  /** 销毁逻辑，由 PluginRegistry 在应用退出前统一调用 */
  destroy?: () => void
}

/**
 * 插件注册中心（单例）。
 *
 * 负责收集所有内置插件，并按统一生命周期驱动其初始化：
 * - `initializeAll`：应用启动初期调用，完成 IPC 注册、事件监听等。
 * - `ready`：应用 Ready 后调用，触发各插件通过 `onReady` 注册的回调。
 * - `destroy`：应用退出前调用，按注册顺序的倒序执行插件销毁逻辑。
 */
export class PluginRegistry {
  private static instance: PluginRegistry | null = null
  private plugins: AppPlugin[] = []
  private readyCallbacks: Array<() => void> = []

  private constructor() {}

  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry()
    }
    return PluginRegistry.instance
  }

  /**
   * 注册一个插件。
   *
   * @param plugin 待注册的插件实例
   */
  register(plugin: AppPlugin): void {
    if (this.plugins.some((p) => p.name === plugin.name)) {
      // register 阶段 logger 尚未注入，使用 console 输出警告
      console.warn(`[PluginRegistry] 检测到同名插件 "${plugin.name}" 重复注册`)
    }
    this.plugins.push(plugin)
  }

  /**
   * 初始化所有已注册插件。
   *
   * 每个插件的初始化异常都会被捕获并记录，不会中断后续插件的初始化。
   *
   * @param context 插件上下文（不含 onReady，由注册中心注入）
   */
  initializeAll(context: Omit<PluginContext, 'onReady'>): void {
    const ctx: PluginContext = {
      ...context,
      onReady: (callback) => {
        this.readyCallbacks.push(callback)
      },
    }

    this.plugins.forEach((plugin) => {
      try {
        ctx.logger.info(`[PluginRegistry] 初始化插件: ${plugin.name}`)
        plugin.initialize(ctx)
      } catch (err) {
        ctx.logger.error(`[PluginRegistry] 插件 "${plugin.name}" 初始化失败：`, err)
      }
    })
  }

  /**
   * 触发所有通过 `onReady` 注册的回调。
   * 应在 `app.whenReady()` 之后调用。
   *
   * 单个回调的异常不会影响其他回调的执行。
   */
  ready(logger: typeof log): void {
    this.readyCallbacks.forEach((callback) => {
      try {
        callback()
      } catch (err) {
        logger.error('[PluginRegistry] ready 回调执行失败：', err)
      }
    })
  }

  /**
   * 销毁所有已注册插件。
   *
   * 按注册顺序的倒序执行插件的 `destroy` 方法，确保依赖关系正确释放。
   * 单个插件的销毁异常不会影响其他插件的销毁。
   */
  destroy(logger: typeof log): void {
    // 倒序遍历，先注册的插件后销毁
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const plugin = this.plugins[i]
      if (typeof plugin.destroy !== 'function') {
        continue
      }

      try {
        logger.info(`[PluginRegistry] 销毁插件: ${plugin.name}`)
        plugin.destroy()
      } catch (err) {
        logger.error(`[PluginRegistry] 插件 "${plugin.name}" 销毁失败：`, err)
      }
    }
  }
}

export const pluginRegistry = PluginRegistry.getInstance()
