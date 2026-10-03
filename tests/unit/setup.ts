import { vi } from 'vitest'

/**
 * 全局 Mock：electron-log/main。
 *
 * 所有主进程单元测试都会通过 LoggerManager 间接导入 electron-log，
 * 其内部 require('electron') 在 CI 环境中会因 Electron 二进制未安装而失败。
 * 此 mock 在测试收集前生效，使 electron-log 的代码完全不被加载。
 */
vi.mock('electron-log/main', () => {
  const logFn = vi.fn()
  return {
    default: {
      info: logFn,
      warn: logFn,
      error: logFn,
      debug: logFn,
      verbose: logFn,
      silly: logFn,
      initialize: vi.fn(),
      transports: {
        file: {
          resolvePathFn: undefined as unknown as (variables: { fileName?: string }) => string,
        },
      },
    },
  }
})
