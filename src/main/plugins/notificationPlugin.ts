import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { notificationManager } from '../core/NotificationManager'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 处理器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 系统通知插件。
 *
 * 负责注册通知 IPC，将系统通知能力暴露给渲染进程。
 */
export const notificationPlugin: AppPlugin = {
  name: 'notification',
  initialize({ ipcMain }: PluginContext) {
    _ipcMain = ipcMain

    notificationManager.registerIpcHandlers(ipcMain)
  },
  destroy() {
    if (!_ipcMain) return

    _ipcMain.removeHandler('notification:show')
    _ipcMain = undefined
  },
}
