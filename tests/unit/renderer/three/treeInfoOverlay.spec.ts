import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createTreeInfoOverlay } from '../../../../src/renderer/three/treeInfoOverlay'
import {
  CROWN_RING_SEGMENTS,
  DBH_RING_SEGMENTS,
  buildMarkerGeometryData,
  type TreeMarkerItem,
} from '../../../../src/renderer/utils/treeMarkers'

// 纯 three.js 对象构造，不需要 WebGL 上下文（几何体/材质都是 JS 侧数据），
// 故与 viewingPivot.spec.ts 同样跑在默认的 node 环境，无需 jsdom 注释。
//
// 只断言"能被外部观察到的量与不变量"：场景图结构（**一个** Group 下**两个**对象 —— 这是
// "2 个 draw call"那条设计的哨兵）、drawRange 的收缩、缓冲容量只增不减、dispose 的摘除。
// 顶点生成式在 utils/treeMarkers.spec.ts 里断过了，这里不重复。

/** 一棵"算全了"的树要画的标记（显示坐标；数值本身不重要）。 */
function mkItem(i: number): TreeMarkerItem {
  return {
    id: i + 1,
    center: { x: i, y: 0, z: 1.3 },
    crown: { x: i, y: 0, z: 10, halfX: 2, halfY: 3 },
    dbh: { x: i, y: 0, z: 1.3, radius: 0.2 },
  }
}

/** 每棵树：冠层 64 段 + 胸径 48 段（各 2 顶点），树心 1 个顶点。 */
const RING_VERTS_PER_TREE = (CROWN_RING_SEGMENTS + DBH_RING_SEGMENTS) * 2

function setup() {
  const scene = new THREE.Scene()
  const overlay = createTreeInfoOverlay(scene)
  const group = scene.getObjectByName('treeInfoOverlay')
  if (!group) throw new Error('group 未挂到 scene')
  const rings = group.children.find((c) => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments
  const centers = group.children.find((c) => (c as THREE.Points).isPoints) as THREE.Points
  return { scene, overlay, group, rings, centers }
}

describe('createTreeInfoOverlay（树木 3D 标记装配）', () => {
  it('挂到 scene 的一个 Group 下，恰好 1 个 LineSegments + 1 个 Points、初始全隐藏', () => {
    const { scene, group, rings, centers } = setup()
    expect(scene.children).toContain(group)
    expect(group.children).toHaveLength(2)
    expect(rings).toBeDefined()
    expect(centers).toBeDefined()
    // Z-up 显示坐标 → 世界坐标的转换与点云 Group 同款
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2, 12)
    expect(group.visible).toBe(false)
    expect(rings.visible).toBe(false)
    expect(centers.visible).toBe(false)
    // 顶点数由 drawRange 决定，必须关掉视锥剔除（否则会被误剪）
    expect(rings.frustumCulled).toBe(false)
    expect(centers.frustumCulled).toBe(false)
  })

  it('show：两层可见、drawRange 与 items 对齐、数据写在缓冲开头', () => {
    const { overlay, group, rings, centers } = setup()
    const data = buildMarkerGeometryData([mkItem(0), mkItem(1), mkItem(2)])
    overlay.show(data)
    expect(group.visible).toBe(true)
    expect(rings.geometry.drawRange.count).toBe(RING_VERTS_PER_TREE * 3)
    expect(centers.geometry.drawRange.count).toBe(3)
    // 第 2 棵树的树心点（每棵 1 个顶点、3 个分量）
    const pos = centers.geometry.getAttribute('position') as THREE.BufferAttribute
    expect(pos.getX(1)).toBeCloseTo(1, 6)
    expect(pos.getZ(1)).toBeCloseTo(1.3, 6)
    // 颜色属性与位置同容量（顶点色材质读的就是它）
    expect(centers.geometry.getAttribute('color')).toBeDefined()
    expect(rings.geometry.getAttribute('color')).toBeDefined()
  })

  it('空输入 ⇒ 整组隐藏（不是留一个空 drawRange 的对象）', () => {
    const { overlay, group, rings, centers } = setup()
    overlay.show(buildMarkerGeometryData([]))
    expect(group.visible).toBe(false)
    expect(rings.visible).toBe(false)
    expect(centers.visible).toBe(false)
    expect(rings.geometry.drawRange.count).toBe(0)
    expect(centers.geometry.drawRange.count).toBe(0)
  })

  it('二次 show 覆盖：少了就收缩 drawRange，不留残影', () => {
    const { overlay, rings, centers } = setup()
    overlay.show(buildMarkerGeometryData([mkItem(0), mkItem(1), mkItem(2)]))
    overlay.show(buildMarkerGeometryData([mkItem(0)]))
    expect(rings.geometry.drawRange.count).toBe(RING_VERTS_PER_TREE)
    expect(centers.geometry.drawRange.count).toBe(1)
    // 第二棵的槽位不该再被画出来（数据还在缓冲里，但 drawRange 圈不到它）
    overlay.show(buildMarkerGeometryData([]))
    expect(rings.geometry.drawRange.count).toBe(0)
  })

  it('容量只增不减：大批次之后的小批次不再重分配（缓冲地址不变）', () => {
    const { overlay, rings, centers } = setup()
    overlay.show(buildMarkerGeometryData(Array.from({ length: 40 }, (_, i) => mkItem(i))))
    const ringBuffer = rings.geometry.getAttribute('position').array
    const centerBuffer = centers.geometry.getAttribute('position').array
    expect(ringBuffer.length).toBeGreaterThanOrEqual(40 * RING_VERTS_PER_TREE * 3)
    // 换成 2 棵：drawRange 收缩、几何体不重建（同一份缓冲）
    overlay.show(buildMarkerGeometryData([mkItem(0), mkItem(1)]))
    expect(rings.geometry.getAttribute('position').array).toBe(ringBuffer)
    expect(centers.geometry.getAttribute('position').array).toBe(centerBuffer)
    expect(rings.geometry.drawRange.count).toBe(RING_VERTS_PER_TREE * 2)
    // 再涨回去也不重建（容量已够）
    overlay.show(buildMarkerGeometryData(Array.from({ length: 40 }, (_, i) => mkItem(i))))
    expect(rings.geometry.getAttribute('position').array).toBe(ringBuffer)
  })

  it('hide 只隐藏（复用实例，不释放）', () => {
    const { overlay, group } = setup()
    overlay.show(buildMarkerGeometryData([mkItem(0)]))
    overlay.hide()
    expect(group.visible).toBe(false)
  })

  it('dispose：从场景摘除并释放两个几何体', () => {
    const { scene, overlay, group, rings, centers } = setup()
    // three 的 dispose() 会派发 'dispose' 事件（渲染器据此交还 GPU 缓冲），借它观察是否真的释放了
    let ringDisposed = false
    let centerDisposed = false
    rings.geometry.addEventListener('dispose', () => {
      ringDisposed = true
    })
    centers.geometry.addEventListener('dispose', () => {
      centerDisposed = true
    })
    overlay.dispose()
    expect(scene.children).not.toContain(group)
    expect(ringDisposed).toBe(true)
    expect(centerDisposed).toBe(true)
  })
})
