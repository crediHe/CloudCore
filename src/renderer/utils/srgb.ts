/**
 * sRGB → 线性 色彩空间换算（three r152+ 色彩管理的数据边界约定）。
 *
 * three 自 r152 起默认开启色彩管理：渲染器输出端做 sRGB 编码
 * （renderer.outputColorSpace = SRGBColorSpace），因此**喂给顶点色
 * （BufferAttribute 'color'）与材质的数值必须已是线性空间**；若把文件里
 * 的 sRGB 编码字节（LAS/PLY 的 RGB、8 位色表）原样写入，显示端会再次
 * 提亮（约 c → c^(1/2.4)），表现为颜色发白、偏淡。
 *
 * 纯函数、零依赖（不碰 three/DOM），公式与 three 内置 SRGBToLinear 一致
 * （IEC 61966-2-1 分段式：暗部线性段 c/12.92 + 亮部 (1.055c^…) 段）。
 */

/** sRGB 编码分量（0-1）→ 线性分量（0-1）。 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 文件/色表常见的 u8 字节（0-255，sRGB 编码）→ 线性分量（0-1）。 */
export function srgbU8ToLinear(v: number): number {
  return srgbToLinear(v / 255)
}

/**
 * 线性分量（0-1）→ sRGB 编码分量（0-1）。`srgbToLinear` 的逆（同一分段式）。
 *
 * 用于**导出**：内存里的顶点色是线性值，写进 PLY/LAS 前必须编回 sRGB，
 * 否则存出去的字节被别的软件按 sRGB 解读会整体偏暗（与加载时"直接写字节会发白"
 * 是同一个换算的两端）。
 *
 * 指数取 1/2.4（IEC 61966-2-1 精确值）；three 内置的 LinearToSRGB 用截断的 0.41666，
 * 两者在 8 位量化后没有任何可观测差异。
 */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/** 线性分量（0-1）→ **sRGB 编码的 u8 字节**（0-255，导出写文件用）。 */
export function linearToSrgbU8(c: number): number {
  const v = Math.round(linearToSrgb(c) * 255)
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * 线性空间字节（0-255）→ sRGB 字节（0-255）。
 *
 * 顶点缓冲里若有 Uint8 归一化的**线性**字节（如聚类/单木分割的预览色，其值来自
 * `srgbByteToLinearByte`），导出时同样要编回 sRGB。查 256 项表：值域只有 256 个，
 * 表与逐点算 `linearToSrgb`
 * 完全等价，但省掉每次 `Math.pow`（1 亿点 × 3 通道的差别是可感知的）。
 */
const LINEAR_U8_TO_SRGB_U8 = buildLinearU8ToSrgbU8Lut()

function buildLinearU8ToSrgbU8Lut(): Uint8Array {
  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    lut[v] = linearToSrgbU8(v / 255)
  }
  return lut
}

/** 线性字节 → sRGB 字节（查表，见上）。 */
export function linearU8ToSrgbU8(v: number): number {
  return LINEAR_U8_TO_SRGB_U8[v]
}
