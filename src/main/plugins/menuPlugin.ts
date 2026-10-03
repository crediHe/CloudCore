import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import { menuManager } from '../core/MenuManager'

/**
 * 原生菜单插件。
 *
 * 负责在应用 Ready 后构建并设置应用主菜单。
 */
export const menuPlugin: AppPlugin = {
  name: 'menu',
  initialize({ onReady }: PluginContext) {
    onReady(() => {
      menuManager.createMenu()
    })
  },
  // 应用菜单由 Electron 进程退出时自动释放，无需额外清理。
  destroy() {},
}
