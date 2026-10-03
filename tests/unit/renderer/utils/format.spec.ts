import { describe, it, expect } from 'vitest'
import {
  fmtAxisCenter,
  fmtAxisDimensionLine,
  fmtFixed,
  fmtGlobalCenter,
  fmtGlobalShift,
  fmtNum,
  fmtShiftedCenter,
  fmtThousands,
} from '../../../../src/renderer/utils/format'

describe('format（属性面板数值格式化）', () => {
  it('fmtThousands 千分位格式化', () => {
    expect(fmtThousands(38620446)).toBe('38,620,446')
    expect(fmtThousands(0)).toBe('0')
  })

  it('fmtFixed 固定小数位并防御 NaN/Infinity', () => {
    expect(fmtFixed(140.023, 3)).toBe('140.023')
    expect(fmtFixed(NaN, 3)).toBe('—')
    expect(fmtFixed(Infinity, 3)).toBe('—')
  })

  it('fmtAxisDimensionLine 包围盒尺寸行（3 位小数 + 范围）', () => {
    expect(fmtAxisDimensionLine('X', 140.023, -56.54, 83.483)).toBe('X: 140.023 (-56.540 : 83.483)')
  })

  it('fmtShiftedCenter 显示坐标中心 4 位小数', () => {
    expect(fmtShiftedCenter({ x: 13.4715, y: 10.4695, z: 41.3885 })).toBe('X: 13.4715  Y: 10.4695  Z: 41.3885')
  })

  it('fmtGlobalCenter 全局中心 6 位小数', () => {
    expect(fmtGlobalCenter({ x: 490495.4715, y: 3385758.469498, z: 41.3885 })).toBe(
      'X: 490495.471500  Y: 3385758.469498  Z: 41.388500'
    )
  })

  it('fmtGlobalShift 取负、分号分隔、2 位小数、外层括号', () => {
    expect(fmtGlobalShift({ x: 490482, y: 3385748, z: 0 })).toBe('(-490482.00;-3385748.00;0.00)')
  })

  it('fmtNum 可空值：null/undefined/NaN ⇒ 空串（不是 0.00），默认 2 位小数', () => {
    expect(fmtNum(null)).toBe('')
    expect(fmtNum(undefined)).toBe('')
    expect(fmtNum(NaN)).toBe('')
    expect(fmtNum(Infinity)).toBe('')
    // 0 是**算出来的 0**，必须显示出来（与 null 的"没这个数"区分开）
    expect(fmtNum(0)).toBe('0.00')
    expect(fmtNum(12.3456)).toBe('12.35')
    expect(fmtNum(12.3456, 3)).toBe('12.346')
  })

  it('fmtAxisCenter 面板点坐标行取 2 位小数', () => {
    expect(fmtAxisCenter({ x: 490495.4715, y: 3385758.469498, z: 41.3885 }, 2)).toBe(
      'X: 490495.47  Y: 3385758.47  Z: 41.39'
    )
  })
})
