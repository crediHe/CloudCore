import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { computeQuadrangleSelection, computePolygonSelection } from '../../../../src/renderer/utils/segmentSelection'
import type { NdcRect, NdcPoint } from '../../../../src/renderer/utils/segmentSelection'

// 纯数学算法，node 环境即可（不依赖 DOM），无需 jsdom 注释。

/** 构造透视相机：位于 (0,0,10) 看向原点。 */
function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

/** 构造正交相机（bounds ±5，near/far 与 makeCamera 同值）：位于 (0,0,10) 看向原点。 */
function makeOrthoCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

/**
 * 选区成员的地面真值（与算法内部实现独立）：
 * 世界坐标 → 视空间判断是否在相机前（透视 w<=0 即视空间 z>-near），
 * 再投影 NDC 判断矩形归属。
 * 正交相机 w≡1（平行投影），背后/超近远平面只能靠 NDC z ∈ [-1,1] 判定；
 * 投影矩阵第 4 行恒 (0,0,0,1)，project() 的 w 除法退化为恒等，z 即 NDC z。
 */
function isInsideGroundTruth(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  rect: NdcRect,
  x: number,
  y: number,
  z: number
): boolean {
  const view = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  const v = new THREE.Vector3(x, y, z).project(camera)
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    if (v.z < -1 || v.z > 1) return false
  } else if (view.z > -camera.near) {
    return false
  }
  return v.x >= rect.minX && v.x <= rect.maxX && v.y >= rect.minY && v.y <= rect.maxY
}

describe('computeQuadrangleSelection（四边形选区）', () => {
  it('单位矩阵 group：矩形包围盒内/外归属与相机背后点归外部', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    const group = new THREE.Group()
    scene.add(group)

    // 世界坐标点（group 无变换，局部=世界）
    const points = [0.1, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 11]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))

    const rect: NdcRect = { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }
    const result = await computeQuadrangleSelection(camera, scene, rect, [
      { entityId: 1, group, geometries: [geometry] },
    ])

    const sels = result.get(1)!
    expect(sels).toHaveLength(1)
    const sel = sels[0]

    // 与地面真值对比（相机背后点已由真值函数排除在外）
    const expectedInside: number[] = []
    const expectedOutside: number[] = []
    for (let i = 0; i < points.length / 3; i++) {
      const isIn = isInsideGroundTruth(camera, rect, points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
      ;(isIn ? expectedInside : expectedOutside).push(i)
    }
    expect(Array.from(sel.inside)).toEqual(expectedInside)
    expect(Array.from(sel.outside)).toEqual(expectedOutside)
    // 相机背后点 (0,0,11) 的 w<=0，必须归外部（真值函数已排除，单独再断言一次）
    expect(Array.from(sel.outside)).toContain(3)
    // inside 包围盒 = 唯一命中点的坐标（Float32 存储有尾差，逐字段近似比较）
    expect(sel.insideBBox.minX).toBeCloseTo(0.1)
    expect(sel.insideBBox.minY).toBeCloseTo(0)
    expect(sel.insideBBox.minZ).toBeCloseTo(0)
    expect(sel.insideBBox.maxX).toBeCloseTo(0.1)
    expect(sel.insideBBox.maxY).toBeCloseTo(0)
    expect(sel.insideBBox.maxZ).toBeCloseTo(0)
    // 两侧索引递增且无重叠
    expect(sel.inside.length + sel.outside.length).toBe(4)
  })

  it('S1 回归：rotation.x=-π/2 的 group 必须乘 matrixWorld，选区与屏幕矩形一致', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    // 点云挂在 Z-up→Y-up 旋转的 Group 内（与项目一致）：局部 (x,y,z) → 世界 (x, z, -y)
    const group = new THREE.Group()
    group.rotation.x = -Math.PI / 2
    scene.add(group)

    // 局部坐标点：
    // A (0,1,0) → 世界 (0,0,-1)：投影在屏幕正中 → 不在 [0.1,0.3] 横带内（若不乘 matrixWorld 会误判为带内）
    // B (0,0,0.6) → 世界 (0,0.6,0)：投影 y≈0.129 → 带内
    // C (0,-11,0) → 世界 (0,0,11)：相机背后 → 外部
    const local = [0, 1, 0, 0, 0, 0.6, 0, -11, 0]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(local), 3))

    const rect: NdcRect = { minX: -0.5, minY: 0.1, maxX: 0.5, maxY: 0.3 }
    const result = await computeQuadrangleSelection(camera, scene, rect, [
      { entityId: 7, group, geometries: [geometry] },
    ])
    const sel = result.get(7)![0]

    // 地面真值：把局部点经 matrixWorld 转世界后投影（与算法内部无关）
    const world = new THREE.Vector3()
    const expectedInside: number[] = []
    const expectedOutside: number[] = []
    for (let i = 0; i < local.length / 3; i++) {
      world.fromArray(local, i * 3).applyMatrix4(group.matrixWorld)
      const isIn = isInsideGroundTruth(camera, rect, world.x, world.y, world.z)
      ;(isIn ? expectedInside : expectedOutside).push(i)
    }
    expect(Array.from(sel.inside)).toEqual(expectedInside)
    expect(Array.from(sel.inside)).toEqual([1]) // 只有 B 命中
    expect(Array.from(sel.outside)).toEqual([0, 2]) // A（误判点）+ C（相机背后）
  })

  it('多块 geometry：结果与各块对齐，onChunk 每块回调一次', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    const group = new THREE.Group()
    scene.add(group)

    const geoA = new THREE.BufferGeometry()
    geoA.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3))
    const geoB = new THREE.BufferGeometry()
    geoB.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-2, 0, 0, 5, 0, 0]), 3))

    const rect: NdcRect = { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }
    let chunkCalls = 0
    const result = await computeQuadrangleSelection(
      camera,
      scene,
      rect,
      [{ entityId: 1, group, geometries: [geoA, geoB] }],
      () => {
        chunkCalls++
      }
    )

    expect(chunkCalls).toBe(2)
    const sels = result.get(1)!
    expect(sels).toHaveLength(2)
    // 块 A：点 (0,0,0) 与 (1,0,0)（ndc x≈0.21）都在中心框内
    expect(Array.from(sels[0].inside)).toEqual([0, 1])
    expect(Array.from(sels[0].outside)).toEqual([])
    // 块 B：(-2,0,0)（ndc x≈-0.43）在框内；(5,0,0)（ndc x≈1.07）在外
    expect(Array.from(sels[1].inside)).toEqual([0])
    expect(Array.from(sels[1].outside)).toEqual([1])
  })

  it('回归：分割产物（共享缓冲 + index 子集）二次分割只筛自己的点，不混入兄弟子集', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    const group = new THREE.Group()
    scene.add(group)

    // 模拟第一次分割后的实体 A：geometry 共享整块原始缓冲（splitEntity →
    // buildIndexedGeometry 语义），index [0,2] 才是属于 A 的可见点。
    // 顶点 1/3 属于兄弟实体 B：顶点 1 恰好落在选区框内（旧实现会泄漏进 inside），
    // 顶点 3 在框外（旧实现会泄漏进 outside，因其 outside = 全量缓冲的补集）。
    // z=0 平面 NDC≈±1 对应世界≈±4.663，world ±0.5/±1 均落在中心框 [-0.5,0.5]² 内
    const full = [1, 0.5, 0, 0.9, -0.2, 0, -1, -0.5, 0, 5, 0, 0]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(full), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 2]), 1))

    const rect: NdcRect = { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }
    const result = await computeQuadrangleSelection(camera, scene, rect, [
      { entityId: 1, group, geometries: [geometry] },
    ])
    const sel = result.get(1)![0]

    // inside/outside 为"顶点缓冲空间"下标，并集恰为 A 的 index 条目（[0,2] 且递增），
    // B 的顶点 1（框内）与顶点 3（框外）一律不得出现
    expect(Array.from(sel.inside)).toEqual([0, 2])
    expect(Array.from(sel.outside)).toEqual([])
    expect(Array.from(sel.inside).concat(Array.from(sel.outside))).toEqual([0, 2])
    // inside 包围盒只覆盖 A 的两点（若泄漏顶点 1，minX≈0.9 而非 -1）
    expect(sel.insideBBox.minX).toBeCloseTo(-1)
    expect(sel.insideBBox.minY).toBeCloseTo(-0.5)
    expect(sel.insideBBox.maxX).toBeCloseTo(1)
    expect(sel.insideBBox.maxY).toBeCloseTo(0.5)
  })
})

/**
 * 多边形选区成员的地面真值（独立 winding number 实现，与 even-odd 算法代码路径不同，
 * 避免同错同对）：世界坐标 → 视空间判断是否在相机前（透视 w<=0 即视空间 z>-near），
 * 再投影 NDC 判多边形归属。相机背后的点一律视为"外部"。
 */
function isInsidePolygonGroundTruth(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  poly: NdcPoint[],
  x: number,
  y: number,
  z: number
): boolean {
  const view = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  const v = new THREE.Vector3(x, y, z).project(camera)
  // 正交相机 w≡1：背后/超近远平面靠 NDC z ∈ [-1,1] 判定（与 isInsideGroundTruth 同理由）
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    if (v.z < -1 || v.z > 1) return false
  } else if (view.z > -camera.near) {
    return false
  }
  // winding number（Dan Sunday 算法）：wn ≠ 0 即在内
  let wn = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y
    const xj = poly[j].x,
      yj = poly[j].y
    const cross = (xj - xi) * (v.y - yi) - (v.x - xi) * (yj - yi)
    if (yi <= v.y) {
      if (yj > v.y && cross > 0) wn++
    } else {
      if (yj <= v.y && cross < 0) wn--
    }
  }
  return wn !== 0
}

describe('computePolygonSelection（自由多边形选区）', () => {
  it('单位矩阵 group：凹多边形（倒 L 形）内外归属与相机背后点归外部', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    const group = new THREE.Group()
    scene.add(group)

    // 倒 L 形凹多边形（NDC，点击顺序，逆时针）：左边全高 + 顶部全宽，缺口在右下
    const poly: NdcPoint[] = [
      { x: -0.6, y: -0.6 },
      { x: -0.6, y: 0.6 },
      { x: 0.6, y: 0.6 },
      { x: 0.6, y: 0.2 },
      { x: -0.2, y: 0.2 },
      { x: -0.2, y: -0.6 },
    ]

    // 相机 z=10、fov 50°、aspect 1 时，z=0 平面上 NDC≈±1 对应世界≈±4.663；
    // 世界坐标点：前 3 个在多边形内，后 4 个在外（右下缺口 / AABB 外 / 相机背后）
    const S = 4.663
    const world = [
      0.4 * S,
      0.4 * S,
      0, // 顶部全宽区 → inside
      -0.5 * S,
      0.5 * S,
      0, // 左上 → inside
      -0.3 * S,
      0,
      0, // 左侧条带 → inside
      0,
      0,
      0, // 右下缺口 → outside
      0.5 * S,
      -0.3 * S,
      0, // 右下缺口 → outside
      0.9 * S,
      0.5 * S,
      0, // NDC AABB 之外 → outside
      0,
      0,
      11, // 相机背后 → outside
    ]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(world), 3))

    const result = await computePolygonSelection(camera, scene, poly, [{ entityId: 1, group, geometries: [geometry] }])
    const sel = result.get(1)![0]

    // 与独立 winding number 真值逐点对比
    const expectedInside: number[] = []
    const expectedOutside: number[] = []
    for (let i = 0; i < world.length / 3; i++) {
      const isIn = isInsidePolygonGroundTruth(camera, poly, world[i * 3], world[i * 3 + 1], world[i * 3 + 2])
      ;(isIn ? expectedInside : expectedOutside).push(i)
    }
    expect(Array.from(sel.inside)).toEqual(expectedInside)
    expect(Array.from(sel.inside)).toEqual([0, 1, 2]) // 缺口与相机背后点都归外部
    expect(Array.from(sel.outside)).toEqual([3, 4, 5, 6])
    // 两侧索引递增且无重叠
    expect(sel.inside.length + sel.outside.length).toBe(world.length / 3)
    // inside 包围盒：三个命中点都在 z=0 平面
    expect(sel.insideBBox.minZ).toBeCloseTo(0)
    expect(sel.insideBBox.maxZ).toBeCloseTo(0)
  })

  it('S1 回归：rotation.x=-π/2 的 group 必须乘 matrixWorld（多边形同样适用）', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    // 点云挂在 Z-up→Y-up 旋转的 Group 内（与项目一致）：局部 (x,y,z) → 世界 (x, z, -y)
    const group = new THREE.Group()
    group.rotation.x = -Math.PI / 2
    scene.add(group)

    // 与四边形 S1 用例同构：多边形为屏幕横带矩形
    // A (0,1,0) → 世界 (0,0,-1)：NDC y≈0 不在带内（若不乘 matrixWorld 会误判为带内）
    // B (0,0,0.6) → 世界 (0,0.6,0)：NDC y≈0.129 → 带内
    // C (0,-11,0) → 世界 (0,0,11)：相机背后 → 外部
    const poly: NdcPoint[] = [
      { x: -0.5, y: 0.1 },
      { x: -0.5, y: 0.3 },
      { x: 0.5, y: 0.3 },
      { x: 0.5, y: 0.1 },
    ]
    const local = [0, 1, 0, 0, 0, 0.6, 0, -11, 0]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(local), 3))

    const result = await computePolygonSelection(camera, scene, poly, [{ entityId: 7, group, geometries: [geometry] }])
    const sel = result.get(7)![0]

    // 地面真值：把局部点经 matrixWorld 转世界后投影（与算法内部无关）
    const world = new THREE.Vector3()
    const expectedInside: number[] = []
    const expectedOutside: number[] = []
    for (let i = 0; i < local.length / 3; i++) {
      world.fromArray(local, i * 3).applyMatrix4(group.matrixWorld)
      const isIn = isInsidePolygonGroundTruth(camera, poly, world.x, world.y, world.z)
      ;(isIn ? expectedInside : expectedOutside).push(i)
    }
    expect(Array.from(sel.inside)).toEqual(expectedInside)
    expect(Array.from(sel.inside)).toEqual([1]) // 只有 B 命中
    expect(Array.from(sel.outside)).toEqual([0, 2]) // A（误判点）+ C（相机背后）
  })

  it('多块 geometry：onChunk 每块一次 + 空块 EMPTY_BBOX 防御 + 少于 3 顶点返回空 Map', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    const group = new THREE.Group()
    scene.add(group)

    const geoA = new THREE.BufferGeometry()
    geoA.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3))
    const geoEmpty = new THREE.BufferGeometry()
    geoEmpty.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))

    // 覆盖屏幕中心的矩形多边形（正方形，4 顶点）
    const poly: NdcPoint[] = [
      { x: -0.5, y: -0.5 },
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: -0.5 },
    ]
    let chunkCalls = 0
    const result = await computePolygonSelection(
      camera,
      scene,
      poly,
      [{ entityId: 1, group, geometries: [geoA, geoEmpty] }],
      () => {
        chunkCalls++
      }
    )

    expect(chunkCalls).toBe(2)
    const sels = result.get(1)!
    expect(sels).toHaveLength(2)
    expect(Array.from(sels[0].inside)).toEqual([0])
    // 空块：0 点 + EMPTY_BBOX
    expect(sels[1].inside).toHaveLength(0)
    expect(sels[1].outside).toHaveLength(0)
    expect(sels[1].insideBBox).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 })

    // 少于 3 顶点：防御返回空 Map
    const emptyResult = await computePolygonSelection(
      camera,
      scene,
      [
        { x: 0, y: 0 },
        { x: 0.2, y: 0.2 },
      ],
      [{ entityId: 1, group, geometries: [geoA] }]
    )
    expect(emptyResult.size).toBe(0)
  })

  it('回归：多边形二次分割同样只遍历 index 条目，outside 只含本实体点', async () => {
    const scene = new THREE.Scene()
    const camera = makeCamera()
    const group = new THREE.Group()
    scene.add(group)

    // 模拟第一次分割后的实体 A：共享缓冲 + index [0,2,4]（顶点 1/3 属于兄弟实体 B，
    // 其中顶点 1 落在多边形内——旧实现会把它泄漏进 inside，顶点 3 泄漏进 outside）。
    // z=0 平面 NDC≈±1 对应世界≈±4.663：A 的 0/2 在中心框内、4 在框外左下角
    const full = [0.5, 0.5, 0, 0.4, -0.4, 0, -0.5, 0.5, 0, 4, 0, 0, -3, -3, 0]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(full), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 2, 4]), 1))

    const poly: NdcPoint[] = [
      { x: -0.5, y: -0.5 },
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: -0.5 },
    ]
    const result = await computePolygonSelection(camera, scene, poly, [{ entityId: 9, group, geometries: [geometry] }])
    const sel = result.get(9)![0]

    // 结果为顶点缓冲空间下标，并集恰为 A 的 index 条目；B 的顶点 1/3 均不得出现
    expect(Array.from(sel.inside)).toEqual([0, 2])
    expect(Array.from(sel.outside)).toEqual([4])
    expect(Array.from(sel.inside).concat(Array.from(sel.outside))).toEqual([0, 2, 4])
  })
})

/**
 * 正交相机下的四边形选区（正射投影：NDC x/y 与深度无关）。
 * bounds ±5 且 zoom=1：世界 x/y ±2.5 即中心框 [-0.5,0.5]² 的边界。
 * 相机位于 (0,0,10) 看向原点，near/far = 0.1/100 → 视空间 z ∈ (-100, -0.1) 可见。
 */
describe('computeQuadrangleSelection（正交相机）', () => {
  it('纵深上的点算选区内；相机背后/超远平面的点必须排除（w≡1 依赖 z 裁剪）', async () => {
    const scene = new THREE.Scene()
    const camera = makeOrthoCamera()
    const group = new THREE.Group()
    scene.add(group)

    const points = [
      1, 0, 0, // p0 x ndc 0.2 → 框内（浅层）
      3, 0, 0, // p1 x ndc 0.6 → 框外
      0, 0, 4, // p2 视线正前深处（视空间 z=-6）：x/y ndc 0 → 框内（正射含纵深）
      -2.4, 0, -50, // p3 x ndc -0.48 框内、视空间 z=-60 深部 → 框内
      0, 0, 11, // p4 相机背后（视空间 z=1 > -near）：w≡1 时无 z 裁剪会误判框内
      0, 0, -200, // p5 超远平面（视空间 z=-210 < -far）：同样必须排除
    ]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))

    const rect: NdcRect = { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }
    const result = await computeQuadrangleSelection(camera, scene, rect, [
      { entityId: 1, group, geometries: [geometry] },
    ])
    const sel = result.get(1)![0]

    // 与地面真值对比（正交分支：NDC z ∈ [-1,1] 近远裁剪 + x/y 框内）
    const expectedInside: number[] = []
    const expectedOutside: number[] = []
    for (let i = 0; i < points.length / 3; i++) {
      const isIn = isInsideGroundTruth(camera, rect, points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
      ;(isIn ? expectedInside : expectedOutside).push(i)
    }
    expect(Array.from(sel.inside)).toEqual(expectedInside)
    // 关键回归闸门：相机背后 p4 与超远 p5 必须归外部（无 z 裁剪时二者 NDC 与 p2 相同）
    expect(Array.from(sel.inside)).toEqual([0, 2, 3])
    expect(Array.from(sel.outside)).toEqual([1, 4, 5])
    // 两侧索引递增且无重叠
    expect(sel.inside.length + sel.outside.length).toBe(points.length / 3)
  })
})

/**
 * 正交相机下的自由多边形选区冒烟（与四边形同款近远排除逻辑，走 even-odd 路径）。
 */
describe('computePolygonSelection（正交相机）', () => {
  it('单位矩阵 group：框内/框外/相机背后/超远平面归属正确', async () => {
    const scene = new THREE.Scene()
    const camera = makeOrthoCamera()
    const group = new THREE.Group()
    scene.add(group)

    // 覆盖中心框的矩形多边形（正方形，4 顶点）
    const poly: NdcPoint[] = [
      { x: -0.5, y: -0.5 },
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: -0.5 },
    ]
    const points = [
      0, 0, 0, // p0 中心 → 框内
      3, 0, 0, // p1 x ndc 0.6 → 框外
      0, 0, 11, // p2 相机背后 → 框外（回归闸门）
      0, 0, -200, // p3 超远平面 → 框外（回归闸门）
    ]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))

    const result = await computePolygonSelection(camera, scene, poly, [{ entityId: 1, group, geometries: [geometry] }])
    const sel = result.get(1)![0]

    const expectedInside: number[] = []
    const expectedOutside: number[] = []
    for (let i = 0; i < points.length / 3; i++) {
      const isIn = isInsidePolygonGroundTruth(camera, poly, points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
      ;(isIn ? expectedInside : expectedOutside).push(i)
    }
    expect(Array.from(sel.inside)).toEqual(expectedInside)
    expect(Array.from(sel.inside)).toEqual([0])
    expect(Array.from(sel.outside)).toEqual([1, 2, 3])
    expect(sel.inside.length + sel.outside.length).toBe(points.length / 3)
  })
})
