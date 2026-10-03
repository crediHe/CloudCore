import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  candidateCountOfChunk,
  classifyPlane,
  estimateRansacDefaults,
} from '../../../../src/renderer/utils/ransacPlane'
import type {
  RansacPlaneAddon,
  RansacPlaneChunkSource,
  RansacPlaneEntityResult,
  RansacPlaneRequest,
} from '../../../../src/renderer/utils/ransacPlane'

// 纯函数（classifyPlane / estimateRansacDefaults）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/ransac-plane/build/Release/ransac_plane.node', import.meta.url)
)
const nativeAvailable = existsSync(NATIVE_PATH)
const require = createRequire(import.meta.url)

/** 加载 native 产物（仅 nativeAvailable 时调用）。 */
function loadAddon(): RansacPlaneAddon {
  return require(NATIVE_PATH)
}

/** 确定性伪随机数（mulberry32），保证测试可复现（与 C++ 用的是同一族 PRNG）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// 合成数据：倾斜平面 + 噪声 + 离群点
// ---------------------------------------------------------------------------

/**
 * 目标平面：法向 (0.3, 0.5, 1) 归一化、d = -2（即 n·p = 2）。
 *
 * 刻意非轴对齐（避免退化成 z = const 这类特例），也非垂直（nz 最大的分量为正 ⇒ 按 C++ 的
 * 法向符号约定，拟合结果的法向应与真值同向而非反向，测试可断言 dot ≈ 1）。
 */
function truthPlane(): { nx: number; ny: number; nz: number; d: number } {
  const len = Math.sqrt(0.3 * 0.3 + 0.5 * 0.5 + 1 * 1)
  return { nx: 0.3 / len, ny: 0.5 / len, nz: 1 / len, d: -2 }
}

/** 点到平面方程的有符号值（|值| = 点到平面的距离，法向已单位化）。 */
function distToPlane(x: number, y: number, z: number, pl: { nx: number; ny: number; nz: number; d: number }): number {
  return pl.nx * x + pl.ny * y + pl.nz * z + pl.d
}

interface CloudSpec {
  positions: Float32Array
  /** 真内点掩码：按「到真值平面的实际距离 ≤ 噪声幅度」判定，不是按构造意图。 */
  trueInlier: Uint8Array
  /** 到真值平面距离 > 20 × distanceThreshold 的远点（绝不该被拟合成内点）。 */
  farPoint: Uint8Array
}

/**
 * 造「倾斜平面 + 均匀噪声 + 离群点」的合成云。
 *
 * 平面点：在真值平面上均匀取 (x, y) 后解 z，再沿法向加均匀噪声 ±noiseSigma。
 * 离群点：在立方体内均匀散布（**不是**平行平面——否则等于人为送一个可分的第二平面）。
 * 两个掩码都按**实际距离**计算，与拟合结果无关，故断言不循环依赖。
 */
function planeCloud(
  rand: () => number,
  planePoints: number,
  outlierPoints: number,
  noiseSigma: number,
  extent = 10,
  distanceThreshold = 0.005
): CloudSpec {
  const pl = truthPlane()
  const total = planePoints + outlierPoints
  const positions = new Float32Array(total * 3)
  const trueInlier = new Uint8Array(total)
  const farPoint = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    let x: number
    let y: number
    let z: number
    if (i < planePoints) {
      x = (rand() - 0.5) * extent
      y = (rand() - 0.5) * extent
      z = (-pl.d - pl.nx * x - pl.ny * y) / pl.nz
      const noise = (rand() * 2 - 1) * noiseSigma
      x += pl.nx * noise
      y += pl.ny * noise
      z += pl.nz * noise
    } else {
      x = (rand() - 0.5) * extent
      y = (rand() - 0.5) * extent
      z = (rand() - 0.5) * extent
    }
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    // 距离用 float32 舍入后的坐标算，与 native 读到的一致
    const dist = Math.abs(distToPlane(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], pl))
    trueInlier[i] = dist <= noiseSigma ? 1 : 0
    farPoint[i] = dist > 20 * distanceThreshold ? 1 : 0
  }
  return { positions, trueInlier, farPoint }
}

/** 把全长点数组切进 chunks，可选地对每块再挑一个「候选子集 index」（模拟分割产物）。 */
function makeChunks(
  positions: Float32Array,
  chunkSize: number,
  rand: () => number,
  useIndex: boolean
): RansacPlaneChunkSource[] {
  const total = positions.length / 3
  const chunks: RansacPlaneChunkSource[] = []
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

/** 候选总数（无 index = 全量顶点数）。 */
function candidateTotal(chunks: RansacPlaneChunkSource[]): number {
  return chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
}

/** 「块内顶点下标」→ 全局候选序号（各块全量顶点时 = 块起点 + 顶点下标）。 */
function globalVertex(chunks: RansacPlaneChunkSource[], ci: number, vertex: number): number {
  let base = 0
  for (let c = 0; c < ci; c++) base += candidateCountOfChunk(chunks[c])
  return base + vertex
}

// ---------------------------------------------------------------------------
// 纯函数：无需 native 产物，CI 也跑
// ---------------------------------------------------------------------------

describe('classifyPlane（C++ classifyAll 的逐位镜像）', () => {
  it('轴对齐平面：恰在阈值上判内点（≤ 阈值，边界相等保留）', () => {
    const positions = new Float32Array([
      0,
      0,
      0, // 距离 0
      0,
      0,
      0.005, // 距离 0.005 = 阈值 → 内点
      0,
      0,
      -0.005, // 距离 0.005 = 阈值 → 内点
      0,
      0,
      0.006, // 超过阈值 → 剔除
    ])
    const res = classifyPlane([{ positions, index: null }], { nx: 0, ny: 0, nz: 1, d: 0 }, 0.005)
    expect(Array.from(res[0])).toEqual([0, 1, 2])
  })

  it('倾斜平面 + 带 index 的候选子集：只判候选、返回顶点下标、块内递增', () => {
    const pl = truthPlane()
    // 3 个平面点（顶点 0/2/3）+ 1 个远点（顶点 1）；候选 index 只含 0/1/2
    const positions = new Float32Array([
      0,
      0,
      -pl.d / pl.nz, //
      50,
      50,
      50, // 远点，不在候选里
      -pl.d / pl.nx,
      0,
      0, //
      0,
      -pl.d / pl.ny,
      0, // 候选外的平面点
    ])
    const index = new Uint32Array([0, 1, 2])
    // 阈值取 1e-5 而非 1e-6：坐标经 float32 存储后的舍入（~5e-7）会落在 1e-6 量级上
    const res = classifyPlane([{ positions, index }], pl, 1e-5)
    expect(Array.from(res[0])).toEqual([0, 2]) // 顶点 3 不在候选内，顶点 1 不在平面上
  })

  it('非正阈值按 0 处理：仅恰好落在平面上的点判内点', () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 1e-9])
    const res = classifyPlane([{ positions, index: null }], { nx: 0, ny: 0, nz: 1, d: 0 }, 0)
    expect(Array.from(res[0])).toEqual([0])
  })

  it('空候选：逐块回空数组（块数与输入对齐）', () => {
    const res = classifyPlane(
      [
        { positions: new Float32Array([0, 0, 1]), index: null },
        { positions: new Float32Array([0, 0, 0, 0, 0, 1]), index: new Uint32Array([]) },
      ],
      { nx: 0, ny: 0, nz: 1, d: 0 },
      0.1
    )
    expect(res).toHaveLength(2)
    expect(res[0]).toHaveLength(0)
    expect(res[1]).toHaveLength(0)
  })
})

describe('estimateRansacDefaults', () => {
  it('距离阈值 = 平均点距 × 2；迭代次数取 1000、默认开启系数优化', () => {
    const d = estimateRansacDefaults(1000, { x: 10, y: 10, z: 10 })
    // 体积密度 cbrt(1000/1000) = 1
    expect(d.distanceThreshold).toBeCloseTo(2, 6)
    expect(d.maxIterations).toBe(1000)
    expect(d.optimizeCoefficients).toBe(true)
  })

  it('退化输入（点数 < 2）不返回 0 阈值（0 = 无内点，功能会哑火）', () => {
    expect(estimateRansacDefaults(1, { x: 0, y: 0, z: 0 }).distanceThreshold).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// C++ 正确性对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------

describe.skipIf(!nativeAvailable)('ransac_plane.node 契约、质量与确定性', () => {
  let addon: RansacPlaneAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 compute。 */
  function computeNative(req: RansacPlaneRequest): Promise<RansacPlaneEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.compute(req, (err, results) => {
          if (err) reject(err)
          else resolve(results ?? [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  // ---- 组 1：精确对照（最重要的一条） ----

  it('native 回传的 plane 用 JS classifyPlane 重判，与回传 inliers 逐位相等（多组参数）', async () => {
    // 这条断言同时验证：契约字段语义、索引空间（顶点缓冲而非候选序号）、递增性、逐块对齐，
    // 且不依赖 PRNG 或 log（故可要求逐位相等，而不是"近似"）。
    // 若将来它只在最后几个 ulp 上失败：先查 C++ 是否被加了 /arch:AVX2 或 /fp:fast —— FMA
    // 收缩会把 nx*x + ny*y + nz*z + d 的求值精度改掉，镜像式便不再逐位成立。
    const cases = [
      {
        seed: 31,
        planePoints: 4000,
        outlierPoints: 1000,
        noiseSigma: 0.001,
        chunkSize: 1500,
        useIndex: true,
        threshold: 0.005,
        maxIter: 1000,
        optimize: true,
      },
      {
        seed: 32,
        planePoints: 3000,
        outlierPoints: 3000,
        noiseSigma: 0.002,
        chunkSize: 2000,
        useIndex: false,
        threshold: 0.01,
        maxIter: 500,
        optimize: false,
      },
      {
        seed: 33,
        planePoints: 2000,
        outlierPoints: 500,
        noiseSigma: 0.0002,
        chunkSize: 700,
        useIndex: true,
        threshold: 0.0005,
        maxIter: 1000,
        optimize: true,
      }, // 阈值逼近噪声：内点稀疏
      {
        seed: 34,
        planePoints: 1000,
        outlierPoints: 100,
        noiseSigma: 0.001,
        chunkSize: 3000,
        useIndex: false,
        threshold: 1e6,
        maxIter: 200,
        optimize: true,
      }, // 阈值巨大：全为内点
    ]
    for (const c of cases) {
      const rand = mulberry32(c.seed)
      const cloud = planeCloud(rand, c.planePoints, c.outlierPoints, c.noiseSigma, 10, c.threshold)
      const chunks = makeChunks(cloud.positions, c.chunkSize, rand, c.useIndex)
      const results = await computeNative({
        distanceThreshold: c.threshold,
        maxIterations: c.maxIter,
        optimizeCoefficients: c.optimize,
        entities: [{ entityId: 1, chunks }],
      })
      const r = results[0]
      expect(r.entityId).toBe(1)
      expect(r.inliers, `[case seed=${c.seed}] 块数对齐`).toHaveLength(chunks.length)
      expect(r.plane, `[case seed=${c.seed}] 应拟合出平面`).not.toBeNull()

      const mirrored = classifyPlane(chunks, r.plane!, c.threshold)
      mirrored.forEach((arr, ci) => {
        expect(Array.from(arr), `[case seed=${c.seed} 块 ${ci}] 逐位一致`).toEqual(Array.from(r.inliers[ci]))
      })
      // 内点数与契约字段自洽
      const total = r.inliers.reduce((s, a) => s + a.length, 0)
      expect(total, `[case seed=${c.seed}] inlierCount 与索引总数一致`).toBe(r.plane!.inlierCount)
      // 每块严格递增（顶点缓冲空间）
      for (const arr of r.inliers) {
        for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThan(arr[i - 1])
      }
    }
  })

  it('sampleCount = min(候选数, 65536)；iterationsUsed ≤ maxIterations', async () => {
    const rand = mulberry32(41)
    const cloud = planeCloud(rand, 5000, 0, 0.001)
    const chunks = makeChunks(cloud.positions, 2500, rand, false)
    const [r] = await computeNative({
      distanceThreshold: 0.01,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks }],
    })
    expect(r.plane!.sampleCount).toBe(candidateTotal(chunks))
    expect(r.plane!.iterationsUsed).toBeGreaterThan(0)
    expect(r.plane!.iterationsUsed).toBeLessThanOrEqual(1000)
  })

  // ---- 组 2：平面质量（"有效分割"的核心承诺） ----

  it('斜面 + 噪声 + 大块离群点：法向/d 复原、真内点几乎全收、远点全排除', async () => {
    const pl = truthPlane()
    const rand = mulberry32(51)
    const cloud = planeCloud(rand, 6000, 4000, 0.002)
    const [r] = await computeNative({
      distanceThreshold: 0.005,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }],
    })
    const model = r.plane!
    // 法向与真值同向（C++ 的符号约定：绝对值最大的分量为正）
    const dot = model.nx * pl.nx + model.ny * pl.ny + model.nz * pl.nz
    expect(dot, '法向与真值同向且精度足够').toBeGreaterThan(1 - 1e-6)
    expect(Math.abs(model.d - pl.d), '平面偏移复原').toBeLessThan(0.01)
    // 完备性：真内点几乎全部被收（允许 1% 因阈值边界浮动）
    const found = new Set<number>(Array.from(r.inliers[0]))
    let missed = 0
    let trueCount = 0
    for (let i = 0; i < cloud.trueInlier.length; i++) {
      if (!cloud.trueInlier[i]) continue
      trueCount++
      if (!found.has(i)) missed++
    }
    expect(trueCount).toBeGreaterThan(5000)
    expect(missed, '漏收的真内点数').toBeLessThanOrEqual(trueCount * 0.01)
    // 排他性：离平面 20 × 阈值之外的远点一个都不能进
    for (let i = 0; i < cloud.farPoint.length; i++) {
      if (cloud.farPoint[i]) expect(found.has(i), `远点 ${i} 不应进内点集`).toBe(false)
    }
    // 平面度指标自洽
    expect(model.rms).toBeLessThanOrEqual(0.005)
    expect(model.maxDeviation).toBeLessThanOrEqual(0.005)
    expect(model.maxDeviation).toBeGreaterThanOrEqual(model.rms)
  })

  it('候选全部为内点时 inlierCount > sampleCount（证明第二趟全量扫描真的跑了）', async () => {
    // 点数刻意超过自动采样上限 65536：若实现偷懒只在采样集上判内点，1 亿点的云只能分出
    // 6.5 万个点——这是本模块与"教科书 RANSAC"最实质的差别，必须有回归防线。
    const rand = mulberry32(61)
    const cloud = planeCloud(rand, 70000, 0, 0.001, 10, 0.01)
    const [r] = await computeNative({
      distanceThreshold: 0.01,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }],
    })
    expect(r.plane!.sampleCount).toBe(65536)
    expect(r.plane!.inlierCount).toBeGreaterThan(65536)
    expect(r.plane!.inlierCount).toBeGreaterThan(69000)
  })

  it('平面只占少数（25%）时仍能被找出，且内点全部落在该平面上', async () => {
    const pl = truthPlane()
    const rand = mulberry32(71)
    const cloud = planeCloud(rand, 2000, 6000, 0.002)
    const [r] = await computeNative({
      distanceThreshold: 0.005,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }],
    })
    const model = r.plane!
    const dot = model.nx * pl.nx + model.ny * pl.ny + model.nz * pl.nz
    expect(dot, '少数派平面仍被正确找出（不是被离群点带偏的次优解）').toBeGreaterThan(1 - 1e-6)
    const found = new Set<number>(Array.from(r.inliers[0]))
    for (let i = 0; i < cloud.farPoint.length; i++) {
      if (cloud.farPoint[i]) expect(found.has(i)).toBe(false)
    }
  })

  // ---- 组 3：确定性（预览不跳变的基础） ----

  it('同输入连续两次调用：inliers 与 plane 完全一致（固定种子 + 固定归约顺序）', async () => {
    const rand = mulberry32(81)
    const cloud = planeCloud(rand, 4000, 2000, 0.002)
    const chunks = makeChunks(cloud.positions, 1500, rand, true)
    const req: RansacPlaneRequest = {
      distanceThreshold: 0.005,
      maxIterations: 700,
      optimizeCoefficients: true,
      entities: [{ entityId: 9, chunks }],
    }
    const [a] = await computeNative(req)
    const [b] = await computeNative(req)
    expect(b.plane).toEqual(a.plane)
    expect(b.inliers).toHaveLength(a.inliers.length)
    a.inliers.forEach((arr, ci) => {
      expect(Array.from(b.inliers[ci])).toEqual(Array.from(arr))
    })
  })

  it('纯随机噪声（无平面）：结果同样可复现，不因两次运行给出不同答案', async () => {
    const rand = mulberry32(91)
    const cloud = planeCloud(rand, 0, 3000, 0)
    const req: RansacPlaneRequest = {
      distanceThreshold: 0.001,
      maxIterations: 300,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }],
    }
    const [a] = await computeNative(req)
    const [b] = await computeNative(req)
    expect(a.plane === null).toBe(b.plane === null)
    if (a.plane) expect(b.plane).toEqual(a.plane)
  })

  // ---- 组 4：退化与边界 ----

  it('候选 < 3 / maxIterations = 0：返回 plane = null 与空块（渲染侧据此提示）', async () => {
    const twoPoints = new Float32Array([0, 0, 0, 1, 1, 1])
    const [r1] = await computeNative({
      distanceThreshold: 0.1,
      maxIterations: 100,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: twoPoints, index: null }] }],
    })
    expect(r1.plane).toBeNull()
    expect(r1.inliers).toHaveLength(1)
    expect(r1.inliers[0]).toHaveLength(0)

    const rand = mulberry32(101)
    const cloud = planeCloud(rand, 1000, 0, 0.001)
    const [r2] = await computeNative({
      distanceThreshold: 0.1,
      maxIterations: 0,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }],
    })
    expect(r2.plane).toBeNull()
  })

  it('全共线点云：任何三元组都退化，直接判未找到（不是崩、也不是给个乱平面）', async () => {
    const n = 800
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = i
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = 0
    }
    const [r] = await computeNative({
      distanceThreshold: 1,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions, index: null }] }],
    })
    expect(r.plane).toBeNull()
    expect(r.inliers[0]).toHaveLength(0)
  })

  it('全部候选同坐标：退化三元组同样被跳过（不返回 plane）', async () => {
    const n = 500
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = 3
      positions[i * 3 + 1] = 4
      positions[i * 3 + 2] = 5
    }
    const [r] = await computeNative({
      distanceThreshold: 1,
      maxIterations: 500,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions, index: null }] }],
    })
    expect(r.plane).toBeNull()
  })

  it('带 index 的候选子集：内点必落在候选内，且候选外的点一个都不出现', async () => {
    // 块内含「真平面点」与「远点」两组；候选 index 只指向远点 → 找不到那个平面
    const pl = truthPlane()
    const rand = mulberry32(111)
    const planePts = planeCloud(rand, 3000, 0, 0.001)
    const n = 3000
    const positions = new Float32Array(n * 6)
    positions.set(planePts.positions, 0)
    for (let i = 0; i < n; i++) {
      positions[n * 3 + i * 3] = (rand() - 0.5) * 10
      positions[n * 3 + i * 3 + 1] = (rand() - 0.5) * 10
      positions[n * 3 + i * 3 + 2] = (rand() - 0.5) * 10
    }
    // 候选 = 后 3000 个（顶点下标 n..2n-1，递增）
    const indexFar = new Uint32Array(n)
    for (let i = 0; i < n; i++) indexFar[i] = n + i
    const chunks: RansacPlaneChunkSource[] = [{ positions, index: indexFar }]
    const [r] = await computeNative({
      distanceThreshold: 0.005,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks }],
    })
    // 候选是随机噪声：不该给出与真平面一致的解；若给出平面，内点必须全在候选内
    for (const arr of r.inliers) {
      for (const v of arr) expect(v).toBeGreaterThanOrEqual(n)
    }
    if (r.plane) {
      const dot = Math.abs(r.plane.nx * pl.nx + r.plane.ny * pl.ny + r.plane.nz * pl.nz)
      expect(dot, '候选不含平面点 ⇒ 不应复原出真平面').toBeLessThan(0.999)
    }
    // 反向：候选只指向平面点 → 应稳定复原真平面
    const indexPlane = new Uint32Array(n)
    for (let i = 0; i < n; i++) indexPlane[i] = i
    const [r2] = await computeNative({
      distanceThreshold: 0.005,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions, index: indexPlane }] }],
    })
    expect(r2.plane).not.toBeNull()
    const dot2 = r2.plane!.nx * pl.nx + r2.plane!.ny * pl.ny + r2.plane!.nz * pl.nz
    expect(dot2).toBeGreaterThan(1 - 1e-6)
    for (const arr of r2.inliers) {
      for (const v of arr) expect(v).toBeLessThan(n)
    }
  })

  it('块划分不改变结论：同一片数据切 1 块 / 2 块 / 多块，内点集合一致', async () => {
    // 精修关掉时，模型只由采样三点决定（采样走**全局候选序号**，与块划分无关）⇒ 平面系数
    // 逐位一致；打开精修时，协方差的浮点归约**分组**随块数变化（(a+b)+c+d ≠ (a+b)+(c+d)），
    // 精修平面可能差最后几个 ulp——故降到「内点集合一致 + 系数 ≤ 1e-12」。这是浮点加法不
    // 可结合的必然结果，不是缺陷；内点集合不受影响（判定只看距离是否越过阈值）。
    const rand = mulberry32(121)
    const cloud = planeCloud(rand, 3000, 1000, 0.002)
    const base = {
      distanceThreshold: 0.005,
      maxIterations: 1000,
      optimizeCoefficients: false,
    }
    const whole = [{ positions: cloud.positions, index: null }]
    const half = makeChunks(cloud.positions, 2000, rand, false)
    const many = makeChunks(cloud.positions, 500, rand, false)
    /** 平面系数与内点数逐位相等；rms 走归约，放到 1e-12 容差。 */
    const expectSamePlane = (a: typeof rWhole.plane, b: typeof rWhole.plane): void => {
      expect(b!.nx).toBe(a!.nx)
      expect(b!.ny).toBe(a!.ny)
      expect(b!.nz).toBe(a!.nz)
      expect(b!.d).toBe(a!.d)
      expect(b!.inlierCount).toBe(a!.inlierCount)
      expect(b!.maxDeviation).toBe(a!.maxDeviation) // max 无归约误差
      expect(b!.quad).toEqual(a!.quad) // 画布跨度也是 min/max，无归约误差
      expect(b!.rms).toBeCloseTo(a!.rms, 12)
    }
    const [rWhole] = await computeNative({ ...base, entities: [{ entityId: 1, chunks: whole }] })
    const [rHalf] = await computeNative({ ...base, entities: [{ entityId: 1, chunks: half }] })
    const [rMany] = await computeNative({ ...base, entities: [{ entityId: 1, chunks: many }] })
    expectSamePlane(rWhole.plane, rHalf.plane)
    expectSamePlane(rWhole.plane, rMany.plane)
    const flatWhole = Array.from(rWhole.inliers[0])
    // 2 块：块内顶点下标 + 块起点 = 全局顶点下标
    const flatHalf = rHalf.inliers.flatMap((arr, ci) => Array.from(arr, (v) => globalVertex(half, ci, v)))
    const flatMany = rMany.inliers.flatMap((arr, ci) => Array.from(arr, (v) => globalVertex(many, ci, v)))
    expect(flatHalf).toEqual(flatWhole)
    expect(flatMany).toEqual(flatWhole)

    // 精修打开：模型容差放到 1e-12，内点集合仍须一致
    const opt = { ...base, optimizeCoefficients: true }
    const [oWhole] = await computeNative({ ...opt, entities: [{ entityId: 1, chunks: whole }] })
    const [oMany] = await computeNative({ ...opt, entities: [{ entityId: 1, chunks: many }] })
    expect(oMany.plane!.nx).toBeCloseTo(oWhole.plane!.nx, 12)
    expect(oMany.plane!.ny).toBeCloseTo(oWhole.plane!.ny, 12)
    expect(oMany.plane!.nz).toBeCloseTo(oWhole.plane!.nz, 12)
    expect(oMany.plane!.d).toBeCloseTo(oWhole.plane!.d, 12)
    const flatOptWhole = Array.from(oWhole.inliers[0])
    const flatOptMany = oMany.inliers.flatMap((arr, ci) => Array.from(arr, (v) => globalVertex(many, ci, v)))
    expect(flatOptMany).toEqual(flatOptWhole)
  })

  it('平面片画布 quad：中心落在平面上、跨度覆盖全部内点、基为正交单位系', async () => {
    const rand = mulberry32(131)
    const cloud = planeCloud(rand, 5000, 500, 0.001)
    const chunks = makeChunks(cloud.positions, 1200, rand, false)
    const [r] = await computeNative({
      distanceThreshold: 0.005,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks }],
    })
    const { quad } = r.plane!
    const pl = r.plane!
    // 中心到平面距离 ≈ 0（平面度以内）
    expect(Math.abs(distToPlane(quad.cx, quad.cy, quad.cz, pl))).toBeLessThan(1e-6)
    // u / v 正交单位、且都垂直于法向
    const uLen = Math.sqrt(quad.ux ** 2 + quad.uy ** 2 + quad.uz ** 2)
    const vLen = Math.sqrt(quad.vx ** 2 + quad.vy ** 2 + quad.vz ** 2)
    expect(uLen).toBeCloseTo(1, 12)
    expect(vLen).toBeCloseTo(1, 12)
    expect(Math.abs(quad.ux * quad.vx + quad.uy * quad.vy + quad.uz * quad.vz)).toBeLessThan(1e-12)
    expect(Math.abs(quad.ux * pl.nx + quad.uy * pl.ny + quad.uz * pl.nz)).toBeLessThan(1e-12)
    // 每个内点都落在画布内（半跨度是内点实际跨度之半，不外扩）
    expect(quad.halfU).toBeGreaterThan(0)
    expect(quad.halfV).toBeGreaterThan(0)
    let maxU = 0
    let maxV = 0
    r.inliers.forEach((arr, ci) => {
      const positions = chunks[ci].positions
      for (const v of arr) {
        const x = positions[v * 3]
        const y = positions[v * 3 + 1]
        const z = positions[v * 3 + 2]
        maxU = Math.max(maxU, Math.abs((x - quad.cx) * quad.ux + (y - quad.cy) * quad.uy + (z - quad.cz) * quad.uz))
        maxV = Math.max(maxV, Math.abs((x - quad.cx) * quad.vx + (y - quad.cy) * quad.vy + (z - quad.cz) * quad.vz))
      }
    })
    expect(maxU).toBeLessThanOrEqual(quad.halfU + 1e-6)
    expect(maxV).toBeLessThanOrEqual(quad.halfV + 1e-6)
    // 跨度确实贴合内点分布（不是随便给个大数）
    expect(maxU).toBeGreaterThan(quad.halfU - 1e-6)
    expect(maxV).toBeGreaterThan(quad.halfV - 1e-6)
  })

  it('多实体：各实体独立拟合，结果与逐实体单独调用一致', async () => {
    const randA = mulberry32(141)
    const randB = mulberry32(142)
    const cloudA = planeCloud(randA, 2000, 200, 0.001)
    const cloudB = planeCloud(randB, 1500, 300, 0.002)
    const chunkA: RansacPlaneChunkSource[] = [{ positions: cloudA.positions, index: null }]
    const chunkB: RansacPlaneChunkSource[] = [{ positions: cloudB.positions, index: null }]
    const req = { distanceThreshold: 0.005, maxIterations: 500, optimizeCoefficients: true }
    const both = await computeNative({
      ...req,
      entities: [
        { entityId: 5, chunks: chunkA },
        { entityId: 8, chunks: chunkB },
      ],
    })
    const [onlyA] = await computeNative({ ...req, entities: [{ entityId: 5, chunks: chunkA }] })
    const [onlyB] = await computeNative({ ...req, entities: [{ entityId: 8, chunks: chunkB }] })
    expect(both).toHaveLength(2)
    expect(both[0].entityId).toBe(5)
    expect(both[1].entityId).toBe(8)
    expect(both[0].plane).toEqual(onlyA.plane)
    expect(both[1].plane).toEqual(onlyB.plane)
    both.forEach((r, i) => {
      const single = i === 0 ? onlyA : onlyB
      r.inliers.forEach((arr, ci) => {
        expect(Array.from(arr)).toEqual(Array.from(single.inliers[ci]))
      })
    })
  })

  it('参数校验：缺字段 / 类型不符时同步抛 TypeError（不静默算错）', () => {
    expect(() => addon.compute({} as unknown as RansacPlaneRequest, () => {})).toThrow(TypeError)
    expect(() =>
      addon.compute(
        {
          distanceThreshold: 1,
          maxIterations: 10,
          optimizeCoefficients: true,
          entities: 'x',
        } as unknown as RansacPlaneRequest,
        () => {}
      )
    ).toThrow(TypeError)
  })

  it('globalVertex 辅助函数自用校验：块内顶点下标能还原成全局顶点（防测试自身写错）', () => {
    const chunks = makeChunks(new Float32Array(30), 12, mulberry32(1), false)
    expect(candidateTotal(chunks)).toBe(10)
    expect(globalVertex(chunks, 0, 3)).toBe(3)
    expect(globalVertex(chunks, 1, 0)).toBe(10)
  })
})
