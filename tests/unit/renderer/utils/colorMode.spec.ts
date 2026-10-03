import { describe, it, expect } from 'vitest'
import { resolveColorMode, type ColorCapabilities } from '../../../../src/renderer/utils/colorMode'
import type { ColorMode } from '../../../../src/renderer/stores/sceneStore'

// 纯函数（不碰 three / DOM / store），node 环境即可，无需 jsdom 注释。
// 这是全仓库**唯一**一份着色降级规则，两个消费方都靠它：sceneStore.updateEntityMeta
// 在元数据变化时把"意图"压回可用值，pointcloudStore.applyColorMode 在渲染前兜底。
// 故这里按两层钉：具体的降级链用例 + 全域性质（任何意图 × 任何数据能力都不出错值）。

const FULL: ColorCapabilities = { hasColor: true, hasNormals: true, hasLabelColor: true }
const EMPTY: ColorCapabilities = { hasColor: false, hasNormals: false, hasLabelColor: false }
const ALL_MODES: ColorMode[] = ['none', 'rgb', 'scalar', 'normal', 'elevation', 'label']

/** 该数据能力下**能真显示**的着色方式（scalar 靠分类字段、elevation 靠 z，不依赖这三项）。 */
function displayable(caps: ColorCapabilities): ColorMode[] {
  const out: ColorMode[] = ['none', 'scalar', 'elevation']
  if (caps.hasColor) out.push('rgb')
  if (caps.hasNormals) out.push('normal')
  if (caps.hasLabelColor) out.push('label')
  return out
}

/** 8 种能力组合（2³）。 */
function capCombos(): ColorCapabilities[] {
  const out: ColorCapabilities[] = []
  for (const hasColor of [false, true]) {
    for (const hasNormals of [false, true]) {
      for (const hasLabelColor of [false, true]) out.push({ hasColor, hasNormals, hasLabelColor })
    }
  }
  return out
}

describe('resolveColorMode（着色降级链 label → rgb → none）', () => {
  it('数据齐备时任何意图都原样通过（不做无谓降级）', () => {
    for (const mode of ALL_MODES) {
      expect(resolveColorMode(mode, FULL)).toBe(mode)
    }
  })

  it('⚠ label 的退路是 rgb 而不是 none（.noise / 合并产物仍要看真彩色）', () => {
    expect(resolveColorMode('label', { hasColor: true, hasNormals: true, hasLabelColor: false })).toBe('rgb')
    // 法向量与它无关：没有法向量也照样退到 rgb
    expect(resolveColorMode('label', { hasColor: true, hasNormals: false, hasLabelColor: false })).toBe('rgb')
  })

  it('rgb 再往下才是 none（真的没有颜色数据，如 LAS 点格式 0）', () => {
    expect(resolveColorMode('rgb', EMPTY)).toBe('none')
    expect(resolveColorMode('rgb', { hasColor: false, hasNormals: true, hasLabelColor: true })).toBe('none')
  })

  it('降级链走满两跳：label + 无分割色 + 无颜色 → none（不停在坏值 rgb 上）', () => {
    expect(resolveColorMode('label', EMPTY)).toBe('none')
  })

  it('normal 无法向量 → none（没有"退到 rgb"的中间档，与 label 不同）', () => {
    expect(resolveColorMode('normal', { ...FULL, hasNormals: false })).toBe('none')
  })

  it('none / scalar / elevation 不依赖这三项能力，恒原样通过', () => {
    for (const mode of ['none', 'scalar', 'elevation'] as ColorMode[]) {
      expect(resolveColorMode(mode, EMPTY)).toBe(mode)
    }
  })

  it('全域性质：6 意图 × 8 能力组合，结果必在该能力下可显示', () => {
    for (const caps of capCombos()) {
      const ok = displayable(caps)
      for (const mode of ALL_MODES) {
        expect(ok).toContain(resolveColorMode(mode, caps))
      }
    }
  })

  it('幂等：降级结果再判一次不变（updateEntityMeta 与 applyColorMode 会先后各判一次）', () => {
    for (const caps of capCombos()) {
      for (const mode of ALL_MODES) {
        const once = resolveColorMode(mode, caps)
        expect(resolveColorMode(once, caps)).toBe(once)
      }
    }
  })
})
