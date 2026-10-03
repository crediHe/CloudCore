import axios, { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'

/**
 * HTTP 请求配置（对外暴露的简化版本）。
 */
export interface HttpRequestConfig {
  /** 请求头。 */
  headers?: Record<string, string>
  /** URL 查询参数。 */
  params?: Record<string, string | number | boolean>
}

/**
 * HTTP 客户端接口。
 */
export interface HttpClient {
  /** 发起 GET 请求。 */
  get<T>(url: string, config?: HttpRequestConfig): Promise<T>
  /** 发起 POST 请求。 */
  post<T>(url: string, body?: unknown, config?: HttpRequestConfig): Promise<T>
  /** 发起 PUT 请求。 */
  put<T>(url: string, body?: unknown, config?: HttpRequestConfig): Promise<T>
  /** 发起 DELETE 请求。 */
  delete<T>(url: string, config?: HttpRequestConfig): Promise<T>

  /**
   * 添加请求拦截器。
   * 返回的拦截器 ID 可用于后续移除。
   */
  addRequestInterceptor(
    onFulfilled?: (
      config: InternalAxiosRequestConfig
    ) => InternalAxiosRequestConfig | Promise<InternalAxiosRequestConfig>,
    onRejected?: (error: unknown) => unknown
  ): number

  /**
   * 添加响应拦截器。
   * 返回的拦截器 ID 可用于后续移除。
   */
  addResponseInterceptor(
    onFulfilled?: (response: AxiosResponse<unknown>) => AxiosResponse<unknown> | Promise<AxiosResponse<unknown>>,
    onRejected?: (error: unknown) => unknown
  ): number
}

/**
 * 结构化的 HTTP 异常。
 */
export class HttpError extends Error {
  /** HTTP 状态码。 */
  status: number
  /** HTTP 状态文本。 */
  statusText: string
  /** 服务端返回的错误数据（如果有）。 */
  data: unknown

  constructor(status: number, statusText: string, data: unknown) {
    super(`HTTP 错误 ${status}: ${statusText}`)
    this.name = 'HttpError'
    this.status = status
    this.statusText = statusText
    this.data = data
  }
}

/**
 * 创建 HttpClient 实例。
 *
 * @param baseURL - API 基础地址，通常来自环境变量。
 */
export function createHttpClient(baseURL: string): HttpClient {
  const instance: AxiosInstance = axios.create({
    baseURL,
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  })

  /**
   * 执行实际请求并统一处理错误。
   */
  async function request<T>(method: string, url: string, body?: unknown, config?: HttpRequestConfig): Promise<T> {
    try {
      const response = await instance.request<T>({
        method,
        url,
        data: body,
        ...config,
      })
      return response.data
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const axiosError = err as AxiosError<unknown>
        const status = axiosError.response?.status ?? 0
        const statusText = axiosError.response?.statusText ?? axiosError.message
        const data = axiosError.response?.data
        throw new HttpError(status, statusText, data)
      }
      throw err
    }
  }

  return {
    get: <T>(url: string, config?: HttpRequestConfig) => request<T>('GET', url, undefined, config),
    post: <T>(url: string, body?: unknown, config?: HttpRequestConfig) => request<T>('POST', url, body, config),
    put: <T>(url: string, body?: unknown, config?: HttpRequestConfig) => request<T>('PUT', url, body, config),
    delete: <T>(url: string, config?: HttpRequestConfig) => request<T>('DELETE', url, undefined, config),
    addRequestInterceptor: (onFulfilled, onRejected) => instance.interceptors.request.use(onFulfilled, onRejected),
    addResponseInterceptor: (onFulfilled, onRejected) => instance.interceptors.response.use(onFulfilled, onRejected),
  }
}
