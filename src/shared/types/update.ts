/**
 * 自动更新状态。
 * 供主进程与渲染进程共享。
 */
export interface UpdateState {
  /** 当前更新流程阶段。 */
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  /** 可安装的新版本号（仅在 available / downloaded 阶段有效）。 */
  version?: string
  /** 错误信息（仅在 error 阶段有效）。 */
  message?: string
  /** 下载进度百分比（仅在 downloading 阶段有效）。 */
  percent?: number
}
