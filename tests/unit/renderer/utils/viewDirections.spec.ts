import { describe, it, expect } from 'vitest'
import { VIEW_DIRECTIONS, type ViewName } from '../../../../src/renderer/utils/viewDirections'

// 纯数据，node 环境即可（不依赖 DOM），无需 jsdom 注释。

const VIEW_NAMES: ViewName[] = ['front', 'back', 'left', 'right', 'top', 'bottom']

/** 向量长度。 */
function length(v: { x: number; y: number; z: number }) {
  return Math.hypot(v.x, v.y, v.z)
}

describe('VIEW_DIRECTIONS（六向视角方位表）', () => {
  it('六个视角齐全且均指向单位长度（轴向量）', () => {
    for (const name of VIEW_NAMES) {
      expect(VIEW_DIRECTIONS[name]).toBeDefined()
      expect(length(VIEW_DIRECTIONS[name])).toBeCloseTo(1, 10)
    }
  })

  it('上下沿 ±Y，其余四向在 XZ 平面内', () => {
    expect(VIEW_DIRECTIONS.top).toEqual({ x: 0, y: 1, z: 0 })
    expect(VIEW_DIRECTIONS.bottom).toEqual({ x: 0, y: -1, z: 0 })
    for (const name of ['front', 'back', 'left', 'right'] as const) {
      expect(VIEW_DIRECTIONS[name].y).toBe(0)
    }
  })

  it('前后沿 ±Z、左右沿 ±X（相机所处方位，见文件头注释约定）', () => {
    expect(VIEW_DIRECTIONS.front).toEqual({ x: 0, y: 0, z: 1 })
    expect(VIEW_DIRECTIONS.back).toEqual({ x: 0, y: 0, z: -1 })
    expect(VIEW_DIRECTIONS.left).toEqual({ x: -1, y: 0, z: 0 })
    expect(VIEW_DIRECTIONS.right).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('六个方向两两互异（保证每个按钮有独立机位）', () => {
    const keys = VIEW_NAMES.map((name) => Object.values(VIEW_DIRECTIONS[name]).join(','))
    expect(new Set(keys).size).toBe(VIEW_NAMES.length)
  })
})
