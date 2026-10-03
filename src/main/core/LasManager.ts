import { promises as fs } from 'fs'
import { type IpcMain } from 'electron'
import { logger } from './LoggerManager'
import { LAS_RGB_OFFSETS } from '../../shared/types/las'
import type { LasChunkRequest, LasChunkResult, LasFileInfo } from '../../shared/types/las'

/**
 * LAS 公共头部读取上限。
 * LAS 1.0-1.3 头部为 227 字节，LAS 1.4 为 375 字节，读 4KB 足够覆盖。
 */
const HEADER_BUFFER_SIZE = 4096

/**
 * 支持的 LAS 点数据格式。
 * 0/1/2/3 为经典格式，6/7/8 为 LAS 1.4 新格式；
 * 4/5/9/10 是波形数据格式（布局含 Wave Packet 字段），本应用暂不支持。
 */
const SUPPORTED_POINT_FORMATS = new Set([0, 1, 2, 3, 6, 7, 8])

export class LasManager {
    private static instance: LasManager | null = null
    private constructor() {}

    static getInstance(): LasManager {
        if (!LasManager.instance) {
            LasManager.instance = new LasManager()
        }
        return LasManager.instance
    }

    registerIpcHandlers(ipcMain: IpcMain): void {
        // 注册 LAS 文件信息获取事件：解析二进制公共头部。
        ipcMain.handle('las:get-file-info', async (_event, filePath: string): Promise<LasFileInfo> => {
            try {
                const stat = await fs.stat(filePath)
                const fd = await fs.open(filePath, 'r')
                try {
                    // 1. 读取公共头部（375 字节已覆盖 LAS 1.4 最大头部）
                    const header = Buffer.alloc(HEADER_BUFFER_SIZE)
                    const { bytesRead } = await fd.read(header, 0, HEADER_BUFFER_SIZE, 0)
                    if (bytesRead < 227) {
                        throw new Error('文件过小，不是有效的 LAS 文件')
                    }

                    // 2. 签名校验（"LASF"）
                    if (header.toString('ascii', 0, 4) !== 'LASF') {
                        throw new Error('文件签名不是 LASF，不是有效的 LAS 文件')
                    }

                    // 3. 版本与头部大小（LAS 版本只有 1.x）
                    const versionMajor = header.readUInt8(24)
                    const versionMinor = header.readUInt8(25)
                    if (versionMajor !== 1) {
                        throw new Error(`不支持的 LAS 版本：${versionMajor}.${versionMinor}`)
                    }
                    const headerSize = header.readUInt16LE(94)

                    // 4. 点数据格式与点记录长度（步长，含 extra bytes）
                    const pointFormat = header.readUInt8(104)
                    const pointRecordLength = header.readUInt16LE(105)
                    if (!SUPPORTED_POINT_FORMATS.has(pointFormat)) {
                        throw new Error(`暂不支持的 LAS 点格式 ${pointFormat}（波形数据格式 4/5/9/10）`)
                    }

                    // 5. 数据偏移：默认取遗留 uint32；LAS 1.4 且为 0 时偏移超过 4GB，
                    // 真实偏移存放在公共头部之后的 8 字节（uint64）
                    const legacyOffset = header.readUInt32LE(96)
                    let dataOffset = legacyOffset
                    if (versionMinor >= 4 && legacyOffset === 0) {
                        const ext = Buffer.alloc(8)
                        const { bytesRead: extRead } = await fd.read(ext, 0, 8, headerSize)
                        if (extRead < 8) {
                            throw new Error('无法读取扩展数据偏移（超大文件）')
                        }
                        dataOffset = Number(ext.readBigUInt64LE(0))
                    }

                    // 6. 点计数：LAS 1.4 且遗留 uint32 字段为 0 时，读扩展 uint64 字段（偏移 227）。
                    // 扩展字段只在头部 ≥235 字节时存在（规范 1.4 为 375），防止不规范文件读到垃圾字节。
                    // 部分非标软件会把总计数清零但按返回计数仍填写真实点数（如榉树+香樟_111.las），
                    // 因此总计数为 0 时依次回退：扩展按返回计数之和（偏移 235，5×uint32）→ 按文件大小推算。
                    const legacyPointCount = header.readUInt32LE(107)
                    const hasExtendedFields = headerSize >= 235
                    const extendedPointCount = hasExtendedFields ? Number(header.readBigUInt64LE(227)) : 0
                    let pointCount =
                        versionMinor >= 4 && legacyPointCount === 0
                            ? extendedPointCount
                            : legacyPointCount
                    if (pointCount === 0 && headerSize >= 255) {
                        for (let i = 0; i < 5; i++) {
                            pointCount += header.readUInt32LE(235 + i * 4)
                        }
                    }
                    if (pointCount === 0) {
                        pointCount = Math.max(0, Math.floor((stat.size - dataOffset) / pointRecordLength))
                    }
                    if (pointCount === 0) {
                        // 报错带上头部关键字段，便于排查真实文件的版本/字段差异
                        throw new Error(
                            `LAS 文件中没有点数据（版本 ${versionMajor}.${versionMinor}，头部大小 ${headerSize}，` +
                                `遗留点数 ${legacyPointCount}，扩展点数 ${extendedPointCount}，` +
                                `点格式 ${pointFormat}，点记录长度 ${pointRecordLength}，数据偏移 ${dataOffset}）`,
                        )
                    }

                    // 7. 坐标缩放因子与偏移量（真实坐标 = int32 × scale + offset）
                    const scaleX = header.readDoubleLE(131)
                    const scaleY = header.readDoubleLE(139)
                    const scaleZ = header.readDoubleLE(147)
                    const offsetX = header.readDoubleLE(155)
                    const offsetY = header.readDoubleLE(163)
                    const offsetZ = header.readDoubleLE(171)
                    // 缩放因子为 0 或非法会导致所有坐标变成偏移量，直接拒绝
                    if (!isFinite(scaleX) || !isFinite(scaleY) || !isFinite(scaleZ) || scaleX === 0 || scaleY === 0 || scaleZ === 0) {
                        throw new Error('LAS 头部坐标缩放因子非法（为 0 或非有限值）')
                    }

                    // 8. 头部声明的包围盒（真实坐标，double 精度）
                    const minX = header.readDoubleLE(187)
                    const minY = header.readDoubleLE(203)
                    const minZ = header.readDoubleLE(219)
                    const maxX = header.readDoubleLE(179)
                    const maxY = header.readDoubleLE(195)
                    const maxZ = header.readDoubleLE(211)

                    // 9. 采样点记录判定 RGB 存储单位（v = c×256 或 v = c），
                    // 渲染进程据此还原颜色，兼容不同软件写入的 LAS。
                    // 只读文件开头最多 1024 条记录（几 KB），代价可忽略。
                    const hasColor = pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8
                    let rgbMax = 0
                    if (hasColor && pointCount > 0) {
                        const rgbOffset = LAS_RGB_OFFSETS[pointFormat] ?? -1
                        if (rgbOffset >= 0) {
                            const sampleCount = Math.min(1024, pointCount)
                            const sampleBuf = Buffer.alloc(sampleCount * pointRecordLength)
                            const { bytesRead } = await fd.read(sampleBuf, 0, sampleBuf.length, dataOffset)
                            const sampled = Math.floor(bytesRead / pointRecordLength)
                            for (let i = 0; i < sampled; i++) {
                                const o = i * pointRecordLength + rgbOffset
                                const r = sampleBuf.readUInt16LE(o)
                                const g = sampleBuf.readUInt16LE(o + 2)
                                const b = sampleBuf.readUInt16LE(o + 4)
                                if (r > rgbMax) rgbMax = r
                                if (g > rgbMax) rgbMax = g
                                if (b > rgbMax) rgbMax = b
                            }
                        }
                    }

                    return {
                        path: filePath,
                        size: stat.size,
                        pointCount,
                        dataOffset,
                        pointRecordLength,
                        versionMajor,
                        versionMinor,
                        pointFormat,
                        hasColor,
                        rgbMax,
                        scaleX,
                        scaleY,
                        scaleZ,
                        offsetX,
                        offsetY,
                        offsetZ,
                        minX,
                        minY,
                        minZ,
                        maxX,
                        maxY,
                        maxZ,
                    }
                } finally {
                    await fd.close()
                }
            } catch (err) {
                logger.error('[LasManager] 获取文件信息失败：', err)
                throw err
            }
        })

        // 注册 LAS 分块读取事件（与 PLY 相同，步长换成点记录长度）。
        ipcMain.handle('las:read-chunk', async (_event, options: LasChunkRequest): Promise<LasChunkResult> => {
            try {
                const { path, pointRecordLength, chunkIndex, chunkSize, pointCount, dataOffset } = options
                // 本次实际要读的点数（最后一块可能不足 chunkSize）
                const pointsToRead = Math.min(chunkSize, pointCount - chunkIndex * chunkSize)
                const bytesToRead = pointsToRead * pointRecordLength
                const startOffset = dataOffset + chunkIndex * chunkSize * pointRecordLength

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
                logger.error('[LasManager] 读取分块失败：', err)
                throw err
            }
        })
    }
}

export const lasManager = LasManager.getInstance()
