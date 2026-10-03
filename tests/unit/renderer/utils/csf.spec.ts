import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { estimateCsfDefaults, CSF_FIXED } from '../../../../src/renderer/utils/csf'
import type { CsfAddon, CsfChunkSource, CsfRequest } from '../../../../src/renderer/utils/csf'
import { csfJsReference } from './csfReference'

// 纯算法（默认参数估计）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。
// 对照基准 csfJsReference（csf.cc 逐式镜像）见同目录 csfReference.ts。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/csf-lidar/build/Release/csf_lidar.node', import.meta.url)
)
const require = createRequire(import.meta.url)

/** 加载 native 产物（仅 nativeAvailable 时调用）。 */
function loadAddon(): CsfAddon {
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

/** 生成 n 个随机点坐标（摊开成 Float32Array）：z = 平滑起伏地表 + 小噪声。 */
function terrainCloud(rand: () => number, n: number, extent: number): Float32Array {
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = (rand() - 0.5) * extent
    const y = (rand() - 0.5) * extent
    // 平滑山包地表（sin/cos 低频组合），幅度 < extent/10，加 ±0.05 噪声
    const z = Math.sin(x * 0.9) * 0.8 + Math.cos(y * 0.7) * 0.6 + (rand() - 0.5) * 0.1
    arr[i * 3] = x
    arr[i * 3 + 1] = y
    arr[i * 3 + 2] = z
  }
  return arr
}

/**
 * 语义用例数据：平地上立一个中央高台（"凸起地物"）。CSF 的桌布效应——布料
 * 搭在台周地面上、悬在台顶上方未接触：台顶判非地面（要剔除的建筑物等凸起），
 * 台外地面贴合判地面。
 * @returns positions + 台顶点下标 top / 台外点下标 outside（台内留底的点仅作
 *   普通地面噪声存在，不参与断言——真实扫描中台底正下方通常没有点）
 */
function steppedCloud(
  rand: () => number,
  n: number,
  extent: number
): { positions: Float32Array; top: number[]; outside: number[] } {
  const box = extent * 0.25 // 中央高台边长（占 25%）
  const top: number[] = []
  const outside: number[] = []
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = (rand() - 0.5) * extent
    const y = (rand() - 0.5) * extent
    const inBox = Math.abs(x) < box / 2 && Math.abs(y) < box / 2
    // 台内一半点抬高（台顶）、一半留底；台外为平地
    const isTop = inBox && rand() < 0.5
    const z = isTop ? 3 + (rand() - 0.5) * 0.05 : (rand() - 0.5) * 0.05
    arr[i * 3] = x
    arr[i * 3 + 1] = y
    arr[i * 3 + 2] = z
    if (isTop) {
      top.push(i)
    } else if (!inBox) {
      outside.push(i)
    }
  }
  return { positions: arr, top, outside }
}

/** 把全长点数组切进 chunks，可选地对每块再挑一个"候选子集 index"（模拟分割产物）。 */
function makeChunks(positions: Float32Array, chunkSize: number, rand: () => number, useIndex: boolean): CsfChunkSource[] {
  const total = positions.length / 3
  const chunks: CsfChunkSource[] = []
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(total, start + chunkSize)
    const count = end - start
    const slice = positions.slice(start * 3, end * 3)
    let index: Uint32Array | null = null
    if (useIndex) {
      // 候选子集：每点 80% 概率进入；值 = 块内顶点下标（0..count-1，递增）
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

describe('estimateCsfDefaults（按数据量级估初始参数）', () => {
  it('纯函数：由平均点距 ×4 / ×2 给出布料分辨率与分类阈值', () => {
    // 100³ 米内 1e6 点 → 平均点距 1 → 布料分辨率 4、分类阈值 2
    const d = estimateCsfDefaults(1_000_000, { x: 100, y: 100, z: 100 })
    expect(d.clothResolution).toBeCloseTo(4, 6)
    expect(d.classThreshold).toBeCloseTo(2, 6)
  })

  it('退化输入：返回 1（保证初始布料分辨率非 0）', () => {
    expect(estimateCsfDefaults(1000, { x: 0, y: 0, z: 0 })).toEqual({ clothResolution: 4, classThreshold: 2 })
  })
})

// ---------------------------------------------------------------------------
// C++ 正确性对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------
const nativeAvailable = existsSync(NATIVE_PATH)

describe.skipIf(!nativeAvailable)('csf_lidar.node 与 JS 参考实现一致性', () => {
  let addon: CsfAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 compute；默认参数与渲染侧（csfStore）一致。 */
  function computeNative(
    chunks: CsfChunkSource[],
    entityId: number,
    overrides: Partial<CsfRequest> = {}
  ): Promise<Uint32Array[]> {
    const request: CsfRequest = {
      clothResolution: 2,
      rigidness: 2,
      iterations: CSF_FIXED.iterations,
      timeStep: CSF_FIXED.timeStep,
      classThreshold: 0.5,
      smoothSlope: false,
      heightAxis: CSF_FIXED.heightAxis,
      entities: [{ entityId, chunks }],
      ...overrides,
    }
    return new Promise((resolve, reject) => {
      try {
        addon.compute(request, (err, results) => {
          if (err) reject(err)
          else resolve(results?.[0]?.ground ?? [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  /** 断言 native 输出与 JS 参考逐元素一致（ground 均为顶点下标、递增）。 */
  function expectMatchesReference(ground: Uint32Array[], ref: Uint32Array[]) {
    expect(ground).toHaveLength(ref.length)
    for (let i = 0; i < ref.length; i++) {
      expect(Array.from(ground[i])).toEqual(Array.from(ref[i]))
      // 递增序自检（与算法注释声明的输出契约一致）
      for (let k = 1; k < ground[i].length; k++) {
        expect(ground[i][k]).toBeGreaterThan(ground[i][k - 1])
      }
    }
  }

  it('多轮随机起伏地表点集：native 与 JS 参考逐元素一致（含多块 / index 子集 / 平滑开合）', async () => {
    const cases: {
      seed: number
      n: number
      extent: number
      chunkSize: number
      useIndex: boolean
      res: number
      rigidness: number
      threshold: number
      smooth: boolean
      iterations: number
    }[] = [
      { seed: 31, n: 1200, extent: 20, chunkSize: 400, useIndex: false, res: 2.0, rigidness: 2, threshold: 0.5, smooth: false, iterations: 120 },
      { seed: 32, n: 1500, extent: 20, chunkSize: 600, useIndex: true, res: 2.5, rigidness: 1, threshold: 0.8, smooth: false, iterations: 80 },
      { seed: 33, n: 900, extent: 16, chunkSize: 500, useIndex: true, res: 1.5, rigidness: 3, threshold: 0.3, smooth: true, iterations: 100 },
      { seed: 34, n: 2000, extent: 24, chunkSize: 2000, useIndex: false, res: 3.0, rigidness: 2, threshold: 1.0, smooth: true, iterations: 60 }, // 单块
    ]
    for (const c of cases) {
      const rnd = mulberry32(c.seed)
      const positions = terrainCloud(rnd, c.n, c.extent)
      const chunks = makeChunks(positions, c.chunkSize, rnd, c.useIndex)
      const [ground, ref] = await Promise.all([
        computeNative(chunks, c.seed, {
          clothResolution: c.res,
          rigidness: c.rigidness,
          classThreshold: c.threshold,
          smoothSlope: c.smooth,
          iterations: c.iterations,
        }),
        Promise.resolve(
          csfJsReference(chunks, {
            clothResolution: c.res,
            rigidness: c.rigidness,
            iterations: c.iterations,
            timeStep: CSF_FIXED.timeStep,
            classThreshold: c.threshold,
            smoothSlope: c.smooth,
            heightAxis: CSF_FIXED.heightAxis,
          })
        ),
      ])
      expectMatchesReference(ground, ref)
    }
  })

  it('多实体一次 compute：各实体独立铺布、结果互不干扰', async () => {
    const rnd = mulberry32(41)
    const chunksA = makeChunks(terrainCloud(rnd, 800, 20), 400, rnd, false)
    const chunksB = makeChunks(terrainCloud(rnd, 800, 20), 400, rnd, true)
    const request: CsfRequest = {
      clothResolution: 2,
      rigidness: 2,
      iterations: 80,
      timeStep: CSF_FIXED.timeStep,
      classThreshold: 0.5,
      smoothSlope: false,
      heightAxis: CSF_FIXED.heightAxis,
      entities: [
        { entityId: 1, chunks: chunksA },
        { entityId: 2, chunks: chunksB },
      ],
    }
    const native = await new Promise<Map<number, Uint32Array[]>>((resolve, reject) => {
      try {
        addon.compute(request, (err, results) => {
          if (err) reject(err)
          else {
            const map = new Map<number, Uint32Array[]>()
            for (const r of results ?? []) map.set(r.entityId, r.ground)
            resolve(map)
          }
        })
      } catch (e) {
        reject(e)
      }
    })
    const refA = csfJsReference(chunksA, {
      clothResolution: 2,
      rigidness: 2,
      iterations: 80,
      timeStep: CSF_FIXED.timeStep,
      classThreshold: 0.5,
      smoothSlope: false,
      heightAxis: CSF_FIXED.heightAxis,
    })
    const refB = csfJsReference(chunksB, {
      clothResolution: 2,
      rigidness: 2,
      iterations: 80,
      timeStep: CSF_FIXED.timeStep,
      classThreshold: 0.5,
      smoothSlope: false,
      heightAxis: CSF_FIXED.heightAxis,
    })
    expectMatchesReference(native.get(1)!, refA)
    expectMatchesReference(native.get(2)!, refB)
  })

  it('语义用例：平地 + 中央高台（凸起地物），native 输出符合 CSF 桌布效应', async () => {
    const rnd = mulberry32(51)
    const { positions, top, outside } = steppedCloud(rnd, 3000, 40)
    const ground = await computeNative([{ positions, index: null }], 1, {
      clothResolution: 2,
      iterations: 150,
      classThreshold: 0.5,
    })
    const groundSet = new Set(Array.from(ground[0]))
    const rate = (idx: number[]) => idx.filter((i) => groundSet.has(i)).length / idx.length
    // 台顶（凸起地物）：布料被台周平地撑起、悬在台顶上方未接触 → 判非地面
    // （这正是地面分割要剔除的建筑物/车辆等凸起物）
    expect(rate(top)).toBeLessThan(0.1)
    // 台外平地：布料贴合 → 绝大多数判地面
    expect(rate(outside)).toBeGreaterThan(0.95)
    // 参考实现同数据逐元素一致（哨兵防双实现同错）
    const ref = csfJsReference([{ positions, index: null }], {
      clothResolution: 2,
      rigidness: 2,
      iterations: 150,
      timeStep: CSF_FIXED.timeStep,
      classThreshold: 0.5,
      smoothSlope: false,
      heightAxis: CSF_FIXED.heightAxis,
    })
    expect(Array.from(ground[0])).toEqual(Array.from(ref[0]))
  })

  it('契约：带 index 时 ground 为候选子集内的顶点下标（顶点缓冲空间）', async () => {
    const rnd = mulberry32(61)
    const positions = terrainCloud(rnd, 1000, 20)
    const chunks = makeChunks(positions, 400, rnd, true)
    const ground = await computeNative(chunks, 1)
    for (let c = 0; c < chunks.length; c++) {
      const index = chunks[c].index!
      const cand = new Set(Array.from(index))
      for (const v of ground[c]) {
        expect(cand.has(v)).toBe(true) // ground 值必须是候选顶点
      }
      // 候选子集含整块 → 地面 + 非地面 = 全量候选（补集完备性由渲染侧推导，这里校验不漏算）
      expect(ground[c].length).toBeLessThanOrEqual(index.length)
    }
  })

  it('契约：布料分辨率非法（≤0）→ 地面为空（与 C++ 语义一致，非崩溃）', async () => {
    const rnd = mulberry32(71)
    const chunks = makeChunks(terrainCloud(rnd, 500, 20), 300, rnd, false)
    const ground = await computeNative(chunks, 1, { clothResolution: 0 })
    expect(ground.every((g) => g.length === 0)).toBe(true)
  })

  it('契约：空实体 / 无候选点 → 地面全空', async () => {
    const ground = await computeNative([], 1)
    expect(ground).toEqual([])
    const empty = await computeNative([{ positions: new Float32Array(0), index: null }], 1)
    expect(Array.from(empty[0])).toEqual([])
  })

  it('契约：分类阈值单调——阈值越大地面越多（同数据同参数）', async () => {
    const rnd = mulberry32(81)
    const chunks = makeChunks(terrainCloud(rnd, 1000, 20), 500, rnd, false)
    const [gTiny, gBig] = await Promise.all([
      computeNative(chunks, 1, { classThreshold: 0.05, iterations: 150 }),
      computeNative(chunks, 1, { classThreshold: 2.0, iterations: 150 }),
    ])
    const nTiny = gTiny.reduce((s, a) => s + a.length, 0)
    const nBig = gBig.reduce((s, a) => s + a.length, 0)
    expect(nTiny).toBeLessThan(nBig)
    expect(nBig).toBeGreaterThan(0)
  })
})
