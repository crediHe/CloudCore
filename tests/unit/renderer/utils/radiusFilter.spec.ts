import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  candidateCountOfChunk,
  splitKeptRemoved,
  radiusFilterBruteForce,
  estimateMeanPointSpacing,
} from '../../../../src/renderer/utils/radiusFilter'
import type {
  RadiusFilterAddon,
  RadiusFilterChunkSource,
  RadiusFilterEntitySource,
  RadiusFilterRequest,
} from '../../../../src/renderer/utils/radiusFilter'

// 纯算法（后处理 / 暴力参考 / 点距估算）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/radius-filter/build/Release/radius_filter.node', import.meta.url)
)
const require = createRequire(import.meta.url)

/** 加载 native 产物（仅 nativeAvailable 时调用）。 */
function loadAddon(): RadiusFilterAddon {
  return require(NATIVE_PATH)
}

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 在单位立方体内生成 n 个随机点坐标（摊开成 Float32Array）。 */
function randomCloud(rand: () => number, n: number, extent = 10): Float32Array {
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = (rand() - 0.5) * extent
    arr[i * 3 + 1] = (rand() - 0.5) * extent
    arr[i * 3 + 2] = (rand() - 0.5) * extent
  }
  return arr
}

/** 把全长点数组切进 chunks，可选地对每块再挑一个"候选子集 index"（模拟分割产物）。 */
function makeChunks(
  positions: Float32Array,
  chunkSize: number,
  rand: () => number,
  useIndex: boolean
): RadiusFilterChunkSource[] {
  const total = positions.length / 3
  const chunks: RadiusFilterChunkSource[] = []
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(total, start + chunkSize)
    const count = end - start
    const slice = positions.slice(start * 3, end * 3)
    let index: Uint32Array | null = null
    if (useIndex) {
      // 候选子集：每点 80% 概率进入；值 = 块内顶点下标（0..count-1，递增）
      // —— 与分割产物 index 语义一致：index 条目指向本块共享缓冲的顶点
      const picks: number[] = []
      for (let i = 0; i < count; i++) {
        if (rand() < 0.8) picks.push(i)
      }
      index = new Uint32Array(picks)
    }
    chunks.push({ positions: slice, index })
  }
  return chunks
}

describe('splitKeptRemoved（kept → removed 补集 + 两侧包围盒）', () => {
  // 6 个点：坐标刻意不连续，便于核对包围盒
  const POS = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])

  it('无 index（候选 = 全量顶点）：kept 子集 → removed 为补集，两侧包围盒正确', () => {
    const kept = new Uint32Array([0, 3, 5]) // 顶点 0/3/5 保留
    const { removed, keptBBox, removedBBox } = splitKeptRemoved(POS, null, kept)
    expect(Array.from(removed)).toEqual([1, 2, 4])
    // 保留侧 = 顶点 0(1,2,3)、3(10,11,12)、5(16,17,18)
    expect(keptBBox).toEqual({ minX: 1, minY: 2, minZ: 3, maxX: 16, maxY: 17, maxZ: 18 })
    // 剔除侧 = 顶点 1(4,5,6)、2(7,8,9)、4(13,14,15)
    expect(removedBBox).toEqual({ minX: 4, minY: 5, minZ: 6, maxX: 13, maxY: 14, maxZ: 15 })
  })

  it('带 index（候选 = 条目子集）：removed 输出顶点缓冲空间下标，非条目序号', () => {
    const candidates = new Uint32Array([1, 3, 5]) // 分割产物只含顶点 1/3/5
    const kept = new Uint32Array([3]) // C++ 判 3 保留
    const { removed } = splitKeptRemoved(POS, candidates, kept)
    // 候选 {1,3,5} − kept {3} = {1,5}（顶点空间，与候选值一致而不是 {0,2}）
    expect(Array.from(removed)).toEqual([1, 5])
  })

  it('kept 为空：removed = 全部候选，kept 侧包围盒全 0', () => {
    const { removed, keptBBox } = splitKeptRemoved(POS, null, new Uint32Array(0))
    expect(removed).toHaveLength(6)
    expect(Array.from(removed)).toEqual([0, 1, 2, 3, 4, 5])
    expect(keptBBox).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 })
  })

  it('kept = 全部候选：removed 为空，removed 侧包围盒全 0', () => {
    const kept = new Uint32Array([0, 1, 2, 3, 4, 5])
    const { removed, removedBBox, keptBBox } = splitKeptRemoved(POS, null, kept)
    expect(removed).toHaveLength(0)
    expect(removedBBox).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 })
    expect(keptBBox).toEqual({ minX: 1, minY: 2, minZ: 3, maxX: 16, maxY: 17, maxZ: 18 })
  })

  it('契约防御：kept 含候选集外顶点时抛错', () => {
    const candidates = new Uint32Array([2, 4])
    const kept = new Uint32Array([0]) // 0 不在候选 {2,4}
    expect(() => splitKeptRemoved(POS, candidates, kept)).toThrow(/不在候选集/)
  })

  it('契约防御：kept 数量超过候选总数时抛错', () => {
    const kept = new Uint32Array([0, 1, 2, 3])
    expect(() => splitKeptRemoved(POS, new Uint32Array([0, 1]), kept)).toThrow(/超过候选总数/)
  })
})

describe('estimateMeanPointSpacing（平均点距粗估）', () => {
  it('立方体分布：返回体积密度间距 cbrt(V/N)', () => {
    // 100³ 米内 1e6 点 → 网格距 1
    expect(estimateMeanPointSpacing(1_000_000, { x: 100, y: 100, z: 100 })).toBeCloseTo(1, 6)
  })

  it('薄板分布：厚度小于间距时退化为面密度 sqrt(A/N)', () => {
    // 1000×800×0.001 平板，1e7 点 → sqrt(8e5/1e7) ≈ 0.2828
    const s = estimateMeanPointSpacing(10_000_000, { x: 1000, y: 800, z: 0.001 })
    expect(s).toBeCloseTo(Math.sqrt((1000 * 800) / 10_000_000), 6)
  })

  it('线状分布：进一步退化为线密度 L/N', () => {
    const s = estimateMeanPointSpacing(1000, { x: 100, y: 0, z: 0 })
    expect(s).toBeCloseTo(0.1, 6)
  })

  it('退化输入：各轴延伸为 0 或点数不足时返回 1（保证默认半径非 0）', () => {
    expect(estimateMeanPointSpacing(1000, { x: 0, y: 0, z: 0 })).toBe(1)
    expect(estimateMeanPointSpacing(1, { x: 10, y: 10, z: 10 })).toBe(1)
    expect(estimateMeanPointSpacing(0, { x: 10, y: 10, z: 10 })).toBe(1)
  })
})

describe('radiusFilterBruteForce（暴力参考：语义镜像 C++）', () => {
  it('边界分支：radius <= 0 全剔除；minNeighbors == 0 全保留（保序全量）', () => {
    const chunks = makeChunks(randomCloud(mulberry32(1), 30), 12, mulberry32(2), false)
    expect(radiusFilterBruteForce(chunks, 0, 2).every((k) => k.length === 0)).toBe(true)
    const all = radiusFilterBruteForce(chunks, 1, 0)
    chunks.forEach((c, i) => {
      const n = candidateCountOfChunk(c)
      expect(all[i]).toHaveLength(n)
      expect(Array.from(all[i])).toEqual(Array.from({ length: n }, (_, v) => v))
    })
  })

  it('与 C++ 实现等价：剔除半径内邻居不足的点（随机点集小样本手工核对）', () => {
    // 手工构造：3 个聚簇点（互为邻居）+ 1 个孤点
    const positions = new Float32Array([
      0,
      0,
      0, //
      1,
      0,
      0, //
      0,
      1,
      0, //
      50,
      50,
      50, // 孤立点
    ])
    const kept = radiusFilterBruteForce([{ positions, index: null }], 1.5, 2)
    expect(Array.from(kept[0])).toEqual([0, 1, 2]) // 孤点（顶点 3）被剔除
  })
})

// ---------------------------------------------------------------------------
// C++ 正确性对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------
const nativeAvailable = existsSync(NATIVE_PATH)

describe.skipIf(!nativeAvailable)('radius_filter.node 与 JS 暴力参考一致性', () => {
  let addon: RadiusFilterAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 compute。 */
  function computeNative(req: RadiusFilterRequest): Promise<Map<number, Uint32Array[]>> {
    return new Promise((resolve, reject) => {
      try {
        addon.compute(req, (err, results) => {
          if (err) reject(err)
          else {
            const map = new Map<number, Uint32Array[]>()
            for (const r of results ?? []) map.set(r.entityId, r.kept)
            resolve(map)
          }
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  it('多轮随机点集（含带 index 的分割产物块）逐块 kept 与暴力参考一致', async () => {
    const cases: { seed: number; n: number; chunkSize: number; useIndex: boolean; radius: number; min: number }[] = [
      { seed: 7, n: 1500, chunkSize: 600, useIndex: false, radius: 1.2, min: 3 },
      { seed: 8, n: 2000, chunkSize: 800, useIndex: true, radius: 0.8, min: 4 },
      { seed: 9, n: 900, chunkSize: 500, useIndex: true, radius: 2.0, min: 2 },
      { seed: 10, n: 1200, chunkSize: 1200, useIndex: false, radius: 0.5, min: 6 }, // 单块
      { seed: 11, n: 1000, chunkSize: 300, useIndex: false, radius: 1000, min: 3 }, // 全保留量级
      { seed: 12, n: 800, chunkSize: 400, useIndex: true, radius: 1e-6, min: 3 }, // 全剔除量级
    ]
    for (const c of cases) {
      const rnd = mulberry32(c.seed)
      const positions = randomCloud(rnd, c.n)
      const chunks = makeChunks(positions, c.chunkSize, rnd, c.useIndex)
      const entity: RadiusFilterEntitySource = { entityId: c.seed, chunks }
      const [nativeMap, jsKept] = await Promise.all([
        computeNative({ radius: c.radius, minNeighbors: c.min, entities: [entity] }),
        Promise.resolve(radiusFilterBruteForce(chunks, c.radius, c.min)),
      ])
      const cppKept = nativeMap.get(c.seed)
      expect(cppKept).toBeDefined()
      expect(cppKept).toHaveLength(chunks.length)
      // 逐块元素级一致（kept 均为顶点下标、递增）
      for (let i = 0; i < chunks.length; i++) {
        expect(Array.from(cppKept![i])).toEqual(Array.from(jsKept[i]))
      }
      // 递增序自检（与算法注释声明的输出契约一致）
      for (const arr of cppKept!) {
        for (let i = 1; i < arr.length; i++) {
          expect(arr[i]).toBeGreaterThan(arr[i - 1])
        }
      }
    }
  })

  it('多实体一次 compute：跨实体互不干扰（邻居只在实体内计数）', async () => {
    const rnd = mulberry32(21)
    const dense = randomCloud(rnd, 600)
    const sparse = randomCloud(rnd, 600, 1000) // 拉大散布 → 邻居稀少
    const entities: RadiusFilterEntitySource[] = [
      { entityId: 1, chunks: [{ positions: dense, index: null }] },
      { entityId: 2, chunks: [{ positions: sparse, index: null }] },
    ]
    const nativeMap = await computeNative({ radius: 1.5, minNeighbors: 4, entities })
    const kept1 = nativeMap.get(1)![0].length
    const kept2 = nativeMap.get(2)![0].length
    // 密集中几乎全留、稀疏集中几乎全剔（数量级断言，具体值由 JS 参考兜底）
    expect(kept1).toBeGreaterThan(500)
    expect(kept2).toBeLessThan(50)
    const js1 = radiusFilterBruteForce(entities[0].chunks, 1.5, 4)[0]
    const js2 = radiusFilterBruteForce(entities[1].chunks, 1.5, 4)[0]
    expect(Array.from(nativeMap.get(1)![0])).toEqual(Array.from(js1))
    expect(Array.from(nativeMap.get(2)![0])).toEqual(Array.from(js2))
  })
})
