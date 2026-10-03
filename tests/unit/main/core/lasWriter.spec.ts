// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  LAS_HEADER_SIZE,
  buildLasHeader,
  encodeLasBBoxPatch,
  encodeLasBatch,
  planLasLayout,
} from '../../../../src/main/core/lasWriter'
import {
  LAS_12_MAX_CLASSIFICATION,
  type SaveBBox,
  type SaveChunkRequest,
} from '../../../../src/shared/types/pointcloud-save'

/**
 * 字段偏移与读侧（main/core/LasManager.ts 与 shared/types/las.ts 的常量表）一一对应。
 * 这里抄一遍当契约断言：写偏一个字节，读回来就是"分类变成回波号"这类**不报错的错**。
 */
const OFFSETS = { return: 14, classification: 15, psid: 18, gpsTime: 20, rgb: 28 } as const

const BASE = { x: 500000, y: 4000000, z: 30 }

/** 大地坐标量级的包围盒（LAS 的典型场景）。 */
const BBOX: SaveBBox = {
  minX: 500000,
  minY: 4000000,
  minZ: 30,
  maxX: 500100,
  maxY: 4000200,
  maxZ: 300.3,
}

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

/** 显示坐标 → 写盘后的 int32 坐标（反向验证用）。 */
function toInt(display: number, base: number, offset: number, scale: number): number {
  return Math.round((display + base - offset) / scale)
}

describe('planLasLayout', () => {
  it('默认 scale 0.001、offset 取包围盒中心、有颜色用格式 3', () => {
    const plan = planLasLayout(BBOX, true)
    expect(plan.pointFormat).toBe(3)
    expect(plan.recordLength).toBe(34)
    expect(plan.scale).toBe(0.001)
    expect(plan.offset.x).toBe((BBOX.minX + BBOX.maxX) / 2)
    expect(plan.offset.y).toBe((BBOX.minY + BBOX.maxY) / 2)
    expect(plan.offset.z).toBe((BBOX.minZ + BBOX.maxZ) / 2)
  })

  it('无颜色用格式 0（20 字节）', () => {
    const plan = planLasLayout(BBOX, false)
    expect(plan.pointFormat).toBe(0)
    expect(plan.recordLength).toBe(20)
  })

  it('跨度超出 int32 × scale 时按 10 的幂粗化（否则坐标会被 clamp 掉失精度）', () => {
    // 半跨度 3e6 m：3e6 / 0.001 = 3e9 > INT32_MAX
    const huge: SaveBBox = { minX: -3000000, minY: 0, minZ: 0, maxX: 3000000, maxY: 1, maxZ: 1 }
    const plan = planLasLayout(huge, false)
    expect(plan.scale).toBe(0.01)
    expect(3000000 / plan.scale).toBeLessThanOrEqual(2147483647)

    // 恰好不越界的量级仍保持毫米精度（不该无谓粗化）
    const ok: SaveBBox = { minX: -1000000, minY: 0, minZ: 0, maxX: 1000000, maxY: 1, maxZ: 1 }
    expect(planLasLayout(ok, false).scale).toBe(0.001)
  })
})

describe('buildLasHeader', () => {
  it('写出 227 字节的 LAS 1.2 头部（签名 / 版本 / 偏移 / 点数 / 回波计数）', () => {
    const plan = planLasLayout(BBOX, true)
    const header = buildLasHeader(plan, 42, BBOX)

    expect(header.length).toBe(LAS_HEADER_SIZE)
    expect(LAS_HEADER_SIZE).toBe(227)
    expect(header.subarray(0, 4).toString('ascii')).toBe('LASF')
    expect(header.readUInt8(24)).toBe(1) // 版本主号
    expect(header.readUInt8(25)).toBe(2) // 版本次号
    expect(header.readUInt16LE(94)).toBe(227) // 头部大小
    expect(header.readUInt32LE(96)).toBe(227) // 点数据偏移（无 VLR）
    expect(header.readUInt32LE(100)).toBe(0) // VLR 数量
    expect(header.readUInt8(104)).toBe(3) // 点格式
    expect(header.readUInt16LE(105)).toBe(34) // 记录长度
    expect(header.readUInt32LE(107)).toBe(42) // 点数（遗留字段）
    expect(header.readUInt32LE(111)).toBe(42) // 按回波计数：全部记在第 1 回波
    // generating software 是 32 字节定长字段，内容之后按 0 填充
    expect(header.subarray(58, 75).toString('ascii')).toBe('my-pointcloud-app')
    expect(header.subarray(75, 90).every((b) => b === 0)).toBe(true)
  })

  it('scale / offset 与规划一致，包围盒按 maxX,minX,maxY,minY,maxZ,minZ 顺序落位', () => {
    const plan = planLasLayout(BBOX, true)
    const header = buildLasHeader(plan, 1, BBOX)

    expect(header.readDoubleLE(131)).toBe(plan.scale)
    expect(header.readDoubleLE(139)).toBe(plan.scale)
    expect(header.readDoubleLE(147)).toBe(plan.scale)
    expect(header.readDoubleLE(155)).toBe(plan.offset.x)
    expect(header.readDoubleLE(163)).toBe(plan.offset.y)
    expect(header.readDoubleLE(171)).toBe(plan.offset.z)

    expect(header.readDoubleLE(179)).toBe(BBOX.maxX)
    expect(header.readDoubleLE(187)).toBe(BBOX.minX)
    expect(header.readDoubleLE(195)).toBe(BBOX.maxY)
    expect(header.readDoubleLE(203)).toBe(BBOX.minY)
    expect(header.readDoubleLE(211)).toBe(BBOX.maxZ)
    expect(header.readDoubleLE(219)).toBe(BBOX.minZ)
  })

  it('日期字段是合法的 UTC 年月日序（创建日 ∈ [1, 366]）', () => {
    const header = buildLasHeader(planLasLayout(BBOX, false), 1, BBOX)
    const day = header.readUInt16LE(90)
    const year = header.readUInt16LE(92)
    expect(day).toBeGreaterThanOrEqual(1)
    expect(day).toBeLessThanOrEqual(366)
    expect(year).toBeGreaterThanOrEqual(2020)
  })
})

describe('encodeLasBatch', () => {
  const plan = planLasLayout(BBOX, true)

  it('格式 3：每点 34 字节；坐标 = round((显示坐标 + 基准点 − offset) / scale)', () => {
    const batch = makeBatch({
      pointCount: 2,
      positions: new Float32Array([0, 0, 0, 1.5, -2.25, 0.125]),
    })
    const { buffer, intBBox } = encodeLasBatch(plan, { basePoint: BASE }, batch)

    expect(buffer.length).toBe(2 * 34)
    const ix = toInt(1.5, BASE.x, plan.offset.x, plan.scale)
    expect(buffer.readInt32LE(0)).toBe(toInt(0, BASE.x, plan.offset.x, plan.scale))
    expect(buffer.readInt32LE(4)).toBe(toInt(0, BASE.y, plan.offset.y, plan.scale))
    expect(buffer.readInt32LE(8)).toBe(toInt(0, BASE.z, plan.offset.z, plan.scale))
    expect(buffer.readInt32LE(34)).toBe(ix)
    expect(buffer.readInt32LE(38)).toBe(toInt(-2.25, BASE.y, plan.offset.y, plan.scale))
    expect(buffer.readInt32LE(42)).toBe(toInt(0.125, BASE.z, plan.offset.z, plan.scale))

    // int32 坐标还原回真实坐标（= 显示坐标 + 基准点，误差 ≤ scale/2）
    const restored = intBBox.minX * plan.scale + plan.offset.x
    expect(Math.abs(restored - (BASE.x + 0))).toBeLessThanOrEqual(plan.scale / 2)
  })

  it('格式 3：RGB 以 c << 8 写入（16 位字段携带 8 位精度，同 CloudCompare）', () => {
    const { buffer } = encodeLasBatch(plan, { basePoint: BASE }, makeBatch({ colors: new Uint8Array([1, 128, 255]) }))
    expect(buffer.readUInt16LE(OFFSETS.rgb)).toBe(1 << 8)
    expect(buffer.readUInt16LE(OFFSETS.rgb + 2)).toBe(128 << 8)
    expect(buffer.readUInt16LE(OFFSETS.rgb + 4)).toBe(255 << 8)
  })

  it('格式 0：每点 20 字节且无 RGB；有 color 载荷也不写（格式决定布局）', () => {
    const plan0 = planLasLayout(BBOX, false)
    const { buffer } = encodeLasBatch(
      plan0,
      { basePoint: BASE },
      makeBatch({ colors: new Uint8Array([255, 255, 255]) })
    )
    expect(buffer.length).toBe(20)
  })

  it('分类落字节 15、Point Source ID 落 18（treeid）、回波字节为 1 of 1', () => {
    const { buffer } = encodeLasBatch(
      plan,
      { basePoint: BASE },
      makeBatch({ classification: new Uint8Array([31]), treeIds: new Uint16Array([65535]) })
    )
    expect(buffer.readUInt8(OFFSETS.classification)).toBe(31)
    expect(buffer.readUInt16LE(OFFSETS.psid)).toBe(65535)
    // 0b00001001：低 3 位回波号 1、中 3 位总回波数 1（写 0 不是合法回波号）
    expect(buffer.readUInt8(OFFSETS.return)).toBe(0b00001001)
    // 内存里没有的字段一律写 0（强度 / 扫描角 / UserData / GPS 时间）
    expect(buffer.readUInt16LE(12)).toBe(0)
    expect(buffer.readInt8(16)).toBe(0)
    expect(buffer.readUInt8(17)).toBe(0)
    expect(buffer.readDoubleLE(OFFSETS.gpsTime)).toBe(0)
  })

  it('分类 > 31 抛错（不静默截断高位）', () => {
    expect(LAS_12_MAX_CLASSIFICATION).toBe(31)
    expect(() =>
      encodeLasBatch(plan, { basePoint: BASE }, makeBatch({ classification: new Uint8Array([32]) }))
    ).toThrow(/低 5 位/)
    expect(() =>
      encodeLasBatch(plan, { basePoint: BASE }, makeBatch({ classification: new Uint8Array([200]) }))
    ).toThrow(/PLY/)
    // 边界：31 可写
    expect(() =>
      encodeLasBatch(plan, { basePoint: BASE }, makeBatch({ classification: new Uint8Array([31]) }))
    ).not.toThrow()
  })

  it('intBBox 覆盖本批全部点（供收尾回填真实包围盒）', () => {
    const batch = makeBatch({
      pointCount: 3,
      positions: new Float32Array([0, 0, 0, 10, -20, 30, -5, 8, -3.5]),
    })
    const { intBBox } = encodeLasBatch(plan, { basePoint: BASE }, batch)
    const xs = [0, 1, 2].map((i) => toInt(batch.positions[i * 3], BASE.x, plan.offset.x, plan.scale))
    const ys = [0, 1, 2].map((i) => toInt(batch.positions[i * 3 + 1], BASE.y, plan.offset.y, plan.scale))
    const zs = [0, 1, 2].map((i) => toInt(batch.positions[i * 3 + 2], BASE.z, plan.offset.z, plan.scale))

    expect(intBBox.minX).toBe(Math.min(...xs))
    expect(intBBox.maxX).toBe(Math.max(...xs))
    expect(intBBox.minY).toBe(Math.min(...ys))
    expect(intBBox.maxY).toBe(Math.max(...ys))
    expect(intBBox.minZ).toBe(Math.min(...zs))
    expect(intBBox.maxZ).toBe(Math.max(...zs))
  })

  it('空批返回空缓冲且 intBBox 为"最大空区间"（合并时不会污染累积值）', () => {
    const { buffer, intBBox } = encodeLasBatch(
      plan,
      { basePoint: BASE },
      makeBatch({ pointCount: 0, positions: new Float32Array(0) })
    )
    expect(buffer.length).toBe(0)
    expect(intBBox.minX).toBeGreaterThan(intBBox.maxX)
  })
})

describe('encodeLasBBoxPatch', () => {
  it('按 int32 坐标换算回真实坐标（收尾回填头部 48 字节）', () => {
    const plan = planLasLayout(BBOX, true)
    const intBBox = { minX: -100, minY: -200, minZ: -300, maxX: 100, maxY: 200, maxZ: 300 }
    const patch = encodeLasBBoxPatch(plan, intBBox)

    expect(patch.length).toBe(48)
    expect(patch.readDoubleLE(0)).toBe(100 * plan.scale + plan.offset.x) // maxX
    expect(patch.readDoubleLE(8)).toBe(-100 * plan.scale + plan.offset.x) // minX
    expect(patch.readDoubleLE(16)).toBe(200 * plan.scale + plan.offset.y)
    expect(patch.readDoubleLE(24)).toBe(-200 * plan.scale + plan.offset.y)
    expect(patch.readDoubleLE(32)).toBe(300 * plan.scale + plan.offset.z)
    expect(patch.readDoubleLE(40)).toBe(-300 * plan.scale + plan.offset.z)
  })

  it('补丁与头部包围盒区同宽同位（可直接写到 offset 179）', () => {
    const plan = planLasLayout(BBOX, true)
    const header = buildLasHeader(plan, 1, BBOX)
    const intBBox = { minX: -5, minY: -6, minZ: -7, maxX: 5, maxY: 6, maxZ: 7 }
    const patched = Buffer.from(header)
    encodeLasBBoxPatch(plan, intBBox).copy(patched, 179)

    expect(patched.readDoubleLE(179)).toBe(5 * plan.scale + plan.offset.x)
    expect(patched.readDoubleLE(187)).toBe(-5 * plan.scale + plan.offset.x)
    // 227 字节里只有那 48 字节被改（其余字段原样）
    expect(patched.subarray(0, 179)).toEqual(header.subarray(0, 179))
    expect(patched.subarray(227)).toEqual(header.subarray(227))
  })
})
