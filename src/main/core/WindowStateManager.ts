import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { logger } from './LoggerManager'

/**
 * 窗口状态数据类型
 */
interface WindowState {
  /** 窗口左上角横坐标 */
  x: number
  /** 窗口左上角纵坐标 */
  y: number
  /** 窗口宽度 */
  width: number
  /** 窗口高度 */
  height: number
  /** 是否最大化 */
  isMaximized: boolean
  /** 是否全屏 */
  isFullScreen: boolean
}

/**
 * 窗口状态持久化管理器（单例）
 *
 * 将窗口的位置、尺寸、最大化状态保存到用户数据目录下的 JSON 文件，
 * 下次启动时恢复。已保存的状态会检查是否在当前可用的显示器范围内，
 * 防止因多显示器环境变化导致窗口跑到屏幕外。
 */
export class WindowStateManager {
  private static instance: WindowStateManager | null = null
  private readonly stateFilePath: string

  private constructor() {
    // 状态文件存放在 Electron 用户数据目录下
    this.stateFilePath = path.join(app.getPath('userData'), 'window-state.json')
  }

  static getInstance(): WindowStateManager {
    if (!WindowStateManager.instance) {
      WindowStateManager.instance = new WindowStateManager()
    }
    return WindowStateManager.instance
  }

  /**
   * 读取所有窗口的状态数据。
   */
  private readState(): Record<string, WindowState> {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return {}
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8')
      return JSON.parse(raw) as Record<string, WindowState>
    } catch (err) {
      logger.error('[WindowStateManager] 读取窗口状态失败：', err)
      return {}
    }
  }

  /**
   * 写入所有窗口的状态数据（异步，避免主进程事件循环阻塞）。
   */
  private async writeState(state: Record<string, WindowState>): Promise<void> {
    try {
      await fsPromises.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      logger.error('[WindowStateManager] 写入窗口状态失败：', err)
    }
  }

  /**
   * 保存指定窗口的当前状态。
   */
  async save(name: string, win: BrowserWindow): Promise<void> {
    try {
      if (win.isDestroyed()) return

      const bounds = win.getBounds()
      const state = this.readState()

      state[name] = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: win.isMaximized(),
        isFullScreen: win.isFullScreen(),
      }

      await this.writeState(state)
      logger.info(`[WindowStateManager] 已保存窗口 "${name}" 的状态`)
    } catch (err) {
      logger.error(`[WindowStateManager] 保存窗口 "${name}" 状态失败：`, err)
    }
  }

  /**
   * 加载指定窗口的保存状态。
   * 返回的对象可以直接展开到 BrowserWindow 构造参数中。
   */
  load(name: string): Partial<WindowState> {
    try {
      const state = this.readState()
      const saved = state[name]
      if (!saved) return {}

      // 多显示器边界保护：如果保存的位置不在任何可用屏幕内，则忽略位置信息
      if (!this.isBoundsVisible(saved)) {
        logger.warn(`[WindowStateManager] 窗口 "${name}" 的保存位置不在当前屏幕范围内，将使用默认位置。`)
        return {
          width: saved.width,
          height: saved.height,
        }
      }

      return { ...saved }
    } catch (err) {
      logger.error(`[WindowStateManager] 加载窗口 "${name}" 状态失败：`, err)
      return {}
    }
  }

  /**
   * 清除指定窗口的保存状态。
   */
  async clear(name: string): Promise<void> {
    try {
      const state = this.readState()
      delete state[name]
      await this.writeState(state)
    } catch (err) {
      logger.error(`[WindowStateManager] 清除窗口 "${name}" 状态失败：`, err)
    }
  }

  /**
   * 判断给定的窗口边界是否至少有一部分落在某个可用显示器内。
   *
   * 窗口在显示器内至少需要 100px 宽度或总面积的 10% 才被视为"可见"，
   * 防止超宽窗口仅 1px 边缘在屏幕内时仍被恢复到该位置。
   */
  private isBoundsVisible(bounds: Rectangle): boolean {
    const displays = screen.getAllDisplays()
    const MIN_VISIBLE_PX = 100

    return displays.some((display) => {
      const area = display.workArea

      // 计算窗口与显示器工作区的交集
      const overlapLeft = Math.max(bounds.x, area.x)
      const overlapTop = Math.max(bounds.y, area.y)
      const overlapRight = Math.min(bounds.x + bounds.width, area.x + area.width)
      const overlapBottom = Math.min(bounds.y + bounds.height, area.y + area.height)

      const overlapWidth = overlapRight - overlapLeft
      const overlapHeight = overlapBottom - overlapTop

      if (overlapWidth <= 0 || overlapHeight <= 0) return false

      // 窗口在显示器内的可见部分至少需要 MIN_VISIBLE_PX 宽度，或占总窗口面积的 10%
      const totalArea = bounds.width * bounds.height
      const overlapArea = overlapWidth * overlapHeight
      return overlapWidth >= MIN_VISIBLE_PX || (totalArea > 0 && overlapArea / totalArea >= 0.1)
    })
  }
}

export const windowStateManager = WindowStateManager.getInstance()
