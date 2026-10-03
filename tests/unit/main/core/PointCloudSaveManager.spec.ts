// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { mockElectron } from '../../mocks/electron'

vi.mock('electron', () => mockElectron)

import { PointCloudSaveManager } from '../../../../src/main/core/PointCloudSaveManager'
import { LasManager } from '../../../../src/main/core/LasManager'
import { PlyManager } from '../../../../src/main/core/PlyManager'
import { PLY_UNIT_SIZE } from '../../../../src/main/core/plyWriter'
// 读侧（渲染进程）的颜色解码器：断言"写 c << 8 → 读回同一个 c"这条跨层契约
import { decodeLasRgb } from '../../../../src/renderer/utils/lasColor'
import type { SaveBeginRequest, SaveChunkRequest } from '../../../../src/shared/types/pointcloud-save'

/**
 * 写侧 + 读侧的**联合契约**测试：写完的文件立刻交给本仓库自己的读侧解析器
 * （LasManager 的 las:get-file-info / las:read-chunk、PlyManager 的 ply:get-file-info）
 * 读回来核对 —— 一条测试同时锁住两侧，且用的是真文件（tmpdir），不是内存缓冲。
 */

const BASE = { x: 500000, y: 4000000, z: 30 }

/** 取某 IPC 频道注册的 handler（与 LasManager.spec.ts 同一套路）。 */
function handlerOf(ipcMain: { handle: ReturnType<typeof vi.fn> }, channel: string) {
  return ipcMain.handle.mock.calls.find(([c]) => c === channel)![1]
}

describe('PointCloudSaveManager', () => {
  let tmpDir: string
  let manager: PointCloudSaveManager
  let ipcMain: { handle: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-test-'))
    manager = PointCloudSaveManager.getInstance()
    ipcMain = { handle: vi.fn() }
    manager.registerIpcHandlers(ipcMain as unknown as Electron.IpcMain)
    // 上一轮测试若留下未收尾的会话，先清干净（单例跨用例存活）
    await manager.abortAll()
  })

  afterEach(async () => {
    await manager.abortAll()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function filePath(name: string): string {
    return path.join(tmpDir, name)
  }

  function beginRequest(over: Partial<SaveBeginRequest> = {}): SaveBeginRequest {
    return {
      path: filePath('out.ply'),
      format: 'ply',
      pointCount: 2,
      basePoint: BASE,
      bbox: { minX: BASE.x, minY: BASE.y, minZ: BASE.z, maxX: BASE.x + 100, maxY: BASE.y + 200, maxZ: BASE.z + 300 },
      hasColor: true,
      ...over,
    }
  }

  function chunkRequest(sessionId: string, over: Partial<SaveChunkRequest> = {}): SaveChunkRequest {
    return {
      sessionId,
      pointCount: 2,
      positions: new Float32Array([0, 0, 0, 10.5, -20.25, 300]),
      colors: new Uint8Array([10, 20, 30, 200, 210, 220]),
      classification: new Uint8Array([2, 5]),
      treeIds: new Uint16Array([7, 65535]),
      ...over,
    }
  }

  const begin = (req: SaveBeginRequest) => handlerOf(ipcMain, 'pointcloud:save-begin')({}, req)
  const chunk = (req: SaveChunkRequest) => handlerOf(ipcMain, 'pointcloud:save-chunk')({}, req)
  const end = (sessionId: string) => handlerOf(ipcMain, 'pointcloud:save-end')({}, { sessionId })
  const abort = (sessionId: string) => handlerOf(ipcMain, 'pointcloud:save-abort')({}, { sessionId })

  it('应为单例', () => {
    expect(PointCloudSaveManager.getInstance()).toBe(PointCloudSaveManager.getInstance())
  })

  it('PLY：begin → chunk → end 写出的文件能被读侧解析回同样的点', async () => {
    const { sessionId } = await begin(beginRequest())
    await chunk(chunkRequest(sessionId))
    const done = await end(sessionId)

    expect(done).toMatchObject({ path: filePath('out.ply'), points: 2 })

    // 读侧解析头部（PlyManager 自己的 ply:get-file-info）
    const plyIpc = { handle: vi.fn() }
    PlyManager.getInstance().registerIpcHandlers(plyIpc as unknown as Electron.IpcMain)
    const info = await handlerOf(plyIpc, 'ply:get-file-info')({}, filePath('out.ply'))
    expect(info.pointCount).toBe(2)
    expect(info.size).toBe(done.bytes)
    expect(info.dataOffset).toBe(done.bytes - 2 * PLY_UNIT_SIZE)
    expect(done.bytes).toBe(info.dataOffset + 2 * PLY_UNIT_SIZE)

    // 逐字节核对数据区（偏移与 renderer 的 parsePlyChunk 一致）
    const raw = await fs.readFile(filePath('out.ply'))
    const o = info.dataOffset
    expect(raw.readDoubleLE(o)).toBe(BASE.x + 0)
    expect(raw.readDoubleLE(o + 8)).toBe(BASE.y + 0)
    expect(raw.readDoubleLE(o + 16)).toBe(BASE.z + 0)
    expect(raw[o + 24]).toBe(10)
    expect(raw[o + 25]).toBe(20)
    expect(raw[o + 26]).toBe(30)
    expect(raw[o + 27]).toBe(2)
    expect(raw.readUInt16LE(o + 28)).toBe(7)

    const o2 = o + PLY_UNIT_SIZE
    expect(raw.readDoubleLE(o2)).toBeCloseTo(BASE.x + 10.5, 10)
    expect(raw.readDoubleLE(o2 + 8)).toBeCloseTo(BASE.y - 20.25, 10)
    expect(raw.readDoubleLE(o2 + 16)).toBe(BASE.z + 300)
    expect(raw.readUInt16LE(o2 + 28)).toBe(65535)
  })

  it('LAS：写出的文件能被 LasManager 读回（点数 / 格式 / 精确包围盒 / 分类 / 点源 ID）', async () => {
    const { sessionId } = await begin(beginRequest({ path: filePath('out.las'), format: 'las', hasColor: true }))
    await chunk(chunkRequest(sessionId))
    const done = await end(sessionId)
    expect(done.points).toBe(2)

    const lasIpc = { handle: vi.fn() }
    LasManager.getInstance().registerIpcHandlers(lasIpc as unknown as Electron.IpcMain)
    const info = await handlerOf(lasIpc, 'las:get-file-info')({}, filePath('out.las'))

    expect(info).toMatchObject({
      pointCount: 2,
      pointFormat: 3,
      pointRecordLength: 34,
      versionMajor: 1,
      versionMinor: 2,
      hasColor: true,
      // 颜色写的是 c << 8（最大 220 → 56320）；读侧看到 rgbMax ≥ 256 即判定"移位存储"，
      // 取高 8 位还原（见 utils/lasColor.ts 的 decodeLasRgb）
      rgbMax: 56320,
    })
    expect(decodeLasRgb(56320, info.rgbMax) * 255).toBe(220)
    expect(decodeLasRgb(10 << 8, info.rgbMax) * 255).toBe(10)
    expect(info.size).toBe(done.bytes)
    expect(done.bytes).toBe(227 + 2 * 34)

    // 包围盒 = 实际写入的 int32 坐标换算（收尾回填），不是请求里那份可能偏大的值
    expect(info.minX).toBeCloseTo(BASE.x + 0, 3)
    expect(info.maxX).toBeCloseTo(BASE.x + 10.5, 3)
    expect(info.minY).toBeCloseTo(BASE.y - 20.25, 3)
    expect(info.maxY).toBeCloseTo(BASE.y + 0, 3)
    expect(info.minZ).toBeCloseTo(BASE.z + 0, 3)
    expect(info.maxZ).toBeCloseTo(BASE.z + 300, 3)

    // 读侧逐块读取（坐标还原 + 分类掩码 + RGB 移位解码的完整链路）
    const read = await handlerOf(lasIpc, 'las:read-chunk')(
      {},
      {
        path: filePath('out.las'),
        pointRecordLength: 34,
        chunkIndex: 0,
        chunkSize: 2,
        pointCount: 2,
        dataOffset: 227,
      }
    )
    expect(read.pointsRead).toBe(2)
    const dv = new DataView(read.arrayBuffer)
    expect(dv.getInt32(0, true) * info.scaleX + info.offsetX).toBeCloseTo(BASE.x, 3)
    expect(dv.getInt32(4, true) * info.scaleY + info.offsetY).toBeCloseTo(BASE.y, 3)
    expect(dv.getInt32(34, true) * info.scaleX + info.offsetX).toBeCloseTo(BASE.x + 10.5, 3)
    expect(dv.getUint8(15) & 0x1f).toBe(2) // 分类（低 5 位）
    expect(dv.getUint8(34 + 15) & 0x1f).toBe(5)
    expect(dv.getUint16(18, true)).toBe(7) // Point Source ID ← treeid
    expect(dv.getUint16(34 + 18, true)).toBe(65535)
    expect(dv.getUint16(28, true)).toBe(10 << 8) // RGB（c << 8）
  })

  it('无颜色的实体写格式 0（20 字节记录、不带 RGB）', async () => {
    const { sessionId } = await begin(beginRequest({ path: filePath('nocolor.las'), format: 'las', hasColor: false }))
    await chunk(chunkRequest(sessionId, { colors: null }))
    const done = await end(sessionId)

    expect(done.bytes).toBe(227 + 2 * 20)
    const lasIpc = { handle: vi.fn() }
    LasManager.getInstance().registerIpcHandlers(lasIpc as unknown as Electron.IpcMain)
    const info = await handlerOf(lasIpc, 'las:get-file-info')({}, filePath('nocolor.las'))
    expect(info.pointFormat).toBe(0)
    expect(info.pointRecordLength).toBe(20)
    expect(info.hasColor).toBe(false)
  })

  it('分多批写入与一次写入等价（分块流式的核心不变量）', async () => {
    const batch = (over: Partial<SaveChunkRequest>) =>
      chunkRequest('', { positions: new Float32Array([0, 0, 0, 10.5, -20.25, 300]), ...over })

    const one = await begin(beginRequest({ path: filePath('one.las'), format: 'las' }))
    await chunk({ ...batch({}), sessionId: one.sessionId })
    await end(one.sessionId)

    const many = await begin(beginRequest({ path: filePath('many.las'), format: 'las' }))
    await chunk({
      ...batch({
        pointCount: 1,
        positions: new Float32Array([0, 0, 0]),
        colors: new Uint8Array([10, 20, 30]),
        classification: new Uint8Array([2]),
        treeIds: new Uint16Array([7]),
      }),
      sessionId: many.sessionId,
    })
    await chunk({
      ...batch({
        pointCount: 1,
        positions: new Float32Array([10.5, -20.25, 300]),
        colors: new Uint8Array([200, 210, 220]),
        classification: new Uint8Array([5]),
        treeIds: new Uint16Array([65535]),
      }),
      sessionId: many.sessionId,
    })
    await end(many.sessionId)

    expect(await fs.readFile(filePath('many.las'))).toEqual(await fs.readFile(filePath('one.las')))
  })

  it('abort：关闭句柄并删除半成品文件', async () => {
    const { sessionId } = await begin(beginRequest())
    await chunk(chunkRequest(sessionId))
    const target = filePath('out.ply')
    expect((await fs.stat(target)).size).toBeGreaterThan(0)

    await abort(sessionId)
    await expect(fs.stat(target)).rejects.toThrow()
    // 会话已销毁：后续包被拒绝（而不是写到别的会话上）
    await expect(chunk(chunkRequest(sessionId))).rejects.toThrow(/会话不存在/)
  })

  it('新 begin 顶替旧会话：旧文件被删、旧 sessionId 失效（防残留 fd 写同一批数据）', async () => {
    const first = await begin(beginRequest({ path: filePath('a.ply') }))
    await chunk(chunkRequest(first.sessionId))
    const second = await begin(beginRequest({ path: filePath('b.ply') }))

    expect(second.sessionId).not.toBe(first.sessionId)
    await expect(fs.stat(filePath('a.ply'))).rejects.toThrow()
    await expect(chunk(chunkRequest(first.sessionId))).rejects.toThrow(/会话不存在/)

    // 新会话照常收尾（顶替旧会话不影响自己）
    await chunk(chunkRequest(second.sessionId))
    await expect(end(second.sessionId)).resolves.toMatchObject({ points: 2 })
  })

  it('点数与头部声明不符时 end 失败并删文件（不产出"头部说谎"的文件）', async () => {
    const { sessionId } = await begin(beginRequest({ pointCount: 5 }))
    await chunk(chunkRequest(sessionId))
    await expect(end(sessionId)).rejects.toThrow(/与头部声明不符/)
    await expect(fs.stat(filePath('out.ply'))).rejects.toThrow()
  })

  it('写入点数超过头部声明时立刻失败并删文件', async () => {
    const { sessionId } = await begin(beginRequest({ pointCount: 1 }))
    await expect(chunk(chunkRequest(sessionId))).rejects.toThrow(/超过头部声明/)
    await expect(fs.stat(filePath('out.ply'))).rejects.toThrow()
  })

  it('长度校验：位置 / 颜色 / 分类 / treeid 任一不符即拒绝（宁可干净失败也不写错位文件）', async () => {
    const cases: Partial<SaveChunkRequest>[] = [
      { positions: new Float32Array(3) }, // 1 点却给了 3 个坐标分量
      { colors: new Uint8Array(1) },
      { classification: new Uint8Array(3) },
      { treeIds: new Uint16Array(3) },
      { pointCount: 0 },
    ]
    for (const over of cases) {
      const { sessionId } = await begin(beginRequest({ path: filePath('bad.ply') }))
      await expect(chunk(chunkRequest(sessionId, over))).rejects.toThrow()
      await expect(fs.stat(filePath('bad.ply'))).rejects.toThrow()
    }
  })

  it('LAS 分类 > 31 时 encodeLasBatch 抛错 → 会话被丢弃且不留文件', async () => {
    const { sessionId } = await begin(beginRequest({ path: filePath('cls.las'), format: 'las' }))
    await expect(chunk(chunkRequest(sessionId, { classification: new Uint8Array([32, 1]) }))).rejects.toThrow(/低 5 位/)
    await expect(fs.stat(filePath('cls.las'))).rejects.toThrow()
    await expect(end(sessionId)).rejects.toThrow(/会话不存在/)
  })

  it('未知格式 / 空路径 / 非法点数在 begin 阶段拒绝', async () => {
    await expect(begin(beginRequest({ path: '' }))).rejects.toThrow(/路径为空/)
    await expect(begin(beginRequest({ format: 'laz' as never }))).rejects.toThrow(/不支持的保存格式/)
    await expect(begin(beginRequest({ pointCount: -1 }))).rejects.toThrow(/点数非法/)
  })

  it('abortAll 清掉全部会话（插件销毁 / 应用退出路径）', async () => {
    const a = await begin(beginRequest({ path: filePath('a.ply') }))
    const b = await begin(beginRequest({ path: filePath('b.ply') }))
    await manager.abortAll()
    await expect(fs.stat(filePath('b.ply'))).rejects.toThrow()
    await expect(chunk(chunkRequest(a.sessionId))).rejects.toThrow()
    await expect(end(b.sessionId)).rejects.toThrow()
  })

  it('end 后文件长度 = 头部 + 记录长 × 点数（两种格式）', async () => {
    const ply = await begin(beginRequest())
    await chunk(chunkRequest(ply.sessionId))
    const plyDone = await end(ply.sessionId)
    expect(plyDone.bytes).toBe((await fs.readFile(filePath('out.ply'))).byteLength)

    const las = await begin(beginRequest({ path: filePath('out.las'), format: 'las' }))
    await chunk(chunkRequest(las.sessionId))
    const lasDone = await end(las.sessionId)
    expect(lasDone.bytes).toBe(227 + 2 * 34)
    expect((await fs.readFile(filePath('out.las'))).byteLength).toBe(lasDone.bytes)
  })
})
