// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

import { LasManager } from '../../../../src/main/core/LasManager'

/** 构造 LAS 1.2 公共头部（227 字节）。 */
function buildLas12Header(opts: {
  pointFormat: number
  pointRecordLength: number
  pointCount: number
  dataOffset?: number
}): Buffer {
  const header = Buffer.alloc(227)
  header.write('LASF', 0, 'ascii') // 文件签名
  header.writeUInt8(1, 24) // 版本主号
  header.writeUInt8(2, 25) // 版本次号
  header.writeUInt16LE(227, 94) // 头部大小
  header.writeUInt32LE(opts.dataOffset ?? 227, 96) // 点数据偏移
  header.writeUInt32LE(0, 100) // VLR 数量
  header.writeUInt8(opts.pointFormat, 104) // 点数据格式
  header.writeUInt16LE(opts.pointRecordLength, 105) // 点记录长度
  header.writeUInt32LE(opts.pointCount, 107) // 点数
  // 缩放因子 0.01（mm 精度）
  header.writeDoubleLE(0.01, 131)
  header.writeDoubleLE(0.01, 139)
  header.writeDoubleLE(0.01, 147)
  // 偏移量（模拟大地坐标）
  header.writeDoubleLE(500000, 155)
  header.writeDoubleLE(4000000, 163)
  header.writeDoubleLE(30, 171)
  // 包围盒（真实坐标）
  header.writeDoubleLE(500100, 179) // maxX
  header.writeDoubleLE(500000, 187) // minX
  header.writeDoubleLE(4000200, 195) // maxY
  header.writeDoubleLE(4000000, 203) // minY
  header.writeDoubleLE(300.3, 211) // maxZ
  header.writeDoubleLE(30, 219) // minZ
  return header
}

/** 构造 LAS 格式 3 的点记录（34 字节）：XYZ + intensity + return + 分类 + 点源ID + GPS 时间 + RGB。 */
function buildLasFormat3Point(
  x: number,
  y: number,
  z: number,
  cls: number,
  psid: number,
  rgb: [number, number, number],
): Buffer {
  const p = Buffer.alloc(34)
  p.writeInt32LE(x, 0)
  p.writeInt32LE(y, 4)
  p.writeInt32LE(z, 8)
  p.writeUInt16LE(100, 12) // intensity
  p.writeUInt8(0x09, 14) // return 1 / 共 2 次返回
  p.writeUInt8(cls | 0x20, 15) // 分类（低5位）+ synthetic 标记位（bit 5）
  p.writeInt8(0, 16) // scan angle
  p.writeUInt8(0, 17) // user data
  p.writeUInt16LE(psid, 18) // point source id
  p.writeDoubleLE(1234.5, 20) // GPS time
  p.writeUInt16LE(rgb[0], 28) // R
  p.writeUInt16LE(rgb[1], 30) // G
  p.writeUInt16LE(rgb[2], 32) // B
  return p
}

describe('LasManager', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
      tmpDir = ''
    }
  })

  async function writeLasFile(file: Buffer, name = 'test.las'): Promise<string> {
    tmpDir = tmpDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'las-test-')))
    const filePath = path.join(tmpDir, name)
    await fs.writeFile(filePath, file)
    return filePath
  }

  it('应为单例', () => {
    expect(LasManager.getInstance()).toBe(LasManager.getInstance())
  })

  it('应解析 LAS 1.2 头部并返回完整文件信息', async () => {
    const header = buildLas12Header({ pointFormat: 3, pointRecordLength: 34, pointCount: 2 })
    const p1 = buildLasFormat3Point(0, 0, 0, 2, 7, [65535, 32768, 0])
    const p2 = buildLasFormat3Point(10000, 20000, 30000, 5, 8, [0, 255, 65535])
    const filePath = await writeLasFile(Buffer.concat([header, p1, p2]))

    const manager = LasManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'las:get-file-info')!

    const info = await handler({}, filePath)

    expect(info).toMatchObject({
      path: filePath,
      pointCount: 2,
      dataOffset: 227,
      pointRecordLength: 34,
      versionMajor: 1,
      versionMinor: 2,
      pointFormat: 3,
      hasColor: true,
      // 夹具 RGB 为 [65535, 32768, 0] / [0, 255, 65535]，最大值 65535 ≥ 256 → 移位存储
      rgbMax: 65535,
      scaleX: 0.01,
      scaleY: 0.01,
      scaleZ: 0.01,
      offsetX: 500000,
      offsetY: 4000000,
      offsetZ: 30,
      minX: 500000,
      minY: 4000000,
      minZ: 30,
      maxX: 500100,
      maxY: 4000200,
      maxZ: 300.3,
    })
  })

  it('颜色为未移位 8 位值时 rgbMax 应小于 256（部分软件直接把 8 位色塞进 uint16）', async () => {
    const header = buildLas12Header({ pointFormat: 3, pointRecordLength: 34, pointCount: 2 })
    const p1 = buildLasFormat3Point(0, 0, 0, 2, 7, [200, 150, 90])
    const p2 = buildLasFormat3Point(10000, 0, 0, 5, 8, [10, 30, 240])
    const filePath = await writeLasFile(Buffer.concat([header, p1, p2]))

    const manager = LasManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'las:get-file-info')!

    const info = await handler({}, filePath)
    expect(info.rgbMax).toBe(240) // 全采样最大值 240 < 256 → 未移位
  })

  it('应分块读取 LAS 点数据，最后一块不足 chunkSize 时按实际点数返回', async () => {
    const header = buildLas12Header({ pointFormat: 3, pointRecordLength: 34, pointCount: 3 })
    const p1 = buildLasFormat3Point(0, 0, 0, 2, 7, [65535, 0, 0])
    const p2 = buildLasFormat3Point(10000, 0, 0, 2, 7, [0, 65535, 0])
    const p3 = buildLasFormat3Point(20000, 0, 0, 5, 9, [0, 0, 65535])
    const filePath = await writeLasFile(Buffer.concat([header, p1, p2, p3]))

    const manager = LasManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'las:read-chunk')!

    // 第一块：chunkSize=2，读到 2 点
    const chunk1 = await handler({}, {
      path: filePath,
      pointRecordLength: 34,
      chunkIndex: 0,
      chunkSize: 2,
      pointCount: 3,
      dataOffset: 227,
    })
    expect(chunk1.pointsRead).toBe(2)
    expect(chunk1.arrayBuffer.byteLength).toBe(68)
    const dv1 = new DataView(chunk1.arrayBuffer)
    expect(dv1.getInt32(0, true)).toBe(0)
    expect(dv1.getInt32(34, true)).toBe(10000)

    // 第二块：最后只剩 1 点
    const chunk2 = await handler({}, {
      path: filePath,
      pointRecordLength: 34,
      chunkIndex: 1,
      chunkSize: 2,
      pointCount: 3,
      dataOffset: 227,
    })
    expect(chunk2.pointsRead).toBe(1)
    expect(chunk2.arrayBuffer.byteLength).toBe(34)
    const dv2 = new DataView(chunk2.arrayBuffer)
    expect(dv2.getInt32(0, true)).toBe(20000)
  })

  it('应支持 LAS 1.4 扩展点数与超 4GB 数据偏移（legacy 字段为 0 时读头部后的 uint64）', async () => {
    // LAS 1.4 头部 375 字节：legacy 点数为 0，扩展点数为 5；数据偏移放头部之后
    const header = Buffer.alloc(375)
    header.write('LASF', 0, 'ascii')
    header.writeUInt8(1, 24)
    header.writeUInt8(4, 25) // 1.4
    header.writeUInt16LE(375, 94)
    header.writeUInt32LE(0, 96) // legacy 数据偏移为 0 → 读扩展
    header.writeUInt32LE(0, 100)
    header.writeUInt8(0, 104) // 格式 0（20 字节）
    header.writeUInt16LE(20, 105)
    header.writeUInt32LE(0, 107) // legacy 点数为 0 → 读扩展
    header.writeDoubleLE(0.001, 131)
    header.writeDoubleLE(0.001, 139)
    header.writeDoubleLE(0.001, 147)
    header.writeBigUInt64LE(5n, 239) // 扩展点数
    header.writeDoubleLE(10, 179)
    header.writeDoubleLE(0, 187)
    header.writeDoubleLE(10, 195)
    header.writeDoubleLE(0, 203)
    header.writeDoubleLE(10, 211)
    header.writeDoubleLE(0, 219)
    // 头部之后紧邻 8 字节存真实数据偏移（模拟 >4GB 大文件）
    const ext = Buffer.alloc(8)
    ext.writeBigUInt64LE(5000000000n, 0) // 5GB
    const filePath = await writeLasFile(Buffer.concat([header, ext]))

    const manager = LasManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'las:get-file-info')!

    const info = await handler({}, filePath)
    expect(info.pointCount).toBe(5)
    expect(info.dataOffset).toBe(5000000000)
    expect(info.versionMinor).toBe(4)
    // 格式 0 无颜色字段，不应触发 RGB 采样读取（文件在 5GB 偏移处并没有真实数据）
    expect(info.hasColor).toBe(false)
    expect(info.rgbMax).toBe(0)
  })

  it('签名不是 LASF 时应抛出错误', async () => {
    const filePath = await writeLasFile(Buffer.alloc(227).fill(0))
    const manager = LasManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'las:get-file-info')!

    await expect(handler({}, filePath)).rejects.toThrow('不是有效的 LAS 文件')
  })

  it('波形数据格式（4/5/9/10）应抛出错误', async () => {
    const header = buildLas12Header({ pointFormat: 4, pointRecordLength: 57, pointCount: 1 })
    const filePath = await writeLasFile(header)
    const manager = LasManager.getInstance()
    const ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    const [, handler] = ipcMain.handle.mock.calls.find(([channel]) => channel === 'las:get-file-info')!

    await expect(handler({}, filePath)).rejects.toThrow('暂不支持的 LAS 点格式 4')
  })
})
