import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  bucketLines,
  buildExtractRequest,
  buildLineColors,
  buildTraceRequest,
  candidateKept,
  candidateKeptLinear,
  clampLinearityMin,
  clampMaxSlopeDeg,
  defaultPowerlineParams,
  defaultPowerlineRadius,
  extractParamsChanged,
  lineColor,
  refineChunkIndices,
  refinedCandidateCount,
  slopeSin,
  summarizeLines,
  MAX_SPLIT_LINES,
  POWERLINE_LOOSE_MAX_SLOPE_DEG,
  POWERLINE_LOOSE_MIN_LINEARITY,
  POWERLINE_POOL_MAX_POINTS,
} from '../../../../src/renderer/utils/powerline'
import type {
  PowerlineAddon,
  PowerlineChunkSource,
  PowerlineExtractEntityResult,
  PowerlineExtractRequest,
  PowerlineFeatures,
  PowerlineLineInfo,
  PowerlineParams,
  PowerlineTraceEntityResult,
  PowerlineTraceRequest,
} from '../../../../src/renderer/utils/powerline'
import { buildGroundGrid, sampleGround } from '../../../../src/renderer/utils/groundGrid'
import type { GroundGridData } from '../../../../src/renderer/utils/groundGrid'
import { residualChunkIndices } from '../../../../src/renderer/utils/labelBuckets'
import { labelColor, LABEL_NOISE_SRGB, srgbByteToLinearByte } from '../../../../src/renderer/utils/labelColors'
import { candidateCountOfChunk } from '../../../../src/renderer/utils/radiusFilter'

// 纯函数组在 node 环境即可；native 组直连编译产物（N-API 对 Node 与 Electron 通用），
// 产物缺失（CI 无编译链）时整组 skip（同 euclidean-cluster.spec / treeIso.spec 惯例）。
//
// 无上游对照（CloudCompare 没有电力线提取）：防线是**合成场景**——地面参考面用解析式
// （双线性在线性场上精确，故 HAG 可预言），导线是解析悬链线（抛物线模型在垂跨比 0.03 下
// 偏差 ~1e-3），干扰物（塔腿/横担/树冠/女儿墙/噪声）都是可解析判定的。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/powerline/build/Release/powerline.node', import.meta.url)
)
const nativeAvailable = existsSync(NATIVE_PATH)

/** 确定性 PRNG（线性同余；造点用，跨运行可复现）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 逐元素比对（失败时给出首个不一致位置，便于定位）。 */
function expectInt32Equal(actual: Int32Array, expected: Int32Array, label: string) {
  expect(actual.length, `${label}: 长度`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}: 第 ${i} 个候选标签 ${actual[i]} ≠ 期望 ${expected[i]}`)
    }
  }
}

// ===========================================================================
// 纯 JS 组
// ===========================================================================

describe('defaultPowerlineParams / 参数分级', () => {
  it('邻域半径 = 平均点距 × 10，夹在 0.5–5 m；退化输入给 1 m', () => {
    expect(defaultPowerlineRadius(0.02)).toBe(0.5) // 0.2 被下限 0.5 抬起
    expect(defaultPowerlineRadius(0.1)).toBeCloseTo(1, 10)
    expect(defaultPowerlineRadius(0.5)).toBeCloseTo(5, 10)
    expect(defaultPowerlineRadius(2)).toBe(5) // 上限
    expect(defaultPowerlineRadius(0)).toBe(1)
    expect(defaultPowerlineRadius(Number.NaN)).toBe(1)
    expect(defaultPowerlineRadius(-3)).toBe(1)
  })

  it('默认参数落在宽松闸之内（精筛滑杆必须在池子里，否则有一段永远无效）', () => {
    const p = defaultPowerlineParams(0.05)
    expect(p.linearityMin).toBeGreaterThanOrEqual(POWERLINE_LOOSE_MIN_LINEARITY)
    expect(p.maxSlopeDeg).toBeLessThanOrEqual(POWERLINE_LOOSE_MAX_SLOPE_DEG)
    expect(p.minHeight).toBe(4)
    expect(p.radius).toBe(0.5)
  })

  it('只有 minHeight / radius 属于【重】档（其余改动不必重跑 native #1）', () => {
    const a = defaultPowerlineParams(0.1)
    expect(extractParamsChanged(a, { ...a })).toBe(false)
    expect(extractParamsChanged(a, { ...a, minHeight: 5 })).toBe(true)
    expect(extractParamsChanged(a, { ...a, radius: 1.5 })).toBe(true)
    for (const key of [
      'linearityMin',
      'maxSlopeDeg',
      'connectRadius',
      'residualTolerance',
      'minLinePoints',
      'minLineLength',
      'gapRadius',
      'gapAngleDeg',
      'dirRadius',
    ] as const) {
      expect(extractParamsChanged(a, { ...a, [key]: a[key] + 1 }), key).toBe(false)
    }
  })

  it('精筛滑杆夹取：线性度 ≥ 0.5、倾角 ≤ 30°（池子之外静默无效，故夹住）', () => {
    expect(clampLinearityMin(0.1)).toBe(POWERLINE_LOOSE_MIN_LINEARITY)
    expect(clampLinearityMin(0.9)).toBe(0.9)
    expect(clampLinearityMin(1.5)).toBe(1)
    expect(clampLinearityMin(Number.NaN)).toBe(POWERLINE_LOOSE_MIN_LINEARITY)
    expect(clampMaxSlopeDeg(-5)).toBe(0)
    expect(clampMaxSlopeDeg(25)).toBe(25)
    expect(clampMaxSlopeDeg(90)).toBe(POWERLINE_LOOSE_MAX_SLOPE_DEG)
    expect(clampMaxSlopeDeg(Number.NaN)).toBe(0)
  })
})

describe('candidateKept（渲染侧精筛：含等号边界）', () => {
  /** 造一份单点特征。 */
  function featuresOf(linearity: number, verticality: number, neighbors = 5): PowerlineFeatures {
    return {
      linearity: new Float32Array([linearity]),
      verticality: new Float32Array([verticality]),
      hag: new Float32Array([10]),
      neighborCount: new Uint32Array([neighbors]),
    }
  }

  it('线性度、倾角都是**含等号**（阈值上取到）', () => {
    // 用二进制精确可表示的值测边界：Float32 存的 0.85 是 0.85000002…，
    // 拿它当边界会测到"舍入"而不是"判据"，故取 0.75 / 0.5 这类精确值
    expect(candidateKeptLinear(featuresOf(0.75, 0), 0, 0.75, 0.5)).toBe(true)
    expect(candidateKeptLinear(featuresOf(0.7499, 0), 0, 0.75, 0.5)).toBe(false)
    const f = featuresOf(0.9, 0.5)
    expect(candidateKeptLinear(f, 0, 0.75, 0.5)).toBe(true) // |v1.z| == 上限 → 留
    expect(candidateKeptLinear(f, 0, 0.75, 0.49999)).toBe(false)
    // 垂直度是 |v1.z|，符号无关
    expect(candidateKeptLinear(featuresOf(0.9, -0.5), 0, 0.75, 0.5)).toBe(true)
    // 角度入口：25° 的 sin ≈ 0.4226，垂直度 0.9 远超它
    expect(candidateKept(featuresOf(0.9, 0), 0, 0.75, 25)).toBe(true)
    expect(candidateKept(featuresOf(0.9, 0.9), 0, 0.75, 25)).toBe(false)
    expect(slopeSin(25)).toBeCloseTo(Math.sin((25 * Math.PI) / 180), 12)
  })

  it('邻居数不足 3 的池点不留（与 native 宽松闸同一条）', () => {
    expect(candidateKept(featuresOf(0.99, 0, 2), 0, 0.85, 25)).toBe(false)
    expect(candidateKept(featuresOf(0.99, 0, 3), 0, 0.85, 25)).toBe(true)
  })

  it('candidateKeptLinear 与 candidateKept 等价（批量路径用前者，避免逐点算 sin）', () => {
    const maxVerticality = slopeSin(25)
    for (const v of [0, 0.2, 0.4226, 0.9]) {
      const f = featuresOf(0.9, v)
      expect(candidateKeptLinear(f, 0, 0.85, maxVerticality), `v=${v}`).toBe(candidateKept(f, 0, 0.85, 25))
    }
    expect(slopeSin(30)).toBeCloseTo(0.5, 12)
  })
})

describe('refineChunkIndices（池子 → 逐块精筛下标）', () => {
  /** 造一份「两个块」的 stage-1 结果：块 0 有 3 个池点、块 1 有 2 个。 */
  function extractFixture(): PowerlineExtractEntityResult {
    return {
      entityId: 1,
      chunks: [{ kept: new Uint32Array([5, 7, 9]) }, { kept: new Uint32Array([1, 4]) }],
      features: {
        linearity: new Float32Array([0.9, 0.6, 0.95, 0.99, 0.99]),
        verticality: new Float32Array([0, 0.9, 0, 0, 0]),
        hag: new Float32Array([10, 10, 10, 10, 10]),
        neighborCount: new Uint32Array([5, 5, 5, 5, 5]),
      },
      stats: { offGroundCount: 0, poolCount: 5 },
    }
  }

  it('逐块给出顶点空间下标（升序），不入选的池点被丢掉', () => {
    const out = refineChunkIndices(extractFixture(), 0.85, 25)
    expect(out).toHaveLength(2)
    expect(Array.from(out[0])).toEqual([5, 9]) // 池点 1（线性度 0.6）被精筛掉
    expect(Array.from(out[1])).toEqual([1, 4])
  })

  it('整块被刷空时给**空数组**（不是 null——那是"全量顶点"，语义相反）', () => {
    const out = refineChunkIndices(extractFixture(), 1, 0)
    expect(out[0].length).toBe(0)
    expect(out[1].length).toBe(0)
    expect(Array.from(out[0])).toEqual([])
  })
})

describe('bucketLines（线号 → 逐块顶点下标 + 残点）', () => {
  it('无 index 块：候选序即顶点下标，逐线按块分桶且守恒', () => {
    const chunks: PowerlineChunkSource[] = [
      { positions: new Float32Array(5 * 3), index: null },
      { positions: new Float32Array(4 * 3), index: null },
      { positions: new Float32Array(2 * 3), index: null },
    ]
    // 11 个候选：块主序 = [1,1,2,0,2 | 2,1,0,1 | 1,0]
    const labels = new Int32Array([1, 1, 2, 0, 2, 2, 1, 0, 1, 1, 0])
    const { lines, noiseChunkIndices } = bucketLines(chunks, labels, 2)
    expect(lines.map((l) => l.label)).toEqual([1, 2])
    expect(Array.from(lines[0].chunkIndices[0]!)).toEqual([0, 1]) // 块 0 的两点
    expect(Array.from(lines[0].chunkIndices[1]!)).toEqual([1, 3])
    expect(Array.from(lines[0].chunkIndices[2]!)).toEqual([0])
    expect(Array.from(lines[1].chunkIndices[0]!)).toEqual([2, 4])
    expect(Array.from(lines[1].chunkIndices[1]!)).toEqual([0])
    expect(lines[1].chunkIndices[2]).toBeNull() // 块 2 没有线 2 的点 → null（空块占位）
    expect(noiseChunkIndices).toEqual([new Uint32Array([3]), new Uint32Array([2]), new Uint32Array([1])])
    const kept = lines.reduce((s, l) => s + l.chunkIndices.reduce((t, a) => t + (a ? a.length : 0), 0), 0)
    const noise = noiseChunkIndices!.reduce((s, a) => s + (a ? a.length : 0), 0)
    expect(kept + noise).toBe(labels.length) // 守恒
  })

  it('带 index 的块：桶里装顶点下标（不是候选号）', () => {
    const chunks: PowerlineChunkSource[] = [{ positions: new Float32Array(6 * 3), index: new Uint32Array([1, 3, 5]) }]
    const { lines } = bucketLines(chunks, new Int32Array([1, 0, 1]), 1)
    expect(Array.from(lines[0].chunkIndices[0]!)).toEqual([1, 5])
  })

  it('线号越界 / 标签数与候选数不一致一律抛错（契约破损不写坏数据）', () => {
    const chunks: PowerlineChunkSource[] = [{ positions: new Float32Array(3 * 3), index: null }]
    expect(() => bucketLines(chunks, new Int32Array([1, 1]), 1)).toThrow(/标签数与候选数/)
    expect(() => bucketLines(chunks, new Int32Array([1, 1, 3]), 2)).toThrow(/标签越界/)
  })

  it('一条线都没有时：分桶为空、残点覆盖全部候选', () => {
    const chunks: PowerlineChunkSource[] = [{ positions: new Float32Array(3 * 3), index: null }]
    const { lines, noiseChunkIndices } = bucketLines(chunks, new Int32Array(3), 0)
    expect(lines).toEqual([])
    expect(noiseChunkIndices).toEqual([new Uint32Array([0, 1, 2])])
  })
})

describe('residualChunkIndices（残点 = 源候选减各线点）', () => {
  it('池子之外的点也算残点（残点实体 = 源点云减各线）', () => {
    const chunks: PowerlineChunkSource[] = [{ positions: new Float32Array(6 * 3), index: null }]
    // 线 1 收了 {1, 4}，线 2 收了 {2}
    const residual = residualChunkIndices(chunks, [
      [new Uint32Array([1, 4])],
      [new Uint32Array([2]), null],
    ])
    expect(residual).toEqual([new Uint32Array([0, 3, 5])])
  })

  it('带 index 的块：只在源候选之内取补集（非候选顶点不复活）', () => {
    const chunks: PowerlineChunkSource[] = [{ positions: new Float32Array(6 * 3), index: new Uint32Array([0, 2, 4]) }]
    const residual = residualChunkIndices(chunks, [[new Uint32Array([2])]])
    expect(residual).toEqual([new Uint32Array([0, 4])])
  })

  it('残点为空时给 null（调用方据此不建残点实体）', () => {
    const chunks: PowerlineChunkSource[] = [{ positions: new Float32Array(2 * 3), index: null }]
    expect(residualChunkIndices(chunks, [[new Uint32Array([0, 1])]])).toBeNull()
  })
})

describe('summarizeLines / buildLineColors', () => {
  /** 造 n 条线的统计。 */
  function linesFixture(): PowerlineLineInfo[] {
    return [
      { id: 1, pointCount: 100, length: 300, sag: 8, azimuthDeg: 0, rms: 0.01, gapCount: 1 },
      { id: 2, pointCount: 50, length: 120, sag: 5, azimuthDeg: 90, rms: 0.02, gapCount: 0 },
    ]
  }

  it('汇总守恒：成线点数 + 残点数 = 候选总数', () => {
    const s = summarizeLines(linesFixture(), 200)
    expect(s.lineCount).toBe(2)
    expect(s.linePoints).toBe(150)
    expect(s.noisePoints).toBe(50)
    expect(s.longestLine).toBe(300)
    expect(s.totalLength).toBe(420)
    expect(s.gapLines).toBe(1) // 补过口的线数
    expect(summarizeLines([], 0)).toEqual({
      lineCount: 0,
      linePoints: 0,
      noisePoints: 0,
      longestLine: 0,
      totalLength: 0,
      gapLines: 0,
    })
  })

  it('线色 = labelColor（与分割色同源，改色核两处一起变）', () => {
    expect(lineColor(1)).toEqual(labelColor(1))
    expect(lineColor(37)).toEqual(labelColor(37))
  })

  it('预览色长度 = 顶点数 × 3；成线点按线号上色、其余为灰', () => {
    const positions = new Float32Array(4 * 3)
    const chunks: PowerlineChunkSource[] = [{ positions, index: null }]
    const labels = new Int32Array([1, 0, 2, 1])
    const colors = buildLineColors(chunks, labels, 2)
    expect(colors).toHaveLength(1)
    const bytes = colors[0]!
    expect(bytes.length).toBe(4 * 3)
    const c1 = lineColor(1)
    const c2 = lineColor(2)
    expect(Array.from(bytes.slice(0, 3))).toEqual([c1.r, c1.g, c1.b].map(srgbByteToLinearByte))
    expect(Array.from(bytes.slice(3, 6))).toEqual([LABEL_NOISE_SRGB, LABEL_NOISE_SRGB, LABEL_NOISE_SRGB].map(srgbByteToLinearByte))
    expect(Array.from(bytes.slice(6, 9))).toEqual([c2.r, c2.g, c2.b].map(srgbByteToLinearByte))
    // 零顶点块给 null
    expect(buildLineColors([{ positions: new Float32Array(0), index: null }], new Int32Array(0), 0)).toEqual([null])
  })

  it('常量自洽：分割上限、池子上限、宽松闸都是预期值', () => {
    expect(MAX_SPLIT_LINES).toBe(500)
    expect(POWERLINE_POOL_MAX_POINTS).toBe(4_000_000)
    expect(POWERLINE_LOOSE_MIN_LINEARITY).toBe(0.5)
    expect(POWERLINE_LOOSE_MAX_SLOPE_DEG).toBe(30)
  })
})

// ===========================================================================
// 合成场景（native 组与分块不变性共用）
// ===========================================================================

/** 合成"丘陵"地面：沿 x 的斜坡（解析式，故 HAG 可预言）。 */
function groundZ(x: number): number {
  return 100 + 0.05 * x
}

/** 与 groundZ 严格一致的解析参考面（双线性在线性场上精确 ⇒ HAG 无插值误差）。 */
function makeSceneGrid(): GroundGridData {
  const cellSize = 10
  const cols = 43 // x ∈ [0, 420]
  const rows = 21 // y ∈ [-100, 100]
  const values = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) values[row * cols + col] = groundZ(col * cellSize)
  }
  return { values, cols, rows, cellSize, originX: 0, originY: -100 }
}

/** 合成场景。 */
interface Scene {
  positions: Float32Array
  /** 第 k 条导线（0/1/2）的顶点下标。 */
  wires: number[][]
  /** 结构性干扰物（塔腿 / 横担 / 树冠 / 女儿墙）的顶点下标——**一个都不该被标成线**。 */
  structured: number[]
  /** 随机散点的顶点下标（个别点落进某条线的容差内是正常的，见断言注释）。 */
  noise: number[]
  grid: GroundGridData
  params: PowerlineParams
}

/** 导线沿程点距（m）：0.5 m ⇒ 半径 2 m 的邻域里有约 9 个点，PCA 方向稳定。 */
const WIRE_SPACING = 0.5

/**
 * 造场景：
 * - 3 条导线：1/2 号沿 x（y = 20 / 24，横担间距 4 m，300 m 跨、垂度 8 m）；
 *   3 号沿 y 在 x = 100 处**横穿** 1/2 号（交叉处高差约 1 m，即"平面交叉、空间不相交"）。
 * - 2 基塔（x = -6 / 306）：4 条竖腿（垂直 ⇒ 宽松闸排除）+ 2 根 10 m 横担（长度闸排除）。
 * - 6 个树冠团簇（各向同性 ⇒ 线性度闸排除）。
 * - 15 m 女儿墙（干净水平直线，长度 < 最短线长 ⇒ 长度闸排除）。
 * - 800 个随机散点。
 *
 * @param opts.digGap    在 1 号导线跨中挖掉 17 个点（8 m 缺口）——**端点补全**的用例
 * @param opts.longFence 额外加一条 40 m 的干净水平围栏（**已知限制**：会被当成一条线）
 */
function makeScene(opts: { digGap?: boolean; longFence?: boolean } = {}): Scene {
  const pts: number[] = []
  const wires: number[][] = [[], [], []]
  const structured: number[] = []
  const noise: number[] = []
  const push = (bucket: number[], x: number, y: number, z: number) => {
    bucket.push(pts.length / 3)
    pts.push(x, y, z)
  }
  const rng = makeRng(20260927)

  // 导线 1/2：沿 x，z = 地面 + 25 − 32u(1−u)（跨中垂度 8 m）
  for (const [wire, y] of [
    [0, 20],
    [1, 24],
  ] as const) {
    for (let x = 0; x <= 300; x += WIRE_SPACING) {
      if (opts.digGap && x >= 146 && x <= 154) continue
      const u = x / 300
      push(wires[wire], x, y, groundZ(x) + 25 - 32 * u * (1 - u))
    }
  }
  // 导线 3：沿 y 在 x = 100 处横穿（交叉点高差 ≈ 1 m，落在连接半径 3 m 之内）
  for (let y = -90; y <= 90; y += WIRE_SPACING) {
    const v = (y + 90) / 180
    push(wires[2], 100, y, groundZ(100) + 24.6 - 24 * v * (1 - v))
  }
  // 基塔：竖腿 + 横担（横担在塔身**外侧**，远离导线端头）
  for (const tx of [-6, 306]) {
    const base = groundZ(tx)
    for (const ty of [17, 27]) {
      for (let z = base; z <= base + 25; z += 0.5) push(structured, tx, ty, z)
    }
    for (const cz of [base + 17, base + 25]) {
      for (let y = 15; y <= 29; y += 0.5) push(structured, tx + Math.sign(tx) * 5, y, cz)
    }
  }
  // 树冠：6 个球状团簇
  for (const [cx, cy] of [
    [50, -30],
    [150, -50],
    [250, -20],
    [200, 60],
    [80, 70],
    [330, -60],
  ]) {
    const cz = groundZ(cx) + 12
    for (let i = 0; i < 150; i++) {
      const r = 2.5 * Math.cbrt(rng())
      const th = rng() * 2 * Math.PI
      const ph = Math.acos(2 * rng() - 1)
      push(
        structured,
        cx + r * Math.sin(ph) * Math.cos(th),
        cy + r * Math.sin(ph) * Math.sin(th),
        cz + r * Math.cos(ph)
      )
    }
  }
  // 女儿墙：15 m 干净水平直线（线性度足够，但短于最短线长）
  for (let x = 190; x <= 205; x += 0.5) push(structured, x, -40, groundZ(x) + 12)
  // 已知限制用例：40 m 的干净水平围栏
  if (opts.longFence) {
    for (let x = 150; x <= 190; x += 0.5) push(structured, x, -70, groundZ(x) + 12)
  }
  // 随机散点
  for (let i = 0; i < 800; i++) {
    const x = rng() * 420
    const y = -100 + rng() * 200
    push(noise, x, y, groundZ(x) + rng() * 30)
  }

  const params = defaultPowerlineParams()
  params.radius = 2
  return { positions: new Float32Array(pts), wires, structured, noise, grid: makeSceneGrid(), params }
}

/** 按顶点数把点云连续切成 parts 块（分块不变性用）。 */
function splitChunks(positions: Float32Array, parts: number): PowerlineChunkSource[] {
  const vertexCount = positions.length / 3
  const out: PowerlineChunkSource[] = []
  let start = 0
  for (let p = 0; p < parts; p++) {
    const end = p === parts - 1 ? vertexCount : Math.floor((vertexCount * (p + 1)) / parts)
    out.push({ positions: positions.subarray(start * 3, end * 3), index: null })
    start = end
  }
  return out
}

// ===========================================================================
// native 组
// ===========================================================================

describe.skipIf(!nativeAvailable)('powerline.node（native 产物存在时）', () => {
  const require = createRequire(import.meta.url)
  // 与 euclidean-cluster.spec 惯例一致：直连 addon（不走 nativeLoader 的 window IPC）
  const addon = require(NATIVE_PATH) as PowerlineAddon

  /** promise 化 addon.extractCandidates（同步抛错一并收敛）。 */
  function extractNative(request: PowerlineExtractRequest): Promise<PowerlineExtractEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.extractCandidates(request, (err, results) => (err ? reject(err) : resolve(results ?? [])))
      } catch (e) {
        reject(e)
      }
    })
  }

  /** promise 化 addon.traceLines。 */
  function traceNative(request: PowerlineTraceRequest): Promise<PowerlineTraceEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.traceLines(request, (err, results) => (err ? reject(err) : resolve(results ?? [])))
      } catch (e) {
        reject(e)
      }
    })
  }

  /** 跑一次完整两阶段（extract → 精筛 → trace），返回逐块结果与"逐顶点标签"。 */
  async function runPipeline(
    scene: Scene,
    parts = 1,
    threadCount?: number
  ): Promise<{
    labels: Int32Array
    labelOfVertex: Map<number, number>
    lines: PowerlineLineInfo[]
    extract: PowerlineExtractEntityResult
    refined: Uint32Array[]
    chunks: PowerlineChunkSource[]
    trace: PowerlineTraceEntityResult
  }> {
    const sources = splitChunks(scene.positions, parts)
    const results = await extractNative(
      buildExtractRequest(scene.params, scene.grid, 7, sources, threadCount)
    )
    expect(results).toHaveLength(1)
    expect(results[0].entityId).toBe(7)
    const extract = results[0]

    const refined = refineChunkIndices(extract, scene.params.linearityMin, scene.params.maxSlopeDeg)
    const chunks: PowerlineChunkSource[] = sources.map((c, i) => ({ positions: c.positions, index: refined[i] }))
    const traced = await traceNative(buildTraceRequest(scene.params, 7, chunks, threadCount))
    expect(traced).toHaveLength(1)
    const trace = traced[0]

    // 拼回全局候选序列（块主序）并记录「顶点 → 标签」
    let total = 0
    for (const c of chunks) total += candidateCountOfChunk(c)
    const labels = new Int32Array(total)
    const labelOfVertex = new Map<number, number>()
    let offset = 0
    let vertexBase = 0
    for (let i = 0; i < sources.length; i++) {
      const n = candidateCountOfChunk(chunks[i])
      for (let k = 0; k < n; k++) {
        const local = chunks[i].index![k]
        labels[offset + k] = trace.labels[offset + k]
        labelOfVertex.set(local + vertexBase, trace.labels[offset + k])
      }
      offset += n
      vertexBase += sources[i].positions.length / 3
    }
    return { labels, labelOfVertex, lines: trace.lines, extract, refined, chunks, trace }
  }

  it('契约冒烟：labels 长度 = 候选数、id 连续 1..K、统计守恒', async () => {
    const scene = makeScene()
    const { labels, lines, chunks, trace } = await runPipeline(scene)
    const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
    expect(trace.stats.candidateTotal).toBe(candidateTotal)
    expect(labels.length).toBe(candidateTotal)
    expect(trace.stats.lineCount).toBe(lines.length)
    let sum = 0
    let maxLabel = 0
    for (let i = 0; i < labels.length; i++) {
      sum += labels[i] > 0 ? 1 : 0
      if (labels[i] > maxLabel) maxLabel = labels[i]
    }
    for (const line of lines) {
      expect(line.pointCount).toBeGreaterThan(0)
      expect(line.length).toBeGreaterThanOrEqual(scene.params.minLineLength)
      expect(line.sag).toBeGreaterThanOrEqual(0)
      expect(line.rms).toBeGreaterThanOrEqual(0)
      expect(line.azimuthDeg).toBeGreaterThanOrEqual(0)
      expect(line.azimuthDeg).toBeLessThan(180)
    }
    expect(maxLabel).toBe(lines.length) // 标签连续 1..K
    expect(lines.map((l) => l.id)).toEqual(Array.from({ length: lines.length }, (_, i) => i + 1))
    expect(trace.stats.noiseCount).toBe(candidateTotal - sum)
    expect(summarizeLines(lines, candidateTotal).noisePoints).toBe(trace.stats.noiseCount)
  })

  it('线数 == 3：三条导线各成一条，平行与交叉都被正确拆开（每根线唯一一个线号）', async () => {
    const scene = makeScene()
    const { labelOfVertex, lines } = await runPipeline(scene)
    expect(lines).toHaveLength(3)
    // 每条导线映射到**唯一**一个线号（同一条线没有被拆成两段）
    const ids = scene.wires.map((wire) => {
      const set = new Set<number>()
      let labeled = 0
      for (const v of wire) {
        const label = labelOfVertex.get(v) ?? 0
        if (label > 0) {
          labeled++
          set.add(label)
        }
      }
      expect(set.size, '同一条导线被拆成了多条线').toBe(1)
      // 召回 ≥ 0.95（实测 0.980 / 0.980 / 0.953）：**不是 1.0 是已知且可接受的**，
      // 丢点的机制同一条——PCA 邻域（半径 2 m）里混进"别的方向"，线性度就从 1.000 掉下来：
      //   · 散点贴着导线 ⇒ 0.77~0.85（实测丢 6 点/根）→ 默认精筛 0.85 判掉；
      //   · 另一根导线在交叉处斜穿邻域 ⇒ ≈0.5（实测丢 17 点）——90° 交叉是**最坏**情形。
      // 丢掉这些点**不会拆断线**（端点补全把断口接上，gapCount ≥ 1），它们落进 .noise，
      // 于是「各线实体 ∪ .noise == 源点云」仍然成立。想零丢失就把线性度滑到 0.5
      // （= native 宽松闸），代价是候选池变大。
      expect(labeled / wire.length, '导线召回率').toBeGreaterThanOrEqual(0.95)
      return [...set][0]
    })
    expect(new Set(ids).size).toBe(3) // 三条导线三个不同的线号：平行分离 ✓ 交叉分离 ✓
  })

  it('补全生效：跨中挖掉 8 m 后仍是**一条**线，且 gapCount ≥ 1', async () => {
    /** 1 号导线（wire 0）落在哪条线上；顺带断言"只落一条"。 */
    const wireLine = (
      result: Awaited<ReturnType<typeof runPipeline>>,
      wire: number[]
    ): PowerlineLineInfo => {
      const set = new Set<number>()
      for (const v of wire) {
        const label = result.labelOfVertex.get(v)
        if (label !== undefined && label > 0) set.add(label)
      }
      expect(set.size, '同一根导线落到了多条线上').toBe(1)
      return result.lines[[...set][0] - 1]
    }
    const base = await runPipeline(makeScene())
    const dug = makeScene({ digGap: true })
    const result = await runPipeline(dug)
    expect(result.lines).toHaveLength(3)
    const line = wireLine(result, dug.wires[0])
    expect(line.gapCount, '挖了口却没走端点补全').toBeGreaterThanOrEqual(1)
    // 对照未挖口那次：少掉的点数就是挖掉的 17 个（±2 给"散点被吸进来/掉出去"的余量）
    const dropped = wireLine(base, makeScene().wires[0]).pointCount - line.pointCount
    expect(dropped).toBeGreaterThanOrEqual(15)
    expect(dropped).toBeLessThanOrEqual(19)
    expect(line.length).toBeGreaterThan(280)
  })

  it('干扰物不入选：塔腿 / 横担 / 树冠 / 女儿墙一个都不上色', async () => {
    const scene = makeScene()
    const { labelOfVertex } = await runPipeline(scene)
    let labeled = 0
    for (const v of scene.structured) {
      if ((labelOfVertex.get(v) ?? 0) > 0) labeled++
    }
    expect(labeled, `${labeled} 个结构性干扰点被标成了导线`).toBe(0)
    // 随机散点：个别点落在某条线的残差容差内属正常（毛刺），但不能成片
    let noiseLabeled = 0
    for (const v of scene.noise) {
      if ((labelOfVertex.get(v) ?? 0) > 0) noiseLabeled++
    }
    expect(noiseLabeled / scene.noise.length).toBeLessThan(0.02)
  })

  it('已知限制：超过最短线长的**干净直屋脊/围栏**会被当成一条线（垂度闸门留待下一轮）', async () => {
    const scene = makeScene({ longFence: true })
    const { lines } = await runPipeline(scene)
    expect(lines).toHaveLength(4) // 3 条导线 + 1 段 40 m 围栏
    // 围栏是水平直线：α ≈ 0（几乎无垂度）——这正是将来"垂度下限"判据要用的区分量
    const fence = lines.find((l) => l.sag < 0.1 && l.azimuthDeg < 1)
    expect(fence).toBeDefined()
    expect(fence!.length).toBeGreaterThan(39)
  })

  it('确定性：同输入两次逐位相等（剥离用的 RNG 是固定种子）', async () => {
    const scene = makeScene()
    const a = await runPipeline(scene)
    const b = await runPipeline(scene)
    expectInt32Equal(b.labels, a.labels, '第二次运行')
  })

  it('线程无关：threadCount 1 vs 4 逐位相等', async () => {
    const scene = makeScene()
    const serial = await runPipeline(scene, 1, 1)
    const parallel = await runPipeline(scene, 1, 4)
    expectInt32Equal(parallel.labels, serial.labels, '4 线程')
  })

  it('分块不变性：同一片云切 1 / 3 / 7 块，候选序列与标签逐位相等', async () => {
    const scene = makeScene()
    const one = await runPipeline(scene, 1)
    const three = await runPipeline(scene, 3)
    const seven = await runPipeline(scene, 7)
    expectInt32Equal(three.labels, one.labels, '3 块')
    expectInt32Equal(seven.labels, one.labels, '7 块')
    expect(three.lines.map((l) => l.pointCount)).toEqual(one.lines.map((l) => l.pointCount))
  })

  it('⚠ 空 index = 零候选（本模块与其余模块的契约差异）：不会退化成"全量顶点"', async () => {
    const scene = makeScene()
    // 整块候选刷空：若按"没有 index"解释，这一整块点都会被当成导线候选去连线
    const empty = await traceNative(
      buildTraceRequest(scene.params, 7, [{ positions: scene.positions, index: new Uint32Array(0) }])
    )
    expect(empty[0].stats.candidateTotal).toBe(0)
    expect(empty[0].labels.length).toBe(0)
    expect(empty[0].lines).toHaveLength(0)
    // 对照：显式 null 才是"全量顶点"
    const all = await traceNative(buildTraceRequest(scene.params, 7, [{ positions: scene.positions, index: null }]))
    expect(all[0].stats.candidateTotal).toBe(scene.positions.length / 3)
  })

  it('HAG 闸门真的在用地面参考面：把参考面抬高 30 m ⇒ 一个候选都不剩', async () => {
    const scene = makeScene()
    // 场景里最高的点是导线端头与横担（离地 25 m）；抬高 30 m ⇒ 阈值 34 m ⇒ 无一过闸
    const lifted = makeSceneGrid()
    lifted.values = Float32Array.from(lifted.values, (v) => v + 30)
    const res = await extractNative(
      buildExtractRequest(scene.params, lifted, 7, [{ positions: scene.positions, index: null }])
    )
    expect(res[0].stats.offGroundCount).toBe(0)
    expect(res[0].stats.poolCount).toBe(0)
    expect(res[0].chunks[0].kept.length).toBe(0)
    // 对照：原参考面上有大量离地点（实测 3514 = 导线 1563 + 树冠 900 + 散点/塔身等）
    const normal = await extractNative(
      buildExtractRequest(scene.params, scene.grid, 7, [{ positions: scene.positions, index: null }])
    )
    expect(normal[0].stats.offGroundCount).toBeGreaterThan(2500)
  })

  it('阶段 1 特征与渲染侧预言一致：hag == z − sampleGround、宽松闸 → 池子', async () => {
    const scene = makeScene()
    const res = await extractNative(
      buildExtractRequest(scene.params, scene.grid, 7, [{ positions: scene.positions, index: null }])
    )
    const out = res[0]
    let poolCount = 0
    let offset = 0
    for (const chunk of out.chunks) {
      for (let k = 0; k < chunk.kept.length; k++) {
        const v = chunk.kept[k]
        const i = offset + k
        // hag 特征与「z − 双线性采样地面」一致（容差 = float 存的量化误差）
        const expected = scene.positions[v * 3 + 2] - sampleGround(scene.grid, scene.positions[v * 3], scene.positions[v * 3 + 1])
        expect(Math.abs(out.features.hag[i] - expected)).toBeLessThan(1e-3)
        // 池子里的点必然满足宽松闸
        expect(out.features.linearity[i]).toBeGreaterThanOrEqual(POWERLINE_LOOSE_MIN_LINEARITY)
        expect(Math.abs(out.features.verticality[i])).toBeLessThanOrEqual(0.5 + 1e-6)
        expect(out.features.neighborCount[i]).toBeGreaterThanOrEqual(3)
        poolCount++
      }
      offset += chunk.kept.length
    }
    expect(poolCount).toBe(out.stats.poolCount)
    expect(out.stats.poolCount).toBeLessThanOrEqual(out.stats.offGroundCount)
    // 精筛之后候选更少（默认 0.85 / 25° 比宽松闸严）
    const refined = refineChunkIndices(out, scene.params.linearityMin, scene.params.maxSlopeDeg)
    const refinedTotal = refinedCandidateCount(refined.map((index) => ({ positions: new Float32Array(0), index })))
    expect(refinedTotal).toBeGreaterThan(0)
    expect(refinedTotal).toBeLessThan(out.stats.poolCount)
  })

  it('退化输入：空实体 / 单点 / 低于阈值 / 参数非法', async () => {
    const scene = makeScene()
    const empty = await traceNative(buildTraceRequest(scene.params, 7, [{ positions: new Float32Array(0), index: null }]))
    expect(empty[0].labels.length).toBe(0)
    expect(empty[0].lines).toHaveLength(0)

    const one = await traceNative(
      buildTraceRequest(scene.params, 7, [{ positions: new Float32Array([0, 0, 10]), index: null }])
    )
    expect(one[0].stats.candidateTotal).toBe(1)
    expect(one[0].lines).toHaveLength(0)
    expect(one[0].labels[0]).toBe(0)

    // 10 个共线点（4.5 m）：既不够 minLinePoints 也不够 minLineLength
    const short = new Float32Array(10 * 3)
    for (let i = 0; i < 10; i++) {
      short[i * 3] = i * 0.5
      short[i * 3 + 1] = 0
      short[i * 3 + 2] = 10
    }
    const shortRes = await traceNative(buildTraceRequest(scene.params, 7, [{ positions: short, index: null }]))
    expect(shortRes[0].lines).toHaveLength(0)

    await expect(
      extractNative(
        buildExtractRequest({ ...scene.params, radius: 0 }, scene.grid, 7, [
          { positions: scene.positions, index: null },
        ])
      )
    ).rejects.toThrow()
    await expect(
      extractNative(
        buildExtractRequest(scene.params, scene.grid, 7, [{ positions: new Float32Array(4), index: null }])
      )
    ).rejects.toThrow() // positions 不是 3 的倍数
    await expect(
      traceNative(buildTraceRequest({ ...scene.params, minLinePoints: 2 }, 7, [{ positions: short, index: null }]))
    ).rejects.toThrow() // minLinePoints ≥ 3
    // 越界的 index：契约防御 → 空结果（不崩）
    const outOfRange = await traceNative(
      buildTraceRequest(scene.params, 7, [{ positions: new Float32Array(3), index: new Uint32Array([99]) }])
    )
    expect(outOfRange[0].lines).toHaveLength(0)
    expect(outOfRange[0].labels.length).toBe(0)
  })

  it('地面参考面由渲染侧建：用地面点建面后 HAG 与解析式一致（两模块接口对得上）', async () => {
    const scene = makeScene()
    // 取一批"地面点"（**逐格一个**，10 m 格距——真实地面点覆盖率就是这样），交给 buildGroundGrid 建面
    const groundPts: number[] = []
    const idx: number[] = []
    for (let x = 0; x <= 400; x += 10) {
      for (let y = -100; y <= 100; y += 10) {
        idx.push(groundPts.length / 3)
        groundPts.push(x, y, groundZ(x))
      }
    }
    const grid = buildGroundGrid([new Float32Array(groundPts)], [new Uint32Array(idx)], 10)!
    for (const x of [0, 37.5, 100, 299.9]) {
      expect(Math.abs(sampleGround(grid, x, 20) - groundZ(x)), `x=${x}`).toBeLessThan(1e-4)
    }
  })
})
