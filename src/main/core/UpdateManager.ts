import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/types/update'
import { appEnv } from './env'
import { logger } from './LoggerManager'

export type { UpdateState }

/**
 * 自动更新管理器。
 *
 * 职责：
 * - 仅在打包后的生产环境中启用自动更新事件监听。
 * - 若未配置 UPDATE_URL，则仅初始化 IPC 接口并记录提示，不会连接任何服务端。
 * - 将更新状态通过 WebContents 推送到渲染进程。
 */
export class UpdateManager {
  private static instance: UpdateManager | null = null
  private initialized = false
  private listenersBound = false
  private state: UpdateState = { phase: 'idle' }

  static getInstance(): UpdateManager {
    if (!UpdateManager.instance) {
      UpdateManager.instance = new UpdateManager()
    }
    return UpdateManager.instance
  }

  /**
   * 初始化自动更新模块。
   *
   * 说明：
   * - 开发环境下仅记录日志，不真正检查更新，避免干扰本地调试。
   * - 生产环境下若 UPDATE_URL 存在，则设置 feed URL 并监听事件。
   */
  initialize(): void {
    if (this.initialized) {
      logger.warn('[UpdateManager] 已初始化，跳过重复调用')
      return
    }

    this.initialized = true

    if (!app.isPackaged) {
      logger.info('[UpdateManager] 当前为开发环境，自动更新已禁用')
      this.registerIpcHandlers()
      return
    }

    if (appEnv.UPDATE_URL) {
      autoUpdater.setFeedURL({ provider: 'generic', url: appEnv.UPDATE_URL })
      logger.info('[UpdateManager] 已配置更新源：', appEnv.UPDATE_URL)
      this.bindAutoUpdaterEvents()
    } else {
      logger.info('[UpdateManager] 未配置 UPDATE_URL，自动更新已跳过')
    }

    this.registerIpcHandlers()
  }

  /**
   * 销毁更新管理器。
   *
   * 移除 autoUpdater 上绑定的事件监听器并重置内部状态。
   * 由 updatePlugin.destroy() 在应用退出前调用。
   */
  destroy(): void {
    if (this.listenersBound) {
      autoUpdater.removeAllListeners()
      this.listenersBound = false
    }
    this.initialized = false
    logger.info('[UpdateManager] 已销毁')
  }

  /** 获取当前更新状态。 */
  getState(): UpdateState {
    return { ...this.state }
  }

  /** 注册 IPC 处理器，供渲染进程调用。 */
  private registerIpcHandlers(): void {
    ipcMain.handle('update:check', async () => {
      try {
        await autoUpdater.checkForUpdates()
      } catch (err) {
        logger.error('[UpdateManager] 检查更新失败：', err)
        this.broadcastState({ phase: 'error', message: this.formatError(err) })
      }
    })

    ipcMain.handle('update:download', async () => {
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        logger.error('[UpdateManager] 下载更新失败：', err)
        this.broadcastState({ phase: 'error', message: this.formatError(err) })
      }
    })

    ipcMain.handle('update:quit-and-install', () => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (err) {
        logger.error('[UpdateManager] 退出并安装失败：', err)
        this.broadcastState({ phase: 'error', message: this.formatError(err) })
      }
    })
  }

  /** 绑定 electron-updater 的生命周期事件。 */
  private bindAutoUpdaterEvents(): void {
    if (this.listenersBound) {
      return
    }
    this.listenersBound = true

    autoUpdater.on('checking-for-update', () => {
      this.broadcastState({ phase: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      this.broadcastState({ phase: 'available', version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      this.broadcastState({ phase: 'not-available' })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.broadcastState({ phase: 'downloading', percent: Math.round(progress.percent) })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.broadcastState({ phase: 'downloaded', version: info.version })
    })

    autoUpdater.on('error', (err) => {
      logger.error('[UpdateManager] 自动更新异常：', err)
      this.broadcastState({ phase: 'error', message: this.formatError(err) })
    })
  }

  /** 向所有 BrowserWindow 广播更新状态变更。 */
  private broadcastState(state: UpdateState): void {
    this.state = { ...state }
    BrowserWindow.getAllWindows().forEach((win: Electron.BrowserWindow) => {
      this.sendState(win.webContents)
    })
  }

  /** 向指定 WebContents 发送当前状态。 */
  sendState(webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      return
    }
    webContents.send('update-state-changed', this.state)
  }

  /** 格式化异常为可读字符串。 */
  private formatError(err: unknown): string {
    if (err instanceof Error) {
      return err.message
    }
    return String(err)
  }
}

export const updateManager = UpdateManager.getInstance()
