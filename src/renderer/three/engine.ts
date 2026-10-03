import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { computeOrthoBounds, perspectiveDistanceFromOrtho, type ProjectionMode } from '../utils/cameraProjection'
import { VIEW_DIRECTIONS, type ViewName } from '../utils/viewDirections'
import { DEFAULT_PIVOT_VISIBILITY, type PivotVisibility } from '../utils/pivotVisibility'
import { createViewOverlays, type ViewOverlays } from './viewOverlays'
import { createViewingPivot, type ViewingPivot } from './viewingPivot'

/**
 * three.js 引擎封装。
 *
 * 负责渲染器、场景、相机、轨道控制的初始化，
 * 以及尺寸自适应（ResizeObserver，覆盖窗口缩放与分隔条拖拽）和资源释放。
 * 点云数据的加载与显示由调用方通过 scene 接口完成。
 *
 * 相机支持透视 / 正射两种投影（仿 CloudCompare 的投影切换）。两相机并存，
 * camera 访问器返回当前激活的那一台，消费方（分割、取景等）用时现取即可
 * 同时兼容两种投影；切换数学见 utils/cameraProjection.ts——以 controls.target
 * 为锚，保证目标平面画面不跳变（更近/更远内容的视差差异属投影本质，CloudCompare 亦然）。
 *
 * controls.target 同时是**旋转中心**，其可见符号（黄球 + 三个正交彩环，仿 CC
 * drawPivot）由 three/viewingPivot.ts 提供，本文件负责每帧驱动与拖动显隐。
 */

/**
 * 每帧任务的上下文（见 addFrameTask）。
 * 相机与视口尺寸在任务执行前已是最新值——任务的插入点是
 * `controls.update()` 之后、`renderer.render()` 之前。
 */
export interface FrameContext {
  /** 当前激活相机（透视/正射之一）。 */
  camera: THREE.Camera
  /** 轨道控制器（读 controls.target = 旋转中心）。 */
  controls: OrbitControls
  /** 视口 CSS 像素宽 / 高（视锥与屏幕尺寸判据用）。 */
  width: number
  height: number
  /** 距上一帧的毫秒数（首帧为 0）。 */
  delta: number
}

/** 每帧任务（见 addFrameTask）。返回值为是否需要重绘下一帧的信号由 requestRender 表达。 */
export type FrameTask = (ctx: FrameContext) => void

/** 渲染统计（getRenderStats；直接读 renderer.info，用于调试与性能验收）。 */
export interface RenderStats {
  /** 本帧实际绘制的点数。 */
  points: number
  /** 本帧的 draw call 数。 */
  calls: number
  /** 累计渲染帧数。 */
  frame: number
  /** 是否还有待执行的帧任务。 */
  hasFrameTasks: boolean
}

export interface ThreeViewer {
  scene: THREE.Scene // 3D 场景（所有物体的容器）
  /** 当前激活相机（透视/正射之一，随投影切换，只读访问器） */
  camera: THREE.Camera
  /** 当前投影模式（只读访问器） */
  projection: ProjectionMode
  controls: OrbitControls // 轨道控制器（鼠标交互旋转/缩放；随切换换绑到激活相机）
  domElement: HTMLCanvasElement // 渲染 canvas（分割绘制等交互层挂鼠标监听用）
  /** 右下角浮层（轴向/标尺）；模态交互层可用 addScreenLayer 追加每帧屏幕层（如测量标签） */
  overlays: ViewOverlays
  /**
   * 注册每帧任务，返回注销函数。
   *
   * 执行时机是 `controls.update()` 之后、`renderer.render()` 之前——需要"本帧渲染前
   * 把缓冲填好"的逻辑（如 LOD 填充）必须走这个钩子，直接写 rAF 会与引擎的渲染顺序错位。
   * 任务**无条件每帧执行**（即便当前不需要重绘），因为任务本身可能正在产生新数据；
   * 任务填完数据后调 requestRender() 才会真正重绘。
   */
  addFrameTask: (task: FrameTask) => () => void
  /**
   * 请求重绘一帧（幂等，可重复调用）。
   *
   * 引擎按需渲染：静止时不空转重绘。自动置脏的来源只有三类——
   * 相机变化（OrbitControls 的 'change'）、视口尺寸变化、引擎自身的 API
   * （setProjection / setView / fitView / setPivot / resetPivot / setPivotVisibility）。
   * **其余一切直接写给 three 对象的改动都必须由写入方调用本方法**：three 没有变更
   * 通知，可见性翻转、attribute 换装、material.needsUpdate、scene.add/remove 都侦测不到。
   * 仓库内这些写入方都收敛在 pointcloudStore 里（各写入点都有注释标注）。
   * 新增任何直接改 three 对象的代码时，请一并补上 requestRender()，否则画面上
   * 停在旧状态。顺带一提：resize 后画布会被清空，故 resize 内部也会置脏。
   */
  requestRender: () => void
  /** 视口 CSS 像素尺寸（LOD 预算换算与屏幕尺寸判据用）。 */
  getViewportSize: () => { width: number; height: number }
  /** 渲染统计（调试与性能验收用）。 */
  getRenderStats: () => RenderStats
  /** 切换投影模式；目标点、相机方位、目标平面可见范围保持不变 */
  setProjection: (mode: ProjectionMode) => void
  /** 切到标准视角（前/后/左/右/上/下）：保持 target 与距离，方位约定见 viewDirections.ts */
  setView: (view: ViewName) => void
  /**
   * 把视图对准世界空间的 `center`、取景半径 radius 的点云（透视/正射下等价取景）。
   * `center` 省略即原点（= 显示坐标的基准点），首块加载走这个默认；
   * `View ▸ Zoom to fit` 传入实体包围盒中心，见 pointcloudStore.fitViewTo。
   */
  fitView: (radius: number, center?: THREE.Vector3) => void
  /** 旋转中心符号的可见性（只读访问器，见 viewingPivot.ts） */
  readonly pivotVisibility: PivotVisibility
  /** 设置旋转中心符号可见性；状态镜像到 viewerStore，改这里要同步改那里 */
  setPivotVisibility: (mode: PivotVisibility) => void
  /** 把旋转中心设到世界点 P（两台相机同步平移，朝向与缩放不变，见实现注释） */
  setPivot: (p: THREE.Vector3) => void
  /** 旋转中心复位到原点（点云的显示基准点），走 setPivot 同一路径 */
  resetPivot: () => void
  dispose: () => void // 资源释放方法
}

// 创建 3D 视图引擎实例
export function createViewer(container: HTMLElement): ThreeViewer {
  /** fitView 的默认取景中心（原点 = 显示坐标的基准点）。**只读常量，任何路径都不得改写它**。 */
  const ORIGIN = new THREE.Vector3(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({ antialias: true }) // 创建 WebGL 渲染器，开启抗锯齿
  renderer.setPixelRatio(window.devicePixelRatio) // 适配高分屏（Retina/4K 不模糊）
  container.appendChild(renderer.domElement) // 把渲染的 <canvas> 插入到 DOM 容器中

  // 背景改为 CloudCompare 风格"上深蓝→下黑"纵向渐变：白色点云在原来的白底
  // （--md-surface-container）上看不清，深色渐变下对比度好得多。端色取自 CC
  // 源码默认值——顶色 ccColorTypes.h 的 defaultBkgColor (10,102,151)，底 = 文字
  // 色取反（CC 默认文字白 → 黑），想调观感只改下面两个常量即可。
  const BG_TOP = '#0a6697'
  const BG_BOTTOM = '#000000'
  const gradientCanvas = document.createElement('canvas')
  gradientCanvas.width = 2
  gradientCanvas.height = 256
  const ctx = gradientCanvas.getContext('2d')
  if (ctx) {
    const ramp = ctx.createLinearGradient(0, 0, 0, gradientCanvas.height)
    ramp.addColorStop(0, BG_TOP) // 画布顶 = 视口顶（three 以 v=1 采样画布首行）
    ramp.addColorStop(1, BG_BOTTOM)
    ctx.fillStyle = ramp
    ctx.fillRect(0, 0, gradientCanvas.width, gradientCanvas.height)
  }

  const scene = new THREE.Scene()
  // scene.background 直接赋纹理会被 three 拉伸铺满整个视口（固定于屏幕，不随相机转）
  const bgTexture = new THREE.CanvasTexture(gradientCanvas)
  bgTexture.colorSpace = THREE.SRGBColorSpace // 画布为 sRGB 编码，需标记后经渲染管线还原端色
  bgTexture.minFilter = THREE.LinearFilter
  scene.background = bgTexture

  // 透视与正射相机并存，切换时互相同步位置/朝向/取景范围
  const perspCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000)
  perspCamera.position.set(12, 10, 12)
  // near/far 与透视相机同值，保证两种投影下深度带一致
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000)
  orthoCamera.position.copy(perspCamera.position)
  orthoCamera.quaternion.copy(perspCamera.quaternion)

  // 默认正射投影（2026-09 起，仿 CloudCompare 默认观感 + 分割框选所见即所得）。
  // 启动 bounds 按初始机位距离换算（见 controls 之后的 applyOrthoBounds 调用），
  // 保证与"先透视再切换"的画面等价；运行中切投影见 setProjection。
  let projection: ProjectionMode = 'orthographic'
  let activeCamera: THREE.Camera = orthoCamera
  let aspect = 1 // 画布宽高比（resize 维护，切换/取景换算正射 bounds 用）
  let cssWidth = 0 // 容器 CSS 像素宽（resize 维护，右下角浮层每帧更新用）
  let cssHeight = 0 // 容器 CSS 像素高
  let fitDistance = 0 // 最近一次 fitView 的相机-目标距离（视角切换距离退化时的兜底）

  // ── 按需渲染 ────────────────────────────────────────────────────────────
  // 静止时不再空转重绘（1 亿点场景下每帧重绘就是几百毫秒的 GPU 白烧）。置脏来源见
  // ThreeViewer.requestRender 的注释：相机变化、resize、引擎 API 自动置脏；
  // **其余任何直接写给 three 对象的改动都要由写入方显式调 requestRender()**。
  let needsRender = true // 首帧必须画
  let lastFrameTime = 0
  const frameTasks = new Set<FrameTask>()

  function requestRender() {
    needsRender = true
  }

  // 轨道控制绑定透视相机构造；切换时换绑 object 到激活相机（r185 事件处理与
  // update() 均在运行时读取 object 并按 isOrthographicCamera 分支，无构造期闭包）。
  const controls = new OrbitControls(perspCamera as THREE.Camera, renderer.domElement)
  controls.enableDamping = false // 关闭惯性阻尼（OrbitControls 默认即关）
  // 显式钉死 zoomToCursor=false（OrbitControls 默认值，这里写出来是为了钉住不变量）：
  // 它在 r185 的 onMouseWheel 分支里会**改写 controls.target**（OrbitControls.js:806），
  // 一旦有人打开，滚轮缩放就会静默搬走旋转中心、让旋转中心符号与轨道锚点脱钩。
  controls.zoomToCursor = false
  // 默认正射：轨道控制直接绑正射相机，并按初始透视机位距离换算 bounds，
  // 首帧画面与"旧默认透视"等价（applyOrthoBounds 为函数声明，此处可前向引用）
  controls.object = orthoCamera
  applyOrthoBounds(perspCamera.position.distanceTo(controls.target))

  // 所有经引擎 API 的相机变更（setProjection / setView / fitView / setPivot）最终都走到
  // controls.update()，而它会比对位置/朝向/zoom/target 并在确有变化时派发 'change'——
  // 因此这一处监听同时覆盖了用户拖动与程序化改相机两条路。唯一例外是 setPivotVisibility
  // （只翻符号可见性、相机不动，不会派发），它在自己函数里单独置脏。
  controls.addEventListener('change', requestRender)

  // 基础灯光，为后续实体渲染预留
  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const sun = new THREE.DirectionalLight(0xffffff, 0.8)
  sun.position.set(10, 20, 10)
  scene.add(sun)

  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    aspect = width / height
    cssWidth = width
    cssHeight = height
    renderer.setSize(width, height)
    // setSize 会重建绘制缓冲，不重绘画布就是空白
    needsRender = true
    // 透视相机始终同步宽高比；正射激活时仅水平范围随宽高比伸缩（垂直保持进入时取值）
    perspCamera.aspect = aspect
    perspCamera.updateProjectionMatrix()
    if (projection === 'orthographic') {
      orthoCamera.left = -orthoCamera.top * aspect
      orthoCamera.right = orthoCamera.top * aspect
    }
    orthoCamera.updateProjectionMatrix()
  }

  /** 按当前透视参数把正交相机调成"目标平面画面等价"（top = d·tan(fov/2)、zoom=1）。 */
  function applyOrthoBounds(distance: number) {
    const b = computeOrthoBounds(perspCamera.fov, distance, aspect)
    orthoCamera.left = b.left
    orthoCamera.right = b.right
    orthoCamera.top = b.top
    orthoCamera.bottom = b.bottom
    orthoCamera.zoom = 1
    orthoCamera.updateProjectionMatrix()
  }

  /**
   * 切换投影模式。
   * 透视 → 正射：按当前相机到 target 的距离换算正交 bounds，zoom 复位 1；
   * 正射 → 透视：正交内滚轮只改 zoom，zoom 即"相对进入时刻的缩放"，
   * 反推等价距离 d' = top/(zoom·tanHalf) 还原透视位置。
   */
  function setProjection(mode: ProjectionMode) {
    if (mode === projection) return
    if (mode === 'orthographic') {
      const distance = perspCamera.position.distanceTo(controls.target)
      if (distance <= 0) return // 相机贴在 target 上时换算无意义，防御
      applyOrthoBounds(distance)
      orthoCamera.position.copy(perspCamera.position)
      orthoCamera.quaternion.copy(perspCamera.quaternion)
      activeCamera = orthoCamera
      projection = 'orthographic'
    } else {
      const direction = new THREE.Vector3().subVectors(orthoCamera.position, controls.target)
      const distance = direction.length()
      if (distance <= 0) return
      direction.normalize()
      let d = perspectiveDistanceFromOrtho(orthoCamera.top, perspCamera.fov, orthoCamera.zoom)
      if (!Number.isFinite(d) || d <= 0) d = distance // 非法 zoom 兜底为当前距离
      perspCamera.position.copy(controls.target).addScaledVector(direction, d)
      perspCamera.quaternion.copy(orthoCamera.quaternion)
      perspCamera.updateProjectionMatrix()
      activeCamera = perspCamera
      projection = 'perspective'
    }
    // 先对齐姿态再换绑，最后 update()（会重新 lookAt target），视图保持连续
    controls.object = activeCamera
    controls.update()
  }

  /**
   * 对准世界点 `center` 处的点云（首块点云加载后取景 = 原点；Zoom to fit = 实体中心）。
   * 姿态沿用原 fitCamera 的透视参数（相对 center 偏移 1.5r,1.2r,1.5r）；正射激活时
   * 按同一距离换算 bounds，保证两种投影下取景等价。
   *
   * 注意 `fitView` 会**连 `controls.target` 一起搬**（它是旋转中心）：只挪相机不挪
   * target 的话，取景中心永远被拉回原点，分割出来的子实体（中心离原点几百米）就框不住。
   */
  function fitView(radius: number, center: THREE.Vector3 = ORIGIN) {
    const r = Math.max(radius, 1)
    controls.target.copy(center)
    perspCamera.position.set(center.x + r * 1.5, center.y + r * 1.2, center.z + r * 1.5)
    fitDistance = perspCamera.position.distanceTo(controls.target)
    if (projection === 'orthographic') {
      applyOrthoBounds(perspCamera.position.distanceTo(controls.target))
      orthoCamera.position.copy(perspCamera.position)
      orthoCamera.quaternion.copy(perspCamera.quaternion)
    }
    controls.update()
  }

  /**
   * 切到标准视角（前/后/左/右/上/下）：相机绕 controls.target 转到该方位，
   * 距离保持不变（保留当前缩放语义，仿 CloudCompare 六向键）；正射激活时
   * 保留可视范围与 zoom，只换机位。距离退化（相机贴 target）时按最近一次
   * fitView 距离兜底，从未取景则退回初始机位距离，保证六个方向都能看到场景。
   *
   * 姿态不手动 lookAt：只摆正双相机位置后交给 controls.update() 依位置推导
   * （与 fitView 同款约定）。上/下视时视线与 up 平行，lookAt 的退化由
   * OrbitControls 内部 makeSafe() 微偏极角消化，不会产生 NaN。
   */
  function setView(view: ViewName) {
    const dir = VIEW_DIRECTIONS[view]
    let distance = activeCamera.position.distanceTo(controls.target)
    if (distance <= 1e-6) distance = fitDistance > 0 ? fitDistance : Math.hypot(12, 10, 12)
    const position = new THREE.Vector3()
      .copy(controls.target)
      .addScaledVector(new THREE.Vector3(dir.x, dir.y, dir.z), distance)
    perspCamera.position.copy(position)
    if (projection === 'orthographic') {
      orthoCamera.position.copy(position)
      orthoCamera.quaternion.copy(perspCamera.quaternion)
    }
    controls.update()
  }

  /**
   * 把旋转中心设到世界点 P，**同时把两台相机平移同一个位移**，保证朝向与缩放完全不变。
   *
   * 为什么必须一起搬相机：OrbitControls 的 target 同时是"看向的点"，update() 每帧
   * `lookAt(target)` 且 `position = target + (position − target)`（后者的和式恰好相消，
   * 相机位置不动）。所以只改 target 会变成**相机原地转头**——正射下整个画面被"转"
   * 过去，而不是平移过去。
   *
   * CC 的做法不同：它的旋转中心与相机看向的点是两个独立量（ccGLWindowInterface.cpp:1403
   * setPivotPoint(P, autoUpdateCameraPos=true) 搬相机中心做补偿），换 pivot 时画面
   * 可以纹丝不动。本仓库绕不开 target = 看向点这一条，故只能二选一：原地转头（画面
   * 旋转）还是平移取景（画面平移）。这里选**平移**——朝向、缩放、相机-目标距离都原样
   * 保留，被设为中心的那个点落到画面正中，是两者里唯一不丢失视图状态的做法。
   *
   * 两台相机都要搬：setProjection 是从"当前非激活的那台相机"复制位置与朝向的
   * （见上面的 setProjection），只搬激活的那台会让下一次切投影跳回旧位置。
   */
  function setPivot(p: THREE.Vector3) {
    const delta = new THREE.Vector3().subVectors(p, controls.target)
    if (delta.lengthSq() === 0) return
    controls.target.add(delta)
    perspCamera.position.add(delta)
    orthoCamera.position.add(delta)
    controls.update()
  }

  /**
   * 旋转中心复位到原点（= 点云的显示基准点，见 pointcloudStore 的 basePoint）。
   * 走 setPivot 的同一路径（含相机平移），否则相机会原地转头。
   * 没有这个出口的话，双击把旋转中心设到远处后就再也回不来了——原点周围若恰好
   * 没有点，双击拾取无从落点。
   */
  function resetPivot() {
    setPivot(new THREE.Vector3(0, 0, 0))
  }

  // 右下角浮层：动态 XYZ 轴向 + 缩放距离标尺（仿 CloudCompare）。2026-09 起
  // 取代原先场景内的网格地面 + 坐标轴（AxesHelper/GridHelper 已移除——CC 的
  // 轴向本就画在视口角上而非场景原点）。轴向每帧随相机姿态更新，标尺仅正射
  // 模式显示；均不参与场景，dispose 时随实例释放。
  const overlays = createViewOverlays(container)

  // 旋转中心（controls.target）的可见符号，仿 CC drawPivot。默认档取自 utils
  // （onMove，CC 同款）：只在拖动旋转时浮现，松手即隐。
  let pivotVisibility: PivotVisibility = DEFAULT_PIVOT_VISIBILITY
  const pivot: ViewingPivot = createViewingPivot(scene)
  pivot.setVisibility(pivotVisibility)

  /**
   * 拖动显隐：CC 只在**旋转**时显示旋转中心，缩放与平移都不显示（见其 drawPivot 的
   * 调用点 —— 旋转分支 showPivotSymbol(true)，松手回落；滚轮/平移路径不碰它）。
   *
   * 判据用左键 pointerdown 而**不是** OrbitControls 的 start/end 事件：后者对旋转、
   * 平移、滚轮都会派发（r185 的 onMouseWheel 先 dispatchEvent(start) 再 dispatchEvent(end)，
   * 同一回调内派发故不会"闪"、只是白做功；而平移确实会点亮符号，与 CC 不符），
   * 且 start 的事件对象里没有按键/手势信息，分不出是哪一种。
   * 左键默认绑定 rotate（OrbitControls 默认 mouseButtons），故 button === 0 即"正在旋转"。
   * controls.enabled 判据不能省：框选绘制期 useSegmentInteraction 会把它置 false，
   * 此时左键不在旋转，不该出符号。
   */
  function onPivotPointerDown(e: PointerEvent) {
    if (e.button === 0 && controls.enabled) {
      pivot.setDragging(true)
      needsRender = true // 符号显隐变了，相机没动，不会派发 'change'
    }
  }
  /** 松手一律回落（ALWAYS 档由 viewingPivot 内部维持可见，无需在这里分档）。 */
  function onPivotPointerUp() {
    pivot.setDragging(false)
    needsRender = true
  }
  renderer.domElement.addEventListener('pointerdown', onPivotPointerDown)
  // pointerup 挂 window：拖出 canvas 再松手也要复位（同 useMeasureInteraction 的约定）
  window.addEventListener('pointerup', onPivotPointerUp)
  window.addEventListener('pointercancel', onPivotPointerUp)

  // 按需渲染的保险丝：窗口最小化/被遮挡时 rAF 停摆，绘制缓冲可能已被回收，
  // 恢复可见或重新聚焦时若恰好没有别的变更，画面会停在空白。这两处各补一次置脏，
  // 代价是一次多余重绘，换掉的是"切回来白屏"这种最难复现、最像崩溃的现象。
  document.addEventListener('visibilitychange', requestRender)
  window.addEventListener('focus', requestRender)

  function setPivotVisibility(mode: PivotVisibility) {
    pivotVisibility = mode
    pivot.setVisibility(mode)
    needsRender = true // 相机没动，controls 不会派发 'change'，需显式置脏
  }

  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()

  function animate(now: number) {
    // controls.update() 必须每帧跑：OrbitControls 的阻尼/惯性靠它推进，且它正是
    // 相机变化的派发点（'change' → requestRender）——跳过它会让按需渲染永不醒来
    controls.update()

    const delta = lastFrameTime === 0 ? 0 : now - lastFrameTime
    lastFrameTime = now

    // 帧任务**无条件每帧执行**，即便本轮不重绘：任务可能正在产数据（LOD 填充），
    // 产完自己会 requestRender()。插入点在 controls.update() 之后、render 之前，
    // 保证任务读到的是最终相机姿态、写入的缓冲当帧即被使用。
    if (frameTasks.size > 0) {
      const ctx: FrameContext = {
        camera: activeCamera,
        controls,
        width: cssWidth,
        height: cssHeight,
        delta,
      }
      for (const task of frameTasks) task(ctx)
    }

    if (needsRender) {
      needsRender = false
      // 旋转中心符号排在 render **之前**：它只依赖相机位置与容器尺寸（不用
      // matrixWorldInverse），放在其后会让 3D 物体滞后一帧——与下面浮层的要求正相反
      pivot.update(activeCamera, cssWidth, cssHeight, controls.target)
      renderer.render(scene, activeCamera)
      // 浮层必须放在 render 之后更新：matrixWorldInverse 此刻才与当前姿态同步，
      // 右下角轴向取它投影世界轴、标尺取正射相机 top/zoom
      overlays.update(activeCamera, cssWidth, cssHeight)
    }
    raf = requestAnimationFrame(animate)
  }
  let raf = requestAnimationFrame(animate)

  return {
    scene,
    get camera(): THREE.Camera {
      return activeCamera
    },
    get projection(): ProjectionMode {
      return projection
    },
    controls,
    domElement: renderer.domElement,
    overlays,
    addFrameTask(task: FrameTask) {
      frameTasks.add(task)
      return () => {
        frameTasks.delete(task)
      }
    },
    requestRender,
    getViewportSize() {
      return { width: cssWidth, height: cssHeight }
    },
    getRenderStats(): RenderStats {
      const info = renderer.info.render
      return { points: info.points, calls: info.calls, frame: info.frame, hasFrameTasks: frameTasks.size > 0 }
    },
    setProjection,
    setView,
    fitView,
    get pivotVisibility(): PivotVisibility {
      return pivotVisibility
    },
    setPivotVisibility,
    setPivot,
    resetPivot,
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      frameTasks.clear()
      // 监听挂在了 window 上（见 onPivotPointerUp），必须显式摘——实例重建
      // （HMR / 组件重挂载）时残留的监听会把新实例的符号一直按在拖动态
      renderer.domElement.removeEventListener('pointerdown', onPivotPointerDown)
      window.removeEventListener('pointerup', onPivotPointerUp)
      window.removeEventListener('pointercancel', onPivotPointerUp)
      document.removeEventListener('visibilitychange', requestRender)
      window.removeEventListener('focus', requestRender)
      pivot.dispose()
      overlays.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
