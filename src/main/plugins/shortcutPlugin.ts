import type { AppPlugin, PluginContext } from '../core/PluginRegistry'
import type { ShortcutCenter } from '../core/ShortcutCenter'

// 模块级保存快捷键中心引用，供 destroy 阶段注销使用
let shortcutCenterRef: ShortcutCenter | undefined

/**
 * 全局快捷键插件。
 *
 * 负责在应用 Ready 后集中注册示例全局快捷键，
 * 并在应用退出时由 ShortcutCenter 统一注销。
 */
export const shortcutPlugin: AppPlugin = {
  name: 'shortcut',
  initialize({ app, windowManager, shortcutCenter, onReady }: PluginContext) {
    shortcutCenterRef = shortcutCenter

    onReady(() => {
      // Ctrl+Shift+F9：显示或隐藏主窗口
      shortcutCenter.register(
        'Ctrl+Shift+F9',
        () => {
          const mainWindow = windowManager.get('main')
          if (!mainWindow || mainWindow.isDestroyed()) {
            windowManager.open('main')
            return
          }

          if (mainWindow.isVisible()) {
            mainWindow.hide()
          } else {
            mainWindow.show()
          }
        },
        '显示/隐藏主窗口'
      )

      // Ctrl+Shift+F10：安全退出应用
      shortcutCenter.register(
        'Ctrl+Shift+F10',
        () => {
          app.quit()
        },
        '退出应用'
      )
    })
  },
  destroy() {
    // 应用退出前注销所有全局快捷键，防止系统级残留
    shortcutCenterRef?.unregisterAll()
    shortcutCenterRef = undefined
  },
}
