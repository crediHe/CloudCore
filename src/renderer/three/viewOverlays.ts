import * as THREE from 'three'
import { computeOrthoScaleBar } from '../utils/viewScale'

/**
 * 3D 视图右下角浮层：动态 XYZ 轴向 + 缩放距离标尺（仿 CloudCompare）。
 *
 * 轴向（对应 CC ccGLWindowInterface::drawTrihedron，CloudCompare-master
 * libs/qCC_glWindow/src/ccGLWindowInterface.cpp 4226 行起）：
 *  - X 红 / Y 绿 / Z 蓝（ccColor::red/green/blueCC），每轴一段 25px 线段 +
 *    端点同色字母，锚在视口右下角（CC_DISPLAYED_TRIHEDRON_AXES_LENGTH）；
 *  - "动态"：把世界轴单位向量经相机 matrixWorldInverse 旋到相机系，
 *    取 (x, −y) 投影为屏幕方向并丢弃 z——背向/朝向相机的轴自然"缩短"，
 *    即 CC 用 viewMat 乘 25px 轴向量的投影观感；
 *  - 字母放在端点之外、沿屏幕方向再推约半字距+5px（CC 同款半径）。
 *    屏幕投影长度≈0（该轴正对相机）时回退到锚点左上斜向，避免叠在原点。
 *
 * 标尺（对应 CC drawScale，同上文件 4343 行起）：仅正射模式显示（CC 源码
 * 对透视直接 assert 不画——透视下像素↔世界换算随深度变化）；横线 + 两端竖
 * tick + 上方纯数字标签；取整与换算数学见 utils/viewScale.ts。
 *
 * 实现选 DOM/SVG 而非往渲染管线塞第二场景：CSS 像素天然适配高分屏、不抢
 * GPU、与现有 rAF 解耦；整层 pointer-events:none 不挡轨道/分割交互。
 * 坐标均为容器 CSS 像素（与渲染 canvas 的 CSS 尺寸同一套）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

// —— 轴向常量（CC ccGLWindowInterface.cpp 顶部同款）——
const AXIS_LABELS = ['X', 'Y', 'Z'] as const
// X/Y/Z 线色 = ccColor::red / green / blueCC（CC 三面轴原色）
const AXIS_COLORS = ['#ff0000', '#00ff00', '#0000ff'] as const
const AXIS_EDGE_LENGTH = 25 // CC_DISPLAYED_TRIHEDRON_AXES_LENGTH：轴线段像素长
const AXIS_TEXT_RADIUS = 10 // 字母中心到端点再推的距离 ≈ 半字宽 + 5px margin
const TRIAD_EDGE_INSET = 10 // 轴向锚点到视口右下角的边距
const TRIAD_SVG_SIZE = TRIAD_EDGE_INSET + AXIS_EDGE_LENGTH + AXIS_TEXT_RADIUS + 18 // SVG 边长

// —— 标尺常量 ——
const SCALE_BOTTOM = 6 + 50 // 标尺底线距视口底
const SCALE_RIGHT = TRIAD_SVG_SIZE + 8 + 50// 标尺右端：给右下角轴向让位
const SCALE_PAD = 10 // 标尺横线两端留白（数字可能比线宽）
const SCALE_SVG_HEIGHT = 28 // 含上方数字
const SCALE_LABEL_Y = 12 // 数字基线
const SCALE_BAR_Y = 21 // 横线 y
const SCALE_TICK = 3 // 两端竖 tick 半长

const WORLD_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]

/**
 * 每帧屏幕层回调：把世界坐标投到容器 CSS 像素上（测量标签、后续可能的其他标注）。
 * 由 engine 在 renderer.render **之后**调用——此刻 camera.matrixWorldInverse 才与
 * 当前姿态同步，否则投影会用上一帧的矩阵、标注抖一帧。
 */
export type ScreenLayerUpdate = (camera: THREE.Camera, cssWidthPx: number, cssHeightPx: number) => void

/** 右下角浮层实例：每帧 update，销毁时 dispose。 */
export interface ViewOverlays {
  /**
   * 每帧刷新（engine 在 renderer.render 之后调用，保证 matrixWorldInverse 已更新）。
   * @param cssWidthPx / cssHeightPx 容器 CSS 像素尺寸（= 渲染 canvas CSS 尺寸）
   */
  update(camera: THREE.Camera, cssWidthPx: number, cssHeightPx: number): void
  /**
   * 注册一个每帧屏幕层，返回退订函数（组件卸载/退出模态时调用）。
   *
   * 屏幕层自己建 DOM 根节点（见 measure 的组合式函数），本类只负责按帧驱动——
   * 这样各层的 z-index、生命周期与 DOM 结构互不牵连。用 Set 而非数组：
   * 退订 O(1) 且重复注册不会叠加。
   */
  addScreenLayer(update: ScreenLayerUpdate): () => void
  dispose(): void
}

export function createViewOverlays(container: HTMLElement): ViewOverlays {
  const root = document.createElement('div')
  // inset:0 全铺容器做层容器；pointer-events 置空防挡轨道/分割框选。
  // z-index 高于后续追加的兄弟浮层（如分割预览），轴向/标尺是常显"UI 镀铬"。
  root.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:10;overflow:hidden;'
  container.appendChild(root)

  // ---------- 右下角动态 XYZ 轴向 ----------
  const triadSvg = document.createElementNS(SVG_NS, 'svg')
  triadSvg.setAttribute('width', String(TRIAD_SVG_SIZE))
  triadSvg.setAttribute('height', String(TRIAD_SVG_SIZE))
  triadSvg.setAttribute('viewBox', `0 0 ${TRIAD_SVG_SIZE} ${TRIAD_SVG_SIZE}`)
  triadSvg.style.cssText = `position:absolute;right:50px;bottom:50px;overflow:visible;`
  root.appendChild(triadSvg)

  // 锚点（三段轴的共同起点）：距视口右下角 TRIAD_EDGE_INSET
  const anchorX = TRIAD_SVG_SIZE - TRIAD_EDGE_INSET
  const anchorY = anchorX

  const axisLines = AXIS_LABELS.map((label, i) => {
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('stroke', AXIS_COLORS[i])
    line.setAttribute('stroke-width', '2')
    triadSvg.appendChild(line)
    const text = document.createElementNS(SVG_NS, 'text')
    text.setAttribute('fill', AXIS_COLORS[i])
    text.textContent = label
    text.setAttribute('font-size', '12')
    // 字号虽小仍走 CSS 像素（SVG 与 DOM 同缩放，无需乘 devicePixelRatio）
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'central')
    triadSvg.appendChild(text)
    return { line, text }
  })

  const camAxis = new THREE.Vector3() // 临时量：世界轴 → 相机系（每帧循环复用，免 GC）
  const updateTriad = (camera: THREE.Camera) => {
    for (let i = 0; i < 3; i++) {
      camAxis.copy(WORLD_AXES[i]).transformDirection(camera.matrixWorldInverse)
      // 相机系 y 向上、CSS/SVG y 向下：屏幕方向取 (x, −y)，z 丢弃 → 朝向/背向
      // 相机的轴投影长度趋近 0（CC 观感），而不是在角上恒定画满 25px。
      const dirX = camAxis.x
      const dirY = -camAxis.y
      const tipX = anchorX + dirX * AXIS_EDGE_LENGTH
      const tipY = anchorY + dirY * AXIS_EDGE_LENGTH
      const { line, text } = axisLines[i]
      line.setAttribute('x1', String(anchorX))
      line.setAttribute('y1', String(anchorY))
      line.setAttribute('x2', String(tipX))
      line.setAttribute('y2', String(tipY))
      // 字母：沿屏幕方向从端点再推 AXIS_TEXT_RADIUS；退化（轴正对相机，投影≈0）
      // 时回退到锚点左上斜向，避免字母全叠在锚点上。
      const len = Math.hypot(dirX, dirY)
      const labelX = len > 1e-3 ? tipX + (dirX / len) * AXIS_TEXT_RADIUS : anchorX - AXIS_TEXT_RADIUS * 0.7071
      const labelY = len > 1e-3 ? tipY + (dirY / len) * AXIS_TEXT_RADIUS : anchorY - AXIS_TEXT_RADIUS * 0.7071
      text.setAttribute('x', String(labelX))
      text.setAttribute('y', String(labelY))
    }
  }

  // ---------- 右下角缩放距离标尺（仅正射） ----------
  const scaleSvg = document.createElementNS(SVG_NS, 'svg')
  scaleSvg.style.cssText =
    `position:absolute;right:${SCALE_RIGHT}px;bottom:${SCALE_BOTTOM}px;` +
    'height:' + SCALE_SVG_HEIGHT + 'px;overflow:visible;'
  root.appendChild(scaleSvg)

  const barLine = document.createElementNS(SVG_NS, 'line')
  barLine.setAttribute('stroke', '#ffffff')
  barLine.setAttribute('stroke-width', '1.5')
  scaleSvg.appendChild(barLine)
  // 两端竖 tick（CC 同款：左端上下各半段画在一个元素上即可一条线段，竖线居中）
  const tickLeft = document.createElementNS(SVG_NS, 'line')
  const tickRight = document.createElementNS(SVG_NS, 'line')
  for (const tick of [tickLeft, tickRight]) {
    tick.setAttribute('stroke', '#ffffff')
    tick.setAttribute('stroke-width', '1.5')
    scaleSvg.appendChild(tick)
  }
  const scaleLabel = document.createElementNS(SVG_NS, 'text')
  scaleLabel.setAttribute('fill', '#ffffff')
  scaleLabel.setAttribute('font-size', '12')
  scaleLabel.setAttribute('text-anchor', 'middle')
  scaleLabel.setAttribute('dominant-baseline', 'alphabetic')
  scaleSvg.appendChild(scaleLabel)

  const updateScale = (camera: THREE.Camera, cssWidthPx: number, cssHeightPx: number) => {
    const ortho = camera as THREE.OrthographicCamera
    if (!ortho.isOrthographicCamera) {
      // 透视模式不显示标尺（CC 同款约束，见模块注释）
      scaleSvg.style.display = 'none'
      return
    }
    const bar = computeOrthoScaleBar(cssWidthPx, cssHeightPx, ortho.top, ortho.zoom)
    if (!bar) {
      scaleSvg.style.display = 'none'
      return
    }
    const svgW = Math.ceil(bar.widthCssPx + 2 * SCALE_PAD)
    scaleSvg.setAttribute('width', String(svgW))
    scaleSvg.setAttribute('height', String(SCALE_SVG_HEIGHT))
    scaleSvg.setAttribute('viewBox', `0 0 ${svgW} ${SCALE_SVG_HEIGHT}`)
    const x1 = SCALE_PAD
    const x2 = SCALE_PAD + bar.widthCssPx
    barLine.setAttribute('x1', String(x1))
    barLine.setAttribute('y1', String(SCALE_BAR_Y))
    barLine.setAttribute('x2', String(x2))
    barLine.setAttribute('y2', String(SCALE_BAR_Y))
    const tickY1 = SCALE_BAR_Y - SCALE_TICK
    const tickY2 = SCALE_BAR_Y + SCALE_TICK
    for (const [tick, x] of [
      [tickLeft, x1],
      [tickRight, x2],
    ] as const) {
      tick.setAttribute('x1', String(x))
      tick.setAttribute('y1', String(tickY1))
      tick.setAttribute('x2', String(x))
      tick.setAttribute('y2', String(tickY2))
    }
    // 数字锚在横线中点上方（纯数字，仿 CC 不带单位）
    scaleLabel.setAttribute('x', String(svgW / 2))
    scaleLabel.setAttribute('y', String(SCALE_LABEL_Y))
    scaleLabel.textContent = bar.label
    scaleSvg.style.display = ''
  }

  /** 外部注册的每帧屏幕层（各层自建 DOM，见 addScreenLayer 注释）。 */
  const screenLayers = new Set<ScreenLayerUpdate>()

  return {
    update(camera, cssWidthPx, cssHeightPx) {
      updateTriad(camera)
      updateScale(camera, cssWidthPx, cssHeightPx)
      // 屏幕层排在常显浮层之后：同一帧内后写 DOM，视觉上压在上层
      for (const layer of screenLayers) layer(camera, cssWidthPx, cssHeightPx)
    },
    addScreenLayer(update) {
      screenLayers.add(update)
      return () => {
        screenLayers.delete(update)
      }
    },
    dispose() {
      // 先断引用再拆 DOM：层所有者可能晚于本实例卸载，留着回调会打在已移除的容器上
      screenLayers.clear()
      root.remove()
    },
  }
}
