import { describe, it, expect } from 'vitest'
import {
  roundScale,
  formatScaleValue,
  worldPerPixelOrtho,
  computeOrthoScaleBar,
  pivotRingRadiusPx,
  PIVOT_RING_RADIUS_PERCENT,
  PIVOT_BALL_RADIUS_PX,
} from '../../../../src/renderer/utils/viewScale'

// 纯数学，node 环境即可（不依赖 DOM），无需 jsdom 注释。

// roundScale 的期望值用手工推导（granularity=10^k/2，向下取整），并抽了一条
// 数量级性质做泛化校验，防止用例只对表不透意。
function kOf(w: number): number {
  return Math.floor(Math.log(w) / Math.log(10))
}

describe('roundScale（CC RoundScale：0.5×10^k 步进向下取整）', () => {
  it('在 10^k 附近步进切换：99.9→95、100.1→100、149.9→100、150.1→150', () => {
    expect(roundScale(99.9)).toBeCloseTo(95, 6)
    expect(roundScale(100.1)).toBeCloseTo(100, 6)
    expect(roundScale(149.9)).toBeCloseTo(100, 6)
    expect(roundScale(150.1)).toBeCloseTo(150, 6)
  })

  it('跨数量级一致：24.9→20、25.1→25、1.499→1、1.5→1.5', () => {
    expect(roundScale(24.9)).toBeCloseTo(20, 6)
    expect(roundScale(25.1)).toBeCloseTo(25, 6)
    expect(roundScale(1.499)).toBeCloseTo(1, 6)
    expect(roundScale(1.5)).toBeCloseTo(1.5, 6)
  })

  it('小数数量级：0.4999→0.45、0.5001→0.5', () => {
    expect(roundScale(0.4999)).toBeCloseTo(0.45, 6)
    expect(roundScale(0.5001)).toBeCloseTo(0.5, 6)
  })

  it('性质：结果 ≤ 输入、且相差不超过一步 gran（对数量级 1e-3~1e6 抽样）', () => {
    for (let exp = -3; exp <= 6; exp++) {
      for (const mant of [0.6, 0.99, 1.01, 2.4, 4.9, 5.2, 9.5, 9.99]) {
        const w = mant * Math.pow(10, exp)
        const v = roundScale(w)
        const gran = Math.pow(10, kOf(w)) / 2
        expect(v).toBeGreaterThan(0)
        expect(v).toBeLessThanOrEqual(w + 1e-9)
        expect(w - v).toBeLessThan(gran + 1e-9)
        // 且 v 是 gran 的整数倍（取整后确实落在 0.5×10^k 网格上）
        expect(v / gran).toBeCloseTo(Math.round(v / gran), 9)
      }
    }
  })
})

describe('formatScaleValue（纯数字标签，仿 CC 不带单位）', () => {
  it('各数量级输出最短十进制（无浮点长尾）', () => {
    expect(formatScaleValue(6.5)).toBe('6.5')
    expect(formatScaleValue(150)).toBe('150')
    expect(formatScaleValue(5000000)).toBe('5000000')
    expect(formatScaleValue(0.5)).toBe('0.5')
    expect(formatScaleValue(0.05)).toBe('0.05')
    // 浮点乘积累积出的长尾（0.65 附近）应被裁掉
    expect(formatScaleValue(13 * 0.05)).toBe('0.65')
    expect(formatScaleValue(12 * 0.0005)).toBe('0.006')
  })

  it('非法输入返回空串（调用方据此隐藏标尺）', () => {
    expect(formatScaleValue(0)).toBe('')
    expect(formatScaleValue(-3)).toBe('')
    expect(formatScaleValue(Number.NaN)).toBe('')
    expect(formatScaleValue(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('worldPerPixelOrtho（正射世界单位/像素换算）', () => {
  it('top=10、zoom=1、高 600 → 1/30 单位每像素', () => {
    expect(worldPerPixelOrtho(10, 1, 600)).toBeCloseTo(1 / 30, 10)
  })

  it('zoom 放大 n 倍 ⇒ wpp 缩小 n 倍（滚轮放大后单位长度更小）', () => {
    expect(worldPerPixelOrtho(10, 2, 600)).toBeCloseTo((1 / 30) / 2, 10)
    expect(worldPerPixelOrtho(10, 4, 600)).toBeCloseTo((1 / 30) / 4, 10)
  })
})

describe('computeOrthoScaleBar（整体换算：视口宽 25% → 取整值 → 实际像素宽）', () => {
  it('宽 800 高 600、top=10、zoom=1：值 6.5、标签 "6.5"、宽 ~195px（200 以内）', () => {
    const bar = computeOrthoScaleBar(800, 600, 10, 1)
    expect(bar).not.toBeNull()
    expect(bar!.value).toBeCloseTo(6.5, 6)
    expect(bar!.label).toBe('6.5')
    expect(bar!.widthCssPx).toBeCloseTo(195, 6)
    // CC 约束：实际宽度 ≥ 目标宽度（200px）的一半
    expect(bar!.widthCssPx).toBeGreaterThanOrEqual(100)
    expect(bar!.widthCssPx).toBeLessThanOrEqual(200)
  })

  it('滚轮放大（zoom=4）后数值变小：1.5 / "1.5" / 180px', () => {
    const bar = computeOrthoScaleBar(800, 600, 10, 4)
    expect(bar!.label).toBe('1.5')
    expect(bar!.widthCssPx).toBeCloseTo(180, 6)
  })

  it('更大取景（top=100）：值 65、宽 ~195px', () => {
    const bar = computeOrthoScaleBar(800, 600, 100, 1)
    expect(bar!.label).toBe('65')
    expect(bar!.widthCssPx).toBeCloseTo(195, 6)
  })

  it('透视语义：数值随 zoom 连续缩小但步进离散（模拟 zoom 序列 1→2→4→2）', () => {
    const z = (zoom: number) => computeOrthoScaleBar(800, 600, 10, zoom)!.value
    expect(z(1)).toBeGreaterThan(z(2))
    expect(z(2)).toBeGreaterThan(z(4))
    expect(z(2)).toBeCloseTo(z(2), 10)
  })

  it('非法输入（zoom≤0 / 尺寸为 0）返回 null', () => {
    expect(computeOrthoScaleBar(800, 600, 10, 0)).toBeNull()
    expect(computeOrthoScaleBar(800, 600, 10, -1)).toBeNull()
    expect(computeOrthoScaleBar(800, 600, 0, 1)).toBeNull()
    expect(computeOrthoScaleBar(0, 600, 10, 1)).toBeNull()
  })
})

describe('pivotRingRadiusPx（旋转中心符号的屏幕恒定半径）', () => {
  it('取最短边：800×600 与 600×800 同为 0.8×600/2', () => {
    expect(pivotRingRadiusPx(800, 600)).toBeCloseTo(240, 10)
    expect(pivotRingRadiusPx(600, 800)).toBeCloseTo(240, 10)
  })

  it('正方形视口：1000×1000 → 400（= 0.8 × 1000 / 2）', () => {
    expect(pivotRingRadiusPx(1000, 1000)).toBeCloseTo(400, 10)
  })

  it('与视口尺寸成正比：边长减半则半径减半（屏幕恒定尺寸的前提）', () => {
    const r1 = pivotRingRadiusPx(1200, 900)
    const r2 = pivotRingRadiusPx(600, 450)
    expect(r1 / r2).toBeCloseTo(2, 10)
  })

  it('常量取自 CC 原值：环 0.8（最短边的百分比）、球 10px', () => {
    expect(PIVOT_RING_RADIUS_PERCENT).toBe(0.8)
    expect(PIVOT_BALL_RADIUS_PX).toBe(10)
  })
})
