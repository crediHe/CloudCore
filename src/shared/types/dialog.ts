/**
 * 对话框相关类型定义
 *
 * 这些类型由主进程、Preload、渲染进程共享，确保 IPC 调用类型安全。
 */

/** 打开对话框（选择目录/文件）的选项。 */
export interface OpenDialogOptions {
  /** 对话框标题。 */
  title?: string
  /** 默认打开路径。 */
  defaultPath?: string
  /** 确认按钮自定义文本。 */
  buttonLabel?: string
  /** 文件过滤器；选择目录时通常不需要。 */
  filters?: Array<{ name: string; extensions: string[] }>
  /** 是否允许多选（仅对选择文件有效）。 */
  multiSelections?: boolean
}

/** 保存对话框的选项。 */
export interface SaveDialogOptions {
  /** 对话框标题。 */
  title?: string
  /** 默认保存路径/文件名。 */
  defaultPath?: string
  /** 确认按钮自定义文本。 */
  buttonLabel?: string
  /** 文件过滤器。 */
  filters?: Array<{ name: string; extensions: string[] }>
}
