// @vitest-environment jsdom
/* eslint-disable vue/one-component-per-file */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const createHttpClientMock = vi.fn((baseURL: string) => ({ baseURL }))

vi.mock('../../../../src/shared/http', () => ({
  createHttpClient: (...args: unknown[]) => createHttpClientMock(...args),
}))

describe('useHttp', () => {
  beforeEach(() => {
    vi.resetModules()
    createHttpClientMock.mockClear()
    vi.stubEnv('VITE_API_URL', 'http://api.example.com')
  })

  it('应使用 VITE_API_URL 创建 HTTP 客户端', async () => {
    const { useHttp } = await import('../../../../src/renderer/composables/useHttp')

    const TestComponent = defineComponent({
      setup() {
        const http = useHttp()
        expect(http.baseURL).toBe('http://api.example.com')
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
  })

  it('多次调用应返回同一实例', async () => {
    const { useHttp } = await import('../../../../src/renderer/composables/useHttp')

    const TestComponent = defineComponent({
      setup() {
        const first = useHttp()
        const second = useHttp()
        expect(first).toBe(second)
        expect(createHttpClientMock).toHaveBeenCalledTimes(1)
        return {}
      },
      render() {
        return h('div')
      },
    })

    mount(TestComponent)
  })
})
