/**
 * 日志相关类型定义。
 *
 * 这些类型在主进程与渲染进程之间共享，确保 IPC 调用类型安全。
 */

/** 支持的日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 序列化后的错误对象，用于跨 IPC 传输。 */
export interface SerializedError {
  /** 标记这是一个错误对象。 */
  __isError: true
  /** 错误名称。 */
  name: string
  /** 错误消息。 */
  message: string
  /** 错误堆栈（可选）。 */
  stack?: string
}

/** 序列化后的单条日志参数。 */
export type SerializedLogArg = string | number | boolean | null | undefined | SerializedError | Record<string, unknown>

/** 序列化后的日志参数数组。 */
export type SerializedLogArgs = SerializedLogArg[]
