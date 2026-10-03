// @vitest-environment node

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

// 必须在导入 WindowManager 之前 mock electron
vi.mock('electron', () => mockElectron)

import { WindowManager, windowManager } from '../../../../src/main/core/WindowManager'

describe('WindowManager', () => {
  afterEach(() => {
    windowManager.closeAll()
    vi.clearAllMocks()
  })

  it('应为单例', () => {
    expect(WindowManager.getInstance()).toBe(WindowManager.getInstance())
  })

  it('打开未知窗口名称时应抛出错误', () => {
    expect(() => windowManager.open('unknown')).toThrow('[WindowManager] 未知窗口名称：unknown')
  })

  it('创建非法 URL 的窗口时应抛出错误', () => {
    expect(() =>
      windowManager.create({
        name: 'illegal',
        url: '/not-hash',
      })
    ).toThrow('[WindowManager] 非法窗口 URL')
  })

  it('创建窗口后应能通过名称获取', () => {
    const win = windowManager.create({
      name: 'test-create',
      url: '#/test',
      width: 800,
      height: 600,
    })

    expect(win).toBeDefined()
    expect(windowManager.has('test-create')).toBe(true)
    expect(windowManager.get('test-create')).toBe(win)
  })

  it('重复创建同名窗口时应聚焦已存在窗口', () => {
    const win1 = windowManager.create({
      name: 'test-singleton',
      url: '#/test',
    })
    const win2 = windowManager.create({
      name: 'test-singleton',
      url: '#/test',
    })

    expect(win1).toBe(win2)
    expect(win1.focus).toHaveBeenCalled()
  })

  it('关闭窗口后应无法获取', () => {
    windowManager.create({
      name: 'test-close',
      url: '#/test',
    })

    windowManager.close('test-close')
    expect(windowManager.has('test-close')).toBe(false)
  })

  it('getAll 应返回所有存活窗口', () => {
    windowManager.create({ name: 'test-all-1', url: '#/test1' })
    windowManager.create({ name: 'test-all-2', url: '#/test2' })

    expect(windowManager.getAll()).toHaveLength(2)
  })

  it('getNameByWindow 应根据窗口对象返回注册名称', () => {
    const win = windowManager.create({
      name: 'test-name',
      url: '#/test',
    })

    expect(windowManager.getNameByWindow(win)).toBe('test-name')
  })

  it('getNameByWindow 对 undefined 或已销毁窗口应返回 undefined', () => {
    expect(windowManager.getNameByWindow(undefined)).toBeUndefined()

    const destroyedWin = { isDestroyed: () => true } as unknown as Electron.BrowserWindow
    expect(windowManager.getNameByWindow(destroyedWin)).toBeUndefined()
  })
})
