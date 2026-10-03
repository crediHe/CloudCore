import { dialog, type IpcMain } from 'electron'
import { logger } from './LoggerManager'
import type { OpenDialogOptions, SaveDialogOptions } from '../../shared/types/dialog'

/**
 * 对话框 IPC 管理器（单例）
 *
 * 负责将 Electron 原生对话框能力通过 IPC 暴露给渲染进程。
 * 所有处理器都包裹 try-catch，防止未捕获异常导致应用崩溃。
 */
export class DialogManager {
  private static instance: DialogManager | null = null

  private constructor() {}

  static getInstance(): DialogManager {
    if (!DialogManager.instance) {
      DialogManager.instance = new DialogManager()
    }
    return DialogManager.instance
  }

  /**
   * 注册所有对话框相关的 IPC 处理器。
   *
   * @param ipcMain Electron 主进程 IPC 实例
   */
  registerIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('dialog:openDirectory', async (_event, options?: OpenDialogOptions) => {
      try {
        const result = await dialog.showOpenDialog({
          title: options?.title,
          defaultPath: options?.defaultPath,
          buttonLabel: options?.buttonLabel,
          properties: ['openDirectory'],
        })
        return result.canceled ? undefined : result.filePaths
      } catch (err) {
        logger.error('[DialogManager] 打开目录失败：', err)
        return undefined
      }
    })

    ipcMain.handle('dialog:openFile', async (_event, options?: OpenDialogOptions) => {
      try {
        const properties: Array<'openFile' | 'multiSelections'> = ['openFile']
        if (options?.multiSelections) {
          properties.push('multiSelections')
        }

        const result = await dialog.showOpenDialog({
          title: options?.title,
          defaultPath: options?.defaultPath,
          buttonLabel: options?.buttonLabel,
          filters: options?.filters,
          properties,
        })
        return result.canceled ? undefined : result.filePaths
      } catch (err) {
        logger.error('[DialogManager] 打开文件失败：', err)
        return undefined
      }
    })

    ipcMain.handle('dialog:saveFile', async (_event, options?: SaveDialogOptions) => {
      try {
        const result = await dialog.showSaveDialog({
          title: options?.title,
          defaultPath: options?.defaultPath,
          buttonLabel: options?.buttonLabel,
          filters: options?.filters,
        })
        return result.canceled ? undefined : result.filePath
      } catch (err) {
        logger.error('[DialogManager] 保存文件失败：', err)
        return undefined
      }
    })
  }
}

export const dialogManager = DialogManager.getInstance()
