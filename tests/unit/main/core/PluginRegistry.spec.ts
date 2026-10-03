import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginRegistry, type AppPlugin, type PluginContext } from '../../../../src/main/core/PluginRegistry'

function resetPluginRegistry() {
  ;(PluginRegistry as unknown as { instance: PluginRegistry | null }).instance = null
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as PluginContext['logger']
}

function createMockContext(): PluginContext {
  return {
    app: {} as PluginContext['app'],
    ipcMain: {} as PluginContext['ipcMain'],
    windowManager: {} as PluginContext['windowManager'],
    shortcutCenter: {
      unregisterAll: vi.fn(),
    } as unknown as PluginContext['shortcutCenter'],
    trayManager: {
      destroyTray: vi.fn(),
    } as unknown as PluginContext['trayManager'],
    logger: createMockLogger(),
    onReady: vi.fn(),
  }
}

describe('PluginRegistry', () => {
  beforeEach(() => {
    resetPluginRegistry()
  })

  it('应按注册顺序初始化所有插件', () => {
    const registry = PluginRegistry.getInstance()
    const order: string[] = []

    const pluginA: AppPlugin = {
      name: 'a',
      initialize: () => order.push('a'),
    }
    const pluginB: AppPlugin = {
      name: 'b',
      initialize: () => order.push('b'),
    }

    registry.register(pluginA)
    registry.register(pluginB)
    registry.initializeAll(createMockContext())

    expect(order).toEqual(['a', 'b'])
  })

  it('应通过 context.onReady 收集 Ready 回调，并在 ready() 之前不触发', () => {
    const registry = PluginRegistry.getInstance()
    const callback = vi.fn()

    const plugin: AppPlugin = {
      name: 'ready-plugin',
      initialize({ onReady }) {
        onReady(callback)
      },
    }

    registry.register(plugin)
    registry.initializeAll(createMockContext())

    expect(callback).not.toHaveBeenCalled()

    registry.ready(createMockLogger())

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('ready() 应按 onReady 注册顺序触发回调', () => {
    const registry = PluginRegistry.getInstance()
    const order: string[] = []

    registry.register({
      name: 'first',
      initialize({ onReady }) {
        onReady(() => order.push('first'))
      },
    })

    registry.register({
      name: 'second',
      initialize({ onReady }) {
        onReady(() => order.push('second'))
      },
    })

    registry.initializeAll(createMockContext())
    registry.ready(createMockLogger())

    expect(order).toEqual(['first', 'second'])
  })

  it('应允许注册同名插件而不报错', () => {
    const registry = PluginRegistry.getInstance()
    const plugin: AppPlugin = {
      name: 'duplicate',
      initialize: vi.fn(),
    }

    expect(() => {
      registry.register(plugin)
      registry.register(plugin)
      registry.initializeAll(createMockContext())
    }).not.toThrow()

    expect(plugin.initialize).toHaveBeenCalledTimes(2)
  })

  it('日志应记录每个插件的初始化', () => {
    const registry = PluginRegistry.getInstance()
    const context = createMockContext()

    registry.register({
      name: 'logged',
      initialize: vi.fn(),
    })

    registry.initializeAll(context)

    expect(context.logger.info).toHaveBeenCalledWith('[PluginRegistry] 初始化插件: logged')
  })

  it('initializeAll() 应隔离插件初始化异常，不影响后续插件', () => {
    const registry = PluginRegistry.getInstance()
    const order: string[] = []
    const context = createMockContext()

    registry.register({
      name: 'bad',
      initialize: () => {
        order.push('bad')
        throw new Error('初始化失败')
      },
    })

    registry.register({
      name: 'good',
      initialize: () => order.push('good'),
    })

    expect(() => registry.initializeAll(context)).not.toThrow()
    expect(order).toEqual(['bad', 'good'])
    expect(context.logger.error).toHaveBeenCalledWith('[PluginRegistry] 插件 "bad" 初始化失败：', expect.any(Error))
  })

  it('ready() 应隔离回调异常，不影响后续回调', () => {
    const registry = PluginRegistry.getInstance()
    const order: string[] = []
    const logger = createMockLogger()

    registry.register({
      name: 'bad-ready',
      initialize({ onReady }) {
        onReady(() => {
          order.push('bad')
          throw new Error('ready 失败')
        })
      },
    })

    registry.register({
      name: 'good-ready',
      initialize({ onReady }) {
        onReady(() => order.push('good'))
      },
    })

    registry.initializeAll(createMockContext())

    expect(() => registry.ready(logger)).not.toThrow()
    expect(order).toEqual(['bad', 'good'])
    expect(logger.error).toHaveBeenCalledWith('[PluginRegistry] ready 回调执行失败：', expect.any(Error))
  })

  it('destroy() 应按注册倒序执行插件销毁', () => {
    const registry = PluginRegistry.getInstance()
    const order: string[] = []
    const logger = createMockLogger()

    registry.register({
      name: 'first',
      initialize: vi.fn(),
      destroy: () => order.push('first-destroy'),
    })

    registry.register({
      name: 'second',
      initialize: vi.fn(),
      destroy: () => order.push('second-destroy'),
    })

    registry.destroy(logger)

    expect(order).toEqual(['second-destroy', 'first-destroy'])
    expect(logger.info).toHaveBeenCalledWith('[PluginRegistry] 销毁插件: second')
    expect(logger.info).toHaveBeenCalledWith('[PluginRegistry] 销毁插件: first')
  })

  it('destroy() 应隔离插件销毁异常，不影响其他插件销毁', () => {
    const registry = PluginRegistry.getInstance()
    const order: string[] = []
    const logger = createMockLogger()

    registry.register({
      name: 'bad-destroy',
      initialize: vi.fn(),
      destroy: () => {
        order.push('bad')
        throw new Error('销毁失败')
      },
    })

    registry.register({
      name: 'good-destroy',
      initialize: vi.fn(),
      destroy: () => order.push('good'),
    })

    expect(() => registry.destroy(logger)).not.toThrow()
    expect(order).toEqual(['good', 'bad'])
    expect(logger.error).toHaveBeenCalledWith('[PluginRegistry] 插件 "bad-destroy" 销毁失败：', expect.any(Error))
  })
})
