// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useNotification } from '../../../../src/renderer/composables/useNotification'

describe('useNotification', () => {
  beforeEach(() => {
    ;(globalThis as unknown as Record<string, unknown>).window = {
      electronAPI: {
        notification: {
          show: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as Window & typeof globalThis
  })

  it('show 应调用 notification.show', () => {
    const TestComponent = defineComponent({
      setup() {
        const { show } = useNotification()
        show('标题', '内容')
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
    expect(window.electronAPI.notification.show).toHaveBeenCalledWith('标题', '内容')
  })
})
