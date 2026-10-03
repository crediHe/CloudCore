// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

import { NotificationManager } from '../../../../src/main/core/NotificationManager'

describe('NotificationManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(NotificationManager as any).instance = null
  })

  it('应为单例', () => {
    expect(NotificationManager.getInstance()).toBe(NotificationManager.getInstance())
  })

  it('show 应创建并展示 Notification', () => {
    const manager = NotificationManager.getInstance()
    manager.show('测试标题', '测试正文')

    expect(mockElectron.Notification).toHaveBeenCalledWith(
      expect.objectContaining({ title: '测试标题', body: '测试正文' })
    )
  })

  it('registerIpcHandlers 应注册 notification:show 处理器', () => {
    const manager = NotificationManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)

    expect(ipcMain.handle).toHaveBeenCalledWith('notification:show', expect.any(Function))
  })
})
