import Store from 'electron-store'
import type { IpcMain } from 'electron'
import { logger } from './LoggerManager'
import { appEnv } from './env'

/**
 * 本地持久化存储的 Schema 定义。
 *
 * 用于为 electron-store 提供类型支持，同时约定默认数据结构。
 */
interface StoreSchema {
  launchCount: number
  userPreferences: {
    theme: string
    language: string
  }
}

/**
 * StoreSchema 中所有允许的键（包含嵌套属性的点路径）。
 * 用于 IPC 处理器中的运行时白名单校验。
 */
const ALLOWED_KEYS: readonly string[] = [
  'launchCount',
  'userPreferences',
  'userPreferences.theme',
  'userPreferences.language',
]

/**
 * 本地持久化存储管理器。
 *
 * 基于 electron-store 封装，提供类型安全的键值存储能力。
 * 主进程负责创建 Store 实例，渲染进程通过 Preload 暴露的 API 读写数据。
 */
export class StoreManager {
  private static instance: StoreManager | null = null
  private store: Store<StoreSchema>

  static getInstance(): StoreManager {
    if (!StoreManager.instance) {
      StoreManager.instance = new StoreManager()
    }
    return StoreManager.instance
  }

  private constructor() {
    this.store = new Store<StoreSchema>({
      // 根据环境区分配置名称，避免开发/生产数据互相污染
      name: appEnv.MODE === 'development' ? 'app-config-dev' : 'app-config',
      defaults: {
        launchCount: 0,
        userPreferences: {
          theme: 'default',
          language: 'zh-CN',
        },
      },
    })
  }

  /** 读取指定键的值（需在白名单内）。 */
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!ALLOWED_KEYS.includes(key)) {
      logger.warn(`[StoreManager] 拒绝读取未知键 "${key}"，允许的键：${ALLOWED_KEYS.join(', ')}`)
      return defaultValue
    }
    return this.store.get(key as keyof StoreSchema, defaultValue as StoreSchema[keyof StoreSchema]) as T
  }

  /** 写入指定键的值（需在白名单内）。 */
  set<T>(key: string, value: T): void {
    if (!ALLOWED_KEYS.includes(key)) {
      logger.warn(`[StoreManager] 拒绝写入未知键 "${key}"，允许的键：${ALLOWED_KEYS.join(', ')}`)
      return
    }
    this.store.set(key as keyof StoreSchema, value as StoreSchema[keyof StoreSchema])
  }

  /** 删除指定键（需在白名单内）。 */
  delete(key: string): void {
    if (!ALLOWED_KEYS.includes(key)) {
      logger.warn(`[StoreManager] 拒绝删除未知键 "${key}"，允许的键：${ALLOWED_KEYS.join(', ')}`)
      return
    }
    this.store.delete(key as keyof StoreSchema)
  }

  /** 清空所有存储数据（慎用）。 */
  clear(): void {
    this.store.clear()
  }

  /** 获取当前存储文件路径（调试用）。 */
  getPath(): string {
    return this.store.path
  }

  /**
   * 注册存储相关的 IPC 处理器。
   *
   * @param ipcMain Electron 主进程 IPC 实例
   */
  registerIpcHandlers(ipcMain: IpcMain): void {
    // 白名单校验已下沉到 get/set/delete 方法中，IPC handler 无需重复检查。
    ipcMain.handle('store:get', (_event, key: string, defaultValue: unknown) => {
      try {
        return this.get(key, defaultValue)
      } catch (err) {
        logger.error('[StoreManager] store:get 失败：', err)
        return defaultValue
      }
    })

    ipcMain.handle('store:set', (_event, key: string, value: unknown) => {
      try {
        this.set(key, value)
      } catch (err) {
        logger.error('[StoreManager] store:set 失败：', err)
      }
    })

    ipcMain.handle('store:delete', (_event, key: string) => {
      try {
        this.delete(key)
      } catch (err) {
        logger.error('[StoreManager] store:delete 失败：', err)
      }
    })
  }

  /**
   * 在每次启动时累加启动计数。
   * 该调用应在 IPC 注册之后执行，确保渲染进程能读取到最新值。
   */
  bumpLaunchCount(): void {
    try {
      const currentCount = this.get<number>('launchCount', 0) ?? 0
      this.set('launchCount', currentCount + 1)
    } catch (err) {
      logger.error('[StoreManager] 更新启动计数失败：', err)
    }
  }
}

export const storeManager = StoreManager.getInstance()
