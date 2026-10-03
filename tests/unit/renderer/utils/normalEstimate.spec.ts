import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  INVERT_XOR,
  MODEL_OPTIONS,
  NORMAL_LUT_SIZE,
  NORMAL_MODEL_CODES,
  NORMAL_ORIENTATION_CODES,
  NORMAL_QUANTIZE_LEVEL,
  NULL_NORM_CODE,
  ORIENTATION_OPTIONS,
  buildNormalLut,
  decompressNormalCode,
  invertNormalCode,
  normalCodeToRgbLinear,
  scatterNormalCodes,
} from '../../../../src/renderer/utils/normalEstimate'
import type {
  GuessRadiusRequest,
  GuessRadiusResult,
  NormalEstimateAddon,
  NormalEstimateChunkSource,
  NormalEstimateEntityResult,
  NormalEstimateRequest,
} from '../../../../src/renderer/utils/normalEstimate'
import { srgbToLinear } from '../../../../src/renderer/utils/srgb'
// 测试专用的压缩镜像住在 normalCodesFixture.ts —— 圆柱拟合的合成数据也要编码法线，两处各留
// 一份必然漂移，故统一到那里。它的**逐行镜像**性质（对齐 normal_compressor.cc#compressNormal，
// QUANTIZE_LEVEL = 6：符号位 → L1 归一化 → 6 轮「半箱 + 扇区」细分）仍由本文件的往返误差断言守着；
// 抄错任何一处（尤其 `flip` 的翻转记账与 `sector !== 3` 的分支）都会在那里现形。
import { compressNormalMirror } from './normalCodesFixture'

// 纯函数（编解码镜像 / 摊平 / 着色映射）node 环境即可，无需 jsdom。
// C++ 对照测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试。

const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/normal-estimate/build/Release/normal_estimate.node', import.meta.url)
)
const nativeAvailable = existsSync(NATIVE_PATH)
const require = createRequire(import.meta.url)

function loadAddon(): NormalEstimateAddon {
  return require(NATIVE_PATH)
}

/** 全码查找表（多个 describe 共用；纯函数产物，建一次即可）。 */
const LUT = buildNormalLut()

/** 取码对应的单位向量（LUT 是渲染侧唯一解码入口，测试也走它）。 */
function decode(code: number): [number, number, number] {
  const i = code * 3
  return [LUT[i], LUT[i + 1], LUT[i + 2]]
}

/**
 * 逐位相等断言（用 `===` 而不是 `toBe`：`toBe` 走 Object.is 会把 `0` 与 `-0` 判为不等，
 * 而两者在渲染与数值上等价，不该让测试为符号零翻车；NaN 依旧必不等，正是想要的口径）。
 */
function expectSameNumbers(actual: ArrayLike<number>, expected: ArrayLike<number>, msg: string) {
  expect(actual.length, `${msg}：长度`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i] === expected[i], `${msg}：第 ${i} 项 ${actual[i]} !== ${expected[i]}`).toBe(true)
  }
}

/** 两单位向量夹角（度）。 */
function angleDeg(a: readonly number[], b: readonly number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI
}

/** 不做定向时正负都合法，取锐角版本。 */
function acuteAngleDeg(a: readonly number[], b: readonly number[]): number {
  return Math.min(angleDeg(a, b), angleDeg(a, [-b[0], -b[1], -b[2]]))
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

/** 归一化（镜像侧用 double，与 C++ 一致）。 */
function unit(v: readonly number[]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  return [v[0] / len, v[1] / len, v[2] / len]
}

// ---------------------------------------------------------------------------
// 合成点云
// ---------------------------------------------------------------------------

/**
 * 平面云 z = a·x + b·y + c，x/y 在 [-half, half]² 内均匀随机。
 * 解析法向 ∝ (−a, −b, 1)（符号由定向环节决定，不做定向时两者都可接受）。
 */
function planePoints(rand: () => number, count: number, a: number, b: number, c: number, half: number): Float32Array {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const x = (rand() * 2 - 1) * half
    const y = (rand() * 2 - 1) * half
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = a * x + b * y + c
  }
  return out
}

/** 球面云（半径 R，面积均匀采样）。解析法向 = 径向外向。 */
function spherePoints(rand: () => number, count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1
    const theta = rand() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    out[i * 3] = radius * r * Math.cos(theta)
    out[i * 3 + 1] = radius * r * Math.sin(theta)
    out[i * 3 + 2] = radius * u
  }
  return out
}

/**
 * 把全长点数组切进 chunks。`stride > 1` 用来造候选子集（每 stride 个顶点取 1 个，保持递增）——
 * 与分割产物 index 的语义一致：条目指向**本块**共享缓冲的顶点下标。
 */
function makeChunks(positions: Float32Array, chunkSize: number, stride = 1): NormalEstimateChunkSource[] {
  const total = positions.length / 3
  const chunks: NormalEstimateChunkSource[] = []
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(total, start + chunkSize)
    const count = end - start
    const slice = positions.slice(start * 3, end * 3)
    let index: Uint32Array | null = null
    if (stride > 1) {
      const picks: number[] = []
      for (let i = 0; i < count; i += stride) picks.push(i)
      index = new Uint32Array(picks)
    }
    chunks.push({ positions: slice, index })
  }
  return chunks
}

/** 候选总数（无 index = 全量顶点数）。 */
function candidateTotal(chunks: NormalEstimateChunkSource[]): number {
  return chunks.reduce((s, c) => s + (c.index ? c.index.length : c.positions.length / 3), 0)
}

// ---------------------------------------------------------------------------
// 纯函数：无需 native 产物，CI 也跑
// ---------------------------------------------------------------------------

describe('量化常量与线协议表', () => {
  it('常量自洽：15 位码宽、空码紧随最大有效码、反转掩码是三个符号位', () => {
    expect(NORMAL_QUANTIZE_LEVEL).toBe(6)
    expect(NULL_NORM_CODE).toBe(32768)
    expect(INVERT_XOR).toBe(7 << 12)
    expect(INVERT_XOR).toBe(28672)
    expect(NORMAL_LUT_SIZE).toBe(NULL_NORM_CODE + 1)
    expect(NORMAL_LUT_SIZE).toBe(32769)
    // 反转掩码只动符号位：翻转后仍落在有效码区间内（不会误撞空码）
    expect(32767 ^ INVERT_XOR).toBeLessThan(NULL_NORM_CODE)
  })

  it('下拉选项与线协议码表一一对应（漏一项 UI 就传不出合法码）', () => {
    expect(MODEL_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(NORMAL_MODEL_CODES).sort())
    expect(ORIENTATION_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(NORMAL_ORIENTATION_CODES).sort())
    // 选项不允许重复（重复会出现两个同时选中）
    expect(new Set(ORIENTATION_OPTIONS.map((o) => o.value)).size).toBe(ORIENTATION_OPTIONS.length)
    // 不支持的三项（依赖上一轮法向量 / 关联传感器）刻意不出现在选项里；UNDEFINED = 255
    expect(NORMAL_ORIENTATION_CODES.undefined).toBe(255)
    expect(Object.keys(NORMAL_ORIENTATION_CODES)).toHaveLength(ORIENTATION_OPTIONS.length)
  })
})

describe('decompressNormalCode（箱细分记账）', () => {
  it('全 0 码 = x 走六轮「上半箱」、y/z 每轮对折 ⇒ (1.984375, 0.015625, 0.015625)，即 +X 方向', () => {
    const out = new Float64Array(3)
    decompressNormalCode(0, out)
    // 扇区判定优先级是 z → y → x，故"每层都选 0"意味着只有 x 落在上半箱（端点逐轮收敛到
    // [0.984375, 1]，和 = 1.984375）；y/z 未被选中，上界每轮对折到 2⁻⁶。
    expectSameNumbers(out, [1.984375, 0.015625, 0.015625], '码 0')
    // 归一化后 ≈ +X 轴（残余偏心 ≈ 2⁻⁶ 量级）
    expect(LUT[0]).toBeCloseTo(1, 3)
    expect(Math.abs(LUT[1])).toBeLessThan(0.02)
    expect(Math.abs(LUT[2])).toBeLessThan(0.02)
  })

  it('全 3 码 = 六轮「留在本箱」⇒ 端点交替对折，未归一化 0.671875（三轴相同）', () => {
    // 六个扇区位全 3：3<<10 | 3<<8 | 3<<6 | 3<<4 | 3<<2 | 3 = 4095
    const out = new Float64Array(3)
    decompressNormalCode(4095, out)
    expectSameNumbers(out, [0.671875, 0.671875, 0.671875], '码 4095')
  })

  it('符号位在 bit14..12：置位即整轴取反（箱细分完全不受符号影响）', () => {
    const base = new Float64Array(3)
    decompressNormalCode(4095, base)
    const signs = [
      { bit: 4 << 12, axis: 0 },
      { bit: 2 << 12, axis: 1 },
      { bit: 1 << 12, axis: 2 },
    ]
    for (const { bit, axis } of signs) {
      const out = new Float64Array(3)
      decompressNormalCode(4095 | bit, out)
      for (let i = 0; i < 3; i++) {
        expect(out[i] === (i === axis ? -base[i] : base[i]), `轴 ${i}`).toBe(true)
      }
    }
  })

  it('空码 → 零向量（渲染侧按黑色处理）', () => {
    const out = new Float64Array(3)
    decompressNormalCode(NULL_NORM_CODE, out)
    expectSameNumbers(out, [0, 0, 0], '空码')
  })
})

describe('buildNormalLut', () => {
  it('长度 = 32769 × 3，且每项都是单位向量（空码除外）', () => {
    expect(LUT.length).toBe(NORMAL_LUT_SIZE * 3)
    let worst = 0
    for (let code = 0; code < NULL_NORM_CODE; code++) {
      const i = code * 3
      const len = Math.sqrt(LUT[i] * LUT[i] + LUT[i + 1] * LUT[i + 1] + LUT[i + 2] * LUT[i + 2])
      worst = Math.max(worst, Math.abs(len - 1))
    }
    // float32 存储的舍入上界（~6e-8/分量），留足余量
    expect(worst, '最大模长偏差').toBeLessThan(1e-6)
    expectSameNumbers(decode(NULL_NORM_CODE), [0, 0, 0], '空码项')
  })

  it('LUT[反转码] 与 −LUT[码] 逐位相等（编解码正确性最强的单条断言）', () => {
    // 箱细分只依赖绝对值 ⇒ 翻转符号位等价于对解码向量取反，且**精确**（不是近似）
    for (let code = 0; code < NULL_NORM_CODE; code++) {
      const a = decode(invertNormalCode(code))
      const b = decode(code)
      for (let i = 0; i < 3; i++) {
        if (a[i] !== -b[i]) throw new Error(`码 ${code} 轴 ${i}：${a[i]} !== ${-b[i]}`)
      }
    }
    // 空码取反仍是空码（"无法计算"取反还是"无法计算"）
    expect(invertNormalCode(NULL_NORM_CODE)).toBe(NULL_NORM_CODE)
  })

  it('invertNormalCode 两次调用回到原码', () => {
    for (const code of [0, 1, 4095, 12345, 32767]) {
      expect(invertNormalCode(invertNormalCode(code))).toBe(code)
    }
  })
})

describe('compress ↔ decompress 往返（镜像 = C++ 的逐行实现）', () => {
  it('轴 / 对角 / 随机方向的往返角误差 < 2°（level 6 满量程 ≈ 1.55°）', () => {
    const rand = mulberry32(7)
    const dirs: number[][] = [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [1, 1, 1],
      [-1, -1, -1],
      [0.3, -0.7, 0.2],
    ]
    for (let i = 0; i < 200; i++) {
      dirs.push([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1])
    }
    let worst = 0
    for (const d of dirs) {
      const n = unit(d)
      const code = compressNormalMirror(n)
      expect(code, `方向 ${d} 应产生有效码`).toBeLessThan(NULL_NORM_CODE)
      const err = angleDeg(n, decode(code))
      worst = Math.max(worst, err)
      expect(err, `方向 ${d} 的往返角误差`).toBeLessThan(2)
    }
    // 量化误差上界：符号位不耗精度，每轴 6 层 ⇒ 单轴步长 2⁻⁶，最坏（体对角）≈ atan(√3·2⁻⁶) ≈ 1.55°
    expect(worst).toBeLessThan(1.6)
  })

  it('compress(−n) === compress(n) ^ INVERT_XOR（反转只能翻符号位）', () => {
    const rand = mulberry32(11)
    for (let i = 0; i < 300; i++) {
      const n = unit([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1])
      const pos = compressNormalMirror(n)
      const neg = compressNormalMirror([-n[0], -n[1], -n[2]])
      expect(neg).toBe(pos ^ INVERT_XOR)
    }
  })

  it('零向量 → NULL_NORM_CODE（L1 和为 0 的退化输入）', () => {
    expect(compressNormalMirror([0, 0, 0])).toBe(NULL_NORM_CODE)
  })
})

describe('scatterNormalCodes（每候选一码 → 每顶点一码）', () => {
  it('无 index 的块走零拷贝快路径：返回的就是入参数组本身', () => {
    const codes = [new Uint16Array([1, 2, 3])]
    const out = scatterNormalCodes([{ positions: new Float32Array(9), index: null }], codes)
    expect(out[0]).toBe(codes[0]) // 同一引用，不是副本
  })

  it('带 index 的块散写到顶点缓冲空间：未入选顶点保持空码', () => {
    const positions = new Float32Array(12) // 4 个顶点
    const index = new Uint32Array([1, 3])
    const codes = [new Uint16Array([111, 222])]
    const out = scatterNormalCodes([{ positions, index }], codes)
    expect(out[0].length).toBe(4)
    expect(Array.from(out[0])).toEqual([NULL_NORM_CODE, 111, NULL_NORM_CODE, 222])
    expect(out[0]).not.toBe(codes[0]) // 散写必然新建
  })

  it('逐块对齐：块数与输入一致，各块独立摊平', () => {
    const chunks: NormalEstimateChunkSource[] = [
      { positions: new Float32Array(6), index: null },
      { positions: new Float32Array(12), index: new Uint32Array([0, 2]) },
    ]
    const codes = [new Uint16Array([5, 6]), new Uint16Array([7, 8])]
    const out = scatterNormalCodes(chunks, codes)
    expect(out).toHaveLength(2)
    expect(Array.from(out[0])).toEqual([5, 6])
    expect(Array.from(out[1])).toEqual([7, NULL_NORM_CODE, 8, NULL_NORM_CODE])
  })
})

describe('normalCodeToRgbLinear（静态烘焙着色）', () => {
  const out = new Uint8Array(3)

  it('+Z 码 → 蓝通道满、红绿相等；−Z 码 → 蓝通道 0（上下两色可分）', () => {
    const plusZ = compressNormalMirror([0, 0, 1])
    normalCodeToRgbLinear(LUT, plusZ, out)
    expect(out[0]).toBe(out[1])
    expect(out[2]).toBeGreaterThan(200)
    const up = [out[0], out[1], out[2]]

    const minusZ = invertNormalCode(plusZ)
    normalCodeToRgbLinear(LUT, minusZ, out)
    expect(out[0]).toBe(out[1])
    expect(out[2]).toBe(0)
    // 与 +Z 版本确实不同（否则"朝向色"没有判读价值）
    expect([out[0], out[1], out[2]]).not.toEqual(up)
  })

  it('映射是 (N+1)/2 再 srgbToLinear（不是直接写 sRGB 值）', () => {
    const code = compressNormalMirror(unit([0.3, -0.7, 0.2]))
    const n = decode(code)
    normalCodeToRgbLinear(LUT, code, out)
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBe(Math.round(srgbToLinear((n[i] + 1) / 2) * 255))
    }
  })

  it('空码 → 纯黑（无法向量的顶点不能伪装成某个朝向）', () => {
    normalCodeToRgbLinear(LUT, NULL_NORM_CODE, out)
    expect(Array.from(out)).toEqual([0, 0, 0])
  })
})

// ---------------------------------------------------------------------------
// C++ 契约与解析解对照：native 产物缺失时整组 skip（describe.skipIf 在文件顶层求值）
// ---------------------------------------------------------------------------

describe.skipIf(!nativeAvailable)('normal_estimate.node 契约、解析解与确定性', () => {
  let addon: NormalEstimateAddon
  beforeAll(() => {
    addon = loadAddon()
  })

  /** promise 化 computeNormals（同步 throw 也转成 reject，与 store 的写法一致）。 */
  function computeNative(req: NormalEstimateRequest): Promise<NormalEstimateEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.computeNormals(req, (err, results) => {
          if (err) reject(err)
          else resolve(results ?? [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  /** promise 化 guessRadius。 */
  function guessRadiusNative(req: GuessRadiusRequest): Promise<GuessRadiusResult> {
    return new Promise((resolve, reject) => {
      try {
        addon.guessRadius(req, (err, result) => {
          if (err) reject(err)
          else resolve(result as GuessRadiusResult)
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  const baseRequest = (chunks: NormalEstimateChunkSource[], over: Partial<NormalEstimateRequest> = {}) =>
    ({
      radius: 0.5,
      model: NORMAL_MODEL_CODES.ls,
      orientation: NORMAL_ORIENTATION_CODES.undefined,
      entities: [{ entityId: 1, chunks }],
      ...over,
    }) as NormalEstimateRequest

  /**
   * 单实体估计 + 逐块码**按候选顺序拼接**成一个数组。
   * 无 index 时（stride = 1）拼接结果的下标就是全局顶点号——球面径向、重心定向这两组
   * 断言依赖这一点。
   */
  async function codesOf(
    positions: Float32Array,
    over: Partial<NormalEstimateRequest> = {},
    chunkSize = positions.length / 3,
    stride = 1
  ): Promise<Uint16Array> {
    const chunks = makeChunks(positions, chunkSize, stride)
    const [r] = await computeNative(baseRequest(chunks, over))
    expect(r.codes).toHaveLength(chunks.length)
    const all = new Uint16Array(candidateTotal(chunks))
    let off = 0
    for (const arr of r.codes) {
      all.set(arr, off)
      off += arr.length
    }
    return all
  }

  // ---- 组 1：契约 ----

  it('参数校验：类型不符 / 取值越界时**同步**抛 TypeError（不走回调、不静默算错）', () => {
    const cb = () => {}
    const withReq = (req: unknown) => () => addon.computeNormals(req as NormalEstimateRequest, cb)
    expect(withReq({})).toThrow(TypeError)
    expect(withReq({ radius: '0.5', model: 0, orientation: 255, entities: [] })).toThrow(TypeError)
    expect(withReq({ radius: 0.5, model: 5, orientation: 255, entities: [] })).toThrow(TypeError)
    expect(withReq({ radius: 0.5, model: 0, orientation: 255, entities: 'x' })).toThrow(TypeError)
    expect(withReq({ radius: 0.5, model: 0, orientation: 255, entities: [{ entityId: 'a', chunks: [] }] })).toThrow(TypeError)
    // positions 必须是 Float32Array（喂 Float64Array / 长度非 3 倍数也不行）
    expect(
      withReq({
        radius: 0.5,
        model: 0,
        orientation: 255,
        entities: [{ entityId: 1, chunks: [{ positions: new Float64Array(3), index: null }] }],
      })
    ).toThrow(TypeError)
    expect(
      withReq({
        radius: 0.5,
        model: 0,
        orientation: 255,
        entities: [{ entityId: 1, chunks: [{ positions: new Float32Array(4), index: null }] }],
      })
    ).toThrow(TypeError)
    expect(() => addon.guessRadius({} as unknown as GuessRadiusRequest, cb)).toThrow(TypeError)
    expect(() => addon.guessRadius({ entityId: 1, chunks: 'x' } as unknown as GuessRadiusRequest, cb)).toThrow(TypeError)
  })

  it('回包形状：块数对齐、每块长度 = 该块候选数、统计量与候选总数自洽', async () => {
    const rand = mulberry32(21)
    const pts = planePoints(rand, 2000, 0.1, 0.2, 0, 5)
    const chunks = makeChunks(pts, 700, 3) // 带 index（每 3 个取 1）
    const [r] = await computeNative(baseRequest(chunks, { radius: 0.4 }))
    expect(r.entityId).toBe(1)
    expect(r.codes).toHaveLength(chunks.length)
    chunks.forEach((c, i) => {
      expect(r.codes[i].length, `块 ${i} 码条数 = 候选数`).toBe(c.index ? c.index.length : c.positions.length / 3)
    })
    expect(r.computed + r.nullCount).toBe(candidateTotal(chunks))
    expect(r.capped).toBeLessThanOrEqual(r.nullCount)
    expect(Array.from(r.codes[0]).every((c) => c <= NULL_NORM_CODE)).toBe(true)
  })

  it('多实体：逐实体独立估计，entityId 原样回传，结果与单独调用一致', async () => {
    const randA = mulberry32(31)
    const randB = mulberry32(32)
    const a = planePoints(randA, 800, 0.1, 0.2, 0, 3)
    const b = planePoints(randB, 800, -0.3, 0.05, 1, 3)
    const chunkA: NormalEstimateChunkSource[] = [{ positions: a, index: null }]
    const chunkB: NormalEstimateChunkSource[] = [{ positions: b, index: null }]
    const both = await computeNative({
      radius: 0.3,
      model: NORMAL_MODEL_CODES.ls,
      orientation: NORMAL_ORIENTATION_CODES.undefined,
      entities: [
        { entityId: 5, chunks: chunkA },
        { entityId: 8, chunks: chunkB },
      ],
    })
    expect(both.map((r) => r.entityId)).toEqual([5, 8])
    const [onlyA] = await computeNative(baseRequest(chunkA, { radius: 0.3 }))
    const [onlyB] = await computeNative(baseRequest(chunkB, { radius: 0.3 }))
    expect(Array.from(both[0].codes[0])).toEqual(Array.from(onlyA.codes[0]))
    expect(Array.from(both[1].codes[0])).toEqual(Array.from(onlyB.codes[0]))
  })

  // ---- 组 2：解析解（LS / Quadric 的核心正确性承诺） ----

  it('平面云 LS：与解析法向夹角 < 1°（全量候选与带 index 的候选子集都算）', async () => {
    const truth = unit([-0.1, -0.2, 1])
    const rand = mulberry32(41)
    const pts = planePoints(rand, 4000, 0.1, 0.2, 0, 5)
    const cases = [
      { name: '全量候选单块', chunkSize: pts.length / 3, stride: 1 },
      { name: '带 index 候选子集', chunkSize: 1000, stride: 3 },
    ]
    for (const c of cases) {
      const codes = await codesOf(pts, { radius: 0.5 }, c.chunkSize, c.stride)
      let worst = 0
      let n = 0
      for (const code of codes) {
        if (code === NULL_NORM_CODE) continue
        worst = Math.max(worst, acuteAngleDeg(decode(code), truth))
        n++
      }
      expect(n, `${c.name}：绝大多数点应算出法向量`).toBeGreaterThan(codes.length * 0.9)
      expect(worst, `${c.name}：最大角误差`).toBeLessThan(1)
    }
  })

  it('平面云 Quadric：与解析法向夹角 < 1°（局部二次项 ≈ 0）', async () => {
    const truth = unit([-0.1, -0.2, 1])
    const rand = mulberry32(42)
    const pts = planePoints(rand, 4000, 0.1, 0.2, 0, 5)
    const codes = await codesOf(pts, { radius: 0.5, model: NORMAL_MODEL_CODES.quadric })
    let worst = 0
    let n = 0
    for (const code of codes) {
      if (code === NULL_NORM_CODE) continue
      worst = Math.max(worst, acuteAngleDeg(decode(code), truth))
      n++
    }
    // 平面上二次项为零、邻域也够 ⇒ 不该出现退化空码
    expect(n).toBe(codes.length)
    expect(worst, 'Quadric 最大角误差').toBeLessThan(1)
  })

  it('球面云：两种模型都落在径向附近；Quadric 不劣于 LS', async () => {
    const rand = mulberry32(51)
    const pts = spherePoints(rand, 6000, 5)
    const stats = async (model: number) => {
      const codes = await codesOf(pts, { radius: 0.8, model }, 2000)
      let sum = 0
      let n = 0
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]
        if (code === NULL_NORM_CODE) continue
        // 无 index ⇒ 拼接数组下标 = 全局顶点号，查询点就是它自己
        sum += acuteAngleDeg(decode(code), unit([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]))
        n++
      }
      return { mean: sum / n, n, total: codes.length }
    }
    const ls = await stats(NORMAL_MODEL_CODES.ls)
    const qd = await stats(NORMAL_MODEL_CODES.quadric)
    expect(ls.n).toBeGreaterThan(ls.total * 0.9)
    expect(ls.mean, 'LS 平均角误差').toBeLessThan(3)
    expect(qd.mean, 'Quadric 平均角误差').toBeLessThan(3)
    // 对称邻域上 LS 本就不产生系统性偏差（最小特征向量仍是径向；CC 文档里"LS 在曲面上有偏差"
    // 说的是**非对称**邻域与带噪情形），故这里断言的是"Quadric 不劣于 LS"而非"必须更好"。
    expect(qd.mean, 'Quadric 不应明显劣于 LS').toBeLessThan(ls.mean * 1.5 + 0.05)
  })

  // ---- 组 3：定向 ----

  it('定向 +Z / −Z：解码法向的 z 分量全部同号，且两者互为反转', async () => {
    const rand = mulberry32(61)
    const pts = planePoints(rand, 2000, 0.1, 0.2, 0, 5)
    const up = await codesOf(pts, { radius: 0.5, orientation: NORMAL_ORIENTATION_CODES['plus-z'] })
    const down = await codesOf(pts, { radius: 0.5, orientation: NORMAL_ORIENTATION_CODES['minus-z'] })
    for (const code of up) {
      if (code === NULL_NORM_CODE) continue
      expect(decode(code)[2]).toBeGreaterThan(0)
    }
    for (const code of down) {
      if (code === NULL_NORM_CODE) continue
      expect(decode(code)[2]).toBeLessThan(0)
    }
    // 同一批点的符号位恰好相反（Compress(−n) = Compress(n) ^ INVERT_XOR）
    for (let i = 0; i < up.length; i++) {
      expect(down[i]).toBe(invertNormalCode(up[i]))
    }
  })

  it('定向 背离重心：法向与 (点 − 重心) 点积 > 0（球心在原点时即径向朝外）', async () => {
    const rand = mulberry32(62)
    const pts = spherePoints(rand, 5000, 5)
    const n = pts.length / 3
    let cx = 0
    let cy = 0
    let cz = 0
    for (let i = 0; i < n; i++) {
      cx += pts[i * 3]
      cy += pts[i * 3 + 1]
      cz += pts[i * 3 + 2]
    }
    const bary = [cx / n, cy / n, cz / n]
    const codes = await codesOf(pts, { radius: 0.7, orientation: NORMAL_ORIENTATION_CODES['plus-barycenter'] }, 2500)
    let checked = 0
    for (let i = 0; i < n; i++) {
      const code = codes[i]
      if (code === NULL_NORM_CODE) continue
      const nv = decode(code)
      const d =
        nv[0] * (pts[i * 3] - bary[0]) + nv[1] * (pts[i * 3 + 1] - bary[1]) + nv[2] * (pts[i * 3 + 2] - bary[2])
      expect(d, `点 ${i} 应背离重心`).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBeGreaterThan(n * 0.9)
  })

  // ---- 组 4：退化与边界 ----

  it('孤点 / 两点 / 空候选：不崩，邻域不足的点留空码并计入 capped', async () => {
    // 单点：半径放大到 16 倍也只有自身 1 个邻居 < 3 ⇒ 空码 + capped（CC 同语义）
    const [r1] = await computeNative(baseRequest([{ positions: new Float32Array([1, 2, 3]), index: null }], { radius: 5 }))
    expect(Array.from(r1.codes[0])).toEqual([NULL_NORM_CODE])
    expect(r1.computed).toBe(0)
    expect(r1.nullCount).toBe(1)
    expect(r1.capped).toBe(1)

    const two = new Float32Array([0, 0, 0, 1, 1, 1])
    const [r2] = await computeNative(baseRequest([{ positions: two, index: null }], { radius: 5 }))
    expect(Array.from(r2.codes[0])).toEqual([NULL_NORM_CODE, NULL_NORM_CODE])
    expect(r2.capped).toBe(2)

    // 空块：码数组长度 0，不参与统计
    const [r3] = await computeNative(
      baseRequest([
        { positions: new Float32Array(0), index: null },
        // ⚠ 长度 0 的 index 经 N-API 后与「没有 index」等价（`Data()` 对空数组给空指针），
        // native 的 `candidateCountOfChunk` 遂按**全量顶点**算——不是 0 个候选。
        // 渲染侧 `candidateCountOfChunk`（geometryVisibleIndex → slice(0,0)）算出 0，
        // 故 `pointcloudStore.setEntityNormalCodes` 的逐块长度校验会拒绝写入（干净失败，
        // 不是静默写坏）。这个不一致是九个模块共有的既定语义，此处只做记录与钉桩。
        { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array([]) },
      ])
    )
    expect(r3.codes).toHaveLength(2)
    expect(r3.codes[0]).toHaveLength(0)
    // 3 个非共线点 ⇒ 即使半径再大也只有 3 个邻居 = kMinPointsLS，正好够 LS 拟合（不空码）
    const nonEmpty = Array.from(r3.codes[1])
    expect(nonEmpty).toHaveLength(3)
    expect(nonEmpty.every((c) => c !== NULL_NORM_CODE)).toBe(true)
    expect(r3.computed).toBe(3)
    expect(r3.nullCount).toBe(0)

    // 无块的实体（防御）：回空 codes，不崩
    const [r4] = await computeNative(baseRequest([]))
    expect(r4.codes).toHaveLength(0)
    expect(r4.computed).toBe(0)
    expect(r4.nullCount).toBe(0)

    // 一个实体都没有：回空数组而不是报错（直接构造，baseRequest 的默认形态是「单实体」）
    const empty = await computeNative({ ...baseRequest([]), entities: [] })
    expect(empty).toHaveLength(0)
  })

  it('radius <= 0：全部空码且 capped = 候选总数（"半径不合法"与"邻域不足"同路返回）', async () => {
    const rand = mulberry32(71)
    const pts = planePoints(rand, 500, 0.1, 0.2, 0, 5)
    for (const radius of [0, -1]) {
      const [r] = await computeNative(baseRequest([{ positions: pts, index: null }], { radius }))
      expect(r.computed).toBe(0)
      expect(r.nullCount).toBe(500)
      expect(r.capped).toBe(500)
      expect(Array.from(r.codes[0]).every((c) => c === NULL_NORM_CODE)).toBe(true)
    }
  })

  it('半径明显偏小时 capped 占空码多数（渲染侧据此提示"半径偏小"）', async () => {
    // 半径 1e-4：放大到 16 倍（1.6e-3）仍几乎只有自身 ⇒ 全部 capped
    const rand = mulberry32(72)
    const pts = planePoints(rand, 1000, 0, 0, 0, 5)
    const [r] = await computeNative(baseRequest([{ positions: pts, index: null }], { radius: 1e-4 }))
    expect(r.nullCount).toBe(1000)
    expect(r.capped).toBeGreaterThan(r.nullCount * 0.5)
  })

  // ---- 组 5：确定性与分块不变性 ----

  it('确定性：同参数两次调用码逐位相等（逐点独立 + 固定归约顺序）', async () => {
    const rand = mulberry32(81)
    const pts = planePoints(rand, 3000, 0.1, 0.2, 0, 5)
    const chunks = makeChunks(pts, 1000, 2)
    const req = baseRequest(chunks, { radius: 0.45, model: NORMAL_MODEL_CODES.quadric })
    const [a] = await computeNative(req)
    const [b] = await computeNative(req)
    expect(a.computed).toBe(b.computed)
    expect(a.nullCount).toBe(b.nullCount)
    a.codes.forEach((arr, i) => expect(Array.from(b.codes[i])).toEqual(Array.from(arr)))
  })

  it('分块不变性：同一批点切 1 / 3 / 20 块，逐点码完全相同（邻居跨块搜索）', async () => {
    const rand = mulberry32(91)
    const pts = planePoints(rand, 1500, 0.1, 0.2, 0, 5)
    const whole = await codesOf(pts, { radius: 0.4 }, pts.length / 3)
    for (const chunkSize of [500, 75]) {
      const codes = await codesOf(pts, { radius: 0.4 }, chunkSize)
      expect(Array.from(codes)).toEqual(Array.from(whole))
    }
  })

  // ---- 组 6：自动半径 ----

  it('Auto 半径：均匀面云上末轮邻域人口落在目标区间（16 ± 4）', async () => {
    // 面上均匀随机点：半径 r 的期望人口 = π r² λ（λ = N / 面积 = 20000 / 10000 = 2）
    const rand = mulberry32(101)
    const pts = planePoints(rand, 20000, 0, 0, 0, 50)
    const res = await guessRadiusNative({ entityId: 1, chunks: [{ positions: pts, index: null }] })
    expect(res.entityId).toBe(1)
    expect(res.radius).toBeGreaterThan(0)
    expect(res.attempts).toBeGreaterThan(0)
    expect(res.sampledCount).toBe(Math.min(200, Math.floor(20000 / 10)))
    // 收工判据是 |均值 − 16| < 4，故命中时人口必然落在 [12, 20]
    expect(res.meanPopulation).toBeGreaterThan(11)
    expect(res.meanPopulation).toBeLessThan(21)
    expect(res.stdDevPopulation).toBeGreaterThanOrEqual(0)
    // 期望半径 ≈ sqrt(16 / (π λ)) ≈ 1.596（命中区间 ⇒ 实际落在 [1.4, 1.8] 附近）
    const analytic = Math.sqrt(16 / (Math.PI * 2))
    expect(res.radius).toBeGreaterThan(analytic * 0.8)
    expect(res.radius).toBeLessThan(analytic * 1.25)
  })

  it('Auto 半径可复现：同输入两次调用数值完全相同（固定种子；CC 用 random_device 做不到）', async () => {
    const rand = mulberry32(102)
    const pts = planePoints(rand, 5000, 0.1, 0.2, 0, 20)
    const req: GuessRadiusRequest = { entityId: 3, chunks: [{ positions: pts, index: null }] }
    const a = await guessRadiusNative(req)
    const b = await guessRadiusNative(req)
    expect(b.radius).toBe(a.radius)
    expect(b.meanPopulation).toBe(a.meanPopulation)
    expect(b.attempts).toBe(a.attempts)
  })

  it('Auto 半径：点数 < 100 直接返回朴素半径（最长包围盒边 / min(100, max(1, N/100))）', async () => {
    // 64 个点铺在 7×7 面上 ⇒ N/100 = 0（整数除）⇒ 除数 1 ⇒ 半径 = 最长边 = 7
    const pts = new Float32Array(64 * 3)
    for (let i = 0; i < 64; i++) {
      pts[i * 3] = i % 8
      pts[i * 3 + 1] = Math.floor(i / 8)
      pts[i * 3 + 2] = 0
    }
    const res = await guessRadiusNative({ entityId: 1, chunks: [{ positions: pts, index: null }] })
    expect(res.attempts).toBe(0)
    expect(res.sampledCount).toBe(0)
    expect(res.radius).toBeCloseTo(7, 5)
  })

  it('Auto 半径：空实体返回 0（不抛错、不给 NaN）', async () => {
    const res = await guessRadiusNative({ entityId: 1, chunks: [{ positions: new Float32Array(0), index: null }] })
    expect(res.radius).toBe(0)
  })
})
