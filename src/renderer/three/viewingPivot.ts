import * as THREE from 'three'
import { DEFAULT_PIVOT_VISIBILITY, type PivotVisibility } from '../utils/pivotVisibility'
import {
  PIVOT_BALL_RADIUS_PX,
  pivotRingRadiusPx,
  worldPerPixelOrtho,
  worldPerPixelPerspective,
} from '../utils/viewScale'

/**
 * 旋转中心（pivot = controls.target）的可见符号，仿 CloudCompare drawPivot。
 *
 * CC 出处：CloudCompare-master libs/qCC_glWindow/src/ccGLWindowInterface.cpp
 * `drawPivot()`（6962 行起），本文件逐项对齐：
 *  - 黄色小球（ccColor::yellow，本仓库 MEASURE_COLOR 同款 #ffd400）；
 *  - 三个正交单位圆环，64 段闭合线（`glDrawUnitCircle`，6936 行），法向分别是
 *    X/Y/Z（CC 的 dimX=(dim+1)%3、dimY=(dimX+1)%3 生成式），颜色红/绿/蓝
 *    （与 viewOverlays.ts 右下角轴向同一套色），alpha 0.6、线宽 2；
 *  - 每个环再画一条沿自身法向的 −1→+1 直径线（同环色）。
 *
 * 屏幕恒定尺寸：CC 的 `symbolRadius = 0.8 × min(w,h)/2` 像素（常量在 77 行），
 * 再乘 `computeActualPixelSize()` 换成世界长度。这里用同一套换算，只是换成本仓库
 * 已有的 utils/viewScale.ts（worldPerPixel*，与测量拾取共用本源）。
 *
 * 两个有意与 CC 不同的实现细节：
 *  - **球用独立缩放而非改几何体**。CC 把 `ccSphere(10.0/symbolRadius)` 编进 display
 *    list 缓存，视口尺寸变化后球的实际像素半径就不再跟踪（缓存不会重建）；这里给球
 *    一个与 group 无关的缩放（BALL_RADIUS_PX / 环半径比），resize 时无需重建几何体。
 *  - **前景绘制改用 depthTest:false + renderOrder**。CC 走 CC_DRAW_FOREGROUND 的
 *    固定管线开关；three 里等价手段就是关深度测试 + 排在点云之后（点云是不透明
 *    PointsMaterial、renderOrder 默认 0，球 renderOrder 998 故画在其后且不写深度）。
 *    环与线是 transparent 材质，three 的透明趟天然排在所有不透明物体之后，于是
 *    得到 CC 的层序：点云 → 球 → 环/线（环压在球上）。
 *
 * 三处与 CC 的已知差异（都是 three/WebGL 的固有限制，不是遗漏）：
 *  - **线宽恒 1px**。CC 用 glLineWidth(2.0) 画环；WebGL 的 LineBasicMaterial.linewidth
 *    被驱动忽略，恒为 1px——本仓库其他线状覆盖物（测量连线等）同样是这条已知限制。
 *  - **平移会带走旋转中心**。CC 的 pivot 是固定的世界点，平移相机时它不动（甚至会移出
 *    画面）；本仓库的 pivot 就是 controls.target，而 target 同时是 OrbitControls 的
 *    平移锚点，故平移视图时符号跟着走。这是绕 target 旋转的架构所决定的，无法两全。
 *  - **换旋转中心必然移动画面**（见 engine.setPivot 的注释）。
 *
 * 坐标系：环对齐的是**显示空间**的 X/Y/Z 轴（点云 Group 带 rotation.x=-π/2 把数据
 * 从 Z-up 转到 Y-up），与右下角轴向指示器一致。
 *
 * 只在 object-centered（绕 controls.target 旋转）语义下有意义——本应用恒为
 * object-centered（透视/正射双相机都绕 target），故无需 CC 的那层模式判断。
 */

/** CC 的 64 段单位圆（glDrawUnitCircle 的 steps 默认值）。 */
const RING_STEPS = 64

/** 球色 = ccColor::yellow（本仓库 measure.ts 的 MEASURE_COLOR 同款）。 */
const BALL_COLOR = 0xffd400

/** X/Y/Z 环与直径线的颜色，与 viewOverlays.ts 右下角轴向同一套。 */
const AXIS_COLORS = [0xff0000, 0x00ff00, 0x0000ff] as const

/** 环/线的透明度（CC c_alpha = MAX × 0.6）。 */
const RING_OPACITY = 0.6

/** 球排在点云（renderOrder 0）之后、测量标记（999）之前。 */
const BALL_RENDER_ORDER = 998
/** 环与直径线（透明趟最后画，压在球上）。 */
const RING_RENDER_ORDER = 999

/** 旋转中心符号实例。 */
export interface ViewingPivot {
  /** 设置三档可见性（CC setPivotVisibility）。下一帧生效。 */
  setVisibility(mode: PivotVisibility): void
  /**
   * 拖动中标记（左键按下 true / 松开 false）。
   * 仅 'onMove' 档有意义，等价于 CC 旋转时 showPivotSymbol(true)、
   * 松开时回落为 `visibility == ALWAYS_SHOW`（行 6697 / 6755）。
   */
  setDragging(dragging: boolean): void
  /**
   * 每帧刷新位置与屏幕恒定尺寸。
   * 必须在 renderer.render **之前**调用（只依赖相机位置与容器尺寸，不依赖
   * matrixWorldInverse；放在 render 之后会让 3D 物体滞后一帧）。
   */
  update(camera: THREE.Camera, cssWidthPx: number, cssHeightPx: number, pivot: THREE.Vector3): void
  dispose(): void
}

/** 单位圆环：法向为 axis（0=X/1=Y/2=Z），顶点落在垂直该轴的两基轴上（CC 生成式）。 */
function buildRing(axis: number): THREE.BufferGeometry {
  const dimX = (axis + 1) % 3
  const dimY = (dimX + 1) % 3
  const positions = new Float32Array(RING_STEPS * 3)
  for (let i = 0; i < RING_STEPS; i++) {
    const theta = (2 * Math.PI * i) / RING_STEPS
    positions[i * 3 + dimX] = Math.cos(theta)
    positions[i * 3 + dimY] = Math.sin(theta)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}

/** 沿 axis（0=X/1=Y/2=Z）的 −1→+1 直径线，穿过对应环的圆心、垂直于环面。 */
function buildAxisLine(axis: number): THREE.BufferGeometry {
  const positions = new Float32Array(6)
  positions[axis] = -1
  positions[3 + axis] = 1
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}

/**
 * 建一个挂在 scene 下的旋转中心符号，返回其控制接口。
 *
 * 位置由 update 每帧写入（不在构造期定死）；几何体按单位圆建一次，实际屏幕尺寸
 * 全靠每帧的 group/ball 缩放。
 */
export function createViewingPivot(scene: THREE.Scene): ViewingPivot {
  const group = new THREE.Group()
  group.name = 'viewingPivot'
  // 常驻但默认不可见（默认档 onMove，未拖动时不画）——与 CC 默认一致
  group.visible = false

  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []

  // 黄色小球：用 Lambert 而非 Basic——CC 强制给球开光照（drawPivot 里的
  // glEnableSunLight()），场景已有 AmbientLight + DirectionalLight，开箱即有立体感
  const ballGeometry = new THREE.SphereGeometry(1, 16, 12)
  const ballMaterial = new THREE.MeshLambertMaterial({
    color: BALL_COLOR,
    depthTest: false, // 压在最前（CC CC_DRAW_FOREGROUND）
    depthWrite: false, // 不写深度，免得影响后续绘制
  })
  geometries.push(ballGeometry)
  materials.push(ballMaterial)
  const ball = new THREE.Mesh(ballGeometry, ballMaterial)
  ball.frustumCulled = false
  ball.renderOrder = BALL_RENDER_ORDER
  group.add(ball)

  for (let axis = 0; axis < 3; axis++) {
    const material = new THREE.LineBasicMaterial({
      color: AXIS_COLORS[axis],
      transparent: true,
      opacity: RING_OPACITY,
      depthTest: false,
      depthWrite: false,
    })
    materials.push(material)

    const ringGeometry = buildRing(axis)
    geometries.push(ringGeometry)
    const ring = new THREE.LineLoop(ringGeometry, material)
    ring.frustumCulled = false
    ring.renderOrder = RING_RENDER_ORDER
    group.add(ring)

    const axisGeometry = buildAxisLine(axis)
    geometries.push(axisGeometry)
    const axisLine = new THREE.LineSegments(axisGeometry, material) // 与环共用材质，同色
    axisLine.frustumCulled = false
    axisLine.renderOrder = RING_RENDER_ORDER
    group.add(axisLine)
  }

  scene.add(group)

  let visibility: PivotVisibility = DEFAULT_PIVOT_VISIBILITY
  let dragging = false
  /** 最近一帧的尺寸是否可用（容器已布局、相机未贴住目标）；不可用时一律不画。 */
  let sized = false

  /** 按 可见性档位 × 拖动中 × 尺寸可用 三者的合取刷新 group.visible。 */
  function applyVisible() {
    group.visible = sized && (visibility === 'always' || (visibility === 'onMove' && dragging))
  }

  /** 目标处的"世界单位 / CSS 像素"（透视随深度、正射恒定，见 utils/viewScale.ts）。 */
  function worldPerPixelAt(camera: THREE.Camera, pivot: THREE.Vector3, cssHeightPx: number): number {
    // 判别式照搬 measure.ts 的 pickThresholdWorld：ViewerCamera 是两台相机的联合类型，
    // isXxxCamera 只在各自的具体类型上声明，直接访问联合体会报"属性不存在"
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const cam = camera as THREE.OrthographicCamera
      return worldPerPixelOrtho(cam.top, cam.zoom, cssHeightPx)
    }
    const cam = camera as THREE.PerspectiveCamera
    // OrbitControls 每帧 lookAt(target)，目标恒在画面正中——故欧氏距离
    // 与 CC 取相机系 z 的"焦距深度"等价。钳到 near 是必要的：OrbitControls 默认
    // minDistance=0，相机可以 dollied 到贴上甚至穿过 target，那时深度 → 0、
    // 符号缩放 → 0 并在穿过后翻转。measure.ts 的拾取阈值出于同一原因同样钳 near。
    const depth = Math.max(cam.position.distanceTo(pivot), cam.near)
    return worldPerPixelPerspective(cam.fov, depth, cssHeightPx)
  }

  return {
    setVisibility(mode) {
      visibility = mode
      applyVisible()
    },
    setDragging(value) {
      dragging = value
      applyVisible()
    },
    update(camera, cssWidthPx, cssHeightPx, pivot) {
      group.position.copy(pivot)
      const radiusPx = pivotRingRadiusPx(cssWidthPx, cssHeightPx)
      const wpp = radiusPx > 0 ? worldPerPixelAt(camera, pivot, cssHeightPx) : 0
      // 尺寸非法（容器尚未布局 → 半径 0；相机贴住目标 → wpp 非有限）时整体不画，
      // 否则会把 Infinity/NaN 写进变换矩阵，后续帧的包围球/拾取都会被污染
      sized = radiusPx > 0 && Number.isFinite(wpp) && wpp > 0
      applyVisible()
      if (!sized) return
      group.scale.setScalar(radiusPx * wpp) // 单位环 → 屏幕上 radiusPx 像素
      ball.scale.setScalar(PIVOT_BALL_RADIUS_PX / radiusPx) // 相对 group：球恒 10px 半径
    },
    dispose() {
      scene.remove(group)
      geometries.forEach((g) => g.dispose())
      materials.forEach((m) => m.dispose())
    },
  }
}
