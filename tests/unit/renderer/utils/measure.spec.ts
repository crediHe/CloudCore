import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  computeDistanceInfo,
  computeAngleInfo,
  buildMeasureResult,
  formatPointLine,
  formatOriginalLine,
  pickThresholdWorld,
  ensureBoundingSphere,
  pickVertex,
  projectWorldToScreen,
  readPointsTag,
  PICK_RADIUS_PX,
} from '../../../../src/renderer/utils/measure'
import type { PickCandidate, PickedPoint } from '../../../../src/renderer/utils/measure'

// 纯数学 + three 射线，node 环境即可（不依赖 DOM），无需 jsdom 注释。

/** 视口 CSS 高（拾取阈值换算用）。 */
const CSS_H = 600
/** 视口 CSS 尺寸（投影用）。 */
const CSS_W = 800

/** 构造透视相机：位于 (0,0,10) 看向原点（同 segmentSelection.spec.ts）。 */
function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, CSS_W / CSS_H, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

/** 构造正交相机（bounds ±5，zoom=1）：位于 (0,0,10) 看向原点。 */
function makeOrthoCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

interface PointsOptions {
  entityId?: number
  chunkIndex?: number
  /** 按项目约定给 Group 加 rotation.x=-π/2（局部 (x,y,z) → 世界 (x,z,-y)）。 */
  rotate?: boolean
  index?: number[]
  drawRange?: [number, number]
}

/** 建场：Points（带 userData 标记与位置属性）+ 承载它的 Group。 */
function makePoints(local: number[], opts: PointsOptions = {}): { points: THREE.Points; group: THREE.Group } {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(local), 3))
  if (opts.index) geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(opts.index), 1))
  if (opts.drawRange) geometry.setDrawRange(opts.drawRange[0], opts.drawRange[1])

  const points = new THREE.Points(geometry, new THREE.PointsMaterial())
  points.frustumCulled = false
  points.userData = { entityId: opts.entityId ?? 1, chunkIndex: opts.chunkIndex ?? 0 }

  const group = new THREE.Group()
  if (opts.rotate) group.rotation.x = -Math.PI / 2
  group.add(points)
  group.updateMatrixWorld(true)
  return { points, group }
}

/** 由 Points 的实际世界包围盒造候选（生产环境由分块包围球提供，此处等价取材）。 */
function makeCandidate(entityId: number, chunkIndex: number, points: THREE.Points): PickCandidate {
  const box = new THREE.Box3().setFromObject(points)
  return {
    entityId,
    chunkIndex,
    points,
    centerWorld: box.getCenter(new THREE.Vector3()),
    radiusWorld: box.getSize(new THREE.Vector3()).length() / 2,
  }
}

/** 从 NDC 出发的射线器（NDC (0,0) 即屏幕中心，相机看向原点时沿 -Z 穿过原点）。 */
function castAt(ndcX: number, ndcY: number, camera: THREE.Camera): THREE.Raycaster {
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
  return raycaster
}

/** 构造一个被拾取点（默认无全局位移、带分类）。 */
function makePicked(over: Partial<PickedPoint> = {}): PickedPoint {
  return {
    entityId: 1,
    entityName: 'cloud.ply',
    chunkIndex: 0,
    vertexIndex: 42,
    local: { x: 1.5, y: -2.25, z: 0.75 },
    world: { x: 1.5, y: 0.75, z: 2.25 },
    original: { x: 1.5, y: -2.25, z: 0.75 },
    globalShift: { x: 0, y: 0, z: 0 },
    classification: 2,
    ...over,
  }
}

describe('computeDistanceInfo（两点距离）', () => {
  it('3-4-5 直角边：距离与各轴/平面增量', () => {
    const d = computeDistanceInfo({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })
    expect(d).toEqual({ distance: 5, dx: 3, dy: 4, dz: 0, dxy: 5, dxz: 3, dzy: 4 })
  })

  it('三点均非零：距离 3（(1,2,2) 模长）与平面距离为两分量 hypot', () => {
    const d = computeDistanceInfo({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 })
    expect(d.distance).toBeCloseTo(3, 12)
    expect(d.dx).toBeCloseTo(1, 12)
    expect(d.dy).toBeCloseTo(2, 12)
    expect(d.dz).toBeCloseTo(2, 12)
    expect(d.dxy).toBeCloseTo(Math.hypot(1, 2), 12)
    expect(d.dxz).toBeCloseTo(Math.hypot(1, 2), 12)
    expect(d.dzy).toBeCloseTo(Math.hypot(2, 2), 12)
  })

  it('增量方向有符号（P2 在前为负）', () => {
    const d = computeDistanceInfo({ x: 5, y: 5, z: 5 }, { x: 5, y: 3, z: 1 })
    expect(d.dx).toBe(0)
    expect(d.dy).toBe(-2)
    expect(d.dz).toBe(-4)
    expect(d.distance).toBeCloseTo(Math.hypot(0, 2, 4), 12)
  })
})

describe('computeAngleInfo（三点角度）', () => {
  it('直角三角形 A(0,0,0) B(3,0,0) C(0,4,0)：三角 90/53.13/36.87、三边 3/5/4、面积 6', () => {
    const a = computeAngleInfo({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 0, y: 4, z: 0 })
    expect(a.angleA).toBeCloseTo(90, 9)
    expect(a.angleB).toBeCloseTo(53.13010235415598, 9)
    expect(a.angleC).toBeCloseTo(36.86989764584402, 9)
    expect(a.angleA + a.angleB + a.angleC).toBeCloseTo(180, 9)
    expect(a.ab).toBeCloseTo(3, 12)
    expect(a.bc).toBeCloseTo(5, 12)
    expect(a.ca).toBeCloseTo(4, 12)
    expect(a.area).toBeCloseTo(6, 12)
  })

  it('三点不共面：角度和恒为 180，B 点角与手算一致', () => {
    // B 处：BA = (1,1,1)、BC = (2,-1,1) → cos = (2−1+1)/(√3·√6) = 2/√18
    const a = computeAngleInfo({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 2, y: -1, z: 1 })
    expect(a.angleB).toBeCloseTo((Math.acos(2 / Math.sqrt(18)) * 180) / Math.PI, 9)
    expect(a.angleA + a.angleB + a.angleC).toBeCloseTo(180, 9)
  })

  it('退化：三点重合 → 三角均 NaN（边长 0 无方向）、三边与面积 0', () => {
    const p = { x: 2, y: 3, z: 4 }
    const a = computeAngleInfo(p, p, p)
    expect(a.angleA).toBeNaN()
    expect(a.angleB).toBeNaN()
    expect(a.angleC).toBeNaN()
    expect(a.ab).toBe(0)
    expect(a.bc).toBe(0)
    expect(a.ca).toBe(0)
    expect(a.area).toBe(0)
  })

  it('退化：三点共线 → 0/180/0 且面积为 0', () => {
    const a = computeAngleInfo({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })
    expect(a.angleA).toBeCloseTo(0, 9)
    expect(a.angleB).toBeCloseTo(180, 9)
    expect(a.angleC).toBeCloseTo(0, 9)
    expect(a.area).toBe(0)
  })

  it('回归：点积浮点越界（cos = 1+2e-16）必须 clamp 后取 0，而非 acos 出 NaN', () => {
    // 该向量对经搜索得到：以 Vector3.length()（sqrt）路径算出的 cos 为 1.0000000000000002，
    // 直接 acos 返回 NaN；clamp 是唯一防线。
    const a = { x: 0, y: 0, z: 0 }
    const b = { x: 0, y: 1, z: 3 }
    const c = { x: 0, y: 1.0000000000000002, z: 3.000000000000001 }
    expect(computeAngleInfo(a, b, c).angleA).toBeCloseTo(0, 9)
  })

  it('回归：点积浮点越界（cos = −1−2e-16）必须 clamp 后取 180，而非 NaN', () => {
    const a = { x: 0, y: 0, z: 0 }
    const b = { x: 0, y: 1, z: 3 }
    const c = { x: 0, y: -1.0000000000000002, z: -3.000000000000001 }
    expect(computeAngleInfo(a, b, c).angleA).toBeCloseTo(180, 9)
  })
})

describe('formatPointLine / buildMeasureResult（结果组装）', () => {
  it('formatPointLine / formatOriginalLine：可选 A/B/C 前缀 + 固定小数位', () => {
    const p = makePicked({
      original: { x: 500000, y: 4000000, z: 100.75 },
    })
    expect(formatPointLine(p)).toBe('P#42  X: 1.5000  Y: -2.2500  Z: 0.7500')
    expect(formatPointLine(p, 'B')).toBe('B P#42  X: 1.5000  Y: -2.2500  Z: 0.7500')
    expect(formatOriginalLine(p)).toBe('原始 X: 500000.000000  Y: 4000000.000000  Z: 100.750000')
    expect(formatOriginalLine(p, 'C')).toBe('原始C X: 500000.000000  Y: 4000000.000000  Z: 100.750000')
  })

  it('未满员返回 null（各模式分别断言，避免误报）', () => {
    const p = makePicked()
    expect(buildMeasureResult('point', [])).toBeNull()
    expect(buildMeasureResult('distance', [p])).toBeNull()
    expect(buildMeasureResult('angle', [p, p])).toBeNull()
  })

  it('单点模式：顶点号 / 4 位显示坐标 / 分类名；无位移时不出现原始坐标行', () => {
    const r = buildMeasureResult('point', [makePicked()])!
    expect(r.lines).toEqual(['P#42', 'X: 1.5000  Y: -2.2500  Z: 0.7500', '分类 2 地面点'])
    expect(r.title).toBe('P#42')
    expect(r.summary).toContain('P#42')
    expect(r.summary).toContain('X: 1.5000')
  })

  it('单点模式：有全局位移时补一行 6 位原始坐标；无分类属性则不写分类行', () => {
    const r = buildMeasureResult('point', [
      makePicked({
        classification: null,
        globalShift: { x: 499998.5, y: 4000002.25, z: 100 },
        original: { x: 500000, y: 4000000, z: 100.75 },
      }),
    ])!
    expect(r.lines).toEqual([
      'P#42',
      'X: 1.5000  Y: -2.2500  Z: 0.7500',
      '原始 X: 500000.000000  Y: 4000000.000000  Z: 100.750000',
    ])
  })

  it('两点模式：距离与 ΔX/ΔY/ΔZ、ΔXY/ΔXZ/ΔZY、带 A/B 标记的两点坐标行', () => {
    const p1 = makePicked({ local: { x: 0, y: 0, z: 0 }, vertexIndex: 10 })
    const p2 = makePicked({ local: { x: 3, y: 4, z: 0 }, vertexIndex: 20 })
    const r = buildMeasureResult('distance', [p1, p2])!
    expect(r.title).toBe('距离 5.0000')
    expect(r.lines[0]).toBe('距离 5.0000')
    expect(r.lines[1]).toBe('ΔX 3.0000  ΔY 4.0000  ΔZ 0.0000')
    expect(r.lines[2]).toBe('ΔXY 5.0000  ΔXZ 3.0000  ΔZY 4.0000')
    // A/B 标记与浮动标签上的徽标对应，缺了就看不出哪端是 Δ 的正方向
    expect(r.lines[3]).toBe('A P#10  X: 0.0000  Y: 0.0000  Z: 0.0000')
    expect(r.lines[4]).toBe('B P#20  X: 3.0000  Y: 4.0000  Z: 0.0000')
    expect(r.summary).toContain('5.0000')
    expect(r.summary).toContain('A P#10')
    expect(r.summary).toContain('B P#20')
  })

  it('两点模式有位移时：原始坐标行同样带 A/B 标记（否则三行分不清归属）', () => {
    const shift = { x: 499998.5, y: 4000002.25, z: 100 }
    const p1 = makePicked({
      local: { x: 0, y: 0, z: 0 },
      vertexIndex: 10,
      globalShift: shift,
      original: { x: 499998.5, y: 4000002.25, z: 100 },
    })
    const p2 = makePicked({
      local: { x: 3, y: 4, z: 0 },
      vertexIndex: 20,
      globalShift: shift,
      original: { x: 500001.5, y: 4000006.25, z: 100 },
    })
    const r = buildMeasureResult('distance', [p1, p2])!
    expect(r.lines[5]).toBe('原始A X: 499998.500000  Y: 4000002.250000  Z: 100.000000')
    expect(r.lines[6]).toBe('原始B X: 500001.500000  Y: 4000006.250000  Z: 100.000000')
  })

  it('单点模式有位移时：原始坐标行不带标记（只有一个点，无歧义）', () => {
    const r = buildMeasureResult('point', [
      makePicked({
        globalShift: { x: 499998.5, y: 0, z: 0 },
        original: { x: 500000, y: -2.25, z: 0.75 },
      }),
    ])!
    expect(r.lines[2]).toBe('原始 X: 500000.000000  Y: -2.250000  Z: 0.750000')
  })

  it('三点模式：标题显示 B 点角、正文含三角/三边/面积与 A/B/C 三点行', () => {
    const p1 = makePicked({ local: { x: 0, y: 0, z: 0 }, vertexIndex: 1 })
    const p2 = makePicked({ local: { x: 3, y: 0, z: 0 }, vertexIndex: 2 })
    const p3 = makePicked({ local: { x: 0, y: 4, z: 0 }, vertexIndex: 3 })
    const r = buildMeasureResult('angle', [p1, p2, p3])!
    expect(r.title).toBe('角度 B 53.130°')
    expect(r.lines[0]).toBe('A 90.000°  B 53.130°  C 36.870°')
    expect(r.lines[1]).toBe('边长 AB 3.0000  BC 5.0000  CA 4.0000')
    expect(r.lines[2]).toBe('面积 6.0000')
    expect(r.lines[3]).toBe('A P#1  X: 0.0000  Y: 0.0000  Z: 0.0000')
    expect(r.lines[4]).toBe('B P#2  X: 3.0000  Y: 0.0000  Z: 0.0000')
    expect(r.lines[5]).toBe('C P#3  X: 0.0000  Y: 4.0000  Z: 0.0000')
  })

  it('三点退化（重合点）：角度渲染为「—」而不是 NaN 字样', () => {
    const p = makePicked({ local: { x: 1, y: 1, z: 1 } })
    const r = buildMeasureResult('angle', [p, p, p])!
    expect(r.lines[0]).toBe('A —  B —  C —')
    expect(r.lines[1]).toBe('边长 AB 0.0000  BC 0.0000  CA 0.0000')
    expect(r.lines[2]).toBe('面积 0.0000')
  })
})

describe('readPointsTag（分块标记反查）', () => {
  it('读回 pointcloudStore 打的标记', () => {
    const { points } = makePoints([0, 0, 0], { entityId: 7, chunkIndex: 3 })
    expect(readPointsTag(points)).toEqual({ entityId: 7, chunkIndex: 3 })
  })

  it('无标记 / 标记字段类型不对的 Points 返回 null（不抛异常）', () => {
    const plain = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial())
    expect(readPointsTag(plain)).toBeNull()
    plain.userData = { entityId: '7', chunkIndex: 3 }
    expect(readPointsTag(plain)).toBeNull()
    plain.userData = { entityId: 7 }
    expect(readPointsTag(plain)).toBeNull()
  })
})

describe('ensureBoundingSphere（包围球惰性补齐）', () => {
  it('有 boundingBox 时由半对角线推保守球（不扫全量点）', () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0]), 3))
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0))
    geometry.boundingSphere = null

    ensureBoundingSphere(geometry)
    expect(geometry.boundingSphere).not.toBeNull()
    expect(geometry.boundingSphere!.center.x).toBeCloseTo(1, 6)
    expect(geometry.boundingSphere!.center.y).toBeCloseTo(0, 6)
    expect(geometry.boundingSphere!.radius).toBeCloseTo(1, 6)
  })

  it('已有包围球时不动它（幂等，保护 three 自己的更紧结果）', () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0]), 3))
    const existing = new THREE.Sphere(new THREE.Vector3(9, 9, 9), 0.5)
    geometry.boundingSphere = existing

    ensureBoundingSphere(geometry)
    expect(geometry.boundingSphere).toBe(existing)
  })

  it('box 与 sphere 均为空时退回 computeBoundingSphere', () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0]), 3))

    ensureBoundingSphere(geometry)
    expect(geometry.boundingSphere).not.toBeNull()
    expect(geometry.boundingSphere!.radius).toBeCloseTo(1, 6)
  })
})

describe('pickThresholdWorld（像素半径 → 世界阈值）', () => {
  it('正交：与深度无关，等于 R × 世界单位/像素（精确公式）', () => {
    const camera = makeOrthoCamera()
    // bounds ±5、zoom=1、画布高 600：wpp = 2*5/(1*600)
    const t = pickThresholdWorld(camera, CSS_H, PICK_RADIUS_PX, new THREE.Vector3(0, 0, 0), 100)
    expect(t).toBeCloseTo((PICK_RADIUS_PX * (2 * 5)) / CSS_H, 12)
  })

  it('透视：用包围球远侧估深度（偏大方向，保证不漏拾）', () => {
    const camera = makeCamera()
    const center = new THREE.Vector3(0, 0, 0)
    const radius = 2
    const t = pickThresholdWorld(camera, CSS_H, PICK_RADIUS_PX, center, radius)
    // 深度 = |相机−球心| + 半径 = 12
    const expected = (PICK_RADIUS_PX * 2 * 12 * Math.tan((50 * Math.PI) / 360)) / CSS_H
    expect(t).toBeCloseTo(expected, 12)
  })
})

describe('pickVertex（真实 Raycaster 拾取）', () => {
  it('透视相机：命中顶点由顶点缓冲回读，取沿射线最近者（不是缓冲里第一个）', () => {
    // 旋转 group 下局部 (0,-1,0) → 世界 (0,0,1)，比世界 (0,0,0) 更靠近相机 → 必须取 index 1；
    // 同时断言 local 是 position 属性原值（不是 worldToLocal(hit.point)）
    const { points } = makePoints([0, 0, 0, 0, -1, 0], { rotate: true })
    const camera = makeCamera()
    const hit = pickVertex(castAt(0, 0, camera), camera, [makeCandidate(1, 0, points)], CSS_H)
    expect(hit).not.toBeNull()
    expect(hit!.vertexIndex).toBe(1)
    expect(hit!.entityId).toBe(1)
    expect(hit!.chunkIndex).toBe(0)
    expect(hit!.local.x).toBeCloseTo(0, 6)
    expect(hit!.local.y).toBeCloseTo(-1, 6)
    expect(hit!.local.z).toBeCloseTo(0, 6)
  })

  it('正交相机：同一场合同样取出最近的旋转后顶点', () => {
    const { points } = makePoints([0, 0, 0, 0, -1, 0], { rotate: true })
    const camera = makeOrthoCamera()
    const hit = pickVertex(castAt(0, 0, camera), camera, [makeCandidate(3, 2, points)], CSS_H)
    expect(hit).not.toBeNull()
    expect(hit!.vertexIndex).toBe(1)
    expect(hit!.entityId).toBe(3)
    expect(hit!.chunkIndex).toBe(2)
  })

  it('阈值锥内偏离射线的顶点：local 取顶点真值，而非射线上的最近点', () => {
    // 顶点 0 在 (0.05,0,1)：距射线 0.05 世界单位（锥内）、沿射线 9；顶点 1 在原点、沿射线 10
    // 最近者是顶点 0；若误用 intersects.point（射线上最近点）会得到 x=0 而非 0.05
    const { points } = makePoints([0.05, 0, 1, 0, 0, 0])
    const camera = makeCamera()
    const hit = pickVertex(castAt(0, 0, camera), camera, [makeCandidate(1, 0, points)], CSS_H)
    expect(hit!.vertexIndex).toBe(0)
    expect(hit!.local.x).toBeCloseTo(0.05, 6)
    expect(hit!.local.z).toBeCloseTo(1, 6)
  })

  it('索引几何体（分割产物）：索引外的顶点即使更近也不得返回', () => {
    // 顶点 1 在世界 (0,0,1) 距相机最近，但 index=[0,2] 里没有它
    const { points } = makePoints([0, 0, 0, 0, 0, 1, 0, 0, -1], { index: [0, 2] })
    const camera = makeCamera()
    const hit = pickVertex(castAt(0, 0, camera), camera, [makeCandidate(1, 0, points)], CSS_H)
    expect(hit).not.toBeNull()
    expect(hit!.vertexIndex).toBe(0)
  })

  it('drawRange 隐藏的点（预览隐藏）拾不到', () => {
    // 顶点 1 在 (0,0,1) 更近，但 drawRange 只放行 [0,1) 一条
    const { points } = makePoints([0, 0, 0, 0, 0, 1], { drawRange: [0, 1] })
    const camera = makeCamera()
    const hit = pickVertex(castAt(0, 0, camera), camera, [makeCandidate(1, 0, points)], CSS_H)
    expect(hit).not.toBeNull()
    expect(hit!.vertexIndex).toBe(0)
  })

  it('跨实体遮挡：无论候选顺序如何都取沿射线更近的那块', () => {
    const front = makePoints([0, 0, 2], { entityId: 7, chunkIndex: 1 }) // 世界 z=2，距相机 8
    const back = makePoints([0, 0, 0], { entityId: 9, chunkIndex: 0 }) // 世界 z=0，距相机 10
    const camera = makeCamera()
    const frontC = makeCandidate(7, 1, front.points)
    const backC = makeCandidate(9, 0, back.points)

    const a = pickVertex(castAt(0, 0, camera), camera, [frontC, backC], CSS_H)
    expect(a!.entityId).toBe(7)
    expect(a!.chunkIndex).toBe(1)
    // 交换顺序（近的在后）必须仍是同一结果
    const b = pickVertex(castAt(0, 0, camera), camera, [backC, frontC], CSS_H)
    expect(b!.entityId).toBe(7)
    expect(b!.chunkIndex).toBe(1)
  })

  it('点空白：无候选中命中返回 null，且不改写已传入的候选', () => {
    const { points } = makePoints([0, 0, 0])
    const camera = makeCamera()
    expect(pickVertex(castAt(0.9, 0.9, camera), camera, [makeCandidate(1, 0, points)], CSS_H)).toBeNull()
    expect(pickVertex(castAt(0, 0, camera), camera, [], CSS_H)).toBeNull()
  })

  it('拾取后包围球已补齐（下一帧不再触发整块 O(N) 计算）', () => {
    const { points } = makePoints([0, 0, 0, 1, 0, 0])
    const camera = makeCamera()
    expect(points.geometry.boundingSphere).toBeNull()
    pickVertex(castAt(0, 0, camera), camera, [makeCandidate(1, 0, points)], CSS_H)
    expect(points.geometry.boundingSphere).not.toBeNull()
  })
})

describe('projectWorldToScreen（世界 → CSS 像素）', () => {
  it('透视相机：原点投影到容器中心', () => {
    const p = projectWorldToScreen({ x: 0, y: 0, z: 0 }, makeCamera(), CSS_W, CSS_H)
    expect(p).not.toBeNull()
    expect(p!.x).toBeCloseTo(CSS_W / 2, 6)
    expect(p!.y).toBeCloseTo(CSS_H / 2, 6)
  })

  it('透视相机：y 轴向上映射、x 轴向右映射', () => {
    const camera = makeCamera()
    const right = projectWorldToScreen({ x: 1, y: 0, z: 0 }, camera, CSS_W, CSS_H)!
    expect(right.x).toBeGreaterThan(CSS_W / 2)
    expect(right.y).toBeCloseTo(CSS_H / 2, 6)
    const up = projectWorldToScreen({ x: 0, y: 1, z: 0 }, camera, CSS_W, CSS_H)!
    expect(up.y).toBeLessThan(CSS_H / 2) // CSS y 向下，世界 +Y 在屏幕上半部
  })

  it('透视相机：相机背后 / 超远平面一律 null（不出现镜像位置的残留标签）', () => {
    const camera = makeCamera()
    expect(projectWorldToScreen({ x: 0, y: 0, z: 20 }, camera, CSS_W, CSS_H)).toBeNull() // 相机背后（w≤0）
    expect(projectWorldToScreen({ x: 0, y: 0, z: -200 }, camera, CSS_W, CSS_H)).toBeNull() // 超远平面
  })

  it('正交相机：原点居中；背后与超远平面靠 NDC z 排除（正交 w≡1）', () => {
    const camera = makeOrthoCamera()
    const center = projectWorldToScreen({ x: 0, y: 0, z: 0 }, camera, CSS_W, CSS_H)
    expect(center).not.toBeNull()
    expect(center!.x).toBeCloseTo(CSS_W / 2, 6)
    expect(center!.y).toBeCloseTo(CSS_H / 2, 6)
    // 正交 w≡1 恒定，w≤0 分支永不触发，只能靠 |ndc.z|>1 判据——这两条正是该判据的闸门
    expect(projectWorldToScreen({ x: 0, y: 0, z: 20 }, camera, CSS_W, CSS_H)).toBeNull() // 相机背后
    expect(projectWorldToScreen({ x: 0, y: 0, z: -200 }, camera, CSS_W, CSS_H)).toBeNull() // 超远平面
  })

  it('正交相机：视野内的纵深点不因正射投影而丢失', () => {
    const camera = makeOrthoCamera()
    // bounds ±5 → x=2.5 恰在右边界（NDC x=0.5）
    const p = projectWorldToScreen({ x: 2.5, y: 0, z: -50 }, camera, CSS_W, CSS_H)!
    expect(p.x).toBeCloseTo(CSS_W * 0.75, 6)
    expect(p.y).toBeCloseTo(CSS_H / 2, 6)
  })
})
