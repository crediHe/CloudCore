import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { lasManager } from '../core/LasManager'

let _ipcMain: Electron.IpcMain | undefined

export const lasPlugin: AppPlugin = {
    name: 'las',
    initialize({ ipcMain }: PluginContext) {
        _ipcMain = ipcMain
        lasManager.registerIpcHandlers(ipcMain)
    },
    destroy() {
        if (!_ipcMain) return
        _ipcMain.removeHandler('las:get-file-info')
        _ipcMain.removeHandler('las:read-chunk')
        _ipcMain = undefined
    },
}
