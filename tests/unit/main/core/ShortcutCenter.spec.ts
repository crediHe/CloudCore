// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

import { ShortcutCenter } from '../../../../src/main/core/ShortcutCenter'

describe('ShortcutCenter', () => {
  beforeEach(() => {
    ;(ShortcutCenter as unknown as { instance: ShortcutCenter | null }).instance = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    ShortcutCenter.getInstance().unregisterAll()
  })

  it('应为单例', () => {
    expect(ShortcutCenter.getInstance()).toBe(ShortcutCenter.getInstance())
  })

  it('register 应注册全局快捷键并返回 true', () => {
    const center = ShortcutCenter.getInstance()
    const callback = vi.fn()

    const result = center.register('Ctrl+Shift+A', callback, '测试快捷键')

    expect(result).toBe(true)
    expect(mockElectron.globalShortcut.register).toHaveBeenCalledWith('Ctrl+Shift+A', expect.any(Function))
  })

  it('重复注册同一快捷键应返回 false', () => {
    const center = ShortcutCenter.getInstance()
    const callback = vi.fn()

    center.register('Ctrl+Shift+A', callback)
    const result = center.register('Ctrl+Shift+A', callback)

    expect(result).toBe(false)
  })

  it('注册失败时应返回 false', () => {
    mockElectron.globalShortcut.register.mockReturnValueOnce(false)
    const center = ShortcutCenter.getInstance()

    const result = center.register('Ctrl+Shift+B', vi.fn())

    expect(result).toBe(false)
  })

  it('unregister 应注销指定快捷键', () => {
    const center = ShortcutCenter.getInstance()
    center.register('Ctrl+Shift+C', vi.fn())

    center.unregister('Ctrl+Shift+C')

    expect(mockElectron.globalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+C')
  })

  it('unregisterAll 应注销所有快捷键', () => {
    const center = ShortcutCenter.getInstance()
    center.register('Ctrl+Shift+D', vi.fn())
    center.register('Ctrl+Shift+E', vi.fn())

    center.unregisterAll()

    expect(mockElectron.globalShortcut.unregisterAll).toHaveBeenCalled()
  })

  it('getRegisteredAccelerators 应返回已注册快捷键列表', () => {
    const center = ShortcutCenter.getInstance()
    center.register('Ctrl+Shift+F', vi.fn())

    expect(center.getRegisteredAccelerators()).toEqual(['Ctrl+Shift+F'])
  })
})
