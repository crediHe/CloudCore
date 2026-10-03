import * as THREE from 'three'
import type { RansacPlaneQuad } from '../utils/ransacPlane'

/**
 * RANSAC 平面拟合的平面片可视化：半透明四边形 + 法线箭头。
 *
 * 形状仿 three/viewingPivot.ts（`createXxx(scene)` 返回带 show/hide/dispose 的实例），
 * 同样**不进 engine.ts**——引擎至今无 gizmo，LOD 四件套与测量/框选覆盖物也都在引擎外，
 * 由各自的 store/composable 直接往 `viewer.scene` 上挂。
 *
 * 坐标系：与点云 Group 完全一致——几何直接按**显示坐标**（= 原始坐标 − 全局基准点，
 * Z-up）画，再给 Group 加 `rotation.x = -π/2` 让 matrixWorld 完成 Z-up → Y-up 转换。
 * 平面模型的 n / d / quad 都是从同一份显示坐标缓冲算出来的（见 utils/ransacPlane.ts），
 * 故两者天然贴合，无需任何换算。
 *
 * 两个实现取舍：
 * - **单位四边形建一次、每次 show 只写矩阵**：平面片尺寸跨实体能差几个数量级
 *   （地面 1000 m × 1000 m 与桌面 0.2 m × 0.2 m），重建几何体毫无必要。
 * - **槽位池**：一次拟合可能覆盖多个目标实体（选中项目 = 全部子实体），每个都出一块
 *   平面片。池按需增长、多余的隐藏，切模式时只有一个 Group 要管。
 */

/** 半透明平面片颜色（青色：黄色已归旋转中心/测量、紫色归框选覆盖物，避让）。 */
const QUAD_COLOR = 0x00e5ff
/** 平面片不透明度：够看清贴合关系，又不遮住内点的颜色分布。 */
const QUAD_OPACITY = 0.18
/** 边框不透明度：与平面片共用色，画边线让平面片在侧视时也能被看见。 */
const EDGE_OPACITY = 0.9

/** 一块待显示的平面片。 */
export interface PlaneOverlayItem {
  /** 平面片画布（中心 + 平面内正交单位基 + 半跨度），来自 native 回包。 */
  quad: RansacPlaneQuad
  /** 单位法向（决定箭头朝向）。 */
  normal: { nx: number; ny: number; nz: number }
}

/** 平面片可视化实例。 */
export interface PlaneOverlay {
  /**
   * 显示这批平面片（整体替换上一次的内容；多余的槽位隐藏）。
   * @warning 调用方**必须**随后 `viewer.requestRender()`（three 无变更通知）
   */
  show(planes: PlaneOverlayItem[]): void
  /** 隐藏全部（复用实例，不 dispose——预览会反复开关）。调用方同样须 requestRender。 */
  hide(): void
  dispose(): void
}

/** 单位四边形（局部 XY 平面上的 −1..1，两三角面索引）。矩阵缩放即半跨度。 */
function buildUnitQuad(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -1,
        -1,
        0, //
        1,
        -1,
        0,
        1,
        1,
        0,
        -1,
        1,
        0,
      ]),
      3
    )
  )
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  return geometry
}

/** 一个槽位：平面片 + 边框 + 法线箭头（共享单位四边形几何，矩阵各写一份）。 */
interface Slot {
  mesh: THREE.Mesh
  edge: THREE.LineLoop
  arrow: THREE.ArrowHelper
}

export function createPlaneOverlay(scene: THREE.Scene): PlaneOverlay {
  const group = new THREE.Group()
  group.name = 'ransacPlaneOverlay'
  group.visible = false
  // 与点云 Group 同款：数据是 Z-up，几何按显示坐标画，世界变换自动跟上
  group.rotation.x = -Math.PI / 2

  const unitQuad = buildUnitQuad()
  const quadMaterial = new THREE.MeshBasicMaterial({
    color: QUAD_COLOR,
    transparent: true,
    opacity: QUAD_OPACITY,
    side: THREE.DoubleSide, // 从平面背面看也要有
    depthWrite: false, // 半透明面不写深度：免得遮住后画的点/线
  })
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: QUAD_COLOR,
    transparent: true,
    opacity: EDGE_OPACITY,
    depthWrite: false,
  })

  const slots: Slot[] = []

  /** 取第 i 个槽位，不够就新建（几何共享，材质共享，只有箭头自建）。 */
  function slotAt(i: number): Slot {
    const existing = slots[i]
    if (existing) return existing
    const mesh = new THREE.Mesh(unitQuad, quadMaterial)
    // 尺寸由矩阵决定，包围球不随矩阵更新，交给引擎剔除会误剪
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false // 矩阵由 show() 直接写
    group.add(mesh)

    const edge = new THREE.LineLoop(unitQuad, edgeMaterial)
    edge.frustumCulled = false
    edge.matrixAutoUpdate = false
    group.add(edge)

    // 箭头从平面片中心指向法向一侧；长度随平面片尺寸走（见 show）
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, QUAD_COLOR)
    arrow.frustumCulled = false
    group.add(arrow)

    const slot: Slot = { mesh, edge, arrow }
    slots.push(slot)
    return slot
  }

  /** 复用对象，避免每次 show 分配（预览期间会反复调用）。 */
  const basis = new THREE.Matrix4()
  const axisU = new THREE.Vector3()
  const axisV = new THREE.Vector3()
  const axisN = new THREE.Vector3()
  const center = new THREE.Vector3()
  const scaleVec = new THREE.Vector3()

  /** 写一块平面片的变换矩阵：[u v n | c] · diag(halfU, halfV, 1)（右乘 scale 只缩列不动平移）。 */
  function applyMatrix(target: THREE.Object3D, halfU: number, halfV: number): void {
    basis.makeBasis(axisU, axisV, axisN)
    basis.setPosition(center)
    scaleVec.set(halfU, halfV, 1)
    basis.scale(scaleVec)
    target.matrix.copy(basis)
    target.matrixWorldNeedsUpdate = true
  }

  return {
    show(planes) {
      planes.forEach((item, i) => {
        const slot = slotAt(i)
        const { quad, normal } = item
        center.set(quad.cx, quad.cy, quad.cz)
        axisU.set(quad.ux, quad.uy, quad.uz)
        axisV.set(quad.vx, quad.vy, quad.vz)
        axisN.set(normal.nx, normal.ny, normal.nz)
        // 半跨度可能为 0（内点退化）——钳一个极小值，否则矩阵奇异、箭头长度也归零
        const halfU = Math.max(quad.halfU, 1e-6)
        const halfV = Math.max(quad.halfV, 1e-6)
        applyMatrix(slot.mesh, halfU, halfV)
        applyMatrix(slot.edge, halfU, halfV)

        // 箭头长度 = 平面片长边的 40%（点云尺度未知，按平面自身跨度取最直观）
        const arrowLength = Math.max(halfU, halfV) * 0.4
        slot.arrow.position.copy(center)
        slot.arrow.setDirection(axisN)
        slot.arrow.setLength(arrowLength, arrowLength * 0.2, arrowLength * 0.08)

        slot.mesh.visible = true
        slot.edge.visible = true
        slot.arrow.visible = true
      })
      for (let i = planes.length; i < slots.length; i++) {
        slots[i].mesh.visible = false
        slots[i].edge.visible = false
        slots[i].arrow.visible = false
      }
      group.visible = planes.length > 0
    },
    hide() {
      group.visible = false
    },
    dispose() {
      scene.remove(group)
      unitQuad.dispose()
      quadMaterial.dispose()
      edgeMaterial.dispose()
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
