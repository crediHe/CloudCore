// @vitest-environment jsdom
/* eslint-disable vue/one-component-per-file */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useStore } from '../../../../src/renderer/composables/useStore'

describe('useStore', () => {
  beforeEach(() => {
    ;(globalThis as unknown as Record<string, unknown>).window = {
      electronAPI: {
        store: {
          get: vi.fn().mockResolvedValue('dark'),
          set: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as Window & typeof globalThis
  })

  it('get 应调用 store.get 并返回值', async () => {
    const TestComponent = defineComponent({
      setup() {
        const { get } = useStore()
        get<string>('userPreferences.theme').then((value) => {
          expect(value).toBe('dark')
        })
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
    expect(window.electronAPI.store.get).toHaveBeenCalledWith('userPreferences.theme', undefined)
  })

  it('set 应调用 store.set', () => {
    const TestComponent = defineComponent({
      setup() {
        const { set } = useStore()
        set('userPreferences.theme', 'light')
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
    expect(window.electronAPI.store.set).toHaveBeenCalledWith('userPreferences.theme', 'light')
  })
})
