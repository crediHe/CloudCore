import type { CrossWindowMessage, CrossWindowRendererAPI, WindowManagerRendererAPI } from './window'
import type { OpenDialogOptions, SaveDialogOptions } from './dialog'
import type { LogLevel } from './logger'
import type { UpdateState } from './update'
import type { PlyBBox, PlyChunkRequest, PlyChunkResult, PlyFileInfo, PlyScanRequest } from './ply'
import type { LasChunkRequest, LasChunkResult, LasFileInfo } from './las'
import type {
  SaveAbortRequest,
  SaveBeginRequest,
  SaveBeginResult,
  SaveChunkRequest,
  SaveEndRequest,
  SaveEndResult,
} from './pointcloud-save'

/**
 * 当前窗口控制 API。
 */
export interface WindowControlAPI {
  /** 最小化当前窗口。 */
  minimize: () => void
  /** 最大化当前窗口。 */
  maximize: () => void
  /** 从最大化状态恢复当前窗口。 */
  unmaximize: () => void
  /** 关闭当前窗口。 */
  close: () => void
  /** 返回当前窗口是否已最大化。 */
  isMaximized: () => Promise<boolean>
}

/**
 * 自动更新 API。
 */
export interface UpdateAPI {
  /** 检查是否有可用更新。 */
  check: () => Promise<void>
  /** 手动下载已发现的更新。 */
  download: () => Promise<void>
  /** 退出当前应用并安装已下载的更新。 */
  quitAndInstall: () => Promise<void>
}

/**
 * 应用级 API。
 */
export interface AppAPI {
  /** 立即退出应用（与关闭窗口不同：主窗口关闭会隐藏到托盘）。 */
  quit: () => void
}

/**
 * PLY 文件读取 API。
 */
export interface PlyAPI {
  /** 获取 PLY 文件信息（文件大小、顶点数、数据偏移）。 */
  getFileInfo: (path: string) => Promise<PlyFileInfo>
  /** 分块读取 PLY 二进制点数据。 */
  readChunk: (request: PlyChunkRequest) => Promise<PlyChunkResult>
  /** 扫描整个文件算包围盒（double 精度，计算全局基准点用，不跨 IPC 传点数据）。 */
  scanBBox: (request: PlyScanRequest) => Promise<PlyBBox>
}

/**
 * LAS 文件读取 API。
 */
export interface LasAPI {
  /** 获取 LAS 文件信息（解析二进制头部：版本、点数、缩放/偏移、包围盒等）。 */
  getFileInfo: (path: string) => Promise<LasFileInfo>
  /** 分块读取 LAS 二进制点数据。 */
  readChunk: (request: LasChunkRequest) => Promise<LasChunkResult>
}

/**
 * 点云「另存为」API（分块流式写盘，与读侧的 get-file-info + read-chunk 对称）。
 *
 * 流程固定为 begin → chunk × N → end；中途失败或用户取消调 abort（主进程会删除
 * 半成品文件，不留 truncate 的 .las / .ply）。
 */
export interface PointCloudSaveAPI {
  /** 启动保存会话：主进程开文件并写好头部。 */
  begin: (request: SaveBeginRequest) => Promise<SaveBeginResult>
  /** 追加一批点（一批最多几百 KB～几 MB，避免大文件一次跨 IPC）。 */
  chunk: (request: SaveChunkRequest) => Promise<void>
  /** 收尾：回填 LAS 头部包围盒并关闭文件。 */
  end: (request: SaveEndRequest) => Promise<SaveEndResult>
  /** 中止并删除半成品文件。 */
  abort: (request: SaveAbortRequest) => Promise<void>
}

/**
 * 渲染进程通过 `window.electronAPI` 访问的完整 API。
 */
export interface ElectronAPI {
  /** 应用级操作。 */
  app: AppAPI
  /** 当前窗口控制。 */
  windowControl: WindowControlAPI
  /** 窗口管理器。 */
  windowManager: WindowManagerRendererAPI
  /** 跨窗口通信。 */
  crossWindow: CrossWindowRendererAPI
  /** 系统对话框。 */
  dialog: {
    /** 打开目录选择器。 */
    openDirectory: (options?: OpenDialogOptions) => Promise<string[] | undefined>
    /** 打开文件选择器。 */
    openFile: (options?: OpenDialogOptions) => Promise<string[] | undefined>
    /** 打开保存文件对话框。 */
    saveFile: (options?: SaveDialogOptions) => Promise<string | undefined>
  }
  /** 日志写入。 */
  logger: Record<LogLevel, (...args: unknown[]) => Promise<void>>
  /** DevTools 控制。 */
  devTools: {
    /** 打开当前窗口的 DevTools。 */
    open: () => Promise<void>
  }
  /** 自动更新。 */
  update: UpdateAPI
  /** 本地持久化存储。 */
  store: {
    /** 读取指定键的值。 */
    get: <T>(key: string, defaultValue?: T) => Promise<T | undefined>
    /** 写入指定键的值。 */
    set: <T>(key: string, value: T) => Promise<void>
    /** 删除指定键。 */
    delete: (key: string) => Promise<void>
  }
  /** 系统通知。 */
  notification: {
    /** 发送一条系统通知。 */
    show: (title: string, body: string) => Promise<void>
  }
  /** PLY 文件读取。 */
  ply: PlyAPI
  /** LAS 文件读取。 */
  las: LasAPI
  /** 点云另存为（PLY / LAS 写入）。 */
  pointCloudSave: PointCloudSaveAPI
  /** 原生模块（node-addon）加载路径通道。 */
  native: NativeAPI
}

/**
 * 原生模块（node-addon）产物路径信息。
 */
export interface NativeModulePathInfo {
  /** .node 产物的绝对路径（dev = 项目根；打包后 = app.asar.unpacked 镜像路径）。 */
  path: string
  /** 产物文件是否存在（渲染进程据此给出友好报错，提示先跑 pnpm build:native）。 */
  exists: boolean
}

/**
 * 原生模块加载通道。
 *
 * 渲染进程已开启 nodeIntegration 直接 require .node 产物（贴数据零拷贝计算），
 * 但产物路径依 dev / 打包环境而异，由主进程统一解析后经 IPC 下发。
 */
export interface NativeAPI {
  /** 按模块名获取 .node 产物绝对路径与存在性。 */
  getModulePath: (name: string) => Promise<NativeModulePathInfo>
}

/**
 * 渲染进程通过 `window.electronEvents` 订阅主进程推送事件。
 */
export interface ElectronEvents {
  /** 窗口最大化状态变更。 */
  onWindowStateChanged: (callback: (event: unknown, state: { isMaximized: boolean }) => void) => () => void
  /** 主进程主动推送的消息。 */
  onMainProcessMessage: (callback: (event: unknown, message: string) => void) => () => void
  /** 自动更新状态变更。 */
  onUpdateStateChanged: (callback: (event: unknown, state: UpdateState) => void) => () => void
}

export { CrossWindowMessage }
