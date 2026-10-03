import { ref, onMounted, onUnmounted } from 'vue'
import type { UpdateState } from '../../shared/types/update'

/**
 * 自动更新组合式函数。
 *
 * 功能：
 * - 暴露当前更新状态、检查更新、下载更新、退出并安装。
 * - 监听主进程推送的 `update-state-changed` 事件。
 * - 组件卸载时自动取消事件监听。
 */
export function useUpdate() {
  const state = ref<UpdateState>({ phase: 'idle' })
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    // 通过 preload 暴露的事件监听入口订阅更新状态。
    unsubscribe =
      window.electronEvents?.onUpdateStateChanged?.((_event, nextState) => {
        state.value = nextState
      }) ?? null
  })

  onUnmounted(() => {
    unsubscribe?.()
  })

  /** 手动触发检查更新。 */
  async function check(): Promise<void> {
    await window.electronAPI.update.check()
  }

  /** 手动触发下载更新（通常在 update-available 后调用）。 */
  async function download(): Promise<void> {
    await window.electronAPI.update.download()
  }

  /** 退出当前应用并安装已下载的更新。 */
  async function quitAndInstall(): Promise<void> {
    await window.electronAPI.update.quitAndInstall()
  }

  return {
    state,
    check,
    download,
    quitAndInstall,
  }
}
