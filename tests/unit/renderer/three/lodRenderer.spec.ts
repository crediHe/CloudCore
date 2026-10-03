import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  createLodDisplay,
  disposeLodDisplay,
  fillLodFallback,
  fillLodFromIds,
  lodStagingAttributes,
  buildChunkViews,
  LOD_CHUNK_SENTINEL,
  LOD_FRAME_BUDGET,
} from '../../../../src/renderer/three/lodRenderer'
import type { LodDisplay } from '../../../../src/renderer/three/lodRenderer'
import { readPointsTag, readLodSlotResolver } from '../../../../src/renderer/utils/measure'
import { lodPackId } from '../../../../src/renderer/utils/lodOctree'

// 纯 three 对象与 TypedArray，node 环境即可（不依赖 DOM），无需 jsdom 注释。
//
// 填充有两条路径：`fillLodFallback`（块主序等距取样，建树期间的兜底）与
// `fillLodFromIds`（树就绪后按 gather 的打包 id 解码）。前者由 createLodDisplay
// 首帧直接调用，后者由 lodScheduler 每帧调用——两条路径写的是同一套 staging 缓冲
// 与同一套 slotIds 编码，因此**反查链路对两条路径都要成立**，这是本文件的主线。

/**
 * 造一个"原始块"几何体（无 index）：n 个点，X 坐标 = chunkTag × 1e6 + 块内序号。
 * X 因此**唯一标识源点**（float32 精确表示到 16.7M），
 * "反查出来的 (chunk, vertex) 读到的 X" === "槽位里的 X" 就是一次逐点的等价性断言。
 */
function makeChunk(n: number, chunkTag: number, colorKind: 'float' | 'u8' = 'float'): THREE.BufferGeometry {
  const positions = new Float32Array(n * 3)
  const colors = colorKind === 'float' ? new Float32Array(n * 3) : new Uint8Array(n * 3)
  const classifications = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    positions[i * 3] = chunkTag * 1e6 + i
    positions[i * 3 + 1] = chunkTag
    positions[i * 3 + 2] = -i
    if (colorKind === 'float') {
      ;(colors as Float32Array)[i * 3] = i / 1000
      ;(colors as Float32Array)[i * 3 + 1] = 0.25
      ;(colors as Float32Array)[i * 3 + 2] = 0.5
    } else {
      colors[i * 3] = 10
      colors[i * 3 + 1] = 20
      colors[i * 3 + 2] = 30
    }
    classifications[i] = i % 256
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3, colorKind === 'u8'))
  geo.setAttribute('classification', new THREE.BufferAttribute(classifications, 1))
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(chunkTag * 1e6, chunkTag, -n),
    new THREE.Vector3(chunkTag * 1e6 + n - 1, chunkTag, 0)
  )
  return geo
}

/** 造一个"分割产物"几何体：顶点缓冲全量，靠 index 圈出可见子集（顶点下标 = index[k]）。 */
function makeIndexedChunk(vertexCount: number, visible: number[], chunkTag: number): THREE.BufferGeometry {
  const geo = makeChunk(vertexCount, chunkTag)
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(visible), 1))
  return geo
}

function makeMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({ size: 2, vertexColors: true, sizeAttenuation: false })
}

/** 槽位 X 坐标（Float32Array 视图）。 */
function slotX(display: LodDisplay, slot: number): number {
  return (display.points.geometry.getAttribute('position').array as Float32Array)[slot * 3]
}

/** 源点 X 坐标（按顶点缓冲空间下标）。 */
function sourceX(geo: THREE.BufferGeometry, vertexIndex: number): number {
  return (geo.getAttribute('position').array as Float32Array)[vertexIndex * 3]
}

/**
 * 逐槽位断言：反查出来的 (chunk, vertex) 读到的源坐标 === 槽位里的坐标。
 * 断言只发一次（先收集不匹配的槽位）——预算级的用例要跑 50 万次，逐次 expect 会拖死测试。
 */
function expectSlotsMatchSource(display: LodDisplay, geometries: THREE.BufferGeometry[]): void {
  const resolver = readLodSlotResolver(display.points)
  expect(resolver).not.toBeNull()
  const bad: string[] = []
  for (let slot = 0; slot < display.filled; slot++) {
    const ref = resolver!(slot)
    if (!ref) {
      bad.push(`${slot}: 反查落空`)
    } else if (slotX(display, slot) !== sourceX(geometries[ref.chunkIndex], ref.vertexIndex)) {
      bad.push(`${slot}: ${slotX(display, slot)} ≠ ${sourceX(geometries[ref.chunkIndex], ref.vertexIndex)}`)
    }
    if (bad.length > 5) break
  }
  expect(bad).toEqual([])
}

/** 统计每个块分到的槽位数（按反查器算，与实现无关）。 */
function quotaByChunk(display: LodDisplay, chunkCount: number): number[] {
  const counts = new Array(chunkCount).fill(0)
  const resolver = readLodSlotResolver(display.points)!
  for (let slot = 0; slot < display.filled; slot++) {
    counts[resolver(slot)!.chunkIndex]++
  }
  return counts
}

/** 按显示层的位宽编一个打包 id（模拟 gather 的输出）。 */
function packFor(display: LodDisplay, chunk: number, vertexIndex: number): number {
  return lodPackId(chunk, vertexIndex, display.bufferShift)
}

/** 走一遍"树就绪"的填充路径：写入打包 id → 解码重填。 */
function refillFromIds(display: LodDisplay, ids: number[]): void {
  display.slotIds.set(ids, 0)
  fillLodFromIds(display, lodStagingAttributes(display), buildChunkViews(display.geometries), ids.length)
}

describe('LOD 显示层：等距取样填充（建树期间的兜底）', () => {
  it('可见点数为 0 时返回 null（没有可显示的内容）', () => {
    const empty = new THREE.BufferGeometry()
    empty.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    expect(createLodDisplay([empty], makeMaterial(), 1)).toBeNull()
  })

  it('总点数未超预算时全量取样（步长 1），顺序为块主序', () => {
    const chunks = [makeChunk(4, 0), makeChunk(3, 1)]
    const display = createLodDisplay(chunks, makeMaterial(), 7)!
    expect(display.filled).toBe(7)
    expect(quotaByChunk(display, 2)).toEqual([4, 3])
    // 块主序：前 4 个槽位来自块 0，接着 3 个来自块 1
    expect(Array.from({ length: 7 }, (_, s) => slotX(display, s))).toEqual([
      0, 1, 2, 3, // 块 0
      1e6 + 0, 1e6 + 1, 1e6 + 2, // 块 1
    ])
    expectSlotsMatchSource(display, chunks)
  })

  it('各块配额与规模成比例（不是先到先得）', () => {
    const chunks = [makeChunk(100_000, 0), makeChunk(100_000, 1), makeChunk(7, 2)]
    const display = createLodDisplay(chunks, makeMaterial(), 7)!
    expect(display.filled).toBe(200_007) // 未触预算上限 → 全量
    expect(quotaByChunk(display, 3)).toEqual([100_000, 100_000, 7])
    expectSlotsMatchSource(display, chunks)
  })

  it('超预算时大块被抽稀、极小的块仍拿到正比份额（不会整块消失）', () => {
    const chunks = [makeChunk(599_963, 0), makeChunk(37, 1)]
    const display = createLodDisplay(chunks, makeMaterial(), 7)!
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
    const quotas = quotaByChunk(display, 2)
    expect(quotas[0] + quotas[1]).toBe(LOD_FRAME_BUDGET)
    // 37 / 600000 × 524288 ≈ 32：与规模相称，既不是 0（被大块吃光）也不是 37（越额）
    expect(quotas[1]).toBeGreaterThanOrEqual(30)
    expect(quotas[1]).toBeLessThanOrEqual(37)
    expectSlotsMatchSource(display, chunks)
  })

  it('总点数超预算时被抽稀到恰好预算内（每帧成本与总点数解耦）', () => {
    // 80 万点 > 每帧预算，容量封顶 —— 这是"渲染成本与数据量解耦"的核心断言
    const chunks = [makeChunk(400_000, 0), makeChunk(400_000, 1)]
    const display = createLodDisplay(chunks, makeMaterial(), 3)!
    expect(display.capacity).toBe(LOD_FRAME_BUDGET)
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
    // 两块规模相同 → 配额各半（比例分配，不是先到先得）
    const quotas = quotaByChunk(display, 2)
    expect(Math.abs(quotas[0] - quotas[1])).toBeLessThanOrEqual(1)
    // 槽位不重不漏：每个槽位对应一个唯一的源顶点
    const resolver = readLodSlotResolver(display.points)!
    const seen = new Set<number>()
    let duplicates = 0
    for (let slot = 0; slot < display.filled; slot++) {
      const ref = resolver(slot)!
      const key = ref.chunkIndex * 1e7 + ref.vertexIndex
      if (seen.has(key)) duplicates++
      seen.add(key)
    }
    expect(duplicates).toBe(0)
    expect(seen.size).toBe(LOD_FRAME_BUDGET)
    expectSlotsMatchSource(display, chunks)
  })

  it('取样是确定性的：同样输入两次结果逐位相同', () => {
    const build = () => createLodDisplay([makeChunk(300_000, 0), makeChunk(300_000, 1)], makeMaterial(), 1)!
    const a = build()
    const b = build()
    expect(a.filled).toBe(b.filled)
    expect(Array.from(a.slotIds.subarray(0, a.filled))).toEqual(Array.from(b.slotIds.subarray(0, b.filled)))
    expect(Array.from(a.points.geometry.getAttribute('position').array as Float32Array)).toEqual(
      Array.from(b.points.geometry.getAttribute('position').array as Float32Array)
    )
  })

  it('兜底路径也写 slotIds（否则建树期间拾取全落空）', () => {
    const chunks = [makeChunk(300, 0), makeChunk(120, 1)]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    // 位宽由块数决定（2 块 → 1 位），与 native 的 PackedCodec::ForChunks 同式
    expect(display.bufferShift).toBe(31)
    expect(display.slotIds[0]).toBe(packFor(display, 0, 0))
    expect(display.slotIds[300]).toBe(packFor(display, 1, 0))
    expectSlotsMatchSource(display, chunks)
  })
})

describe('LOD 显示层：按打包 id 填充（树就绪后的主路径）', () => {
  it('按 id 解码到源坐标；跨块的分段各自读各自块的缓冲', () => {
    const chunks = [makeChunk(1000, 0), makeChunk(500, 1)]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    // 模拟一次 gather 的输出：块 0 取 3 个（非连续，模拟子树前缀）、块 1 取 2 个
    refillFromIds(display, [
      packFor(display, 0, 7),
      packFor(display, 0, 8),
      packFor(display, 0, 900),
      packFor(display, 1, 3),
      packFor(display, 1, 4),
    ])
    expect(display.filled).toBe(5)
    expect(display.points.geometry.drawRange.count).toBe(5)
    expect(Array.from({ length: 5 }, (_, s) => slotX(display, s))).toEqual([7, 8, 900, 1e6 + 3, 1e6 + 4])
    expectSlotsMatchSource(display, chunks)
  })

  it('重新填充会缩短画幅（filled 与 drawRange 一起跟着走）', () => {
    const chunks = [makeChunk(100, 0)]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    expect(display.filled).toBe(100)
    refillFromIds(display, [packFor(display, 0, 5), packFor(display, 0, 6)])
    expect(display.filled).toBe(2)
    expect(display.points.geometry.drawRange.count).toBe(2)
    // 槽位 2 之后的陈旧数据不能反查出来（resolver 按 filled 判过期）
    expect(readLodSlotResolver(display.points)!(2)).toBeNull()
  })

  it('颜色与分类按 id 指向的顶点现读（着色换装无需平行刷新逻辑）', () => {
    const chunks = [makeChunk(64, 0, 'float'), makeChunk(64, 1, 'u8')]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    refillFromIds(display, [packFor(display, 0, 3), packFor(display, 1, 9)])
    const colors = display.points.geometry.getAttribute('color').array as Float32Array
    expect(colors[0]).toBeCloseTo(3 / 1000, 6) // 块 0 的 Float32 线性色
    expect(colors[1]).toBeCloseTo(0.25, 6)
    expect(colors[3]).toBeCloseTo(10 / 255, 6) // 块 1 的 Uint8 normalized
    expect(colors[4]).toBeCloseTo(20 / 255, 6)
    const bytes = display.points.geometry.getAttribute('classification').array as Uint8Array
    expect(bytes[0]).toBe(3 % 256)
    expect(bytes[1]).toBe(9 % 256)

    // 语义层换装（rgb → 标量色）：同一条 id 序列重填一次即跟上
    const scalar = new Uint8Array(64 * 3).fill(51)
    chunks[0].setAttribute('color', new THREE.BufferAttribute(scalar, 3, true))
    refillFromIds(display, [packFor(display, 0, 3), packFor(display, 1, 9)])
    expect(colors[0]).toBeCloseTo(51 / 255, 6)
    expect(colors[1]).toBeCloseTo(51 / 255, 6)
  })

  it('带 index 的分割产物：id 里的顶点下标直接读缓冲（index 已在建树期解引用）', () => {
    const indexed = makeIndexedChunk(10, [2, 5, 7], 0)
    const display = createLodDisplay([indexed], makeMaterial(), 1)!
    // 建树期 native 已把 index 条目解引用成顶点缓冲下标（2 / 5 / 7）
    refillFromIds(display, [packFor(display, 0, 7), packFor(display, 0, 2)])
    expect(display.filled).toBe(2)
    expect(Array.from({ length: 2 }, (_, s) => slotX(display, s))).toEqual([7, 2])
    expectSlotsMatchSource(display, [indexed])
  })

  it('id 指向不存在的块时停在该处（防御坏 id 把循环带飞）', () => {
    const display = createLodDisplay([makeChunk(10, 0)], makeMaterial(), 1)!
    display.slotIds.set([packFor(display, 0, 1), packFor(display, 3, 0)], 0)
    fillLodFromIds(display, lodStagingAttributes(display), buildChunkViews(display.geometries), 2)
    expect(display.filled).toBe(1)
  })

  it('返回 0 时画幅归零（视锥外实体不该留下上一帧的点）', () => {
    const display = createLodDisplay([makeChunk(50, 0)], makeMaterial(), 1)!
    refillFromIds(display, [])
    expect(display.filled).toBe(0)
    expect(display.points.geometry.drawRange.count).toBe(0)
  })
})

describe('LOD 显示层：槽位反查（拾取桥）', () => {
  it('无 index 的原始块：每个槽位都能反查回坐标一致的源顶点', () => {
    const chunks = [makeChunk(300, 0), makeChunk(120, 1), makeChunk(7, 2)]
    const display = createLodDisplay(chunks, makeMaterial(), 42)!
    expectSlotsMatchSource(display, chunks)
  })

  it('带 index 的分割产物：兜底取样反查解引用 index 条目（不是缓冲下标）', () => {
    // 顶点缓冲 10 个，可见子集 = {2, 5, 7}（顶点 0/1/3/4/6/8/9 属于兄弟子集）
    const indexed = makeIndexedChunk(10, [2, 5, 7], 0)
    const plain = makeChunk(4, 1)
    const display = createLodDisplay([indexed, plain], makeMaterial(), 5)!
    expect(display.filled).toBe(7)
    const resolver = readLodSlotResolver(display.points)!
    const vertices = Array.from({ length: 7 }, (_, s) => resolver(s)!.vertexIndex)
    expect(vertices).toEqual([2, 5, 7, 0, 1, 2, 3])
    expectSlotsMatchSource(display, [indexed, plain])
  })

  it('槽位越界返回 null（宁可拾不到，不可拾错点）', () => {
    const display = createLodDisplay([makeChunk(10, 0)], makeMaterial(), 1)!
    const resolver = readLodSlotResolver(display.points)!
    expect(resolver(-1)).toBeNull()
    expect(resolver(display.filled)).toBeNull()
    expect(resolver(1.5)).toBeNull()
    expect(resolver(0)).toEqual({ chunkIndex: 0, vertexIndex: 0 })
  })

  it('staging 挂的是可识别的哨兵 tag 与反查器；分块 Points 没有反查器', () => {
    const display = createLodDisplay([makeChunk(10, 0)], makeMaterial(), 99)!
    expect(readPointsTag(display.points)).toEqual({ entityId: 99, chunkIndex: LOD_CHUNK_SENTINEL })
    expect(readLodSlotResolver(display.points)).not.toBeNull()
    const plain = new THREE.Points(makeChunk(10, 0), makeMaterial())
    expect(readLodSlotResolver(plain)).toBeNull()
  })

  it('显示层带上 entityId（建树队列按它取消/对账）', () => {
    expect(createLodDisplay([makeChunk(10, 0)], makeMaterial(), 12345)!.entityId).toBe(12345)
  })
})

describe('LOD 显示层：颜色与分类', () => {
  it('Float32 线性颜色原样拷贝到槽位', () => {
    const chunks = [makeChunk(50, 0, 'float')]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    const colors = display.points.geometry.getAttribute('color').array as Float32Array
    for (let slot = 0; slot < display.filled; slot++) {
      expect(colors[slot * 3]).toBeCloseTo(slot / 1000, 6)
      expect(colors[slot * 3 + 1]).toBe(0.25)
      expect(colors[slot * 3 + 2]).toBe(0.5)
    }
  })

  it('Uint8 normalized 颜色归一到 0..1（不按 0-255 直写）', () => {
    const chunks = [makeChunk(20, 0, 'u8')]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    const colors = display.points.geometry.getAttribute('color').array as Float32Array
    expect(colors[0]).toBeCloseTo(10 / 255, 6)
    expect(colors[1]).toBeCloseTo(20 / 255, 6)
    expect(colors[2]).toBeCloseTo(30 / 255, 6)
  })

  it('分类字节跟随槽位（按反查出的顶点读源分类）', () => {
    const chunks = [makeChunk(300, 0), makeChunk(120, 1)]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    const bytes = display.points.geometry.getAttribute('classification').array as Uint8Array
    const resolver = readLodSlotResolver(display.points)!
    for (let slot = 0; slot < display.filled; slot++) {
      const ref = resolver(slot)!
      const src = chunks[ref.chunkIndex].getAttribute('classification').array as Uint8Array
      expect(bytes[slot]).toBe(src[ref.vertexIndex])
    }
  })

  it('缺少颜色 attribute 的块写默认灰（0.7）', () => {
    const geo = makeChunk(5, 0)
    geo.deleteAttribute('color')
    const display = createLodDisplay([geo], makeMaterial(), 1)!
    const colors = display.points.geometry.getAttribute('color').array as Float32Array
    // 存在 Float32Array 里，0.7 只能近似表示
    expect(colors[0]).toBeCloseTo(0.7, 6)
    expect(colors[1]).toBeCloseTo(0.7, 6)
    expect(colors[2]).toBeCloseTo(0.7, 6)
  })

  it('空 index 的块（分割产物被 drawRange 排除）不贡献槽位', () => {
    const indexed = makeIndexedChunk(10, [0, 1, 2], 0)
    // 可见点数为 0：drawRange 起点推到最后
    indexed.setDrawRange(3, 0)
    const plain = makeChunk(4, 1)
    const display = createLodDisplay([indexed, plain], makeMaterial(), 1)!
    expect(display.filled).toBe(4)
    expect(quotaByChunk(display, 2)).toEqual([0, 4])
  })
})

describe('LOD 显示层：包围体与释放', () => {
  it('包围体取语义层全集（不只是采样集），且与源几何体不共享实例', () => {
    const chunks = [makeChunk(1000, 0), makeChunk(1000, 1)]
    // 造一个"采样不到的远端块"：它会被抽稀，但包围体必须覆盖它
    chunks.push(makeChunk(1, 2))
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    const box = display.points.geometry.boundingBox!
    expect(box.min.x).toBe(0)
    expect(box.max.x).toBe(2 * 1e6)
    expect(display.points.geometry.boundingSphere!.radius).toBeGreaterThan(0)
    // 源几何体的包围盒实例不能被改写（union 写进新 Box3）
    expect(chunks[0].boundingBox!.max.x).toBe(999)
    expect(box).not.toBe(chunks[0].boundingBox)
  })

  it('显示层参与视锥剔除（包围体已显式填好，不会退化成 O(N) 现算）', () => {
    const display = createLodDisplay([makeChunk(10, 0)], makeMaterial(), 1)!
    expect(display.points.frustumCulled).toBe(true)
    expect(display.points.geometry.boundingSphere).not.toBeNull()
  })

  it('disposeLodDisplay 把 staging 从父节点摘除，并断开树的引用', () => {
    const display = createLodDisplay([makeChunk(10, 0)], makeMaterial(), 1)!
    const parent = new THREE.Group()
    parent.add(display.points)
    display.tree = null
    disposeLodDisplay(display)
    expect(parent.children).toHaveLength(0)
    expect(display.tree).toBeNull()
  })

  it('fillLodFallback 可单独调用（建树失败后的重填路径）', () => {
    const chunks = [makeChunk(50, 0)]
    const display = createLodDisplay(chunks, makeMaterial(), 1)!
    refillFromIds(display, [packFor(display, 0, 1)])
    expect(display.filled).toBe(1)
    const filled = fillLodFallback(display, lodStagingAttributes(display), buildChunkViews(chunks), 10)
    expect(filled).toBe(10)
    expect(display.filled).toBe(10)
  })
})
