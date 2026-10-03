// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

import { CrossWindowBridge, CROSS_WINDOW_RECEIVE_CHANNEL } from '../../../../src/main/core/CrossWindowBridge'
import { windowManager } from '../../../../src/main/core/WindowManager'

describe('CrossWindowBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(CrossWindowBridge as any).instance = null
  })

  afterEach(() => {
    windowManager.closeAll()
  })

  it('应为单例', () => {
    const ipcMain = { on: vi.fn() }
    expect(CrossWindowBridge.getInstance(ipcMain as unknown as Electron.IpcMain)).toBe(
      CrossWindowBridge.getInstance(ipcMain as unknown as Electron.IpcMain)
    )
  })

  it('注册 IPC 时应监听 cross-window-send 通道', () => {
    const ipcMain = { on: vi.fn() }
    CrossWindowBridge.getInstance(ipcMain as unknown as Electron.IpcMain)

    expect(ipcMain.on).toHaveBeenCalledWith('cross-window-send', expect.any(Function))
  })

  it('deliver 应向目标窗口发送消息', () => {
    const ipcMain = { on: vi.fn() }
    const bridge = CrossWindowBridge.getInstance(ipcMain as unknown as Electron.IpcMain)

    const targetWin = windowManager.create({ name: 'settings', url: '#/settings' })

    bridge.deliver({
      channel: 'theme-changed',
      target: 'settings',
      payload: { theme: 'dark' },
      from: 'main',
    })

    expect(targetWin.webContents.send).toHaveBeenCalledWith(
      CROSS_WINDOW_RECEIVE_CHANNEL,
      expect.objectContaining({ channel: 'theme-changed', payload: { theme: 'dark' } })
    )
  })

  it('deliver 广播时应向除发送方外的窗口发送消息', () => {
    const ipcMain = { on: vi.fn() }
    const bridge = CrossWindowBridge.getInstance(ipcMain as unknown as Electron.IpcMain)

    const mainWin = windowManager.create({ name: 'main', url: '#/' })
    const settingsWin = windowManager.create({ name: 'settings', url: '#/settings' })

    bridge.deliver({
      channel: 'broadcast',
      payload: { data: 1 },
      from: 'main',
    })

    expect(mainWin.webContents.send).not.toHaveBeenCalled()
    expect(settingsWin.webContents.send).toHaveBeenCalledWith(
      CROSS_WINDOW_RECEIVE_CHANNEL,
      expect.objectContaining({ channel: 'broadcast', payload: { data: 1 } })
    )
  })
})
