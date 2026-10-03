import { vi } from 'vitest'

/**
 * 创建支持 on/once/off 的简单事件发射器 mock。
 */
function createEventEmitterMock() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(callback)
    }),
    once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(callback)
    }),
    off: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (!handlers[event]) return
      handlers[event] = handlers[event].filter((cb) => cb !== callback)
    }),
    emit: (event: string, ...args: unknown[]) => {
      handlers[event]?.forEach((callback) => callback(...args))
    },
  }
}

/**
 * Electron 模块的通用 mock。
 * 在主进程单元测试中使用 vi.mock('electron', () => mockElectron)。
 */
export const mockElectron = {
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/tmp/electron-user-data'
      if (name === 'exe') return '/tmp/app.exe'
      return '/tmp'
    }),
    isPackaged: false,
    name: 'TestApp',
    quit: vi.fn(),
    exit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: vi.fn().mockImplementation(() => {
    const events = createEventEmitterMock()
    const id = Math.floor(Math.random() * 1000000)
    return {
      id,
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      close: vi.fn().mockImplementation(() => events.emit('closed')),
      destroy: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      restore: vi.fn(),
      getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
      setBounds: vi.fn(),
      setFullScreen: vi.fn(),
      webContents: {
        send: vi.fn(),
        reload: vi.fn(),
        openDevTools: vi.fn(),
        toggleDevTools: vi.fn(),
      },
      ...events,
    }
  }),
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({})),
    setApplicationMenu: vi.fn(),
  },
  Tray: vi.fn().mockImplementation(() => ({
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
    popUpContextMenu: vi.fn(),
  })),
  Notification: Object.assign(
    vi.fn().mockImplementation(() => ({
      show: vi.fn(),
      on: vi.fn(),
    })),
    {
      isSupported: vi.fn(() => true),
    }
  ),
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({})),
  },
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
    isRegistered: vi.fn(() => false),
  },
  crashReporter: {
    start: vi.fn(),
  },
}
