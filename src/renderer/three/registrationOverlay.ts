import * as THREE from 'three'

/**
 * 点对配准（Align）的拾取标记覆盖物：每对点画「对齐点标记 + 参考点标记 + 一条连线」。
 *
 * 形状仿 three/planeOverlay.ts（`createXxx(scene)` 返回带 show/hide/dispose 的实例），
 * 同样**不进 engine.ts**——引擎至今无 gizmo，LOD 四件套与测量/框选/平面覆盖物也都在
 * 引擎外，由各自的 store 直接往 `viewer.scene` 上挂。
 *
 * 坐标系：与点云 Group 完全一致——几何直接按**显示坐标**（= 原始坐标 − 全局基准点，
 * Z-up）画，再给 Group 加 `rotation.x = -π/2` 让 matrixWorld 完成 Z-up → Y-up 转换。
 * 拾取点坐标（utils/measure.ts 的 `PickHit.local`）就是显示坐标，故两者天然贴合。
 *
 * ⚠ **标记不跟随配准预览**：CC 把标签挂成点云子对象，GL 变换一应用标签就跟着走；这里的
 * 覆盖物是独立场景对象。故 Align 的约定是**任何点对/过滤器改动都先撤销预览**（见
 * alignStore.preview/revokePreview），标记因此永远画在真实坐标上——代价是"预览后再微调"
 * 要重按一次「对齐」（记在 native/registration/README-REF.md 的差异清单里）。
 *
 * 每侧一个独立的单顶点 `Points`（而不是"两个顶点一组的顶点色 Points"）：
 * 两侧点数可以不相等（只点了待对齐侧的第 4 个点、参考侧还没点），那种"单边点"必须能单独
 * 显示出来——用户靠它找到自己刚点在哪、再决定删哪一个。顶点色方案下两个标记共用一个
 * geometry，隐藏其一就得改写缓冲，反而更绕。标记数最多几十个，对象多一点无所谓。
 *
 * 颜色沿用测量/分割/平面的避让表：**橙 = 对齐、蓝 = 参考**（黄=测量、紫=分割、青=平面已占）。
 */

/** 对齐点标记色（橙）。 */
const ALIGNED_COLOR = 0xff8f00
/** 参考点标记色（蓝）。 */
const REFERENCE_COLOR = 0x2196f3
/** 连线色（半透明白：不抢两侧标记的注意力）。 */
const LINK_COLOR = 0xffffff
const LINK_OPACITY = 0.55
/** 标记点屏幕尺寸（像素；sizeAttenuation=false 下与相机距离无关，同测量标记）。 */
const MARKER_PX = 10
/** 覆盖物渲染顺序：压在点云之上，免得被近处点遮住（同测量/分割覆盖物的 999）。 */
const OVERLAY_RENDER_ORDER = 999

/** 显示坐标三元组。 */
export interface OverlayVec3 {
  x: number
  y: number
  z: number
}

/**
 * 一对拾取点（都是**显示坐标**）。
 * 某一侧为 `null` = 该侧还没点上（两侧点数不等时会出现），只画另一侧的标记、不画连线。
 */
export interface RegistrationOverlayItem {
  aligned: OverlayVec3 | null
  reference: OverlayVec3 | null
}

/** 点对标记可视化实例。 */
export interface RegistrationOverlay {
  /**
   * 显示这批点对（整体替换上一次的内容；多余的槽位隐藏）。
   * @warning 调用方**必须**随后 `viewer.requestRender()`（three 无变更通知）
   */
  show(pairs: RegistrationOverlayItem[]): void
  /** 隐藏全部（复用实例，不 dispose——预览与拾取会反复开关）。调用方同样须 requestRender。 */
  hide(): void
  dispose(): void
}

/** 一个槽位：两侧各一个标记点 + 一条连线。 */
interface Slot {
  alignedMarker: THREE.Points
  referenceMarker: THREE.Points
  link: THREE.Line
}

/** 单顶点 Points（位置缓冲留给调用方就地改写）。 */
function createMarker(material: THREE.Material): { object: THREE.Points; positions: Float32Array } {
  const positions = new Float32Array(3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const object = new THREE.Points(geometry, material)
  object.frustumCulled = false // 单点几何体的包围球是"半径为 0 的球"，交给视锥剔除会被误剪
  object.renderOrder = OVERLAY_RENDER_ORDER
  return { object, positions }
}

export function createRegistrationOverlay(scene: THREE.Scene): RegistrationOverlay {
  const group = new THREE.Group()
  group.name = 'registrationOverlay'
  group.visible = false
  // 与点云 Group 同款：数据是 Z-up，几何按显示坐标画，世界变换自动跟上
  group.rotation.x = -Math.PI / 2

  const alignedMaterial = new THREE.PointsMaterial({
    color: ALIGNED_COLOR,
    size: MARKER_PX,
    sizeAttenuation: false, // size 即屏幕像素（同测量标记：与相机距离无关，无需每帧重算）
    depthTest: false, // 标记不被点云遮挡（CC 同名点标记同样常显）
  })
  // 显式再构造一次（而非 `{ ...alignedMaterial, color }` 展开）：材质字段既有自有属性也有
  // 原型上的访问器，展开只能可靠地带上前者
  const referenceMaterial = new THREE.PointsMaterial({
    color: REFERENCE_COLOR,
    size: MARKER_PX,
    sizeAttenuation: false,
    depthTest: false,
  })
  const linkMaterial = new THREE.LineBasicMaterial({
    color: LINK_COLOR,
    transparent: true,
    opacity: LINK_OPACITY,
    depthTest: false,
  })

  const slots: Slot[] = []

  /** 取第 i 个槽位，不够就新建（材质共享，只有顶点数据自建）。 */
  function slotAt(i: number): Slot {
    const existing = slots[i]
    if (existing) return existing
    const aligned = createMarker(alignedMaterial)
    const reference = createMarker(referenceMaterial)
    group.add(aligned.object, reference.object)

    const linkPositions = new Float32Array(6)
    const linkGeometry = new THREE.BufferGeometry()
    linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3))
    const link = new THREE.Line(linkGeometry, linkMaterial)
    link.frustumCulled = false
    link.renderOrder = OVERLAY_RENDER_ORDER
    group.add(link)

    const slot: Slot = { alignedMarker: aligned.object, referenceMarker: reference.object, link }
    slots.push(slot)
    return slot
  }

  /** 就地改写一个单顶点标记。 */
  function writeMarker(object: THREE.Points, p: OverlayVec3): void {
    const attr = object.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.setXYZ(0, p.x, p.y, p.z)
    attr.needsUpdate = true // 就地改写：显式告知 GPU 重传
    object.visible = true
  }

  return {
    show(pairs) {
      pairs.forEach((item, i) => {
        const slot = slotAt(i)
        if (item.aligned) writeMarker(slot.alignedMarker, item.aligned)
        else slot.alignedMarker.visible = false
        if (item.reference) writeMarker(slot.referenceMarker, item.reference)
        else slot.referenceMarker.visible = false
        // 连线只在两侧都有时画：只有一侧的话线会从原点扯过来（误导）
        if (item.aligned && item.reference) {
          const attr = slot.link.geometry.getAttribute('position') as THREE.BufferAttribute
          attr.setXYZ(0, item.aligned.x, item.aligned.y, item.aligned.z)
          attr.setXYZ(1, item.reference.x, item.reference.y, item.reference.z)
          attr.needsUpdate = true
          slot.link.visible = true
        } else {
          slot.link.visible = false
        }
      })
      for (let i = pairs.length; i < slots.length; i++) {
        slots[i].alignedMarker.visible = false
        slots[i].referenceMarker.visible = false
        slots[i].link.visible = false
      }
      group.visible = pairs.length > 0
    },
    hide() {
      group.visible = false
    },
    dispose() {
      scene.remove(group)
      alignedMaterial.dispose()
      referenceMaterial.dispose()
      linkMaterial.dispose()
      // 几何体逐槽位自建（见 slotAt），必须逐个释放
      for (const slot of slots) {
        slot.alignedMarker.geometry.dispose()
        slot.referenceMarker.geometry.dispose()
        slot.link.geometry.dispose()
      }
      slots.length = 0
    },
  }
}
