import * as THREE from 'three'
import type { ThreeViewer, FrameTask } from './engine'
import {
  LOD_FRAME_BUDGET,
  buildChunkViews,
  fillLodFallback,
  fillLodFromIds,
  lodStagingAttributes,
  type LodDisplay,
} from './lodRenderer'
import { flagVisibility, gatherLodPoints, planLodBudget, type LodBudgetEntry, type LodTreeState } from './lodTraversal'

/**
 * LOD 调度器：把"每帧画哪些点"接到引擎的渲染循环上。
 *
 * 状态机（对标 CloudCompare 的 LOD 循环，见 ccGLWindowInterface.cpp:4846-4867）：
 *
 *  - **相机一动就重取，连续运动期间不重取**——CC 在拖动期同样把 LOD 刷新按下不表
 *    （`!m_mouseMoved && !m_mouseButtonPressed` 才排下一次 pass）。于是拖拽的每帧
 *    成本只剩"画上一帧的点集"这一件纯 GPU 的事，这正是不掉帧的关键。判据用
 *    "距上次相机变化 ≥ LOD_REFRESH_IDLE_MS"的**空闲阈值**而非鼠标按键：滚轮缩放
 *    没有按键，慢慢挪鼠标也没有（连续运动里每一帧都在刷新这个计时器）。
 *  - **拖拽降质**：拖拽期内一旦真的取过点（用户中途停顿），预算压到
 *    LOD_DRAG_BUDGET，松手后从那一档逐级翻倍回 LOD_FRAME_BUDGET，每级之间隔
 *    LOD_DENSIFY_PACE_MS（64K → 128K → 256K → 512K，约 200 ms 长满）。预算翻倍时
 *    步长减半（见 lodTraversal 的叶内取点），先前那批点必然还在集合里——画面只增不减，
 *    加密是纯加法。
 *    拖拽期一次都没停顿过的纯点击不会压低预算，故松手后什么都不会发生。
 *  - **可见性标记按相机缓存**（`tree.valid`）：加密的那几帧只重跑配额与取点，
 *    省掉几万次节点测试。
 *
 * 视锥必须换算到**实体 Group 的局部空间**再测：分块几何体的坐标是显示坐标
 * （Z-up），而 Group 带 `rotation.x = -π/2`（见 pointcloudStore 的 buildSplitGroup），
 * 节点立方体的中心/边长与坐标同系。故每个实体的 MVP = 投影 × 视图 × Group.matrixWorld。
 */

/** 空闲阈值（ms）：相机连续运动期间不重取点集（见文件头）。 */
export const LOD_REFRESH_IDLE_MS = 100

/** 加密节奏（ms）：松手后每一档预算之间的间隔。 */
export const LOD_DENSIFY_PACE_MS = 50

/** 拖拽期预算（对齐 CC 的 CC_LOD_RENDER_PASS_LOW = 1<<16 档）。 */
export const LOD_DRAG_BUDGET = 1 << 16

// ---- 模块级单例（引擎同一时刻只有一个，见 viewerStore 的 registerViewer） ----
const displays = new Set<LodDisplay>()
let activeViewer: ThreeViewer | null = null
let detach: (() => void) | null = null

let budget = LOD_FRAME_BUDGET
let dragging = false
let ramping = false
let lastGatherMs = -Infinity
let lastCameraMoveMs = -Infinity

const _mvp = new THREE.Matrix4()
const _frustum = new THREE.Frustum()
// 必须是 Float64：矩阵元素是 double，存进 Float32Array 会被四舍五入，
// 于是"比较缓存值与当前值"变成永真——每帧都被判成相机在动，空闲阈值永远打不开，
// 整个调度器一次都不取点（画面永远停在建立显示层时的兜底取样）
const _signature = new Float64Array(32) // 投影矩阵 16 + 视图矩阵 16
let signatureValid = false

/**
 * 挂上（或换绑）调度器。viewer 为 null 时卸载。
 * 引擎实例由 ThreeView.vue 创建并注册，窗口重建 / HMR 会换新实例，故要幂等。
 */
export function attachLodScheduler(viewer: ThreeViewer | null): void {
  if (viewer === activeViewer) return
  detach?.()
  activeViewer = viewer
  detach = null
  // 换引擎意味着新画布、新相机：签名与节奏状态都从头来（旧引擎的拖拽/加密进度
  // 与它一起作废），否则重挂载后会沿用上一台引擎的档位与计时
  signatureValid = false
  budget = LOD_FRAME_BUDGET
  dragging = false
  ramping = false
  lastGatherMs = -Infinity
  lastCameraMoveMs = -Infinity
  if (!viewer) return

  const offTask = viewer.addFrameTask(makeTick(viewer))
  const onStart = () => {
    dragging = true
  }
  const onEnd = () => {
    dragging = false
    // 判据只看"预算是否被压低过"，不看本次拖拽有没有真取过点：拖拽期一次都没停顿过
    // 的纯点击根本没压低预算（ramping 自然为 false，什么都不会发生）；而在加密途中
    // 手滑点一下则是**接着**加密，不会卡在半粗的档位上。
    ramping = budget < LOD_FRAME_BUDGET
    if (ramping) {
      // 必须主动置脏：最常见的手势是"拖着、中途停下（此时取了点、脏被清掉）、再松手"，
      // 松手后相机不再动、也就再没有东西置脏——不在这里置脏，画面就永远停在拖拽档。
      for (const display of displays) {
        if (display.tree && isRenderable(display)) display.dirty = true
      }
    }
  }
  viewer.controls.addEventListener('start', onStart)
  viewer.controls.addEventListener('end', onEnd)
  detach = () => {
    offTask()
    viewer.controls.removeEventListener('start', onStart)
    viewer.controls.removeEventListener('end', onEnd)
  }
  // 换引擎（重挂载 / HMR）后缓存的可见性标记与视锥都作废，全部重取一遍
  for (const display of displays) invalidateLodDisplay(display)
}

/** 纳管一个显示层（pointcloudStore 建显示层后调用；建立时已填好首帧，故不置脏）。 */
export function trackLodDisplay(display: LodDisplay): void {
  displays.add(display)
}

/** 解除纳管（pointcloudStore 释放显示层时调用；之后不再被调度）。 */
export function untrackLodDisplay(display: LodDisplay): void {
  displays.delete(display)
}

/** 标记显示层需要重取（颜色换装 / 显隐翻转 / 树就绪 / 预览回退结束）。 */
export function invalidateLodDisplay(display: LodDisplay): void {
  display.dirty = true
  // 缓存的可见性标记是按**当时的相机与可见性**算的，两个前提都动了就不能再信
  if (display.tree) display.tree.valid = false
}

export function lodSchedulerDebugState(): { displays: number; budget: number; dragging: boolean; ramping: boolean } {
  return { displays: displays.size, budget, dragging, ramping }
}

/** 显示层当前是否真的会被画出来（自身可见 + 父 Group 可见，见文件头）。 */
function isRenderable(display: LodDisplay): boolean {
  return display.points.visible && (display.points.parent?.visible ?? true)
}

/** 相机签名是否变化（投影矩阵 + 视图矩阵逐元素比较；更新签名并返回结论）。 */
function cameraChanged(camera: THREE.Camera): boolean {
  const p = camera.projectionMatrix.elements
  const v = camera.matrixWorldInverse.elements
  let changed = !signatureValid
  for (let i = 0; i < 16; i++) {
    if (_signature[i] !== p[i]) {
      _signature[i] = p[i]
      changed = true
    }
    if (_signature[i + 16] !== v[i]) {
      _signature[i + 16] = v[i]
      changed = true
    }
  }
  signatureValid = true
  return changed
}

/** 把视锥换到某显示层所属 Group 的局部空间（见文件头注释）。 */
function frustumFor(display: LodDisplay, camera: THREE.Camera): THREE.Frustum {
  // 显示层刚建好、还没被 renderer 画过时 Group 的 matrixWorld 还是旧的，这里强制刷新
  // （updateParents 顺带把 Group 的旋转算进来；只有相机静止后的取点会走到，成本可忽略）
  display.points.updateWorldMatrix(true, false)
  _mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _mvp.multiply(display.points.matrixWorld)
  _frustum.setFromProjectionMatrix(_mvp)
  return _frustum
}

function makeTick(viewer: ThreeViewer): FrameTask {
  return (ctx) => {
    if (displays.size === 0) return
    const now = performance.now()

    // matrixWorldInverse 平时由 renderer.render 刷新；本任务跑在它之前，故自己刷一次
    // （Camera.updateMatrixWorld 内部会同步求逆，见 three/src/cameras/Camera.js）。
    ctx.camera.updateMatrixWorld()
    if (cameraChanged(ctx.camera)) {
      lastCameraMoveMs = now
      for (const display of displays) {
        if (!display.tree || !isRenderable(display)) continue
        display.tree.valid = false
        display.dirty = true
      }
    }

    let dirty = false
    for (const display of displays) {
      if (display.dirty && isRenderable(display)) {
        dirty = true
        break
      }
    }
    if (!dirty) return

    // 连续运动期间不重取：画面用上一帧的点集，拖拽成本只剩 GPU 绘制
    if (now - lastCameraMoveMs < LOD_REFRESH_IDLE_MS) return
    // 加密节奏：预算还没到顶时按 LOD_DENSIFY_PACE_MS 分档推进
    if (ramping && now - lastGatherMs < LOD_DENSIFY_PACE_MS) return

    if (dragging) {
      budget = LOD_DRAG_BUDGET // 拖拽期只画最粗一档
      ramping = false
    }
    gatherAll(viewer, ctx.camera)
    lastGatherMs = now

    if (dragging) {
      // 预算已在上面压到拖拽档；松手时 onEnd 会接手继续加密
    } else if (ramping) {
      // 本帧取的是**涨档前**的预算，故每次涨档后都要再取一轮
      budget = Math.min(LOD_FRAME_BUDGET, Math.max(budget + 1, budget * 2))
      if (budget >= LOD_FRAME_BUDGET) ramping = false
      // 到顶那一档同样要置脏：本帧取的还是上一档（256K）的点，不置脏画面就永远
      // 停在"倒数第二档"的密度上——终点差一半，肉眼看得出来
      for (const display of displays) {
        if (display.tree && isRenderable(display)) display.dirty = true
      }
    }
  }
}

/**
 * 一次全量重取：标记可见性 → 二轮配额 → 取点 → 填缓冲。
 *
 * 取点是**全量重取**而非"在上一帧基础上补点"：采样率只由「可见性 + 配额」决定，
 * 预算变大时结果必然包含先前那批点（画面不会闪），而全量重取让相机变化后的选点
 * 立刻正确——CC 的
 * `displayedPointCount` 跨帧累积是为了配合它的 FBO 不清屏累积绘制，本应用每帧
 * 整屏重画（staging 装的就是"当前该画的全部点"），不需要那份状态。
 */
function gatherAll(viewer: ThreeViewer, camera: THREE.Camera): void {
  const entries: LodBudgetEntry[] = []
  const pending: { display: LodDisplay; tree: LodTreeState }[] = []
  const refills: LodDisplay[] = []

  for (const display of displays) {
    // 隐藏（含预览回退）的显示层不重取：显隐一变由 store 走 invalidateLodDisplay 置脏
    if (!isRenderable(display)) continue
    const wasDirty = display.dirty
    display.dirty = false
    if (!display.tree) {
      // 建树中：等距取样兜底。取样与相机无关，只在真被置脏（换色等）时重填
      if (wasDirty) refills.push(display)
      continue
    }
    if (!display.tree.valid) flagVisibility(display.tree, frustumFor(display, camera))
    entries.push({ visible: display.tree.visiblePoints, capacity: display.capacity, quota: 0 })
    pending.push({ display, tree: display.tree })
  }

  planLodBudget(entries, budget)
  for (let i = 0; i < pending.length; i++) {
    const { display, tree } = pending[i]
    // bufferShift 与随后写进 slotIds 的 id 同批定型（反查器读的是显示层当前的这一份）
    display.bufferShift = tree.result.vertexShift
    const filled = gatherLodPoints(tree, entries[i].quota, display.slotIds)
    fillLodFromIds(display, lodStagingAttributes(display), buildChunkViews(display.geometries), filled)
  }
  for (const display of refills) {
    fillLodFallback(display, lodStagingAttributes(display), buildChunkViews(display.geometries), LOD_FRAME_BUDGET)
  }
  if (pending.length > 0 || refills.length > 0) viewer.requestRender()
}
