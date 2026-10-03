import { describe, it, expect } from 'vitest'
import {
  ELEVATION_BINS,
  ELEVATION_RAMP_ANCHORS,
  ELEVATION_RAMP_CSS,
  buildElevationLut,
  buildElevationRampSrgb,
  binIndexOf,
  countInRange,
  elevationAxis,
  fillElevationColors,
  getElevationLut,
  histogramOfZ,
  normalizeElevationRange,
} from '../../../../src/renderer/utils/elevation'
import { srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'

/** 轴箱边界对应的值（手柄吸附到箱边界，读数与着色都建立在这个前提上）。 */
function binEdge(axis: { min: number; max: number }, b: number): number {
  return axis.min + (b / ELEVATION_BINS) * (axis.max - axis.min)
}

describe('elevation（高程色带 / 直方图 / 范围规整）', () => {
  describe('色带 LUT', () => {
    it('sRGB 色带 256 项，两端是锚点（蓝 → 红）', () => {
      const ramp = buildElevationRampSrgb()
      expect(ramp.length).toBe(ELEVATION_BINS * 3)
      expect(Array.from(ramp.slice(0, 3))).toEqual([0, 0, 255])
      expect(Array.from(ramp.slice(-3))).toEqual([255, 0, 0])
      // 每一档与锚点表的两端一致（表顺序即"低 → 高"）
      expect(Array.from(ramp.slice(0, 3))).toEqual(Array.from(ELEVATION_RAMP_ANCHORS[0]))
      expect(Array.from(ramp.slice(-3))).toEqual(Array.from(ELEVATION_RAMP_ANCHORS[ELEVATION_RAMP_ANCHORS.length - 1]))
    })

    it('色带没有"所有通道都低"的档位（8 位线性量化的暗部台阶守卫）', () => {
      const ramp = buildElevationRampSrgb()
      for (let k = 0; k < ELEVATION_BINS; k++) {
        const r = ramp[k * 3]
        const g = ramp[k * 3 + 1]
        const b = ramp[k * 3 + 2]
        expect(Math.max(r, g, b)).toBeGreaterThanOrEqual(200)
      }
    })

    it('LUT 是**线性**字节（与 srgbU8ToLinear × 255 同口径），不是 sRGB 码', () => {
      const ramp = buildElevationRampSrgb()
      const lut = buildElevationLut()
      expect(lut.length).toBe(ELEVATION_BINS * 3)
      for (let i = 0; i < ramp.length; i++) {
        expect(lut[i]).toBe(Math.round(srgbU8ToLinear(ramp[i]) * 255))
      }
      // 关键哨兵：线性字节 ≠ sRGB 码（中间灰直接抄字节会得到 128，正确值是 55）
      const midGray = Math.round(srgbU8ToLinear(128) * 255)
      expect(midGray).toBeLessThan(80)
    })

    it('getElevationLut 返回模块级缓存的同一实例', () => {
      expect(getElevationLut()).toBe(getElevationLut())
    })

    it('CSS 渐变串由锚点构成（图例与色带条共用）', () => {
      expect(ELEVATION_RAMP_CSS.startsWith('linear-gradient(90deg, ')).toBe(true)
      expect(ELEVATION_RAMP_CSS.split('rgb(').length - 1).toBe(ELEVATION_RAMP_ANCHORS.length)
    })
  })

  describe('elevationAxis（唯一换算点）', () => {
    it('轴 = 原始包围盒 − 全局平移（显示坐标）', () => {
      expect(elevationAxis({ minZ: -1.5, maxZ: 48.5 }, { z: -0.5 })).toEqual({ min: -1, max: 49 })
    })

    it('平移非零时轴整体跟随（漏换算会整体偏移，画面照样出颜色）', () => {
      const shifted = elevationAxis({ minZ: 100, maxZ: 200 }, { z: 100 })
      expect(shifted).toEqual({ min: 0, max: 100 })
    })
  })

  describe('normalizeElevationRange', () => {
    const axis = { min: 0, max: 100 }

    it('null → 满量程（默认态 = 正常的 Z 最高最低着色）', () => {
      expect(normalizeElevationRange(axis, null)).toEqual({ min: 0, max: 100 })
    })

    it('倒置输入互换后使用', () => {
      expect(normalizeElevationRange(axis, { min: 80, max: 20 })).toEqual({ min: 20, max: 80 })
    })

    it('部分越界钳到轴内', () => {
      expect(normalizeElevationRange(axis, { min: -50, max: 30 })).toEqual({ min: 0, max: 30 })
      expect(normalizeElevationRange(axis, { min: 70, max: 500 })).toEqual({ min: 70, max: 100 })
    })

    it('完全落在轴外 → 回满量程（不要一片纯端色）', () => {
      expect(normalizeElevationRange(axis, { min: 200, max: 300 })).toEqual({ min: 0, max: 100 })
      expect(normalizeElevationRange(axis, { min: -300, max: -200 })).toEqual({ min: 0, max: 100 })
    })

    it('跨度不足一箱 → 扩到一箱且不越界（避免 hi === lo 的除零 / 纯色）', () => {
      const thin = normalizeElevationRange(axis, { min: 50, max: 50 })
      expect(thin.max - thin.min).toBeCloseTo(100 / ELEVATION_BINS, 10)
      expect(thin.min).toBeGreaterThanOrEqual(0)
      expect(thin.max).toBeLessThanOrEqual(100)
      const atMin = normalizeElevationRange(axis, { min: 0, max: 0 })
      expect(atMin.min).toBe(0)
      expect(atMin.max).toBeGreaterThan(0)
      const atMax = normalizeElevationRange(axis, { min: 100, max: 100 })
      expect(atMax.max).toBe(100)
      expect(atMax.min).toBeLessThan(100)
    })

    it('退化轴原样返回（水平云不产生 NaN）', () => {
      expect(normalizeElevationRange({ min: 5, max: 5 }, { min: 1, max: 2 })).toEqual({ min: 5, max: 5 })
    })

    it('非有限值 → 满量程', () => {
      expect(normalizeElevationRange(axis, { min: NaN, max: 50 })).toEqual({ min: 0, max: 100 })
      expect(normalizeElevationRange(axis, { min: 0, max: Infinity })).toEqual({ min: 0, max: 100 })
    })
  })

  describe('histogramOfZ', () => {
    /** 构造 positions：z 依次取给定值（x=y=0）。 */
    function positionsOf(zs: number[]): Float32Array {
      const out = new Float32Array(zs.length * 3)
      zs.forEach((z, i) => {
        out[i * 3 + 2] = z
      })
      return out
    }

    it('逐点精确分箱（轴 [0,256]，z=i 落第 i 箱）', () => {
      const axis = { min: 0, max: 256 }
      const bins = new Uint32Array(ELEVATION_BINS)
      const counted = histogramOfZ(positionsOf([0, 1, 128, 255]), null, axis, bins)
      expect(counted).toBe(4)
      expect(bins[0]).toBe(1)
      expect(bins[1]).toBe(1)
      expect(bins[128]).toBe(1)
      expect(bins[255]).toBe(1)
    })

    it('闭区间语义：z === axis.max 落最后一箱（不是溢出到箱外）', () => {
      const axis = { min: 0, max: 256 }
      const bins = new Uint32Array(ELEVATION_BINS)
      histogramOfZ(positionsOf([256]), null, axis, bins)
      expect(bins[255]).toBe(1)
    })

    it('**index 感知**（滤波产物的回归哨兵：按 index 取才是它自己的分布）', () => {
      const axis = { min: 0, max: 256 }
      const positions = positionsOf([0, 256, 0, 256])
      const full = new Uint32Array(ELEVATION_BINS)
      histogramOfZ(positions, null, axis, full)
      expect(full[0]).toBe(2)
      expect(full[255]).toBe(2)
      const subset = new Uint32Array(ELEVATION_BINS)
      const counted = histogramOfZ(positions, new Uint32Array([2, 3]), axis, subset)
      expect(counted).toBe(2)
      expect(subset[0]).toBe(1)
      expect(subset[255]).toBe(1)
      // 关键：子集分布必须与全量分布不同，否则这条用例挡不住"漏了 index"的写法
      expect(Array.from(subset)).not.toEqual(Array.from(full))
    })

    it('轴外的点钳进端点箱（计数之和 = 可见点数 − NaN 数）', () => {
      const axis = { min: 0, max: 100 }
      const bins = new Uint32Array(ELEVATION_BINS)
      const counted = histogramOfZ(positionsOf([-5, 300, 50]), null, axis, bins)
      expect(counted).toBe(3)
      expect(bins[0]).toBe(1)
      expect(bins[255]).toBe(1)
      expect(bins[128]).toBe(1)
    })

    it('NaN 点跳过（不虚增端点箱）', () => {
      const axis = { min: 0, max: 100 }
      const bins = new Uint32Array(ELEVATION_BINS)
      const counted = histogramOfZ(positionsOf([NaN, 50, NaN]), null, axis, bins)
      expect(counted).toBe(1)
      expect(bins[0]).toBe(0)
      expect(Array.from(bins).reduce((a, b) => a + b, 0)).toBe(1)
    })

    it('退化轴：全部计进首箱', () => {
      const bins = new Uint32Array(ELEVATION_BINS)
      const counted = histogramOfZ(positionsOf([5, 5, 5]), null, { min: 5, max: 5 }, bins)
      expect(counted).toBe(3)
      expect(bins[0]).toBe(3)
    })

    it('空输入安全', () => {
      const bins = new Uint32Array(ELEVATION_BINS)
      expect(histogramOfZ(new Float32Array(0), null, { min: 0, max: 1 }, bins)).toBe(0)
      expect(Array.from(bins).reduce((a, b) => a + b, 0)).toBe(0)
    })
  })

  describe('fillElevationColors', () => {
    const lut = buildElevationLut()
    function positionsOf(zs: number[]): Float32Array {
      const out = new Float32Array(zs.length * 3)
      zs.forEach((z, i) => {
        out[i * 3 + 2] = z
      })
      return out
    }
    const colorsAt = (out: Uint8Array, i: number) => Array.from(out.slice(i * 3, i * 3 + 3))

    it('范围外压成端点色（clamp，不隐藏不变灰）', () => {
      const positions = positionsOf([-10, 50, 110])
      const out = new Uint8Array(9)
      fillElevationColors(positions, 0, 100, lut, out)
      expect(colorsAt(out, 0)).toEqual(Array.from(lut.slice(0, 3))) // 低于范围 → 最低色
      expect(colorsAt(out, 2)).toEqual(Array.from(lut.slice(-3))) // 高于范围 → 最高色
    })

    it('两端点恰好取端点色，中值取中间档', () => {
      const positions = positionsOf([0, 50, 100])
      const out = new Uint8Array(9)
      fillElevationColors(positions, 0, 100, lut, out)
      expect(colorsAt(out, 0)).toEqual(Array.from(lut.slice(0, 3)))
      expect(colorsAt(out, 2)).toEqual(Array.from(lut.slice(-3)))
      // 中值落第 128 箱（0.5 × 256 取整）
      expect(colorsAt(out, 1)).toEqual(Array.from(lut.slice(128 * 3, 128 * 3 + 3)))
    })

    it('**偏移不变性**：z 与 lo/hi 同加常数 → 字节逐位相同（显示坐标 vs 绝对高程的钉子）', () => {
      // 偏移取 2 的幂：float32 存储与 double 减法在这些量级上是精确的，
      // 「字节逐位相同」才是对实现的检验，而不是在考浮点存储的舍入
      const shift = 1024
      const zs = [-3, 0, 12.5, 99.75, 100, 140]
      const a = positionsOf(zs)
      const b = positionsOf(zs.map((z) => z + shift))
      const outA = new Uint8Array(zs.length * 3)
      const outB = new Uint8Array(zs.length * 3)
      fillElevationColors(a, 0, 100, lut, outA)
      fillElevationColors(b, shift, shift + 100, lut, outB)
      expect(Array.from(outB)).toEqual(Array.from(outA))
    })

    it('NaN 的 z 落到最低色（不写坏缓冲）', () => {
      const positions = positionsOf([NaN, 50])
      const out = new Uint8Array(6)
      fillElevationColors(positions, 0, 100, lut, out)
      expect(colorsAt(out, 0)).toEqual(Array.from(lut.slice(0, 3)))
      expect(colorsAt(out, 1)).not.toEqual(Array.from(lut.slice(0, 3)))
    })

    it('颜色索引随 z 单调不减（色带方向没接反）', () => {
      const zs = Array.from({ length: 40 }, (_, i) => i * 2.5)
      const positions = positionsOf(zs)
      const out = new Uint8Array(zs.length * 3)
      fillElevationColors(positions, 0, 100, lut, out)
      const idx = (i: number) => lut.indexOf(out[i * 3])
      for (let i = 1; i < zs.length; i++) {
        // 线性 LUT 里同一颜色可能对应多档，用"红分量不降"这个单调量做判据
        expect(out[i * 3]).toBeGreaterThanOrEqual(out[(i - 1) * 3])
      }
      expect(idx(zs.length - 1)).toBeGreaterThan(idx(0))
    })

    it('只写前 n×3 字节（尾部缓冲区不被越界污染）', () => {
      const out = new Uint8Array(3 * 2 + 6).fill(7)
      fillElevationColors(positionsOf([0, 100]), 0, 100, lut, out)
      expect(Array.from(out.slice(6))).toEqual([7, 7, 7, 7, 7, 7])
    })
  })

  describe('countInRange / binIndexOf（手柄读数）', () => {
    const axis = { min: 0, max: 256 }

    it('箱级计数 = 落在 [lo, hi] 内的点数（手柄吸附箱边界时严格相等）', () => {
      const zs = [0, 10, 50, 50.5, 128, 200, 255.9, 256]
      const positions = new Float32Array(zs.length * 3)
      zs.forEach((z, i) => {
        positions[i * 3 + 2] = z
      })
      const bins = new Uint32Array(ELEVATION_BINS)
      histogramOfZ(positions, null, axis, bins)

      const lo = binEdge(axis, 32)
      const hi = binEdge(axis, 200)
      const expected = zs.filter((z) => z >= lo && z <= hi).length
      expect(countInRange(bins, axis, lo, hi)).toBe(expected)
    })

    it('满量程 = 全量点数', () => {
      const bins = new Uint32Array(ELEVATION_BINS)
      const zs = [0, 1, 2, 3, 4]
      const positions = new Float32Array(zs.length * 3)
      zs.forEach((z, i) => {
        positions[i * 3 + 2] = z
      })
      histogramOfZ(positions, null, axis, bins)
      expect(countInRange(bins, axis, axis.min, axis.max)).toBe(zs.length)
    })

    it('binIndexOf 与箱边界自洽（边界值属于该箱，不越到下一箱）', () => {
      expect(binIndexOf(binEdge(axis, 10), axis)).toBe(10)
      expect(binIndexOf(binEdge(axis, 255), axis)).toBe(255)
      expect(binIndexOf(axis.max, axis)).toBe(ELEVATION_BINS - 1)
      expect(binIndexOf(axis.min, axis)).toBe(0)
      expect(binIndexOf(-100, axis)).toBe(0)
      expect(binIndexOf(1e9, axis)).toBe(ELEVATION_BINS - 1)
    })

    it('退化轴上 countInRange 退回首箱计数', () => {
      const bins = new Uint32Array(ELEVATION_BINS)
      bins[0] = 7
      expect(countInRange(bins, { min: 3, max: 3 }, 3, 3)).toBe(7)
    })
  })
})
