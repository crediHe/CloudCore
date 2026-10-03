// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

import { DialogManager } from '../../../../src/main/core/DialogManager'

describe('DialogManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应为单例', () => {
    expect(DialogManager.getInstance()).toBe(DialogManager.getInstance())
  })

  it('应注册 dialog:openDirectory 处理器', async () => {
    const manager = DialogManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)

    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'dialog:openDirectory')!
    mockElectron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\projects'] })

    const result = await handler({}, {})
    expect(result).toEqual(['C:\\projects'])
    expect(mockElectron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory'] })
    )
  })

  it('dialog:openDirectory 取消时应返回 undefined', async () => {
    const manager = DialogManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)

    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'dialog:openDirectory')!
    mockElectron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    const result = await handler({}, {})
    expect(result).toBeUndefined()
  })

  it('应注册 dialog:openFile 处理器并支持多选', async () => {
    const manager = DialogManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)

    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'dialog:openFile')!
    mockElectron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:\\file1.txt', 'C:\\file2.txt'],
    })

    const result = await handler({}, { multiSelections: true })
    expect(result).toEqual(['C:\\file1.txt', 'C:\\file2.txt'])
    expect(mockElectron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile', 'multiSelections'] })
    )
  })

  it('应注册 dialog:saveFile 处理器', async () => {
    const manager = DialogManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)

    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'dialog:saveFile')!
    mockElectron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:\\save.txt' })

    const result = await handler({}, {})
    expect(result).toBe('C:\\save.txt')
  })
})
