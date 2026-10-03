import { ipcRenderer } from 'electron'
import type {
  CrossWindowMessage,
  CrossWindowRendererAPI,
  WindowConfig,
  WindowManagerRendererAPI,
} from '../shared/types/window'
import type { OpenDialogOptions, SaveDialogOptions } from '../shared/types/dialog'

import type { UpdateState } from '../shared/types/update'
import type { PlyChunkRequest, PlyScanRequest } from '../shared/types/ply'
import type { LasChunkRequest } from '../shared/types/las'
import type {
  SaveAbortRequest,
  SaveBeginRequest,
  SaveChunkRequest,
  SaveEndRequest,
} from '../shared/types/pointcloud-save'
import type { AppAPI, ElectronAPI, ElectronEvents, WindowControlAPI, UpdateAPI } from '../shared/types/electron-api'

import type { PlyAPI, LasAPI, NativeAPI, PointCloudSaveAPI } from '../shared/types/electron-api'

export type { ElectronAPI, ElectronEvents, WindowControlAPI, UpdateAPI, PlyAPI, LasAPI, NativeAPI, PointCloudSaveAPI }

// ------------------------------------------------------------------
// 预加载脚本向渲染进程暴露的 API 类型定义。
// 具体接口定义位于 src/shared/types/electron-api.ts；
// 全局 Window 扩展位于 src/renderer/types/electron.d.ts，供 UI 代码使用。
// ------------------------------------------------------------------

// --------- 向渲染进程暴露 API ---------
// 上下文隔离已关闭（2026-09 性能优先决策，见 WindowManager.ts webPreferences 注释）：
// contextBridge 仅在隔离开启时可用，此处改为直接挂全局（preload 与页面同属主世界，
// 页面脚本可见性与隔离开启时经 contextBridge 暴露一致）。
const electronAPI = {
  app: {
    quit: () => ipcRenderer.send('app:quit'),
  } satisfies AppAPI,

  windowControl: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    unmaximize: () => ipcRenderer.send('window-unmaximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized') as Promise<boolean>,
  } satisfies WindowControlAPI,

  windowManager: {
    open: (name: string) => ipcRenderer.invoke('window-manager-open', name),
    create: (config: WindowConfig) => ipcRenderer.invoke('window-manager-create', config),
    close: (name: string) => ipcRenderer.invoke('window-manager-close', name),
    focus: (name: string) => ipcRenderer.invoke('window-manager-focus', name),
  } satisfies WindowManagerRendererAPI,

  crossWindow: {
    send: <T>(channel: string, payload: T, target?: string) => {
      ipcRenderer.send('cross-window-send', { channel, target, payload })
    },
    on: <T>(channel: string, callback: (message: CrossWindowMessage<T>) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, message: CrossWindowMessage<T>) => {
        if (message.channel === channel) {
          callback(message)
        }
      }
      ipcRenderer.on('cross-window-message', listener)
      return () => {
        ipcRenderer.off('cross-window-message', listener)
      }
    },
  } satisfies CrossWindowRendererAPI,

  dialog: {
    openDirectory: (options?: OpenDialogOptions) => ipcRenderer.invoke('dialog:openDirectory', options),
    openFile: (options?: OpenDialogOptions) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options?: SaveDialogOptions) => ipcRenderer.invoke('dialog:saveFile', options),
  },

  ply: {
    getFileInfo: (path: string) => ipcRenderer.invoke('ply:get-file-info', path),
    readChunk: (request: PlyChunkRequest) => ipcRenderer.invoke('ply:read-chunk', request),
    scanBBox: (request: PlyScanRequest) => ipcRenderer.invoke('ply:scan-bbox', request),
  },

  las: {
    getFileInfo: (path: string) => ipcRenderer.invoke('las:get-file-info', path),
    readChunk: (request: LasChunkRequest) => ipcRenderer.invoke('las:read-chunk', request),
  },

  pointCloudSave: {
    begin: (request: SaveBeginRequest) => ipcRenderer.invoke('pointcloud:save-begin', request),
    chunk: (request: SaveChunkRequest) => ipcRenderer.invoke('pointcloud:save-chunk', request),
    end: (request: SaveEndRequest) => ipcRenderer.invoke('pointcloud:save-end', request),
    abort: (request: SaveAbortRequest) => ipcRenderer.invoke('pointcloud:save-abort', request),
  },

  logger: {
    debug: (...args: unknown[]) => ipcRenderer.invoke('logger:log', 'debug', args),
    info: (...args: unknown[]) => ipcRenderer.invoke('logger:log', 'info', args),
    warn: (...args: unknown[]) => ipcRenderer.invoke('logger:log', 'warn', args),
    error: (...args: unknown[]) => ipcRenderer.invoke('logger:log', 'error', args),
  },

  devTools: {
    open: () => ipcRenderer.invoke('devTools:open'),
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    quitAndInstall: () => ipcRenderer.invoke('update:quit-and-install'),
  } satisfies UpdateAPI,

  store: {
    get: <T>(key: string, defaultValue?: T) =>
      ipcRenderer.invoke('store:get', key, defaultValue) as Promise<T | undefined>,
    set: <T>(key: string, value: T) => ipcRenderer.invoke('store:set', key, value) as Promise<void>,
    delete: (key: string) => ipcRenderer.invoke('store:delete', key) as Promise<void>,
  },

  notification: {
    show: (title: string, body: string) => ipcRenderer.invoke('notification:show', title, body) as Promise<void>,
  },

  native: {
    getModulePath: (name: string) => ipcRenderer.invoke('native:get-module-path', name),
  } satisfies NativeAPI,
} satisfies ElectronAPI

// 同时暴露类型化的辅助对象，用于订阅主进程的推送消息。
const electronEvents = {
  onWindowStateChanged: (callback: (event: unknown, state: { isMaximized: boolean }) => void) => {
    const listener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      callback(event, args[0] as { isMaximized: boolean })
    }
    ipcRenderer.on('window-state-changed', listener)

    return () => {
      ipcRenderer.off('window-state-changed', listener)
    }
  },
  onMainProcessMessage: (callback: (event: unknown, message: string) => void) => {
    const listener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      callback(event, args[0] as string)
    }
    ipcRenderer.on('main-process-message', listener)

    return () => {
      ipcRenderer.off('main-process-message', listener)
    }
  },

  onUpdateStateChanged: (callback: (event: unknown, state: UpdateState) => void) => {
    const listener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      callback(event, args[0] as UpdateState)
    }
    ipcRenderer.on('update-state-changed', listener)

    return () => {
      ipcRenderer.off('update-state-changed', listener)
    }
  },
} satisfies ElectronEvents

// 挂到主世界全局（preload 先于页面脚本执行，Vue 启动时即可见）。
;(globalThis as { electronAPI?: ElectronAPI }).electronAPI = electronAPI
;(globalThis as { electronEvents?: ElectronEvents }).electronEvents = electronEvents
