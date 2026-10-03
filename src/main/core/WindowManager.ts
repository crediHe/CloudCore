import { BrowserWindow } from 'electron'
import path from 'node:path'
import type { WindowConfig, WindowDefinition } from '../../shared/types/window'
import { logger } from './LoggerManager'
import { appEnv } from './env'
import { windowStateManager } from './WindowStateManager'

// 复用主进程入口中的公共资源目录解析逻辑
const __dirname = import.meta.dirname
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const APP_ROOT = process.env.APP_ROOT ?? path.join(__dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(APP_ROOT, 'public') : RENDERER_DIST

const PRELOAD_PATH = path.join(__dirname, 'preload.mjs')

/** 预定义窗口配置表。 */
const WINDOW_REGISTRY: Record<string, WindowDefinition> = {
  main: {
    name: 'main',
    url: '#/',
    title: 'CloudCore',
    width: 1000,
    height: 650,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    frameless: true,
    rememberState: true,
    singleton: true,
    minimizeToTray: true, // 主窗口最小化时隐藏到托盘
  },
  settings: {
    name: 'settings',
    url: '#/settings',
    title: '设置',
    width: 700,
    height: 500,
    minWidth: 500,
    minHeight: 350,
    resizable: true,
    frameless: true,
    rememberState: false,
    singleton: true,
  },
}

/** 校验动态窗口 URL 是否为安全的 hash 路由。 */
function isValidWindowUrl(url: string): boolean {
  return url.startsWith('#')
}

export class WindowManager {
  private static instance: WindowManager | null = null
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly windowNames = new Map<number, string>()

  private constructor() {}

  static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager()
    }
    return WindowManager.instance
  }

  /** 根据动态配置创建窗口。 */
  create(config: WindowConfig): BrowserWindow {
    if (!isValidWindowUrl(config.url)) {
      throw new Error(`[WindowManager] 非法窗口 URL：${config.url}。只允许以 "#" 开头的 hash 路由。`)
    }

    // 同名窗口已存在且未销毁时，直接聚焦而不是重复创建
    const existing = this.get(config.name)
    if (existing) {
      existing.focus()
      return existing
    }

    // 如果需要记住状态，则从持久化存储中加载上次的位置与尺寸
    const savedState = config.rememberState ? windowStateManager.load(config.name) : {}
    if (config.rememberState && Object.keys(savedState).length > 0) {
      logger.info(`[WindowManager] 已恢复窗口 "${config.name}" 的保存状态`)
    }

    const win = new BrowserWindow({
      title: config.title ?? config.name,
      x: savedState.x,
      y: savedState.y,
      width: savedState.width ?? config.width ?? 800,
      height: savedState.height ?? config.height ?? 600,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      resizable: config.resizable ?? true,
      // frame: false 即可实现无边框窗口；不设置 titleBarStyle 避免 Windows 上
      // Electron 28+ 保留原生窗口控制按钮（与自定义 TitleBar 冲突）。
      frame: !(config.frameless ?? false),
      // Windows 11 Mica 材质（浅色主题下呈现白色半透明色调）
      backgroundMaterial: 'mica',
      // Win10 回退：浅色背景
      backgroundColor: '#fcf8f9',
      icon: path.join(process.env.VITE_PUBLIC!, 'electron-vite.svg'),
      show: false, // 等待 ready-to-show 后再显示，避免白屏闪烁
      webPreferences: {
        preload: PRELOAD_PATH,
        // 性能优先决策（2026-09）：允许渲染进程直接 require 原生 node-addon
        //（半径滤波等 C++ 算法贴数据零拷贝计算）。注意安全边界已为此让位：
        // 渲染进程拥有完整 Node 权限，应用不得加载不可信远程内容。
        nodeIntegration: true,
        // contextIsolation 必须关：开启时 Node 只注入 preload 的隔离世界，页面主世界
        // 拿不到 require；而 three.js 缓冲在主世界，跨世界传递只能拷贝、无法零拷贝。
        // contextBridge 要求隔离开启、随之不可用，preload 改为直接挂全局 electronAPI
        //（同世界直挂，页面调用方式与隔离开启时一致，见 preload.ts 注释）。
        contextIsolation: false,
        // Electron 20+ 默认沙箱会强制忽略 nodeIntegration，必须显式关闭
        sandbox: false,
      },
    })

    // 通过 id→name 映射保存窗口名称，避免在 BrowserWindow 实例上附加自定义属性
    this.windowNames.set(win.id, config.name)

    win.once('ready-to-show', () => {
      win.show()
      // 如果上次退出时处于最大化状态，则恢复最大化
      if (config.rememberState && savedState.isMaximized) {
        win.maximize()
      }
    })

    // 移动或调整尺寸时进行防抖保存，防止崩溃时状态丢失
    let saveTimer: NodeJS.Timeout | null = null
    if (config.rememberState) {
      const debouncedSave = () => {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          if (!win.isDestroyed()) {
            windowStateManager.save(config.name, win)
          }
        }, 500)
      }

      win.on('move', debouncedSave)
      win.on('resize', debouncedSave)
    }

    // 窗口关闭时保存状态（如果需要记住状态），并清理定时器避免泄漏
    win.on('close', () => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (config.rememberState) {
        windowStateManager.save(config.name, win)
      }
    })

    win.on('closed', () => {
      this.windows.delete(config.name)
      this.windowNames.delete(win.id)
    })

    // 通知标题栏更新最大化/恢复图标
    win.on('maximize', () => {
      win.webContents.send('window-state-changed', { isMaximized: true })
    })
    win.on('unmaximize', () => {
      win.webContents.send('window-state-changed', { isMaximized: false })
    })

    // 如果配置为最小化到托盘，则拦截最小化事件并隐藏窗口
    if (config.minimizeToTray) {
      win.on('minimize', (event: Electron.Event) => {
        event.preventDefault()
        win.hide()
      })
    }

    // 开发环境通过 Vite DevServer 加载页面；生产环境加载打包后的 index.html，并通过 hash 参数指定路由
    if (VITE_DEV_SERVER_URL) {
      void win.loadURL(`${VITE_DEV_SERVER_URL}${config.url}`)
    } else {
      void win.loadFile(path.join(RENDERER_DIST, 'index.html'), { hash: config.url.slice(1) })
    }

    // 开发环境仅为主窗口自动打开 DevTools（detach 模式，独立窗口不挤压内容区）。
    // Autofill CDP 警告为 Chromium DevTools 正常行为，不影响功能。
    if (appEnv.MODE === 'development' && config.name === 'main') {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    this.windows.set(config.name, win)
    return win
  }

  /** 根据预定义名称打开窗口。 */
  open(name: string): BrowserWindow {
    const definition = WINDOW_REGISTRY[name]
    if (!definition) {
      throw new Error(`[WindowManager] 未知窗口名称：${name}`)
    }
    return this.create(definition)
  }

  /** 关闭指定名称的窗口。
   *
   * 注意：不在此处同步删除窗口引用，由 `closed` 事件异步清理。
   * 避免在窗口关闭期间立即 open() 同名窗口时绕过幂等检查，产生双窗口竞态。
   */
  close(name: string): void {
    const win = this.windows.get(name)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  }

  /** 关闭所有受管窗口。 */
  closeAll(): void {
    for (const [name] of this.windows) {
      this.close(name)
    }
  }

  /** 聚焦指定名称的窗口。 */
  focus(name: string): void {
    const win = this.windows.get(name)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  }

  /** 获取指定名称的窗口。 */
  get(name: string): BrowserWindow | undefined {
    const win = this.windows.get(name)
    if (win && win.isDestroyed()) {
      this.windows.delete(name)
      return undefined
    }
    return win
  }

  /** 判断指定窗口是否存在且存活。 */
  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /** 获取所有存活的受管窗口。 */
  getAll(): BrowserWindow[] {
    return Array.from(this.windows.values()).filter((win) => !win.isDestroyed())
  }

  /** 根据 BrowserWindow 实例查找其注册名称。 */
  getNameByWindow(win: BrowserWindow | undefined): string | undefined {
    if (!win || win.isDestroyed()) return undefined
    return this.windowNames.get(win.id)
  }
}

export const windowManager = WindowManager.getInstance()
