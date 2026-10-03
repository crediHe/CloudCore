import { app, ipcMain } from 'electron'
import log from 'electron-log/main'
import { windowManager } from './core/WindowManager'
import { shortcutCenter } from './core/ShortcutCenter'
import { trayManager } from './core/TrayManager'
import { pluginRegistry } from './core/PluginRegistry'
import {
  loggerPlugin,
  robustnessPlugin,
  crossWindowBridgePlugin,
  dialogPlugin,
  updatePlugin,
  storePlugin,
  notificationPlugin,
  windowControlPlugin,
  windowManagerPlugin,
  shortcutPlugin,
  trayPlugin,
  menuPlugin,
  plyPlugin,
  lasPlugin,
  pointCloudSavePlugin,
  nativeModulePlugin,
} from './plugins'
import { appEnv } from './core/env'

// 注册所有内置插件。顺序有讲究：日志与健壮性必须最早初始化。
pluginRegistry.register(loggerPlugin)
pluginRegistry.register(robustnessPlugin)
pluginRegistry.register(crossWindowBridgePlugin)
pluginRegistry.register(plyPlugin)
pluginRegistry.register(lasPlugin)
pluginRegistry.register(pointCloudSavePlugin)
pluginRegistry.register(nativeModulePlugin)
pluginRegistry.register(dialogPlugin)
pluginRegistry.register(updatePlugin)
pluginRegistry.register(storePlugin)
pluginRegistry.register(notificationPlugin)
pluginRegistry.register(windowControlPlugin)
pluginRegistry.register(windowManagerPlugin)
pluginRegistry.register(shortcutPlugin)
pluginRegistry.register(trayPlugin)
pluginRegistry.register(menuPlugin)

// 输出当前环境信息，仅用于调试。注意不要在日志中打印密钥等敏感信息。
log.info('[main] MODE:', appEnv.MODE)
log.info('[main] API_URL:', appEnv.API_URL)

// 统一初始化所有插件，注入主进程核心依赖。
pluginRegistry.initializeAll({
  app,
  ipcMain,
  windowManager,
  shortcutCenter,
  trayManager,
  logger: log,
})

// 当所有窗口关闭时退出应用（macOS 除外）。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 点击 Dock 图标且没有窗口时重新打开主窗口（macOS 行为）。
app.on('activate', () => {
  if (windowManager.getAll().length === 0) {
    windowManager.open('main')
  }
})

// 应用即将退出时，通过插件注册中心统一销毁所有插件，
// 避免 main.ts 直接调用 ShortcutCenter / TrayManager 的具体方法。
app.on('will-quit', () => {
  pluginRegistry.destroy(log)
})

app.whenReady().then(() => {
  windowManager.open('main')
  pluginRegistry.ready(log)
})
