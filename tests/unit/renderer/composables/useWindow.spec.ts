// @vitest-environment jsdom
/* eslint-disable vue/one-component-per-file */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useWindow } from '../../../../src/renderer/composables/useWindow'

describe('useWindow', () => {
  beforeEach(() => {
    ;(globalThis as unknown as Record<string, unknown>).window = {
      electronAPI: {
        windowManager: {
          open: vi.fn(),
          create: vi.fn(),
          close: vi.fn(),
          focus: vi.fn(),
        },
      },
    } as unknown as Window & typeof globalThis
  })

  it('open 应调用 windowManager.open', () => {
    const TestComponent = defineComponent({
      setup() {
        const { open } = useWindow()
        open('settings')
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
    expect(window.electronAPI.windowManager.open).toHaveBeenCalledWith('settings')
  })

  it('openSettings 应调用 windowManager.open("settings")', () => {
    const TestComponent = defineComponent({
      setup() {
        const { openSettings } = useWindow()
        openSettings()
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
    expect(window.electronAPI.windowManager.open).toHaveBeenCalledWith('settings')
  })
})
