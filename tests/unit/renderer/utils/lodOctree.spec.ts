import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  lodChildNode,
  lodDecodeChunk,
  lodDecodeVertex,
  lodIsLeaf,
  lodNodeBoundingRadius,
} from '../../../../src/renderer/utils/lodOctree'
import type {
  LodOctreeAddon,
  LodOctreeChunkSource,
  LodOctreeEntityResult,
  LodOctreeRequest,
} from '../../../../src/renderer/utils/lodOctree'

// 树导航纯函数（node 环境即可）+ 契约冒烟测试直连编译产物（N-API 对 Node 与 Electron
// 通用）；产物缺失（CI 无编译链）时整组 skip，不挂测试（同 radiusFilter.spec 惯例）。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(new URL('../../../../native/lod-octree/build/Release/lod_octree.node', import.meta.url))
const nativeAvailable = existsSync(NATIVE_PATH)

// ---- 人造点云（确定性 PRNG：同一份数据在 CI 与本地得到同一棵树） ----

/** 确定性 xorshift32（避免 Math.random 让断言随运行变化）。 */
function makeRng(seed: number): () => number {
  let h = seed >>> 0
  return () => {
    h ^= h << 13
    h >>>= 0
    h ^= h >>> 17
    h ^= h << 5
    h >>>= 0
    return h / 4294967296
  }
}

/** 均匀随机块（各块覆盖同一空间 = 真实 LAS 分块形态，测试块主序不变量的最坏情形）。 */
function randomChunk(vertexCount: number, seed: number): LodOctreeChunkSource {
  const positions = new Float32Array(vertexCount * 3)
  const rng = makeRng(seed)
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = rng() * 100
    positions[i * 3 + 1] = rng() * 50
    positions[i * 3 + 2] = rng() * 20
  }
  return { positions, index: null }
}

/** 带 index 块：候选 = index 条目指向的顶点。 */
function indexedChunk(vertexCount: number, index: number[], seed: number): LodOctreeChunkSource {
  const chunk = randomChunk(vertexCount, seed)
  return { positions: chunk.positions, index: new Uint32Array(index) }
}

/** 打包 id → 坐标（测试内自行解码，与生产路径的反查链一致）。 */
function pointOf(chunks: LodOctreeChunkSource[], id: number, vertexShift: number): [number, number, number] {
  const c = lodDecodeChunk(id, vertexShift)
  const v = lodDecodeVertex(id, vertexShift)
  return [chunks[c].positions[v * 3], chunks[c].positions[v * 3 + 1], chunks[c].positions[v * 3 + 2]]
}

/** 候选总数（无 index = 全量顶点）。 */
function candidateTotal(chunks: LodOctreeChunkSource[]): number {
  return chunks.reduce((s, c) => s + (c.index ? c.index.length : c.positions.length / 3), 0)
}

/** 枚举节点的子节点下标（升序；与 C++ 的子节点紧密排列约定一致）。 */
function childrenOf(result: LodOctreeEntityResult, node: number): number[] {
  const out: number[] = []
  for (let k = 0; k < 8; k++) {
    const child = lodChildNode(result, node, k)
    if (child >= 0) out.push(child)
  }
  return out
}

describe('lodOctree 树导航纯函数', () => {
  /** 最小人造结果：根(0) 有卦限 5/7 两个子节点（下标 1、2）。 */
  function fakeResult(): LodOctreeEntityResult {
    return {
      entityId: 1,
      nodeCount: 3,
      pointCount: 0,
      chunkBits: 2,
      vertexShift: 30,
      bounds: new Float32Array(6),
      nodeChildBase: new Uint32Array([1, 0, 0]),
      nodeChildMask: new Uint8Array([0b1010_0000, 0, 0]),
      nodePointStart: new Uint32Array(3),
      nodePointCount: new Uint32Array(3),
      nodeCenter: new Float32Array(9),
      nodeSize: new Float32Array(3),
      nodeLevel: new Uint8Array(3),
      pointIds: new Uint32Array(0),
    }
  }

  it('打包 id 解码：块号与顶点下标（顶点缓冲空间）', () => {
    const shift = 30
    const id = (3 << shift) | 1234
    expect(lodDecodeChunk(id, shift)).toBe(3)
    expect(lodDecodeVertex(id, shift)).toBe(1234)
    expect(lodDecodeChunk(1234, shift)).toBe(0)
  })

  it('lodChildNode 按 popcount 定位：存在返回下标，不存在返回 -1', () => {
    const r = fakeResult()
    expect(lodChildNode(r, 0, 5)).toBe(1) // 第一个置位的卦限 → 基址 + 0
    expect(lodChildNode(r, 0, 7)).toBe(2) // 之前 1 个置位 → 基址 + 1
    expect(lodChildNode(r, 0, 0)).toBe(-1)
    expect(lodChildNode(r, 0, 4)).toBe(-1)
    expect(lodIsLeaf(r, 0)).toBe(false)
    expect(lodIsLeaf(r, 1)).toBe(true)
    expect(childrenOf(r, 0)).toEqual([1, 2])
    expect(childrenOf(r, 1)).toEqual([])
  })

  it('lodNodeBoundingRadius = 边长 × √3/2（外接球，保守剔除）', () => {
    expect(lodNodeBoundingRadius(2)).toBeCloseTo(Math.sqrt(3), 12)
  })
})

describe.skipIf(!nativeAvailable)('lod_octree.node 契约冒烟（native 产物存在时）', () => {
  const require = createRequire(import.meta.url)
  const addon = require(NATIVE_PATH) as LodOctreeAddon

  /** promise 化 addon.compute（compute 同步抛错一并收敛）。 */
  function computeNative(request: LodOctreeRequest): Promise<LodOctreeEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.compute(
          request,
          () => {},
          (err, results) => {
            if (err) reject(err)
            else resolve(results ?? [])
          }
        )
      } catch (e) {
        reject(e)
      }
    })
  }

  it('多块交错 + 带 index 块：节点区间划分、叶子覆盖与立方体归属全部自洽', async () => {
    const chunks = [
      randomChunk(4096, 1),
      randomChunk(4096, 2),
      indexedChunk(100, [5, 7, 9, 11, 13], 3),
      { positions: new Float32Array(0), index: null }, // 空块：应被安全跳过
    ]
    const expected = candidateTotal(chunks)
    const results = await computeNative({
      maxPointsPerCell: 64,
      maxLevel: 8,
      entities: [{ entityId: 7, chunks }],
    })
    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.entityId).toBe(7)
    expect(r.pointCount).toBe(expected)
    expect(r.pointIds).toHaveLength(expected)
    expect(r.nodeCount).toBeGreaterThan(1)
    // 节点数组等长
    for (const arr of [r.nodeChildBase, r.nodeChildMask, r.nodePointStart, r.nodePointCount, r.nodeLevel]) {
      expect(arr).toHaveLength(r.nodeCount)
    }
    expect(r.nodeCenter).toHaveLength(r.nodeCount * 3)
    expect(r.nodeSize).toHaveLength(r.nodeCount)
    expect(r.chunkBits).toBeGreaterThanOrEqual(1)
    expect(r.chunkBits + r.vertexShift).toBe(32)

    // 1) 根的区间 = 全部点；子节点的区间恰好首尾相接地划分父区间
    expect(r.nodePointStart[0]).toBe(0)
    expect(r.nodePointCount[0]).toBe(expected)
    for (let n = 0; n < r.nodeCount; n++) {
      const kids = childrenOf(r, n)
      if (kids.length === 0) continue
      let cursor = r.nodePointStart[n]
      let sum = 0
      for (const k of kids) {
        expect(r.nodePointStart[k]).toBe(cursor)
        expect(r.nodeLevel[k]).toBe(r.nodeLevel[n] + 1)
        cursor += r.nodePointCount[k]
        sum += r.nodePointCount[k]
      }
      expect(cursor).toBe(r.nodePointStart[n] + r.nodePointCount[n])
      expect(sum).toBe(r.nodePointCount[n])
      // 子节点连续排列：首个置位卦限的子节点即 nodeChildBase
      expect(r.nodeChildBase[n]).toBe(kids[0])
    }

    // 2) 叶子覆盖：每个点恰好出现一次，且都落在自己的节点立方体内
    const seen = new Set<number>()
    let leafTotal = 0
    for (let n = 0; n < r.nodeCount; n++) {
      if (!lodIsLeaf(r, n)) continue
      expect(r.nodePointCount[n]).toBeLessThanOrEqual(64) // 正常数据不应触顶
      const cx = r.nodeCenter[n * 3]
      const cy = r.nodeCenter[n * 3 + 1]
      const cz = r.nodeCenter[n * 3 + 2]
      const half = r.nodeSize[n] / 2
      for (let i = 0; i < r.nodePointCount[n]; i++) {
        const id = r.pointIds[r.nodePointStart[n] + i]
        const chunk = lodDecodeChunk(id, r.vertexShift)
        expect(chunk).toBeLessThan(chunks.length)
        expect(seen.has(id)).toBe(false)
        seen.add(id)
        leafTotal++
        // 立方体归属（留 0.1% 容差吸收 float32 中心/边长的舍入）
        const [x, y, z] = pointOf(chunks, id, r.vertexShift)
        expect(Math.abs(x - cx)).toBeLessThanOrEqual(half * 1.001)
        expect(Math.abs(y - cy)).toBeLessThanOrEqual(half * 1.001)
        expect(Math.abs(z - cz)).toBeLessThanOrEqual(half * 1.001)
      }
    }
    expect(leafTotal).toBe(expected)
    expect(seen.size).toBe(expected)

    // 3) **叶子**的区间是块主序的（gather 按段切缓冲的前提）：每块最多一段，
    //    段数 ≤ 该叶子覆盖的块数。内部节点不保证（见 lod_octree.h）。
    let maxSegments = 0
    for (let n = 0; n < r.nodeCount; n++) {
      if (!lodIsLeaf(r, n)) continue
      let prev = -1
      let segments = 0
      const encountered = new Set<number>()
      for (let i = 0; i < r.nodePointCount[n]; i++) {
        const chunk = lodDecodeChunk(r.pointIds[r.nodePointStart[n] + i], r.vertexShift)
        if (chunk === prev) continue
        expect(encountered.has(chunk)).toBe(false) // 同一块在叶子里出现两段 = 违反不变量
        encountered.add(chunk)
        prev = chunk
        segments++
      }
      maxSegments = Math.max(maxSegments, segments)
    }
    expect(maxSegments).toBeLessThanOrEqual(chunks.length)
  })

  it('带 index 块只收录 index 条目；越界条目与非有限坐标被丢弃', async () => {
    // 顶点 0..9；index 里混入越界项 99（丢弃）与顶点 2（坐标为 NaN，建树期剔除）
    const positions = new Float32Array(30)
    for (let i = 0; i < 10; i++) {
      positions[i * 3] = i
      positions[i * 3 + 1] = i * 2
      positions[i * 3 + 2] = i * 3
    }
    positions[2 * 3] = Number.NaN
    const index = new Uint32Array([0, 1, 2, 3, 99, 4])
    const results = await computeNative({ entities: [{ entityId: 1, chunks: [{ positions, index }] }] })
    const r = results[0]
    expect(r.pointCount).toBe(4) // 0,1,3,4（2 = NaN 剔除，99 = 越界剔除）
    const vertices = new Set<number>()
    for (const id of r.pointIds) vertices.add(lodDecodeVertex(id, r.vertexShift))
    expect([...vertices].sort((a, b) => a - b)).toEqual([0, 1, 3, 4])
    // 包围盒不掺入被剔除的点
    expect(r.bounds[0]).toBeCloseTo(0, 5)
    expect(r.bounds[3]).toBeCloseTo(4, 5)
  })

  it('空实体与「阈值大于点数」：nodeCount 0 / 根即叶子', async () => {
    const empty = await computeNative({ entities: [{ entityId: 1, chunks: [{ positions: new Float32Array(0), index: null }] }] })
    expect(empty[0].nodeCount).toBe(0)
    expect(empty[0].pointCount).toBe(0)

    const small = await computeNative({
      maxPointsPerCell: 1024,
      entities: [{ entityId: 2, chunks: [randomChunk(50, 9)] }],
    })
    expect(small[0].nodeCount).toBe(1) // 点数 ≤ 阈值 → 根即叶子
    expect(lodIsLeaf(small[0], 0)).toBe(true)
    expect(small[0].pointCount).toBe(50)
  })

  it('共点云（坐标全部重合）不失控：停在 maxLevel 或节点预算', async () => {
    const positions = new Float32Array(3000 * 3) // 全 0 坐标（3000 个共点）
    const t0 = Date.now()
    const results = await computeNative({
      maxPointsPerCell: 64,
      maxLevel: 4,
      entities: [{ entityId: 1, chunks: [{ positions, index: null }] }],
    })
    const r = results[0]
    expect(Date.now() - t0).toBeLessThan(5000) // 不炸节点表（共点是风险 8 的退化输入）
    expect(r.pointCount).toBe(3000)
    expect(r.nodeCount).toBeLessThanOrEqual(5) // maxLevel 4 → 至多单链 5 个节点
    expect(r.nodeLevel[r.nodeCount - 1]).toBe(4)
  })

  it('cancel 中止在飞建树并走错误回调', async () => {
    const pending = new Promise<Error | null>((resolve) => {
      addon.compute({ entities: [{ entityId: 1, chunks: [randomChunk(400_000, 11)] }] }, () => {}, (err) => resolve(err))
    })
    addon.cancel() // compute 返回后同步取消：算法在层循环起点的检查必然可见
    const err = await pending
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/取消/)
  })
})
