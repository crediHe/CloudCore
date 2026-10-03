import { describe, it, expect } from 'vitest'
import {
  linearToSrgb,
  linearToSrgbU8,
  linearU8ToSrgbU8,
  srgbToLinear,
  srgbU8ToLinear,
} from '../../../../src/renderer/utils/srgb'

// 纯数学，node 环境即可（不依赖 DOM），无需 jsdom 注释。
// 参考值按 IEC 61966-2-1 分段式独立推导（与 three SRGBToLinear 同款）。

describe('srgbToLinear（sRGB 0-1 → 线性）', () => {
  it('端点与暗部线性段（c ≤ 0.04045 → c/12.92）', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBe(1)
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 10)
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 10)
  })

  it('亮部幂段：0.5 → ≈0.2140（即显示端若按线性直写会提亮到 ~0.73，淡的根源）', () => {
    // ((0.5+0.055)/1.055)^2.4
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404, 4)
    expect(srgbToLinear(0.25)).toBeCloseTo(0.05088, 4)
    expect(srgbToLinear(0.75)).toBeCloseTo(0.5225, 4)
  })

  it('单调不减且值域收敛于 [0,1]（抽样性质）', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const v = srgbToLinear(i / 100)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      prev = v
    }
  })
})

describe('srgbU8ToLinear（u8 字节 → 线性）', () => {
  it('端点：0→0、255→1', () => {
    expect(srgbU8ToLinear(0)).toBe(0)
    expect(srgbU8ToLinear(255)).toBe(1)
  })

  it('中灰 128 → ≈0.2158（字节 sRGB 码 128 直接当线性会使显示端提亮）', () => {
    expect(srgbU8ToLinear(128)).toBeCloseTo(0.2158, 3)
    expect(srgbU8ToLinear(64)).toBeCloseTo(0.0513, 3)
  })

  it('与 srgbToLinear 一致：等价于 srgbToLinear(v/255)', () => {
    for (const v of [0, 1, 2, 60, 127, 128, 200, 254, 255]) {
      expect(srgbU8ToLinear(v)).toBeCloseTo(srgbToLinear(v / 255), 12)
    }
  })
})

describe('linearToSrgb（线性 → sRGB 0-1，导出方向）', () => {
  it('端点与暗部线性段（c ≤ 0.0031308 → c × 12.92）', () => {
    expect(linearToSrgb(0)).toBe(0)
    // 1.055×1 − 0.055 在浮点下是 0.9999999999999999（three 的 LinearToSRGB 同样如此）
    expect(linearToSrgb(1)).toBeCloseTo(1, 12)
    expect(linearToSrgb(0.001)).toBeCloseTo(0.001 * 12.92, 12)
  })

  it('亮部幂段：0.2140 → ≈0.5（加载时被压暗的值，导出必须编回原样）', () => {
    expect(linearToSrgb(0.21404)).toBeCloseTo(0.5, 4)
    expect(linearToSrgb(0.05088)).toBeCloseTo(0.25, 4)
    expect(linearToSrgb(0.5225)).toBeCloseTo(0.75, 4)
  })

  it('与 srgbToLinear 互逆（1e-12 量级）', () => {
    for (let i = 0; i <= 100; i++) {
      const c = i / 100
      expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 12)
      expect(srgbToLinear(linearToSrgb(c))).toBeCloseTo(c, 12)
    }
  })
})

describe('linearToSrgbU8 / linearU8ToSrgbU8（导出落字节）', () => {
  it('端点与钳位：0→0、1→255，越界输入夹到 [0,255]', () => {
    expect(linearToSrgbU8(0)).toBe(0)
    expect(linearToSrgbU8(1)).toBe(255)
    expect(linearToSrgbU8(-1)).toBe(0)
    expect(linearToSrgbU8(2)).toBe(255)
  })

  it('线性中灰 srgbU8ToLinear(128) → 128 字节（加载值原样编回，色不变）', () => {
    expect(linearToSrgbU8(srgbU8ToLinear(128))).toBe(128)
  })

  it('LUT 版与逐点算完全等价（256 项全等，故聚类预览色的导出精度与加载色一致）', () => {
    for (let v = 0; v < 256; v++) {
      expect(linearU8ToSrgbU8(v)).toBe(linearToSrgbU8(v / 255))
    }
  })

  it('sRGB 字节往返：srgbU8ToLinear → linearToSrgbU8 逐字节恒等（256 项全等）', () => {
    // 这是"加载进来的颜色原样存回去"的保证。注意 **线性字节空间与 sRGB 字节空间不是同一个
    // 刻度**：linearU8ToSrgbU8(1) = 13（线性 1/255 已经很亮），所以那条恒等式只对 sRGB 字节成立。
    for (let v = 0; v < 256; v++) {
      expect(linearToSrgbU8(srgbU8ToLinear(v))).toBe(v)
    }
  })
})
