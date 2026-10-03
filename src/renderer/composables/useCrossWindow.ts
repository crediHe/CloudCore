import { onUnmounted } from 'vue'
import type { CrossWindowMessage } from '../../shared/types/window'

/**
 * 跨窗口通信的组合式函数。
 *
 * 消息始终通过主进程中继，渲染进程之间禁止直接通信。
 */
export function useCrossWindow() {
  const api = window.electronAPI.crossWindow
  const unsubscribes: Array<() => void> = []

  /**
   * 向其他窗口发送消息。
   * 如果省略 target，则向所有其他窗口广播。
   */
  function send<T>(channel: string, payload: T, target?: string) {
    api.send(channel, payload, target)
  }

  /**
   * 订阅指定通道的消息。
   * 组件卸载时自动取消订阅。
   */
  function on<T>(channel: string, callback: (message: CrossWindowMessage<T>) => void) {
    const unsubscribe = api.on<T>(channel, callback)
    unsubscribes.push(unsubscribe)
    return unsubscribe
  }

  onUnmounted(() => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  })

  return {
    send,
    on,
  }
}
