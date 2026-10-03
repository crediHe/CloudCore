import { Notification, type IpcMain } from 'electron'
import { windowManager } from './WindowManager'
import { logger } from './LoggerManager'

/**
 * 系统通知管理器（单例）。
 *
 * 封装 Windows 原生通知（Electron Notification），
 * 主进程负责构造与展示，渲染进程通过 Preload 请求发送通知。
 */
export class NotificationManager {
  private static instance: NotificationManager | null = null

  static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager()
    }
    return NotificationManager.instance
  }

  /**
   * 发送一条系统通知。
   *
   * @param title 通知标题
   * @param body 通知正文
   * @param onClick 用户点击通知时的回调
   */
  show(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) {
      logger.warn('[NotificationManager] 当前系统不支持通知')
      return
    }

    const notification = new Notification({
      title,
      body,
      // Windows 上 toast 通知通常不需要 icon，但可指定应用图标
      icon: undefined,
    })

    if (onClick) {
      notification.on('click', onClick)
    }

    notification.show()
    logger.info('[NotificationManager] 已发送通知：', { title, body })
  }

  /**
   * 注册通知相关的 IPC 处理器。
   *
   * @param ipcMain Electron 主进程 IPC 实例
   */
  registerIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('notification:show', (_event, title: string, body: string) => {
      try {
        this.show(title, body, () => {
          const mainWindow = windowManager.get('main')
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.focus()
          }
        })
      } catch (err) {
        logger.error('[NotificationManager] 发送通知失败：', err)
      }
    })
  }
}

export const notificationManager = NotificationManager.getInstance()
