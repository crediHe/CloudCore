import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createViewingPivot } from '../../../../src/renderer/three/viewingPivot'
import { PIVOT_BALL_RADIUS_PX, pivotRingRadiusPx, worldPerPixelOrtho } from '../../../../src/renderer/utils/viewScale'

// 纯 three.js 对象构造，不需要 WebGL 上下文（几何体/材质都是 JS 侧数据），
// 故与 measure.spec.ts 同样跑在默认的 node 环境，无需 jsdom 注释。
//
// 只测"能被外部观察到的量与不变量"：group 的位置/缩放/可见性、球的世界半径、
// dispose 的摘除；环的顶点生成式（buildRing）是内部细节，不直接断言。

/** 视口尺寸（与 viewScale.spec.ts 的用例取值一致，便于手算换算）。 */
const W = 800
const H = 600

/** 从挂载后的 group 里取黄球（唯一的 Mesh 子节点；环与直径线都是 Line）。 */
function findBall(group: THREE.Object3D): THREE.Mesh {
  const ball = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined
  if (!ball) throw new Error('viewingPivot 里找不到球体子节点')
  return ball
}

/** 建一个 pivot + 一个正交相机（top=10、zoom=1），并跑一帧 update。 */
function setupOrtho(pivotAt = new THREE.Vector3()) {
  const scene = new THREE.Scene()
  const pivot = createViewingPivot(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 10, -10, 0.1, 10000)
  camera.position.set(0, 0, 100)
  pivot.update(camera, W, H, pivotAt)
  const group = scene.getObjectByName('viewingPivot')
  if (!group) throw new Error('group 未挂到 scene')
  return { scene, pivot, camera, group, ball: findBall(group) }
}

describe('createViewingPivot（旋转中心符号，仿 CC drawPivot）', () => {
  it('挂到 scene 的一个 Group 下，含 1 个球 + 3 环 + 3 直径线', () => {
    const { group } = setupOrtho()
    expect(group.children.filter((c) => (c as THREE.Mesh).isMesh)).toHaveLength(1)
    expect(group.children.filter((c) => (c as THREE.LineLoop).isLineLoop)).toHaveLength(3)
    expect(group.children.filter((c) => (c as THREE.LineSegments).isLineSegments)).toHaveLength(3)
  })

  it('位置跟随 pivot（每帧写入，不在构造期定死）', () => {
    const { group } = setupOrtho(new THREE.Vector3(1, -2, 3))
    expect(group.position.toArray()).toEqual([1, -2, 3])
  })

  it('环的世界半径 = 屏幕上 ringRadiusPx 像素（正射换算）', () => {
    const { group } = setupOrtho()
    // 正射 top=10、zoom=1、高 600 ⇒ 每像素 1/30 世界单位
    const wpp = worldPerPixelOrtho(10, 1, H)
    expect(wpp).toBeCloseTo(1 / 30, 12)
    // 单位圆 × scale，在屏幕上正好铺成 ringRadiusPx 像素
    expect(group.scale.x).toBeCloseTo(pivotRingRadiusPx(W, H) * wpp, 12)
  })

  it('球的世界半径恒为 10 像素（与环半径、视口尺寸无关）', () => {
    const { group, ball } = setupOrtho()
    const wpp = worldPerPixelOrtho(10, 1, H)
    const worldRadius = ball.scale.x * group.scale.x
    expect(worldRadius).toBeCloseTo(PIVOT_BALL_RADIUS_PX * wpp, 12)
    // 换个视口尺寸，球的**像素**半径不变（world 半径按 wpp 同步缩放）
    const big = setupOrtho()
    big.pivot.update(big.camera, 1600, 1200, new THREE.Vector3())
    const wppBig = worldPerPixelOrtho(10, 1, 1200)
    expect(big.ball.scale.x * big.group.scale.x).toBeCloseTo(PIVOT_BALL_RADIUS_PX * wppBig, 12)
  })

  it('透视下随深度等比放大，屏幕上尺寸不变（d 加倍 ⇒ 世界尺寸加倍）', () => {
    const scene = new THREE.Scene()
    const pivot = createViewingPivot(scene)
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 10000)
    const group = scene.getObjectByName('viewingPivot')!

    camera.position.set(0, 0, 10)
    pivot.update(camera, W, H, new THREE.Vector3())
    const near = group.scale.x
    camera.position.set(0, 0, 20)
    pivot.update(camera, W, H, new THREE.Vector3())
    expect(group.scale.x / near).toBeCloseTo(2, 10)
  })

  it('相机贴住目标（深度→0）时不产生 NaN/Infinity（钳到 near）', () => {
    const scene = new THREE.Scene()
    const pivot = createViewingPivot(scene)
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 10000)
    camera.position.copy(new THREE.Vector3()) // 与 pivot 重合
    pivot.update(camera, W, H, new THREE.Vector3())
    const group = scene.getObjectByName('viewingPivot')!
    expect(Number.isFinite(group.scale.x)).toBe(true)
    expect(group.scale.x).toBeGreaterThan(0)
  })

  it('尺寸非法时一律不画：容器未布局（0×0）/ 正射 zoom 退化（top=0）', () => {
    const { pivot, camera, group } = setupOrtho()
    pivot.setVisibility('always')
    expect(group.visible).toBe(true)

    pivot.update(camera, 0, 0, new THREE.Vector3())
    expect(group.visible).toBe(false)

    // top=0 ⇒ worldPerPixel 为 0：此时若继续算缩放会把 Infinity 写进矩阵
    const broken = new THREE.OrthographicCamera(-1, 1, 0, 0, 0.1, 10000)
    broken.position.set(0, 0, 100)
    pivot.update(broken, W, H, new THREE.Vector3())
    expect(group.visible).toBe(false)
  })
})

describe('ViewingPivot 三档可见性（CC 的 PivotVisibility）', () => {
  it('默认 onMove：未拖动不显示，拖动中显示，松手回落', () => {
    const { pivot, group } = setupOrtho()
    expect(group.visible).toBe(false)
    pivot.setDragging(true)
    expect(group.visible).toBe(true)
    pivot.setDragging(false)
    expect(group.visible).toBe(false)
  })

  it('always：常显，且松手后仍显示（不随拖动状态回落）', () => {
    const { pivot, group } = setupOrtho()
    pivot.setVisibility('always')
    expect(group.visible).toBe(true)
    pivot.setDragging(true)
    pivot.setDragging(false)
    expect(group.visible).toBe(true)
  })

  it('hide：即使正在拖动也不显示', () => {
    const { pivot, group } = setupOrtho()
    pivot.setVisibility('hide')
    pivot.setDragging(true)
    expect(group.visible).toBe(false)
    pivot.setVisibility('always') // 切回常显应立即生效，无需等下一帧
    expect(group.visible).toBe(true)
  })
})

describe('ViewingPivot.dispose', () => {
  it('把 group 从 scene 摘掉（场景不留残骸）', () => {
    const { scene, pivot } = setupOrtho()
    expect(scene.children).toHaveLength(1)
    pivot.dispose()
    expect(scene.children).toHaveLength(0)
    expect(scene.getObjectByName('viewingPivot')).toBeUndefined()
  })
})
