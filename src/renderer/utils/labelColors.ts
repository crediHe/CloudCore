import { srgbU8ToLinear } from './srgb'
import { candidateCountOfChunk } from './radiusFilter'

/**
 * 「标签色」共享色核（纯函数、零副作用，同 utils/srgb.ts 的定位）。
 *
 * 分割类的预览与产物着色**必须共用同一套实现**，否则"预览看到的颜色"与
 * "拆出来的实体颜色"会悄悄漂移（两边各写一份 = 迟早对不上）。当前消费方：
 * - `utils/euclideanCluster.ts#buildClusterColors`（欧式聚类预览）
 * - `utils/treeIso.ts#buildTreeColors`（单木分割预览）
 * - 两者的拆片着色（`pointcloudStore.setEntityLabelColor`）——它们直接调
 *   `labelColor` 拿 sRGB 字节，由 setEntityLabelColor 内部做同一套线性换算。
 *
 * 色彩空间约定：色值一律以 **sRGB 字节**（0-255，与人眼/取色器一致）表述，
 * 装进 GPU 前必须换算成**线性**（three r152+ 色彩管理要求，见 utils/srgb.ts）。
 * 两条消费路径的换算等价，这是"预览色 == 实体色"的依据：
 * - 预览色（顶点缓冲字节）：`srgbByteToLinearByte`（`Math.round(srgbToLinear(c/255)*255)`）；
 * - 产物分割色（材质 `material.color`，**浮点**）：`srgbToLinear(c/255)`。
 * 两者只差一次 8 位取整（字节路径的固有量化，≤ 半字节），色值本身同一个数——
 * `labelColors.spec.ts` 末组用"逐通道差 ≤ 0.5/255"钉住这条（**不是**逐位相等：
 * 量化那一步长在字节路径里，去不掉）。
 */

/** 色相黄金角（相邻标签的色相间隔最大，避免邻近标签同色）。 */
const GOLDEN_ANGLE_DEG = 137.508

/** 标签色的固定饱和度 / 明度（HSL：`labelColor` 用它们定色，同族派生色以父色为准）。 */
const LABEL_SAT = 0.75
const LABEL_LIGHT = 0.55

/** 未入选 / 非候选点的预览灰（sRGB 字节；入选项才上色，其余一律这个灰）。 */
export const LABEL_NOISE_SRGB = 110

/**
 * HSL → sRGB 字节（h 度数，s / l ∈ [0,1]）。**色核里唯一的 HSL→RGB 实现**：
 * `labelColor` 与 `derivedLabelColors` 都走它，两者才可能逐字节相容。
 */
export function hslToRgbBytes(hue: number, sat: number, light: number): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const m = light - c / 2
  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
  }
}

/** sRGB 字节 → HSL（h ∈ [0,360)，s / l ∈ [0,1]）。派生色靠它从**父色**反推色相与饱和度。 */
export function rgbBytesToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l } // 灰：无色调（派生色只能是灰阶，见 derivedLabelColors）
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = 60 * (((gn - bn) / d) % 6)
  else if (max === gn) h = 60 * ((bn - rn) / d + 2)
  else h = 60 * ((rn - gn) / d + 4)
  return { h: (h + 360) % 360, s, l }
}

/**
 * 标签 → sRGB 字节色（黄金角相位 + 固定饱和/亮度 HSL→RGB）。
 *
 * 为什么按**标签**定色而不是按"入选顺序"：参数只改渲染侧过滤阈值时标签不变，
 * 于是颜色不跳、肉眼能对着画面调参数（入选与否只影响是否上色，不影响已上色的值）。
 *
 * @param label native 的组件号（1..K）
 */
export function labelColor(label: number): { r: number; g: number; b: number } {
  return hslToRgbBytes((label - 1) * GOLDEN_ANGLE_DEG, LABEL_SAT, LABEL_LIGHT)
}

/** 同族派生色的明度档距与夹取区间（见 derivedLabelColors）。 */
const DERIVED_LIGHTNESS_STEP = 0.2
const DERIVED_LIGHTNESS_MIN = 0.28
const DERIVED_LIGHTNESS_MAX = 0.82

/**
 * **同族派生色**：把一个物体切开时给各片分色（框选分割 / 按分类拆分的产物）。
 *
 * 语义：**色相与饱和度保持父色不变**，只把明度按档铺开 —— 于是画面上一眼看出
 * "这几片来自同一棵"，同时各片之间又能分辨（`labelColor` 体系里同色相只属于这一个
 * 父物体：切开后父物体已从场景移除，母号不会被复用，故同族色不会与别的物体撞）。
 *
 * 档位按 `DERIVED_LIGHTNESS_STEP` 以父色明度为中心对称铺开：索引 0 最亮、末位最暗
 * （框选分割的 `.segmented` 取首档、`.remaining` 取次档；层数再多就依次外推）。
 * 明度夹在 [DERIVED_LIGHTNESS_MIN, DERIVED_LIGHTNESS_MAX]：越界会掉到黑/白，
 * 那时色相就看不出来了（"同源可见"这条正是本函数存在的理由）。
 *
 * 父色是**灰**（s = 0，如无色占位灰）时派生出的是同档灰阶——无中生不出色相，
 * 与"父色即灰"的事实一致。
 *
 * ⚠ 与 `labelColor` 的关系：那条是 `f(编号)`（同一编号恒同色、跨容器也一致），
 * 本条是 `f(父色, 档位)`（不依赖编号）—— 两条共同保证"颜色要么由编号定、要么由
 * 父色定"，绝无第三种来源（见 pointcloudStore.setEntityLabelColor 的调用点）。
 *
 * @param parent 父物体的 sRGB 字节色（父材质的 `labelColor`；灰色则派生灰阶）
 * @param count  要派生几档（≥ 1；1 档即父色本身，因为偏移量为 0）
 */
export function derivedLabelColors(
  parent: { r: number; g: number; b: number },
  count: number
): { r: number; g: number; b: number }[] {
  const out: { r: number; g: number; b: number }[] = []
  if (count <= 0) return out
  const { h, s, l } = rgbBytesToHsl(parent.r, parent.g, parent.b)
  for (let i = 0; i < count; i++) {
    const offset = ((count - 1) / 2 - i) * DERIVED_LIGHTNESS_STEP
    const light = Math.min(DERIVED_LIGHTNESS_MAX, Math.max(DERIVED_LIGHTNESS_MIN, l + offset))
    out.push(hslToRgbBytes(h, s, light))
  }
  return out
}

/** sRGB 字节 → 线性字节（three 顶点色要求线性；预览色通道用，与分割色的浮点路径同式）。 */
export function srgbByteToLinearByte(v: number): number {
  return Math.round(srgbU8ToLinear(v) * 255)
}

/**
 * 逐标签预计算线性色表（长度 = maxLabel × 3；标签 label 的色在 (label-1)×3 起）。
 *
 * `base` 是**编号基准**：表项 label 取 `labelColor(base + label - 1)`。默认 1（= 编号
 * 与 native 标签一一对应）。树项容器"原地重建"时容器里可能还留着带编号的手工项，
 * 新一批树的编号要从它们之后续（见 sceneStore.nextLabelNo），于是预览色必须按同一个
 * base 位移——**否则预览是一套色、拆完是另一套色**（预览与产物必须同源，这是本参数的
 * 唯一理由；单测钉住 base=1 与 base>1 两种表与 `labelColor` 的对应关系）。
 */
export function buildLabelColorTable(maxLabel: number, base = 1): Uint8Array {
  const table = new Uint8Array(maxLabel * 3)
  for (let label = 1; label <= maxLabel; label++) {
    const c = labelColor(base + label - 1)
    table[(label - 1) * 3] = srgbByteToLinearByte(c.r)
    table[(label - 1) * 3 + 1] = srgbByteToLinearByte(c.g)
    table[(label - 1) * 3 + 2] = srgbByteToLinearByte(c.b)
  }
  return table
}

/**
 * 逐块生成预览色（长度 = 该块**顶点数** × 3，可直接装成 BufferAttribute('color')）。
 *
 * 两条语义（与 pointcloudStore.setEntityPreviewColors 的校验对齐）：
 * - 长度按**顶点数**而不是候选数：预览是"把整片点云染色"，几何体的 index 不参与
 *   （不像滤波预览那样按 index 隐藏点）——于是非候选顶点（带 index 的块里被其它
 *   工具剔除过的点）显示为灰。
 * - 顶点数为 0 的块给 `null`（该块无几何，装不上颜色）。
 *
 * @param chunks    与 native 请求一致的块源（只读 positions 长度与 index）
 * @param labels    逐候选标签（**块主序**，契约同 addon；长度 = 候选总数）
 * @param colorTable 逐标签线性色表（见 buildLabelColorTable）
 * @param isColored 该标签是否上色（false / 越界 / label ≤ 0 一律按灰）
 */
export function buildLabelColors(
  chunks: { positions: Float32Array; index: Uint32Array | null }[],
  labels: Int32Array,
  colorTable: Uint8Array,
  isColored: (label: number) => boolean
): (Uint8Array | null)[] {
  const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
  if (labels.length !== candidateTotal) {
    throw new Error(`标签数与候选数不一致（labels ${labels.length} / 候选 ${candidateTotal}），契约异常`)
  }
  const grey = srgbByteToLinearByte(LABEL_NOISE_SRGB)
  const maxLabel = (colorTable.length / 3) | 0
  const out: (Uint8Array | null)[] = []
  let offset = 0
  for (const chunk of chunks) {
    const vertexCount = chunk.positions.length / 3
    if (vertexCount === 0) {
      out.push(null)
      offset += candidateCountOfChunk(chunk)
      continue
    }
    const bytes = new Uint8Array(vertexCount * 3)
    // 底色：全顶点先铺灰（非候选顶点与该块未入选的标签都保持灰）
    for (let v = 0; v < vertexCount; v++) {
      bytes[v * 3] = grey
      bytes[v * 3 + 1] = grey
      bytes[v * 3 + 2] = grey
    }
    const n = candidateCountOfChunk(chunk)
    const index = chunk.index
    for (let i = 0; i < n; i++) {
      const label = labels[offset + i]
      // label ≤ 0（未分类）与越界标签都不上色：越界属契约破损，按灰处理而非读坏色表
      if (label <= 0 || label > maxLabel || !isColored(label)) continue
      const v = (index ? index[i] : i) * 3
      const s = (label - 1) * 3
      bytes[v] = colorTable[s]
      bytes[v + 1] = colorTable[s + 1]
      bytes[v + 2] = colorTable[s + 2]
    }
    out.push(bytes)
    offset += n
  }
  return out
}
