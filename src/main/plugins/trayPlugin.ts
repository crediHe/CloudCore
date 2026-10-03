import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import type { TrayManager } from '../core/TrayManager'

// 模块级保存托盘管理器引用，供 destroy 阶段销毁使用
let trayManagerRef: TrayManager | undefined

/**
 * 系统托盘插件。
 *
 * 负责在应用 Ready 后创建系统托盘图标与右键菜单，
 * 并在应用退出时由 TrayManager 销毁托盘。
 */
export const trayPlugin: AppPlugin = {
  name: 'tray',
  initialize({ trayManager, onReady }: PluginContext) {
    trayManagerRef = trayManager

    onReady(() => {
      trayManager.createTray()
    })
  },
  destroy() {
    // 应用退出前销毁托盘图标，防止系统级残留
    trayManagerRef?.destroyTray()
    trayManagerRef = undefined
  },
}
