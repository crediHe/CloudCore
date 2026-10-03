import { createHttpClient } from '../../shared/http'
import type { HttpClient } from '../../shared/http'

/**
 * 渲染进程 HttpClient 单例。
 *
 * 在首次调用时根据 `import.meta.env.VITE_API_URL` 创建实例，
 * 后续复用该实例，避免重复创建 axios 实例。
 */
let httpClient: HttpClient | null = null

/**
 * 获取渲染进程 HTTP 客户端。
 */
export function useHttp(): HttpClient {
  if (!httpClient) {
    const baseURL = import.meta.env.VITE_API_URL || ''
    httpClient = createHttpClient(baseURL)
  }
  return httpClient
}
