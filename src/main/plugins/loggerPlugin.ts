import type { AppPlugin } from '../core/PluginRegistry'
import { loggerManager } from '../core/LoggerManager'

/**
 * 日志插件。
 *
 * 负责最早阶段初始化 electron-log，确保后续插件与主进程都能使用日志能力。
 */
export const loggerPlugin: AppPlugin = {
  name: 'logger',
  initialize() {
    loggerManager.initialize()
  },
  // LoggerManager 的 IPC 处理器在模块加载时已注册，无需额外销毁。
  destroy() {},
}
