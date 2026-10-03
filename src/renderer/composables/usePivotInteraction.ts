import { onUnmounted } from 'vue'
import type { Ref } from 'vue'
import * as THREE from 'three'
import { useViewerStore } from '../stores/viewerStore'
import { useMeasureStore } from '../stores/measureStore'
import { useSegmentStore } from '../stores/segmentStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useConsoleStore } from '../stores/consoleStore'
import { collectCandidates, pickVertex, toViewerCamera } from '../utils/measure'
import { fmtAxisCenter } from '../utils/format'

/**
 * 双击点云上的点 → 把它设为旋转中心。
 *
 * 仿 CloudCompare 的 ccGLWindowInterface::processMouseDoubleClickEvent
 * （ccGLWindowInterface.cpp:6331）：光标下的点直接成为 pivot。
 *
 * 与另两个交互层（分割 / 测量）不同，本层**没有模态**——常驻监听，跟随引擎实例的
 * 生死，不占工具栏、不改光标。这是 CC 的语义：双击设 pivot 任何时候都可用。
 *
 * 两处与 CC 的有意差异：
 *  - **测量/框选模态期间不响应**。CC 在双击时会 m_deferredPickingTimer.stop() 取消掉
 *    那一次点拾取；本仓库的测量是 mouseup 立即提交、不做延迟，等 dblclick 到达时两次
 *    拾取已经落定、撤不回来——与其为一个便捷入口去重构测量的拾取时机，不如在测量/
 *    框选期间直接关掉这个入口。
 *  - 命中要求同 CC：只有拾取到**顶点**才设（空白处双击无操作）。
 *
 * 传给引擎的是 world 坐标（含点云 Group 的 rotation.x=-π/2，见 engine.setPivot）；
 * 日志里报的是 local（显示坐标），与测量的读法一致——world 是渲染内部量，对用户无意义。
 */

/** 判定"这是旋转/误触、不是双击"的最大拖拽距离（像素，同测量层 CLICK_MAX_DRAG_PX）。 */
const CLICK_MAX_DRAG_PX = 4

export function usePivotInteraction(container: Ref<HTMLElement | null>) {
  const { getViewer, setPivot } = useViewerStore()
  const { log } = useConsoleStore()
  // 挂载时捕获实例：本层的监听与它同生共死（重挂载时组件会重新调用本函数）
  const viewer = getViewer()
  if (!viewer) return

  /* ---------- 点击 vs 拖拽 ---------- */

  let pressed = false
  let moved = false
  let downX = 0
  let downY = 0

  function onCanvasMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    pressed = true
    moved = false
    downX = e.clientX
    downY = e.clientY
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!pressed || moved) return
    if (Math.abs(e.clientX - downX) > CLICK_MAX_DRAG_PX || Math.abs(e.clientY - downY) > CLICK_MAX_DRAG_PX) {
      moved = true
    }
  }

  /** 松手只解除按住标记；moved 要留到 dblclick 才判定（dblclick 在 mouseup 之后派发）。 */
  function onWindowMouseUp() {
    pressed = false
  }

  /* ---------- 双击设旋转中心 ---------- */

  // 写成箭头常量而非 function 声明：function 会被提升，TS 认为它可能在上面那句
  // 提前返回之前被调用，捕获到的 viewer 收窄随之失效（function 写法会报 possibly null）
  const onDoubleClick = (e: MouseEvent) => {
    // 拖拽旋转/平移后松手再点，浏览器仍可能判成双击——按下到抬起位移超阈值即忽略
    if (moved) return
    // 测量/框选期间让位（理由见文件头注释）
    if (useMeasureStore().active.value || useSegmentStore().active.value) return
    const el = container.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const candidates = collectCandidates(usePointCloudStore().getVisibleTargets())
    if (candidates.length === 0) return

    // NDC 一律用容器矩形换算（flex 布局下 clientX 与 offsetLeft 的算术不可靠，同测量层）
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((e.clientY - rect.top) / rect.height) * 2
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, viewer.camera)
    const hit = pickVertex(raycaster, toViewerCamera(viewer.camera), candidates, rect.height)
    if (!hit) return

    // 取命中的那个 Points 的 matrixWorld 换算世界坐标（同测量层：LOD 显示层命中时
    // (entityId, chunkIndex) 反查不出候选，必须用 pickVertex 回传的实例）
    hit.points.updateWorldMatrix(true, false)
    setPivot(hit.local.clone().applyMatrix4(hit.points.matrixWorld))
    log('View', `旋转中心已设为 P#${hit.vertexIndex} ${fmtAxisCenter(hit.local)}`)
  }

  viewer.domElement.addEventListener('mousedown', onCanvasMouseDown)
  viewer.domElement.addEventListener('dblclick', onDoubleClick)
  // mousemove/mouseup 挂 window：拖出 canvas 再松手也要复位（同测量层约定）
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)

  onUnmounted(() => {
    // 用挂载时捕获的实例摘监听：ThreeView 的 onUnmounted 先于本回调注册，此刻
    // viewerStore 里已是 null，而元素对象即使已脱离 DOM 也仍能 removeEventListener
    viewer.domElement.removeEventListener('mousedown', onCanvasMouseDown)
    viewer.domElement.removeEventListener('dblclick', onDoubleClick)
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  })
}
