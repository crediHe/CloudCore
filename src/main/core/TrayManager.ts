import { Tray, Menu, app, nativeImage } from 'electron'
import path from 'node:path'
import { logger } from './LoggerManager'
import { windowManager } from './WindowManager'

/**
 * 系统托盘管理器（单例）
 *
 * 负责创建托盘图标、右键菜单，以及主窗口的显示/隐藏/退出控制。
 */
export class TrayManager {
  private static instance: TrayManager | null = null
  private tray: Tray | null = null

  private constructor() {}

  static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager()
    }
    return TrayManager.instance
  }

  /**
   * 创建系统托盘图标与菜单。
   *
   * 根据平台选择对应格式的图标文件（Windows: .ico，其他: .png），
   * 确保未来启用跨平台构建时托盘图标正常显示。
   */
  createTray(): void {
    if (this.tray) return

    const iconExt = process.platform === 'win32' ? 'ico' : 'png'
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, `icon.${iconExt}`)
      : path.join(process.cwd(), 'resources', `icon.${iconExt}`)
    const icon = nativeImage.createFromPath(iconPath)

    this.tray = new Tray(icon)
    this.tray.setToolTip('CloudCore')

    // 单击托盘图标：切换主窗口显示/隐藏
    this.tray.on('click', () => {
      this.toggleMainWindow()
    })

    // 右键托盘图标：显示上下文菜单
    this.tray.on('right-click', () => {
      this.updateContextMenu()
      this.tray?.popUpContextMenu()
    })

    this.updateContextMenu()
    logger.info('[TrayManager] 系统托盘已创建')
  }

  /**
   * 根据主窗口当前可见性重建右键菜单。
   */
  private updateContextMenu(): void {
    if (!this.tray) return

    const mainWindow = windowManager.get('main')
    const isVisible = mainWindow?.isVisible() ?? false

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: isVisible ? '隐藏主窗口' : '显示主窗口',
        click: () => {
          if (isVisible) {
            this.hideMainWindow()
          } else {
            this.showMainWindow()
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        },
      },
    ]

    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  /**
   * 显示并聚焦主窗口。
   */
  showMainWindow(): void {
    const mainWindow = windowManager.get('main')
    if (!mainWindow || mainWindow.isDestroyed()) {
      windowManager.open('main')
      this.updateContextMenu()
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    this.updateContextMenu()
  }

  /**
   * 隐藏主窗口到托盘。
   */
  hideMainWindow(): void {
    const mainWindow = windowManager.get('main')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
    this.updateContextMenu()
  }

  /**
   * 切换主窗口显示/隐藏状态。
   */
  toggleMainWindow(): void {
    const mainWindow = windowManager.get('main')
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      this.hideMainWindow()
    } else {
      this.showMainWindow()
    }
  }

  /**
   * 销毁托盘图标，通常在应用退出前调用。
   */
  destroyTray(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
      logger.info('[TrayManager] 系统托盘已销毁')
    }
  }
}

export const trayManager = TrayManager.getInstance()
