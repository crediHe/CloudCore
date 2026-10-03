import { BrowserWindow, type IpcMain } from 'electron'
import type { CrossWindowMessage } from '../../shared/types/window'
import { windowManager } from './WindowManager'
import { logger } from './LoggerManager'

/** 渲染进程向主进程发送跨窗口消息时使用的通道。 */
export const CROSS_WINDOW_SEND_CHANNEL = 'cross-window-send'

/** 主进程向目标渲染进程投递消息时使用的通道。 */
export const CROSS_WINDOW_RECEIVE_CHANNEL = 'cross-window-message'

/**
 * 跨窗口消息中转桥。
 *
 * 所有窗口间通信都必须经过此桥接，渲染进程之间禁止直接通信。
 */
export class CrossWindowBridge {
  private static instance: CrossWindowBridge | null = null
  private ipcMain: IpcMain

  private constructor(ipcMain: IpcMain) {
    this.ipcMain = ipcMain
    this.registerIpc()
  }

  static getInstance(ipcMain: IpcMain): CrossWindowBridge {
    if (!CrossWindowBridge.instance) {
      CrossWindowBridge.instance = new CrossWindowBridge(ipcMain)
    }
    return CrossWindowBridge.instance
  }

  private registerIpc(): void {
    this.ipcMain.on(CROSS_WINDOW_SEND_CHANNEL, (event, partialMessage: Omit<CrossWindowMessage, 'from'>) => {
      try {
        // 运行时校验：渲染进程传入的数据可能不满足类型约定
        if (!partialMessage || typeof partialMessage.channel !== 'string') {
          logger.warn('[CrossWindowBridge] 收到无效消息（缺少 channel 字段），已忽略。')
          return
        }

        const senderBrowserWindow = BrowserWindow.fromWebContents(event.sender)
        const sender = windowManager.getNameByWindow(senderBrowserWindow ?? undefined)
        if (!sender) {
          const senderTitle = senderBrowserWindow?.getTitle() ?? 'unknown'
          const senderId = senderBrowserWindow?.id ?? 'unknown'
          logger.warn(
            `[CrossWindowBridge] 无法识别发送方窗口（title="${senderTitle}", id=${senderId}），已忽略来自 channel="${partialMessage.channel}" 的消息。`
          )
          return
        }

        const message: CrossWindowMessage = {
          ...partialMessage,
          from: sender,
        }

        this.deliver(message)
      } catch (err) {
        logger.error('[CrossWindowBridge] 转发消息失败：', err)
      }
    })
  }

  /**
   * 将消息投递到目标窗口，或向所有其他窗口广播。
   */
  deliver(message: CrossWindowMessage): void {
    try {
      if (message.target) {
        const target = windowManager.get(message.target)
        if (target && !target.isDestroyed()) {
          target.webContents.send(CROSS_WINDOW_RECEIVE_CHANNEL, message)
        } else {
          logger.debug(`[CrossWindowBridge] 目标窗口 "${message.target}" 不存在，消息已丢弃。`)
        }
        return
      }

      // 向除发送方外的所有窗口广播。
      for (const win of windowManager.getAll()) {
        const name = windowManager.getNameByWindow(win)
        if (name && name !== message.from) {
          win.webContents.send(CROSS_WINDOW_RECEIVE_CHANNEL, message)
        }
      }
    } catch (err) {
      logger.error('[CrossWindowBridge] 投递消息失败：', err)
    }
  }
}
