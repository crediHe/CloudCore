import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { dialogManager } from '../core/DialogManager'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 处理器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 对话框插件。
 *
 * 负责注册文件/目录选择、保存文件等对话框 IPC。
 */
export const dialogPlugin: AppPlugin = {
  name: 'dialog',
  initialize({ ipcMain }: PluginContext) {
    _ipcMain = ipcMain

    dialogManager.registerIpcHandlers(ipcMain)
  },
  destroy() {
    if (!_ipcMain) return

    _ipcMain.removeHandler('dialog:openDirectory')
    _ipcMain.removeHandler('dialog:openFile')
    _ipcMain.removeHandler('dialog:saveFile')
    _ipcMain = undefined
  },
}
