import type { AppPlugin } from '../core/PluginRegistry'
import { updateManager } from '../core/UpdateManager'

/**
 * 自动更新插件。
 *
 * 负责初始化 electron-updater 并注册相关 IPC。
 * 应用退出时通过 destroy() 清理事件监听器。
 */
export const updatePlugin: AppPlugin = {
  name: 'update',
  initialize() {
    updateManager.initialize()
  },
  destroy() {
    updateManager.destroy()
  },
}
