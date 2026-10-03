// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  CROWN_RING_SEGMENTS,
  DBH_RING_SEGMENTS,
  TREE_CENTER_COLOR,
  TREE_CROWN_COLOR,
  TREE_DBH_COLOR,
  buildMarkerGeometryData,
  collectTreeMarkers,
  type TreeMarkerItem,
  type TreeMarkerSource,
} from '../../../../src/renderer/utils/treeMarkers'
import { srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'
import type { TreeObject } from '../../../../src/renderer/stores/sceneStore'

/** 一棵"算全了"的树：代表点 (10,20,1.3)、冠层落点 (1,2,8)、胸径 40 cm、冠幅 X 4 / Y 6。 */
function mkTree(over: Partial<TreeObject> = {}): TreeObject {
  return {
    height: 12,
    dbh: 40,
    crownWidth: 6,
    crownWidthX: 4,
    crownWidthY: 6,
    crownBaseHeight: 8,
    dbhHeight: 1.3,
    basePoint: { x: 0, y: 0, z: 0 },
    representative: { x: 10, y: 20, z: 1.3 },
    crownCenter: { x: 1, y: 2, z: 8 },
    quality: { dbhMethod: 'fit', dbhSlicePoints: 12, dbhInliers: 9, dbhRms: 0.004, crownPoints: 30 },
    ...over,
  }
}

function mkSource(over: Partial<TreeMarkerSource> = {}): TreeMarkerSource {
  return { id: 1, visible: true, globalShift: { x: 100, y: 200, z: 0 }, treeObject: mkTree(), ...over }
}

/** 一个圆/椭圆的全部线段顶点（每 2 个顶点一段，取每段起点即可遍历整圈）。 */
function ringVertices(data: ReturnType<typeof buildMarkerGeometryData>, from: number, count: number): number[][] {
  const out: number[][] = []
  for (let i = from; i < from + count; i++) {
    out.push([data.ringPositions[i * 3], data.ringPositions[i * 3 + 1], data.ringPositions[i * 3 + 2]])
  }
  return out
}

/**
 * 几何断言里的容差都得按 **Float32 存储**取（~1e-7 相对误差，如 1.3 → 1.2999999523162842），
 * 不是按算法误差取——圈上的点在 3 位有效数字上是精确的，只是装不进 float32。
 */
const F32_DIGITS = 4

/** Float32Array 与期望值逐元素近似比较（`toEqual` 会被 float32 舍入打败）。 */
function expectF32(actual: Float32Array, expected: number[]): void {
  expect(actual.length).toBe(expected.length)
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, F32_DIGITS))
}

describe('treeMarkers · collectTreeMarkers（筛选的唯一实现）', () => {
  it('off ⇒ 空（哪怕有选中的树）', () => {
    expect(collectTreeMarkers([mkSource()], new Set([1]), 'off')).toEqual([])
  })

  it('selected ⇒ 只取选中集里的；all ⇒ 全部', () => {
    const sources = [mkSource({ id: 1 }), mkSource({ id: 2 }), mkSource({ id: 3 })]
    expect(collectTreeMarkers(sources, new Set([2]), 'selected').map((m) => m.id)).toEqual([2])
    expect(collectTreeMarkers(sources, new Set([2]), 'all').map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('三种跳过条件：不可见 / 无树木信息 / 无 globalShift', () => {
    const sources = [
      mkSource({ id: 1, visible: false }),
      mkSource({ id: 2, treeObject: null }),
      mkSource({ id: 3, globalShift: null }),
      mkSource({ id: 4 }),
    ]
    expect(collectTreeMarkers(sources, new Set(), 'all').map((m) => m.id)).toEqual([4])
  })

  it('坐标换算成显示坐标（文件原始坐标 − globalShift），z 一并换算', () => {
    const s = mkSource({ globalShift: { x: 100, y: 200, z: 5 } })
    const [item] = collectTreeMarkers([s], new Set([1]), 'selected')
    expect(item.center).toEqual({ x: -90, y: -180, z: -3.7 })
    expect(item.crown).toEqual({ x: -99, y: -198, z: 3, halfX: 2, halfY: 3 })
  })

  it('冠层落点为空 ⇒ 不画冠层圈（手填的树就是这样）', () => {
    const [item] = collectTreeMarkers(
      [mkSource({ treeObject: mkTree({ crownCenter: null }) })],
      new Set([1]),
      'selected'
    )
    expect(item.crown).toBeNull()
    expect(item.center).not.toBeNull()
  })

  it('胸径圈：半径 = dbh/200（cm→m），圆心 = 树心点', () => {
    const [item] = collectTreeMarkers([mkSource()], new Set([1]), 'selected')
    // 默认 globalShift 的 z 是 0 ⇒ 切片高度原样是 1.3
    expect(item.dbh).toEqual({ x: -90, y: -180, z: 1.3, radius: 0.2 })
  })

  it('dbh = 0（圆拟合被拒 / 质心兜底）⇒ 不画胸径圈：半径 0 的圈没有意义', () => {
    const [item] = collectTreeMarkers([mkSource({ treeObject: mkTree({ dbh: 0 }) })], new Set([1]), 'selected')
    expect(item.dbh).toBeNull()
    expect(item.center).not.toBeNull()
  })

  it('代表点为空 ⇒ 树心点与胸径圈都没有，只有冠层圈', () => {
    const [item] = collectTreeMarkers(
      [mkSource({ treeObject: mkTree({ representative: null, dbh: 0 }) })],
      new Set([1]),
      'selected'
    )
    expect(item.center).toBeNull()
    expect(item.dbh).toBeNull()
    expect(item.crown).not.toBeNull()
  })
})

describe('treeMarkers · buildMarkerGeometryData（几何可断言）', () => {
  it('顶点数：冠层 64 段 ×2 / 胸径 48 段 ×2 / 树心每棵 1 个', () => {
    const items = collectTreeMarkers([mkSource()], new Set([1]), 'selected')
    const data = buildMarkerGeometryData(items)
    const expectedRing = CROWN_RING_SEGMENTS * 2 + DBH_RING_SEGMENTS * 2
    expect(data.ringVertexCount).toBe(expectedRing)
    expect(data.centerVertexCount).toBe(1)
    expect(data.ringPositions.length).toBe(expectedRing * 3)
    expect(data.ringColors.length).toBe(expectedRing * 3)
    expect(data.centerPositions.length).toBe(3)
    expect(data.centerColors.length).toBe(3)
  })

  it('空输入 ⇒ 长度 0 的缓冲（装配层据此隐藏对象）', () => {
    const data = buildMarkerGeometryData([])
    expect(data.ringVertexCount).toBe(0)
    expect(data.centerVertexCount).toBe(0)
    expect(data.ringPositions.length).toBe(0)
    expect(data.centerPositions.length).toBe(0)
  })

  it('冠层圈是以 crownCenter 为中心、半轴 crownWidthX/2 / crownWidthY/2 的 XY 平面椭圆', () => {
    const [item] = collectTreeMarkers([mkSource()], new Set([1]), 'selected')
    const data = buildMarkerGeometryData([item])
    const verts = ringVertices(data, 0, CROWN_RING_SEGMENTS * 2)
    const c = item.crown!
    for (const [x, y, z] of verts) {
      expect(z).toBeCloseTo(c.z, F32_DIGITS) // 平面：整圈同一个 z
      const e = ((x - c.x) / c.halfX) ** 2 + ((y - c.y) / c.halfY) ** 2
      expect(e).toBeCloseTo(1, 4) // 落在椭圆上
    }
    // 首段起点在 +X 半轴上、末段终点与它重合（圈是闭合的，没有缺口）
    expect(verts[0][0]).toBeCloseTo(c.x + c.halfX, F32_DIGITS)
    expect(verts[0][1]).toBeCloseTo(c.y, F32_DIGITS)
    expect(verts[verts.length - 1][0]).toBeCloseTo(c.x + c.halfX, F32_DIGITS)
    expect(verts[verts.length - 1][1]).toBeCloseTo(c.y, F32_DIGITS)
  })

  it('胸径圈是正圆：到圆心的距离恒等于半径，圆心在树心点、z 在切片高度', () => {
    const [item] = collectTreeMarkers([mkSource()], new Set([1]), 'selected')
    const data = buildMarkerGeometryData([item])
    const from = CROWN_RING_SEGMENTS * 2
    const verts = ringVertices(data, from, DBH_RING_SEGMENTS * 2)
    const c = item.dbh!
    expect(c.radius).toBeCloseTo(0.2, 12) // 40 cm 胸径 ⇒ 0.2 m
    for (const [x, y, z] of verts) {
      expect(Math.hypot(x - c.x, y - c.y)).toBeCloseTo(c.radius, F32_DIGITS)
      expect(z).toBeCloseTo(c.z, F32_DIGITS)
    }
  })

  it('树心点写在 centerPositions 里（显示坐标）', () => {
    const items = collectTreeMarkers([mkSource({ id: 7 })], new Set([7]), 'selected')
    const data = buildMarkerGeometryData(items)
    expectF32(data.centerPositions, [-90, -180, 1.3])
  })

  it('两类圈各用各的颜色：写的必须是**线性** RGB（sRGB 字节会整体偏亮）', () => {
    const items = collectTreeMarkers([mkSource()], new Set([1]), 'selected')
    const data = buildMarkerGeometryData(items)
    const crownByte = (TREE_CROWN_COLOR >> 8) & 0xff
    const dbhByte = (TREE_DBH_COLOR >> 8) & 0xff
    const centerByte = (TREE_CENTER_COLOR >> 8) & 0xff
    // 冠层圈（第 1 圈）的 G 分量
    expect(data.ringColors[1]).toBeCloseTo(srgbU8ToLinear(crownByte), 6)
    expect(data.ringColors[1]).toBeLessThan(crownByte / 255)
    // 胸径圈（第 2 圈，起点 = 冠层圈顶点数）
    const dbhFrom = CROWN_RING_SEGMENTS * 2 * 3
    expect(data.ringColors[dbhFrom + 1]).toBeCloseTo(srgbU8ToLinear(dbhByte), 6)
    // 树心点
    expect(data.centerColors[1]).toBeCloseTo(srgbU8ToLinear(centerByte), 6)
  })

  it('多棵树：圈按 items 顺序首尾相接、树心点与有代表点的树一一对应', () => {
    const sources = [
      mkSource({ id: 1 }),
      // 第二棵没有代表点 ⇒ 只有冠层圈，不进 centerPositions
      mkSource({ id: 2, treeObject: mkTree({ representative: null, dbh: 0 }) }),
    ]
    const data = buildMarkerGeometryData(collectTreeMarkers(sources, new Set(), 'all'))
    expect(data.ringVertexCount).toBe(CROWN_RING_SEGMENTS * 2 * 2 + DBH_RING_SEGMENTS * 2)
    expect(data.centerVertexCount).toBe(1)
    expectF32(data.centerPositions, [-90, -180, 1.3])
  })

  it('半轴/半径跟着数值走（改冠幅或胸径 ⇒ 圈的大小随之变）', () => {
    const items = collectTreeMarkers(
      [mkSource({ treeObject: mkTree({ crownWidthX: 8, crownWidthY: 2, dbh: 100 }) })],
      new Set([1]),
      'selected'
    )
    const [item]: TreeMarkerItem[] = items
    expect(item.crown!.halfX).toBe(4)
    expect(item.crown!.halfY).toBe(1)
    expect(item.dbh!.radius).toBe(0.5)
  })
})
