// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { PLY_UNIT_SIZE, buildPlyHeader, encodePlyBatch } from '../../../../src/main/core/plyWriter'
import type { SaveChunkRequest } from '../../../../src/shared/types/pointcloud-save'

/**
 * 读侧（renderer/stores/pointcloudStore.ts 的 parsePlyChunk）**按偏移硬编码**解码，
 * 从不解析 property 名 —— 所以这里把偏移再抄一遍当作契约断言。改动写侧偏移而不同步
 * 读侧（或反之）会让文件读回来整片错位且**不报错**，这组断言就是那道哨兵。
 */
const READ_OFFSETS = { x: 0, r: 24, classification: 27, treeid: 28 } as const

/** 无颜色实体写出的中性灰（见 plyWriter 注释：round(linearToSrgb(0.7) × 255)）。 */
const NEUTRAL_GREY_BYTE = 218

function makeBatch(over: Partial<SaveChunkRequest> = {}): SaveChunkRequest {
  return {
    sessionId: 's1',
    pointCount: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: null,
    classification: null,
    treeIds: null,
    ...over,
  }
}

const BASE = { x: 500000, y: 4000000, z: 30 }

describe('plyWriter', () => {
  it('每点 30 字节（读侧 plyUnitSize 必须与它相等）', () => {
    expect(PLY_UNIT_SIZE).toBe(30)
  })

  it('头部写死 8 个属性且以 LF 换行结尾', () => {
    const header = buildPlyHeader(1234).toString('ascii')
    expect(header).toContain('format binary_little_endian 1.0')
    expect(header).toContain('element vertex 1234')
    // 顺序即布局：缺任何一个属性，读侧偏移就整体错位
    const props = ['double x', 'double y', 'double z', 'uchar red', 'uchar green', 'uchar blue']
    let cursor = -1
    for (const p of props) {
      const at = header.indexOf(`property ${p}`)
      expect(at, `缺少属性 ${p}`).toBeGreaterThan(-1)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
    expect(header).toContain('property uchar classification')
    expect(header).toContain('property ushort treeid')
    expect(header.endsWith('end_header\n')).toBe(true)
    // 读侧按 '\nend_header\n' 的字节数定位数据起点：写成 CRLF 会让数据偏移多出字节数
    expect(header).not.toContain('\r')
  })

  it('坐标写 double：显示坐标加回基准点后逐位相等', () => {
    const batch = makeBatch({
      pointCount: 2,
      // 显示坐标（内存里的样子：已减基准点）
      positions: new Float32Array([1.5, -2.25, 0.125, -1000, 2000, -30]),
    })
    const buf = encodePlyBatch({ basePoint: BASE }, batch)

    expect(buf.length).toBe(2 * PLY_UNIT_SIZE)
    expect(buf.readDoubleLE(READ_OFFSETS.x)).toBe(BASE.x + 1.5)
    expect(buf.readDoubleLE(READ_OFFSETS.x + 8)).toBe(BASE.y - 2.25)
    expect(buf.readDoubleLE(READ_OFFSETS.x + 16)).toBe(BASE.z + 0.125)
    expect(buf.readDoubleLE(PLY_UNIT_SIZE + READ_OFFSETS.x)).toBe(BASE.x - 1000)
    expect(buf.readDoubleLE(PLY_UNIT_SIZE + READ_OFFSETS.x + 8)).toBe(BASE.y + 2000)
    expect(buf.readDoubleLE(PLY_UNIT_SIZE + READ_OFFSETS.x + 16)).toBe(BASE.z - 30)
  })

  it('坐标以 double 写出：基准点的小数位不被截成 float32', () => {
    // 基准点来自包围盒中心（double），1e6 量级带小数的值落进 float32 就会被舍掉
    const base = { x: 4000000.125, y: 0, z: 0 }
    expect(Math.fround(base.x)).not.toBe(base.x) // 前提：float32 真的存不下它

    const buf = encodePlyBatch({ basePoint: base }, makeBatch())
    expect(buf.readDoubleLE(0)).toBe(base.x)
    // 按 8 字节步距写（若按 float32 写，布局会整体压成 3 字节一套，读侧全错位）
    expect(buf.readDoubleLE(8)).toBe(base.y)
    expect(buf.readDoubleLE(16)).toBe(base.z)
  })

  it('颜色为已转好的 sRGB 字节，原样落位', () => {
    const buf = encodePlyBatch({ basePoint: BASE }, makeBatch({ colors: new Uint8Array([0, 128, 255]) }))
    expect([buf[24], buf[25], buf[26]]).toEqual([0, 128, 255])
  })

  it('无颜色实体写中性灰（布局要求恒有 RGB）', () => {
    const buf = encodePlyBatch({ basePoint: BASE }, makeBatch({ colors: null }))
    expect([buf[24], buf[25], buf[26]]).toEqual([NEUTRAL_GREY_BYTE, NEUTRAL_GREY_BYTE, NEUTRAL_GREY_BYTE])
  })

  it('分类（uchar）与 treeid（ushort LE）落位；缺属性写 0', () => {
    const buf = encodePlyBatch(
      { basePoint: BASE },
      makeBatch({ classification: new Uint8Array([7]), treeIds: new Uint16Array([500]) })
    )
    expect(buf[READ_OFFSETS.classification]).toBe(7)
    expect(buf.readUInt16LE(READ_OFFSETS.treeid)).toBe(500)

    const empty = encodePlyBatch({ basePoint: BASE }, makeBatch())
    expect(empty[READ_OFFSETS.classification]).toBe(0)
    expect(empty.readUInt16LE(READ_OFFSETS.treeid)).toBe(0)
    expect(empty.readDoubleLE(READ_OFFSETS.x)).toBe(BASE.x)
  })

  it('treeid 按小端写（>255 时高字节在后）', () => {
    const buf = encodePlyBatch({ basePoint: BASE }, makeBatch({ treeIds: new Uint16Array([0x1234]) }))
    expect(buf[READ_OFFSETS.treeid]).toBe(0x34)
    expect(buf[READ_OFFSETS.treeid + 1]).toBe(0x12)
  })

  it('往返：拼出的整文件按读侧偏移能精确解回每一个字段', () => {
    const batch = makeBatch({
      pointCount: 2,
      positions: new Float32Array([0, 0, 0, 10, 20, 30]),
      colors: new Uint8Array([10, 20, 30, 200, 210, 220]),
      classification: new Uint8Array([2, 5]),
      treeIds: new Uint16Array([1, 999]),
    })
    const header = buildPlyHeader(batch.pointCount)
    const file = Buffer.concat([header, encodePlyBatch({ basePoint: BASE }, batch)])

    expect(file.length).toBe(header.length + 2 * PLY_UNIT_SIZE)
    for (let i = 0; i < 2; i++) {
      const o = header.length + i * PLY_UNIT_SIZE
      expect(file.readDoubleLE(o + READ_OFFSETS.x)).toBe(BASE.x + batch.positions[i * 3])
      expect(file.readDoubleLE(o + READ_OFFSETS.x + 8)).toBe(BASE.y + batch.positions[i * 3 + 1])
      expect(file.readDoubleLE(o + READ_OFFSETS.x + 16)).toBe(BASE.z + batch.positions[i * 3 + 2])
      expect(file.readUInt8(o + READ_OFFSETS.r)).toBe(batch.colors![i * 3])
      expect(file.readUInt8(o + READ_OFFSETS.r + 1)).toBe(batch.colors![i * 3 + 1])
      expect(file.readUInt8(o + READ_OFFSETS.r + 2)).toBe(batch.colors![i * 3 + 2])
      expect(file.readUInt8(o + READ_OFFSETS.classification)).toBe(batch.classification![i])
      expect(file.readUInt16LE(o + READ_OFFSETS.treeid)).toBe(batch.treeIds![i])
    }
  })
})
