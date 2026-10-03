/**
 * 点云「另存为」写盘管理器（单例）。
 *
 * 与读侧（PlyManager / LasManager 的"读头部 + 逐块读"）严格对称的**写**通道：
 * begin（开文件、写头部）→ chunk × N（逐批编码落盘）→ end（回填头部包围盒、关闭）。
 * 逐批而非一次全量：1 亿点也不会出现单条 IPC 消息几 GB 的峰值。
 *
 * 三条纪律：
 * 1. **同时只允许一个活跃会话**：新 begin 会先中止旧会话（渲染进程重启 / 上一轮异常
 *    退出时可能留下残留），避免两个 fd 同时写同一批数据。
 * 2. **任何失败路径都不留半成品**：abort 与编码异常都关闭句柄并删除文件 —— 用户拿到
 *    一个 truncate 的 .las 比拿到"保存失败"更糟。
 * 3. **编码与格式知识全在主进程**（plyWriter / lasWriter），渲染侧只负责摊点集与
 *    颜色转码，将来换 native 实现时契约不变。
 */

import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { type IpcMain } from 'electron'
import { logger } from './LoggerManager'
import { buildPlyHeader, encodePlyBatch } from './plyWriter'
import {
  buildLasHeader,
  encodeLasBBoxPatch,
  encodeLasBatch,
  planLasLayout,
  type LasIntBBox,
  type LasPlan,
} from './lasWriter'
import type {
  SaveAbortRequest,
  SaveBeginRequest,
  SaveBeginResult,
  SaveChunkRequest,
  SaveEndRequest,
  SaveEndResult,
  SaveFormat,
} from '../../shared/types/pointcloud-save'

/** 进行中的写盘会话。 */
interface SaveSession {
  id: string
  path: string
  format: SaveFormat
  /** 打开的文件句柄（`fs.FileHandle` 只挂在 promises 命名空间上，没有具名导出可 import）。 */
  fd: fs.FileHandle
  /** 头部声明的总点数（收尾时校验实际写入量，防止写出"头部说谎"的文件）。 */
  expectedPoints: number
  pointsWritten: number
  bytesWritten: number
  /** 全局基准点：显示坐标 + 它 = 原始坐标（两种格式的编码都要用）。 */
  basePoint: { x: number; y: number; z: number }
  /** LAS：布局规划 + 累积的 int32 坐标包围盒（收尾回填头部用）。 */
  las: { plan: LasPlan; intBBox: LasIntBBox | null } | null
}

export class PointCloudSaveManager {
  private static instance: PointCloudSaveManager | null = null
  private constructor() {}

  static getInstance(): PointCloudSaveManager {
    if (!PointCloudSaveManager.instance) {
      PointCloudSaveManager.instance = new PointCloudSaveManager()
    }
    return PointCloudSaveManager.instance
  }

  private sessions = new Map<string, SaveSession>()

  registerIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('pointcloud:save-begin', async (_event, request: SaveBeginRequest): Promise<SaveBeginResult> => {
      try {
        return await this.begin(request)
      } catch (err) {
        logger.error('[PointCloudSaveManager] 启动保存失败：', err)
        throw err
      }
    })

    ipcMain.handle('pointcloud:save-chunk', async (_event, request: SaveChunkRequest): Promise<void> => {
      try {
        await this.appendChunk(request)
      } catch (err) {
        logger.error('[PointCloudSaveManager] 写入分块失败：', err)
        throw err
      }
    })

    ipcMain.handle('pointcloud:save-end', async (_event, request: SaveEndRequest): Promise<SaveEndResult> => {
      try {
        return await this.end(request)
      } catch (err) {
        logger.error('[PointCloudSaveManager] 收尾保存失败：', err)
        throw err
      }
    })

    ipcMain.handle('pointcloud:save-abort', async (_event, request: SaveAbortRequest): Promise<void> => {
      try {
        await this.abort(request.sessionId)
      } catch (err) {
        logger.error('[PointCloudSaveManager] 中止保存失败：', err)
        throw err
      }
    })
  }

  /** 启动保存会话：开文件并写好头部。 */
  private async begin(request: SaveBeginRequest): Promise<SaveBeginResult> {
    if (!request.path) throw new Error('保存路径为空')
    if (!Number.isInteger(request.pointCount) || request.pointCount < 0) {
      throw new Error(`点数非法：${request.pointCount}`)
    }
    // 纪律 1：新会话顶替旧会话（残留会话可能仍在持有 fd）
    for (const id of [...this.sessions.keys()]) {
      logger.warn('[PointCloudSaveManager] 检测到未收尾的会话，已中止：', id)
      await this.abort(id)
    }

    const fd = await fs.open(request.path, 'w')
    const session: SaveSession = {
      id: randomUUID(),
      path: request.path,
      format: request.format,
      fd,
      expectedPoints: request.pointCount,
      pointsWritten: 0,
      bytesWritten: 0,
      basePoint: request.basePoint,
      las: null,
    }

    try {
      let header: Buffer
      if (request.format === 'ply') {
        header = buildPlyHeader(request.pointCount)
      } else if (request.format === 'las') {
        const plan = planLasLayout(request.bbox, request.hasColor)
        session.las = { plan, intBBox: null }
        // 头部先按请求里的包围盒写；收尾时用实际写入的 int32 坐标回填（见 end）
        header = buildLasHeader(plan, request.pointCount, request.bbox)
      } else {
        throw new Error(`不支持的保存格式：${String(request.format)}`)
      }
      await writeAll(fd, header, 0)
      session.bytesWritten = header.length
    } catch (err) {
      // 头部都写不进去（磁盘满 / 权限）→ 直接收拾干净
      await this.discard(session)
      throw err
    }

    this.sessions.set(session.id, session)
    logger.info(
      `[PointCloudSaveManager] 开始保存 ${request.format.toUpperCase()}：${request.path}（${request.pointCount} 点）`
    )
    return { sessionId: session.id }
  }

  /** 追加一批点。 */
  private async appendChunk(request: SaveChunkRequest): Promise<void> {
    const session = this.requireSession(request.sessionId)
    const { pointCount, positions, colors, classification, treeIds } = request

    try {
      // 长度校验：宁可"干净失败"，也不要写出错位的文件（与 setEntityNormalCodes 同一立场）
      if (!Number.isInteger(pointCount) || pointCount <= 0) {
        throw new Error(`分块点数非法：${pointCount}`)
      }
      if (positions.length !== pointCount * 3) {
        throw new Error(`坐标长度不匹配：${positions.length} ≠ ${pointCount} × 3`)
      }
      if (colors && colors.length !== pointCount * 3) {
        throw new Error(`颜色长度不匹配：${colors.length} ≠ ${pointCount} × 3`)
      }
      if (classification && classification.length !== pointCount) {
        throw new Error(`分类长度不匹配：${classification.length} ≠ ${pointCount}`)
      }
      if (treeIds && treeIds.length !== pointCount) {
        throw new Error(`树 ID 长度不匹配：${treeIds.length} ≠ ${pointCount}`)
      }
      if (session.pointsWritten + pointCount > session.expectedPoints) {
        throw new Error(
          `写入点数超过头部声明：已写 ${session.pointsWritten} + 本批 ${pointCount} > ${session.expectedPoints}`
        )
      }

      let buffer: Buffer
      if (session.format === 'ply') {
        buffer = encodePlyBatch({ basePoint: session.basePoint }, request)
      } else if (session.las) {
        const { buffer: buf, intBBox } = encodeLasBatch(session.las.plan, { basePoint: session.basePoint }, request)
        buffer = buf
        session.las.intBBox = mergeIntBBox(session.las.intBBox, intBBox)
      } else {
        throw new Error('会话状态异常：LAS 会话缺少布局规划')
      }
      await writeAll(session.fd, buffer, session.bytesWritten)
      session.bytesWritten += buffer.length
      session.pointsWritten += pointCount
    } catch (err) {
      // 纪律 2：校验 / 编码 / 落盘任何一步失败 → 立刻收拾，不留半成品。
      // 校验失败也是**调用方 bug**（长度对不上没有"重试同一会话"的合理路径），
      // 留着会话只会让半成品文件一直躺在磁盘上（渲染侧虽会 abort，但不能依赖它）。
      await this.discard(session)
      throw err
    }
  }

  /** 收尾：回填 LAS 头部包围盒（真实值）并关闭文件。 */
  private async end(request: SaveEndRequest): Promise<SaveEndResult> {
    const session = this.requireSession(request.sessionId)
    if (session.pointsWritten !== session.expectedPoints) {
      const message = `写入点数与头部声明不符：${session.pointsWritten} ≠ ${session.expectedPoints}`
      await this.discard(session)
      throw new Error(message)
    }

    try {
      if (session.las && session.las.intBBox) {
        // 用实际写入的 int32 坐标换算真实包围盒回填（见 encodeLasBBoxPatch 注释）
        const patch = encodeLasBBoxPatch(session.las.plan, session.las.intBBox)
        await writeAll(session.fd, patch, LAS_BBOX_OFFSET)
      }
      await session.fd.close()
    } catch (err) {
      await this.discard(session)
      throw err
    }

    this.sessions.delete(session.id)
    logger.info(
      `[PointCloudSaveManager] 保存完成：${session.path}（${session.pointsWritten} 点，${session.bytesWritten} 字节）`
    )
    return { path: session.path, points: session.pointsWritten, bytes: session.bytesWritten }
  }

  /** 中止会话：关闭句柄并删除半成品文件（不存在则忽略）。 */
  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.discard(session)
  }

  /** 中止全部会话（插件销毁 / 应用退出时调用）。 */
  async abortAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.abort(id)
    }
  }

  /** 关闭句柄 + 删文件 + 移出会话表（幂等，异常只记日志不抛 —— 清理路径不该再制造失败）。 */
  private async discard(session: SaveSession): Promise<void> {
    this.sessions.delete(session.id)
    try {
      await session.fd.close()
    } catch (err) {
      logger.warn('[PointCloudSaveManager] 关闭文件句柄失败：', err)
    }
    try {
      await fs.unlink(session.path)
    } catch (err) {
      // ENOENT 是正常路径（头部都没写成功时文件可能不存在）
      logger.warn('[PointCloudSaveManager] 删除半成品文件失败：', err)
    }
  }

  private requireSession(sessionId: string): SaveSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`保存会话不存在或已结束：${String(sessionId)}`)
    }
    return session
  }
}

/** LAS 头部里包围盒区的起始偏移（max X 起，48 字节）。 */
const LAS_BBOX_OFFSET = 179

/** 把一批的 int32 包围盒并入累积包围盒。 */
function mergeIntBBox(acc: LasIntBBox | null, next: LasIntBBox): LasIntBBox {
  if (!acc) return next
  return {
    minX: Math.min(acc.minX, next.minX),
    minY: Math.min(acc.minY, next.minY),
    minZ: Math.min(acc.minZ, next.minZ),
    maxX: Math.max(acc.maxX, next.maxX),
    maxY: Math.max(acc.maxY, next.maxY),
    maxZ: Math.max(acc.maxZ, next.maxZ),
  }
}

/**
 * 从指定位置写满整个缓冲。
 *
 * 必须循环：`FileHandle.write` 允许部分写入（Windows 上也确实可能发生），
 * 一次调用就认为写完会导致文件中间缺一块而**无人察觉**。显式传 position
 * 而非依赖文件内部游标，是为了让 LAS 头部回填能直接定位到 179 字节处。
 */
async function writeAll(fd: fs.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await fd.write(buffer, offset, buffer.length - offset, position + offset)
    if (bytesWritten <= 0) {
      throw new Error('写入文件失败（磁盘已满或设备错误）')
    }
    offset += bytesWritten
  }
}

export const pointCloudSaveManager = PointCloudSaveManager.getInstance()
