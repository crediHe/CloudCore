import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { storeManager } from '../core/StoreManager'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 处理器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 本地存储插件。
 *
 * 负责注册存储 IPC，并在启动时累加启动计数。
 */
export const storePlugin: AppPlugin = {
  name: 'store',
  initialize({ ipcMain }: PluginContext) {
    _ipcMain = ipcMain

    storeManager.registerIpcHandlers(ipcMain)
    storeManager.bumpLaunchCount()
  },
  destroy() {
    if (!_ipcMain) return

    _ipcMain.removeHandler('store:get')
    _ipcMain.removeHandler('store:set')
    _ipcMain.removeHandler('store:delete')
    _ipcMain = undefined
  },
}
