import * as THREE from 'three'
import { lodChunkBitsFor, lodDecodeChunk, lodDecodeVertex, lodPackId } from '../utils/lodOctree'
import type { LodSlotResolver, PointsTag } from '../utils/measure'
import type { LodTreeState } from './lodTraversal'

/**
 * LOD 显示层：每实体一个"每帧预算"大小的 staging `THREE.Points`。
 *
 * 动机（对标 CloudCompare）：CC 每帧硬上限 1<<19 点
 * （`ccPointCloud.cpp:2799` MAX_POINT_COUNT_PER_LOD_RENDER_PASS），靠八叉树 LOD
 * 挑选该画哪些点，整云**从不常驻显存**。本模块是那套机制在 three 侧的下半身：
 *
 *  - staging 几何体的容量 = 每帧预算（LOD_FRAME_BUDGET），**与点云总点数无关**——
 *    1 亿点与 100 万点占用同样多的显存与同样的绘制成本，渲染因此与数据量解耦。
 *    整云只留在语义层（CPU 内存里的 TypedArray，见 pointcloudStore 的 CloudRecord）。
 *  - **材质与语义层的 per-chunk `Points` 共用同一个实例**（刻意不克隆）：点大小
 *    （applyPointSize）与着色开关（applyColorMode）都写在这一个材质上，两条路径
 *    天然同观感，也省掉了各自同步。staging 只负责"往缓冲里装哪批点"。
 *  - **拾取走显示层**：`THREE.Points.raycast` 是逐顶点距离测试，语义层的点云直扫
 *    是秒级卡死；staging 上限 512K，扫描成本与总点数解耦，且命中的就是屏幕上
 *    真实可见的那批点。槽位号 → 语义层 (chunkIndex, vertexIndex) 的反查由挂在
 *    staging userData 上的 resolver 完成（协议见 utils/measure.ts 的 LodSlotResolver）。
 *
 * 填充路径有两条，按"八叉树是否已就绪"分流（都由 lodScheduler 驱动）：
 *  - **树就绪**：`gatherLodPoints`（lodTraversal）按视锥与配额取点，本模块的
 *    `fillLodFromIds` 把打包 id 解码回坐标/颜色/分类字节。取点集随相机与预算变化。
 *  - **树未就绪**（建树中）：`fillLodFallback` 的**块主序等距取样**——保证建树期间
 *    有画面可看（对齐 CC 建 LOD 期间的 decimStep 降级），树一到就被替换。
 *
 * `LodDisplay.filled` 是"缓冲里装了前多少个槽位"，`LOD_CHUNK_SENTINEL` 标记拾取
 * 必须走反查（staging 的槽位号不是任何真实分块）。
 */

/** 每帧预算（点数）；对齐 CC 的 MAX_POINT_COUNT_PER_LOD_RENDER_PASS = 1<<19。 */
export const LOD_FRAME_BUDGET = 1 << 19

/**
 * 显示层 staging 的 `Points` 上 `chunkIndex` 的哨兵值。
 * 它不是任何真实分块：拾取命中后必须由 resolver 反查回真实的 (chunkIndex, vertexIndex)。
 */
export const LOD_CHUNK_SENTINEL = -1

/** 显示层对象（挂在 pointcloudStore 的 CloudRecord.lod 上）。 */
export interface LodDisplay {
  points: THREE.Points
  /** 所属实体 id（建树队列按它取消/对账；与 staging userData 里的 tag 同源）。 */
  entityId: number
  /** 打包 id（槽位 → 语义层），与 capacity 等长；前 filled 个有效。 */
  slotIds: Uint32Array
  /** 当前装进缓冲的 id 用的 `vertexShift`（树就绪前后由不同路径写入，见各处赋值）。 */
  bufferShift: number
  /** 已填充槽位数（= drawRange.count）。 */
  filled: number
  /** 槽位容量（= min(可见总点数, LOD_FRAME_BUDGET)）。 */
  capacity: number
  /** 八叉树遍历状态；null = 尚未建好（或建树失败）→ 回退等距取样。 */
  tree: LodTreeState | null
  /** 语义层分块几何体的**借用引用**（每次重取时重建逐块视图；生命周期同 CloudRecord）。 */
  geometries: THREE.BufferGeometry[]
  /** 需要重取（颜色换装 / 树就绪 / 预算变化）；由 lodScheduler 消费并清零。 */
  dirty: boolean
}

/** staging 几何体的三个 attribute（逐帧写入，缓存引用避免热路径里反复 getAttribute）。 */
export interface LodStagingAttributes {
  position: THREE.BufferAttribute
  color: THREE.BufferAttribute
  classification: THREE.BufferAttribute
}

/** 逐点读取所需的最小属性结构（BufferAttribute 与 InterleavedBufferAttribute 都满足）。 */
type AnyAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute

/**
 * 单块的可见点视图。可见点集语义与 segmentSelection / geometryVisibleIndex 一致：
 * 带 index 的几何体（分割产物）的可见点 = index 条目；无 index 的原始块 = 全量顶点。
 * 刻意**不看 drawRange**：本应用只对无 index 的几何体写 drawRange（且恒为全量），
 * 唯一会写非全量的场景是分割预览，而预览期整条回退旧路径（见 setChunkVisibility）。
 */
export interface LodChunkView {
  positions: Float32Array
  /** index 条目数组；无 index（原始块）为 null。 */
  index: Uint32Array | null
  /** drawRange 在 index 条目上的起点（无 index 时无意义）。 */
  rangeStart: number
  /** 可见点数。 */
  count: number
  /** 当前装在几何体上的颜色 attribute（'none' 着色时不存在）；未装写灰。 */
  colorAttr: AnyAttribute | null
  /** 分类字节 attribute（空块没有）。 */
  clsAttr: AnyAttribute | null
}

/** 块内第 k 个可见点对应的**顶点缓冲下标**（无 index 时即 k 本身）。 */
function vertexAt(view: LodChunkView, k: number): number {
  return view.index ? view.index[view.rangeStart + k] : k
}

/**
 * 逐块建立可见点视图。块数通常是几十到几百，开销可忽略。
 * 空块（解析期的空几何体）count = 0，自然被取样跳过。
 */
export function buildChunkViews(geometries: THREE.BufferGeometry[]): LodChunkView[] {
  const views: LodChunkView[] = []
  for (const g of geometries) {
    const posAttr = g.getAttribute('position')
    const positions = posAttr ? (posAttr.array as Float32Array) : new Float32Array(0)
    const indexAttr = g.index
    const index = indexAttr ? (indexAttr.array as Uint32Array) : null
    let rangeStart = 0
    let count: number
    if (index) {
      rangeStart = Math.min(Math.max(g.drawRange.start, 0), index.length)
      const end = Number.isFinite(g.drawRange.count)
        ? Math.min(index.length, g.drawRange.start + g.drawRange.count)
        : index.length
      count = Math.max(end - rangeStart, 0)
    } else {
      count = posAttr ? posAttr.count : 0
    }
    views.push({
      positions,
      index,
      rangeStart,
      count,
      colorAttr: g.getAttribute('color'),
      clsAttr: g.getAttribute('classification'),
    })
  }
  return views
}

/**
 * 等距取样：把 capacity 个槽位按各块可见点数**成比例**分给各块，块内等距取点。
 *
 * 分块配额而非全局取样是刻意的——点云的块是按加载批次切的，点数往往极不均匀
 * （首末块可能只有几百点）。全局等距会让小块的点的采样率与大块相同，但因为小块
 * 本身点数少，实际取到的点数量极少，视觉上"整块消失"；按块配额则保证每块都有
 * 与其规模相称的代表点。
 *
 * @param views     逐块视图（buildChunkViews 的产物）
 * @param capacity  槽位上限
 * @param visit     (槽位号, 块下标, 块内候选序号, 块视图)；块内候选序号不是顶点下标
 * @returns 实际填充的槽位数
 */
function forEachSample(
  views: LodChunkView[],
  capacity: number,
  visit: (slot: number, chunkIndex: number, k: number, view: LodChunkView) => void
): number {
  const n = views.length
  let total = 0
  for (const v of views) total += v.count
  let budget = Math.min(total, capacity)
  let remaining = total
  let slot = 0
  for (let i = 0; i < n; i++) {
    const v = views[i]
    if (v.count === 0) continue
    // 最后一块直接吃掉剩余预算，避免逐块 Math.round 的截断误差累积成"永远填不满"
    let quota = i === n - 1 ? budget : Math.round((v.count / remaining) * budget)
    if (quota > v.count) quota = v.count
    if (quota > budget) quota = budget
    for (let j = 0; j < quota; j++) {
      visit(slot++, i, Math.floor((j * v.count) / quota), v)
    }
    budget -= quota
    remaining -= v.count
  }
  return slot
}

/**
 * 取一组语义层分块几何体的显示空间包围体（逐块已填好的 boundingBox 求并集）。
 * 不逐点现算：解析路径已把每块的包围盒填好（pointcloudStore.applyBoundingVolumes）。
 * 用**全集**而非采样集的包围体是刻意保守的——每帧取点集都会变，包围体必须覆盖
 * 整云，否则 three 的整体早退会把本该画出来的点剪掉。
 */
function unionBoundingVolumes(geometries: THREE.BufferGeometry[]): { box: THREE.Box3; sphere: THREE.Sphere } {
  const box = new THREE.Box3()
  for (const g of geometries) {
    if (g.boundingBox && !g.boundingBox.isEmpty()) box.union(g.boundingBox)
  }
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
  const radius = size.length() / 2
  return { box, sphere: new THREE.Sphere(center, radius) }
}

/** 颜色读取暂存（避免逐点分配小数组）。 */
const _rgb = [0.7, 0.7, 0.7]

/**
 * 读一个顶点的颜色到 _rgb。
 *
 * 语义层有两套颜色 attribute，格式不同、都是**线性值**（three r185 默认色彩管理，
 * 输出端再做 sRGB 编码）：
 *  - rgb 态：解析期写入的 Float32（0..1）；
 *  - scalar 态：buildScalarColors 产出的 Uint8 + normalized=true。
 * 显示层统一按 Float32 存（不做 8 位量化——线性空间量化会把暗部整片压成 0，
 * 视觉可见），故这里按底层数组类型归一化到 0..1。
 */
function readColor(view: { colorAttr: AnyAttribute | null }, vertexIndex: number): void {
  const attr = view.colorAttr
  if (!attr) {
    _rgb[0] = 0.7
    _rgb[1] = 0.7
    _rgb[2] = 0.7
    return
  }
  const arr = attr.array as unknown as ArrayLike<number>
  const i = vertexIndex * attr.itemSize
  const scale = attr.normalized && arr instanceof Uint8Array ? 1 / 255 : 1
  _rgb[0] = arr[i] * scale
  _rgb[1] = arr[i + 1] * scale
  _rgb[2] = arr[i + 2] * scale
}

/**
 * 建立某实体的显示层：分配 staging 缓冲 + 首帧填充 + 挂上槽位反查器。
 *
 * @param geometries 语义层分块几何体（**借用**：只读，本模块不改写它们）
 * @param material   与语义层 per-chunk Points **共用**的材质实例（见文件头注释）
 * @param entityId   所属实体 id（写进 userData 供拾取反查）
 * @returns 显示层对象；该实体可见点数为 0 时返回 null（没有可显示的内容）
 */
export function createLodDisplay(
  geometries: THREE.BufferGeometry[],
  material: THREE.PointsMaterial,
  entityId: number
): LodDisplay | null {
  const views = buildChunkViews(geometries)
  let total = 0
  for (const v of views) total += v.count
  if (total === 0) return null

  const capacity = Math.min(total, LOD_FRAME_BUDGET)
  const positions = new Float32Array(capacity * 3)
  const colors = new Float32Array(capacity * 3)
  const classifications = new Uint8Array(capacity)

  const geometry = new THREE.BufferGeometry()
  const positionAttr = new THREE.BufferAttribute(positions, 3)
  const colorAttr = new THREE.BufferAttribute(colors, 3)
  const classAttr = new THREE.BufferAttribute(classifications, 1)
  geometry.setAttribute('position', positionAttr)
  geometry.setAttribute('color', colorAttr)
  geometry.setAttribute('classification', classAttr)
  // 包围体取语义层全集的并集（不是取点集的）：保守，且不随取点集每帧变化而重算。
  // 必须显式填好——three 的视锥剔除在 boundingSphere 为 null 时会当场 O(N) 现算。
  const volumes = unionBoundingVolumes(geometries)
  geometry.boundingBox = volumes.box
  geometry.boundingSphere = volumes.sphere

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = true

  const display: LodDisplay = {
    points,
    entityId,
    slotIds: new Uint32Array(capacity),
    // 回退取样的打包位宽由块数决定，与 native 的 PackedCodec 同一公式（见 lodChunkBitsFor）
    bufferShift: 32 - lodChunkBitsFor(views.length),
    filled: 0,
    capacity,
    tree: null,
    geometries,
    dirty: false,
  }
  const attributes: LodStagingAttributes = {
    position: positionAttr,
    color: colorAttr,
    classification: classAttr,
  }
  display.filled = fillLodFallback(display, attributes, views, LOD_FRAME_BUDGET)

  const tag: PointsTag = { entityId, chunkIndex: LOD_CHUNK_SENTINEL }
  points.userData = { ...tag, lodSlot: makeSlotResolver(display) }
  return display
}

/** 上传本帧改动的属性区间（只传写过的段，避免整个 6 MB 缓冲重传）。 */
function uploadRange(attr: THREE.BufferAttribute, start: number, count: number, itemSize: number): void {
  if (count <= 0) return
  // addUpdateRange 是 r159+ 的部分上传通道（WebGLAttributes 按区间 updateBuffer）
  attr.addUpdateRange(start * itemSize, count * itemSize)
  attr.needsUpdate = true
}

/** 把 filled/画幅同步到几何体（drawRange + 脏标记）。 */
function applyFill(display: LodDisplay, count: number): void {
  display.filled = count
  display.points.geometry.setDrawRange(0, count)
  display.dirty = false
}

/**
 * 填充路径 A（树就绪）：把 `slotIds[0..count)` 的打包 id 解码回坐标 / 颜色 / 分类。
 *
 * slotIds 由 `gatherLodPoints`（lodTraversal）写入——那是叶子区间上的**步长采样**
 * （单调映射，故同块的点在 id 序列里仍连成段），逐点的随机访问只发生在这一层：
 * 按块切段后段内**只读同一块的坐标缓冲**（native 保证叶子区间块主序，故这种段很少），
 * 缓存与 TLB 都友好。
 */
export function fillLodFromIds(
  display: LodDisplay,
  attributes: LodStagingAttributes,
  views: LodChunkView[],
  count: number
): void {
  const ids = display.slotIds
  const positions = attributes.position.array as Float32Array
  const colors = attributes.color.array as Float32Array
  const classifications = attributes.classification.array as Uint8Array
  const shift = display.bufferShift
  const limit = Math.min(count, display.capacity)

  let slot = 0
  while (slot < limit) {
    const chunk = ids[slot] >>> shift
    const view = views[chunk]
    if (!view) break // 不可能发生（id 由本进程编码）；防御以免坏 id 把循环带飞
    // 同块连续段：本段内只需要一个源缓冲
    let end = slot + 1
    while (end < limit && ids[end] >>> shift === chunk) end++
    const src = view.positions
    const clsSrc = view.clsAttr ? (view.clsAttr.array as Uint8Array) : null
    for (let i = slot; i < end; i++) {
      const vertexIndex = ids[i] & ((1 << shift) - 1)
      const s = vertexIndex * 3
      const d = i * 3
      positions[d] = src[s]
      positions[d + 1] = src[s + 1]
      positions[d + 2] = src[s + 2]
      readColor(view, vertexIndex)
      colors[d] = _rgb[0]
      colors[d + 1] = _rgb[1]
      colors[d + 2] = _rgb[2]
      classifications[i] = clsSrc ? clsSrc[vertexIndex] : 0
    }
    slot = end
  }

  // 按**实际写过的槽位数**收尾而不是 limit：坏 id 会让上面的循环提前 break，
  // 此时多出来的槽位里是上一次的陈旧坐标——画出去既是错点，反查器（按 filled 判过期）
  // 还会把它们当成有效槽位拾出来。宁可少画一行，不可拾错点。
  uploadRange(attributes.position, 0, slot, 3)
  uploadRange(attributes.color, 0, slot, 3)
  uploadRange(attributes.classification, 0, slot, 1)
  applyFill(display, slot)
}

/**
 * 填充路径 B（树未就绪 / 无树的回退）：块主序等距取样填满预算。
 * 建树期间有画面可看，且拾取反查照常工作；树一到就换 A 路径重填。
 */
export function fillLodFallback(
  display: LodDisplay,
  attributes: LodStagingAttributes,
  views: LodChunkView[],
  budget: number
): number {
  const ids = display.slotIds
  const positions = attributes.position.array as Float32Array
  const colors = attributes.color.array as Float32Array
  const classifications = attributes.classification.array as Uint8Array
  const shift = display.bufferShift
  const limit = Math.min(budget, display.capacity)
  const filled = forEachSample(views, limit, (slot, chunkIndex, k, view) => {
    const vertexIndex = vertexAt(view, k)
    const s = vertexIndex * 3
    const d = slot * 3
    positions[d] = view.positions[s]
    positions[d + 1] = view.positions[s + 1]
    positions[d + 2] = view.positions[s + 2]
    readColor(view, vertexIndex)
    colors[d] = _rgb[0]
    colors[d + 1] = _rgb[1]
    colors[d + 2] = _rgb[2]
    classifications[slot] = view.clsAttr ? (view.clsAttr.array as Uint8Array)[vertexIndex] : 0
    ids[slot] = lodPackId(chunkIndex, vertexIndex, shift)
  })
  uploadRange(attributes.position, 0, filled, 3)
  uploadRange(attributes.color, 0, filled, 3)
  uploadRange(attributes.classification, 0, filled, 1)
  applyFill(display, filled)
  return filled
}

/** 取显示层的三个 staging attribute（fillLod* 的入参；只在建立时取一次）。 */
export function lodStagingAttributes(display: LodDisplay): LodStagingAttributes {
  const geometry = display.points.geometry
  return {
    position: geometry.getAttribute('position') as THREE.BufferAttribute,
    color: geometry.getAttribute('color') as THREE.BufferAttribute,
    classification: geometry.getAttribute('classification') as THREE.BufferAttribute,
  }
}

/**
 * 释放显示层（几何体与它自带的三个 attribute；材质是与语义层共用的，**不能**在这里释放）。
 * 调用方负责把它从 Group 里摘掉。
 */
export function disposeLodDisplay(display: LodDisplay): void {
  display.points.removeFromParent()
  display.points.geometry.dispose()
  display.tree = null
}

/**
 * 槽位号 → 语义层 (chunkIndex, vertexIndex) 的反查器。
 *
 * 阶段 3 起 id 就是**打包 id**（native/lod-octree 的 `pointIds` 同款编码，
 * 回退取样路径按同一公式自行编码），故反查退化成一次移位 + 一次掩码：
 * 阶段 1 的"槽位 → 候选序号 → 二分块边界表 → 再解一次 index"整条链都不需要了。
 *
 * `bufferShift` 在**每次填充时**与写入的 id 一起定型（树就绪前后可能不同），
 * 故这里每次读取时取用，不能在建显示层时固化。
 */
function makeSlotResolver(display: LodDisplay): LodSlotResolver {
  return (slot) => {
    // 越界即表已过期（staging 被重填过）：宁可落空，也不能反查出一个错误的点
    if (!Number.isInteger(slot) || slot < 0 || slot >= display.filled) return null
    const id = display.slotIds[slot]
    return {
      chunkIndex: lodDecodeChunk(id, display.bufferShift),
      vertexIndex: lodDecodeVertex(id, display.bufferShift),
    }
  }
}
