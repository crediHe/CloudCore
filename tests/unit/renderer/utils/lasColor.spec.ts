// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { decodeLasRgb } from '../../../../src/renderer/utils/lasColor'

describe('decodeLasRgb', () => {
  it('移位 8 位存储（rgbMax >= 256）：取高 8 位还原', () => {
    // 34304 = 134 << 8，高 8 位即颜色值
    expect(decodeLasRgb(34304, 59392)).toBeCloseTo(134 / 255)
    expect(decodeLasRgb(65280, 59392)).toBeCloseTo(1)
    expect(decodeLasRgb(0, 59392)).toBe(0)
  })

  it('未移位 8 位存储（rgbMax < 256）：直接取低 8 位', () => {
    expect(decodeLasRgb(128, 252)).toBeCloseTo(128 / 255)
    expect(decodeLasRgb(252, 252)).toBeCloseTo(252 / 255)
    expect(decodeLasRgb(0, 252)).toBe(0)
  })

  it('真 16 位颜色（rgbMax >= 256）：取高 8 位做标准有损换算', () => {
    expect(decodeLasRgb(65535, 65535)).toBeCloseTo(1)
    expect(decodeLasRgb(32768, 65535)).toBeCloseTo(128 / 255)
  })

  it('采样窗口纯黑（rgbMax = 0）：按未移位处理，结果仍为黑', () => {
    expect(decodeLasRgb(0, 0)).toBe(0)
  })
})
