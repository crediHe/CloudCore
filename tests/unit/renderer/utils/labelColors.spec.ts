import { describe, it, expect } from 'vitest'
import {
  buildLabelColorTable,
  buildLabelColors,
  derivedLabelColors,
  hslToRgbBytes,
  LABEL_NOISE_SRGB,
  labelColor,
  rgbBytesToHsl,
  srgbByteToLinearByte,
} from '../../../../src/renderer/utils/labelColors'
import { clusterColor } from '../../../../src/renderer/utils/euclideanCluster'
import { linearToSrgbU8, linearU8ToSrgbU8, srgbToLinear, srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'

// 「标签色」共享色核是纯函数（node 环境即可，无需 jsdom）。
// 它由 utils/euclideanCluster.ts 抽取而来：下面第一组用 euclideanCluster 的公开 API
// （clusterColor / CLUSTER_NOISE_SRGB 的字节值）**逐字节对照** —— 抽取 = 等价的前提是
// "两边给出的颜色一模一样"。⚠ 抽取之后 clusterColor 只是转调 labelColor，这条对照严格
// 说是**同义反复**了；真正钉住色板的是它下面的"黄金角规格"用例（那条与实现无关地
// 重述了色板应有的值），改色核时它必须跟着改 = 承认画面配色变了。

/** 线性字节（预览色装进顶点缓冲前的最终形态；与 setEntityLabelColor 同换算，见文件末的等价用例）。 */
const lin = (v: number) => Math.round(srgbU8ToLinear(v) * 255)

describe('labelColor（标签 → sRGB 字节；与欧式聚类逐字节一致）', () => {
  it('抽取等价：labelColor(i) == clusterColor(i)（1..64 全扫）', () => {
    for (let label = 1; label <= 64; label++) {
      expect(labelColor(label)).toEqual(clusterColor(label))
    }
  })

  // 色板是**对用户可见的契约**（"3 号是那个颜色"）：黄金角相位 137.508°、固定饱和度 0.75、
  // 明度 0.55。下面按规格独立重述（不调 labelColor），几个代表值**写死字节**——改色核时
  // 这些数会变，那就是"全库配色都变了"，必须显式改这里而不是顺手调公式。
  it('黄金角规格：h = (编号−1)×137.508°、s = 0.75、l = 0.55（含冻结字节）', () => {
    expect(labelColor(1)).toEqual({ r: 226, g: 54, b: 54 }) // 相位 0°：红
    expect(labelColor(2)).toEqual({ r: 54, g: 226, b: 104 })
    expect(labelColor(3)).toEqual({ r: 155, g: 54, b: 226 })
    expect(labelColor(10)).toEqual({ r: 54, g: 226, b: 162 })
    expect(labelColor(64)).toEqual({ r: 226, g: 120, b: 54 })
    // 规格重述：与上面的冻结值同一份判据（相位/饱和/明度就写在这里）
    for (let label = 1; label <= 200; label++) {
      expect(labelColor(label)).toEqual(hslToRgbBytes((label - 1) * 137.508, 0.75, 0.55))
    }
  })

  it('确定性 + 相邻标签不同色 + 分量都是合法字节', () => {
    expect(labelColor(3)).toEqual(labelColor(3))
    expect(labelColor(1)).not.toEqual(labelColor(2))
    for (let label = 1; label <= 200; label++) {
      const c = labelColor(label)
      for (const v of [c.r, c.g, c.b]) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe('hslToRgbBytes（色核里唯一的 HSL→RGB 实现）', () => {
  it('纯色与灰阶端点（s = 1 的六个 60° 扇区）', () => {
    expect(hslToRgbBytes(0, 1, 0.5)).toEqual({ r: 255, g: 0, b: 0 })
    expect(hslToRgbBytes(60, 1, 0.5)).toEqual({ r: 255, g: 255, b: 0 })
    expect(hslToRgbBytes(120, 1, 0.5)).toEqual({ r: 0, g: 255, b: 0 })
    expect(hslToRgbBytes(180, 1, 0.5)).toEqual({ r: 0, g: 255, b: 255 })
    expect(hslToRgbBytes(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255 })
    expect(hslToRgbBytes(300, 1, 0.5)).toEqual({ r: 255, g: 0, b: 255 })
    // s = 0 ⇒ 灰（三个分量相等）；明度 0 / 1 是黑与白
    expect(hslToRgbBytes(210, 0, 0.5)).toEqual({ r: 128, g: 128, b: 128 })
    expect(hslToRgbBytes(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 })
    expect(hslToRgbBytes(0, 0, 1)).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('色相归一：负数与超 360 收敛到同一色（派生色喂进来的 hue 可能越界）', () => {
    expect(hslToRgbBytes(-120, 1, 0.5)).toEqual(hslToRgbBytes(240, 1, 0.5))
    expect(hslToRgbBytes(480, 1, 0.5)).toEqual(hslToRgbBytes(120, 1, 0.5))
    expect(hslToRgbBytes(360, 1, 0.5)).toEqual(hslToRgbBytes(0, 1, 0.5))
  })
})

describe('rgbBytesToHsl（派生色从父色反推色相/饱和度）', () => {
  it('灰：无色调（h = 0、s = 0），l 就是字节值', () => {
    expect(rgbBytesToHsl(110, 110, 110)).toEqual({ h: 0, s: 0, l: 110 / 255 })
    expect(rgbBytesToHsl(0, 0, 0)).toEqual({ h: 0, s: 0, l: 0 })
    expect(rgbBytesToHsl(255, 255, 255)).toEqual({ h: 0, s: 0, l: 1 })
  })

  it('三原色与 HSL 定义一致', () => {
    expect(rgbBytesToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 })
    expect(rgbBytesToHsl(0, 255, 0).h).toBeCloseTo(120, 10)
    expect(rgbBytesToHsl(0, 0, 255).h).toBeCloseTo(240, 10)
  })

  it('往返 hslToRgbBytes → rgbBytesToHsl：误差只来自 8 位量化（h ≤ 0.5°、s / l ≤ 0.005）', () => {
    // 容差按实测上界给（全整数色相扫描：h 0.26°、s 0.0022、l 0.001），留 ~2 倍余量——
    // 给到 3° / 0.01 这类比量级还松的值就形同没判（扇区判错、相位差一位都会轻松过关）。
    for (let hue = 0; hue < 360; hue += 13) {
      const bytes = hslToRgbBytes(hue, 0.75, 0.55)
      const back = rgbBytesToHsl(bytes.r, bytes.g, bytes.b)
      const dh = Math.min(Math.abs(back.h - hue), 360 - Math.abs(back.h - hue))
      expect(dh).toBeLessThanOrEqual(0.5)
      expect(Math.abs(back.s - 0.75)).toBeLessThanOrEqual(0.005)
      expect(Math.abs(back.l - 0.55)).toBeLessThanOrEqual(0.005)
    }
  })
})

// **同族派生色**：把一棵树切开时给各片分色（框选分割 / 按分类拆分）。判据是"一眼看出
// 这几片来自同一棵，同时各片又能分辨"—— 故色相必须保住、明度必须分开。
describe('derivedLabelColors（同族派生色）', () => {
  const parent = labelColor(7) // 典型父色（黄金角色板上的一个）
  /** 档位按 HSL 明度排序（sRGB 字节比大小不可靠：同明度不一定同感知，但同色相下 l 可比）。 */
  const lightness = (c: { r: number; g: number; b: number }) => rgbBytesToHsl(c.r, c.g, c.b).l

  it('两档：首档亮、末档暗（框选分割的 .segmented 取首档、.remaining 取次档）', () => {
    const [bright, dark] = derivedLabelColors(parent, 2)
    expect(lightness(bright)).toBeGreaterThan(lightness(dark))
    expect(bright).not.toEqual(dark)
  })

  it('色相与饱和度保持父色（不许变成另一个颜色；容差按实测上界留 2 倍余量）', () => {
    // 4 档 = 明度 ±0.3（0.55 → 0.25 / 0.85，都被夹进 [0.28, 0.82]）。实测上界
    // （父色 1..40 × 4 档全扫）：h 0.53°、s 0.0087 —— 饱和度漂移比色相大一个量级，
    // 因为 s = d / (1 − |2l − 1|)，明度离中点越远同一个 d 的字节误差被放得越大。
    const ph = rgbBytesToHsl(parent.r, parent.g, parent.b)
    for (const c of derivedLabelColors(parent, 4)) {
      const ch = rgbBytesToHsl(c.r, c.g, c.b)
      const dh = Math.min(Math.abs(ch.h - ph.h), 360 - Math.abs(ch.h - ph.h))
      expect(dh).toBeLessThanOrEqual(1)
      expect(Math.abs(ch.s - ph.s)).toBeLessThanOrEqual(0.02)
    }
  })

  it('单档 = 父色本身（偏移 0；只差一次 HSL 往返的量化误差 ≤ 1 字节）', () => {
    const [only] = derivedLabelColors(parent, 1)
    expect(Math.abs(only.r - parent.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(only.g - parent.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(only.b - parent.b)).toBeLessThanOrEqual(1)
  })

  it('确定性：两次调用逐字节相等（同一父色 + 同一档数 ⇒ 同一组色）', () => {
    expect(derivedLabelColors(parent, 3)).toEqual(derivedLabelColors(parent, 3))
  })

  it('层数越多档位依次外推；档距由"以父色明度为中心对称铺开"定（3 档中间那档 ≈ 父色）', () => {
    const three = derivedLabelColors(parent, 3)
    expect(lightness(three[0])).toBeGreaterThan(lightness(three[1]))
    expect(lightness(three[1])).toBeGreaterThan(lightness(three[2]))
    const [only] = derivedLabelColors(parent, 1)
    expect(Math.abs(lightness(three[1]) - lightness(only))).toBeLessThanOrEqual(0.01)
  })

  it('灰父色 ⇒ 灰阶（s = 0 无中生不出色相），但两档仍可分辨', () => {
    const greyParent = { r: LABEL_NOISE_SRGB, g: LABEL_NOISE_SRGB, b: LABEL_NOISE_SRGB }
    const [bright, dark] = derivedLabelColors(greyParent, 2)
    for (const c of [bright, dark]) {
      expect(c.r).toBe(c.g)
      expect(c.g).toBe(c.b)
    }
    expect(bright.r).toBeGreaterThan(dark.r)
  })

  it('明度夹取：极端父色（纯黑 / 纯白）不产生越界字节，且档位被夹到同一档', () => {
    // 已知行为（不是缺陷）：父色已经在 [0.28, 0.82] 之外时，两档都被夹到边界 ⇒ 退化成同色。
    // 记下来是因为"退化成同色"是安静发生的，将来若改成别的铺开策略，这里会红。
    for (const extreme of [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ]) {
      const shades = derivedLabelColors(extreme, 2)
      for (const c of shades) {
        for (const v of [c.r, c.g, c.b]) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(255)
        }
      }
      expect(shades[0]).toEqual(shades[1])
    }
    // 正常父色（色板明度 0.55）不触发夹取：两档确实不同
    expect(derivedLabelColors(parent, 2)[0]).not.toEqual(derivedLabelColors(parent, 2)[1])
  })

  it('count ≤ 0：空数组（不返回 null，调用方按长度判断）', () => {
    expect(derivedLabelColors(parent, 0)).toEqual([])
    expect(derivedLabelColors(parent, -3)).toEqual([])
  })

  it('切了再切不漂：写进材质的线性色读回来仍是原字节（派生链可以无限接下去）', () => {
    // setEntityLabelColor 存的是 srgbToLinear(c/255) 浮点，再切开时由 linearToSrgbU8 读回
    // 成 sRGB 字节。这条往返恒等 = 派生色永远还在原色相族里（每切一刀色相不漂）。
    for (let v = 0; v <= 255; v++) {
      expect(linearToSrgbU8(srgbToLinear(v / 255))).toBe(v)
    }
  })
})

describe('srgbByteToLinearByte（预览色 → 线性字节）', () => {
  it('与 setEntityLabelColor 的浮点版同式（差一步 8 位量化）：Math.round(srgbToLinear(c/255)*255)', () => {
    for (const v of [0, 1, 13, 110, 127, 200, 254, 255]) {
      expect(srgbByteToLinearByte(v)).toBe(Math.round(srgbToLinear(v / 255) * 255))
    }
  })

  it('⚠ 线性字节空间 ≠ sRGB 字节空间（别把 v 直接当结果）', () => {
    expect(srgbByteToLinearByte(0)).toBe(0)
    expect(srgbByteToLinearByte(255)).toBe(255)
    // 两个空间不是同一个刻度：sRGB 13 ⇄ 线性 1（反向的 linearU8ToSrgbU8(1) === 13
    // ——同一条约定的两个方向）
    expect(srgbByteToLinearByte(13)).toBe(1)
    expect(linearU8ToSrgbU8(1)).toBe(13)
    // 单调不减（色彩空间换算在 [0,255] 上单调）
    let prev = -1
    for (let v = 0; v <= 255; v++) {
      const cur = srgbByteToLinearByte(v)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })
})

// 分割色有**两条落地路径**，本文件是它们相遇的地方，必须钉住"颜色看起来一样"：
//  - 预览（欧式聚类 / 单木分割的染色预览）：颜色写进 Uint8 顶点色 ⇒ 走 `srgbByteToLinearByte`，
//    归一化后分量 = 线性字节 / 255（量化到 8 位）；
//  - 产物实体（setEntityLabelColor）：颜色写在**材质**上 ⇒ 走 `srgbToLinear(byte/255)` 浮点，不量化。
describe('预览字节路径 ↔ 实体浮点路径（同一换算，差 ≤ 半字节）', () => {
  it('逐通道差 = 四舍五入误差，≤ 0.5/255（256 项全扫）', () => {
    for (let v = 0; v <= 255; v++) {
      const preview = srgbByteToLinearByte(v) / 255 // Uint8 顶点色的实际取值
      const entity = srgbToLinear(v / 255) // 材质色的实际取值
      // 上界就是量化半径：round(x·255)/255 与 x 的差
      expect(Math.abs(preview - entity)).toBeLessThanOrEqual(0.5 / 255)
    }
  })

  it('端点逐位相等（黑与白没有量化余地，故纯色不会漂）', () => {
    expect(srgbByteToLinearByte(0) / 255).toBe(srgbToLinear(0))
    expect(srgbByteToLinearByte(255) / 255).toBe(srgbToLinear(1))
  })
})

describe('buildLabelColorTable（逐标签线性色表）', () => {
  it('长度 = maxLabel × 3；标签 label 的色在 (label-1)×3，等于 labelColor 的线性换算', () => {
    const table = buildLabelColorTable(3)
    expect(table.length).toBe(9)
    for (let label = 1; label <= 3; label++) {
      const c = labelColor(label)
      expect(Array.from(table.subarray((label - 1) * 3, label * 3))).toEqual([lin(c.r), lin(c.g), lin(c.b)])
    }
  })

  it('maxLabel = 0（无入选标签）：空表，不越界', () => {
    expect(buildLabelColorTable(0).length).toBe(0)
  })

  // base = **编号基准**（树项容器原地重建时新树的编号从旧手工项之后续）：表项 label 取
  // labelColor(base + label − 1)。预览按它有位移，产物按 pointcloudStore.setEntityLabelColor
  // 同一编号取色 ⇒ 两边的色才对得上（base 算错的症状是"预览一套色、拆完另一套"）。
  it('base 位移：表项 label 取 labelColor(base + label − 1)；缺省 base = 1（与旧行为逐字节一致）', () => {
    expect(Array.from(buildLabelColorTable(2, 1))).toEqual(Array.from(buildLabelColorTable(2)))
    const shifted = buildLabelColorTable(2, 3)
    for (const [label, no] of [
      [1, 3],
      [2, 4],
    ]) {
      const c = labelColor(no)
      expect(Array.from(shifted.subarray((label - 1) * 3, label * 3))).toEqual([lin(c.r), lin(c.g), lin(c.b)])
    }
    // 同一份色板被两个 base 取到不同的号 ⇒ 表内容必然不同（否则 base 没生效）
    expect(Array.from(shifted)).not.toEqual(Array.from(buildLabelColorTable(2, 1)))
  })
})

describe('buildLabelColors（逐块逐顶点线性色；两处分割预览共用）', () => {
  const chunk = (vertexCount: number, index: number[] | null) => ({
    positions: new Float32Array(vertexCount * 3),
    index: index ? new Uint32Array(index) : null,
  })

  it('长度 = 顶点数 × 3（不是候选数）；带 index 块的非候选顶点保持灰', () => {
    const chunks = [chunk(5, [1, 3])]
    const labels = new Int32Array([1, 1])
    const [bytes] = buildLabelColors(chunks, labels, buildLabelColorTable(1), () => true)
    expect(bytes).not.toBeNull()
    expect(bytes!.length).toBe(5 * 3)
    const c = labelColor(1)
    expect(Array.from(bytes!.subarray(3, 6))).toEqual([lin(c.r), lin(c.g), lin(c.b)])
    expect(Array.from(bytes!.subarray(9, 12))).toEqual([lin(c.r), lin(c.g), lin(c.b)])
    const g = lin(LABEL_NOISE_SRGB)
    for (const v of [0, 2, 4]) {
      expect(Array.from(bytes!.subarray(v * 3, v * 3 + 3))).toEqual([g, g, g])
    }
  })

  it('无 index 块：候选序即顶点序（v = k）', () => {
    const [bytes] = buildLabelColors(
      [chunk(3, null)],
      new Int32Array([2, 2, 0]),
      buildLabelColorTable(2),
      (l) => l === 2
    )
    const c2 = labelColor(2)
    const g = lin(LABEL_NOISE_SRGB)
    expect(Array.from(bytes!.subarray(0, 3))).toEqual([lin(c2.r), lin(c2.g), lin(c2.b)])
    expect(Array.from(bytes!.subarray(3, 6))).toEqual([lin(c2.r), lin(c2.g), lin(c2.b)])
    expect(Array.from(bytes!.subarray(6, 9))).toEqual([g, g, g]) // label 0 ⇒ 不上色
  })

  it('零顶点块给 null 占位；块序与输入逐块对齐', () => {
    const chunks = [chunk(0, null), chunk(2, [1]), chunk(10, [])]
    const labels = new Int32Array([1]) // 候选总数 = 0 + 1 + 0
    const out = buildLabelColors(chunks, labels, buildLabelColorTable(1), () => true)
    expect(out[0]).toBeNull() // 空块
    expect(out[1]!.length).toBe(6)
    // index 为空数组 ⇒ 该块候选 0 ⇒ 全灰（不是"无 index 即全量"）
    expect(Array.from(out[2]!)).toEqual(new Array(30).fill(lin(LABEL_NOISE_SRGB)))
  })

  it('越界标签与 isColored=false 一律按灰（不读坏色表）', () => {
    const g = lin(LABEL_NOISE_SRGB)
    // 色表只到 label 1，但 labels 里出现 5（契约破损）⇒ 灰而非越界读
    const [bytes] = buildLabelColors([chunk(2, null)], new Int32Array([5, 5]), buildLabelColorTable(1), () => true)
    expect(Array.from(bytes!)).toEqual([g, g, g, g, g, g])
    // 色表足够但 isColored 拒绝（未入选）⇒ 也灰
    const [bytes2] = buildLabelColors([chunk(2, null)], new Int32Array([1, 1]), buildLabelColorTable(1), () => false)
    expect(Array.from(bytes2!)).toEqual([g, g, g, g, g, g])
  })

  it('标签数与候选数不符（契约异常）抛错', () => {
    expect(() => buildLabelColors([chunk(5, null)], new Int32Array(3), buildLabelColorTable(1), () => true)).toThrow(
      /契约异常/
    )
  })
})
