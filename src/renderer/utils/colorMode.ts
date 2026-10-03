/**
 * 着色方式的**可用性降级**（纯函数，node 环境可测；不碰 three / DOM / store）。
 *
 * UI 上的 ColorMode 是用户的**意图**，能不能真显示还要看实体有没有那套数据：
 * 无色云（LAS 点格式 0）没有 RGB、没算过法向量就没有 Normal RGB、不是分割产物就
 * 没有分割色（`label`，见 pointcloudStore.setEntityLabelColor）。降级规则全仓库只有
 * 这一份，两个消费方必须同源：
 *  - `sceneStore.updateEntityMeta`——元数据变化时把意图压回可用值（清除法向量、合并产物
 *    没拿到编号等）；
 *  - `pointcloudStore.applyColorMode`——渲染前映射，兜住"数据能力"与"意图"的任何偏差。
 *
 * ⚠ `label` 的降级目标是 **rgb** 而不是 none：没有分割色的实体（`.noise` / `.remaining` /
 * 普通点云合并产物 / 用户手动改过 colorMode 的云）本来就该显示原始真彩色，压成 None 会把
 * 画面变成一片灰。rgb 再往下才是 none（那才是真的没有颜色数据）。
 */
import type { ColorMode } from '../stores/sceneStore'

/** 实体当前具备的着色数据能力（与 SceneEntity 的同名字段一一对应）。 */
export interface ColorCapabilities {
  hasColor: boolean
  hasNormals: boolean
  hasLabelColor: boolean
}

/**
 * 把"想要的着色方式"映射成"实际能显示的着色方式"。
 *
 * 降级链（`label → rgb → none`）是这个函数的全部要点：分割色依赖法向量/分类那种
 * "数据在不在"的标志，而它的退路是 RGB 而不是 None。
 */
export function resolveColorMode(mode: ColorMode, caps: ColorCapabilities): ColorMode {
  let out = mode
  // 无分割色 → 退回 RGB 语义（而不是 None）：.noise / 没拿到编号的合并产物仍要看真彩色
  if (out === 'label' && !caps.hasLabelColor) out = 'rgb'
  if (out === 'rgb' && !caps.hasColor) out = 'none'
  if (out === 'normal' && !caps.hasNormals) out = 'none'
  return out
}
