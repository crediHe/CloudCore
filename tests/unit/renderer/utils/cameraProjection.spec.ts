import { describe, it, expect } from 'vitest'
import {
  tanHalfFov,
  orthoHalfHeight,
  computeOrthoBounds,
  perspectiveDistanceFromOrtho,
} from '../../../../src/renderer/utils/cameraProjection'

// 纯数学，node 环境即可（不依赖 DOM），无需 jsdom 注释。

const FOV = 50
const TAN_HALF = Math.tan((FOV * Math.PI) / 360)

describe('tanHalfFov / orthoHalfHeight（垂直 fov 半角）', () => {
  it('fov=50 的半角正切为常量 tan(25°)', () => {
    expect(tanHalfFov(FOV)).toBeCloseTo(0.466307658, 8)
  })

  it('目标平面可见半高 = 距离 × 半角正切', () => {
    expect(orthoHalfHeight(FOV, 10)).toBeCloseTo(10 * TAN_HALF, 10)
    expect(orthoHalfHeight(FOV, 3.7)).toBeCloseTo(3.7 * TAN_HALF, 10)
  })
})

describe('computeOrthoBounds（透视 → 正射 bounds 换算）', () => {
  it('垂直方向随 fov+距离，水平随 aspect（1:1 时正方形）', () => {
    const b = computeOrthoBounds(FOV, 10, 1)
    const half = 10 * TAN_HALF
    expect(b.top).toBeCloseTo(half, 10)
    expect(b.bottom).toBeCloseTo(-half, 10)
    expect(b.right).toBeCloseTo(half, 10)
    expect(b.left).toBeCloseTo(-half, 10)
  })

  it('aspect=16/9 只放大水平范围，垂直不变（正射 resize 语义）', () => {
    const b = computeOrthoBounds(FOV, 10, 16 / 9)
    const half = 10 * TAN_HALF
    expect(b.top).toBeCloseTo(half, 10)
    expect(b.bottom).toBeCloseTo(-half, 10)
    expect(b.right).toBeCloseTo(half * (16 / 9), 10)
    expect(b.left).toBeCloseTo(-half * (16 / 9), 10)
  })

  it('top 不随 aspect 变化：resize 只动 left/right，垂直范围保持', () => {
    const b1 = computeOrthoBounds(FOV, 10, 1)
    const b2 = computeOrthoBounds(FOV, 10, 2)
    expect(b2.top).toBeCloseTo(b1.top, 10)
    expect(b2.right).toBeCloseTo(b1.right * 2, 10)
  })
})

describe('perspectiveDistanceFromOrtho（正射 → 透视距离还原）', () => {
  it('zoom=1 往返一致：透视 d → bounds → 距离还原回 d', () => {
    for (const d of [1, 3.7, 10, 250]) {
      const bounds = computeOrthoBounds(FOV, d, 1.5)
      expect(perspectiveDistanceFromOrtho(bounds.top, FOV, 1)).toBeCloseTo(d, 10)
    }
  })

  it('zoom 放大 f 倍 ⇒ 等价距离缩小 f 倍（画面内容等价）', () => {
    const bounds = computeOrthoBounds(FOV, 10, 1)
    const d2 = perspectiveDistanceFromOrtho(bounds.top, FOV, 2)
    expect(d2).toBeCloseTo(5, 10)
    // 等价性：还原距离处的透视半高 = 正射有效半高 top/zoom
    expect(orthoHalfHeight(FOV, d2)).toBeCloseTo(bounds.top / 2, 10)
  })

  it('多次滚轮缩放往返无漂移（zoom 序列 1→2→4→2→1）', () => {
    const bounds = computeOrthoBounds(FOV, 10, 1)
    const d = (zoom: number) => perspectiveDistanceFromOrtho(bounds.top, FOV, zoom)
    expect(d(1)).toBeCloseTo(10, 8)
    expect(d(2)).toBeCloseTo(5, 8)
    expect(d(4)).toBeCloseTo(2.5, 8)
    expect(d(2)).toBeCloseTo(5, 8)
    expect(d(1)).toBeCloseTo(10, 8)
  })

  it('zoom<=0 为非法输入（0 → Infinity；负值 → 负距离），调用方须兜底', () => {
    expect(Number.isFinite(perspectiveDistanceFromOrtho(1, FOV, 0))).toBe(false)
    expect(perspectiveDistanceFromOrtho(1, FOV, -2)).toBeLessThan(0)
  })
})
