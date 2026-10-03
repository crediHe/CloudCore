import { app, crashReporter } from 'electron'
import path from 'node:path'
import { windowManager } from './WindowManager'
import { logger, loggerManager } from './LoggerManager'
import { appEnv } from './env'

/**
 * 应用健壮性管理器（单例）
 *
 * 封装以下能力：
 * - 单实例运行限制与二次启动聚焦
 * - Electron 崩溃报告器（crashReporter）启动
 * - 主进程全局异常兜底
 */
export class RobustnessManager {
  private static instance: RobustnessManager | null = null
  private initialized = false

  private constructor() {}

  static getInstance(): RobustnessManager {
    if (!RobustnessManager.instance) {
      RobustnessManager.instance = new RobustnessManager()
    }
    return RobustnessManager.instance
  }

  /**
   * 初始化健壮性相关能力。
   */
  initialize(): void {
    if (this.initialized) {
      return
    }
    this.initialized = true

    this.setupSingleInstanceLock()
    this.setupCrashReporter()
    this.setupGlobalErrorHandlers()
  }

  /**
   * 配置单实例锁。
   *
   * 若未能获取锁，则直接退出应用；否则监听二次启动事件并聚焦主窗口。
   */
  private setupSingleInstanceLock(): void {
    const gotTheLock = app.requestSingleInstanceLock()

    if (!gotTheLock) {
      logger.warn('[RobustnessManager] 未能获取单实例锁，应用即将退出')
      app.quit()
      return
    }

    app.on('second-instance', (_event, argv, cwd) => {
      logger.info('[RobustnessManager] 检测到第二次启动', { argv, cwd })
      this.focusMainWindow()
    })
  }

  /**
   * 聚焦或重建主窗口。
   */
  private focusMainWindow(): void {
    const mainWindow = windowManager.get('main')

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
      logger.info('[RobustnessManager] 已聚焦到已存在的主窗口')
      return
    }

    windowManager.open('main')
    logger.info('[RobustnessManager] 主窗口不存在，已重新打开')
  }

  /**
   * 启动崩溃报告器。
   *
   * - 崩溃 dumps 存放在日志目录下的 crashes/ 子目录。
   * - 若配置了 SENTRY_DSN，则尝试上传；否则仅本地收集。
   */
  private setupCrashReporter(): void {
    try {
      const logDir = loggerManager.resolveLogDirectory()
      const crashDir = path.join(logDir, 'crashes')
      app.setPath('crashDumps', crashDir)

      const submitUrl = appEnv.SENTRY_DSN
      crashReporter.start({
        productName: app.name,
        submitURL: submitUrl || undefined,
        uploadToServer: !!submitUrl,
        ignoreSystemCrashHandler: true,
      })

      logger.info('[RobustnessManager] 崩溃报告已启动，上传地址：', submitUrl || '无（本地收集）')
    } catch (err) {
      logger.error('[RobustnessManager] 启动崩溃报告失败：', err)
    }
  }

  /**
   * 注册主进程全局异常处理器。
   */
  private setupGlobalErrorHandlers(): void {
    process.on('uncaughtException', (err) => {
      logger.error('[RobustnessManager] 未捕获的异常：', err)
      app.exit(1)
    })

    process.on('unhandledRejection', (reason) => {
      logger.error('[RobustnessManager] 未处理的 Promise 拒绝：', reason)
    })
  }
}

export const robustnessManager = RobustnessManager.getInstance()
