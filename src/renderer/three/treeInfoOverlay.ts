import * as THREE from 'three'
import { watch } from 'vue'
import type { ThreeViewer } from './engine'
import { useSceneStore } from '../stores/sceneStore'
import { useTreeInfoStore } from '../stores/treeInfoStore'
import { resolveNormalSelection } from '../stores/normalStore'
import {
  buildMarkerGeometryData,
  collectTreeMarkers,
  type TreeMarkerGeometryData,
  type TreeMarkerItem,
  type TreeMarkerSource,
} from '../utils/treeMarkers'

/**
 * 树木 3D 标记的**装配层**：一个 `LineSegments` 装下全部圈（冠层椭圆 + 胸径圆，逐顶点色），
 * 一个 `Points` 画全部树心，挂在 `viewer.scene` 下的一个 Group 里——**共 2 个 draw call**，
 * 与树的棵数无关（见 `utils/treeMarkers.ts` 的文件头：每棵 3 个对象在千棵级就是 3000 个 draw call，
 * 且挂在实体 Group 下就得在 5 条销毁路径上分别收尾）。
 *
 * 形状仿 `three/planeOverlay.ts` / `cylinderOverlay.ts` / `registrationOverlay.ts`
 * （`createXxx(scene)` 返回带 show/hide/dispose 的实例），同样**不进 engine.ts**。
 *
 * 坐标系：与点云 Group 完全一致——几何直接按**显示坐标**（Z-up）画，再给 Group 加
 * `rotation.x = -π/2` 让 matrixWorld 完成 Z-up → Y-up 转换。`utils/treeMarkers` 已经把
 * `TreeObject` 里的文件原始坐标换算成了显示坐标，故两者天然贴合。
 *
 * 两个实现取舍：
 * - **容量只增不减 + `setDrawRange`**：选中集一变就整批重填，拖动选择时一秒可能几十次；
 *   每次重分配缓冲会一路生产垃圾（同 LOD staging 的取舍）。
 * - **不逐棵建对象**：见上，代价与棵数解耦是这个模块存在的全部理由。
 *
 * 驱动（`attachTreeMarkers`）也在本文件里，照 `three/lodScheduler.ts` 的先例（three/ 文件
 * 自带 store 接线）：`ThreeView.vue` 在 onMounted / onUnmounted 各调一次。
 */

/** 树心点的屏幕尺寸（像素；`sizeAttenuation: false` 下与相机距离无关，同测量/配准标记）。 */
const CENTER_MARKER_PX = 8
/** 覆盖物渲染顺序：压在点云之上（同测量/分割/配准覆盖物的 999）。 */
const OVERLAY_RENDER_ORDER = 999
/** 圈的初始容量（顶点数）：一次 show 至少这么多，之后按需翻倍。 */
const INITIAL_CAPACITY = 256

/** 树木标记可视化实例。 */
export interface TreeInfoOverlay {
  /**
   * 显示这批标记（**整体替换**上一次的内容：少了就收缩 `drawRange`，不留残影）。
   * @warning 调用方**必须**随后 `viewer.requestRender()`（three 无变更通知）
   */
  show(data: TreeMarkerGeometryData): void
  /** 隐藏全部（复用实例，不 dispose——切换档位会反复开关）。调用方同样须 requestRender。 */
  hide(): void
  dispose(): void
}

/**
 * 容量只增不减的图层：`position` + `color` 两个属性同容量，顶点数由 `drawRange` 圈定。
 *
 * 增长时**整块换新几何体并 `dispose()` 旧的**：只换属性的话旧属性缓冲不会被 three 回收
 * （`onGeometryDispose` 只释放当时挂在几何体上的那些），换几何体则连同两个旧缓冲一起交还 GPU。
 */
interface GrowingLayer {
  object: THREE.LineSegments | THREE.Points
  /** 确保容量 ≥ n 个顶点（够就原样返回）。 */
  ensure(n: number): void
  /** 写入 n 个顶点（调用前必须 `ensure(n)`；n = 0 ⇒ 整层隐藏）。 */
  write(positions: Float32Array, colors: Float32Array, n: number): void
}

function createGrowingLayer(kind: 'lines' | 'points', material: THREE.Material): GrowingLayer {
  let capacity = 0
  let geometry = new THREE.BufferGeometry()
  let position = new THREE.BufferAttribute(new Float32Array(0), 3)
  let color = new THREE.BufferAttribute(new Float32Array(0), 3)
  geometry.setAttribute('position', position)
  geometry.setAttribute('color', color)
  geometry.setDrawRange(0, 0)

  const object = kind === 'lines' ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material)
  // 顶点由 drawRange 决定，包围球不随之更新，交给引擎剔除会误剪
  object.frustumCulled = false
  object.renderOrder = OVERLAY_RENDER_ORDER
  object.visible = false

  return {
    object,
    ensure(n) {
      if (n <= capacity) return
      let cap = Math.max(capacity, INITIAL_CAPACITY)
      while (cap < n) cap *= 2
      const next = new THREE.BufferGeometry()
      position = new THREE.BufferAttribute(new Float32Array(cap * 3), 3)
      color = new THREE.BufferAttribute(new Float32Array(cap * 3), 3)
      next.setAttribute('position', position)
      next.setAttribute('color', color)
      next.setDrawRange(0, 0)
      object.geometry = next
      geometry.dispose()
      geometry = next
      capacity = cap
    },
    write(positions, colors, n) {
      if (n > 0) {
        position.array.set(positions)
        color.array.set(colors)
        position.needsUpdate = true
        color.needsUpdate = true
      }
      geometry.setDrawRange(0, n)
      object.visible = n > 0
    },
  }
}

export function createTreeInfoOverlay(scene: THREE.Scene): TreeInfoOverlay {
  const group = new THREE.Group()
  group.name = 'treeInfoOverlay'
  group.visible = false
  // 与点云 Group 同款：数据是 Z-up，几何按显示坐标画，世界变换自动跟上
  group.rotation.x = -Math.PI / 2

  // 圈：不写深度（同点的圈会互相交叠，写深度只会打架），但**要**受深度测试
  // ——圈被树冠/树干挡住才看得出它贴不贴合，全画在最上面反而失去意义
  const ringMaterial = new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false })
  // 树心点：不测深度（它是"这棵树在哪"的锚，必须找得到），屏幕恒定像素
  const centerMaterial = new THREE.PointsMaterial({
    vertexColors: true,
    size: CENTER_MARKER_PX,
    sizeAttenuation: false,
    depthTest: false,
  })

  const rings = createGrowingLayer('lines', ringMaterial)
  const centers = createGrowingLayer('points', centerMaterial)
  group.add(rings.object, centers.object)
  scene.add(group)

  return {
    show(data) {
      rings.ensure(data.ringVertexCount)
      centers.ensure(data.centerVertexCount)
      rings.write(data.ringPositions, data.ringColors, data.ringVertexCount)
      centers.write(data.centerPositions, data.centerColors, data.centerVertexCount)
      group.visible = data.ringVertexCount > 0 || data.centerVertexCount > 0
    },
    hide() {
      group.visible = false
    },
    dispose() {
      scene.remove(group)
      rings.object.geometry.dispose()
      centers.object.geometry.dispose()
      ringMaterial.dispose()
      centerMaterial.dispose()
    },
  }
}

/* ------------------------------ 驱动（模块级单例） ------------------------------ */

let overlay: TreeInfoOverlay | null = null
/** 覆盖物所属的场景：换引擎（HMR / 组件重挂载）时旧场景已作废，须重建。 */
let overlayScene: THREE.Scene | null = null
/** 监听只装一次（**应用级**而非引擎级：换引擎时覆盖物重建，但监听要接着用）。 */
let watching = false
/** 当前挂着的引擎（watch 回调里要用它 requestRender）。 */
let activeViewer: ThreeViewer | null = null

/** 取数：实体清单 + 选中集 + 档位 ⇒ 待画的标记（筛选逻辑全在 utils/treeMarkers）。 */
function collectMarkers(): TreeMarkerItem[] {
  const sceneStore = useSceneStore()
  const sources: TreeMarkerSource[] = sceneStore.getAllEntities().map((e) => ({
    id: e.id,
    visible: e.visible,
    globalShift: e.globalShift,
    treeObject: e.treeObject,
  }))
  const selected = new Set(resolveNormalSelection(sceneStore.selection.value))
  return collectTreeMarkers(sources, selected, useTreeInfoStore().markerMode.value)
}

/**
 * 实体的"身份 + 显隐 + 平移"签名。⚠ **树信息的字段不在里面**：`TreeObject` 是一份整体对象，
 * 逐字段拼串既啰嗦又会漏（漏一个就是"改了没反应、且无报错"，同 pointcloudStore 那条
 * "高程范围必须进签名"的教训）——改树信息统一走 `setEntityTreeObject`，它自增
 * `treeObjectRevision`，故签名里读那一个 ref 就够（见下面的 watch）。
 */
function entitySignature(): string {
  let s = ''
  for (const e of useSceneStore().getAllEntities()) {
    const g = e.globalShift
    s += `${e.id}|${e.visible ? 1 : 0}|${g ? `${g.x},${g.y},${g.z}` : '-'};`
  }
  return s
}

/**
 * watch 的签名：**拼成一个字符串**再比（getter 返回数组的话每次都是新对象，
 * Vue 的 Object.is 比较恒不相等，任何依赖一动都会白重画一遍）。
 */
function watchSignature(): string {
  const sceneStore = useSceneStore()
  return [
    useTreeInfoStore().markerMode.value,
    sceneStore.treeObjectRevision.value, // 树信息被改（见 entitySignature 注释）
    sceneStore.selection.value.map((s) => `${s.type}:${s.id}`).join(','),
    entitySignature(),
  ].join('|')
}

/** 重画一次（收集 → 覆盖物 → 置脏）。数据为空时 `show` 自己会隐藏两层。 */
function refresh(): void {
  if (!overlay || !activeViewer) return
  overlay.show(buildMarkerGeometryData(collectMarkers()))
  activeViewer.requestRender()
}

/**
 * 挂上（或换绑）树木标记。viewer 为 null 时整个卸掉。
 * 引擎实例由 ThreeView.vue 创建，窗口重建 / HMR 会换新实例，故要幂等。
 */
export function attachTreeMarkers(viewer: ThreeViewer | null): void {
  activeViewer = viewer
  if (!watching) {
    watching = true
    watch(watchSignature, refresh)
  }
  if (!viewer) {
    overlay?.dispose()
    overlay = null
    overlayScene = null
    return
  }
  if (overlay && overlayScene !== viewer.scene) {
    // 换引擎：旧场景连同画布一起没了，覆盖物必须重建（否则新场景里什么都画不出来）
    overlay.dispose()
    overlay = null
  }
  if (!overlay) {
    overlay = createTreeInfoOverlay(viewer.scene)
    overlayScene = viewer.scene
  }
  // 首次挂载 / HMR 重挂后立刻刷一次：档位默认是"仅选中的树"，选中集可能早就有了
  refresh()
}

/** 测试与调试：当前覆盖物的挂载状态（不暴露内部对象）。 */
export function treeMarkersDebugState(): { attached: boolean; scene: THREE.Scene | null } {
  return { attached: overlay !== null, scene: overlayScene }
}
