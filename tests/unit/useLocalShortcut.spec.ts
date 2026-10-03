// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useLocalShortcut } from '../../src/renderer/composables/useLocalShortcut'

/**
 * 测试组件：绑定 Ctrl+K 局部快捷键，触发时调用回调。
 */
const TestComponent = defineComponent({
  setup() {
    const handler = vi.fn()
    useLocalShortcut('Ctrl+K', handler)
    return { handler }
  },
  render() {
    return h('div')
  },
})

describe('useLocalShortcut', () => {
  it('应在按下匹配快捷键时触发回调', async () => {
    const wrapper = mount(TestComponent)
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    window.dispatchEvent(event)

    expect(wrapper.vm.handler).toHaveBeenCalled()
  })

  it('应在输入框中默认不触发快捷键', async () => {
    const wrapper = mount(TestComponent)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    input.dispatchEvent(event)

    expect(wrapper.vm.handler).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })
})
