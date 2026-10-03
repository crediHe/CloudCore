/**
 * LAS RGB 颜色还原（兼容不同写入软件的存储单位）。
 * 纯函数，便于单元测试。
 */

/**
 * 把 LAS 原始 uint16 颜色值还原为 0-1 归一化值。
 *
 * 不同软件写入 LAS 的 RGB 单位不一致：
 * - 多数软件按规范存"8 位值左移 8 位"（原始值 = c×256，如 255 → 65280）；
 * - 部分软件直接把 8 位值塞进 uint16（原始值 = c，如 255 → 255）；
 * - 个别软件存真正的 16 位颜色（0-65535）。
 *
 * 主进程 getFileInfo 已采样文件判定存储单位（rgbMax >= 256 表示移位存储，
 * 此时取高 8 位还原；真 16 位颜色同样取高 8 位，标准的有损换算）。
 * 若采样窗口恰为纯黑（rgbMax = 0），按未移位处理，结果同样是黑，无副作用。
 *
 * @param raw 文件中的 uint16 原始值
 * @param rgbMax 主进程采样算出的 RGB 最大值（LasFileInfo.rgbMax）
 * @returns 归一化 sRGB 颜色分量（0-1，与文件字节同色域）。
 *  本函数只做"存储单位还原"；写入 three 顶点色前还需经 srgbToLinear
 *  解码为线性值（three r185 默认色彩管理，见 utils/srgb.ts）。
 */
export function decodeLasRgb(raw: number, rgbMax: number): number {
  const value = rgbMax >= 256 ? raw >> 8 : raw
  return value / 255.0
}
