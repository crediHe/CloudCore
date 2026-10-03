import { Menu, type MenuItemConstructorOptions, app } from 'electron'
import { windowManager } from './WindowManager'

/**
 * 原生应用菜单管理器（单例）。
 *
 * 负责构建并设置 Electron 主窗口的顶部菜单栏（Application Menu）。
 * 菜单触发的事件统一通过主进程处理，不直接暴露给渲染进程。
 */
export class MenuManager {
  private static instance: MenuManager | null = null

  static getInstance(): MenuManager {
    if (!MenuManager.instance) {
      MenuManager.instance = new MenuManager()
    }
    return MenuManager.instance
  }

  /**
   * 构建并设置应用菜单。
   */
  createMenu(): void {
    const template: MenuItemConstructorOptions[] = [
      {
        label: '文件',
        submenu: [
          {
            label: '打开设置窗口',
            accelerator: 'CmdOrCtrl+,',
            click: () => {
              windowManager.open('settings')
            },
          },
          { type: 'separator' },
          {
            label: '退出',
            accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
            click: () => {
              app.quit()
            },
          },
        ],
      },
      {
        label: '视图',
        submenu: [
          {
            label: '重新加载',
            accelerator: 'CmdOrCtrl+R',
            click: (_item, focusedWindow) => {
              focusedWindow?.webContents.reload()
            },
          },
          {
            label: '切换全屏',
            accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11',
            click: (_item, focusedWindow) => {
              if (focusedWindow) {
                focusedWindow.setFullScreen(!focusedWindow.isFullScreen())
              }
            },
          },
          { type: 'separator' },
          {
            label: '打开开发者工具',
            accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
            click: (_item, focusedWindow) => {
              focusedWindow?.webContents.toggleDevTools()
            },
          },
        ],
      },
      {
        label: '窗口',
        submenu: [
          {
            label: '最小化',
            accelerator: 'CmdOrCtrl+M',
            click: (_item, focusedWindow) => {
              focusedWindow?.minimize()
            },
          },
          {
            label: '关闭窗口',
            accelerator: 'CmdOrCtrl+W',
            click: (_item, focusedWindow) => {
              focusedWindow?.close()
            },
          },
        ],
      },
      {
        label: '帮助',
        submenu: [
          {
            label: '关于',
            click: () => {
              const mainWindow = windowManager.get('main')
              if (mainWindow && !mainWindow.isDestroyed()) {
                // 通过主进程向渲染进程发送消息，展示关于信息
                mainWindow.webContents.send('main-process-message', '点击了菜单：关于')
              }
            },
          },
        ],
      },
    ]

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
  }

  /**
   * 隐藏应用菜单（适用于无边框窗口或自定义标题栏场景）。
   */
  hideMenu(): void {
    Menu.setApplicationMenu(null)
  }
}

export const menuManager = MenuManager.getInstance()
