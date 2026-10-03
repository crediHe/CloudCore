import type { LasChunkRequest } from '../../shared/types/las'

/**
 * 渲染进程 LAS 文件读取组合式函数。
 *
 * 所有调用都通过 Preload 桥接到主进程，渲染进程不直接访问 Electron API。
 */
export function useLas() {
  const las = window.electronAPI.las

  return {
    /** 获取 LAS 文件信息（解析二进制头部：版本、点数、缩放/偏移、包围盒）。 */
    getFileInfo: (path: string) => las.getFileInfo(path),
    /** 分块读取 LAS 二进制点数据。 */
    readChunk: (request: LasChunkRequest) => las.readChunk(request),
  }
}
