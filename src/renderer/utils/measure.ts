import * as THREE from 'three'
import { fmtAxisCenter, fmtFixed, fmtGlobalCenter } from './format'
import { className } from './classColors'
import { worldPerPixelOrtho, worldPerPixelPerspective } from './viewScale'
// 仅类型引用（编译期擦除）：segmentSelection 不引 store，本文件仍可跑在 node 单测环境
import type { SegmentTarget } from './segmentSelection'

/**
 * 点云测量的拾取与数值计算（纯逻辑，可单测）。
 *
 * 对齐 CloudCompare 的 "Point picking"（qCC/ccPointPropertiesDlg + libs/qCC_db/src/cc2DLabel.cpp）：
 * 单点信息 / 两点距离 / 三点角度三种模式，数值语义与 CC 完全一致——
 * 距离 = |P2−P1|（位移不影响），角度 = 三个顶点处的 acos（带 clamp），
 * 另附三角形面积与三边长度（CC 的 getLabelInfo2 / getLabelInfo3）。
 *
 * 与 CC 的有意差异（其余见本文件各处注释）：
 *  - CC 的点拾取用 ±R 像素的**方形**窗口（ccGLWindowInterface::startCPUBasedPointPicking，
 *    默认 R=5px），这里用 three.Raycaster 的圆锥阈值近似成屏幕**圆形**窗口，同一意图；
 *  - CC 的拾取阈值是界面可调的，这里固定为 PICK_RADIUS_PX（需求明确不要多余 UI）。
 *
 * 拾取实现要点（均已对照 three r0.185 源码核实）：
 *  1. Points.raycast（src/objects/Points.js:98-157）自带三件套：按 geometry.boundingSphere
 *     整体早退、尊重 geometry.index + drawRange（预览隐藏的点自动拾不到）、
 *     回传的 index 是**顶点缓冲空间**下标（与 segmentSelection 的 ChunkSelection 同空间）；
 *  2. `intersects[i].point` 是**射线上**距顶点最近的点（Points.js:204），最多偏离一个
 *     threshold，**不是顶点位置**——必须用 index 回读 position 属性；
 *  3. Raycaster.intersectObjects 只测 layers、不看 object.visible（Raycaster.js:236-260），
 *     可见性必须由调用方过滤——**目标级**由 pointcloudStore.getVisibleTargets 过滤，
 *     **分块级**由 collectCandidates 逐个跳过（LOD 实体的语义层分块常驻但不可见）。
 *
 * LOD 显示层（2026-09 起，见 three/lodRenderer.ts）：超大点云的可见点不在 per-chunk
 * `Points` 上，而在每实体一个的 staging `Points` 上。它与分块同构（同形状的 tag、
 * 同样的 position/classification attribute），因此 collectCandidates 一行不用改；
 * 差别只在命中后要**多跳一次**：命中的 `index` 是 staging 槽位号，不是顶点缓冲下标，
 * 得靠挂在它上面的 LodSlotResolver 反查回真实的 (chunkIndex, vertexIndex)。
 * 这一跳在 pickVertex 内部完成——调用方拿到的 PickHit 与从前完全一样。
 */

/** 测量模式：单点信息 / 两点距离 / 三点角度。 */
export type MeasureMode = 'point' | 'distance' | 'angle'

/** 各模式需要的拾取点数（超过即重开一组，CC 语义）。 */
export const MEASURE_CAPACITY: Record<MeasureMode, number> = { point: 1, distance: 2, angle: 3 }

/** 模式显示名（工具栏按钮 / 日志）。 */
export const MEASURE_MODE_LABELS: Record<MeasureMode, string> = {
  point: '单点信息',
  distance: '两点距离',
  angle: '三点角度',
}

/** 拾取半径（CSS 像素，同 CC 的默认 pickRadius=5）。 */
export const PICK_RADIUS_PX = 5

/** 纯数值三元组（不带 three 类型，便于 store 与单测使用）。 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 一个被拾取的点：全是基础数据，可安全放进 reactive state。 */
export interface PickedPoint {
  entityId: number
  /** 实体名（浮动标签与日志里指明点属于哪块点云）。 */
  entityName: string
  /** 分块下标（顶点缓冲空间索引的限定范围）。 */
  chunkIndex: number
  /** 顶点缓冲空间下标（分割产物为共享全量缓冲 + index 子集，故同一缓冲的兄弟子集下标可能重叠）。 */
  vertexIndex: number
  /** 显示坐标（解析期已减共享基准点，Z-up 数据空间）——展示与距离计算都用它。 */
  local: Vec3
  /** 世界坐标（three 场景内，Y-up；仅用于标记与连线，绝不用于展示）。 */
  world: Vec3
  /** 文件原始坐标 = local + globalShift。 */
  original: Vec3
  /** 该实体的全局平移（全 0 表示未位移，此时不必展示原始坐标）。 */
  globalShift: Vec3
  /** 分类值（几何体无 classification 属性时为 null）。 */
  classification: number | null
}

/** 两点距离信息（CC cc2DLabel::getLabelInfo2 的 ΔX/ΔY/ΔZ 与 ΔXY/ΔXZ/ΔZY 平面距离）。 */
export interface DistanceInfo {
  distance: number
  dx: number
  dy: number
  dz: number
  dxy: number
  dxz: number
  dzy: number
}

/** 三点角度信息（CC cc2DLabel::getLabelInfo3：三个顶点角、三边、面积）。 */
export interface AngleInfo {
  /** A 顶点处夹角（度；AB 与 AC）。 */
  angleA: number
  /** B 顶点处夹角（度；BA 与 BC）——即"三点角度"通常所指的中间点夹角。 */
  angleB: number
  /** C 顶点处夹角（度；CA 与 CB）。 */
  angleC: number
  /** 边长 AB / BC / CA。 */
  ab: number
  bc: number
  ca: number
  /** 三角形面积 = |AB×AC|/2。 */
  area: number
}

/** 一次完成的测量结果：标题 + 正文行（浮动标签）+ 单行摘要（Console）。 */
export interface MeasureResult {
  title: string
  lines: string[]
  summary: string
}

// ---------------------------------------------------------------------------
// 数值计算
// ---------------------------------------------------------------------------

/** u 与 v 的夹角（度）；任一边长为 0（重合点）时返回 NaN，由格式化渲染成「—」。 */
function angleDeg(u: THREE.Vector3, v: THREE.Vector3): number {
  const lu = u.length()
  const lv = v.length()
  if (lu === 0 || lv === 0) return NaN
  // clamp 必须保留：浮点误差会让 |dot| 略超 |u||v|，acos 直接出 NaN
  const cos = Math.min(1, Math.max(-1, u.dot(v) / (lu * lv)))
  return THREE.MathUtils.radToDeg(Math.acos(cos))
}

/** 两点距离与各轴/平面增量（平面距离取两分量的 hypot）。 */
export function computeDistanceInfo(p1: Vec3, p2: Vec3): DistanceInfo {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const dz = p2.z - p1.z
  return {
    distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
    dx,
    dy,
    dz,
    dxy: Math.hypot(dx, dy),
    dxz: Math.hypot(dx, dz),
    dzy: Math.hypot(dz, dy),
  }
}

/**
 * 三点角度、边长与面积（顶点角：A = ∠BAC，B = ∠ABC，C = ∠ACB）。
 * 顶点重合/共线等退化输入按数学结果返回（夹角 NaN、共线面积 0），不做特殊处理。
 */
export function computeAngleInfo(a: Vec3, b: Vec3, c: Vec3): AngleInfo {
  const va = new THREE.Vector3(a.x, a.y, a.z)
  const vb = new THREE.Vector3(b.x, b.y, b.z)
  const vc = new THREE.Vector3(c.x, c.y, c.z)
  const ab = new THREE.Vector3().subVectors(vb, va) // AB
  const ac = new THREE.Vector3().subVectors(vc, va) // AC
  const bc = new THREE.Vector3().subVectors(vc, vb) // BC
  return {
    angleA: angleDeg(ab, ac),
    angleB: angleDeg(ab.clone().negate(), bc),
    angleC: angleDeg(ac.clone().negate(), bc.clone().negate()),
    ab: ab.length(),
    bc: bc.length(),
    ca: ac.length(),
    area: new THREE.Vector3().crossVectors(ab, ac).length() / 2,
  }
}

/** 是否带全局位移（决定要不要展示原始坐标行）。 */
export function hasGlobalShift(s: Vec3): boolean {
  return s.x !== 0 || s.y !== 0 || s.z !== 0
}

/**
 * 角度格式化（默认 3 位小数 + 度数符号）。
 * NaN（三点重合导致该顶点无方向）只给占位符、不缀「°」——否则渲染成「—°」。
 */
export function fmtAngle(deg: number, digits = 3): string {
  return Number.isFinite(deg) ? `${fmtFixed(deg, digits)}°` : '—'
}

// ---------------------------------------------------------------------------
// 格式化与结果组装
// ---------------------------------------------------------------------------

/** 单点信息行：`P#1024  X: 1.2345  Y: 0.0000  Z: -1.9000`（tag 用于角度的 A/B/C 标注）。 */
export function formatPointLine(p: PickedPoint, tag = ''): string {
  const prefix = tag ? `${tag} ` : ''
  return `${prefix}P#${p.vertexIndex}  ${fmtAxisCenter(p.local)}`
}

/**
 * 文件原始坐标行，仅在有全局位移时输出。
 * 多点模式带上 A/B/C 标记——与浮动标签上的徽标对应，否则三行「原始 …」分不清谁是谁。
 */
export function formatOriginalLine(p: PickedPoint, tag = ''): string {
  const prefix = tag ? `原始${tag} ` : '原始 '
  return `${prefix}${fmtGlobalCenter(p.original)}`
}

/** 单点模式正文：顶点号、显示坐标、原始坐标（有位移时）、分类。 */
function pointModeLines(p: PickedPoint): string[] {
  const lines = [`P#${p.vertexIndex}`, fmtAxisCenter(p.local)]
  if (hasGlobalShift(p.globalShift)) {
    lines.push(formatOriginalLine(p))
  }
  if (p.classification !== null) {
    lines.push(`分类 ${p.classification} ${className(p.classification)}`)
  }
  return lines
}

/**
 * 组装当前模式的测量结果；拾取点数不足该模式要求时返回 null
 * （未满员不产出结果，也不会写 Console）。
 */
export function buildMeasureResult(mode: MeasureMode, points: PickedPoint[]): MeasureResult | null {
  if (points.length < MEASURE_CAPACITY[mode]) return null

  if (mode === 'point') {
    const p = points[0]
    return {
      title: `P#${p.vertexIndex}`,
      lines: pointModeLines(p),
      summary: `单点信息 ${p.entityName} P#${p.vertexIndex} ${fmtAxisCenter(p.local)}`,
    }
  }

  if (mode === 'distance') {
    const [p1, p2] = points
    const d = computeDistanceInfo(p1.local, p2.local)
    const tags = [
      `距离 ${fmtFixed(d.distance, 4)}`,
      `ΔX ${fmtFixed(d.dx, 4)}  ΔY ${fmtFixed(d.dy, 4)}  ΔZ ${fmtFixed(d.dz, 4)}`,
    ]
    tags.push(`ΔXY ${fmtFixed(d.dxy, 4)}  ΔXZ ${fmtFixed(d.dxz, 4)}  ΔZY ${fmtFixed(d.dzy, 4)}`)
    const lines = [...tags, formatPointLine(p1, 'A'), formatPointLine(p2, 'B')]
    if (hasGlobalShift(p1.globalShift)) {
      lines.push(formatOriginalLine(p1, 'A'), formatOriginalLine(p2, 'B'))
    }
    return {
      title: `距离 ${fmtFixed(d.distance, 4)}`,
      lines,
      summary: `距离 ${fmtFixed(d.distance, 4)}（A P#${p1.vertexIndex} ↔ B P#${p2.vertexIndex}）`,
    }
  }

  const [p1, p2, p3] = points
  const a = computeAngleInfo(p1.local, p2.local, p3.local)
  const lines = [
    `A ${fmtAngle(a.angleA)}  B ${fmtAngle(a.angleB)}  C ${fmtAngle(a.angleC)}`,
    `边长 AB ${fmtFixed(a.ab, 4)}  BC ${fmtFixed(a.bc, 4)}  CA ${fmtFixed(a.ca, 4)}`,
    `面积 ${fmtFixed(a.area, 4)}`,
    formatPointLine(p1, 'A'),
    formatPointLine(p2, 'B'),
    formatPointLine(p3, 'C'),
  ]
  if (hasGlobalShift(p1.globalShift)) {
    lines.push(formatOriginalLine(p1, 'A'), formatOriginalLine(p2, 'B'), formatOriginalLine(p3, 'C'))
  }
  return {
    title: `角度 B ${fmtAngle(a.angleB)}`,
    lines,
    summary: `角度 B ${fmtAngle(a.angleB)}（A P#${p1.vertexIndex} / B P#${p2.vertexIndex} / C P#${p3.vertexIndex}）`,
  }
}

// ---------------------------------------------------------------------------
// 拾取（Raycaster + Points.raycast）
// ---------------------------------------------------------------------------

/**
 * 打在 `THREE.Points` 上的分块标记（pointcloudStore 写、拾取读）。
 *
 * 有它才能把一次射线命中反查回 (entityId, chunkIndex)。不能改用「子节点下标 ↔
 * geometries 下标」对齐：名称标签 `createLabel` 会往同一个 Group 里塞一个
 * THREE.Sprite，子节点下标与块下标不再一致。
 */
export interface PointsTag {
  entityId: number
  chunkIndex: number
}

/** 读 `THREE.Points` 上的分块标记；非本应用创建的 Points（无标记）返回 null。 */
export function readPointsTag(points: THREE.Points): PointsTag | null {
  const data = points.userData as Partial<PointsTag> | undefined
  if (!data || typeof data.entityId !== 'number' || typeof data.chunkIndex !== 'number') return null
  return { entityId: data.entityId, chunkIndex: data.chunkIndex }
}

/**
 * LOD 显示层的槽位反查器（lodRenderer 写、本文件的 pickVertex 读）。
 *
 * 入参是 staging 缓冲里的**槽位号**，返回语义层的 `{chunkIndex, vertexIndex}`；
 * 越界/表已过期返回 null。定义在这里而不是 three/lodRenderer.ts，是因为
 * "Points 上挂什么"是本文件（拾取侧）的协议，lodRenderer 只是实现方之一。
 */
export type LodSlotResolver = (slot: number) => { chunkIndex: number; vertexIndex: number } | null

/** userData 上的槽位反查器键名。 */
const LOD_SLOT_KEY = 'lodSlot'

/** 读 `THREE.Points` 上的槽位反查器；非 LOD 显示层（分块 Points）返回 null。 */
export function readLodSlotResolver(points: THREE.Points): LodSlotResolver | null {
  const data = points.userData as Record<string, unknown> | undefined
  const resolver = data?.[LOD_SLOT_KEY]
  return typeof resolver === 'function' ? (resolver as LodSlotResolver) : null
}

/** 拾取候选：一块已加载且可见的分块点云。 */
export interface PickCandidate {
  entityId: number
  chunkIndex: number
  points: THREE.Points
  /** 该块包围球（世界空间），用于按实体估拾取阈值。 */
  centerWorld: THREE.Vector3
  radiusWorld: number
}

/**
 * 收集拾取候选：给定点云里**每个分块**一项（可见性由调用方先行过滤）。
 *
 * 逐分块而非逐实体，因为拾取阈值要按块估深度（见 pickVertex）。
 * 目标集合必须由调用方筛过可见性——Raycaster 不看 object.visible（Raycaster.js:236-260），
 * 这一步不能省：测量交互层与双击设旋转中心都传 pointcloudStore.getVisibleTargets()。
 * 名称标签 Sprite 等非 Points 子节点直接跳过（readPointsTag 也认不出它们）。
 *
 * 目标由参数注入、不在函数内取 store：本文件是"纯逻辑可单测"（单测跑在 node 环境，
 * 不碰 store），仓库既有先例见 utils/segmentSelection.ts 的 targets 形参。
 */
export function collectCandidates(targets: SegmentTarget[]): PickCandidate[] {
  const candidates: PickCandidate[] = []
  const box = new THREE.Box3()
  const size = new THREE.Vector3()
  for (const target of targets) {
    target.group.updateMatrixWorld(true)
    for (const child of target.group.children) {
      const points = child as THREE.Points
      if (!points.isPoints) continue
      // 分块级可见性必须在这里逐个判：Raycaster 不看 object.visible，而 LOD 实体的
      // 语义层分块是常驻 Group 但整片隐藏的（显示层接管渲染），不跳过就会退化成
      // 逐顶点扫描整云——正是 LOD 要根治的那个卡顿
      if (!points.visible) continue
      const tag = readPointsTag(points)
      if (!tag) continue
      const geometry = points.geometry
      // 块几何体的 boundingBox 由解析路径显式填好（pointcloudStore.applyBoundingVolumes）；
      // 缺失只可能出现在测试等旁路构造的场景，补算一次兜底
      if (geometry.boundingBox === null) geometry.computeBoundingBox()
      if (geometry.boundingBox === null) continue
      box.copy(geometry.boundingBox).applyMatrix4(points.matrixWorld)
      if (box.isEmpty()) continue // 空块（零顶点）的包围盒是 ±Infinity，会污染阈值
      candidates.push({
        entityId: tag.entityId,
        chunkIndex: tag.chunkIndex,
        points,
        centerWorld: box.getCenter(new THREE.Vector3()),
        radiusWorld: box.getSize(size).length() / 2,
      })
    }
  }
  return candidates
}

/** 拾取命中（索引一律是**顶点缓冲空间**下标，LOD 显示层的槽位号已在 pickVertex 内解掉）。 */
export interface PickHit {
  entityId: number
  chunkIndex: number
  vertexIndex: number
  /** 顶点显示坐标（position 属性原值）。 */
  local: THREE.Vector3
  /** 沿射线距离（用于跨实体比较前后）。 */
  distance: number
  /**
   * 命中的 `Points` 对象本身（分块 Points 或 LOD 显示层 staging）。
   * 调用方据此取 matrixWorld（世界坐标）——不能再按 (entityId, chunkIndex) 反查候选表：
   * 一次 LOD 命中对应的是显示层那一个节点，而不是某个真实分块。
   */
  points: THREE.Points
  /** 命中点的分类值（几何体无 classification 属性时为 null）。 */
  classification: number | null
}

/** 相机既非透视也非正交时的兜底垂直视场角（度）。 */
const FALLBACK_FOV_DEG = 50

/**
 * 本应用只有透视/正射两台相机（engine.ts 双相机并存、切换见 setProjection），
 * 但引擎对外暴露的是 THREE.Camera 基类——基类没有 near/far（在具体相机上）。
 * 拾取需要 near/far 做距离裁剪，故在此收口成联合类型。
 */
export type ViewerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera

/** 把引擎的 THREE.Camera 收窄为带 near/far 的具体相机（见 ViewerCamera 注释）。 */
export function toViewerCamera(camera: THREE.Camera): ViewerCamera {
  return camera as ViewerCamera
}

/**
 * 保证几何体有包围球（Points.raycast 的早退依赖它）。
 *
 * 2026-09 起解析路径已显式填好 boundingSphere（pointcloudStore.applyBoundingVolumes），
 * 所以正常加载的点云走不到这里；保留兜底是因为拾取是"一次点击、偶发 O(N)"的形态——
 * 千万级点云上现算一次就是几秒卡顿，多一层防护远比省几行值当。
 * 优先由已缓存的 boundingBox 推半对角线作保守球（比真实包围球略大，早退略放宽但不扫全量点）。
 */
export function ensureBoundingSphere(geometry: THREE.BufferGeometry): void {
  if (geometry.boundingSphere !== null) return
  if (geometry.boundingBox !== null) {
    const box = geometry.boundingBox
    const center = box.getCenter(new THREE.Vector3())
    geometry.boundingSphere = new THREE.Sphere(center, box.getSize(new THREE.Vector3()).length() / 2)
    return
  }
  geometry.computeBoundingSphere()
}

/**
 * 某个候选块的拾取阈值（世界单位），即把 pixelRadius 个像素换算成该块处的世界长度。
 *  - 正射：与深度无关，精确；
 *  - 透视：用包围球**远侧**作深度上界估计，偏大（保证不漏拾），命中后再由
 *    pickVertex 用实际深度精确化一次。
 */
export function pickThresholdWorld(
  camera: ViewerCamera,
  cssHeightPx: number,
  pixelRadius: number,
  centerWorld: THREE.Vector3,
  radiusWorld: number
): number {
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const cam = camera as THREE.OrthographicCamera
    return pixelRadius * worldPerPixelOrtho(cam.top, cam.zoom, cssHeightPx)
  }
  const cam = camera as THREE.PerspectiveCamera
  const fov = Number.isFinite(cam.fov) ? cam.fov : FALLBACK_FOV_DEG
  const depth = Math.max(cam.position.distanceTo(centerWorld) + radiusWorld, cam.near)
  return pixelRadius * worldPerPixelPerspective(fov, depth, cssHeightPx)
}

/**
 * 取交点数组中沿射线最近的一个。
 *
 * 必须自己比：Points.raycast 按**顶点缓冲顺序** push 命中（Points.js:132-153），
 * 而 Raycaster.intersectObject（单数）**不排序**——只有 intersectObjects（复数）
 * 才在末尾 sort（Raycaster.js:222）。少这一步取到的是缓冲里第一个落入锥内的点，
 * 不是屏幕上最靠前的点。
 */
function closestHit(hits: THREE.Intersection[]): THREE.Intersection | null {
  let best: THREE.Intersection | null = null
  for (const h of hits) {
    if (!best || h.distance < best.distance) best = h
  }
  return best
}

/**
 * 拾取一个顶点：逐候选块设置阈值后调用 Points.raycast，块内与跨块都按沿射线距离取
 * 最近（即前遮挡后，跨实体遮挡天然成立）。
 *
 * 逐块调用而非一次 intersectObjects 的原因：raycaster.params.Points.threshold 是全局值，
 * 而正确的屏幕像素窗口需要按块估深度。
 *
 * @param raycaster 已 setFromCamera 的射线器（本函数会改写其 near/far/threshold）
 * @returns 命中点；点空白/全部未命中返回 null
 */
export function pickVertex(
  raycaster: THREE.Raycaster,
  camera: ViewerCamera,
  candidates: PickCandidate[],
  cssHeightPx: number,
  pixelRadius = PICK_RADIUS_PX
): PickHit | null {
  raycaster.near = camera.near
  raycaster.far = camera.far

  let bestPoints: THREE.Points | null = null
  let bestHit: THREE.Intersection | null = null
  let bestEntityId = 0
  let bestChunkIndex = 0

  for (const c of candidates) {
    ensureBoundingSphere(c.points.geometry)
    const threshold = pickThresholdWorld(camera, cssHeightPx, pixelRadius, c.centerWorld, c.radiusWorld)
    raycaster.params.Points.threshold = threshold

    const coarse: THREE.Intersection[] = []
    raycaster.intersectObject(c.points, false, coarse)
    let hit = closestHit(coarse)
    if (!hit) continue

    // 透视下粗阈值按包围球远侧估、偏大，用最近命中的实际深度精确化后重拾一次
    const cam = camera as THREE.PerspectiveCamera
    if (cam.isPerspectiveCamera) {
      const precise = pixelRadius * worldPerPixelPerspective(cam.fov, Math.max(hit.distance, cam.near), cssHeightPx)
      if (precise < threshold) {
        raycaster.params.Points.threshold = precise
        const fine: THREE.Intersection[] = []
        raycaster.intersectObject(c.points, false, fine)
        hit = closestHit(fine) ?? hit
      }
    }

    if (!bestHit || hit.distance < bestHit.distance) {
      bestHit = hit
      bestPoints = c.points
      bestEntityId = c.entityId
      bestChunkIndex = c.chunkIndex
    }
  }

  if (!bestHit || !bestPoints || bestHit.index === undefined) return null
  const hitIndex = bestHit.index
  const geometry = bestPoints.geometry
  const position = geometry.getAttribute('position')
  // 顶点位置必须回读属性：intersects[i].point 是射线上的最近点，不是顶点本身。
  // bestHit.index 此刻仍是"该 Points 自己的下标"（分块 = 顶点缓冲下标，显示层 = 槽位号），
  // 而两种几何体的 position 都按这个下标排布，故这一行在两条路径上都对
  const local = new THREE.Vector3().fromBufferAttribute(position as THREE.BufferAttribute, hitIndex)
  // 分类同样按"该 Points 自己的下标"读（显示层的 classification attribute 是按槽位排布的，
  // 换成顶点缓冲下标去读会读到别的点）——必须在下面反查之前取
  const clsAttr = geometry.getAttribute('classification')
  const classification = clsAttr ? clsAttr.getX(hitIndex) : null

  // LOD 显示层：把槽位号反查回语义层下标；表过期则整体落空（宁可拾不到，不可拾错点）
  const resolver = readLodSlotResolver(bestPoints)
  let chunkIndex = bestChunkIndex
  let vertexIndex = hitIndex
  if (resolver) {
    const resolved = resolver(hitIndex)
    if (!resolved) return null
    chunkIndex = resolved.chunkIndex
    vertexIndex = resolved.vertexIndex
  }

  return {
    entityId: bestEntityId,
    chunkIndex,
    vertexIndex,
    local,
    distance: bestHit.distance,
    points: bestPoints,
    classification,
  }
}

/**
 * 世界坐标 → 容器 CSS 像素（浮动标签/引线用）。
 *
 * 相机背后（w≤0，透视）或落在近远平面之外（|ndc.z|>1，正射 w≡1 同样适用）返回 null，
 * 调用方据此隐藏标签——与 CC 在点跑出视锥时不画标签一致。
 * 必须在 renderer.render 之后调用（matrixWorldInverse 由 render 刷新）。
 */
export function projectWorldToScreen(
  world: Vec3,
  camera: THREE.Camera,
  cssWidthPx: number,
  cssHeightPx: number
): { x: number; y: number } | null {
  const v = new THREE.Vector4(world.x, world.y, world.z, 1)
  v.applyMatrix4(camera.matrixWorldInverse) // 世界 → 视图
  v.applyMatrix4(camera.projectionMatrix) // 视图 → 裁剪
  if (v.w <= 0) return null
  const nz = v.z / v.w
  if (nz < -1 || nz > 1) return null
  return {
    x: ((v.x / v.w) * 0.5 + 0.5) * cssWidthPx,
    y: (1 - ((v.y / v.w) * 0.5 + 0.5)) * cssHeightPx,
  }
}
