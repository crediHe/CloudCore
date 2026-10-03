import { watch } from 'vue'
import type { Ref } from 'vue'
import * as THREE from 'three'
import { useViewerStore } from '../stores/viewerStore'
import { useSegmentStore } from '../stores/segmentStore'
import { useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useProgressStore } from '../stores/progressStore'
import { useConsoleStore } from '../stores/consoleStore'
import { computeQuadrangleSelection, computePolygonSelection } from '../utils/segmentSelection'
import type { NdcRect, NdcPoint, SegmentTarget, ChunkSelection } from '../utils/segmentSelection'
import type { ThreeViewer } from '../three/engine'

/** 判定"误触点击"的最小拖拽距离（像素）。 */
const MIN_DRAG_PX = 4

/** 3D 覆盖矩形/多边形的颜色（对齐 MD3 primary #6000a7）。 */
const OVERLAY_COLOR = 0x6000a7

/**
 * 分割模式的 3D 交互层：在 3D 视图容器上挂载绘制监听。
 *
 * 生命周期由 segmentStore.active 驱动：
 * - 进入模式：锁定轨道控制器（绘制期间不可旋转）、强制目标点云可见、挂监听；
 * - 四边形绘制：canvas mousedown 起笔，window mousemove/mouseup 跟踪（拖出 canvas
 *   不丢跟踪），mouseup 时按像素矩形换算 NDC 选区，计算各块 inside/outside 索引，
 *   但预览未应用、相机仍锁定——等待用户选择"选区内/选取外"；
 * - 自由多边形绘制：canvas mousedown 左键加点（≥3），mousemove 时 SVG 橡皮筋
 *   末段跟随鼠标，右键闭合（拦截原生菜单），Esc 清除草稿/选区；
 * - 选定模式（setMode）：应用索引预览，此后确定可用、相机解锁（可旋转观察）；
 * - 3D 锚定覆盖物：把 NDC 图形反投影到"过目标云世界中心、法线=相机前向"的平面，
 *   生成世界坐标里的描边+半透明填充（相机旋转后图形仍在 3D 空间原地不动）；
 * - 退出模式：还原索引、移除覆盖物、解除强制可见、解锁相机、卸监听。
 */
export function useSegmentInteraction(container: Ref<HTMLElement | null>) {
  const { active, shape, hasRect, modeChosen, targetEntityIds, setHasRect, storeSelection, resetSelection } =
    useSegmentStore()
  const { getViewer } = useViewerStore()
  const { start } = useProgressStore()
  const { log } = useConsoleStore()
  const { getAllEntities } = useSceneStore()

  /** 当前分割目标（进入模式时快照；确定后场景树里的原实体已替换，不参与清理）。 */
  let targets: SegmentTarget[] = []
  /** 是否正在拖拽绘制（四边形 mousedown 到 mouseup 之间）。 */
  let drawing = false
  let dragStartX = 0
  let dragStartY = 0
  /** 四边形拖拽预览框（跟随鼠标的像素矩形）。 */
  let previewDiv: HTMLDivElement | null = null
  /** 3D 锚定覆盖物（LineLoop 描边 + 半透明填充）。 */
  let overlay: THREE.Group | null = null

  /* ---------- 自由多边形绘制 ---------- */

  /** 像素坐标点（相对 canvas 容器）。 */
  interface PixelPoint {
    x: number
    y: number
  }

  /** 多边形草稿：canvas 相对像素坐标（点击顺序，闭合/清除后清空）。 */
  let polygonPoints: PixelPoint[] = []
  /** 橡皮筋预览（SVG polyline，末段跟随鼠标）。 */
  let polylineSvg: SVGSVGElement | null = null
  let polylineEl: SVGPolylineElement | null = null
  /** 已点击顶点的圆点标记（跟随加点实时显示，闭合后由 overlay 接管）。 */
  let vertexCircles: SVGCircleElement[] = []

  /** 清除多边形草稿与橡皮筋预览（幂等）。 */
  function clearPolygonDraft() {
    polygonPoints = []
    vertexCircles = []
    polylineSvg?.remove()
    polylineSvg = null
    polylineEl = null
  }

  /** 创建（或复用）橡皮筋 SVG 层，返回是否就绪。 */
  function ensurePolylineSvg(): boolean {
    const el = container.value
    if (!el) return false
    if (polylineSvg) return true
    // 显式 top/left/width/height 定位（与四边形预览框一致；inset 简写在 cssText 里解析不可靠，
    // 失效时 SVG 只剩默认 300×150 尺寸，超出范围的折线看不见）
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;'
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    poly.setAttribute('fill', 'none')
    poly.setAttribute('stroke', '#6000a7')
    poly.setAttribute('stroke-width', '2')
    poly.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(poly)
    el.appendChild(svg)
    polylineSvg = svg
    polylineEl = poly
    return true
  }

  /** 在点击位置添加顶点圆点标记。 */
  function addVertexMarker(p: PixelPoint) {
    if (!polylineSvg) return
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', `${p.x}`)
    circle.setAttribute('cy', `${p.y}`)
    circle.setAttribute('r', '3')
    circle.setAttribute('fill', '#6000a7')
    polylineSvg.appendChild(circle)
    vertexCircles.push(circle)
  }

  /** 刷新橡皮筋：已有点 + 可选的光标位置（末段跟随）。 */
  function updatePolyline(cursor?: PixelPoint) {
    if (!polylineEl) return
    const pts = polygonPoints.map((p) => `${p.x},${p.y}`)
    if (cursor) pts.push(`${cursor.x},${cursor.y}`)
    polylineEl.setAttribute('points', pts.join(' '))
  }

  /* ---------- 拖拽绘制（四边形）与加点（多边形） ---------- */

  function onCanvasMouseDown(e: MouseEvent) {
    // 已绘制过选区则不再响应（无重画，刷新/Esc 清除后可再画）
    if (!active.value || hasRect.value || drawing) return
    if (e.button !== 0) return
    const el = container.value
    if (!el) return
    if (shape.value === 'polygon') {
      // 自由多边形：左键添加顶点，橡皮筋实时预览
      const box = el.getBoundingClientRect()
      const pt = { x: e.clientX - box.left, y: e.clientY - box.top }
      polygonPoints.push(pt)
      if (ensurePolylineSvg()) {
        addVertexMarker(pt)
        updatePolyline()
      }
      return
    }
    // 四边形：起笔拖拽预览框（跟随鼠标，纯视觉反馈）
    drawing = true
    const box = el.getBoundingClientRect()
    dragStartX = e.clientX - box.left
    dragStartY = e.clientY - box.top
    previewDiv = document.createElement('div')
    previewDiv.style.cssText =
      'position:absolute;border:2px solid #6000a7;background:rgba(96,0,167,0.12);' +
      'pointer-events:none;z-index:5;box-sizing:border-box;'
    previewDiv.style.left = `${dragStartX}px`
    previewDiv.style.top = `${dragStartY}px`
    el.appendChild(previewDiv)
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!active.value) return
    const el = container.value
    if (!el) return
    if (shape.value === 'polygon') {
      // 自由多边形：草稿非空且未闭合时，末段橡皮筋跟随鼠标
      if (hasRect.value || polygonPoints.length === 0 || !polylineEl) return
      const box = el.getBoundingClientRect()
      updatePolyline({ x: e.clientX - box.left, y: e.clientY - box.top })
      return
    }
    if (!drawing || !previewDiv) return
    const box = el.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    previewDiv.style.left = `${Math.min(dragStartX, x)}px`
    previewDiv.style.top = `${Math.min(dragStartY, y)}px`
    previewDiv.style.width = `${Math.abs(x - dragStartX)}px`
    previewDiv.style.height = `${Math.abs(y - dragStartY)}px`
  }

  /** 像素坐标 → NDC（Y 翻转：屏幕 y 向下，NDC y 向上）。 */
  function toNdc(px: number, py: number, box: DOMRect): NdcPoint {
    return { x: (px / box.width) * 2 - 1, y: 1 - (py / box.height) * 2 }
  }

  /**
   * 计算选区并落地：进度对话框（分块间让出主线程）+ 写缓存 + 标记完成 + 锚定覆盖物。
   * 四边形与多边形共用；compute 闭包承担形状差异（选区内判定）。
   */
  async function computeAndStore(
    viewer: ThreeViewer,
    ndcPoints: NdcPoint[],
    compute: (onChunk: () => void | Promise<void>) => Promise<Map<number, ChunkSelection[]>>,
    doneHint: string
  ) {
    const handle = start({ title: '分割选区计算', modal: true, progress: null })
    try {
      const totalChunks = targets.reduce((sum, t) => sum + t.geometries.length, 0)
      let done = 0
      const selections = await compute(() => {
        done++
        handle.update(null, `正在筛选点（${done}/${totalChunks}）`)
      })
      storeSelection(selections)
      setHasRect(true)
      // 预览与应用、相机解锁都推迟到用户选定"选区内/选取外"之后（见 watch 组合）
      buildOverlay(viewer, ndcPoints)
      handle.done()
      log('Segment', doneHint)
    } catch (err) {
      console.error('选区计算失败', err)
      handle.fail('选区计算失败')
      log('Segment', '选区计算失败，请重新绘制')
    }
  }

  async function onWindowMouseUp(e: MouseEvent) {
    if (!drawing) return
    drawing = false
    removePreviewDiv()
    const el = container.value
    const viewer = getViewer()
    if (!el || !viewer) return
    const box = el.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    // 最小拖拽阈值：误触点击（无拖动）忽略，不进入预览状态
    const width = Math.abs(x - dragStartX)
    const height = Math.abs(y - dragStartY)
    if (width < MIN_DRAG_PX || height < MIN_DRAG_PX) {
      log('Segment', '拖拽距离过小，已忽略（请在视图内拖拽绘制矩形）')
      return
    }
    // 像素 → NDC 角点，顺序保持 [minX,minY],[minX,maxY],[maxX,maxY],[maxX,minY]（与 buildOverlay 一致）
    const minPx = Math.min(dragStartX, x)
    const maxPx = Math.max(dragStartX, x)
    const minPy = Math.min(dragStartY, y)
    const maxPy = Math.max(dragStartY, y)
    const ndcCorners: NdcPoint[] = [
      toNdc(minPx, minPy, box),
      toNdc(minPx, maxPy, box),
      toNdc(maxPx, maxPy, box),
      toNdc(maxPx, minPy, box),
    ]
    const rect: NdcRect = {
      minX: ndcCorners[0].x,
      minY: ndcCorners[1].y,
      maxX: ndcCorners[2].x,
      maxY: ndcCorners[0].y,
    }
    await computeAndStore(
      viewer,
      ndcCorners,
      (onChunk) => computeQuadrangleSelection(viewer.camera, viewer.scene, rect, targets, onChunk),
      '矩形绘制完成；请先选择选区内或选取外以应用预览，再确定分割'
    )
  }

  /** 自由多边形：右键闭合（≥3 顶点），拦截原生右键菜单。 */
  function onCanvasContextMenu(e: MouseEvent) {
    if (!active.value || shape.value !== 'polygon') return
    // 绘制期 controls.enabled=false，OrbitControls 不 preventDefault（已核实 r185 源码），
    // 必须自行拦截，否则会弹出浏览器原生菜单
    e.preventDefault()
    if (hasRect.value) return
    if (polygonPoints.length < 3) {
      log('Segment', `多边形至少需要 3 个顶点才能闭合（当前 ${polygonPoints.length} 个）`)
      return
    }
    void finalizePolygon()
  }

  /** 自由多边形：闭合计算（像素 → NDC → computePolygonSelection → 落地）。 */
  async function finalizePolygon() {
    const el = container.value
    const viewer = getViewer()
    if (!el || !viewer) return
    const box = el.getBoundingClientRect()
    const ndc = polygonPoints.map((p) => toNdc(p.x, p.y, box))
    clearPolygonDraft() // 完成即清草稿，overlay 接管视觉
    await computeAndStore(
      viewer,
      ndc,
      (onChunk) => computePolygonSelection(viewer.camera, viewer.scene, ndc, targets, onChunk),
      '多边形绘制完成；请先选择选区内或选取外以应用预览，再确定分割'
    )
  }

  /** Esc：清除多边形草稿；已闭合未选模式时等价刷新按钮（清选区重画）。 */
  function onWindowKeyDown(e: KeyboardEvent) {
    if (!active.value || shape.value !== 'polygon') return
    if (e.key !== 'Escape') return
    e.preventDefault()
    // 与刷新按钮可用条件一致：绘制完成但未选定选区模式才清选区；modeChosen 后不响应
    if (hasRect.value && !modeChosen.value) {
      resetSelection()
    }
    clearPolygonDraft()
  }

  /* ---------- 3D 锚定覆盖物 ---------- */

  /**
   * 目标云的世界空间中心（各实体显示坐标 bbox 中心经 group.matrixWorld 变换后平均）。
   * 相机锁定状态下绘制，group.matrixWorld 稳定；此处仍需刷新矩阵以防 stale。
   */
  function worldCenter(): THREE.Vector3 {
    const sum = new THREE.Vector3()
    let n = 0
    for (const t of targets) {
      const entity = getAllEntities().find((en) => en.id === t.entityId)
      if (!entity || !entity.bbox || !entity.globalShift) continue
      const local = new THREE.Vector3(
        (entity.bbox.minX + entity.bbox.maxX) / 2 - entity.globalShift.x,
        (entity.bbox.minY + entity.bbox.maxY) / 2 - entity.globalShift.y,
        (entity.bbox.minZ + entity.bbox.maxZ) / 2 - entity.globalShift.z
      ).applyMatrix4(t.group.matrixWorld)
      sum.add(local)
      n++
    }
    return n > 0 ? sum.divideScalar(n) : new THREE.Vector3()
  }

  /**
   * 在 3D 空间中锚定选区图形：NDC 点经射线反投影到"过目标中心、法线=相机前向"的
   * 平面。图形成为世界坐标里的几何体，之后旋转/缩放相机它都停在原地。
   * 真实选择语义是"过图形窗口的视锥"（含平面后方、纵深上的点），覆盖物只是截面。
   * 四边形传 4 角点（[minX,minY],[minX,maxY],[maxX,maxY],[maxX,minY] 顺序），
   * 自由多边形传点击顺序的顶点；填充用 ShapeGeometry 三角化（凹多边形亦支持）。
   */
  function buildOverlay(viewer: ThreeViewer, ndcPoints: NdcPoint[]) {
    removeOverlay()
    // camera 不在 scene 中，需单独刷新矩阵
    viewer.camera.updateMatrixWorld(true)
    viewer.scene.updateMatrixWorld(true)

    const center = worldCenter()
    const normal = viewer.camera.getWorldDirection(new THREE.Vector3()).normalize()
    // 锚定平面局部正交基：ShapeGeometry 需要平面局部 2D 坐标（z=0），
    // 世界点先经 frameInv 转局部喂给 Shape，再 applyMatrix4(frame) 映射回世界
    const up = Math.abs(normal.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
    const xAxis = new THREE.Vector3().crossVectors(normal, up).normalize()
    const yAxis = new THREE.Vector3().crossVectors(xAxis, normal).normalize()
    const frame = new THREE.Matrix4().makeBasis(xAxis, yAxis, normal).setPosition(center)
    const frameInv = frame.clone().invert()

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center)
    const raycaster = new THREE.Raycaster()
    const worldPts = ndcPoints.map((p) => {
      raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), viewer.camera)
      const hit = new THREE.Vector3()
      return raycaster.ray.intersectPlane(plane, hit) ?? raycaster.ray.origin
    })

    const group = new THREE.Group()
    // 描边（LineLoop 自动闭合回起点）；renderOrder 置顶保证不被点云盖住
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(worldPts),
      new THREE.LineBasicMaterial({ color: OVERLAY_COLOR, depthTest: false })
    )
    line.renderOrder = 999
    group.add(line)

    // 半透明填充（depthTest:false + renderOrder 置顶，否则被点云盖住）；
    // Earcut 自动三角化凹多边形；自相交时三角化失败返回空数组，仅填充消失、描边仍在
    if (worldPts.length >= 3) {
      const localPts = worldPts.map((p) => p.clone().applyMatrix4(frameInv))
      const shape = new THREE.Shape()
      localPts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)))
      shape.closePath()
      const fillGeo = new THREE.ShapeGeometry(shape)
      fillGeo.applyMatrix4(frame) // 局部 → 世界
      const fill = new THREE.Mesh(
        fillGeo,
        new THREE.MeshBasicMaterial({
          color: OVERLAY_COLOR,
          transparent: true,
          opacity: 0.12,
          depthTest: false,
          side: THREE.DoubleSide,
        })
      )
      fill.renderOrder = 999
      group.add(fill)
    }
    overlay = group
    viewer.scene.add(group)
    // 引擎按需渲染：场景增删不会自己触发重绘（见 ThreeViewer.requestRender）。
    // 四边形拖拽期间本函数每次 mousemove 都重建覆盖物，这里也就顺带把重绘排上了
    viewer.requestRender()
  }

  function removeOverlay() {
    if (!overlay) return
    const viewer = getViewer()
    viewer?.scene.remove(overlay)
    viewer?.requestRender()
    overlay.traverse((obj) => {
      const object = obj as THREE.Mesh | THREE.Line
      object.geometry?.dispose()
      const material = object.material as THREE.Material | THREE.Material[] | undefined
      if (material) {
        ;(Array.isArray(material) ? material : [material]).forEach((m) => m.dispose())
      }
    })
    overlay = null
  }

  function removePreviewDiv() {
    previewDiv?.remove()
    previewDiv = null
  }

  /* ---------- 生命周期 ---------- */

  function attachListeners(viewer: ThreeViewer) {
    viewer.domElement.addEventListener('mousedown', onCanvasMouseDown)
    viewer.domElement.addEventListener('contextmenu', onCanvasContextMenu)
    // mousemove/mouseup 挂 window：拖出 canvas 不丢跟踪
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
    window.addEventListener('keydown', onWindowKeyDown)
  }

  function detachListeners() {
    const viewer = getViewer()
    viewer?.domElement.removeEventListener('mousedown', onCanvasMouseDown)
    viewer?.domElement.removeEventListener('contextmenu', onCanvasContextMenu)
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    window.removeEventListener('keydown', onWindowKeyDown)
  }

  /**
   * 相机锁同步：分割模式下"绘制完成但尚未选定选区模式"时保持锁定，
   * 选定"选区内/选取外"（预览应用）后才解锁，可旋转/缩放/平移观察。
   * 退出模式时一律解锁。
   */
  watch([active, hasRect, modeChosen], () => {
    const viewer = getViewer()
    if (!viewer) return
    viewer.controls.enabled = !active.value || (hasRect.value && modeChosen.value)
  })

  // 选定"选区内/选取外"后预览已表达选区，锚定覆盖物使命完成，移除
  watch(modeChosen, (chosen) => {
    if (chosen) removeOverlay()
  })

  // 选区被清除（刷新按钮/Esc/切形状/退出）时清理覆盖物与预览元素；removeXxx 均幂等
  watch(hasRect, (h) => {
    if (!h) {
      removeOverlay()
      removePreviewDiv()
      clearPolygonDraft()
    }
  })

  // 切形状时清掉未完成的多边形草稿（此时 hasRect 可能一直是 false，上一条 watch 不触发）
  watch(shape, () => clearPolygonDraft())

  watch(active, (act) => {
    if (act) {
      // 进入分割模式
      targets = usePointCloudStore().getSegmentTargets(targetEntityIds.value)
      if (targets.length === 0) return // startSegment 已过滤，此处仅防御
      const viewer = getViewer()
      if (!viewer) return
      // 预览期间强制目标可见（防树勾选把整云藏掉）
      usePointCloudStore().beginSegmentPreview(targets.map((t) => t.entityId))
      attachListeners(viewer)
    } else {
      // 退出分割模式（确定/取消/再次点击 segment 按钮）
      detachListeners()
      removeOverlay()
      removePreviewDiv()
      clearPolygonDraft()
      if (targets.length > 0) {
        usePointCloudStore().endSegmentPreview(targets.map((t) => t.entityId))
      }
      targets = []
    }
  })
}
