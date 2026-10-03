/**
 * 本地持久化存储组合式函数。
 *
 * 通过 Preload 桥接 electron-store，渲染进程不直接访问 Node.js 文件系统。
 */
export function useStore() {
  const store = window.electronAPI.store

  return {
    /** 读取指定键的值。 */
    get: <T>(key: string, defaultValue?: T) => store.get<T>(key, defaultValue),

    /** 写入指定键的值。 */
    set: <T>(key: string, value: T) => store.set<T>(key, value),

    /** 删除指定键。 */
    delete: (key: string) => store.delete(key),
  }
}
