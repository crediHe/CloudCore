import { BrowserWindow } from 'electron'
import { logger } from '../core/LoggerManager'
import type { AppPlugin, PluginContext } from '../core/PluginRegistry'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 监听器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 根据 IPC 事件获取发送方所在的 BrowserWindow。
 * 用于避免在每个 IPC handler 中重复提取窗口名的样板代码。
 */
function getSenderWindow(
  event: { sender: Electron.WebContents },
  windowManager: PluginContext['windowManager']
): Electron.BrowserWindow | undefined {
  const winName = windowManager.getNameByWindow(BrowserWindow.fromWebContents(event.sender) ?? undefined)
  return winName ? windowManager.get(winName) : undefined
}

/**
 * 窗口控制插件。
 *
 * 负责注册当前窗口的最小化、最大化、恢复、关闭、最大化状态查询以及 DevTools 打开 IPC。
 */
export const windowControlPlugin: AppPlugin = {
  name: 'window-control',
  initialize({ app, ipcMain, windowManager }: PluginContext) {
    _ipcMain = ipcMain

    // 立即退出应用。不能用 window-close 代替：主窗口关闭会隐藏到托盘。
    ipcMain.on('app:quit', () => {
      app.quit()
    })

    ipcMain.on('window-minimize', (event) => {
      try {
        getSenderWindow(event, windowManager)?.minimize()
      } catch (err) {
        logger.error('[windowControlPlugin] 最小化窗口失败：', err)
      }
    })

    ipcMain.on('window-maximize', (event) => {
      try {
        getSenderWindow(event, windowManager)?.maximize()
      } catch (err) {
        logger.error('[windowControlPlugin] 最大化窗口失败：', err)
      }
    })

    ipcMain.on('window-unmaximize', (event) => {
      try {
        getSenderWindow(event, windowManager)?.unmaximize()
      } catch (err) {
        logger.error('[windowControlPlugin] 恢复窗口失败：', err)
      }
    })

    ipcMain.on('window-close', (event) => {
      try {
        getSenderWindow(event, windowManager)?.close()
      } catch (err) {
        logger.error('[windowControlPlugin] 关闭窗口失败：', err)
      }
    })

    ipcMain.handle('window-is-maximized', (event) => {
      try {
        return getSenderWindow(event, windowManager)?.isMaximized() ?? false
      } catch (err) {
        logger.error('[windowControlPlugin] 获取窗口最大化状态失败：', err)
        return false
      }
    })

    // 打开当前窗口的 DevTools（从 LoggerManager 迁移至此，遵循关注点分离原则）
    ipcMain.handle('devTools:open', (event) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win && !win.isDestroyed()) {
          win.webContents.openDevTools({ mode: 'detach' })
        }
      } catch (err) {
        logger.error('[windowControlPlugin] 打开 DevTools 失败：', err)
      }
    })
  },
  destroy() {
    // 清理窗口控制相关的 IPC 监听器，防止应用退出后残留。
    if (!_ipcMain) return

    _ipcMain.removeAllListeners('app:quit')
    _ipcMain.removeAllListeners('window-minimize')
    _ipcMain.removeAllListeners('window-maximize')
    _ipcMain.removeAllListeners('window-unmaximize')
    _ipcMain.removeAllListeners('window-close')
    _ipcMain.removeHandler('window-is-maximized')
    _ipcMain.removeHandler('devTools:open')
    _ipcMain = undefined
  },
}
