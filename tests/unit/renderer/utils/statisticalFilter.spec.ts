import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { candidateCountOfChunk, sorFilterBruteForce } from '../../../../src/renderer/utils/statisticalFilter'
import type {
  SorFilterAddon,
  SorFilterChunkSource,
  SorFilterRequest,
} from '../../../../src/renderer/utils/statisticalFilter'

// 纯算法（暴力参考）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/statistical-filter/build/Release/statistical_filter.node', import.meta.url)
)
const require = createRequire(import.meta.url)

/** 加载 native 产物（仅 nativeAvailable 时调用）。 */
function loadAddon(): SorFilterAddon {
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
): SorFilterChunkSource[] {
  const total = positions.length / 3
  const chunks: SorFilterChunkSource[] = []
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

/** 边长为 1 的正四面体 4 点（任两点距离 = 1，精确手算基础）。 */
function tetrahedron(): [number, number, number][] {
  return [
    [0, 0, 0],
    [1, 0, 0],
    [0.5, Math.sqrt(3) / 2, 0],
    [0.5, Math.sqrt(3) / 6, Math.sqrt(2 / 3)],
  ]
}

describe('sorFilterBruteForce（暴力参考：语义镜像 C++）', () => {
  it('边界分支：neighbors == 0 全部保留（保序全量）', () => {
    const chunks = makeChunks(randomCloud(mulberry32(1), 30), 12, mulberry32(2), false)
    const all = sorFilterBruteForce(chunks, 0, 1)
    chunks.forEach((c, i) => {
      const n = candidateCountOfChunk(c)
      expect(all[i]).toHaveLength(n)
      expect(Array.from(all[i])).toEqual(Array.from({ length: n }, (_, v) => v))
    })
  })

  it('游离孤点剔除、紧凑主体保留（随机点集手工核对）', () => {
    // 手工构造：三角形 3 点（两两距 1）+ 1 个绝对孤点（距任意点 > 80）
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
      100,
      100,
      100, // 孤立点
    ])
    const kept = sorFilterBruteForce([{ positions, index: null }], 2, 1)
    expect(Array.from(kept[0])).toEqual([0, 1, 2]) // 孤点（顶点 3）被剔除
  })

  it('K 超过邻居数：按实际邻居数平均，不因凑不满 K 而误剔（四面体全保留）', () => {
    // 四面体 4 点互为邻居（距 ≈1）；K=10 > 3 → 每点按实际 3 邻居平均。各点 avg 近乎相等
    //（仅 float32 坐标舍入引入 ~1e-7 微扰），λ 取 10 使阈值宽于微扰幅度 → 全保留；
    // 若"邻居不足 K"按剔除处理（错误语义），4 点应全部被剔——本断言区分该语义
    const positions = new Float32Array(tetrahedron().flat())
    const kept = sorFilterBruteForce([{ positions, index: null }], 10, 10)
    expect(Array.from(kept[0])).toEqual([0, 1, 2, 3])
  })

  it('单点云：无邻居平均 0（μ = σ = 0），保留', () => {
    const positions = new Float32Array([3, 4, 5])
    const kept = sorFilterBruteForce([{ positions, index: null }], 5, 1)
    expect(Array.from(kept[0])).toEqual([0])
  })

  it('稀疏但致密的独立群不被剔除（统计离群按分布判，非按绝对稀疏判）', () => {
    // 主体：间距 1 的 4×4×4 栅格（64 点，内部点最近邻平均 ≥ 1）
    // 稀疏有效群：距主体 > 8 的四面体（4 点，群内两两距 1，avg = 1 为全局最小值）
    // 孤立噪点：距所有点 > 40
    // K=3（群内邻居足够）：四面体点 avg = 1 ≤ μ ≤ 阈值 → 必保留；噪点 avg ≈ 40+ 必剔除
    const pts: [number, number, number][] = []
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        for (let z = 0; z < 4; z++) pts.push([x, y, z])
      }
    }
    for (const p of tetrahedron()) pts.push([p[0] + 50, p[1] + 50, p[2] + 50]) // 稀疏致密群
    pts.push([200, 200, 200]) // 绝对孤立噪点
    const positions = new Float32Array(pts.flat())
    const kept = sorFilterBruteForce([{ positions, index: null }], 3, 1)
    const keptArr = Array.from(kept[0])
    // 剔除的只可能是孤立噪点（顶点 68），四面体与栅格主体全部保留
    expect(keptArr).toHaveLength(68)
    expect(keptArr).not.toContain(68)
  })

  it('带 index 候选（分割产物形态）：kept 输出顶点缓冲空间下标，非条目序号', () => {
    // 8 个顶点；候选 index = [2,3,4,7]（三角形 + 孤点）
    const positions = new Float32Array([
      99,
      0,
      0, // 顶点 0：非候选（充当背景，不与候选邻近）
      99,
      1,
      0, // 顶点 1：非候选
      0,
      0,
      0, //  顶点 2：候选（三角形）
      1,
      0,
      0, //  顶点 3：候选（三角形）
      0,
      1,
      0, //  顶点 4：候选（三角形）
      99,
      2,
      0, // 顶点 5：非候选
      99,
      3,
      0, // 顶点 6：非候选
      100,
      100,
      100, // 顶点 7：候选（孤立点，应剔除）
    ])
    const candidates = new Uint32Array([2, 3, 4, 7])
    const kept = sorFilterBruteForce([{ positions, index: candidates }], 2, 1)
    // 三角形互为邻居（K=2 凑满），孤点剔除 → kept = 顶点 2/3/4
    expect(Array.from(kept[0])).toEqual([2, 3, 4])
  })
})

// ---------------------------------------------------------------------------
// C++ 正确性对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------
const nativeAvailable = existsSync(NATIVE_PATH)

describe.skipIf(!nativeAvailable)('statistical_filter.node 与 JS 暴力参考一致性', () => {
  let addon: SorFilterAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 compute。 */
  function computeNative(req: SorFilterRequest): Promise<Map<number, Uint32Array[]>> {
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
    const cases: {
      seed: number
      n: number
      chunkSize: number
      useIndex: boolean
      neighbors: number
      stddevMul: number
    }[] = [
      { seed: 7, n: 1200, chunkSize: 600, useIndex: false, neighbors: 7, stddevMul: 1 },
      { seed: 8, n: 1500, chunkSize: 800, useIndex: true, neighbors: 10, stddevMul: 1 },
      { seed: 9, n: 900, chunkSize: 500, useIndex: true, neighbors: 4, stddevMul: 0.5 },
      { seed: 10, n: 800, chunkSize: 1200, useIndex: false, neighbors: 50, stddevMul: 2 }, // K 逼近总量
      { seed: 11, n: 1000, chunkSize: 300, useIndex: false, neighbors: 12, stddevMul: 0 }, // λ = 0：阈值 = μ
      { seed: 12, n: 600, chunkSize: 200, useIndex: true, neighbors: 8, stddevMul: 3 }, // 温和阈值（保全趋向）
    ]
    for (const c of cases) {
      const rnd = mulberry32(c.seed)
      const positions = randomCloud(rnd, c.n, 20)
      const chunks = makeChunks(positions, c.chunkSize, rnd, c.useIndex)
      const native = await computeNative({
        neighbors: c.neighbors,
        stddevMul: c.stddevMul,
        entities: [{ entityId: 1, chunks }],
      })
      const nativeKept = native.get(1)!
      const bruteKept = sorFilterBruteForce(chunks, c.neighbors, c.stddevMul)
      expect(nativeKept).toHaveLength(chunks.length)
      for (let ci = 0; ci < chunks.length; ci++) {
        expect(Array.from(nativeKept[ci]), `[case seed=${c.seed} 块 ${ci}] kept 与暴力参考一致`).toEqual(
          Array.from(bruteKept[ci])
        )
      }
    }
  })

  it('退化输入：全部候选同坐标（μ = σ = 0，avg 不严格大于阈值 → 全保留）逐元素一致', async () => {
    // 距离全 0 → 每点 avg = 0 = μ，σ = 0，avg > μ + λσ 不成立 → 全部保留
    const samePoint = new Float32Array(50 * 3)
    for (let i = 0; i < 50; i++) {
      samePoint[i * 3] = 1.5
      samePoint[i * 3 + 1] = -2.25
      samePoint[i * 3 + 2] = 3.75
    }
    const chunks: SorFilterChunkSource[] = [{ positions: samePoint, index: null }]
    const native = await computeNative({
      neighbors: 10,
      stddevMul: 1,
      entities: [{ entityId: 9, chunks }],
    })
    const brute = sorFilterBruteForce(chunks, 10, 1)
    expect(Array.from(native.get(9)![0])).toEqual(Array.from(brute[0]))
    expect(brute[0]).toHaveLength(50) // 全保留
  })

  it('密度两区 + 绝对孤立噪点场景（统计滤波的典型目标数据）逐元素一致', async () => {
    // 稠密区（间距 ~1）+ 稀疏有效区（间距 ~2，密度差一个量级内）+ 孤立噪点（> 15）
    const pts: [number, number, number][] = []
    const denseRnd = mulberry32(21)
    for (let i = 0; i < 500; i++) {
      pts.push([(denseRnd() - 0.5) * 10, (denseRnd() - 0.5) * 10, (denseRnd() - 0.5) * 10])
    }
    const sparseRnd = mulberry32(22)
    for (let i = 0; i < 120; i++) {
      pts.push([60 + (sparseRnd() - 0.5) * 10, (sparseRnd() - 0.5) * 10, (sparseRnd() - 0.5) * 10])
    }
    for (let i = 0; i < 6; i++) {
      const j = pts.length + i
      pts.push([j * 3, -j * 3, j * 2]) // 绝对孤立噪点（彼此也远离）
    }
    const positions = new Float32Array(pts.flat())
    const chunks: SorFilterChunkSource[] = [{ positions, index: null }]
    for (const cfg of [
      { neighbors: 8, stddevMul: 1 },
      { neighbors: 15, stddevMul: 1.5 },
    ]) {
      const native = await computeNative({
        neighbors: cfg.neighbors,
        stddevMul: cfg.stddevMul,
        entities: [{ entityId: 5, chunks }],
      })
      const nativeKept = native.get(5)!
      const bruteKept = sorFilterBruteForce(chunks, cfg.neighbors, cfg.stddevMul)
      expect(Array.from(nativeKept[0])).toEqual(Array.from(bruteKept[0]))
    }
  })

  it('多实体独立滤波：entityId 透传且互不串扰', async () => {
    const rnd = mulberry32(31)
    const a = randomCloud(rnd, 400, 8)
    const b = randomCloud(rnd, 700, 8)
    const native = await computeNative({
      neighbors: 6,
      stddevMul: 1,
      entities: [
        { entityId: 11, chunks: [{ positions: a, index: null }] },
        { entityId: 22, chunks: [{ positions: b, index: null }] },
      ],
    })
    expect([...native.keys()].sort()).toEqual([11, 22])
    const bruteA = sorFilterBruteForce([{ positions: a, index: null }], 6, 1)
    const bruteB = sorFilterBruteForce([{ positions: b, index: null }], 6, 1)
    expect(Array.from(native.get(11)![0])).toEqual(Array.from(bruteA[0]))
    expect(Array.from(native.get(22)![0])).toEqual(Array.from(bruteB[0]))
  })

  it('空输入与全空块契约：空实体输出空 kept', async () => {
    const native = await computeNative({
      neighbors: 5,
      stddevMul: 1,
      entities: [{ entityId: 1, chunks: [] }],
    })
    expect(native.get(1)).toEqual([])
  })
})
