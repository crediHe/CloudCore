import type { OpenDialogOptions, SaveDialogOptions } from '../../shared/types/dialog'

/**
 * 渲染进程对话框组合式函数。
 *
 * 所有调用都通过 Preload 桥接到主进程，渲染进程不直接访问 Electron API。
 */
export function useDialog() {
  const dialog = window.electronAPI.dialog

  return {
    /** 打开目录选择器。 */
    openDirectory: (options?: OpenDialogOptions) => dialog.openDirectory(options),

    /** 打开文件选择器。 */
    openFile: (options?: OpenDialogOptions) => dialog.openFile(options),

    /** 打开保存文件对话框。 */
    saveFile: (options?: SaveDialogOptions) => dialog.saveFile(options),
  }
}
