import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { pointCloudSaveManager } from '../core/PointCloudSaveManager'

let _ipcMain: Electron.IpcMain | undefined

/**
 * 点云「另存为」插件：注册写盘通道（begin / chunk / end / abort）。
 *
 * 与 plyPlugin / lasPlugin（读）对称。destroy 时**先移除全部 handler 再中止会话**：
 * 应用退出时若有未收尾的保存（用户中途关窗口），半成品文件必须删掉。
 */
export const pointCloudSavePlugin: AppPlugin = {
  name: 'pointcloud-save',
  initialize({ ipcMain }: PluginContext) {
    _ipcMain = ipcMain
    pointCloudSaveManager.registerIpcHandlers(ipcMain)
  },
  destroy() {
    if (!_ipcMain) return
    _ipcMain.removeHandler('pointcloud:save-begin')
    _ipcMain.removeHandler('pointcloud:save-chunk')
    _ipcMain.removeHandler('pointcloud:save-end')
    _ipcMain.removeHandler('pointcloud:save-abort')
    _ipcMain = undefined
    void pointCloudSaveManager.abortAll()
  },
}
