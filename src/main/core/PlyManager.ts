import { promises as fs } from 'fs'
import { type IpcMain } from 'electron'
import { logger } from './LoggerManager'
import type { PlyBBox, PlyChunkRequest, PlyChunkResult, PlyFileInfo, PlyScanRequest } from '../../shared/types/ply'

/** PLY 头部读取上限（参考实现里头部按 4KB 假设）。 */
const HEADER_BUFFER_SIZE = 4096

export class PlyManager {
    private static instance: PlyManager | null = null
    private constructor() {}

    static getInstance(): PlyManager {
        if (!PlyManager.instance) {
        PlyManager.instance = new PlyManager()
        }
        return PlyManager.instance
    }

    registerIpcHandlers(ipcMain: IpcMain): void {
        
        // 注册 PLY 文件信息获取事件
        ipcMain.handle('ply:get-file-info', async (_event, filePath: string): Promise<PlyFileInfo> => {
        try {
            const stat = await fs.stat(filePath)
            const fd = await fs.open(filePath, 'r')
            try {
            // 1. 读取头部（只读前 4KB）
            const headerBuffer = Buffer.alloc(HEADER_BUFFER_SIZE)
            await fd.read(headerBuffer, 0, HEADER_BUFFER_SIZE, 0)
            const headerStr = headerBuffer.toString('ascii')

            // 2. 定位二进制数据起始位置
            const endHeaderStr = 'end_header\n'
            const endHeaderIndex = headerStr.indexOf(endHeaderStr)
            if (endHeaderIndex === -1) {
                throw new Error('不是有效的 PLY 文件，或者头部超过 4KB')
            }
            const dataOffset = endHeaderIndex + endHeaderStr.length

            // 3. 提取总点数
            const vertexMatch = headerStr.match(/element vertex (\d+)/)
            if (!vertexMatch) {
                throw new Error('无法从头文件中解析出顶点数量')
            }
            const pointCount = parseInt(vertexMatch[1], 10)

            return { path: filePath, size: stat.size, pointCount, dataOffset }
            } finally {
            await fd.close()
            }
        } catch (err) {
            logger.error('[PlyManager] 获取文件信息失败：', err)
            throw err
        }
        })

        // 注册 PLY 分块读取事件
        ipcMain.handle('ply:read-chunk', async (_event, options: PlyChunkRequest): Promise<PlyChunkResult> => {
        try {
            const { path, plyUnitSize, chunkIndex, chunkSize, pointCount, dataOffset } = options
            // 本次实际要读的点数（最后一块可能不足 chunkSize）
            const pointsToRead = Math.min(chunkSize, pointCount - chunkIndex * chunkSize)
            const bytesToRead = pointsToRead * plyUnitSize
            const startOffset = dataOffset + chunkIndex * chunkSize * plyUnitSize

            const fd = await fs.open(path, 'r')
            try {
            const buffer = Buffer.allocUnsafe(bytesToRead)
            await fd.read(buffer, 0, bytesToRead, startOffset)
            // 截出真正的 ArrayBuffer 区域再传回渲染进程（Node Buffer 底层是共享池，可能比实际数据大）。
            // 但分块通常远大于 Buffer.poolSize 的一半（4KB），allocUnsafe 会走独立分配：
            // byteOffset === 0 且长度正好相等，此时直接传底层 ArrayBuffer，零拷贝；
            // 只有文件末尾的小块（<4KB）仍落在共享池里，才需要拷贝对齐。
            const arrayBuffer =
                buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
                    ? buffer.buffer
                    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            return { pointsRead: pointsToRead, arrayBuffer }
            } finally {
            await fd.close()
            }
        } catch (err) {
            logger.error('[PlyManager] 读取分块失败：', err)
            throw err
        }
        })

        // 注册 PLY 包围盒扫描事件（首个点云定全局基准点用）。
        // 流式读完整文件只算 min/max（double 精度），不跨 IPC 传点数据。
        ipcMain.handle('ply:scan-bbox', async (_event, options: PlyScanRequest): Promise<PlyBBox> => {
        try {
            const { path, plyUnitSize, pointCount, dataOffset } = options
            const fd = await fs.open(path, 'r')
            try {
            let minX = Infinity, minY = Infinity, minZ = Infinity
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
            // 16MB 缓冲，但每轮读取量必须对齐 plyUnitSize（30 字节）：
            // 否则下一轮起点偏移错位，从"半个点"开始解析，垃圾坐标会污染 min/max
            const rawBufSize = 16 * 1024 * 1024
            const buffer = Buffer.allocUnsafe(rawBufSize)
            const alignedBufSize = rawBufSize - (rawBufSize % plyUnitSize)
            let bytesLeft = pointCount * plyUnitSize
            let readOffset = dataOffset
            while (bytesLeft > 0) {
                const toRead = Math.min(alignedBufSize, bytesLeft)
                const { bytesRead } = await fd.read(buffer, 0, toRead, readOffset)
                if (bytesRead <= 0) break // 文件已读完（防截断文件读到未初始化内存）
                const points = Math.floor(bytesRead / plyUnitSize)
                for (let i = 0; i < points; i++) {
                const o = i * plyUnitSize
                const x = buffer.readDoubleLE(o)
                const y = buffer.readDoubleLE(o + 8)
                const z = buffer.readDoubleLE(o + 16)
                // 跳过无效点（数据里的 NaN 占位），避免污染基准点
                if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue
                if (x < minX) minX = x
                if (y < minY) minY = y
                if (z < minZ) minZ = z
                if (x > maxX) maxX = x
                if (y > maxY) maxY = y
                if (z > maxZ) maxZ = z
                }
                bytesLeft -= bytesRead
                readOffset += bytesRead
                // 让出事件循环，避免扫描大文件时主进程卡顿
                await new Promise((resolve) => setTimeout(resolve, 0))
            }
            // 一个有效点都没扫到：抛错，避免 NaN 基准点传播到渲染进程
            if (minX === Infinity) {
                throw new Error('文件中扫描不到有效坐标点（数据为空或全为 NaN）')
            }
            return { minX, minY, minZ, maxX, maxY, maxZ }
            } finally {
            await fd.close()
            }
        } catch (err) {
            logger.error('[PlyManager] 扫描包围盒失败：', err)
            throw err
        }
        })
    }
}

export const plyManager = PlyManager.getInstance()