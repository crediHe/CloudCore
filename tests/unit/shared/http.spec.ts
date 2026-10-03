// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { createHttpClient, HttpError } from '../../../src/shared/http'

vi.mock('axios')

describe('createHttpClient', () => {
  const mockRequest = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(axios.create as ReturnType<typeof vi.fn>).mockReturnValue({
      request: mockRequest,
      interceptors: {
        request: { use: vi.fn(() => 1) },
        response: { use: vi.fn(() => 2) },
      },
    })
  })

  it('应创建带 baseURL 的 HTTP 客户端', () => {
    createHttpClient('http://api.example.com')

    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://api.example.com',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      })
    )
  })

  it('get 应返回响应数据', async () => {
    const client = createHttpClient('http://api.example.com')
    mockRequest.mockResolvedValueOnce({ data: { id: 1 } })

    const result = await client.get<{ id: number }>('/items/1')

    expect(result).toEqual({ id: 1 })
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/items/1' }))
  })

  it('post 应发送请求体', async () => {
    const client = createHttpClient('http://api.example.com')
    mockRequest.mockResolvedValueOnce({ data: { success: true } })

    const result = await client.post('/items', { name: 'test' })

    expect(result).toEqual({ success: true })
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: '/items', data: { name: 'test' } })
    )
  })

  it('Axios 错误应包装为 HttpError', async () => {
    const client = createHttpClient('http://api.example.com')
    mockRequest.mockRejectedValue({
      response: { status: 404, statusText: 'Not Found', data: { message: 'not found' } },
      message: 'Request failed',
    })
    ;(axios.isAxiosError as ReturnType<typeof vi.fn>).mockReturnValue(true)

    await expect(client.get('/missing')).rejects.toThrow(HttpError)
    await expect(client.get('/missing')).rejects.toThrow('HTTP 错误 404: Not Found')
  })

  it('非 Axios 错误应原样抛出', async () => {
    const client = createHttpClient('http://api.example.com')
    const error = new Error('network error')
    mockRequest.mockRejectedValueOnce(error)
    ;(axios.isAxiosError as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)

    await expect(client.get('/error')).rejects.toThrow(error)
  })
})
