// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

// electron-store 需要 mock，否则在 Node 测试环境中会尝试读取真实配置
vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => {
    const data: Record<string, unknown> = {
      launchCount: 5,
      userPreferences: { theme: 'dark', language: 'zh-CN' },
    }
    return {
      get: vi.fn((key: string, defaultValue?: unknown) => {
        return data[key] ?? defaultValue
      }),
      set: vi.fn((key: string, value: unknown) => {
        data[key] = value
      }),
      delete: vi.fn((key: string) => {
        delete data[key]
      }),
      clear: vi.fn(() => {
        for (const key of Object.keys(data)) {
          delete data[key]
        }
      }),
      path: '/tmp/electron-user-data/app-config.json',
    }
  }),
}))

import { StoreManager } from '../../../../src/main/core/StoreManager'

describe('StoreManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // 重置单例，保证每个测试独立
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(StoreManager as any).instance = null
  })

  it('应为单例', () => {
    expect(StoreManager.getInstance()).toBe(StoreManager.getInstance())
  })

  it('应能读取指定键的值', () => {
    const manager = StoreManager.getInstance()
    expect(manager.get<number>('launchCount')).toBe(5)
  })

  it('键不存在时应返回默认值', () => {
    const manager = StoreManager.getInstance()
    expect(manager.get('missingKey', 'default')).toBe('default')
  })

  it('应能设置并读取新值', () => {
    const manager = StoreManager.getInstance()
    // 键必须在 ALLOWED_KEYS 白名单内
    manager.set('launchCount', 42)
    expect(manager.get<number>('launchCount')).toBe(42)
  })

  it('应能删除指定键', () => {
    const manager = StoreManager.getInstance()
    manager.delete('launchCount')
    expect(manager.get<number>('launchCount')).toBeUndefined()
  })

  it('bumpLaunchCount 应将启动计数加 1', () => {
    const manager = StoreManager.getInstance()
    manager.bumpLaunchCount()
    expect(manager.get<number>('launchCount')).toBe(6)
  })

  it('registerIpcHandlers 应注册 store:get / store:set / store:delete 处理器', () => {
    const manager = StoreManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)

    expect(ipcMain.handle).toHaveBeenCalledWith('store:get', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('store:set', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('store:delete', expect.any(Function))
  })
})
