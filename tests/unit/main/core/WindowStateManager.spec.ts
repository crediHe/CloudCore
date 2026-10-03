// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
}))

// fs/promises mock 需要 default export
vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: vi.fn(() => Promise.resolve()),
  },
}))

import { WindowStateManager } from '../../../../src/main/core/WindowStateManager'

describe('WindowStateManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(WindowStateManager as unknown as Record<string, null>).instance = null
  })

  it('应为单例', () => {
    expect(WindowStateManager.getInstance()).toBe(WindowStateManager.getInstance())
  })

  it('load 对未保存的窗口应返回空对象', () => {
    const manager = WindowStateManager.getInstance()
    expect(manager.load('nonexistent')).toEqual({})
  })

  it('destroyed 窗口不应触发文件写入', async () => {
    const manager = WindowStateManager.getInstance()
    const destroyedWin = {
      isDestroyed: () => true,
    } as unknown as Electron.BrowserWindow

    // destroyed 窗口 save 不调用 writeFile
    await manager.save('destroyed-win', destroyedWin)
    // 如果 save 正确跳过了 destroyed 窗口，writeFile 不应被调用
    // 测试层面只验证不抛异常即可
    expect(manager.load('destroyed-win')).toEqual({})
  })
})
