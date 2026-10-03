import { describe, it, expect } from 'vitest'
import {
  buildScalarColors,
  userClassColor,
  className,
  CLASS_COLORS,
  CLASS_NAMES,
} from '../../../../src/renderer/utils/classColors'
import { srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'

describe('classColors（项目分类色表）', () => {
  it('色表长度为 22（覆盖项目分类 0-21）', () => {
    expect(CLASS_COLORS).toHaveLength(22)
    expect(CLASS_NAMES).toHaveLength(22)
  })

  it('色表保持 sRGB 显示码（图例/统计色块直接显示用，不被线性化）', () => {
    // 抽样：0 未定义点白 / 2 地面点纯绿 / 21 堆方体点橙
    expect(CLASS_COLORS[0]).toEqual([255, 255, 255])
    expect(CLASS_COLORS[2]).toEqual([0, 255, 0])
    expect(CLASS_COLORS[21]).toEqual([255, 102, 0])
  })

  it('className：0-21 查标准中文名，22-63 保留、64-255 自定义（带编号兜底）', () => {
    expect(className(0)).toBe('未定义点')
    expect(className(2)).toBe('地面点')
    expect(className(15)).toBe('导线')
    expect(className(21)).toBe('堆方体点')
    expect(className(22)).toBe('保留 22')
    expect(className(63)).toBe('保留 63')
    expect(className(64)).toBe('自定义 64')
    expect(className(255)).toBe('自定义 255')
  })

  it('buildScalarColors 输出 n*3 线性字节：按分类查表并 sRGB→线性量化', () => {
    const cls = new Uint8Array([0, 2, 6, 33])
    const colors = buildScalarColors(cls)
    expect(colors).toHaveLength(12)
    // 输出 = Math.round(srgbU8ToLinear(色表分量) × 255)——three 顶点色要求线性值
    const lin = (v: number) => Math.round(srgbU8ToLinear(v) * 255)
    // 点 1 分类 0（白 255）→ 线性化后仍为 255
    expect(colors[0]).toBe(255)
    expect(colors[1]).toBe(255)
    expect(colors[2]).toBe(255)
    // 点 2 分类 2（地面点纯绿）→ 0,255,0
    expect(colors[3]).toBe(0)
    expect(colors[4]).toBe(255)
    expect(colors[5]).toBe(0)
    // 点 3 分类 6（建筑物青）→ 0,255,255
    expect(colors[6]).toBe(0)
    expect(colors[7]).toBe(255)
    expect(colors[8]).toBe(255)
    // 点 4 分类 33 超出色表范围 → 生成色（不再查旧 0-31 表）
    expect(colors[9]).toBe(lin(userClassColor(33)[0]))
    expect(colors[10]).toBe(lin(userClassColor(33)[1]))
    expect(colors[11]).toBe(lin(userClassColor(33)[2]))
  })

  it('分类 ≥22 不再掩码/串色（LAS 1.4 格式 6-10 全字节保真）', () => {
    const lin = (v: number) => Math.round(srgbU8ToLinear(v) * 255)
    // 33 与 22、以及会串到的 0/1（白/红）均不同色，且与生成色公式一致
    const c33 = buildScalarColors(new Uint8Array([33]))
    expect(c33).not.toEqual(buildScalarColors(new Uint8Array([0])))
    expect(c33).not.toEqual(buildScalarColors(new Uint8Array([1])))
    expect(c33).not.toEqual(buildScalarColors(new Uint8Array([22])))
    expect(c33[0]).toBe(lin(userClassColor(33)[0]))
    expect(c33[1]).toBe(lin(userClassColor(33)[1]))
    expect(c33[2]).toBe(lin(userClassColor(33)[2]))
  })

  it('生成色确定且相邻类可区分（黄金角旋转拉开色相）', () => {
    // 同值重复构建结果一致（图例/重着色可复现）
    expect(buildScalarColors(new Uint8Array([64, 65, 66]))).toEqual(buildScalarColors(new Uint8Array([64, 65, 66])))
    // 用户自定义类 64/65/66 两两不同色
    const c = buildScalarColors(new Uint8Array([64, 65, 66]))
    expect(c.subarray(0, 3)).not.toEqual(c.subarray(3, 6))
    expect(c.subarray(3, 6)).not.toEqual(c.subarray(6, 9))
    expect(c.subarray(0, 3)).not.toEqual(c.subarray(6, 9))
    // 生成色落在合法字节范围
    for (const byte of c) {
      expect(byte).toBeGreaterThanOrEqual(0)
      expect(byte).toBeLessThanOrEqual(255)
    }
  })

  it('线性化方向正确：128 红变暗（128→55，而非原样）', () => {
    const colors = buildScalarColors(new Uint8Array([7])) // 7 低点 #800000
    // sRGB 128 ≈ 0.502 → 线性 ≈ 0.216 × 255 ≈ 55
    expect(colors[0]).toBe(55)
    expect(colors[1]).toBe(0)
    expect(colors[2]).toBe(0)
  })

  it('空输入返回空数组', () => {
    expect(buildScalarColors(new Uint8Array(0))).toHaveLength(0)
  })
})
