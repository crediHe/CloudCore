/**
 * 开发环境 DevTools 助手。
 *
 * 仅在开发环境使用，通过 Preload 通知主进程打开当前窗口的 DevTools。
 */
export function useDevTools() {
  return {
    /** 打开当前窗口的 DevTools。 */
    open: () => window.electronAPI.devTools.open(),
  }
}
