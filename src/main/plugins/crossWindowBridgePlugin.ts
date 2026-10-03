import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { CrossWindowBridge } from '../core/CrossWindowBridge'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 监听器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 跨窗口消息桥插件。
 *
 * 负责注册跨窗口消息中继，使渲染进程间通信必须经过主进程。
 */
export const crossWindowBridgePlugin: AppPlugin = {
  name: 'cross-window-bridge',
  initialize({ ipcMain }: PluginContext) {
    _ipcMain = ipcMain

    CrossWindowBridge.getInstance(ipcMain)
  },
  destroy() {
    if (!_ipcMain) return

    _ipcMain.removeAllListeners('cross-window-send')
    _ipcMain = undefined
  },
}
