import type { WindowConfig } from '../../shared/types/window'

/**
 * 渲染进程中管理 Electron 窗口的组合式函数。
 *
 * 所有窗口生命周期操作都通过 Preload 桥接转发给主进程，遵守宪法的分层边界。
 */
export function useWindow() {
  const manager = window.electronAPI.windowManager

  return {
    /**
     * 根据名称打开预定义窗口。
     * 已知窗口："main"、"settings"。
     */
    open: (name: string) => manager.open(name),

    /**
     * 根据动态配置创建窗口。
     * URL 必须是带 "#" 开头的 hash 路由。
     */
    create: (config: WindowConfig) => manager.create(config),

    /** 根据名称关闭窗口。 */
    close: (name: string) => manager.close(name),

    /** 根据名称聚焦窗口。 */
    focus: (name: string) => manager.focus(name),

    /** 便捷方法：打开设置窗口。 */
    openSettings: () => manager.open('settings'),

    /** 便捷方法：关闭设置窗口。 */
    closeSettings: () => manager.close('settings'),
  }
}
