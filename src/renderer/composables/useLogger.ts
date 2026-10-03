import type { LogLevel, SerializedLogArg } from '../../shared/types/logger'

/**
 * 序列化单条日志参数。
 *
 * Error 对象无法直接通过 IPC 传输，因此转换为可克隆的 plain object。
 */
function serializeArg(arg: unknown): SerializedLogArg {
  if (arg instanceof Error) {
    return {
      __isError: true,
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    }
  }
  return arg as SerializedLogArg
}

/**
 * 渲染进程日志组合式函数。
 *
 * 所有日志通过 Preload 桥接到主进程，再由 electron-log 写入文件。
 */
export function useLogger() {
  const logger = window.electronAPI.logger

  function log(level: LogLevel, ...args: unknown[]) {
    return logger[level](...args.map(serializeArg))
  }

  return {
    /** 调试日志。 */
    debug: (...args: unknown[]) => log('debug', ...args),
    /** 普通信息日志。 */
    info: (...args: unknown[]) => log('info', ...args),
    /** 警告日志。 */
    warn: (...args: unknown[]) => log('warn', ...args),
    /** 错误日志。 */
    error: (...args: unknown[]) => log('error', ...args),
  }
}
