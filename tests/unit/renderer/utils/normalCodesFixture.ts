import { NORMAL_QUANTIZE_LEVEL, NULL_NORM_CODE } from '../../../../src/renderer/utils/normalEstimate'

/**
 * 测试专用：把法向量编成 `normalCode` 量化码的小工具（**非 spec 文件，禁止 import 进生产代码**）。
 *
 * 为什么需要它：`ransac-cylinder` 自 2026-09 起要求入参带法线（`normals: Uint16Array`，
 * **顶点缓冲空间**），而合成场景的法线是**解析已知**的——直接编成码喂进去，轴断言就与
 * 「法线估计误差」无关，只含量化误差（≈ 0.3~0.5°），这是最干净的断言形式。
 *
 * `compressNormalMirror` 是 `native/normal-estimate/src/normal_compressor.cc` 的 `compressNormal`
 * 的**逐行镜像**（原先内联在 `normalEstimate.spec.ts` 里，2026-09 提到这里做成单一来源）。
 * 生产代码里没有压缩器：C++ 只写码不读码、渲染侧只需要解码，它存在的唯一理由是让
 * 「往返误差」「Compress(−n) === Compress(n) ^ INVERT_XOR」这类性质能在纯 JS 下断言。
 *
 * 抄错任何一处（尤其 `flip` 的翻转记账与 `sector !== 3` 的分支）都会在往返误差上现形。
 */
export function compressNormalMirror(n: readonly number[]): number {
  let res = 0
  let x: number
  let y: number
  let z: number
  if (n[0] >= 0) {
    x = n[0]
  } else {
    res |= 4
    x = -n[0]
  }
  if (n[1] >= 0) {
    y = n[1]
  } else {
    res |= 2
    y = -n[1]
  }
  if (n[2] >= 0) {
    z = n[2]
  } else {
    res |= 1
    z = -n[2]
  }

  // C++ 里 psnorm 被复用成两个含义：先是 L1 和，后是箱端点交换的暂存
  let psnorm = x + y + z
  if (psnorm === 0) return NULL_NORM_CODE
  x /= psnorm
  y /= psnorm
  z /= psnorm

  const box = [0, 0, 0, 1, 1, 1]
  let flip = false
  for (let level = NORMAL_QUANTIZE_LEVEL; level !== 0; ) {
    res <<= 2
    --level
    const h = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2]
    let sector = 3
    if (flip) {
      if (z < h[2]) sector = 2
      else if (y < h[1]) sector = 1
      else if (x < h[0]) sector = 0
    } else {
      if (z > h[2]) sector = 2
      else if (y > h[1]) sector = 1
      else if (x > h[0]) sector = 0
    }
    res |= sector
    if (level !== 0) {
      if (flip) {
        if (sector !== 3) psnorm = box[sector]
        box[0] = h[0]
        box[1] = h[1]
        box[2] = h[2]
        if (sector !== 3) {
          box[3 + sector] = box[sector]
          box[sector] = psnorm
        } else {
          flip = false
        }
      } else {
        if (sector !== 3) psnorm = box[3 + sector]
        box[3] = h[0]
        box[4] = h[1]
        box[5] = h[2]
        if (sector !== 3) {
          box[sector] = box[3 + sector]
          box[3 + sector] = psnorm
        } else {
          flip = true
        }
      }
    }
  }
  return res
}

/**
 * 逐点把法向量编成量化码：`normals` 是扁平 xyz（长度 = 3 × 点数），返回长度 = 点数的码表。
 *
 * 零向量 / 非有限值 → `NULL_NORM_CODE`（与 native 侧「零向量 = 非法线、不参与投票」的约定一致），
 * 其余先归一化再交给压缩镜像（C++ 的 compress 内部也做 L1 归一化，这里显式归一只是让测试意图清晰）。
 */
export function encodeNormalCodes(normals: ArrayLike<number>): Uint16Array {
  const count = Math.floor(normals.length / 3)
  const out = new Uint16Array(count)
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3]
    const y = normals[i * 3 + 1]
    const z = normals[i * 3 + 2]
    const len = Math.sqrt(x * x + y * y + z * z)
    out[i] = Number.isFinite(len) && len > 0 ? compressNormalMirror([x / len, y / len, z / len]) : NULL_NORM_CODE
  }
  return out
}
