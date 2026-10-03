/**
 * 多窗口管理与跨窗口通信的共享类型。
 *
 * 这些类型同时被主进程与渲染进程使用，必须保持无依赖，以便在任何位置导入。
 */

/** 支持的构建模式。 */
export type AppMode = 'development' | 'production' | 'test'

/** 用于动态创建新 BrowserWindow 的配置。 */
export interface WindowConfig {
  /** 唯一窗口标识符。 */
  name: string
  /** 要加载的 hash 路由，例如 "#/settings"，必须以 "#" 开头。 */
  url: string
  /** 窗口标题，显示在操作系统标题栏中（如适用）。 */
  title?: string
  /** 初始宽度，单位为像素。 */
  width?: number
  /** 初始高度，单位为像素。 */
  height?: number
  /** 最小宽度，单位为像素。 */
  minWidth?: number
  /** 最小高度，单位为像素。 */
  minHeight?: number
  /** 是否允许用户调整窗口大小。 */
  resizable?: boolean
  /** 是否使用自定义无边框标题栏。 */
  frameless?: boolean
  /** 是否在应用重启后持久化该窗口的状态。 */
  rememberState?: boolean
  /** 最小化窗口时是否隐藏到系统托盘。 */
  minimizeToTray?: boolean
}

/** 通过主进程中继在窗口间发送的消息协议。 */
export interface CrossWindowMessage<T = unknown> {
  /** 业务通道名称，例如 "theme-changed"。 */
  channel: string
  /** 目标窗口名称；省略则向所有其他窗口广播。 */
  target?: string
  /** 消息载荷。 */
  payload: T
  /** 发送方窗口名称（由主进程中继注入）。 */
  from: string
}

/** 预定义窗口注册项。 */
export interface WindowDefinition extends WindowConfig {
  /** 该窗口是否为单例窗口（只允许一个实例）。 */
  singleton?: boolean
}

/** 面向渲染进程的窗口管理器 API。 */
export interface WindowManagerRendererAPI {
  /** 根据预定义名称创建或聚焦窗口。 */
  open: (name: string) => Promise<void>
  /** 根据动态配置创建窗口。 */
  create: (config: WindowConfig) => Promise<void>
  /** 根据名称关闭窗口。 */
  close: (name: string) => void
  /** 根据名称聚焦窗口。 */
  focus: (name: string) => void
}

/** 面向渲染进程的跨窗口通信 API。 */
export interface CrossWindowRendererAPI {
  /** 向其他窗口发送消息（省略 target 则广播）。 */
  send: <T>(channel: string, payload: T, target?: string) => void
  /** 订阅指定通道的消息，返回取消订阅函数。 */
  on: <T>(channel: string, callback: (message: CrossWindowMessage<T>) => void) => () => void
}
