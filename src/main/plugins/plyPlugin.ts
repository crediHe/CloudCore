import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { plyManager } from '../core/PlyManager'

let _ipcMain: Electron.IpcMain | undefined

export const plyPlugin: AppPlugin = {
    name: 'ply',
    initialize({ ipcMain }: PluginContext) {
        _ipcMain = ipcMain
        plyManager.registerIpcHandlers(ipcMain)
    },
    destroy() {
        if (!_ipcMain) return
        _ipcMain.removeHandler('ply:get-file-info')
        _ipcMain.removeHandler('ply:read-chunk')
        _ipcMain = undefined
    },
}