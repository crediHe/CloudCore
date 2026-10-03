// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any, vue/one-component-per-file */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useUpdate } from '../../src/renderer/composables/useUpdate'

describe('useUpdate', () => {
  beforeEach(() => {
    ;(globalThis as any).window.electronEvents = {
      onUpdateStateChanged: vi.fn(() => {
        return () => {}
      }),
    }
    ;(globalThis as any).window.electronAPI = {
      update: {
        check: vi.fn(),
        download: vi.fn(),
        quitAndInstall: vi.fn(),
      },
    }
  })

  it('应暴露 idle 初始状态', () => {
    const TestComponent = defineComponent({
      setup() {
        const { state } = useUpdate()
        return { state }
      },
      render() {
        return h('div')
      },
    })

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.state.phase).toBe('idle')
  })

  it('应响应主进程推送的状态变更', () => {
    let stateCallback: ((event: unknown, state: { phase: string }) => void) | null = null
    ;(globalThis as any).window.electronEvents = {
      onUpdateStateChanged: vi.fn((callback) => {
        stateCallback = callback
        return () => {}
      }),
    }

    const TestComponent = defineComponent({
      setup() {
        const { state } = useUpdate()
        return { state }
      },
      render() {
        return h('div')
      },
    })

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.state.phase).toBe('idle')

    stateCallback?.({}, { phase: 'available' })
    expect(wrapper.vm.state.phase).toBe('available')
  })

  it('应能通过 electronAPI 调用 check', async () => {
    const TestComponent = defineComponent({
      setup() {
        const { check } = useUpdate()
        return { check }
      },
      render() {
        return h('div')
      },
    })

    const wrapper = mount(TestComponent)
    await wrapper.vm.check()
    expect(window.electronAPI.update.check).toHaveBeenCalled()
  })
})
