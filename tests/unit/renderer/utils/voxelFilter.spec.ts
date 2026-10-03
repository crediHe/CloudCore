import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { candidateCountOfChunk } from '../../../../src/renderer/utils/radiusFilter'
import { voxelFilterBruteForce } from '../../../../src/renderer/utils/voxelFilter'
import type {
  VoxelFilterAddon,
  VoxelFilterChunkSource,
  VoxelFilterEntitySource,
  VoxelFilterRequest,
} from '../../../../src/renderer/utils/voxelFilter'

// 纯算法（暴力参考）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/voxel-filter/build/Release/voxel_filter.node', import.meta.url)
)
const require = createRequire(import.meta.url)

/** 加载 native 产物（仅 nativeAvailable 时调用）。 */
function loadAddon(): VoxelFilterAddon {
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
): VoxelFilterChunkSource[] {
  const total = positions.length / 3
  const chunks: VoxelFilterChunkSource[] = []
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

describe('voxelFilterBruteForce（暴力参考：语义镜像 C++）', () => {
  it('边界分支：leafSize <= 0 全部保留（保序全量）', () => {
    const chunks = makeChunks(randomCloud(mulberry32(1), 30), 12, mulberry32(2), false)
    const all = voxelFilterBruteForce(chunks, 0)
    chunks.forEach((c, i) => {
      const n = candidateCountOfChunk(c)
      expect(all[i]).toHaveLength(n)
      expect(Array.from(all[i])).toEqual(Array.from({ length: n }, (_, v) => v))
    })
  })

  it('手工 6 点两格：每格保留距重心最近的点（期望 [0, 3]）', () => {
    // 与 e2e（native-voxel-filter.spec.ts）同一组数据：
    // leaf=4 时 v0/v1/v2 同格（重心 (1, 0.3, 0)，最近 v0：d²=1.09 < v2 1.36 < v1 4.09），
    // v3/v4/v5 同格（重心 (5.5, 0.2667, 0)，最近 v3：d²≈0.321 < v5≈0.534 < v4≈1.071）
    const positions = new Float32Array([
      0,
      0,
      0, // 顶点 0 → 保留
      3,
      0,
      0, // 顶点 1
      0,
      0.9,
      0, // 顶点 2
      5,
      0,
      0, // 顶点 3 → 保留
      6.5,
      0,
      0, // 顶点 4
      5,
      0.8,
      0, // 顶点 5
    ])
    const kept = voxelFilterBruteForce([{ positions, index: null }], 4)
    expect(Array.from(kept[0])).toEqual([0, 3])
  })

  it('平局规则：两点对称于重心时保留遍历序先者（候选更小）', () => {
    // 单格两点 (0,0,0) / (2,0,0)，重心 (1,0,0)，距离并列 → 保留顶点 0
    const positions = new Float32Array([0, 0, 0, 2, 0, 0])
    const kept = voxelFilterBruteForce([{ positions, index: null }], 4)
    expect(Array.from(kept[0])).toEqual([0])
  })

  it('候选 = index 条目：非候选顶点永不进入结果（顶点缓冲空间语义）', () => {
    const positions = new Float32Array([
      100,
      100,
      100, // 顶点 0：非候选（即便离候选很远也不参与）
      0,
      0,
      0, // 顶点 1：候选（与顶点 2 同格且对称 → 保留，序先）
      2,
      0,
      0, // 顶点 2：候选（平局落选）
      100,
      0,
      100, // 顶点 3：非候选
    ])
    const chunks = [{ positions, index: new Uint32Array([1, 2]) }]
    const kept = voxelFilterBruteForce(chunks, 4)
    expect(Array.from(kept[0])).toEqual([1])
  })

  it('跨块体素：同格点分属两块，代表点落在它所属块的 kept 里', () => {
    // 块 0 顶点 (0,0,0)；块 1 顶点 (2,0,0)。leaf=4 同格，重心 (1,0,0) 平局取先 = 块 0
    const chunks: VoxelFilterChunkSource[] = [
      { positions: new Float32Array([0, 0, 0]), index: null },
      { positions: new Float32Array([2, 0, 0]), index: null },
    ]
    const kept = voxelFilterBruteForce(chunks, 4)
    expect(kept).toHaveLength(2)
    expect(Array.from(kept[0])).toEqual([0])
    expect(Array.from(kept[1])).toEqual([])
  })

  it('体素巨大：跨块全云同一格时全局仅 1 个代表点', () => {
    // 显式点集（不依赖 randomCloud/makeChunks 的坐标量级假设）：
    // 三点分属三块，间距 << leafSize → 全云只占 1 个格
    const chunks: VoxelFilterChunkSource[] = [
      { positions: new Float32Array([0, 0, 0]), index: null },
      { positions: new Float32Array([2, 0, 0]), index: null },
      { positions: new Float32Array([5, 0, 0]), index: null },
    ]
    const kept = voxelFilterBruteForce(chunks, 1e6)
    expect(kept).toHaveLength(chunks.length)
    const total = kept.reduce((s, a) => s + a.length, 0)
    expect(total).toBe(1) // 三块同格：全局只保留 1 个代表点（跨块去重语义）
  })

  it('多块随机点集：kept 均严格递增且与候选一致（输出契约自检）', () => {
    const rnd = mulberry32(5)
    const positions = randomCloud(rnd, 500)
    const chunks = makeChunks(positions, 120, rnd, true)
    const kept = voxelFilterBruteForce(chunks, 1.2)
    chunks.forEach((c, i) => {
      const arr = kept[i]
      for (let j = 1; j < arr.length; j++) {
        expect(arr[j]).toBeGreaterThan(arr[j - 1])
      }
      // kept 必为候选子集：逐个在候选（或全量 0..n-1）里存在
      const universe = c.index ? c.index : null
      for (const v of arr) {
        if (universe) expect(universe.includes(v)).toBe(true)
        else expect(v).toBeLessThan(c.positions.length / 3)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// C++ 正确性对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------
const nativeAvailable = existsSync(NATIVE_PATH)

describe.skipIf(!nativeAvailable)('voxel_filter.node 与 JS 暴力参考一致性', () => {
  let addon: VoxelFilterAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 compute。 */
  function computeNative(req: VoxelFilterRequest): Promise<Map<number, Uint32Array[]>> {
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
    const cases: { seed: number; n: number; chunkSize: number; useIndex: boolean; leaf: number }[] = [
      { seed: 7, n: 1500, chunkSize: 600, useIndex: false, leaf: 1.2 }, // 中等降采样
      { seed: 8, n: 2000, chunkSize: 800, useIndex: true, leaf: 0.8 },
      { seed: 9, n: 900, chunkSize: 500, useIndex: true, leaf: 2.0 }, // 大格少体素
      { seed: 10, n: 1200, chunkSize: 1200, useIndex: false, leaf: 0.5 }, // 单块
      { seed: 11, n: 1000, chunkSize: 300, useIndex: false, leaf: 1e6 }, // 全云单体素 → 每块 ≤1 点
      { seed: 12, n: 800, chunkSize: 400, useIndex: true, leaf: 1e-9 }, // 极细格 → 几乎全保留
    ]
    for (const c of cases) {
      const rnd = mulberry32(c.seed)
      const positions = randomCloud(rnd, c.n)
      const chunks = makeChunks(positions, c.chunkSize, rnd, c.useIndex)
      const entity: VoxelFilterEntitySource = { entityId: c.seed, chunks }
      const nativeMap = await computeNative({ leafSize: c.leaf, entities: [entity] })
      const jsKept = voxelFilterBruteForce(chunks, c.leaf)
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

  it('多实体一次 compute：跨实体互不干扰（体素只在实体内划分）', async () => {
    const rnd = mulberry32(21)
    const dense = randomCloud(rnd, 600)
    const sparse = randomCloud(rnd, 600, 1000) // 拉大散布 → 每点几乎独占一格
    const entities: VoxelFilterEntitySource[] = [
      { entityId: 1, chunks: [{ positions: dense, index: null }] },
      { entityId: 2, chunks: [{ positions: sparse, index: null }] },
    ]
    const nativeMap = await computeNative({ leafSize: 1.5, entities })
    const kept1 = nativeMap.get(1)![0].length
    const kept2 = nativeMap.get(2)![0].length
    // 密集点云显著降采样（10³ 体积 / 1.5³ 格 ≈ 296 格、600 点 → 期望占用约 257 格）；
    // 稀疏点云几乎每点独占一格（碰撞概率 < 0.1%）。数量级断言，具体值由 JS 参考兜底
    expect(kept1).toBeGreaterThan(200)
    expect(kept1).toBeLessThan(400)
    expect(kept2).toBeGreaterThan(590)
    const js1 = voxelFilterBruteForce(entities[0].chunks, 1.5)[0]
    const js2 = voxelFilterBruteForce(entities[1].chunks, 1.5)[0]
    expect(Array.from(nativeMap.get(1)![0])).toEqual(Array.from(js1))
    expect(Array.from(nativeMap.get(2)![0])).toEqual(Array.from(js2))
  })
})
