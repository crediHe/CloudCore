import { BrowserWindow } from 'electron'
import { logger } from '../core/LoggerManager'
import type { AppPlugin, PluginContext } from '../core/PluginRegistry'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 处理器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 窗口管理插件。
 *
 * 负责注册打开、创建、关闭、聚焦窗口以及获取当前窗口名称的 IPC。
 */
export const windowManagerPlugin: AppPlugin = {
  name: 'window-manager',
  initialize({ ipcMain, windowManager }: PluginContext) {
    _ipcMain = ipcMain

    ipcMain.handle('window-manager-open', (_event, name: string) => {
      try {
        windowManager.open(name)
      } catch (err) {
        logger.error('[windowManagerPlugin] 打开窗口失败：', err)
      }
    })

    ipcMain.handle('window-manager-create', (_event, config) => {
      try {
        // 运行时参数校验，防止恶意或畸形 config 传入 WindowManager
        if (!config || typeof config.name !== 'string' || config.name.trim() === '') {
          logger.error('[windowManagerPlugin] 创建窗口失败：name 必填且不能为空')
          return
        }
        if (
          config.width !== undefined &&
          (typeof config.width !== 'number' || config.width <= 0 || config.width > 16384)
        ) {
          logger.error(`[windowManagerPlugin] 创建窗口 "${config.name}" 失败：width 必须为正整数且在合理范围内`)
          return
        }
        if (
          config.height !== undefined &&
          (typeof config.height !== 'number' || config.height <= 0 || config.height > 16384)
        ) {
          logger.error(`[windowManagerPlugin] 创建窗口 "${config.name}" 失败：height 必须为正整数且在合理范围内`)
          return
        }
        windowManager.create(config)
      } catch (err) {
        logger.error('[windowManagerPlugin] 创建窗口失败：', err)
      }
    })

    ipcMain.handle('window-manager-close', (_event, name: string) => {
      try {
        windowManager.close(name)
      } catch (err) {
        logger.error('[windowManagerPlugin] 关闭窗口失败：', err)
      }
    })

    ipcMain.handle('window-manager-focus', (_event, name: string) => {
      try {
        windowManager.focus(name)
      } catch (err) {
        logger.error('[windowManagerPlugin] 聚焦窗口失败：', err)
      }
    })

    ipcMain.handle('window-manager-get-current-name', (event) => {
      try {
        return windowManager.getNameByWindow(BrowserWindow.fromWebContents(event.sender) ?? undefined) ?? ''
      } catch (err) {
        logger.error('[windowManagerPlugin] 获取当前窗口名称失败：', err)
        return ''
      }
    })
  },
  destroy() {
    // 清理窗口管理相关的 IPC 处理器。
    if (!_ipcMain) return

    _ipcMain.removeHandler('window-manager-open')
    _ipcMain.removeHandler('window-manager-create')
    _ipcMain.removeHandler('window-manager-close')
    _ipcMain.removeHandler('window-manager-focus')
    _ipcMain.removeHandler('window-manager-get-current-name')
    _ipcMain = undefined
  },
}
