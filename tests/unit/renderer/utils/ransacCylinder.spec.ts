import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  candidateCountOfChunk,
  classifyCylinder,
  estimateCylinderDefaults,
} from '../../../../src/renderer/utils/ransacCylinder'
import type {
  RansacCylinderAddon,
  RansacCylinderAxis,
  RansacCylinderChunkSource,
  RansacCylinderEntityResult,
  RansacCylinderRequest,
} from '../../../../src/renderer/utils/ransacCylinder'
import {
  NORMAL_MODEL_CODES,
  NORMAL_ORIENTATION_CODES,
  scatterNormalCodes,
} from '../../../../src/renderer/utils/normalEstimate'
import type {
  NormalEstimateAddon,
  NormalEstimateChunkSource,
  NormalEstimateEntityResult,
  NormalEstimateRequest,
} from '../../../../src/renderer/utils/normalEstimate'
import { encodeNormalCodes } from './normalCodesFixture'

// 纯函数（classifyCylinder / estimateCylinderDefaults）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。

/**
 * **2026-09 起轴方向不再由本模块现算**：请求要么显式给 `axis`（约束），要么每块带上
 * `normals`（法向量量化码，顶点缓冲空间）让 native 从法线估轴——两者都不给时绑定层同步抛
 * `TypeError`。故本文件里凡是不给 `axis` 的用例都必须喂法线，合成场景的法线由
 * `normalCodesFixture.ts` 的编码镜像编成码（解析已知 ⇒ 轴断言只含量化误差）。
 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/ransac-cylinder/build/Release/ransac_cylinder.node', import.meta.url)
)
/** `normal_estimate` 产物：端到端用例（真法线估计 → 圆柱拟合）要求两者都在。 */
const NORMAL_NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/normal-estimate/build/Release/normal_estimate.node', import.meta.url)
)
const nativeAvailable = existsSync(NATIVE_PATH) && existsSync(NORMAL_NATIVE_PATH)
const require = createRequire(import.meta.url)

/** 加载 native 产物（仅 nativeAvailable 时调用）。 */
function loadAddon(): RansacCylinderAddon {
  return require(NATIVE_PATH)
}

/** 加载法向量估计产物（仅 nativeAvailable 时调用）。 */
function loadNormalAddon(): NormalEstimateAddon {
  return require(NORMAL_NATIVE_PATH)
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
// 合成数据：倾斜圆柱 + 噪声 + 离群点
// ---------------------------------------------------------------------------

/**
 * 目标圆柱：轴 (0.3, -0.2, 0.93) 归一化、半径 2.5、轴上一点 (7, -3, 120)。
 *
 * 刻意非轴对齐（避免退化成 z 轴特例）、也非竖直（否则「水平/竖直」这类先验会顺手蒙对）；
 * 中心离原点远（120）而半径小（2.5）——这是刻意加难：用「到中心点的距离」这类错误判据
 * 会立刻露馅（点到中心的距离跨 118..122，而到轴的垂距恒在 2.5 附近）。
 */
const TRUTH_RAW = [0.3, -0.2, 0.93]
const TRUTH_AXIS = ((): [number, number, number] => {
  const len = Math.hypot(...TRUTH_RAW)
  return [TRUTH_RAW[0] / len, TRUTH_RAW[1] / len, TRUTH_RAW[2] / len]
})()
const TRUTH_CENTER: [number, number, number] = [7, -3, 120]
const TRUTH_RADIUS = 2.5

/** 圆柱面上的正交基（e1, e2 ⊥ 轴）。 */
function truthBasis(): { e1: [number, number, number]; e2: [number, number, number] } {
  const [ax, ay, az] = TRUTH_AXIS
  // e1 = a × z 归一化（a 非竖直，故叉积非零）
  const cx = ay * 1 - az * 0
  const cy = az * 0 - ax * 1
  const cz = ax * 0 - ay * 0
  const n1 = Math.hypot(cx, cy, cz)
  const e1: [number, number, number] = [cx / n1, cy / n1, cz / n1]
  // e2 = a × e1（已是单位向量）
  const e2: [number, number, number] = [ay * e1[2] - az * e1[1], az * e1[0] - ax * e1[2], ax * e1[1] - ay * e1[0]]
  return { e1, e2 }
}

/** 点到真值圆柱面的绝对偏差（独立于拟合结果计算，故断言不循环依赖）。 */
function truthDeviation(x: number, y: number, z: number): number {
  const [ax, ay, az] = TRUTH_AXIS
  const vx = x - TRUTH_CENTER[0]
  const vy = y - TRUTH_CENTER[1]
  const vz = z - TRUTH_CENTER[2]
  const wx = vy * az - vz * ay
  const wy = vz * ax - vx * az
  const wz = vx * ay - vy * ax
  return Math.abs(Math.hypot(wx, wy, wz) - TRUTH_RADIUS)
}

interface CloudSpec {
  positions: Float32Array
  /**
   * 逐点**解析法线**（扁平 xyz，与 positions 同序）：圆柱点 = 径向、离群点 = 球面均匀随机。
   *
   * 圆柱点的法线按**真值柱面**算（`n = (p − 轴上最近点)/r`），不是按点自身的半径——这些点
   * 本就是「真柱面 + 径向噪声」，真值法线才是它们应有的法线；噪声点若反过来按自身半径定法线，
   * 会把噪声当成几何、让轴估计凭空变简单。
   * 离群点给随机朝向（**不是**径向）：那才是外点的真实面目，也才对得上 README 里那条
   * 「各向同性污染不转动特征向量」的性质。故意不给"指向真轴的法线"——那等于送答案。
   */
  normals: Float32Array
  /** 真内点掩码：按「到真值圆柱面的实际偏差 ≤ 噪声幅度」判定，不是按构造意图。 */
  trueInlier: Uint8Array
  /** 到真值圆柱面偏差 > 20 × distanceThreshold 的远点（绝不该被拟合成内点）。 */
  farPoint: Uint8Array
  /** 真内点在轴向上的实际半跨度（中央范围，避开离群点污染，供 halfHeight 断言用）。 */
  trueHalfHeight: number
}

/**
 * 造「倾斜圆柱 + 均匀噪声 + 离群点」的合成云（含逐点解析法线，见 CloudSpec.normals）。
 *
 * 圆柱点：绕轴取随机角 θ、沿轴取随机位置 t，半径加均匀噪声 ±noiseSigma（径向）。
 * 离群点：在立方体内均匀散布（**不是**同心柱壳——否则等于人为送一个可分的第二圆柱）。
 */
function cylinderCloud(
  rand: () => number,
  cylinderPoints: number,
  outlierPoints: number,
  noiseSigma: number,
  length = 12,
  extent = 24,
  distanceThreshold = 0.02
): CloudSpec {
  const { e1, e2 } = truthBasis()
  const [ax, ay, az] = TRUTH_AXIS
  const total = cylinderPoints + outlierPoints
  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const trueInlier = new Uint8Array(total)
  const farPoint = new Uint8Array(total)
  let minT = Infinity
  let maxT = -Infinity
  for (let i = 0; i < total; i++) {
    let x: number
    let y: number
    let z: number
    if (i < cylinderPoints) {
      const theta = rand() * Math.PI * 2
      const t = (rand() - 0.5) * length
      const r = TRUTH_RADIUS + (rand() * 2 - 1) * noiseSigma
      minT = Math.min(minT, t)
      maxT = Math.max(maxT, t)
      const c1 = Math.cos(theta)
      const s1 = Math.sin(theta)
      x = TRUTH_CENTER[0] + t * ax + r * (c1 * e1[0] + s1 * e2[0])
      y = TRUTH_CENTER[1] + t * ay + r * (c1 * e1[1] + s1 * e2[1])
      z = TRUTH_CENTER[2] + t * az + r * (c1 * e1[2] + s1 * e2[2])
      // 解析径向（单位向量，与 r 无关；这就是真值柱面在这一点处的法线）
      normals[i * 3] = c1 * e1[0] + s1 * e2[0]
      normals[i * 3 + 1] = c1 * e1[1] + s1 * e2[1]
      normals[i * 3 + 2] = c1 * e1[2] + s1 * e2[2]
    } else {
      x = TRUTH_CENTER[0] + (rand() - 0.5) * extent
      y = TRUTH_CENTER[1] + (rand() - 0.5) * extent
      z = TRUTH_CENTER[2] + (rand() - 0.5) * extent
      // 球面均匀随机朝向（z 均匀、方位角均匀）
      const cz = rand() * 2 - 1
      const s = Math.sqrt(Math.max(0, 1 - cz * cz))
      const phi = rand() * Math.PI * 2
      normals[i * 3] = s * Math.cos(phi)
      normals[i * 3 + 1] = s * Math.sin(phi)
      normals[i * 3 + 2] = cz
    }
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    // 距离用 float32 舍入后的坐标算，与 native 读到的一致
    const dev = truthDeviation(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    trueInlier[i] = dev <= noiseSigma ? 1 : 0
    farPoint[i] = dev > 20 * distanceThreshold ? 1 : 0
  }
  return { positions, normals, trueInlier, farPoint, trueHalfHeight: (maxT - minT) / 2 }
}

/**
 * 把全长点数组切进 chunks，可选地对每块再挑一个「候选子集 index」（模拟分割产物）。
 *
 * `normals` 传了就把对应区间也切下来**编成量化码**（顶点缓冲空间：长度 = 该块顶点数，
 * 与 `index` 的候选子集无关——这正是 native 侧要的形态，`codes[index[k]]` 才是候选的法线）。
 */
function makeChunks(
  positions: Float32Array,
  chunkSize: number,
  rand: () => number,
  useIndex: boolean,
  normals?: Float32Array
): RansacCylinderChunkSource[] {
  const total = positions.length / 3
  const chunks: RansacCylinderChunkSource[] = []
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
    const codes = normals ? encodeNormalCodes(normals.subarray(start * 3, end * 3)) : null
    chunks.push({ positions: slice, index, normals: codes })
  }
  return chunks
}

/** 单块全量候选 + 该云解析法线的码（最常用的一行式构造）。 */
function wholeChunk(cloud: CloudSpec): RansacCylinderChunkSource[] {
  return [{ positions: cloud.positions, index: null, normals: encodeNormalCodes(cloud.normals) }]
}

/** 候选总数（无 index = 全量顶点数）。 */
function candidateTotal(chunks: RansacCylinderChunkSource[]): number {
  return chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
}

/** 「块内顶点下标」→ 全局候选序号（各块全量顶点时 = 块起点 + 顶点下标）。 */
function globalVertex(chunks: RansacCylinderChunkSource[], ci: number, vertex: number): number {
  let base = 0
  for (let c = 0; c < ci; c++) base += candidateCountOfChunk(chunks[c])
  return base + vertex
}

/** |cos∠|（轴与真值轴的夹角余弦绝对值；轴的正负号无意义）。 */
function axisCos(axis: { ax: number; ay: number; az: number }): number {
  return Math.abs(axis.ax * TRUTH_AXIS[0] + axis.ay * TRUTH_AXIS[1] + axis.az * TRUTH_AXIS[2])
}

// ---------------------------------------------------------------------------
// 纯函数：无需 native 产物，CI 也跑
// ---------------------------------------------------------------------------

describe('classifyCylinder（C++ classifyAll 判定式的逐位镜像）', () => {
  it('竖直轴：恰在阈值上判内点（≤ 阈值，边界相等保留）', () => {
    // 轴 = z、半径 1、轴上过原点：垂距 = √(x²+y²)
    const cyl = { cx: 0, cy: 0, cz: 0, ax: 0, ay: 0, az: 1, radius: 1 }
    const positions = new Float32Array([
      1,
      0,
      0, // 垂距 1 → 偏差 0
      1.02,
      0,
      0, // 垂距 1.02 → 偏差 0.02 = 阈值 → 内点
      0.98,
      0,
      0, // 垂距 0.98 → 偏差 0.02 = 阈值 → 内点
      1.021,
      0,
      0, // 偏差 0.021 > 阈值 → 剔除
      0,
      0,
      50, // 轴上的点：垂距 0，偏差 1 > 阈值 → 剔除
    ])
    const res = classifyCylinder([{ positions, index: null }], cyl, 0.02)
    expect(Array.from(res[0])).toEqual([0, 1, 2])
  })

  it('倾斜轴 + 带 index 的候选子集：只判候选、返回顶点下标、块内递增', () => {
    const { e1, e2 } = truthBasis()
    const [ax, ay, az] = TRUTH_AXIS
    const onSurface = (theta: number, t: number): [number, number, number] => [
      TRUTH_CENTER[0] + t * ax + TRUTH_RADIUS * (Math.cos(theta) * e1[0] + Math.sin(theta) * e2[0]),
      TRUTH_CENTER[1] + t * ay + TRUTH_RADIUS * (Math.cos(theta) * e1[1] + Math.sin(theta) * e2[1]),
      TRUTH_CENTER[2] + t * az + TRUTH_RADIUS * (Math.cos(theta) * e1[2] + Math.sin(theta) * e2[2]),
    ]
    const [p0, p1, p2] = [onSurface(0.3, -4), onSurface(1.7, 2.5), onSurface(4.1, 5)]
    const positions = new Float32Array([
      ...p0,
      ...p1,
      500,
      500,
      500, // 远点（顶点 2）
      ...p2,
      TRUTH_CENTER[0],
      TRUTH_CENTER[1],
      TRUTH_CENTER[2], // 轴上的点（顶点 4），不在候选里
    ])
    const index = new Uint32Array([0, 1, 2, 3])
    // 阈值取 1e-3 而非 1e-6：坐标经 float32 存储后的舍入（~1e-5 量级）会漏判
    const res = classifyCylinder(
      [{ positions, index }],
      {
        cx: TRUTH_CENTER[0],
        cy: TRUTH_CENTER[1],
        cz: TRUTH_CENTER[2],
        ax,
        ay,
        az,
        radius: TRUTH_RADIUS,
      },
      1e-3
    )
    expect(Array.from(res[0])).toEqual([0, 1, 3]) // 顶点 2 是远点、顶点 4 不在候选内
  })

  it('非正阈值按 0 处理：仅恰好落在圆柱面上的点判内点', () => {
    // 1e-6 而非更小的量：float32 在 1.0 附近的间隔是 2^-23 ≈ 1.19e-7，写 1+1e-9 会被
    // Float32Array **舍入成 1.0**（该点其实就在面上）——测阈值语义别用会被舍掉的偏移量。
    const positions = new Float32Array([1, 0, 0, 1 + 1e-6, 0, 0])
    const cyl = { cx: 0, cy: 0, cz: 0, ax: 0, ay: 0, az: 1, radius: 1 }
    expect(Array.from(classifyCylinder([{ positions, index: null }], cyl, 0)[0])).toEqual([0])
    // 负阈值同样按 0（C++ 与镜像一致地钳制），不是"负阈值 ⇒ 无内点"
    expect(Array.from(classifyCylinder([{ positions, index: null }], cyl, -5)[0])).toEqual([0])
  })

  it('空候选：逐块回空数组（块数与输入对齐）', () => {
    const res = classifyCylinder(
      [
        { positions: new Float32Array([5, 0, 0]), index: null },
        { positions: new Float32Array([1, 0, 0, 5, 0, 0]), index: new Uint32Array([]) },
      ],
      { cx: 0, cy: 0, cz: 0, ax: 0, ay: 0, az: 1, radius: 1 },
      0.01
    )
    expect(res).toHaveLength(2)
    expect(res[0]).toHaveLength(0)
    expect(res[1]).toHaveLength(0)
  })
})

describe('estimateCylinderDefaults', () => {
  it('距离阈值 = 平均点距 × 2；迭代 1000、默认开启系数优化、半径不限', () => {
    const d = estimateCylinderDefaults(1000, { x: 10, y: 10, z: 10 })
    // 体积密度 cbrt(1000/1000) = 1
    expect(d.distanceThreshold).toBeCloseTo(2, 6)
    expect(d.maxIterations).toBe(1000)
    expect(d.optimizeCoefficients).toBe(true)
    // 半径无法从点数/包围盒推出来，默认必须"不限制"（0），否则假设会被乱滤掉
    expect(d.minRadius).toBe(0)
    expect(d.maxRadius).toBe(0)
  })

  it('退化输入（点数 < 2）不返回 0 阈值（0 = 无内点，功能会哑火）', () => {
    expect(estimateCylinderDefaults(1, { x: 0, y: 0, z: 0 }).distanceThreshold).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// C++ 正确性对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------

describe.skipIf(!nativeAvailable)('ransac_cylinder.node 契约、质量、轴方向与确定性', () => {
  let addon: RansacCylinderAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 compute。 */
  function computeNative(req: RansacCylinderRequest): Promise<RansacCylinderEntityResult[]> {
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

  it('native 回传的 cylinder 用 JS classifyCylinder 重判，与回传 inliers 逐位相等（多组参数）', async () => {
    // 这条断言同时验证：契约字段语义、索引空间（顶点缓冲而非候选序号）、递增性、逐块对齐，
    // 且不依赖 PRNG 或 log（故可要求逐位相等，而不是"近似"）。
    // 若将来它只在最后几个 ulp 上失败：先查 C++ 是否被加了 /arch:AVX2 或 /fp:fast —— FMA
    // 收缩会把垂距的求值精度改掉（vx/vy/vz → 叉积 → 平方和开方），镜像式便不再逐位成立。
    const cases = [
      {
        seed: 31,
        cylPoints: 6000,
        outPoints: 1500,
        noiseSigma: 0.005,
        chunkSize: 2000,
        useIndex: true,
        threshold: 0.02,
        maxIter: 1000,
        optimize: true,
        axis: null as RansacCylinderAxis | null,
      },
      {
        seed: 32,
        cylPoints: 4000,
        outPoints: 4000,
        noiseSigma: 0.01,
        chunkSize: 2500,
        useIndex: false,
        threshold: 0.03,
        maxIter: 500,
        optimize: false,
        axis: null,
      },
      {
        seed: 33,
        cylPoints: 3000,
        outPoints: 500,
        noiseSigma: 0.001,
        chunkSize: 900,
        useIndex: true,
        threshold: 0.002,
        maxIter: 1000,
        optimize: true,
        axis: { x: TRUTH_AXIS[0], y: TRUTH_AXIS[1], z: TRUTH_AXIS[2] }, // 显式轴：走另一条分支
      },
      {
        seed: 34,
        cylPoints: 5000,
        outPoints: 0,
        noiseSigma: 0.005,
        chunkSize: 3000,
        useIndex: false,
        threshold: 1e6,
        maxIter: 200,
        optimize: true,
        axis: null, // 阈值巨大：全为内点
      },
    ]
    for (const c of cases) {
      const rand = mulberry32(c.seed)
      const cloud = cylinderCloud(rand, c.cylPoints, c.outPoints, c.noiseSigma, 12, 24, c.threshold)
      const chunks = makeChunks(cloud.positions, c.chunkSize, rand, c.useIndex, cloud.normals)
      const results = await computeNative({
        distanceThreshold: c.threshold,
        maxIterations: c.maxIter,
        optimizeCoefficients: c.optimize,
        axis: c.axis,
        entities: [{ entityId: 1, chunks }],
      })
      const r = results[0]
      expect(r.entityId).toBe(1)
      expect(r.inliers, `[case seed=${c.seed}] 块数对齐`).toHaveLength(chunks.length)
      expect(r.cylinder, `[case seed=${c.seed}] 应拟合出圆柱`).not.toBeNull()

      const mirrored = classifyCylinder(chunks, r.cylinder!, c.threshold)
      mirrored.forEach((arr, ci) => {
        expect(Array.from(arr), `[case seed=${c.seed} 块 ${ci}] 逐位一致`).toEqual(Array.from(r.inliers[ci]))
      })
      // 内点数与契约字段自洽
      const total = r.inliers.reduce((s, a) => s + a.length, 0)
      expect(total, `[case seed=${c.seed}] inlierCount 与索引总数一致`).toBe(r.cylinder!.inlierCount)
      // 每块严格递增（顶点缓冲空间）
      for (const arr of r.inliers) {
        for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThan(arr[i - 1])
      }
    }
  })

  it('sampleCount = min(候选数, 65536)；iterationsUsed ≤ maxIterations', async () => {
    const rand = mulberry32(41)
    const cloud = cylinderCloud(rand, 5000, 0, 0.005)
    const chunks = makeChunks(cloud.positions, 2500, rand, false, cloud.normals)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks }],
    })
    expect(r.cylinder!.sampleCount).toBe(candidateTotal(chunks))
    expect(r.cylinder!.iterationsUsed).toBeGreaterThan(0)
    expect(r.cylinder!.iterationsUsed).toBeLessThanOrEqual(1000)
  })

  // ---- 组 2：圆柱质量与轴方向（"有效分割"的核心承诺） ----

  it('斜面圆柱 + 噪声 + 大块离群点：轴方向/半径复原、真内点几乎全收、远点全排除', async () => {
    const rand = mulberry32(51)
    const cloud = cylinderCloud(rand, 12000, 6000, 0.005, 12, 24, 0.02)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    const model = r.cylinder!
    // 轴方向：1−cos ≤ 1e-6 即偏差 ≤ 0.081°。这不是拍脑袋的紧：目标圆柱半长 6，轴偏 δ 会让端部
    // 偏差 ≈ 6δ，要端部点仍进 0.02 阈值就必须 δ ≤ 0.0033 rad = 0.19°——下面"漏收真内点 ≤ 1%"的
    // 断言本就隐含了这一点，这里只是把它显式化。（曾写成 1e-5 = 0.26°，比完整性断言还松，于是
    // 采样集含重复点导致的 0.5° 轴偏差照样绿。）
    // 2026-09 起法线由调用方提供（这里喂的是解析真值编成的量化码），轴估计只剩量化误差（~0.5°/√N）
    // 而不再叠加"现算 PCA 法线"的 1° 误差，故这条容差比过去更干净地可达。
    expect(axisCos(model), '轴方向与真值一致').toBeGreaterThan(1 - 1e-6)
    expect(Math.abs(model.radius - TRUTH_RADIUS), '半径复原').toBeLessThan(0.01)
    // 中心必须落在轴上：到真值轴的垂距 ≈ 0（轴向位置随内点范围浮动，不做断言）
    const vx = model.cx - TRUTH_CENTER[0]
    const vy = model.cy - TRUTH_CENTER[1]
    const vz = model.cz - TRUTH_CENTER[2]
    const wxc = vy * TRUTH_AXIS[2] - vz * TRUTH_AXIS[1]
    const wyc = vz * TRUTH_AXIS[0] - vx * TRUTH_AXIS[2]
    const wzc = vx * TRUTH_AXIS[1] - vy * TRUTH_AXIS[0]
    expect(Math.hypot(wxc, wyc, wzc), '几何中心落在轴上').toBeLessThan(0.02)
    // 半高 = **内点集**的轴向跨度之半（不是圆柱本身的几何长度）：真内点全被收 ⇒ 至少覆盖真跨度；
    // 上界不断言——均匀撒在立方体里的离群点会偶然落进阈值薄壳，其轴向位置是任意的，会把跨度外扩
    // （实测 6.0 → 9.7，正是"被吸收的离群点"而非拟合失误）。无离群点时的紧上界见 70000 点那条。
    expect(model.halfHeight).toBeGreaterThan(cloud.trueHalfHeight * 0.95)
    // 完备性：真内点几乎全部被收（允许 1% 因阈值边界浮动）
    const found = new Set<number>(Array.from(r.inliers[0]))
    let missed = 0
    let trueCount = 0
    for (let i = 0; i < cloud.trueInlier.length; i++) {
      if (!cloud.trueInlier[i]) continue
      trueCount++
      if (!found.has(i)) missed++
    }
    expect(trueCount).toBeGreaterThan(10000)
    expect(missed, '漏收的真内点数').toBeLessThanOrEqual(trueCount * 0.01)
    // 排他性：离圆柱面 20 × 阈值之外的远点一个都不能进
    for (let i = 0; i < cloud.farPoint.length; i++) {
      if (cloud.farPoint[i]) expect(found.has(i), `远点 ${i} 不应进内点集`).toBe(false)
    }
    // 圆柱度指标自洽
    expect(model.rms).toBeLessThanOrEqual(0.02)
    expect(model.maxDeviation).toBeLessThanOrEqual(0.02)
    expect(model.maxDeviation).toBeGreaterThanOrEqual(model.rms)
  })

  it('短粗圆柱（长 = 半径）：靠法线的轴估计仍准（协方差特征值差会在此类形状上退化）', async () => {
    // 长 5、半径 2.5：轴向方差与径向方差同量级，任何"投影协方差特征值之差"式的轴估计器都会
    // 在此给出带伪零点的方向；本模块的轴来自表面法线，与长径比无关。这是该设计选择的回归防线。
    const rand = mulberry32(55)
    const cloud = cylinderCloud(rand, 15000, 0, 0.005, 5, 24, 0.02)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    expect(r.cylinder).not.toBeNull()
    expect(axisCos(r.cylinder!), '短粗圆柱的轴方向仍准确').toBeGreaterThan(1 - 1e-6)
    expect(Math.abs(r.cylinder!.radius - TRUTH_RADIUS)).toBeLessThan(0.02)
  })

  it('小云（点数 < 采样上限）：采样不放回，轴不被重复点打偏', async () => {
    // 回归防线：采样集曾用"有放回"抽取，点云本身不足 65536 时平均每个点被抽中 33 次。
    // 当初的病灶是"现算局部法线"（重复点间距为 0 ⇒ 局部协方差退化成矩阵 ⇒ 法线误差 1°→50°），
    // 那段 2026-09 已删除；但**不放回本身照旧保留**：重复点会让"3 点定圆"抽到同一位置的三点而
    // 空转（浪费轮数），采样集也该覆盖不同表面位置而不是同一点的多次副本。故这条断言不变。
    const rand = mulberry32(56)
    const cloud = cylinderCloud(rand, 2000, 0, 0.005, 12, 24, 0.02)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    expect(r.cylinder).not.toBeNull()
    expect(axisCos(r.cylinder!), '小云也要估准轴方向').toBeGreaterThan(1 - 1e-3)
  })

  it('轴方向语义：自动估计置 axisEstimated=true，显式给定则不重估（原样归一化回传）', async () => {
    const rand = mulberry32(57)
    const cloud = cylinderCloud(rand, 4000, 500, 0.005, 12, 24, 0.02)
    const chunks: RansacCylinderChunkSource[] = wholeChunk(cloud)
    const base = { distanceThreshold: 0.02, maxIterations: 1000, optimizeCoefficients: true }

    const [auto] = await computeNative({ ...base, entities: [{ entityId: 1, chunks }] })
    expect(auto.cylinder!.axisEstimated).toBe(true)
    expect(axisCos(auto.cylinder!)).toBeGreaterThan(1 - 1e-5)

    const [given] = await computeNative({
      ...base,
      axis: { x: TRUTH_AXIS[0], y: TRUTH_AXIS[1], z: TRUTH_AXIS[2] },
      entities: [{ entityId: 1, chunks }],
    })
    expect(given.cylinder!.axisEstimated).toBe(false)
    expect(axisCos(given.cylinder!)).toBeGreaterThan(1 - 1e-12)

    // 显式轴是**约束不是初值**：给一个明显倾斜的方向，回包必须原样保留它（+ 统一符号），
    // 绝不能"顺手改回真值"——那样这篇文章的 Axis 参数就失去意义了
    const tilted: RansacCylinderAxis = { x: 0.3, y: -0.2, z: 0.5 }
    const tlen = Math.hypot(tilted.x, tilted.y, tilted.z)
    const [kept] = await computeNative({ ...base, axis: tilted, entities: [{ entityId: 1, chunks }] })
    expect(kept.cylinder).not.toBeNull()
    const cosTilted = Math.abs(
      (kept.cylinder!.ax * tilted.x + kept.cylinder!.ay * tilted.y + kept.cylinder!.az * tilted.z) / tlen
    )
    expect(cosTilted, '用户给的轴方向被原样使用').toBeGreaterThan(1 - 1e-12)
  })

  it('显式轴 = 真值时不碰方向也能拟合出圆柱，且系数优化不会把方向改掉', async () => {
    const rand = mulberry32(58)
    const cloud = cylinderCloud(rand, 4000, 1000, 0.005, 12, 24, 0.02)
    const chunks: RansacCylinderChunkSource[] = wholeChunk(cloud)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      axis: { x: TRUTH_AXIS[0], y: TRUTH_AXIS[1], z: TRUTH_AXIS[2] },
      entities: [{ entityId: 1, chunks }],
    })
    expect(axisCos(r.cylinder!)).toBeGreaterThan(1 - 1e-12)
    expect(Math.abs(r.cylinder!.radius - TRUTH_RADIUS)).toBeLessThan(0.01)
  })

  it('候选全部为内点时 inlierCount > sampleCount（第二趟全量扫描）且采样不放回（轴不被重复点带偏）', async () => {
    // 点数刻意超过自动采样上限 65536：若实现偷懒只在采样集上判内点，1 亿点的云只能分出
    // 6.5 万个点——这是本模块与"教科书 RANSAC"最实质的差别，必须有回归防线。
    //
    // 这条同时是"采样必须不放回"的回归防线（它是当初发现该缺陷的那条）：候选 70000 > 上限 65536
    // 时若**有放回**抽取，约 35% 的槽位是重复点。当年重复点间距为 0 会把局部协方差压成退化矩阵、
    // 轴偏 0.5° ⇒ 端部偏差 6×0.0086 ≈ 0.05 > 阈值 ⇒ 只收到 58809 个点（丢 16%）；局部法线那段
    // 2026-09 已随法线改为入参而删除，但**不放回照旧**（重复点让 3 点定圆空转、采样集应代表不同
    // 表面位置），故这条断言与它的紧度都保留：采样集大小恰好是上限、且**全部** 70000 点都被收为内点。
    const rand = mulberry32(61)
    const cloud = cylinderCloud(rand, 70000, 0, 0.005, 12, 24, 0.02)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    const model = r.cylinder!
    expect(model.sampleCount).toBe(65536)
    expect(model.inlierCount).toBeGreaterThan(65536)
    // 一个都不该丢（实测 70000/70000）：径向噪声只有 ±0.005，离 0.02 的阈值还有 4 倍余量，
    // 唯一能把点甩出去的就是模型本身偏了。这条同时是**精修（系数优化）是否真在干活**的哨兵：
    // 2026-09 修 Kåsa 半径回代的符号错误之前，精修恒 return false、"保留上一版模型" ⇒ 这里只有
    // 68983（粗定三元组的圆心偏 1.4e-2，把两端各削掉一片）。
    expect(model.inlierCount, '无离群点时真内点一个都不该丢').toBe(70000)
    expect(axisCos(model), '轴偏差必须小到端部点仍在阈值内').toBeGreaterThan(1 - 1e-6)
    // 无离群点 ⇒ 内点轴向跨度就是真跨度，可以给**紧的双边界**（有离群点的那条只能给下界）
    expect(model.halfHeight).toBeGreaterThan(5.9)
    expect(model.halfHeight).toBeLessThan(6.05)
  })

  it('圆柱只占少数（25%）时仍能被找出，且内点全部落在该圆柱面上', async () => {
    const rand = mulberry32(71)
    const cloud = cylinderCloud(rand, 2500, 7500, 0.005, 12, 24, 0.02)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    expect(r.cylinder).not.toBeNull()
    expect(axisCos(r.cylinder!), '少数派圆柱仍被正确找出（不是被离群点带偏的次优解）').toBeGreaterThan(1 - 1e-4)
    const found = new Set<number>(Array.from(r.inliers[0]))
    for (let i = 0; i < cloud.farPoint.length; i++) {
      if (cloud.farPoint[i]) expect(found.has(i)).toBe(false)
    }
  })

  // ---- 组 2.5：地面主导场景（2026-09 判据修正的回归防线） ----
  //
  // 旧判据按「票数 argmax」排序，而平面的法线**垂直于该平面内的任何方向** ⇒ 每个躺在地面里的
  // 方向都免费拿走全部地面法线的票（≈90%），真轴反而票少；叠加 w² 早停（票数占比 0.9）第 2~3 轮
  // 就 break，连"管壁 × 管壁"的对子都抽不到。实测轴偏 72~90°、拟出半径上万/内点五万的假圆柱。
  // 修法：候选按「票数占比 × 一致法线各向异性比 λ_mid/λ_max」排序——地面法线只有一个方向
  // （比值 ≈ 0），柱面径向法线在 ⊥ 轴面内各向同性（比值 ≈ 1）。**下面这组在旧判据下必红。**
  // 另一条同样贵的教训：只把法线来源换成"更好的"（真法线）而判据不动，精度一点也不改善。

  /**
   * 造「水平地面 + 圆柱」：地面点撒在 z ≈ 0 的方格内、法线统一 +Z（平面就是这样）；
   * 圆柱点按给定轴解析生成、法线取真值径向（再编码成量化码喂给 native）。
   *
   * 圆柱穿地面而过（一半在 z<0）是刻意的：真实扫描里埋在地下的那半看不见，但这里留着不影响
   * 任何结论——轴估计只看法线方向，不看点在轴的哪一侧。
   */
  function groundPipeScene(
    rand: () => number,
    groundCount: number,
    pipeCount: number,
    axisRaw: [number, number, number],
    radius: number
  ): { positions: Float32Array; normals: Float32Array; axis: [number, number, number] } {
    const norm = Math.hypot(axisRaw[0], axisRaw[1], axisRaw[2])
    const a: [number, number, number] = [axisRaw[0] / norm, axisRaw[1] / norm, axisRaw[2] / norm]
    const ref: [number, number, number] = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const c1: [number, number, number] = [
      a[1] * ref[2] - a[2] * ref[1],
      a[2] * ref[0] - a[0] * ref[2],
      a[0] * ref[1] - a[1] * ref[0],
    ]
    const n1 = Math.hypot(c1[0], c1[1], c1[2])
    const e1: [number, number, number] = [c1[0] / n1, c1[1] / n1, c1[2] / n1]
    const e2: [number, number, number] = [
      a[1] * e1[2] - a[2] * e1[1],
      a[2] * e1[0] - a[0] * e1[2],
      a[0] * e1[1] - a[1] * e1[0],
    ]
    const total = groundCount + pipeCount
    const positions = new Float32Array(total * 3)
    const normals = new Float32Array(total * 3)
    const half = 12
    const length = 12
    for (let i = 0; i < total; i++) {
      if (i < groundCount) {
        positions[i * 3] = (rand() * 2 - 1) * half
        positions[i * 3 + 1] = (rand() * 2 - 1) * half
        positions[i * 3 + 2] = (rand() * 2 - 1) * 1e-3 // 极薄的一层，法线仍是干净的 +Z
        normals[i * 3 + 2] = 1
      } else {
        const theta = rand() * Math.PI * 2
        const t = (rand() - 0.5) * length
        const co = Math.cos(theta)
        const si = Math.sin(theta)
        positions[i * 3] = t * a[0] + radius * (co * e1[0] + si * e2[0])
        positions[i * 3 + 1] = t * a[1] + radius * (co * e1[1] + si * e2[1])
        positions[i * 3 + 2] = t * a[2] + radius * (co * e1[2] + si * e2[2])
        normals[i * 3] = co * e1[0] + si * e2[0]
        normals[i * 3 + 1] = co * e1[1] + si * e2[1]
        normals[i * 3 + 2] = co * e1[2] + si * e2[2]
      }
    }
    return { positions, normals, axis: a }
  }

  it('地面 + 管（竖直/倾斜 × 10%/30%、水平 × 30%）：定出真轴、半径复原、收全管壁点', async () => {
    const cases: { name: string; axis: [number, number, number]; share: number }[] = [
      { name: '竖直', axis: [0, 0, 1], share: 0.1 },
      { name: '竖直', axis: [0, 0, 1], share: 0.3 },
      { name: '倾斜', axis: [0.3, -0.2, 0.93], share: 0.1 },
      { name: '倾斜', axis: [0.3, -0.2, 0.93], share: 0.3 },
      { name: '水平', axis: [1, 0, 0], share: 0.3 },
    ]
    const PIPE_RADIUS = 0.3
    let seed = 200
    for (const c of cases) {
      const rand = mulberry32(seed++)
      const groundCount = 24000
      const pipeCount = Math.round((groundCount * c.share) / (1 - c.share))
      const scene = groundPipeScene(rand, groundCount, pipeCount, c.axis, PIPE_RADIUS)
      const [r] = await computeNative({
        distanceThreshold: 0.02,
        maxIterations: 1000,
        optimizeCoefficients: true,
        entities: [
          {
            entityId: 1,
            chunks: [{ positions: scene.positions, index: null, normals: encodeNormalCodes(scene.normals) }],
          },
        ],
      })
      const tag = `[${c.name}管 ${c.share * 100}%]`
      expect(r.cylinder, `${tag} 应拟合出圆柱`).not.toBeNull()
      const model = r.cylinder!
      // 1−cos ≤ 4e-4 ⇒ 轴偏 ≤ 1.6°。地面主导下旧判据是 72~90°，差两个数量级；
      // 这里不写更紧是因为**粗定阶段的轴只到 1° 量级**（投票来自成对法线的叉积 + 量化码），
      // 真正把轴收紧的是紧随其后的内点精修——下面的半径与完整性断言才是精度的实际把关。
      const cos = Math.abs(model.ax * scene.axis[0] + model.ay * scene.axis[1] + model.az * scene.axis[2])
      expect(cos, `${tag} 轴方向与真值一致`).toBeGreaterThan(1 - 4e-4)
      // 半径实测：竖直 0.3000、倾斜 0.2928、水平 0.3002（容差 0.02 覆盖倾斜那条的 0.007）
      expect(Math.abs(model.radius - PIPE_RADIUS), `${tag} 半径复原`).toBeLessThan(0.02)
      // 得分 = 票数占比 × 各向异性比：真轴的票全来自管壁（占比 ≈ share），比值 ≈ 1。
      // 这条同时是轴路径"可见性"的回归：它必须明显高于认轴闸门 0.02。
      expect(model.axisScore, `${tag} 轴得分应反映管壁占比`).toBeGreaterThan(c.share * 0.5)
      // 管壁点几乎全收（地面点偶然落进薄壳的不算）；漏收率高 ⇒ 轴偏大 ⇒ 端部点被阈值甩掉
      const found = new Set<number>(Array.from(r.inliers[0]))
      let missed = 0
      for (let i = groundCount; i < groundCount + pipeCount; i++) if (!found.has(i)) missed++
      expect(missed / pipeCount, `${tag} 漏收的管壁点占比`).toBeLessThan(0.02)
    }
  })

  it('水平管的低占比：地面会被"超大半径圆柱"吞掉——轴仍然对，靠 maxRadius 才拿回半径', async () => {
    // **已知局限，不是轴的问题**：轴一旦与地面平行，地面就落在"半径 R→∞ 的圆柱"的切平面上，
    // 而平地上任意三点定出的正是这样一个超大圆。地面点数占绝对多数时它按**内点数**合法胜出
    // （实测 R=1085/2970，吞掉 5300~5462 个地面点，而真圆只有 2667 个管壁点）。
    // 缓解手段与 PCL 一致：给 RadiusLimits（用户界面上的"半径上下限"）。这条用例把两面都钉住——
    // ① 轴方向仍然定得对（本次修的是判据，不是这个几何简并）；
    // ② 加上 maxRadius 之后真管壁点一个不少地收回。
    const rand = mulberry32(260)
    const groundCount = 24000
    const pipeCount = Math.round((groundCount * 0.1) / 0.9)
    const scene = groundPipeScene(rand, groundCount, pipeCount, [1, 0, 0], 0.3)
    const chunks = [{ positions: scene.positions, index: null, normals: encodeNormalCodes(scene.normals) }]
    const base = { distanceThreshold: 0.02, maxIterations: 1000, optimizeCoefficients: true }

    const [unbounded] = await computeNative({ ...base, entities: [{ entityId: 1, chunks }] })
    expect(unbounded.cylinder).not.toBeNull()
    const cos = Math.abs(
      unbounded.cylinder!.ax * scene.axis[0] +
        unbounded.cylinder!.ay * scene.axis[1] +
        unbounded.cylinder!.az * scene.axis[2]
    )
    expect(cos, '轴方向仍与真值一致（问题在半径，不在判据）').toBeGreaterThan(1 - 4e-4)
    expect(unbounded.cylinder!.radius, '无半径上限时胜出的是贴地的大半径圆柱').toBeGreaterThan(50)

    const [bounded] = await computeNative({
      ...base,
      minRadius: 0.05,
      maxRadius: 1,
      entities: [{ entityId: 1, chunks }],
    })
    expect(Math.abs(bounded.cylinder!.radius - 0.3), '限定半径后拿回真管').toBeLessThan(0.02)
    // 完整性在这里只能给**上界**：管壁点约收 2/3，两端各被削掉一段。原因是粗定轴偏 0.43°
    // （投票来自成对法线的叉积），而 12 m 长的管在 0.02 阈值下只容得下 |轴偏| ≤ 0.02/6 = 0.19°
    // （见上面"端部偏差 = 轴角 × 半长"那段推算）⇒ |t| ≳ 2.7 m 的端部点被甩出阈值。
    // 精修本来该收掉这 0.43°，但此场景的内点里 95% 是地面点，`refineAxisFromInliers` 的一致集
    // 被平面法线淹没（平面法线的二阶矩最小特征向量与真轴无关）⇒ 精修被 max-内点规则否掉。
    // 这是"地面主导 + 轴平行于地面"这一简并场景的既定代价，与本次判据修正无关（轴方向本身是对的）。
    const found = new Set<number>(Array.from(bounded.inliers[0]))
    let collected = 0
    for (let i = groundCount; i < groundCount + pipeCount; i++) if (found.has(i)) collected++
    expect(collected / pipeCount, '管壁点至少收到 2/3（两端各被削一段）').toBeGreaterThan(0.6)
  })

  it('纯地面（法线全指向 +Z）：得分 0 ⇒ 判未找到，不再凭空造一个超大半径的假圆柱', async () => {
    // 平面法线只有一个方向 ⇒ 一致法线的 λ_mid = 0 ⇒ 任何候选轴的得分都是 0 < 闸门 0.02。
    // 旧实现会给出一个噪声方向（实测半径 13665、内点 54009/60000），用户看到的是"拟合成功"。
    const rand = mulberry32(300)
    const scene = groundPipeScene(rand, 12000, 0, [0, 0, 1], 0.3)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [
        {
          entityId: 1,
          chunks: [{ positions: scene.positions, index: null, normals: encodeNormalCodes(scene.normals) }],
        },
      ],
    })
    expect(r.cylinder).toBeNull()
    expect(r.inliers[0]).toHaveLength(0)
  })

  it('显式轴不需要法线：竖直/自定义这几档在没算法线的点云上照常可用', async () => {
    // 「用实体法向量」没法线时是软堵（UI 禁用预览），但另外三档不该被连坐——
    // 这条钉住 native 侧的契约：给 axis 时 `normals` 可整个省略。
    const rand = mulberry32(301)
    const cloud = cylinderCloud(rand, 3000, 300, 0.005, 12, 24, 0.02)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 500,
      optimizeCoefficients: true,
      axis: { x: TRUTH_AXIS[0], y: TRUTH_AXIS[1], z: TRUTH_AXIS[2] },
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }],
    })
    expect(r.cylinder).not.toBeNull()
    expect(r.cylinder!.axisEstimated).toBe(false)
    expect(axisCos(r.cylinder!)).toBeGreaterThan(1 - 1e-12)
  })

  it('没给 axis 又没给 normals：同步抛 TypeError；normals 长度不符同样抛', () => {
    const cloud = cylinderCloud(mulberry32(401), 200, 0, 0.005)
    const base = { distanceThreshold: 0.02, maxIterations: 10, optimizeCoefficients: true }
    // 自动模式缺法线：干净失败（否则 native 只能静默返回"未找到"，用户查不出原因）
    expect(() =>
      addon.compute(
        { ...base, entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null }] }] },
        () => {}
      )
    ).toThrow(TypeError)
    // 法线是**顶点缓冲空间**：长度必须等于该块顶点数，差一个都算契约违约
    expect(() =>
      addon.compute(
        {
          ...base,
          entities: [
            {
              entityId: 1,
              chunks: [
                { positions: cloud.positions, index: null, normals: new Uint16Array(cloud.positions.length / 3 - 1) },
              ],
            },
          ],
        },
        () => {}
      )
    ).toThrow(TypeError)
  })

  it('端到端：真 normal_estimate 产物算出的法线 → 圆柱拟合（钉住用户真实流程）', async () => {
    // 这是用户的实际路径：Edit ▸ Normals ▸ Compute normals → 圆柱拟合的「用实体法向量」。
    // 与上面各条的区别是法线**不是解析真值**，而是 LS 平面拟合 + 量化码的真实产物
    // （含遮蔽/稀疏处的空码）——轴断言因此放宽到 0.06°，半径与完整性维持紧口径。
    const normalAddon = loadNormalAddon()
    const rand = mulberry32(501)
    const cloud = cylinderCloud(rand, 12000, 0, 0.005, 12, 24, 0.02)
    const chunks: NormalEstimateChunkSource[] = [{ positions: cloud.positions, index: null }]
    const results = await new Promise<NormalEstimateEntityResult[]>((resolve, reject) => {
      try {
        normalAddon.computeNormals(
          {
            radius: 0.3, // ≈ 2.4 × 平均点距（云密度 63 点/m²），球内约 15 个邻居
            model: NORMAL_MODEL_CODES.ls,
            orientation: NORMAL_ORIENTATION_CODES.undefined, // 不做定向：轴估计对法线符号不敏感
            entities: [{ entityId: 1, chunks }],
          } as NormalEstimateRequest,
          (err, res) => (err ? reject(err) : resolve(res ?? []))
        )
      } catch (e) {
        reject(e) // 入参非法时绑定层同步抛错
      }
    })
    const [est] = results
    // 法线覆盖率：这正是 UI 侧 CYLINDER_MIN_NORMAL_COVERAGE（0.5）那道前置检查的现实样本
    expect(est.nullCount / (est.computed + est.nullCount), '空码占比').toBeLessThan(0.05)
    // 摊成顶点缓冲空间（无 index 的块走零拷贝快路径），与 store 侧 getNormalCodeChunks 的产物同形态
    const perVertex = scatterNormalCodes(chunks, est.codes)
    expect(perVertex[0]).toHaveLength(cloud.positions.length / 3)

    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions: cloud.positions, index: null, normals: perVertex[0] }] }],
    })
    expect(r.cylinder, '真法线驱动下应拟合出圆柱').not.toBeNull()
    const model = r.cylinder!
    expect(model.axisEstimated).toBe(true)
    expect(axisCos(model), '轴方向与真值一致').toBeGreaterThan(1 - 2e-5)
    expect(Math.abs(model.radius - TRUTH_RADIUS), '半径复原').toBeLessThan(0.02)
    expect(model.axisScore, '轴得分应接近满值（法线全是柱面径向）').toBeGreaterThan(0.5)
  })

  // ---- 组 3：半径约束（文章的 RadiusLimits） ----

  it('半径范围的过滤语义：包含真值时结果不变；排除真值时真圆柱不再出现（支撑崩塌）', async () => {
    const rand = mulberry32(75)
    const cloud = cylinderCloud(rand, 4000, 1000, 0.005, 12, 24, 0.02)
    const chunks: RansacCylinderChunkSource[] = wholeChunk(cloud)
    const base = { distanceThreshold: 0.02, maxIterations: 1000, optimizeCoefficients: true }

    const [inRange] = await computeNative({
      ...base,
      minRadius: 2.0,
      maxRadius: 3.0,
      entities: [{ entityId: 1, chunks }],
    })
    expect(inRange.cylinder).not.toBeNull()
    expect(Math.abs(inRange.cylinder!.radius - TRUTH_RADIUS)).toBeLessThan(0.01)

    // 排除真值（2.5 不在 10~20 内）：**不能断言"必然 null"**——平面上任意三点定出一个大圆，
    // 半径 10~20 的圆柱只要有一条生成线贴着真圆柱面擦过，就能收到一小片弧形内点（实测 254 个，
    // 半径 14.6）。那不是缺陷：低支撑的伪圆柱在预览里一看便知，用户不会确认。要断言的是
    // 「真圆柱确实被限住了」——支撑数与在界内时相比崩塌，且半径落在界内。
    const [outOfRange] = await computeNative({
      ...base,
      minRadius: 10,
      maxRadius: 20,
      entities: [{ entityId: 1, chunks }],
    })
    const spurious = outOfRange.cylinder
    if (spurious) {
      expect(spurious.radius).toBeGreaterThanOrEqual(10)
      expect(spurious.radius).toBeLessThanOrEqual(20)
      expect(spurious.inlierCount, '伪圆柱支撑远低于真圆柱').toBeLessThan(inRange.cylinder!.inlierCount * 0.2)
    }
    expect(Math.abs((spurious?.radius ?? 0) - TRUTH_RADIUS), '真半径的圆柱不得出现在结果里').toBeGreaterThan(1)

    // ≤ 0 / 缺省 = 不限制（负值不报错，按不限处理）
    const [unlimited] = await computeNative({
      ...base,
      minRadius: -5,
      maxRadius: 0,
      entities: [{ entityId: 1, chunks }],
    })
    expect(unlimited.cylinder).not.toBeNull()
    expect(Math.abs(unlimited.cylinder!.radius - TRUTH_RADIUS)).toBeLessThan(0.01)
  })

  // ---- 组 4：确定性（预览不跳变的基础） ----

  it('同输入连续两次调用：inliers 与 cylinder 完全一致（固定种子 + 固定归约顺序）', async () => {
    const rand = mulberry32(81)
    const cloud = cylinderCloud(rand, 5000, 2000, 0.005, 12, 24, 0.02)
    const chunks = makeChunks(cloud.positions, 1500, rand, true, cloud.normals)
    const req: RansacCylinderRequest = {
      distanceThreshold: 0.02,
      maxIterations: 700,
      optimizeCoefficients: true,
      entities: [{ entityId: 9, chunks }],
    }
    const [a] = await computeNative(req)
    const [b] = await computeNative(req)
    expect(b.cylinder).toEqual(a.cylinder)
    expect(b.inliers).toHaveLength(a.inliers.length)
    a.inliers.forEach((arr, ci) => {
      expect(Array.from(b.inliers[ci])).toEqual(Array.from(arr))
    })
  })

  it('纯随机噪声（无圆柱）：结果同样可复现，不因两次运行给出不同答案', async () => {
    const rand = mulberry32(91)
    const cloud = cylinderCloud(rand, 0, 3000, 0)
    const req: RansacCylinderRequest = {
      distanceThreshold: 0.001,
      maxIterations: 300,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    }
    const [a] = await computeNative(req)
    const [b] = await computeNative(req)
    expect(a.cylinder === null).toBe(b.cylinder === null)
    if (a.cylinder) expect(b.cylinder).toEqual(a.cylinder)
  })

  // ---- 组 5：退化与边界 ----

  it('候选 < 3 / maxIterations = 0：返回 cylinder = null 与空块（渲染侧据此提示）', async () => {
    const twoPoints = new Float32Array([0, 0, 0, 1, 1, 1])
    const [r1] = await computeNative({
      distanceThreshold: 0.1,
      maxIterations: 100,
      optimizeCoefficients: true,
      entities: [
        {
          entityId: 1,
          chunks: [
            { positions: twoPoints, index: null, normals: encodeNormalCodes(new Float32Array([1, 0, 0, 1, 0, 0])) },
          ],
        },
      ],
    })
    expect(r1.cylinder).toBeNull()
    expect(r1.inliers).toHaveLength(1)
    expect(r1.inliers[0]).toHaveLength(0)

    const rand = mulberry32(101)
    const cloud = cylinderCloud(rand, 1000, 0, 0.005)
    const [r2] = await computeNative({
      distanceThreshold: 0.1,
      maxIterations: 0,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    expect(r2.cylinder).toBeNull()
  })

  it('轴方向为零向量：判未找到（不是崩、也不是给个乱圆柱）', async () => {
    const rand = mulberry32(102)
    const cloud = cylinderCloud(rand, 2000, 0, 0.005)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 500,
      optimizeCoefficients: true,
      axis: { x: 0, y: 0, z: 0 },
      entities: [{ entityId: 1, chunks: wholeChunk(cloud) }],
    })
    expect(r.cylinder).toBeNull()
    expect(r.inliers[0]).toHaveLength(0)
  })

  it('全部候选同坐标 / 全共线：退化输入不崩，判未找到', async () => {
    const n = 500
    const same = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      same[i * 3] = 3
      same[i * 3 + 1] = 4
      same[i * 3 + 2] = 5
    }
    // 法线全零 ⇒ 全 NULL 码（="所有点都没有法线"的真实形态）：轴估不出来，判未找到
    const [r1] = await computeNative({
      distanceThreshold: 1,
      maxIterations: 500,
      optimizeCoefficients: true,
      entities: [
        {
          entityId: 1,
          chunks: [{ positions: same, index: null, normals: encodeNormalCodes(new Float32Array(n * 3)) }],
        },
      ],
    })
    expect(r1.cylinder).toBeNull()

    // 全共线（沿 z 轴）：法线统一取 +X（平面分布）⇒ 各向异性比 0、得分 0 ⇒ 轴闸门先挡下。
    // 这条顺带钉住"没有圆柱时不许凭空造轴"——旧实现会给一个噪声方向然后拟出个假圆柱。
    const collinear = new Float32Array(n * 3)
    const collinearNormals = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      collinear[i * 3] = 0
      collinear[i * 3 + 1] = 0
      collinear[i * 3 + 2] = i
      collinearNormals[i * 3] = 1
    }
    const [r2] = await computeNative({
      distanceThreshold: 1,
      maxIterations: 500,
      optimizeCoefficients: true,
      entities: [
        { entityId: 1, chunks: [{ positions: collinear, index: null, normals: encodeNormalCodes(collinearNormals) }] },
      ],
    })
    expect(r2.cylinder).toBeNull()
  })

  it('带 index 的候选子集：内点必落在候选内，且候选外的点一个都不出现', async () => {
    // 块内含「真圆柱点」与「离群点」两组；候选 index 只指向离群点 → 不应复原出真圆柱。
    // 法线同样按顶点切断（前 n 个是柱面径向、后 n 个随机朝向）：**法线是顶点缓冲空间的**，
    // index 只决定"谁参与"，不改变"第 k 个顶点的法线是谁"——这条正好把它钉住。
    const rand = mulberry32(111)
    const cylPts = cylinderCloud(rand, 4000, 0, 0.005)
    const outskirts = cylinderCloud(rand, 0, 4000, 0.005)
    const n = 4000
    const positions = new Float32Array(n * 6)
    positions.set(cylPts.positions, 0)
    positions.set(outskirts.positions, n * 3)
    const normals = new Float32Array(n * 6)
    normals.set(cylPts.normals, 0)
    normals.set(outskirts.normals, n * 3)
    const indexFar = new Uint32Array(n)
    for (let i = 0; i < n; i++) indexFar[i] = n + i
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions, index: indexFar, normals: encodeNormalCodes(normals) }] }],
    })
    for (const arr of r.inliers) {
      for (const v of arr) expect(v).toBeGreaterThanOrEqual(n)
    }
    if (r.cylinder) {
      expect(axisCos(r.cylinder), '候选不含圆柱点 ⇒ 不应复原出真圆柱').toBeLessThan(0.999)
    }
    // 反向：候选只指向圆柱点 → 应稳定复原真圆柱
    const indexCyl = new Uint32Array(n)
    for (let i = 0; i < n; i++) indexCyl[i] = i
    const [r2] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks: [{ positions, index: indexCyl, normals: encodeNormalCodes(normals) }] }],
    })
    expect(r2.cylinder).not.toBeNull()
    expect(axisCos(r2.cylinder!)).toBeGreaterThan(1 - 1e-4)
    for (const arr of r2.inliers) {
      for (const v of arr) expect(v).toBeLessThan(n)
    }
  })

  it('块划分不改变内点集合：同一片数据切 1 块 / 2 块 / 多块，内点集合一致', async () => {
    // 精修打开时，Kåsa 正规方程的浮点归约**分组**随块数变化（(a+b)+c+d ≠ (a+b)+(c+d)），
    // 圆柱系数可能差最后几个 ulp——故降到「内点集合一致 + 系数 ≤ 1e-9」。这是浮点加法不可
    // 结合的必然结果，不是缺陷；内点集合不受影响（判定只看偏差是否越过阈值）。
    const rand = mulberry32(121)
    const cloud = cylinderCloud(rand, 3000, 1000, 0.005, 12, 24, 0.02)
    const base = { distanceThreshold: 0.02, maxIterations: 1000, optimizeCoefficients: true }
    const whole: RansacCylinderChunkSource[] = wholeChunk(cloud)
    const half = makeChunks(cloud.positions, 2000, rand, false, cloud.normals)
    const many = makeChunks(cloud.positions, 500, rand, false, cloud.normals)
    const [rWhole] = await computeNative({ ...base, entities: [{ entityId: 1, chunks: whole }] })
    const [rHalf] = await computeNative({ ...base, entities: [{ entityId: 1, chunks: half }] })
    const [rMany] = await computeNative({ ...base, entities: [{ entityId: 1, chunks: many }] })
    const flatWhole = Array.from(rWhole.inliers[0])
    const flatHalf = rHalf.inliers.flatMap((arr, ci) => Array.from(arr, (v) => globalVertex(half, ci, v)))
    const flatMany = rMany.inliers.flatMap((arr, ci) => Array.from(arr, (v) => globalVertex(many, ci, v)))
    expect(flatHalf).toEqual(flatWhole)
    expect(flatMany).toEqual(flatWhole)
    expect(rHalf.cylinder!.radius).toBeCloseTo(rWhole.cylinder!.radius, 9)
    expect(rHalf.cylinder!.ax).toBeCloseTo(rWhole.cylinder!.ax, 9)
    expect(rHalf.cylinder!.ay).toBeCloseTo(rWhole.cylinder!.ay, 9)
    expect(rHalf.cylinder!.az).toBeCloseTo(rWhole.cylinder!.az, 9)
    expect(rMany.cylinder!.radius).toBeCloseTo(rWhole.cylinder!.radius, 9)
    expect(rHalf.cylinder!.inlierCount).toBe(rWhole.cylinder!.inlierCount)
  })

  it('basis：与轴正交的单位基，且 (u, v, a) 构成右手系', async () => {
    const rand = mulberry32(131)
    const cloud = cylinderCloud(rand, 6000, 500, 0.005, 12, 24, 0.02)
    const chunks = makeChunks(cloud.positions, 1200, rand, false, cloud.normals)
    const [r] = await computeNative({
      distanceThreshold: 0.02,
      maxIterations: 1000,
      optimizeCoefficients: true,
      entities: [{ entityId: 1, chunks }],
    })
    const m = r.cylinder!
    const { ux, uy, uz, vx, vy, vz } = m.basis
    expect(Math.hypot(ux, uy, uz)).toBeCloseTo(1, 12)
    expect(Math.hypot(vx, vy, vz)).toBeCloseTo(1, 12)
    expect(ux * vx + uy * vy + uz * vz, 'u ⊥ v').toBeLessThan(1e-12)
    expect(ux * m.ax + uy * m.ay + uz * m.az, 'u ⊥ a').toBeLessThan(1e-12)
    expect(vx * m.ax + vy * m.ay + vz * m.az, 'v ⊥ a').toBeLessThan(1e-12)
    // 右手系：u × v = a
    const cx = uy * vz - uz * vy
    const cy = uz * vx - ux * vz
    const cz = ux * vy - uy * vx
    expect(cx * m.ax + cy * m.ay + cz * m.az, 'u × v 与 a 同向').toBeGreaterThan(1 - 1e-12)
    // 轴是单位向量、符号约定为「绝对值最大的分量为正」
    expect(Math.hypot(m.ax, m.ay, m.az)).toBeCloseTo(1, 12)
    const absComponents = [Math.abs(m.ax), Math.abs(m.ay), Math.abs(m.az)]
    const maxIdx = absComponents.indexOf(Math.max(...absComponents))
    expect([m.ax, m.ay, m.az][maxIdx]).toBeGreaterThan(0)
  })

  it('多实体：各实体独立拟合，结果与逐实体单独调用一致', async () => {
    const randA = mulberry32(141)
    const randB = mulberry32(142)
    const cloudA = cylinderCloud(randA, 3000, 300, 0.005)
    const cloudB = cylinderCloud(randB, 2000, 400, 0.008)
    const chunkA = wholeChunk(cloudA)
    const chunkB = wholeChunk(cloudB)
    const req = { distanceThreshold: 0.02, maxIterations: 500, optimizeCoefficients: true }
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
    expect(both[0].cylinder).toEqual(onlyA.cylinder)
    expect(both[1].cylinder).toEqual(onlyB.cylinder)
    both.forEach((r, i) => {
      const single = i === 0 ? onlyA : onlyB
      r.inliers.forEach((arr, ci) => {
        expect(Array.from(arr)).toEqual(Array.from(single.inliers[ci]))
      })
    })
  })

  it('参数校验：缺字段 / 类型不符时同步抛 TypeError（不静默算错）', () => {
    expect(() => addon.compute({} as unknown as RansacCylinderRequest, () => {})).toThrow(TypeError)
    expect(() =>
      addon.compute(
        {
          distanceThreshold: 1,
          maxIterations: 10,
          optimizeCoefficients: true,
          entities: 'x',
        } as unknown as RansacCylinderRequest,
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
