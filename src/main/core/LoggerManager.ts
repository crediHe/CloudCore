import { app, ipcMain } from 'electron'
import log from 'electron-log/main'
import fs from 'node:fs'
import path from 'node:path'
import type { LogLevel } from '../../shared/types/logger'

/**
 * 日志管理器（单例）
 *
 * 负责初始化 electron-log、配置日志文件路径，并提供 IPC 接口供渲染进程写入日志。
 * 日志文件位置规则：
 * - 开发环境：项目根目录下的 logs/
 * - 生产环境（打包后）：应用安装目录下的 logs/
 *
 * IPC 处理器在模块加载时注册，不依赖 initialize() 的调用顺序，
 * 避免因插件注册顺序不当导致渲染进程日志请求静默失败。
 */
export class LoggerManager {
  private static instance: LoggerManager | null = null
  private initialized = false
  private handlersRegistered = false

  private constructor() {}

  static getInstance(): LoggerManager {
    if (!LoggerManager.instance) {
      LoggerManager.instance = new LoggerManager()
    }
    return LoggerManager.instance
  }

  /**
   * 初始化日志系统（文件路径、传输方式等）。
   *
   * IPC 处理器已在模块加载时注册，此处仅配置日志基础设置。
   */
  initialize(): void {
    if (this.initialized) {
      return
    }
    this.initialized = true

    // 初始化 electron-log 主进程端
    log.initialize()

    // 解析并创建日志目录
    const logDir = this.resolveLogDirectory()
    fs.mkdirSync(logDir, { recursive: true })

    // 自定义日志文件路径
    log.transports.file.resolvePathFn = (variables) => {
      const fileName = variables.fileName ?? 'main.log'
      return path.join(logDir, fileName)
    }

    log.info('[LoggerManager] 日志系统已初始化，日志目录：', logDir)
  }

  /**
   * 解析日志存放目录。
   */
  resolveLogDirectory(): string {
    // 优先使用 Electron 提供的日志目录（Windows: %APPDATA%/<app>/logs），
    // 避免因应用安装在 Program Files 等受限目录导致写入失败。
    return app.getPath('logs')
  }

  /**
   * 注册 IPC 处理器。
   *
   * 在模块加载时立即调用，无需等待 initialize()。
   */
  registerIpcHandlers(): void {
    if (this.handlersRegistered) {
      return
    }
    this.handlersRegistered = true

    // 渲染进程写入日志
    ipcMain.handle('logger:log', (_event, level: LogLevel, args: unknown[]) => {
      try {
        switch (level) {
          case 'debug':
            log.debug(...args)
            break
          case 'info':
            log.info(...args)
            break
          case 'warn':
            log.warn(...args)
            break
          case 'error':
            log.error(...args)
            break
          default:
            console.warn(`[LoggerManager] 未知日志级别：${level}`)
        }
      } catch (err) {
        console.error('[LoggerManager] 写入日志失败：', err)
      }
    })
  }
}

export const loggerManager = LoggerManager.getInstance()

// 在模块加载时立即注册 IPC 处理器，确保渲染进程日志请求不依赖 initialize() 的调用顺序。
loggerManager.registerIpcHandlers()

/**
 * 导出 electron-log 实例，供其他主进程模块直接使用。
 *
 * 在 LoggerManager.initialize() 之后，该实例已配置好文件路径与传输方式。
 */
export { log as logger }
