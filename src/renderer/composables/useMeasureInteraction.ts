import { watch } from 'vue'
import type { Ref } from 'vue'
import * as THREE from 'three'
import { useViewerStore } from '../stores/viewerStore'
import { useMeasureStore } from '../stores/measureStore'
import { useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useConsoleStore } from '../stores/consoleStore'
import { collectCandidates, pickVertex, projectWorldToScreen, toViewerCamera } from '../utils/measure'
import type { PickedPoint } from '../utils/measure'
import type { ThreeViewer } from '../three/engine'

/**
 * 测量模式的 3D 交互层：在 3D 视图上挂点击拾取监听，并绘制标记/连线/浮动标签。
 *
 * 生命周期由 measureStore.active 驱动：
 * - 进入模式：光标改 crosshair、挂监听、建 DOM 标签层、订阅引擎的每帧屏幕层；
 * - 点击拾取：canvas mousedown → window mousemove/mouseup（拖出 canvas 不丢跟踪），
 *   只有"位移小、按住短、落在容器内"的才算一次拾取（见下），否则视为旋转/缩放；
 * - 接入 measureStore.pick 后由 [picked, mode] 的 watch 重建 3D 标记与连线、
 *   重写标签正文；标签**位置**由屏幕层每帧投影（相机转动时跟随）；
 * - 退出模式：卸监听、清标记/连线、拆 DOM 标签层、退订屏幕层、还原光标。
 *
 * 相机**不锁**（与分割不同）：CC 在点拾取对话框打开时仍是 MODE_TRANSFORM_CAMERA，
 * 可随时旋转缩放平移并继续点击拾取；也没有像分割那样的拖拽手势与左键旋转冲突。
 *
 * 拾取点为全局（视图内所有可见点云、可跨对象，前遮挡后），不做目标快照——
 * 判断"哪些可见"由 pointcloudStore.getVisibleTargets 每次实时给出。
 */

/** 判定"这是旋转/误触、不是拾取"的最大拖拽距离（像素，同分割 MIN_DRAG_PX 的意图）。 */
const CLICK_MAX_DRAG_PX = 4
/** 判定"这是旋转、不是拾取"的最长按住时长（毫秒，同 CC 的点击阈值）。 */
const CLICK_MAX_PRESS_MS = 200

/** 测量标记色（CC 的黄），与分割的紫色 #6000a7 区分。 */
const MEASURE_COLOR = 0xffd400
const MEASURE_CSS = '#ffd400'
/** 标记点屏幕尺寸（像素；sizeAttenuation=false 下与相机距离无关）。 */
const MARKER_PX = 9
/** 信息框相对锚点的偏移（像素）。 */
const LABEL_OFFSET_PX = 18
/** A/B/C 徽标半径（像素）。 */
const BADGE_RADIUS_PX = 8
/** 徽标字母（下标 = 拾取顺序）。 */
const TAG_LETTERS = ['A', 'B', 'C'] as const

const SVG_NS = 'http://www.w3.org/2000/svg'

export function useMeasureInteraction(container: Ref<HTMLElement | null>) {
  const { active, mode, picked, result, pick, clearPicked } = useMeasureStore()
  const { getViewer } = useViewerStore()
  const { getAllEntities } = useSceneStore()
  const { log } = useConsoleStore()

  /* ---------- 点击 vs 拖拽 ---------- */

  let pressed = false
  let moved = false
  let downX = 0
  let downY = 0
  let downTime = 0

  /* ---------- 3D 标记与连线（世界坐标物体，只在拾取变化时重建） ---------- */

  let primitives: THREE.Group | null = null

  /* ---------- DOM 浮动标签（每帧只改位置，正文只在拾取变化时重写） ---------- */

  let labelRoot: HTMLDivElement | null = null
  let leaderLine: SVGLineElement | null = null
  let infoBox: HTMLDivElement | null = null
  let badges: { circle: SVGCircleElement; text: SVGTextElement }[] = []
  /** 信息框尺寸缓存（每帧定位用；正文变化时才重新测量，避免每帧强制布局）。 */
  let boxWidth = 0
  let boxHeight = 0
  let unsubscribeLayer: (() => void) | null = null

  /* ---------- 拾取 ---------- */

  /** 在给定 NDC 处拾取一个顶点并写入 store；落空则静默返回（不打日志、不重置已满的一组）。 */
  function doPick(ndc: THREE.Vector2, cssHeightPx: number) {
    const viewer = getViewer()
    if (!viewer) return
    // 候选每次实时收集（可见性会随点云显示/隐藏变化），双击设旋转中心复用同一份（见 utils/measure.ts）
    const candidates = collectCandidates(usePointCloudStore().getVisibleTargets())
    if (candidates.length === 0) return
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, viewer.camera)
    const hit = pickVertex(raycaster, toViewerCamera(viewer.camera), candidates, cssHeightPx)
    if (!hit) return

    // 世界坐标由**命中的那个 Points** 给（pickVertex 回传）：LOD 显示层命中时它对应
    // 显示层节点而非某个真实分块，(entityId, chunkIndex) 反查不出候选来
    const points = hit.points
    points.updateWorldMatrix(true, false)
    // 世界坐标仅用于标记与连线；展示与数值一律走 local / original（见 utils/measure.ts）
    const world = hit.local.clone().applyMatrix4(points.matrixWorld)

    const entity = getAllEntities().find((en) => en.id === hit.entityId)
    const shift = entity?.globalShift ?? { x: 0, y: 0, z: 0 }
    // 分类值由 pickVertex 读好（显示层的 classification 按槽位排布，这里拿不到槽位号）
    const classification = hit.classification

    const picked0: PickedPoint = {
      entityId: hit.entityId,
      entityName: entity?.name ?? '',
      chunkIndex: hit.chunkIndex,
      vertexIndex: hit.vertexIndex,
      local: { x: hit.local.x, y: hit.local.y, z: hit.local.z },
      world: { x: world.x, y: world.y, z: world.z },
      original: { x: hit.local.x + shift.x, y: hit.local.y + shift.y, z: hit.local.z + shift.z },
      globalShift: { x: shift.x, y: shift.y, z: shift.z },
      classification,
    }
    pick(picked0)
  }

  /* ---------- 监听器 ---------- */

  function onCanvasMouseDown(e: MouseEvent) {
    if (!active.value || e.button !== 0 || !container.value) return
    pressed = true
    moved = false
    downX = e.clientX
    downY = e.clientY
    downTime = performance.now()
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!pressed || moved) return
    if (Math.abs(e.clientX - downX) > CLICK_MAX_DRAG_PX || Math.abs(e.clientY - downY) > CLICK_MAX_DRAG_PX) {
      moved = true
    }
  }

  function onWindowMouseUp(e: MouseEvent) {
    if (!pressed) return
    pressed = false
    if (!active.value || e.button !== 0 || moved) return
    // 长按后松手多半是在旋转中途停住，不当作拾取（CC 同款阈值）
    if (performance.now() - downTime > CLICK_MAX_PRESS_MS) return
    const el = container.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return
    // 一律用容器矩形换算（flex 布局下 clientX 与 offsetLeft 的算术不可靠）
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((e.clientY - rect.top) / rect.height) * 2
    )
    doPick(ndc, rect.height)
  }

  function attachListeners(viewer: ThreeViewer) {
    viewer.domElement.addEventListener('mousedown', onCanvasMouseDown)
    // mousemove/mouseup 挂 window：拖出 canvas 不丢跟踪
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
    viewer.domElement.style.cursor = 'crosshair'
  }

  function detachListeners() {
    const viewer = getViewer()
    viewer?.domElement.removeEventListener('mousedown', onCanvasMouseDown)
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    if (viewer) viewer.domElement.style.cursor = ''
    pressed = false
  }

  /* ---------- 3D 标记与连线 ---------- */

  function clearPrimitives() {
    if (!primitives) return
    const viewer = getViewer()
    viewer?.scene.remove(primitives)
    primitives.traverse((obj) => {
      const object = obj as THREE.Points | THREE.Line
      object.geometry?.dispose()
      const material = object.material as THREE.Material | THREE.Material[] | undefined
      if (material) {
        ;(Array.isArray(material) ? material : [material]).forEach((m) => m.dispose())
      }
    })
    primitives = null
    // 引擎按需渲染：场景增删不会自己触发重绘（见 ThreeViewer.requestRender）
    viewer?.requestRender()
  }

  /** 按当前拾取重建标记与连线（数量 ≤3，直接新建几何体比复用更省心）。 */
  function rebuildPrimitives() {
    clearPrimitives()
    const viewer = getViewer()
    const pts = picked.value
    if (!viewer || pts.length === 0) return

    const group = new THREE.Group()

    const markerPositions = new Float32Array(pts.length * 3)
    pts.forEach((p, i) => {
      markerPositions[i * 3] = p.world.x
      markerPositions[i * 3 + 1] = p.world.y
      markerPositions[i * 3 + 2] = p.world.z
    })
    const markerGeometry = new THREE.BufferGeometry()
    markerGeometry.setAttribute('position', new THREE.BufferAttribute(markerPositions, 3))
    const marker = new THREE.Points(
      markerGeometry,
      // sizeAttenuation=false：size 即屏幕像素（three 会自动乘 devicePixelRatio），
      // 与仓库现成的点云材质同一渲染模式，无需每帧按距离重算世界缩放
      new THREE.PointsMaterial({ size: MARKER_PX, sizeAttenuation: false, depthTest: false, color: MEASURE_COLOR })
    )
    marker.frustumCulled = false
    marker.renderOrder = 999 // 与分割覆盖物一致：压在点云之上，避免被近处点遮住
    group.add(marker)

    // 连线：两点 → 一段；三点 → A→B→C→A 闭合三角形（单点模式没有线）
    const chain =
      mode.value === 'distance' && pts.length === 2
        ? [0, 1]
        : mode.value === 'angle' && pts.length === 3
          ? [0, 1, 2, 0]
          : []
    if (chain.length >= 2) {
      const linePositions = new Float32Array(chain.length * 3)
      chain.forEach((idx, i) => {
        const w = pts[idx].world
        linePositions[i * 3] = w.x
        linePositions[i * 3 + 1] = w.y
        linePositions[i * 3 + 2] = w.z
      })
      const lineGeometry = new THREE.BufferGeometry()
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
      const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false }))
      line.frustumCulled = false
      line.renderOrder = 999 // 线宽在 WebGL 恒为 1px（与分割覆盖物同一已知限制）
      group.add(line)
    }

    primitives = group
    viewer.scene.add(group)
    // 置脏两点：标记与连线要画出来，且标签的屏幕层（addScreenLayer）只在渲染帧执行
    viewer.requestRender()
  }

  /* ---------- DOM 浮动标签 ---------- */

  /** 惰性创建标签 DOM（引线 + A/B/C 徽标 + 信息框）；返回是否就绪。 */
  function ensureLabelRoot(): boolean {
    if (labelRoot) return true
    const el = container.value
    if (!el) return false

    const root = document.createElement('div')
    // z-index 6：高于分割橡皮筋（5）、低于右下角轴向/标尺（10）；
    // 整层 pointer-events:none，不挡轨道旋转与拾取本身
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden;'

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;'
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('stroke', MEASURE_CSS)
    line.setAttribute('stroke-width', '1')
    line.setAttribute('stroke-dasharray', '3 2')
    svg.appendChild(line)
    leaderLine = line

    // A/B/C 徽标：多点模式下标出各拾取点的身份，与正文里的 A/B/C 行对应
    badges = TAG_LETTERS.map((letter) => {
      const circle = document.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('r', String(BADGE_RADIUS_PX))
      circle.setAttribute('fill', MEASURE_CSS)
      svg.appendChild(circle)
      const text = document.createElementNS(SVG_NS, 'text')
      text.textContent = letter
      text.setAttribute('fill', '#000000')
      text.setAttribute('font-size', '11')
      text.setAttribute('font-weight', 'bold')
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dominant-baseline', 'central')
      svg.appendChild(text)
      return { circle, text }
    })
    root.appendChild(svg)

    // 信息框放在 svg 之后：同为 absolute 时后写的兄弟压在上层，
    // 于是"框心 → 锚点"的引线穿进框内的那一段被框自身盖住，看起来正好像从框边引出
    const box = document.createElement('div')
    box.style.cssText =
      'position:absolute;padding:4px 6px;background:rgba(0,0,0,0.78);border:1px solid ' +
      MEASURE_CSS +
      ';border-radius:3px;color:#ffffff;font:12px/1.45 ui-monospace,Consolas,monospace;' +
      'white-space:pre;pointer-events:none;display:none;'
    root.appendChild(box)
    infoBox = box

    el.appendChild(root)
    labelRoot = root
    return true
  }

  /** 重写信息框正文并缓存其尺寸（未满员时隐藏）。 */
  function renderLabelContent() {
    if (!ensureLabelRoot() || !infoBox) return
    const r = result.value
    if (!r) {
      infoBox.style.display = 'none'
      boxWidth = 0
      boxHeight = 0
      return
    }
    infoBox.textContent = ''
    const title = document.createElement('div')
    title.textContent = r.title
    title.style.cssText = `font-weight:bold;color:${MEASURE_CSS};margin-bottom:2px;`
    infoBox.appendChild(title)
    // 逐行一个 div：行内的多空格靠 white-space:pre 保留，列才能像 CC 那样对齐
    for (const text of r.lines) {
      const row = document.createElement('div')
      row.textContent = text
      infoBox.appendChild(row)
    }
    infoBox.style.display = ''
    boxWidth = infoBox.offsetWidth
    boxHeight = infoBox.offsetHeight
  }

  function removeLabelRoot() {
    infoBox?.remove()
    labelRoot?.remove()
    labelRoot = null
    leaderLine = null
    infoBox = null
    badges = []
    boxWidth = 0
    boxHeight = 0
  }

  /**
   * 每帧屏幕层：把世界坐标投到 CSS 像素上（引线、徽标、信息框都是 DOM 元素）。
   *
   * 由引擎在 renderer.render 之后调用，camera.matrixWorldInverse 此刻才与当前姿态同步
   * （另起一个 rAF 会拿到上一帧的矩阵，标签抖一帧）。
   */
  function updateScreenLayer(camera: THREE.Camera, cssWidthPx: number, cssHeightPx: number) {
    if (!labelRoot || !infoBox || !leaderLine) return
    const pts = picked.value
    const screen = pts.map((p) => projectWorldToScreen(p.world, camera, cssWidthPx, cssHeightPx))

    // 徽标：仅多点模式（单点模式信息框本身指向该点，再套个 A 反而多余）
    const showBadges = mode.value !== 'point'
    badges.forEach((badge, i) => {
      const sp = showBadges ? screen[i] : null
      if (!sp) {
        badge.circle.style.display = 'none'
        badge.text.style.display = 'none'
        return
      }
      badge.circle.setAttribute('cx', String(sp.x))
      badge.circle.setAttribute('cy', String(sp.y))
      badge.text.setAttribute('x', String(sp.x))
      badge.text.setAttribute('y', String(sp.y))
      badge.circle.style.display = ''
      badge.text.style.display = ''
    })

    // 锚点 = 可见拾取点的屏幕质心（CC 的引线箭头同样指向质心）
    const visible = screen.filter((s): s is { x: number; y: number } => s !== null)
    if (visible.length === 0 || !result.value) {
      // 全部点跑到相机背后/视锥外：整体隐藏（CC 在点不可见时同样不画标签），
      // 不隐藏的话会看到标签停在上一帧位置或出现在镜像位置
      leaderLine.style.display = 'none'
      infoBox.style.display = 'none'
      return
    }
    const anchorX = visible.reduce((sum, s) => sum + s.x, 0) / visible.length
    const anchorY = visible.reduce((sum, s) => sum + s.y, 0) / visible.length

    // 信息框默认放在锚点右下方，贴边时翻到另一侧，最后再夹回容器内
    let left = anchorX + LABEL_OFFSET_PX
    let top = anchorY + LABEL_OFFSET_PX
    if (left + boxWidth > cssWidthPx) left = anchorX - LABEL_OFFSET_PX - boxWidth
    if (top + boxHeight > cssHeightPx) top = anchorY - LABEL_OFFSET_PX - boxHeight
    left = Math.max(0, Math.min(left, cssWidthPx - boxWidth))
    top = Math.max(0, Math.min(top, cssHeightPx - boxHeight))
    infoBox.style.left = `${left}px`
    infoBox.style.top = `${top}px`
    infoBox.style.display = ''

    leaderLine.setAttribute('x1', String(left + boxWidth / 2))
    leaderLine.setAttribute('y1', String(top + boxHeight / 2))
    leaderLine.setAttribute('x2', String(anchorX))
    leaderLine.setAttribute('y2', String(anchorY))
    leaderLine.style.display = ''
  }

  /* ---------- 生命周期 ---------- */

  function clearAll() {
    clearPrimitives()
    removeLabelRoot()
  }

  watch(active, (act) => {
    if (act) {
      const viewer = getViewer()
      if (!viewer) return
      attachListeners(viewer)
      ensureLabelRoot()
      unsubscribeLayer = viewer.overlays.addScreenLayer(updateScreenLayer)
    } else {
      detachListeners()
      unsubscribeLayer?.()
      unsubscribeLayer = null
      clearAll()
    }
  })

  // 拾取结果或模式变化：重建 3D 标记/连线 + 重写标签正文（位置交给屏幕层每帧跟）
  watch([picked, mode], () => {
    if (!active.value) return
    rebuildPrimitives()
    renderLabelContent()
  })

  // 测量期间实体被删除/分割/合并（源实体 id 消失）→ 清除结果并告知，
  // 否则会留下指向不存在的点云、且其索引在新几何体里已无意义的标记
  watch(
    () =>
      getAllEntities()
        .map((e) => e.id)
        .join(','),
    () => {
      if (!active.value || picked.value.length === 0) return
      const ids = new Set(getAllEntities().map((e) => e.id))
      if (picked.value.some((p) => !ids.has(p.entityId))) {
        clearPicked()
        log('Measure', '点云已删除或被替换，测量结果已清除')
      }
    }
  )
}
