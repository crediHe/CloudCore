/**
 * 树木 3D 标记的**纯函数层**（数据 → 可断言的几何数值）：不碰 three / DOM，node 环境可测。
 *
 * 一棵算过树木信息的树要画三样东西：
 *   1. **树心点**（= 代表点 / 胸径切片圆心）：找得到、能核对；
 *   2. **冠层圈**（XY 平面上的椭圆，画在冠层底）：看树冠形状；
 *   3. **胸径圈**（半径 = 胸径/2，画在切片高度）：看切片是否规则——这正是"这个胸径能不能信"的目视判据。
 *
 * 为什么全部走**一个** `LineSegments` + **一个** `Points` 装配（见 `three/treeInfoOverlay.ts`）：
 * 一次算几百上千棵是常态，每棵 3 个 three 对象就是 3000 个 draw call（刚做完的 LOD 就是为了消灭这个量级），
 * 且挂在实体 Group 下就得在 5 条销毁路径上分别收尾、漏一条泄漏几何。于是筛选与几何生成都做成纯数据，
 * 装配层只负责拷字节 + 复用缓冲。
 *
 * ⚠ 这里的坐标一律是**显示坐标**（文件原始坐标 − 该实体的 `globalShift`）：标记与点云必须在同一套坐标里。
 * `TreeObject` 存的是文件原始坐标（`utils/treeMetrics.ts` 的产出，面板上显示的也是它），减法只在这一层做一次。
 */

import type { TreeObject } from '../stores/sceneStore'
import { srgbU8ToLinear } from './srgb'

/** 显示档位：只画选中的 / 画全部有树木信息的 / 关闭。默认只画选中的（上千棵树全画会糊成一片）。 */
export type TreeMarkerMode = 'selected' | 'all' | 'off'

export const DEFAULT_TREE_MARKER_MODE: TreeMarkerMode = 'selected'

/** 菜单渲染顺序（形状照 `utils/pivotVisibility.ts#PIVOT_VISIBILITY_CYCLE`，写法与策略一致）。 */
export const TREE_MARKER_MODES: readonly TreeMarkerMode[] = ['selected', 'all', 'off']

export const TREE_MARKER_LABELS: Record<TreeMarkerMode, string> = {
  selected: '仅选中的树',
  all: '全部有树木信息的树',
  off: '关闭',
}

/**
 * 配色。避让既有占用：黄 = 旋转中心 / 测量、紫 = 框选、青 = 平面片、橙 = 圆柱。
 * 三个都是 sRGB 字节（写进顶点色前经 `srgbU8ToLinear` 转线性，同点云颜色的处理）。
 */
export const TREE_CENTER_COLOR = 0xff00ff // 树心点：品红
export const TREE_CROWN_COLOR = 0x00e676 // 冠层圈：绿
export const TREE_DBH_COLOR = 0xff1744 // 胸径圈：红

/** 冠层椭圆段数 / 胸径圆段数（越高越圆；一棵树最多 2×64 + 2×48 = 224 个线段顶点）。 */
export const CROWN_RING_SEGMENTS = 64
export const DBH_RING_SEGMENTS = 48

/** 显示坐标下的一个点。 */
export interface DisplayPoint {
  x: number
  y: number
  z: number
}

/**
 * 一棵树的**标记输入**：`collectTreeMarkers` 只读这几格，由驱动层从 sceneStore / pointcloudStore 摊出来。
 */
export interface TreeMarkerSource {
  id: number
  /** 实体自身显隐（`sceneStore` 的 visible）：隐藏的实体不画标记——所见即所画。 */
  visible: boolean
  /** 显示坐标 ↔ 文件原始坐标的平移量；拿不到就不画（不知道往哪挪）。 */
  globalShift: DisplayPoint | null
  treeObject: TreeObject | null
}

/** 一棵树要画的三样东西（均已换算成**显示坐标**；没有的项为 null）。 */
export interface TreeMarkerItem {
  id: number
  /** 树心点。`representative` 为空（切片点为空 ⇒ 质心兜底也算、见 treeMetrics）时 null。 */
  center: DisplayPoint | null
  /** 冠层椭圆：中心 + 两个半轴 [m]。中心无冠层落点时为 null。 */
  crown: (DisplayPoint & { halfX: number; halfY: number }) | null
  /** 胸径圆：圆心（= 树心点）+ 半径 [m]。 */
  dbh: (DisplayPoint & { radius: number }) | null
}

/** 文件原始坐标 → 显示坐标。 */
function toDisplay(p: { x: number; y: number; z: number }, shift: DisplayPoint): DisplayPoint {
  return { x: p.x - shift.x, y: p.y - shift.y, z: p.z - shift.z }
}

/**
 * 筛选的**唯一实现**（三档 × 三种跳过条件）。规则：
 * `off` ⇒ 空；`selected` ⇒ 只取选中集里的；`all` ⇒ 全部；
 * 一律跳过 `visible === false`、`treeObject === null`、无 `globalShift` 的。
 *
 * 胸径圈只在**真量出数**（`dbh > 0`）时画：拟合被拒时 dbh 恒为 0（`utils/treeMetrics.ts` 刻意不编造数字），
 * 半径 0 的圈没有意义——而"没有圈"本身就是"这棵树的胸径不可信"的图形化（面板 Fit 行会写明是质心兜底）。
 */
export function collectTreeMarkers(
  sources: readonly TreeMarkerSource[],
  selectedIds: ReadonlySet<number>,
  mode: TreeMarkerMode
): TreeMarkerItem[] {
  if (mode === 'off') return []
  const out: TreeMarkerItem[] = []
  for (const src of sources) {
    if (!src.visible) continue
    if (mode === 'selected' && !selectedIds.has(src.id)) continue
    const t = src.treeObject
    const shift = src.globalShift
    if (!t || !shift) continue
    const center = t.representative ? toDisplay(t.representative, shift) : null
    const crown = t.crownCenter
      ? { ...toDisplay(t.crownCenter, shift), halfX: t.crownWidthX / 2, halfY: t.crownWidthY / 2 }
      : null
    const dbh = center && t.dbh > 0 ? { ...center, radius: t.dbh / 200 } : null
    if (!center && !crown && !dbh) continue
    out.push({ id: src.id, center, crown, dbh })
  }
  return out
}

/** 逐顶点几何数据（缓冲长度 = 有效顶点数，装配层按容量拷进自己的复用缓冲）。 */
export interface TreeMarkerGeometryData {
  /** 所有圈的线段顶点（每 2 个顶点一段）。 */
  ringPositions: Float32Array
  /** 与 `ringPositions` 一一对应的线性 RGB（0-1）。 */
  ringColors: Float32Array
  /** 树心点（每棵树一个顶点）。 */
  centerPositions: Float32Array
  centerColors: Float32Array
  ringVertexCount: number
  centerVertexCount: number
}

/** 0xRRGGBB（sRGB 字节）→ 线性 RGB（顶点色要线性，同点云）。 */
function linearRgb(hex: number): [number, number, number] {
  return [srgbU8ToLinear((hex >> 16) & 0xff), srgbU8ToLinear((hex >> 8) & 0xff), srgbU8ToLinear(hex & 0xff)]
}

/**
 * 画一个 XY 平面上的圆 / 椭圆（每段 2 个顶点 = 一条线段），返回写完后的**浮点偏移**。
 * 段数固定 ⇒ 顶点数可预测，装配层的容量与 drawRange 直接由它推。
 */
function writeRing(
  positions: Float32Array,
  colors: Float32Array,
  floatOffset: number,
  ring: DisplayPoint & { halfX: number; halfY: number },
  segments: number,
  color: readonly [number, number, number]
): number {
  let o = floatOffset
  for (let i = 0; i < segments; i++) {
    const a0 = (2 * Math.PI * i) / segments
    const a1 = (2 * Math.PI * (i + 1)) / segments
    positions[o] = ring.x + ring.halfX * Math.cos(a0)
    positions[o + 1] = ring.y + ring.halfY * Math.sin(a0)
    positions[o + 2] = ring.z
    positions[o + 3] = ring.x + ring.halfX * Math.cos(a1)
    positions[o + 4] = ring.y + ring.halfY * Math.sin(a1)
    positions[o + 5] = ring.z
    for (let k = 0; k < 2; k++) {
      colors[o + k * 3] = color[0]
      colors[o + k * 3 + 1] = color[1]
      colors[o + k * 3 + 2] = color[2]
    }
    o += 6
  }
  return o
}

/**
 * items → 逐顶点几何数据。**"每个圈用什么半径、什么颜色"这类可断言逻辑都在这里**，
 * THREE 装配层只负责拷进复用缓冲（于是单测断半径 / 顶点数 / 颜色即可，不需要 WebGL 上下文）。
 */
export function buildMarkerGeometryData(items: readonly TreeMarkerItem[]): TreeMarkerGeometryData {
  let crownCount = 0
  let dbhCount = 0
  let centerCount = 0
  for (const it of items) {
    if (it.crown) crownCount++
    if (it.dbh) dbhCount++
    if (it.center) centerCount++
  }
  const ringVertexCount = crownCount * CROWN_RING_SEGMENTS * 2 + dbhCount * DBH_RING_SEGMENTS * 2
  const ringPositions = new Float32Array(ringVertexCount * 3)
  const ringColors = new Float32Array(ringVertexCount * 3)
  const centerPositions = new Float32Array(centerCount * 3)
  const centerColors = new Float32Array(centerCount * 3)

  const crownColor = linearRgb(TREE_CROWN_COLOR)
  const dbhColor = linearRgb(TREE_DBH_COLOR)
  const centerColor = linearRgb(TREE_CENTER_COLOR)

  let ringOffset = 0
  let centerVertex = 0
  for (const it of items) {
    if (it.crown) {
      ringOffset = writeRing(ringPositions, ringColors, ringOffset, it.crown, CROWN_RING_SEGMENTS, crownColor)
    }
    if (it.dbh) {
      // 圆 = 两半轴相等的椭圆（同一段生成代码，不给圆单开一条路径）
      ringOffset = writeRing(
        ringPositions,
        ringColors,
        ringOffset,
        { ...it.dbh, halfX: it.dbh.radius, halfY: it.dbh.radius },
        DBH_RING_SEGMENTS,
        dbhColor
      )
    }
    if (it.center) {
      const k = centerVertex * 3
      centerPositions[k] = it.center.x
      centerPositions[k + 1] = it.center.y
      centerPositions[k + 2] = it.center.z
      centerColors[k] = centerColor[0]
      centerColors[k + 1] = centerColor[1]
      centerColors[k + 2] = centerColor[2]
      centerVertex++
    }
  }

  return { ringPositions, ringColors, centerPositions, centerColors, ringVertexCount, centerVertexCount: centerCount }
}
