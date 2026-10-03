import type { AppPlugin } from '../core/PluginRegistry'
import { robustnessManager } from '../core/RobustnessManager'

/**
 * 应用健壮性插件。
 *
 * 负责初始化单实例锁、崩溃报告与全局异常兜底。
 */
export const robustnessPlugin: AppPlugin = {
  name: 'robustness',
  initialize() {
    robustnessManager.initialize()
  },
  // 单实例锁、崩溃报告器与全局异常兜底由 Electron 进程退出时自动清理，无需额外操作。
  destroy() {},
}
