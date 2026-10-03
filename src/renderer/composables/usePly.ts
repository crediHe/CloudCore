import type { PlyChunkRequest, PlyScanRequest } from '../../shared/types/ply'

/**
 * 渲染进程 PLY 文件读取组合式函数。
 *
 * 所有调用都通过 Preload 桥接到主进程，渲染进程不直接访问 Electron API。
 */
export function usePly() {
  const ply = window.electronAPI.ply

  return {
    /** 获取 PLY 文件信息（文件大小、顶点数、数据偏移）。 */
    getFileInfo: (path: string) => ply.getFileInfo(path),
    /** 分块读取 PLY 二进制点数据。 */
    readChunk: (request: PlyChunkRequest) => ply.readChunk(request),
    /** 扫描整个文件算包围盒（double 精度）。 */
    scanBBox: (request: PlyScanRequest) => ply.scanBBox(request),
  }
}
