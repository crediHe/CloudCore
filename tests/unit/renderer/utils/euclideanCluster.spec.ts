import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { candidateCountOfChunk } from '../../../../src/renderer/utils/radiusFilter'
import {
  bucketClusters,
  buildClusterColors,
  clusterColor,
  computeEuclideanClusters,
  defaultClusterTolerance,
  euclideanClusterBruteForce,
  isClusterKept,
  summarizeClusters,
  CLUSTER_NOISE_SRGB,
  DEFAULT_CLUSTER_MIN_POINTS,
} from '../../../../src/renderer/utils/euclideanCluster'
import type {
  EuclideanClusterAddon,
  EuclideanClusterChunkSource,
  EuclideanClusterEntityResult,
  EuclideanClusterRequest,
} from '../../../../src/renderer/utils/euclideanCluster'
import { srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'

// 纯函数组在 node 环境即可；native 组直连编译产物（N-API 对 Node 与 Electron 通用），
// 产物缺失（CI 无编译链）时整组 skip（同 treeIso.spec / radiusFilter.spec 惯例）。
//
// 对照基准是 euclideanClusterBruteForce（逐条镜像 C++ 的并查集语义）：C++ 全用
// double 基本算术，故可断言**逐位相等**，不是"近似相等"。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/euclidean-cluster/build/Release/euclidean_cluster.node', import.meta.url)
)
const nativeAvailable = existsSync(NATIVE_PATH)

/** 单块无 index 块源（候选 = 全量顶点）。 */
function rawChunk(vertexCount: number): EuclideanClusterChunkSource {
  return { positions: new Float32Array(vertexCount * 3), index: null }
}

/** 带 index 块源（候选 = index 条目，指向顶点下标）。 */
function indexedChunk(vertexCount: number, index: number[]): EuclideanClusterChunkSource {
  return { positions: new Float32Array(vertexCount * 3), index: new Uint32Array(index) }
}

/** 确定性 PRNG（线性同余；造点用，跨运行可复现）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 点云块：以若干"团"为主 + 均匀散点（保证既有大簇也有碎簇）。 */
function blobChunk(seed: number, blobCount: number, perBlob: number, scatter: number): Float32Array {
  const rng = makeRng(seed)
  const total = blobCount * perBlob + scatter
  const pos = new Float32Array(total * 3)
  let w = 0
  for (let b = 0; b < blobCount; b++) {
    const cx = rng() * 10
    const cy = rng() * 10
    const cz = rng() * 10
    for (let i = 0; i < perBlob; i++) {
      // 团内 ±0.08 抖动：点距约 0.05，团间距 ≥ 1 ⇒ 阈值 0.1~0.3 下团必然独立
      pos[w++] = cx + (rng() - 0.5) * 0.16
      pos[w++] = cy + (rng() - 0.5) * 0.16
      pos[w++] = cz + (rng() - 0.5) * 0.16
    }
  }
  for (let i = 0; i < scatter; i++) {
    pos[w++] = rng() * 30
    pos[w++] = rng() * 30
    pos[w++] = rng() * 30
  }
  return pos
}

/** 逐元素比对标签（失败时给出首个不一致位置，便于定位）。 */
function expectLabelsEqual(actual: Int32Array, expected: Int32Array, label: string) {
  expect(actual.length, `${label}: 长度`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}: 第 ${i} 个候选标签 ${actual[i]} ≠ 期望 ${expected[i]}`)
    }
  }
}

describe('isClusterKept / defaultClusterTolerance（min-max 边界语义）', () => {
  it('min/max 均含端点；maxPoints ≤ 0 表示不限', () => {
    expect(isClusterKept(10, 10, 0)).toBe(true) // 下限含
    expect(isClusterKept(9, 10, 0)).toBe(false)
    expect(isClusterKept(10, 10, 100)).toBe(true)
    expect(isClusterKept(100, 10, 100)).toBe(true) // 上限含
    expect(isClusterKept(101, 10, 100)).toBe(false)
    expect(isClusterKept(1000000, 10, 0)).toBe(true) // 0 = 不限
  })

  it('默认阈值 = 平均点距 × 3；退化输入回落到 0.1', () => {
    expect(defaultClusterTolerance(0.02)).toBeCloseTo(0.06, 10)
    expect(defaultClusterTolerance(0)).toBe(0.1)
    expect(defaultClusterTolerance(Number.NaN)).toBe(0.1)
  })
})

describe('summarizeClusters（簇大小表汇总）', () => {
  it('按 min/max 统计入选与残点，守恒', () => {
    // 簇大小：5, 3, 100, 1；min=3 max=20 ⇒ 入选 5 与 3
    const sizes = new Uint32Array([5, 3, 100, 1])
    const s = summarizeClusters(sizes, 3, 20)
    expect(s.clusterCount).toBe(4)
    expect(s.keptCount).toBe(2)
    expect(s.keptPoints).toBe(8)
    expect(s.noisePoints).toBe(109 - 8)
    expect(s.largestClusterPoints).toBe(100)
    expect(s.largestKeptPoints).toBe(5)
    expect(s.keptPoints + s.noisePoints).toBe(109)
  })

  it('不限上限（max = 0）时除过小簇外全部入选', () => {
    const s = summarizeClusters(new Uint32Array([10, 1, 1000000]), DEFAULT_CLUSTER_MIN_POINTS, 0)
    expect(s.keptCount).toBe(2)
    expect(s.noisePoints).toBe(1)
  })

  it('空表：全 0，不抛错', () => {
    const s = summarizeClusters(new Uint32Array(0), 10, 0)
    expect(s).toEqual({
      clusterCount: 0,
      keptCount: 0,
      keptPoints: 0,
      noisePoints: 0,
      largestClusterPoints: 0,
      largestKeptPoints: 0,
    })
  })
})

describe('bucketClusters（簇标签 → 逐块顶点下标 + 残点）', () => {
  it('无 index 块：候选序即顶点下标，逐簇按块分桶', () => {
    const chunks = [rawChunk(5), rawChunk(4)]
    // 块主序候选：chunk0 顶点 0..4 = [1,1,2,2,2]；chunk1 顶点 0..3 = [2,1,1,3]
    const labels = new Int32Array([1, 1, 2, 2, 2, 2, 1, 1, 3])
    const sizes = new Uint32Array([4, 4, 1]) // 簇 1 共 4、簇 2 共 4、簇 3 共 1
    const { clusters, noiseChunkIndices } = bucketClusters(chunks, labels, sizes, 2, 0)
    // 簇 3 只有 1 点 < min=2 ⇒ 归残点
    expect(clusters.map((c) => c.label)).toEqual([1, 2])
    expect(clusters[0].chunkIndices).toEqual([new Uint32Array([0, 1]), new Uint32Array([1, 2])])
    expect(clusters[1].chunkIndices).toEqual([new Uint32Array([2, 3, 4]), new Uint32Array([0])])
    expect(clusters[0].pointCount).toBe(4)
    expect(noiseChunkIndices).toEqual([null, new Uint32Array([3])])
  })

  it('带 index 块：桶元素是顶点下标（v = index[k]），不是候选序', () => {
    const chunks = [indexedChunk(20, [3, 7, 11, 15])]
    const labels = new Int32Array([1, 2, 2, 1])
    const sizes = new Uint32Array([2, 2])
    const { clusters, noiseChunkIndices } = bucketClusters(chunks, labels, sizes, 1, 0)
    expect(noiseChunkIndices).toBeNull()
    expect(clusters[0].chunkIndices[0]).toEqual(new Uint32Array([3, 15]))
    expect(clusters[1].chunkIndices[0]).toEqual(new Uint32Array([7, 11]))
  })

  it('多块 + min/max 两侧边界：守恒（入选 + 残点 = 候选总数）', () => {
    const chunks = [rawChunk(6), indexedChunk(20, [10, 12, 14, 16])]
    const labels = new Int32Array([1, 1, 2, 2, 3, 3, 1, 2, 3, 4])
    // 簇大小：1→3（两块各 2 + 1 = 3）、2→3、3→3、4→1
    const sizes = new Uint32Array([3, 3, 3, 1])
    const total = 10
    // min=3 max=3 ⇒ 只有 size 恰为 3 的入选（边界含端点）
    const { clusters, noiseChunkIndices } = bucketClusters(chunks, labels, sizes, 3, 3)
    expect(clusters.map((c) => c.label)).toEqual([1, 2, 3])
    const kept = clusters.reduce((s, c) => s + c.pointCount, 0)
    const noise = noiseChunkIndices?.reduce((s, a) => s + (a ? a.length : 0), 0) ?? 0
    expect(kept + noise).toBe(total)
    expect(noise).toBe(1) // 簇 4 单点
  })

  it('全部过小：clusters 空、残点覆盖全部候选', () => {
    const chunks = [rawChunk(4)]
    const labels = new Int32Array([1, 2, 3, 4])
    const sizes = new Uint32Array([1, 1, 1, 1])
    const { clusters, noiseChunkIndices } = bucketClusters(chunks, labels, sizes, 10, 0)
    expect(clusters).toEqual([])
    expect(noiseChunkIndices).toEqual([new Uint32Array([0, 1, 2, 3])])
  })

  it('标签数与候选数不符 / 大小表与标签不符：抛错（契约防御）', () => {
    const chunks = [rawChunk(3)]
    expect(() => bucketClusters(chunks, new Int32Array([1, 1]), new Uint32Array([2]), 1, 0)).toThrow(/标签数与候选数/)
    expect(() => bucketClusters(chunks, new Int32Array([1, 1, 1]), new Uint32Array([3, 1]), 1, 0)).toThrow(/簇大小表/)
  })
})

describe('buildClusterColors（预览逐顶点线性色）', () => {
  // ⚠ srgbU8ToLinear 入参是 u8 字节（内部已除 255），别再除一次（会得到全 0）
  const lin = (v: number) => Math.round(srgbU8ToLinear(v) * 255)

  it('长度 = 顶点数 × 3（不是候选数）；带 index 块的非候选顶点保持灰', () => {
    const chunks = [indexedChunk(5, [1, 3])]
    const labels = new Int32Array([1, 1])
    const sizes = new Uint32Array([2])
    const [bytes] = buildClusterColors(chunks, labels, sizes, 1, 0)
    expect(bytes).not.toBeNull()
    expect(bytes!.length).toBe(5 * 3)
    const c = clusterColor(1)
    // 候选顶点 1、3 上色
    expect(Array.from(bytes!.subarray(3, 6))).toEqual([lin(c.r), lin(c.g), lin(c.b)])
    expect(Array.from(bytes!.subarray(9, 12))).toEqual([lin(c.r), lin(c.g), lin(c.b)])
    // 顶点 0、2、4 不是候选 ⇒ 灰
    expect(Array.from(bytes!.subarray(0, 3))).toEqual([
      lin(CLUSTER_NOISE_SRGB),
      lin(CLUSTER_NOISE_SRGB),
      lin(CLUSTER_NOISE_SRGB),
    ])
    expect(Array.from(bytes!.subarray(6, 9))).toEqual([
      lin(CLUSTER_NOISE_SRGB),
      lin(CLUSTER_NOISE_SRGB),
      lin(CLUSTER_NOISE_SRGB),
    ])
  })

  it('未入选簇（被 max 滤掉）不上色：整块保持灰', () => {
    const chunks = [rawChunk(3)]
    const labels = new Int32Array([1, 1, 1])
    const sizes = new Uint32Array([3])
    const [bytes] = buildClusterColors(chunks, labels, sizes, 1, 2) // max=2 < 3 ⇒ 不入选
    const g = lin(CLUSTER_NOISE_SRGB)
    expect(Array.from(bytes!)).toEqual([g, g, g, g, g, g, g, g, g])
  })

  it('入选与未入选混排：只有入选簇换色（颜色按簇号定，不随参数跳）', () => {
    const chunks = [rawChunk(4)]
    const labels = new Int32Array([2, 2, 5, 5])
    const sizes = new Uint32Array([0, 2, 0, 0, 2]) // 簇 2、5 各 2 点
    const [bytes] = buildClusterColors(chunks, labels, sizes, 2, 0)
    const c2 = clusterColor(2)
    const c5 = clusterColor(5)
    expect(Array.from(bytes!.subarray(0, 3))).toEqual([lin(c2.r), lin(c2.g), lin(c2.b)])
    expect(Array.from(bytes!.subarray(6, 9))).toEqual([lin(c5.r), lin(c5.g), lin(c5.b)])
  })

  it('clusterColor 为确定性纯函数，相邻簇色不同', () => {
    expect(clusterColor(1)).toEqual(clusterColor(1))
    expect(clusterColor(1)).not.toEqual(clusterColor(2))
    const c = clusterColor(1)
    for (const v of [c.r, c.g, c.b]) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })
})

describe.skipIf(!nativeAvailable)('euclidean_cluster.node（native 产物存在时）', () => {
  const require = createRequire(import.meta.url)
  // 与 radiusFilter.spec 惯例一致：直连 addon（不走 nativeLoader 的 window IPC）
  const addon = require(NATIVE_PATH) as EuclideanClusterAddon

  /** promise 化 addon.compute（compute 同步抛错一并收敛）。 */
  function computeNative(request: EuclideanClusterRequest): Promise<EuclideanClusterEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.compute(request, (err, results) => {
          if (err) reject(err)
          else resolve(results ?? [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  /** 单实体跑一次 native，返回唯一结果（缺结果即抛错）。 */
  async function runOne(
    chunks: EuclideanClusterChunkSource[],
    tolerance: number,
    threadCount?: number
  ): Promise<EuclideanClusterEntityResult> {
    const results = await computeNative({ tolerance, threadCount, entities: [{ entityId: 7, chunks }] })
    expect(results).toHaveLength(1)
    expect(results[0].entityId).toBe(7)
    return results[0]
  }

  it('契约冒烟：labels 长度 = 候选数、值 ≥ 1、ΣclusterSizes = 候选数', async () => {
    const positions = blobChunk(11, 3, 60, 40)
    const chunks: EuclideanClusterChunkSource[] = [{ positions, index: null }]
    const res = await runOne(chunks, 0.2)
    const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
    expect(res.labels.length).toBe(candidateTotal)
    expect(res.clusterSizes.length).toBeGreaterThan(0)
    let sum = 0
    let maxLabel = 0
    for (let i = 0; i < res.labels.length; i++) {
      expect(res.labels[i]).toBeGreaterThanOrEqual(1)
      if (res.labels[i] > maxLabel) maxLabel = res.labels[i]
    }
    for (let i = 0; i < res.clusterSizes.length; i++) sum += res.clusterSizes[i]
    expect(sum).toBe(candidateTotal)
    // 标签连续 1..K（按候选序首遇分配）
    expect(maxLabel).toBe(res.clusterSizes.length)
  })

  it('逐位相等：native 与 JS 对照（多块 + 带 index 块 + 多档阈值）', async () => {
    const pos0 = blobChunk(21, 4, 80, 120)
    const pos1 = blobChunk(22, 3, 50, 60)
    // 带 index 的块：候选 = 顶点下标子集（模拟分割产物）
    const pos2 = blobChunk(23, 2, 40, 20)
    const idx2 = new Uint32Array([...Array(pos2.length / 3).keys()].filter((i) => i % 3 !== 0))
    const chunks: EuclideanClusterChunkSource[] = [
      { positions: pos0, index: null },
      { positions: pos1, index: null },
      { positions: pos2, index: idx2 },
    ]
    // 0.1：团内连成簇、散点成碎簇；0.5：跨团团聚；3：几乎全连通
    for (const tolerance of [0.1, 0.5, 3]) {
      const res = await runOne(chunks, tolerance)
      const ref = euclideanClusterBruteForce(chunks, tolerance)
      expectLabelsEqual(res.labels, ref.labels, `tolerance=${tolerance}`)
      expect(Array.from(res.clusterSizes)).toEqual(Array.from(ref.clusterSizes))
    }
  })

  it('线程无关：threadCount 1 与 4 逐位相等（>20 万点，越过原生并行门限）', async () => {
    // 门限是 200000 候选（native 内 kParallelMinPoints），故这里给 25 万。
    // ⚠ 点位必须**稀疏**：致密团 + 大阈值会让每点邻居数 ≈ 点数，KD 查询退化成 O(n²)
    // （25 万点的致密团跑不进任何合理超时）。
    const n = 250000
    const rng = makeRng(31)
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) positions[i] = rng() * 40
    const chunks: EuclideanClusterChunkSource[] = [{ positions, index: null }]
    expect(positions.length / 3).toBeGreaterThan(200000)
    const tolerance = 0.15
    const serial = await runOne(chunks, tolerance, 1)
    const parallel = await runOne(chunks, tolerance, 4)
    expectLabelsEqual(parallel.labels, serial.labels, '平行 vs 串行')
    expect(Array.from(parallel.clusterSizes)).toEqual(Array.from(serial.clusterSizes))
    // 结果有效性：稀疏云下绝大多数点自成一簇
    expect(serial.clusterSizes.length).toBeGreaterThan(n * 0.9)
    // 串行结果同时与 JS 对照逐位一致（O(n²) 在这里不可用，故只比"总量"守恒）
    expect(serial.clusterSizes.reduce((s, v) => s + v, 0)).toBe(n)
  }, 120000)

  it('跨块邻居：人工切成两块的同一团必须并成一簇（块边界不是空间边界）', async () => {
    // 一个团横跨 x=0 平面：x<0 的点在块 0、x>0 的在块 1，块内点距 ≈ 0.05 < 阈值
    const n = 400
    const a = new Float32Array(n * 3)
    const b = new Float32Array(n * 3)
    const rng = makeRng(41)
    let wa = 0
    let wb = 0
    for (let i = 0; i < n; i++) {
      const x = (rng() - 0.5) * 0.8
      const y = (rng() - 0.5) * 0.8
      const z = (rng() - 0.5) * 0.8
      if (x < 0) {
        a[wa++] = x
        a[wa++] = y
        a[wa++] = z
      } else {
        b[wb++] = x
        b[wb++] = y
        b[wb++] = z
      }
    }
    const chunks: EuclideanClusterChunkSource[] = [
      { positions: a.subarray(0, wa) as Float32Array, index: null },
      { positions: b.subarray(0, wb) as Float32Array, index: null },
    ]
    const res = await runOne(chunks, 0.3)
    expect(res.clusterSizes.length).toBe(1) // 跨块连成一个簇
    expect(res.clusterSizes[0]).toBe(wa / 3 + wb / 3)
    // 对照也一致（brute force 同样跨块）
    expectLabelsEqual(res.labels, euclideanClusterBruteForce(chunks, 0.3).labels, '跨块')
  })

  it('阈值极小 → 每候选自成一簇；阈值极大 → 全并为 1 簇', async () => {
    const positions = blobChunk(51, 3, 20, 10)
    const chunks: EuclideanClusterChunkSource[] = [{ positions, index: null }]
    const total = positions.length / 3
    const tiny = await runOne(chunks, 0.0001)
    expect(tiny.clusterSizes.length).toBe(total)
    expect(Array.from(tiny.clusterSizes)).toEqual(Array.from({ length: total }, () => 1))
    const huge = await runOne(chunks, 1e4)
    expect(Array.from(huge.clusterSizes)).toEqual([total])
    expect(Array.from(huge.labels).every((l) => l === 1)).toBe(true)
  })

  it('含等号语义：距离恰好 = 阈值算同类，略大则分开', async () => {
    // 两点 (0,0,0) 与 (1,0,0)：距离恰好 1（float 可精确表示，double 平方亦精确）
    const p = new Float32Array([0, 0, 0, 1, 0, 0])
    const chunks: EuclideanClusterChunkSource[] = [{ positions: p, index: null }]
    const equal = await runOne(chunks, 1)
    expect(Array.from(equal.clusterSizes)).toEqual([2])
    // 阈值略小于 1 ⇒ 距离 > 阈值 ⇒ 两簇。
    // ⚠ 别用 0.99999999：它的 float32 值恰好就是 1（fround 后 == 1.0），等于没改阈值
    const smaller = await runOne(chunks, Math.fround(0.999))
    expect(Array.from(smaller.clusterSizes)).toEqual([1, 1])
    expectLabelsEqual(smaller.labels, euclideanClusterBruteForce(chunks, Math.fround(0.999)).labels, '等号边界外')
  })

  it('tolerance ≤ 0：每候选自成一簇（与 JS 对照一致）', async () => {
    const positions = blobChunk(61, 1, 10, 5)
    const chunks: EuclideanClusterChunkSource[] = [{ positions, index: null }]
    const total = positions.length / 3
    const res = await runOne(chunks, 0)
    expect(res.clusterSizes.length).toBe(total)
    expectLabelsEqual(res.labels, euclideanClusterBruteForce(chunks, 0).labels, 'tolerance=0')
  })

  it('空输入 / 全空块：空 labels 与空大小表', async () => {
    const empty = await runOne([{ positions: new Float32Array(0), index: null }], 0.2)
    expect(empty.labels.length).toBe(0)
    expect(empty.clusterSizes.length).toBe(0)
    const zeroChunks = await runOne([], 0.2)
    expect(zeroChunks.clusterSizes.length).toBe(0)
  })

  it('index 越界：整体作废为空结果（契约防御，不读越界内存）', async () => {
    const positions = blobChunk(71, 1, 10, 0)
    const chunks: EuclideanClusterChunkSource[] = [
      { positions, index: new Uint32Array([0, 1, 999999]) }, // 越界
    ]
    const res = await runOne(chunks, 0.2)
    expect(res.labels.length).toBe(0)
    expect(res.clusterSizes.length).toBe(0)
  })

  it('computeEuclideanClusters（生产入口）在 node 下因 nativeLoader 走 IPC 而拒绝', async () => {
    // 生产入口依赖 window.electronAPI（Electron 渲染环境），node 单测下必须干净失败，
    // 而不是静默返回空结果——这条同时钉住"调用方必须 catch"的约定
    await expect(computeEuclideanClusters({ tolerance: 0.1, entities: [] })).rejects.toThrow()
  })
})
