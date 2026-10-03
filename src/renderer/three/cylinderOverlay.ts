import * as THREE from 'three'
import type { RansacCylinderBasis } from '../utils/ransacCylinder'

/**
 * RANSAC 圆柱拟合的线框可视化：两个端面圆 + 轴向连线 + 轴方向箭头。
 *
 * 形状仿 three/planeOverlay.ts（`createXxx(scene)` 返回带 show/hide/dispose 的实例），
 * 同样**不进 engine.ts**——引擎至今无 gizmo，覆盖物一律由各自的 store 直接往 `viewer.scene`
 * 上挂。
 *
 * 坐标系：与点云 Group 完全一致——几何直接按**显示坐标**（Z-up）画，再给 Group 加
 * `rotation.x = -π/2` 让 matrixWorld 完成 Z-up → Y-up 转换。圆柱模型的 c / a / basis 都是
 * 从同一份显示坐标缓冲算出来的，故两者天然贴合，无需任何换算。
 *
 * 关键实现取舍：
 * - **单位线框建一次，每次 show 只写矩阵**：圆柱尺寸跨实体能差几个数量级（直径 2 m 的管道
 *   与直径 0.02 m 的杆件），重建几何体毫无必要。
 * - **线框按 Z 轴建**（不是 three 的 CylinderGeometry 默认 Y 轴）：模型的 basis 是
 *   (u, v, a) 右手系，直接当矩阵的三列即完成「局部 Z → 轴向」的映射，一步旋转都不用写；
 *   用 Y 轴版还得再补一次旋转，平白多一处出错的地方。
 * - **槽位池**：一次拟合可能覆盖多个目标实体，每个都出一圈线框。池按需增长、多余的隐藏。
 */

/** 线框颜色（橙色：黄归旋转中心/测量、紫归框选、青归平面片，避让）。 */
const WIRE_COLOR = 0xff6d00
/** 线框不透明度：够看清贴合关系，又不盖住内点的颜色分布。 */
const WIRE_OPACITY = 0.55
/** 端面圆的段数：48 段在常见窗口尺寸下已看不出多边形。 */
const RING_SEGMENTS = 48
/** 轴向连线数量（沿圆周均布）。 */
const AXIAL_LINES = 8

/** 一圈待显示的圆柱线框。 */
export interface CylinderOverlayItem {
  /** 几何中心（在轴上）。 */
  center: { cx: number; cy: number; cz: number }
  /** 单位轴方向。 */
  axis: { ax: number; ay: number; az: number }
  /** 半径与沿轴半高。 */
  radius: number
  halfHeight: number
  /** 圆柱面上的正交标架（u, v, a）。 */
  basis: RansacCylinderBasis
}

/** 圆柱线框可视化实例。 */
export interface CylinderOverlay {
  /**
   * 显示这批线框（整体替换上一次的内容；多余的槽位隐藏）。
   * @warning 调用方**必须**随后 `viewer.requestRender()`（three 无变更通知）
   */
  show(cylinders: CylinderOverlayItem[]): void
  /** 隐藏全部（复用实例，不 dispose——预览会反复开关）。调用方同样须 requestRender。 */
  hide(): void
  dispose(): void
}

/**
 * 单位线框：半径 1、沿 **Z** 轴半高 1 的空心圆柱（两端各一圈 + 若干轴向连线）。
 * 一对顶点的 LineSegments 表示（three 的 LineLoop 只能画单条闭合线，两圈得两个对象）。
 */
function buildUnitWireCylinder(): THREE.BufferGeometry {
  const positions: number[] = []
  const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
    positions.push(x1, y1, z1, x2, y2, z2)
  }
  // 两圈端圆
  for (const z of [1, -1]) {
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const t0 = (i / RING_SEGMENTS) * Math.PI * 2
      const t1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2
      push(Math.cos(t0), Math.sin(t0), z, Math.cos(t1), Math.sin(t1), z)
    }
  }
  // 轴向连线
  for (let i = 0; i < AXIAL_LINES; i++) {
    const t = (i / AXIAL_LINES) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    push(c, s, 1, c, s, -1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  return geometry
}

/** 一个槽位：线框 + 轴方向箭头。 */
interface Slot {
  wire: THREE.LineSegments
  arrow: THREE.ArrowHelper
}

export function createCylinderOverlay(scene: THREE.Scene): CylinderOverlay {
  const group = new THREE.Group()
  group.name = 'ransacCylinderOverlay'
  group.visible = false
  // 与点云 Group 同款：数据是 Z-up，几何按显示坐标画，世界变换自动跟上
  group.rotation.x = -Math.PI / 2

  const unitWire = buildUnitWireCylinder()
  const wireMaterial = new THREE.LineBasicMaterial({
    color: WIRE_COLOR,
    transparent: true,
    opacity: WIRE_OPACITY,
    depthWrite: false,
  })

  const slots: Slot[] = []

  /** 取第 i 个槽位，不够就新建（几何共享，材质共享，只有箭头自建）。 */
  function slotAt(i: number): Slot {
    const existing = slots[i]
    if (existing) return existing
    const wire = new THREE.LineSegments(unitWire, wireMaterial)
    // 尺寸由矩阵决定，包围球不随矩阵更新，交给引擎剔除会误剪
    wire.frustumCulled = false
    wire.matrixAutoUpdate = false // 矩阵由 show() 直接写
    group.add(wire)

    // 箭头从几何中心指向轴方向一侧；长度随圆柱尺寸走（见 show）
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, WIRE_COLOR)
    arrow.frustumCulled = false
    group.add(arrow)

    const slot: Slot = { wire, arrow }
    slots.push(slot)
    return slot
  }

  /** 复用对象，避免每次 show 分配（预览期间会反复调用）。 */
  const basis = new THREE.Matrix4()
  const axisU = new THREE.Vector3()
  const axisV = new THREE.Vector3()
  const axisA = new THREE.Vector3()
  const center = new THREE.Vector3()
  const scaleVec = new THREE.Vector3()

  return {
    show(cylinders) {
      cylinders.forEach((item, i) => {
        const slot = slotAt(i)
        center.set(item.center.cx, item.center.cy, item.center.cz)
        axisU.set(item.basis.ux, item.basis.uy, item.basis.uz)
        axisV.set(item.basis.vx, item.basis.vy, item.basis.vz)
        axisA.set(item.axis.ax, item.axis.ay, item.axis.az)
        // 半径/半高可能为 0（内点退化）——钳一个极小值，否则矩阵奇异、线框塌成一点
        const r = Math.max(item.radius, 1e-6)
        const h = Math.max(item.halfHeight, 1e-6)
        // [u v a | c] · diag(r, r, h)：右乘 scale 只缩列（基向量）不动平移
        basis.makeBasis(axisU, axisV, axisA)
        basis.setPosition(center)
        scaleVec.set(r, r, h)
        basis.scale(scaleVec)
        slot.wire.matrix.copy(basis)
        slot.wire.matrixWorldNeedsUpdate = true

        // 箭头长度 = 半径与半高里较大的那个的 60%（点云尺度未知，按圆柱自身尺寸取最直观）
        const arrowLength = Math.max(r, h) * 0.6
        slot.arrow.position.copy(center)
        slot.arrow.setDirection(axisA)
        slot.arrow.setLength(arrowLength, arrowLength * 0.2, arrowLength * 0.08)

        slot.wire.visible = true
        slot.arrow.visible = true
      })
      for (let i = cylinders.length; i < slots.length; i++) {
        slots[i].wire.visible = false
        slots[i].arrow.visible = false
      }
      group.visible = cylinders.length > 0
    },
    hide() {
      group.visible = false
    },
    dispose() {
      scene.remove(group)
      unitWire.dispose()
      wireMaterial.dispose()
      // ArrowHelper 内部自建 Line + Cone，几何与材质都要逐个释放
      for (const slot of slots) {
        slot.arrow.traverse((obj) => {
          const mesh = obj as Partial<THREE.Mesh & THREE.Line>
          mesh.geometry?.dispose()
          const material = mesh.material
          if (Array.isArray(material)) material.forEach((m) => m.dispose())
          else material?.dispose()
        })
      }
      slots.length = 0
    },
  }
}
