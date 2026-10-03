/**
 * 系统通知组合式函数。
 *
 * 通过 Preload 桥接到主进程，由 Electron Notification 展示原生通知。
 * 渲染进程不直接创建 Notification 对象。
 */
export function useNotification() {
  const notification = window.electronAPI.notification

  return {
    /** 发送一条系统通知。 */
    show: (title: string, body: string) => notification.show(title, body),
  }
}
