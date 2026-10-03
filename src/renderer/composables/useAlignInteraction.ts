import { watch } from 'vue'
import type { Ref } from 'vue'
import * as THREE from 'three'
import { useViewerStore } from '../stores/viewerStore'
import { useAlignStore } from '../stores/alignStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useConsoleStore } from '../stores/consoleStore'
import { useSceneStore } from '../stores/sceneStore'
import { collectCandidates, pickVertex, toViewerCamera } from '../utils/measure'
import type { ThreeViewer } from '../three/engine'

/**
 * 点对对齐模式的 3D 交互层：在 3D 视图上挂点击拾取，把命中点路由进 alignStore。
 *
 * 骨架照 `useMeasureInteraction.ts` 抄（这里**没有**DOM 浮动标签，标记全在 3D 里由
 * `three/registrationOverlay.ts` 画）：
 * - 进入模式（`alignStore.active`）→ 光标改 crosshair、挂监听；
 * - canvas mousedown → window mousemove/mouseup（拖出 canvas 不丢跟踪），
 *   只有"位移小、按住短、落在容器内"的才算一次拾取，否则视为旋转/缩放；
 * - 相机**不锁**：CC 的点拾取对话框开着时同样能继续转/缩放/平移，转个角度再拾下一对
 *   是这条工作流的常态（同名点常分布在两侧不同部位）；
 * - 退出模式 → 卸监听、还原光标。
 *
 * 与测量的唯一实质差异是**拾取路由（严格 2 选）**：命中点云必须是进入模式时快照的两个
 * 目标之一（`alignStore.targetEntityIds`），命中别的实体**不记**、只提示一次——这是"选第三片
 * 云来拾取"这类误操作的落点；点本身交由 alignStore.addPick 按 entityId 分到两侧拾取集。
 *
 * 拾取坐标用 `hit.local`（**显示坐标** = 原始坐标 − 全局基准点）：它与点云 position 缓冲
 * 同一坐标系，也正是配准变换作用的坐标系（Group 的基准 rotation.x = -π/2 不在里面）。
 * LOD 显示层命中时 `chunkIndex` 是哨兵 -1，无妨——解算只用坐标，索引仅作来源记录。
 */

/** 判定"这是旋转/误触、不是拾取"的最大拖拽距离（像素，同测量/分割）。 */
const CLICK_MAX_DRAG_PX = 4
/** 判定"这是旋转、不是拾取"的最长按住时长（毫秒，同 CC 的点击阈值）。 */
const CLICK_MAX_PRESS_MS = 200

export function useAlignInteraction(container: Ref<HTMLElement | null>) {
  const { active, targetEntityIds, addPick } = useAlignStore()
  const { getViewer } = useViewerStore()
  const { log } = useConsoleStore()

  /* ---------- 点击 vs 拖拽 ---------- */

  let pressed = false
  let moved = false
  let downX = 0
  let downY = 0
  let downTime = 0
  /** "点到非目标点云"的提示只报一次（连点几下不该刷屏），下次成功拾取后复位。 */
  let hintedForeign = false

  /** 在给定 NDC 处拾取一个顶点并路由进 store；落空则静默返回。 */
  function doPick(ndc: THREE.Vector2, cssHeightPx: number) {
    const viewer = getViewer()
    if (!viewer) return
    const candidates = collectCandidates(usePointCloudStore().getVisibleTargets())
    if (candidates.length === 0) return
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, viewer.camera)
    const hit = pickVertex(raycaster, toViewerCamera(viewer.camera), candidates, cssHeightPx)
    if (!hit) return

    if (!targetEntityIds.value.includes(hit.entityId)) {
      if (!hintedForeign) {
        hintedForeign = true
        log('Registration', '点到了非目标点云：请在对齐的两个点云上拾取（其余点云已被忽略）')
      }
      return
    }
    hintedForeign = false
    addPick({
      entityId: hit.entityId,
      chunkIndex: hit.chunkIndex,
      vertexIndex: hit.vertexIndex,
      x: hit.local.x,
      y: hit.local.y,
      z: hit.local.z,
    })
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
    hintedForeign = false
  }

  /* ---------- 生命周期 ---------- */

  watch(active, (act) => {
    if (act) {
      const viewer = getViewer()
      if (!viewer) return
      attachListeners(viewer)
    } else {
      detachListeners()
    }
  })

  // 目标实体在会话中被删除/分割/合并（id 消失）→ 退出模式并告知：拾取坐标与顶点索引
  // 都绑在旧几何体上，继续留着只会解出一个指向不存在点云的变换
  const getAllEntities = () => useSceneStore().getAllEntities()
  watch(
    () =>
      getAllEntities()
        .map((e) => e.id)
        .join(','),
    () => {
      if (!active.value) return
      const ids = new Set(getAllEntities().map((e) => e.id))
      if (targetEntityIds.value.some((id) => !ids.has(id))) {
        useAlignStore().exitAlign(false)
        log('Registration', '目标点云已删除或被替换，点对对齐已退出')
      }
    }
  )
}
