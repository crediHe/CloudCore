import * as THREE from 'three'
import { ref, watch } from 'vue'
import { usePly } from '../composables/usePly'
import { useLas } from '../composables/useLas'
import { useViewerStore } from './viewerStore'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { useProgressStore } from './progressStore'
import type { EntityBBox, SceneEntity, TreeObject } from './sceneStore'
import type { PlyFileInfo } from '../../shared/types/ply'
import type { LasFileInfo } from '../../shared/types/las'
import { LAS_POINT_SOURCE_ID_OFFSETS, LAS_RGB_OFFSETS } from '../../shared/types/las'
import { buildScalarColors, className } from '../utils/classColors'
import { partitionVisibleByClass } from '../utils/classSplit'
import { rewriteVisibleClass } from '../utils/classEdit'
import { decodeLasRgb } from '../utils/lasColor'
import { resolveColorMode } from '../utils/colorMode'
import { derivedLabelColors, labelColor } from '../utils/labelColors'
import { mergeProductName } from '../utils/objectIdentity'
import { linearToSrgbU8, srgbToLinear, srgbU8ToLinear } from '../utils/srgb'
import { buildSaveBatch, maxClassificationOf, visibleCountOf, type SaveBatch } from '../utils/pointcloudSave'
import type { ChunkSelection, SegmentTarget } from '../utils/segmentSelection'
import type { PointsTag } from '../utils/measure'
import type { RadiusFilterChunkSource } from '../utils/radiusFilter'
import { candidateCountOfChunk } from '../utils/radiusFilter'
import { composePreviewPose, type PreviewPose } from '../utils/registration'
import {
  NULL_NORM_CODE,
  buildNormalLut,
  invertNormalCode,
  normalCodeToRgbLinear,
  scatterNormalCodes,
} from '../utils/normalEstimate'
import { createLodDisplay, disposeLodDisplay, type LodDisplay } from '../three/lodRenderer'
import { createLodTreeState } from '../three/lodTraversal'
import { invalidateLodDisplay, trackLodDisplay, untrackLodDisplay } from '../three/lodScheduler'
import { LodTreeBuildError, cancelLodTree, enqueueLodTree } from '../three/lodTreeBuilder'
import type { LodOctreeChunkSource } from '../utils/lodOctree'
import {
  ELEVATION_BINS,
  elevationAxis,
  fillElevationColors,
  getElevationLut,
  histogramOfZ,
  normalizeElevationRange,
  type ElevationAxis,
  type ElevationHistogram,
} from '../utils/elevation'

/** 多片拆分中的单片定义（TreeIso 单木分割产物等用，见 splitEntityMany）。 */
export interface SplitPart {
  /** 产物完整显示名（如 `Tree 1` / `xxx.noise`）。 */
  name: string
  /** 逐块该部分的顶点下标（顶点缓冲空间，递增；null = 该块无此部分顶点）。 */
  chunkIndices: (Uint32Array | null)[]
  /** 产物归属树项容器 id（TreeIso 树实体）；省略 = 直挂项目顶层（残点等非树产物）。 */
  groupId?: number
  /** 树木属性（仅单木分割树实体非 null；默认 null，见 sceneStore.buildEntity）。 */
  treeObject?: TreeObject | null
}

/**
 * 实体的整体变换（配准用）：**`P' = s·(R·P) + T`**，与 native/上游 `ScaledTransformation` 同约定。
 *
 * 两条容易写反的地方：
 * 1. `matrix` 的平移列就是 T 本身，而 three 的合成序是 `matrix = T·R·S`（平移最后生效），
 *    所以作用在点上**必须先乘 s 再 applyMatrix4**：`P·s → applyMatrix4(M)` ⇒ `R·(s·P) + T` ✓。
 *    反过来（先 applyMatrix4 再乘 s）得到 `s·R·P + s·T`——T 被多缩放了一次，s ≠ 1 时偏差
 *    `(s−1)·T`，肉眼可见（警告同样写在 utils/registration.ts#applyEntityTransformToPoint）。
 * 2. `scale` **刻意不并进 matrix**：预览是"四元数 + position + scale"三个分量写进实体 Group
 *    （three 的 T·R·S 合成序天然表达这个约定），烘焙是按公式逐点算，两处都不需要含缩放的矩阵。
 */
export interface EntityTransform {
  /** R（行主序语义，three 内部列主序存储）+ 平移列 T。 */
  matrix: THREE.Matrix4
  /** 均匀缩放（`adjustScale` 关时恒 1）。 */
  scale: number
}

/** 名称标签尺寸基准相对包围盒半径的比例（标签缩放 = 该基准 ×12，见 applyShowName）。 */
const LABEL_SIZE_RATIO = 0.002

/** 点精灵默认尺寸（屏幕像素）。 */
const DEFAULT_POINT_PIXELS = 2

/**
 * CC 式像素点渲染说明：
 * 材质走不透明硬边点精灵（sizeAttenuation=false，size 单位 = 屏幕像素，见
 * buildPointsGroup），无贴图、无透明混合——小尺寸下肉眼即"点"，缩放不膨胀、
 * 颜色干净，性能最优（不透明管线 + Early-Z）。旧的大圆点方案（径向渐变贴图 +
 * transparent 混合）因放大显脏、有混合开销已弃用。点大小由实体 pointSize 档位
 * （1-16px，默认 1，见 sceneStore）经 applyPointSize 直接映射。
 */

/** 分块加载进度回调参数。 */
export interface LoadProgress {
  progress: number
  currentChunk: number
  totalChunks: number
  status: string
  message: string
}

/** 计划里的一块：块下标 + 该块**可见点数**（空块不入表）。 */
export interface SavePlanChunk {
  /** 块下标（供 getSaveBatch 使用）。 */
  index: number
  /** 该块可见点数（> 0，即 geometry.index 长度或顶点数）。 */
  points: number
}

/**
 * 「另存为」计划：一个实体写盘所需的全部元信息（**不含点数据本身**，逐块数据由
 * getSaveBatch 现取）。渲染侧据此发起 save-begin 并按块号 + 偏移遍历。
 */
export interface SavePlan {
  /** 待存块（按块序；空块已跳过）。 */
  chunks: SavePlanChunk[]
  /** 待存点总数（= 各块**可见点数**之和，即写进文件头部的点数）。 */
  totalPoints: number
  /** 是否带颜色（决定 LAS 点格式：有 → 3，无 → 0）。 */
  hasColor: boolean
  /** **原始坐标**包围盒（= 显示坐标 + basePoint；LAS 的 scale/offset 规划用）。 */
  bbox: EntityBBox
  /**
   * 全局基准点：写盘坐标 = 内存中的显示坐标 + 它。
   *
   * 取 **rec.globalShift**（加载时逐点减去的那个快照）而非模块级 basePoint：
   * 两者应当相等，但坐标与包围盒必须与"当初减掉的那个值"严格配对，
   * 用快照才能保证"加回去"精确复原文件原始坐标。
   */
  basePoint: { x: number; y: number; z: number }
}

/**
 * 全局共享基准点（首块点云包围盒中心，double 精度）。
 *
 * 所有点云在解析时统一减去它（在 double→Float32 转换前，避免大地坐标
 * 在 1e6 量级丢失 Float32 精度），因此多块点云保持真实相对位置而不会
 * 全部堆积在原点。模块级单例：删除首块后重新加载其他点云时依然沿用，
 * 即"基准点保留"。
 */
let basePoint: THREE.Vector3 | null = null

/** 读取当前全局基准点（null 表示尚未设置，即还没加载过任何点云）。 */
export function getBasePoint(): THREE.Vector3 | null {
  return basePoint
}

/**
 * 单块点云解析结果：几何体 + 该块有效点的包围盒（文件原始坐标）+ 有效点数。
 */
interface ParsedChunk {
  geometry: THREE.BufferGeometry
  bbox: EntityBBox | null
  pointCount: number
}

/**
 * 把 TypedArray 截断到实际写入的长度；长度已相等时**直接返回原数组**（零拷贝）。
 *
 * 解析时统一按"读入点数"预分配、按"有效点数 w"写入，无 NaN 的正常路径下
 * `w === 读入点数`，四个数组都恰好用满。此前的 `.slice(0, w * n)` 在正常路径下
 * 是一次纯粹的白拷贝——1 亿点合计约 1.1 GB 的瞬时内存峰值与拷贝耗时。
 */
function truncateTo<T extends Float32Array | Uint8Array | Uint16Array>(arr: T, length: number): T {
  return arr.length === length ? arr : (arr.slice(0, length) as T)
}

/**
 * 按**显示坐标系**（已减基准点）的 min/max 显式填好几何体的 boundingBox 与 boundingSphere。
 *
 * 必须显式填：three r185 的视锥剔除（`Frustum.intersectsObject`）对 Points 走
 * `geometry.boundingSphere` 分支（Points 自身没有 boundingSphere 属性），为 null 时
 * 当场 O(N) 现算；`Points.raycast` 同样先取它做距离早退。1 亿点的现算会卡死数秒
 * ——比不开剔除更糟。而解析时 min/max 本就免费算过，这里只是转成 three 的包围体结构。
 *
 * 球心取盒中心、半径取盒半对角线：O(1) 且保守（宁可多画，不可误剪），
 * 与 three 自己的 computeBoundingSphere（盒中心 + 最远顶点距离）同量级。
 */
function applyBoundingVolumes(
  geometry: THREE.BufferGeometry,
  min: [number, number, number],
  max: [number, number, number]
) {
  const dx = (max[0] - min[0]) / 2
  const dy = (max[1] - min[1]) / 2
  const dz = (max[2] - min[2]) / 2
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2])
  )
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(min[0] + dx, min[1] + dy, min[2] + dz),
    Math.sqrt(dx * dx + dy * dy + dz * dz)
  )
}

/**
 * 一串坐标（**显示坐标**）在给定顶点集上的包围盒；无有效顶点时返回 null。
 *
 * `index` 传 `geometryVisibleIndex(geo)` 的结果（null = 全量顶点）。
 *
 * 为什么要"可见顶点集"而不是"整条 position 缓冲"：实体元数据的 bbox 语义是
 * **自己那部分点**的范围——splitEntity / splitByClassification / splitEntityMany 都是
 * 逐子集算的。而分割产物（`<名称>.plane` 这类）恰恰是配准的常见输入，若拿母集全量顶点
 * 算，标签会飘到母云中心、属性面板的范围也整个胀大一圈。
 * （`geo.boundingBox` 相反：它服务视锥剔除与射线早退，"宁大勿小"，故按全量顶点填。）
 */
function visibleBBoxOf(positions: Float32Array, index: Uint32Array | null): EntityBBox | null {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  if (index) {
    for (let k = 0; k < index.length; k++) {
      const p = index[k] * 3
      const x = positions[p]
      const y = positions[p + 1]
      const z = positions[p + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
  } else {
    for (let p = 0; p < positions.length; p += 3) {
      const x = positions[p]
      const y = positions[p + 1]
      const z = positions[p + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

/**
 * 空块（读入 0 点，或整块都是 NaN 无效点）。
 * 仍给一个退化到原点的包围体：视锥剔除遇 boundingSphere === null 会走现算分支，
 * 而空几何体的现算会产出 NaN 半径并刷警告。
 */
function emptyParsedChunk(): ParsedChunk {
  const geometry = new THREE.BufferGeometry()
  // 包围盒留**空**（默认 Box3 即空）：measure 的 collectCandidates 靠 isEmpty 跳过空块
  geometry.boundingBox = new THREE.Box3()
  // 包围球只需非 null（null 会让视锥剔除走进 computeBoundingSphere 现算并刷 NaN 警告），
  // 退化到原点半径 0 即可——空块本来就没有顶点可画
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0)
  return { geometry, bbox: null, pointCount: 0 }
}

/**
 * 每块点云的渲染状态留存（entityId → 记录）。
 *
 * 注意：这是普通 Map，绝不放进 reactive() —— Vue 深度代理 THREE 对象
 * （typed array / 内部缓存）会拖慢甚至破坏渲染，因此只做"读 reactive 字段 → 写 three 对象"。
 * SceneEntity 中只存可序列化元数据。
 */
interface CloudRecord {
  group: THREE.Group
  material: THREE.PointsMaterial
  geometries: THREE.BufferGeometry[]
  /** 原始 RGB 颜色 attribute 引用（本来就被 THREE.Points 持有，零额外成本）。 */
  rgbColorAttrs: (THREE.BufferAttribute | null)[]
  /** 标量着色的颜色 attribute（懒构建；Uint8 归一化，38M 点约 114MB）。 */
  scalarColorAttrs: (THREE.BufferAttribute | null)[] | null
  /**
   * 法向量着色的颜色 attribute（懒构建；Uint8 归一化）。与标量色同形，但**只依赖
   * geometry 上的 `normalCode` 属性**（视无关），因此在码未变时可靠共享——
   * 分割产物的两个子记录直接继承源列表实例（见 splitEntity）。
   * 任何会改码的操作（重算 / 反转 / 清除）都必须把本字段置 null 换装，绝不原地改色。
   */
  normalColorAttrs: (THREE.BufferAttribute | null)[] | null
  /**
   * 高程着色的颜色 attribute（懒构建；Uint8 归一化，见 utils/elevation.ts）。
   *
   * 与前两套的差别在**依赖**：它是 `(positions, lo, hi)` 的函数，而 `lo/hi` 是用户在
   * 属性面板拖出来的范围（SceneEntity.elevationRange，显示坐标）——范围一变，同一顶点的
   * 颜色就变。由此两条纪律：
   *  - **键控共享**：`key` 记下构建时的范围，安装前逐字比对；分割产物继承范围时可整对象
   *    零拷贝沿用它（理由同 normalColorAttrs 的共享：全量缓冲、每顶点数据），范围不同则
   *    比对失败、懒建自己的。
   *  - **绝不原地改色**：改范围一律新分配数组换装（setEntityPreviewColors 的纪律），
   *    于是兄弟实体的失效互不干扰。唯一会原地改写坐标的路径 bakeEntityTransform
   *    必须显式置 null——坐标变了而颜色没变，画面会"色带整体错位"且不报错。
   */
  elevationColor: { key: string; attrs: (THREE.BufferAttribute | null)[] } | null
  /** 高程色构建在飞（拖拽期的并发合并用，见 ensureElevationColors）。 */
  elevationBuilding?: boolean
  /** 当前 geometry 里装的是哪套颜色 attribute。 */
  colorAttrState: 'rgb' | 'scalar' | 'normal' | 'elevation'
  /**
   * **分割色**（单木分割 / 欧式聚类产物的逐株逐簇纯色；`ColorMode` 的 `label` 取值）。
   *
   * 与上面几套颜色 attribute 的根本差别：产物是**单色**的，所以它不占顶点缓冲——
   * 一个实体一个值，存在**材质**上（`material.color` + `vertexColors = false`，见
   * applyColorMode 的 label 分支）。三条理由，缺一条都会做成另一副样子：
   *  1. **内存**：逐点数组必须按**全量顶点数**分配（产物零拷贝共享母云顶点缓冲，
   *     count 保持全量，见 buildIndexedGeometry），于是 K 个产物 = K 倍母云大小——
   *     2000 个簇就是 2000 倍，静默 OOM；纯色是 O(1)。这也是把旧实现
   *     （`paintEntitySolidColor` 逐块 new Uint8Array(count*3)）换掉的原因。
   *  2. **原始 RGB 不动**：逐点方案要占掉 `rgbColorAttrs` 那一格，而 `getSaveBatch`
   *     正是读它 ⇒ 产物导出变纯色、切回 RGB 也是纯色。材质方案完全不碰它：产物切回
   *     rgb 看到/导出的都是原始真彩色。
   *  3. **批量切换**：多选一批产物切着色只改元数据、不动缓冲（属性面板的批量入口），
   *     O(1)/实体。
   * 值为**线性 0-1**（`material.color.set` 要求线性空间，同顶点色，见 utils/srgb.ts）；
   * null = 该实体没有分割色（`.noise` / `.remaining` / 合并产物 / 普通加载的云），
   * 此时 `label` 意图会被 resolveColorMode 退回 rgb。
   */
  labelColor: { r: number; g: number; b: number } | null
  /**
   * **预览色**旁路通道（欧式聚类预览等"整片染色"型预览用）：非 null 时 applyColorMode
   * 优先装它，与 `colorAttrState` 无关、也不改写 `colorAttrState`
   * ——于是退出预览能按原状态装回规范色（见 setEntityPreviewColors）。
   * 逐块 Uint8 线性色（长度 = 该块顶点数 × 3，`null` 块跳过）。
   * 刻意是可选字段：它是**会话态**，不随分割/合并传给子记录（子记录装自己的纯色）。
   */
  previewColors?: (THREE.BufferAttribute | null)[] | null
  /**
   * 该实体是否带法向量（`normalCode` 属性，2 字节量化码，长度 = 顶点数）。
   * 与 `hasColor` 同属"数据能力"标志：Normal RGB 着色选项的可用性看它。
   */
  hasNormals: boolean
  /** 名称标签尺寸基准：max(包围盒半径 × LABEL_SIZE_RATIO, 0.01)，加载时算好。 */
  labelBaseSize: number
  bbox: EntityBBox
  pointCount: number
  hasColor: boolean
  globalShift: { x: number; y: number; z: number }
  /** 3D 名称标签（懒创建）。 */
  label: THREE.Sprite | null
  /**
   * LOD 显示层（每实体一个"每帧预算"大小的 staging Points，见 three/lodRenderer.ts）。
   * null = 该实体走 per-chunk Points 直绘路径。
   *
   * 建立与释放**只动显示层自有的 staging 几何体**（语义层的 attribute 跨实体共享，
   * 谁都不许 dispose），因此运行期切换（属性面板改 lodEnabled、建树环境级失败回退）
   * 是安全的；唯一要守的纪律是别去释放共享对象。
   */
  lod: LodDisplay | null
  /**
   * 该实体已判定"LOD 建树这条路不可走"（原生模块缺失 / IPC 失败）。
   * 置位后 shouldUseLod 恒假——避免每次同步都重建显示层再失败一遍的抖动循环。
   */
  lodUnavailable?: boolean
}

const cloudRecords = new Map<number, CloudRecord>()

/**
 * 分割预览期间强制可见的实体 id 集合。
 * 预览要看清"显示的一半"，若用户在树里勾掉目标点云会被整体隐藏；
 * syncAllToThree 遇到集合内的实体一律强制可见，退出预览时移出集合再重新同步。
 */
const previewForcedIds = new Set<number>()

/**
 * 「该 position 缓冲被多个实体零拷贝共享」的登记表。
 *
 * **唯一登记点**是 buildIndexedGeometry —— 分割/合并产物与源实体指向**同一个
 * Float32Array**。配准烘焙（bakeEntityTransform）原地改写坐标前必须查这张表：命中即
 * 新分配数组换装，否则改的是**共享的那一份**，兄弟实体的坐标跟着一起被改掉——
 * 无报错、无日志、画面直接错位，事后极难定位。
 *
 * 存数组实例本身（而非 id）有两个好处：合并把来源记录删掉后无需清理，且"同一个缓冲被
 * 谁共享"这种关系天然跟着缓冲走（A 分割出 B、B 又被合并进 C，链条上每一环看到的都是
 * 同一个实例）。用 WeakSet 是免得给已死的缓冲留一条永久引用。
 */
const sharedPositionBuffers = new WeakSet<Float32Array>()

/**
 * 预览变换的**基准位姿**快照（entityId → 首次预览时 Group 的 T·R·S 三分量）。
 *
 * 还原走"按快照写回"而不是"再乘一个逆矩阵"：后者会累积浮点误差，且要求 M 严格可逆。
 * 基准**只在首次预览时取一次**——同一实体连续预览两次是"换个 M"，若第二次以当前
 * （已含 M 的）位姿为基准，还原就会还原到中间态。
 * 刻意不进 reactive：THREE 对象进 deep proxy 会拖垮渲染。
 */
const previewBaselines = new Map<number, PreviewPose>()

/**
 * 分类数据修订号（ref 仅作失效信号，不承载数据）：
 * 属性面板的分类统计以它为依赖触发重算（getClassificationStats 是普通函数，
 * setEntityClassification 改写分类后 bump 一次即可让面板自动刷新）。
 */
const classificationRevision = ref(0)

/**
 * 法向量数据修订号（ref 仅作失效信号，不承载数据）：属性面板的法向量读数
 * （已算 / 为空点数）以它为依赖触发重算。估计完成、反转、清除各 bump 一次。
 * 与 classificationRevision 同构。
 */
const normalsRevision = ref(0)

/**
 * 可见集修订号（ref 仅作失效信号）：属性面板的高程分布图以它为依赖触发重算。
 * 与 classificationRevision 的区别在于触发源——前者由**写分类**显式 bump，
 * 本项由 `setChunkVisibility`（预览）与 updateEntityMeta（提交）两侧一起覆盖：
 * 前者改可见集但不走元数据，后者改 pointCount / bbox，两者都会让直方图过期。
 */
const elevationRevision = ref(0)

/**
 * 高程分布图的一槽缓存（非响应式：直方图是 256 个数的 TypedArray，进 reactive 只会被
 * 深层代理拖慢）。键含实体 id，故换选中项必然重算——见 getElevationHistogram 的戳。
 */
let elevationHistogramCache: { key: string; result: ElevationHistogram } | null = null

const { getAllEntities } = useSceneStore()

/**
 * 请求重绘一帧（引擎按需渲染，机制见 three/engine.ts 的 requestRender 注释）。
 *
 * three 对象没有变更通知，凡是**直接写** three 对象的地方——可见性、attribute 换装、
 * drawRange、material、scene.add/remove——都要调它一次，否则画面停在旧状态。
 * 本文件已把绝大多数写入收敛到 syncAllToThree()（改一处即全覆盖），
 * 剩下的几处直写（预览索引、强制可见、纯色换装、资源释放）各自显式调用。
 */
function requestRender() {
  useViewerStore().getViewer()?.requestRender()
}

/* ---------------------------------------------------------------------------
 * LOD 显示层的阈值分流与生命周期
 * ------------------------------------------------------------------------- */

/**
 * 阈值分流判据（对齐 CC 的 minLoDCloudSize 思路但取更小值：CC 默认 5 千万，
 * 那对本应用的显存与绘制成本来说太晚）。任一成立即对**该实体**启用显示层：
 *
 *  - 单实体 ≥ 100 万点：显存省得最直接（24 B/点 → 恒定 ~15 MB）；
 *  - 全局 ≥ 400 万点：单块都不大、但加起来很多时的总账；
 *  - 实体数 ≥ 32：绘制调用数由"实体 × 分块"压到"实体"，多片产物（TreeIso 上百棵
 *    树、按分类拆分）不至于把 draw call 打爆。
 *
 * 判据在**实体创建时一次性定死**（见 registerCloudRecord），之后绝不中途切换。
 * 于是小点云的拾取 / 预览 / 分割行为完全不变，LOD 是纯增量路径，回归面收窄到
 * "确实很大"的那类数据。
 */
const LOD_MIN_ENTITY_POINTS = 1_000_000
const LOD_MIN_TOTAL_POINTS = 4_000_000
const LOD_MIN_ENTITY_COUNT = 32

/** 值得为它弹进度条的规模（八叉树建树期间显示进度；小实体静默建树，见 requestLodTree）。 */
const LOD_PROGRESS_MIN_POINTS = 10_000_000

/**
 * 该实体是否走显示层路径（在记录**已进** cloudRecords 之后调用）。
 *
 * 内存上界：显示层占用 = Σ min(该实体可见点数, 每帧预算) × 29 B（三个 attribute 各
 * 一项）。单实体判据下最坏 512K × 29 B ≈ 15 MB；聚合判据下与语义层同量级（最坏约
 * 2 倍）。八叉树另有 4 B/点的 pointIds，由 lodTreeBuilder 的 LOD_TREE_MEMORY_BUDGET
 * 单独把关。
 *
 * 除自动判据外还看实体的 `lodEnabled`：`always` 强制启用、`never` 强制直绘
 * （对齐 CC 每片点云上的 "Enable LoD" 勾选框；`never` 是排查渲染问题的开关）。
 * 属性面板改这一项后经 syncAllToThree → applyLodPolicy 立即生效（建/拆显示层都只
 * 动显示层自有的 staging 几何体，不碰跨实体共享的语义层 attribute，故中途切换安全）。
 */
function shouldUseLod(rec: CloudRecord, entity: SceneEntity | undefined): boolean {
  if (rec.lodUnavailable) return false // 环境级失败（native 产物缺失）已判定，不再重试
  const mode = entity?.lodEnabled ?? 'auto'
  if (mode === 'never') return false
  if (mode === 'always') return true
  if (rec.pointCount >= LOD_MIN_ENTITY_POINTS) return true
  if (cloudRecords.size >= LOD_MIN_ENTITY_COUNT) return true
  let total = 0
  for (const r of cloudRecords.values()) total += r.pointCount
  return total >= LOD_MIN_TOTAL_POINTS
}

/**
 * 给实体挂上显示层（不满足条件时什么都不做）。
 *
 * 挂上后语义层的 per-chunk `Points` **不再参与渲染**（staging 承载全部可见点）。
 * 刻意只是 `visible = false` 而不从 Group 里摘掉：分割预览要瞬时切回旧路径
 * （见 setChunkVisibility 的预览回退），而 three 的 projectObject 对不可见对象
 * 提前 return，留着不产生任何绘制成本。
 */
function attachLodDisplay(entity: SceneEntity | undefined, rec: CloudRecord) {
  if (!entity || rec.lod) return
  if (!shouldUseLod(rec, entity)) return
  const display = createLodDisplay(rec.geometries, rec.material, entity.id)
  if (!display) return
  rec.lod = display
  for (const child of rec.group.children) {
    if ((child as THREE.Points).isPoints) child.visible = false
  }
  rec.group.add(display.points)
  trackLodDisplay(display)
  requestLodTree(display, rec, entity)
}

/**
 * 异步送建八叉树（不阻塞首帧显示：显示层建好即已填好等距取样，见 lodRenderer）。
 *
 * 回调里的**时效校验不可省**：建树期间实体可能已被删除、分割、合并，或用户在属性
 * 面板里关掉了 LOD —— 结果必须装回"当初那个显示层对象"，否则就是把节点表写进一个
 * 已从场景摘除的对象（白占内存，且反查会指向错误的点）。
 */
function requestLodTree(display: LodDisplay, rec: CloudRecord, entity: SceneEntity) {
  const chunks: LodOctreeChunkSource[] = []
  for (const g of rec.geometries) {
    const positions = g.getAttribute('position')
    if (!positions) continue
    // 零拷贝：直接把语义层几何体的底层数组交给 native（Napi::Persistent 钉住）
    chunks.push({
      positions: positions.array as Float32Array,
      index: g.index ? (g.index.array as Uint32Array) : null,
    })
  }
  if (chunks.length === 0) return

  const entityId = display.entityId
  const log = useConsoleStore().log
  // 只有大实体值得弹进度条：TreeIso 一次切出上百棵树，逐棵弹会把进度条刷爆
  const task =
    rec.pointCount >= LOD_PROGRESS_MIN_POINTS
      ? useProgressStore().start({
          title: '构建 LOD 八叉树',
          message: `「${entity.name}」${rec.pointCount.toLocaleString()} 点`,
        })
      : null

  enqueueLodTree(entityId, rec.pointCount, chunks, {
    onProgress: (_id, overall) => {
      task?.update(Math.round(overall * 100))
    },
    onReady: (id, result) => {
      task?.done()
      const current = cloudRecords.get(id)
      if (!current || current.lod !== display) return // 已过期（实体被删除/分割/重挂）
      display.tree = createLodTreeState(result)
      invalidateLodDisplay(display) // 下一帧起按树取点（树未就绪时是等距取样回退）
      requestRender()
      log('LOD', `「${entity.name}」八叉树就绪：${result.nodeCount.toLocaleString()} 节点`)
    },
    onFailed: (id, error) => {
      const current = cloudRecords.get(id)
      if (!current || current.lod !== display) return
      if (error instanceof LodTreeBuildError && error.kind === 'unavailable') {
        // 环境级失败（没编译 native / 产物缺失）：显示层这条路走不通，退回语义层直绘。
        // 若不退，用户看到的是一朵"被抽稀过的云"——比慢更糟（数据看着少了）。
        task?.fail(error.message)
        releaseLod(current)
        rec.lodUnavailable = true
        log('LOD', `原生模块不可用，该实体回退全量渲染：${error.message}`)
        return
      }
      // 预算/算法失败：保持等距取样回退（每帧成本仍与点数解耦），只记日志
      task?.fail(error.message)
      log('LOD', `八叉树未建成，「${entity.name}」保持取样显示：${error.message}`)
    },
  })
}

/** 语义层着色源换装后把显示层重取一遍（显示层是拷贝而非引用，见 lodRenderer）。 */
function refreshLod(rec: CloudRecord) {
  if (rec.lod) invalidateLodDisplay(rec.lod)
}

/**
 * 释放显示层：停调度、取消在飞建树、恢复语义层直绘。
 * 材质与语义层共用**不能**在这里释放；staging 几何体是显示层自有的，随手释放安全
 * （分割/合并的产物共享的是语义层几何体，与 staging 无关）。
 */
function releaseLod(rec: CloudRecord) {
  const display = rec.lod
  if (!display) return
  untrackLodDisplay(display)
  cancelLodTree(display.entityId)
  disposeLodDisplay(display)
  rec.lod = null
  // 语义层的 per-chunk Points 恢复参与渲染（挂显示层时被按下了）
  for (const child of rec.group.children) {
    if ((child as THREE.Points).isPoints) child.visible = true
  }
}

/**
 * 登记渲染状态：唯一的写入口。所有建档路径（加载 / 合并 / 三种分割）都走它，
 * 于是"阈值分流在实体创建时定死"这条约定有了单一落点（属性面板的 lodEnabled 是
 * 唯一的运行期例外，经 applyLodPolicy 生效）。
 */
function registerCloudRecord(entityId: number, rec: CloudRecord) {
  cloudRecords.set(entityId, rec)
  attachLodDisplay(
    getAllEntities().find((e) => e.id === entityId),
    rec
  )
}

/**
 * 应用实体的 LOD 开关（属性面板的三态，见 shouldUseLod）。建/拆都只动显示层自有的
 * staging，不触碰跨实体共享的语义层 attribute，因此运行期切换是安全的。
 */
function applyLodPolicy(rec: CloudRecord, entity: SceneEntity) {
  const want = shouldUseLod(rec, entity)
  if (want && !rec.lod) {
    attachLodDisplay(entity, rec)
    requestRender()
  } else if (!want && rec.lod) {
    releaseLod(rec)
    requestRender()
  }
}

/**
 * 模块级单向同步：sceneStore 的 UI 状态变更（树勾选 / 面板下拉）统一收敛到
 * 这里应用到 three 对象。依赖方向 pointcloudStore → sceneStore，无环。
 */
watch(
  () =>
    getAllEntities()
      .map(
        (e) =>
          // 高程范围必须进签名：拖手柄改的正是这两个数，漏了就是「拖了没反应、且无报错」
          `${e.id}|${e.name}|${e.visible}|${e.colorMode}|${e.hasNormals}|${e.pointSize}|${e.showNameIn3D}|${e.lodEnabled}|` +
          `${e.elevationRange?.min ?? ''}|${e.elevationRange?.max ?? ''}`
      )
      .join(';'),
  () => {
    void syncAllToThree()
  }
)

/** 把全部实体的 UI 状态应用到 three 对象（幂等；watch 与加载完成时调用）。 */
async function syncAllToThree() {
  for (const entity of getAllEntities()) {
    const rec = cloudRecords.get(entity.id)
    if (!rec) continue
    const wasVisible = rec.group.visible
    rec.group.visible = previewForcedIds.has(entity.id) || entity.visible
    if (wasVisible !== rec.group.visible && rec.lod) {
      // 隐藏期显示层不参与取点（相机可能动过、视锥标记作废），重新可见时要重取
      invalidateLodDisplay(rec.lod)
    }
    await applyColorMode(rec, entity)
    applyPointSize(rec, entity)
    applyShowName(rec, entity)
    applyLodPolicy(rec, entity)
  }
  // 本函数是"UI 状态 → three 对象"的唯一漏斗，在这里统一置脏即可覆盖
  // 勾选显隐 / 切着色方式 / 改点大小 / 名称标签，以及加载、分割、合并、删除后
  // 的收尾（那些路径末尾都会调一次本函数）
  requestRender()
}

/** 'none' 着色态的材质灰（0.7 线性灰，与旧实现逐位一致）。 */
const NONE_MATERIAL_GREY = { r: 0.7, g: 0.7, b: 0.7 }

/**
 * 材质里的**线性浮点**分割色 → **sRGB 字节**色（同族派生色的输入）。
 *
 * 两条色彩空间各有各的用处：材质存线性（GPU 要的），而 `derivedLabelColors` 的定义域是
 * sRGB 字节（与人眼/取色器一致，色相明度的语义才对）。两个换算是互逆的
 * （`setEntityLabelColor` 用 `srgbToLinear(c/255)`），故"切了再切"不会让颜色漂出色相族。
 */
function labelColorBytesOf(color: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  return { r: linearToSrgbU8(color.r), g: linearToSrgbU8(color.g), b: linearToSrgbU8(color.b) }
}

/** 单色通路的唯一入口：关顶点色 + 材质色 = 给定**线性**色（'none' 灰与 label 分割色共用）。 */
function setSolidMaterial(rec: CloudRecord, color: { r: number; g: number; b: number }) {
  if (rec.material.vertexColors) {
    rec.material.vertexColors = false
    rec.material.needsUpdate = true
  }
  rec.material.color.set(color.r, color.g, color.b)
}

/** 顶点色通路的唯一入口：开顶点色 + 材质色复位为白（乘法关系见 applyColorMode 的 ⚠）。 */
function setVertexColorMaterial(rec: CloudRecord) {
  if (!rec.material.vertexColors) {
    rec.material.vertexColors = true
    rec.material.needsUpdate = true
  }
  const c = rec.material.color
  if (c.r !== 1 || c.g !== 1 || c.b !== 1) c.set(1, 1, 1)
}

/**
 * 应用着色方式。
 * 'none'：关闭顶点色，材质色固定灰色；'rgb'：原始 RGB；'scalar'：分类色表；
 * 'normal'：法向量 RGB（`(N+1)/2` 静态烘焙，视无关）；
 * 'elevation'：高程色带（范围由属性面板拖动，是四者中唯一"内容会变"的着色态）。
 * 'label'：**分割色**（单木分割 / 欧式聚类产物的逐株逐簇纯色）——单色存在材质上，
 * 不装任何顶点色 attribute，故 RGB 字段/缓冲全程不动（见 CloudRecord.labelColor）。
 * 无颜色数据的云（hasColor=false）即使 UI 状态为 rgb 也按 none 渲染；无法向量的云
 * （hasNormals=false）的 normal 状态同样压为 none；没有分割色的实体的 label 意图退回
 * rgb（高程不依赖任何数据，无色云照样能按高程着色，故无此压档）。降级规则只有一份，
 * 见 utils/colorMode.ts#resolveColorMode。
 * 切换只做 attribute 引用交换（GPU 侧重新上传，几十 ms 量级），不复制缓冲。
 *
 * ⚠ **材质态与顶点色是两条互斥通路**（`vertexColors` 开关 + `material.color`）：
 * 顶点色是**乘**在 `material.color` 上的，所以走顶点色的三条分支必须把材质色复位为白，
 * 否则会残留上一层 'none' 的 0.7 灰或 label 的纯色，把 RGB / 分类色 / 法向量色整体染色
 * （这是旧实现漏掉的一处：从 None 切回 RGB 会一直偏暗）。两条通路各自只有一个入口
 * ——setVertexColorMaterial / setSolidMaterial。
 */
async function applyColorMode(rec: CloudRecord, entity: SceneEntity) {
  // 预览色优先，且**排在 vertexColors 开关之前**：预览是"参数试错的放大器"，
  // 连无色云（hasColor=false，着色被压为 none）也要看得见聚类边界。
  if (rec.previewColors) {
    setVertexColorMaterial(rec)
    installColorAttrs(rec, rec.previewColors)
    return
  }
  const hasLabelColor = rec.labelColor !== null
  const mode = resolveColorMode(entity.colorMode, {
    hasColor: rec.hasColor,
    hasNormals: rec.hasNormals,
    hasLabelColor,
  })
  if (mode === 'none') {
    setSolidMaterial(rec, NONE_MATERIAL_GREY)
    return
  }
  if (mode === 'label') {
    // 分割色：只改材质，几何体上那份（母云的）原始 RGB attr 原封不动留着
    // ——切回 rgb 即真彩色，导出也一样。无需 refreshLod：显示层的颜色字节本来就是
    // 从语义层现读的原始 RGB，与这里改的材质色无关（顶点色一关它就不参与采样）。
    // `?? 灰` 兜住"说是 label 却没有 labelColor"的破损态（当前调用契约下不可达：
    // hasLabelColor 恒等于 labelColor !== null），按 'none' 收场总好过把上一种
    // 着色留下的顶点色配白材质显示出来。
    setSolidMaterial(rec, rec.labelColor ?? NONE_MATERIAL_GREY)
    return
  }
  setVertexColorMaterial(rec)
  if (mode === 'scalar' && rec.colorAttrState !== 'scalar') {
    await ensureScalarColorAttrs(rec)
    // 复查：构建期间用户可能已切走（切回 rgb 等），此时不安装
    if (entity.colorMode === 'scalar' && rec.scalarColorAttrs) {
      installColorAttrs(rec, rec.scalarColorAttrs)
      rec.colorAttrState = 'scalar'
      refreshLod(rec) // 显示层是颜色字节的拷贝，换装后要重刷（'none' 分支无需：顶点色已关）
    }
  } else if (mode === 'normal' && rec.colorAttrState !== 'normal') {
    await ensureNormalColorAttrs(rec)
    if (entity.colorMode === 'normal' && rec.normalColorAttrs) {
      installColorAttrs(rec, rec.normalColorAttrs)
      rec.colorAttrState = 'normal'
      refreshLod(rec)
    }
  } else if (mode === 'rgb' && rec.colorAttrState !== 'rgb') {
    installColorAttrs(rec, rec.rgbColorAttrs)
    rec.colorAttrState = 'rgb'
    refreshLod(rec)
  }
  // 高程分支刻意**不按 colorAttrState 早退**：拖拽手柄时模式没变而颜色内容变了，
  // 早退会让画面纹丝不动（见 ensureElevationColors 的收敛式）。
  if (mode === 'elevation') {
    await ensureElevationColors(rec, entity)
    // 快速路径：键已就位（刚切回高程、范围没变）时上面什么都没做，这里补装一次
    if (entity.colorMode === 'elevation' && rec.elevationColor && rec.colorAttrState !== 'elevation') {
      installColorAttrs(rec, rec.elevationColor.attrs)
      rec.colorAttrState = 'elevation'
      refreshLod(rec)
    }
  }
}

/** 把一套颜色 attribute 逐块装进 geometry（跳过无属性的空块）。 */
function installColorAttrs(rec: CloudRecord, attrs: (THREE.BufferAttribute | null)[]) {
  rec.geometries.forEach((g, i) => {
    const attr = attrs[i]
    if (!attr) return
    g.setAttribute('color', attr)
    g.attributes.color.needsUpdate = true
  })
}

/** 按 `colorAttrState` 取该实体的"规范色"（撤预览色时要装回的就是它）。 */
function canonicalColorAttrs(rec: CloudRecord): (THREE.BufferAttribute | null)[] | null {
  if (rec.colorAttrState === 'scalar') return rec.scalarColorAttrs
  if (rec.colorAttrState === 'normal') return rec.normalColorAttrs
  if (rec.colorAttrState === 'elevation') return rec.elevationColor?.attrs ?? null
  return rec.rgbColorAttrs
}

/**
 * 实体当前生效的高程色带范围：`SceneEntity.elevationRange` 按该实体的**显示坐标**
 * 量程规整后的结果（显示坐标 = 原始 − globalShift，换算见 utils/elevation.ts）。
 *
 * 着色（本文件）与图表（ElevationChart.vue）都调它，故画面与读数恒一致；
 * 也是"继承来的范围在新实体上是否仍成立"的判断依据（轴变了 → 规整数值就变）。
 */
function elevationRangeOf(rec: CloudRecord, entity: SceneEntity): ElevationAxis {
  return normalizeElevationRange(elevationAxis(rec.bbox, rec.globalShift), entity.elevationRange)
}

/** 高程色的构建键：规整后的范围数值。键相同 ⟺ 两实体的高程色数组逐字节相同。 */
function elevationKeyOf(range: ElevationAxis): string {
  return `${range.min}|${range.max}`
}

/**
 * 构建高程色 attribute（逐块 + 每 8 块让出主线程，同 ensureScalarColorAttrs 的呼吸权）。
 *
 * 逐块读的是 geometry 上的 position **全量顶点**（不理会 index——颜色是"每顶点"数据，
 * 由 index/drawRange 决定显示哪批，与 ensureScalarColorAttrs / ensureNormalColorAttrs 同惯例）。
 * 范围外的点压成端点色（fillElevationColors 内 clamp，对齐 CC 的 SF 显示参数）。
 */
async function buildElevationAttrs(rec: CloudRecord, range: ElevationAxis): Promise<(THREE.BufferAttribute | null)[]> {
  const lut = getElevationLut()
  const attrs: (THREE.BufferAttribute | null)[] = []
  let built = 0
  for (const g of rec.geometries) {
    const attr = g.getAttribute('position')
    const positions = attr instanceof THREE.BufferAttribute ? (attr.array as Float32Array) : null
    if (!positions || positions.length === 0) {
      attrs.push(null) // 空块（degenerate geometry）：安装时跳过
      continue
    }
    const colors = new Uint8Array(positions.length) // 顶点数 × 3
    fillElevationColors(positions, range.min, range.max, lut, colors)
    attrs.push(new THREE.BufferAttribute(colors, 3, true))
    if (++built % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return attrs
}

/**
 * 保证 rec 装的是"当前范围对应的高程色"，**收敛式**（本文件唯一会因 UI 参数而重建的颜色）。
 *
 * 三条机制，缺一个就是一类事故：
 *  - **键控**：范围（规整后的数值）变了才重建；相同则秒回（切走再切回高程不重算）。
 *  - **在飞守卫 + 收尾补跑**：一次拖拽会触发几十次同步 watch，若每次都起一个构建，
 *    大云上就是几十个并发全量扫描。守卫让在飞的那一次自己把最新范围接上
 *    （构建完 - 比对 - 又变了就用新范围重来一轮），于是"拖拽 → 画面按可达速率跟着走"，
 *    而不是"排一长队中间态"或"松手前毫无反应"。
 *  - **兼容共享**：`elevationColor` 是 `{key, attrs}` 整体，分割产物继承时零拷贝沿用
 *    （键相同即内容相同，见 elevationKeyOf）。
 */
async function ensureElevationColors(rec: CloudRecord, entity: SceneEntity) {
  if (rec.elevationBuilding) return // 在飞：那一轮的收尾会把最新范围接上
  let want = elevationRangeOf(rec, entity)
  if (rec.elevationColor?.key === elevationKeyOf(want)) return
  rec.elevationBuilding = true
  try {
    for (;;) {
      const attrs = await buildElevationAttrs(rec, want)
      const key = elevationKeyOf(want)
      rec.elevationColor = { key, attrs }
      // 构建期间用户可能已切走（切到 rgb 等）：不装，也不刷新（同 ensureScalarColorAttrs 的复查）
      if (entity.colorMode === 'elevation') {
        installColorAttrs(rec, attrs)
        rec.colorAttrState = 'elevation'
        refreshLod(rec) // 显示层是颜色字节的拷贝，换装后要重刷
      }
      const latest = elevationRangeOf(rec, entity)
      if (elevationKeyOf(latest) === key) return // 范围没再动：这一版就是终版
      want = latest // 拖拽中：用最新范围再跑一轮（这一版已装上，画面已跟上）
    }
  } finally {
    rec.elevationBuilding = false
  }
}

/**
 * 懒构建标量颜色 attribute（Uint8 归一化，每点 3 字节）。
 * 逐块构建 + 每 8 块让出主线程（沿用加载时的呼吸权模式）。
 */
async function ensureScalarColorAttrs(rec: CloudRecord) {
  if (rec.scalarColorAttrs) return
  const attrs: (THREE.BufferAttribute | null)[] = []
  let built = 0
  for (const g of rec.geometries) {
    const cls = g.getAttribute('classification')
    if (!cls) {
      attrs.push(null)
      continue
    }
    const colors = buildScalarColors(new Uint8Array(cls.array.buffer, cls.array.byteOffset, cls.array.length))
    attrs.push(new THREE.BufferAttribute(colors, 3, true))
    if (++built % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  // 防重入：期间若已有其他构建完成则丢弃本次结果（内容相同，无害）
  if (!rec.scalarColorAttrs) {
    rec.scalarColorAttrs = attrs
  }
}

/**
 * 懒构建法向量颜色 attribute（Uint8 归一化，每点 3 字节）。
 *
 * 取值 = 逐码查 LUT 得单位向量 → `(N+1)/2` → `srgbToLinear`（见 utils/normalEstimate.ts）。
 * LUT 是**模块级缓存**（32769 × 3 的 Float32Array，约 393 KB），只建一次。
 *
 * 逐块读的是 geometry 上的 `normalCode` 属性**全量顶点**（不理会 index——与
 * ensureScalarColorAttrs 同惯例：颜色是"每顶点"数据，由 index/drawRange 决定显示哪批）。
 * 缺 `normalCode` 的块记 null（installColorAttrs 会跳过）。
 *
 * 逐块构建 + 每 8 块让出主线程（沿用加载时的呼吸权模式）。
 */
async function ensureNormalColorAttrs(rec: CloudRecord) {
  if (rec.normalColorAttrs) return
  const lut = getNormalLut()
  const attrs: (THREE.BufferAttribute | null)[] = []
  let built = 0
  for (const g of rec.geometries) {
    const codeAttr = g.getAttribute('normalCode')
    if (!codeAttr) {
      attrs.push(null)
      continue
    }
    const codes = new Uint16Array(codeAttr.array.buffer, codeAttr.array.byteOffset, codeAttr.array.length)
    const colors = new Uint8Array(codes.length * 3)
    const rgb: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < codes.length; i++) {
      normalCodeToRgbLinear(lut, codes[i], rgb)
      colors[i * 3] = rgb[0]
      colors[i * 3 + 1] = rgb[1]
      colors[i * 3 + 2] = rgb[2]
    }
    attrs.push(new THREE.BufferAttribute(colors, 3, true))
    if (++built % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  // 防重入：期间若已有其他构建完成则丢弃本次结果（内容相同，无害）
  if (!rec.normalColorAttrs) {
    rec.normalColorAttrs = attrs
  }
}

/**
 * 法向量 LUT（模块级缓存；纯函数产物，同一份输入总产出同一份表）。
 * 只在首次进入法向量着色时构建一次，之后所有实体共用。
 */
let normalLutCache: Float32Array | null = null
function getNormalLut(): Float32Array {
  if (!normalLutCache) normalLutCache = buildNormalLut()
  return normalLutCache
}

/** 应用点大小：实体档位（1-16）直接映射为屏幕像素（CC 式，材质 sizeAttenuation=false）。 */
function applyPointSize(rec: CloudRecord, entity: SceneEntity) {
  const size = entity.pointSize
  if (rec.material.size !== size) {
    rec.material.size = size
  }
}

/** 创建/重建名称标签（文本取实体当前名）并挂到 group。 */
function createLabel(rec: CloudRecord, entity: SceneEntity): THREE.Sprite {
  const label = createLabelSprite(entity.name, rec.labelBaseSize)
  // 记录生成时的文本，改名时据此判断是否需要重建
  label.userData.text = entity.name
  // 位置：显示坐标包围盒中心 = (全局中心 − globalShift)。
  // 作为 group 子节点自动继承 rotation.x = -π/2；Sprite 恒面向相机，文字不会歪。
  label.position.set(
    (rec.bbox.minX + rec.bbox.maxX) / 2 - rec.globalShift.x,
    (rec.bbox.minY + rec.bbox.maxY) / 2 - rec.globalShift.y,
    (rec.bbox.minZ + rec.bbox.maxZ) / 2 - rec.globalShift.z
  )
  rec.group.add(label)
  return label
}

/** 释放名称标签（Canvas 纹理）并从场景摘除。 */
function disposeLabel(rec: CloudRecord) {
  if (!rec.label) return
  rec.group.remove(rec.label)
  rec.label.material.map?.dispose()
  rec.label.material.dispose()
  rec.label = null
}

/** 应用"在 3D 中显示名称标签"（懒创建 Canvas 纹理 Sprite）。 */
function applyShowName(rec: CloudRecord, entity: SceneEntity) {
  // 树里改过名且标签已建：canvas 纹理无法原地改写文字，文本不一致直接重建
  if (entity.showNameIn3D && rec.label && rec.label.userData.text !== entity.name) {
    disposeLabel(rec)
  }
  if (entity.showNameIn3D && !rec.label) {
    rec.label = createLabel(rec, entity)
  }
  if (rec.label) {
    // 云隐藏或标签显示关闭时一并隐藏（保留精灵，切换回来不重建）
    rec.label.visible = entity.showNameIn3D && entity.visible
  }
}

/** 创建 3D 名称标签（Canvas 纹理 Sprite）。 */
function createLabelSprite(text: string, labelBaseSize: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const fontSize = 48
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (!ctx) return new THREE.Sprite()
  ctx.font = `600 ${fontSize}px sans-serif`
  const width = Math.ceil(ctx.measureText(text).width) + 32
  canvas.width = width
  // canvas 尺寸变化会重置上下文状态，需重设字体
  ctx.font = `600 ${fontSize}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  ctx.lineWidth = 10
  ctx.strokeText(text, 16, canvas.height / 2)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, 16, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false, // 标签不被点云遮挡（CC 行为）
  })
  const sprite = new THREE.Sprite(material)
  // 标签尺寸相对云的大小：基准点大小 ×12，宽按画布宽高比
  const scale = Math.max(labelBaseSize * 12, 0.5)
  sprite.scale.set((scale * canvas.width) / canvas.height, scale, 1)
  return sprite
}

export function usePointCloudStore() {
  const { getViewer } = useViewerStore()

  /**
   * 分块加载大PLY文件
   * @param {*} plyfilepath PLY 文件路径
   * @param {*} chunkSize 每块分块的点数，默认50万点
   * @param {*} plyUnitSize 每个点云数据的字节数，默认30字节（3*double + 3*uchar + uchar + ushort）
   * @param {*} log 是否打印日志，默认false
   * @param {*} callback 进度回调函数，默认空函数
   */
  async function loadLargePly(
    plyfilepath: string,
    chunkSize = 500000,
    plyUnitSize = 30,
    log = false,
    callback: (progress: LoadProgress) => void = () => {},
    entityId?: number
  ) {
    console.log('开始分块加载大PLY文件:', plyfilepath)

    // 1. 获取文件信息（走主进程 IPC）
    const fileInfo: PlyFileInfo = await usePly().getFileInfo(plyfilepath)
    if (log) {
      console.log('文件信息:', fileInfo)
      console.log('文件大小:', (fileInfo.size / 1024 / 1024).toFixed(2), 'MB')
      console.log('每点字节数:', plyUnitSize)
    }

    // 1.5 【共享基准点】首块点云先扫描整个文件算出包围盒中心，作为全局基准。
    // 基准一旦建立就保留，后续所有点云共享；各块按原始大地坐标减同一基准，
    // 相对位置真实，且不会都堆到原点。
    const isFirstCloud = basePoint === null
    if (isFirstCloud) {
      if (log) {
        console.log('首块点云，扫描文件计算全局基准点...')
      }
      const bbox = await usePly().scanBBox({
        path: plyfilepath,
        plyUnitSize,
        pointCount: fileInfo.pointCount,
        dataOffset: fileInfo.dataOffset,
      })
      basePoint = new THREE.Vector3(
        (bbox.minX + bbox.maxX) / 2,
        (bbox.minY + bbox.maxY) / 2,
        (bbox.minZ + bbox.maxZ) / 2
      )
      if (log) {
        console.log('全局基准点:', basePoint)
      }
    }
    const offset = basePoint // 解析时统一减基准（double 精度，转 Float32 前）

    // 2. 分块读取和解析（每块独立 BufferGeometry，避免大文件 OOM）
    const totalChunks = Math.ceil(fileInfo.pointCount / chunkSize)
    if (log) {
      console.log(`总分块数: ${totalChunks}, 每块点数: ${chunkSize}`)
    }

    const chunks: ParsedChunk[] = []
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const chunkData = await usePly().readChunk({
        path: plyfilepath,
        plyUnitSize,
        chunkIndex,
        chunkSize,
        pointCount: fileInfo.pointCount,
        dataOffset: fileInfo.dataOffset,
      })
      if (log) {
        console.log(`分块 ${chunkIndex + 1}/${totalChunks} 读取到 ${chunkData.pointsRead} 点`)
      }

      chunks.push(parsePlyChunk(chunkData.arrayBuffer, plyUnitSize, log, offset))

      // 进度回调
      const progress = Math.floor(((chunkIndex + 1) / totalChunks) * 100)
      callback({
        progress,
        currentChunk: chunkIndex + 1,
        totalChunks,
        status: 'loading',
        message: `正在加载分块 ${chunkIndex + 1}/${totalChunks}`,
      })

      // 【核心】：释放呼吸权，防止读取大文件时界面白屏
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // 2.5 合并各块元数据（包围盒对原始 double 累积；globalShift 取基准点按值快照）
    const bbox = combineChunkBBoxes(chunks.map((c) => c.bbox))
    const pointCount = chunks.reduce((sum, c) => sum + c.pointCount, 0)
    const globalShift = {
      x: offset?.x ?? 0,
      y: offset?.y ?? 0,
      z: offset?.z ?? 0,
    }

    // 3. 组装 THREE.Points 并加入场景（PLY/LAS 共用）；PLY 固定带 RGB
    const pointsGroup = buildPointsGroup(
      chunks.map((c) => c.geometry),
      isFirstCloud,
      entityId !== undefined && bbox ? { entityId, bbox, pointCount, hasColor: true, globalShift } : undefined
    )

    if (log) {
      console.log(`点云加载完成: ${fileInfo.pointCount} 点, ${totalChunks} 块`)
    }
    return pointsGroup
  }

  /**
   * 分块加载大 LAS 文件。
   *
   * 与 PLY 的区别：LAS 头部自带包围盒（真实坐标），基准点直接取其中心，
   * 无需扫描整个文件；分块步长用头部声明的点记录长度（而非固定 30 字节）。
   * @param {*} lasFilePath LAS 文件路径
   * @param {*} chunkSize 每块分块的点数，默认50万点
   * @param {*} log 是否打印日志，默认false
   * @param {*} callback 进度回调函数，默认空函数
   */
  async function loadLargeLas(
    lasFilePath: string,
    chunkSize = 500000,
    log = false,
    callback: (progress: LoadProgress) => void = () => {},
    entityId?: number
  ) {
    console.log('开始分块加载 LAS 文件:', lasFilePath)

    // 1. 获取文件信息（走主进程 IPC，解析二进制头部）
    const fileInfo: LasFileInfo = await useLas().getFileInfo(lasFilePath)
    if (log) {
      console.log('文件信息:', fileInfo)
      console.log('文件大小:', (fileInfo.size / 1024 / 1024).toFixed(2), 'MB')
      console.log('LAS 版本:', `${fileInfo.versionMajor}.${fileInfo.versionMinor}`, '点格式:', fileInfo.pointFormat)
    }

    // 1.5 【共享基准点】首块点云直接用 LAS 头部包围盒中心作为全局基准。
    // 基准一旦建立就保留，后续所有点云共享；各块按原始大地坐标减同一基准，
    // 相对位置真实，且不会都堆到原点（与 PLY 一致，只是不用扫描文件）。
    const isFirstCloud = basePoint === null
    if (isFirstCloud) {
      if (log) {
        console.log('首块点云，使用 LAS 头部包围盒中心作为全局基准点...')
      }
      basePoint = new THREE.Vector3(
        (fileInfo.minX + fileInfo.maxX) / 2,
        (fileInfo.minY + fileInfo.maxY) / 2,
        (fileInfo.minZ + fileInfo.maxZ) / 2
      )
      if (log) {
        console.log('全局基准点:', basePoint)
      }
    }
    const offset = basePoint // 解析时统一减基准（double 精度，转 Float32 前）

    // 2. 分块读取和解析（每块独立 BufferGeometry，避免大文件 OOM）
    const totalChunks = Math.ceil(fileInfo.pointCount / chunkSize)
    if (log) {
      console.log(`总分块数: ${totalChunks}, 每块点数: ${chunkSize}`)
    }

    const chunks: ParsedChunk[] = []
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const chunkData = await useLas().readChunk({
        path: lasFilePath,
        pointRecordLength: fileInfo.pointRecordLength,
        chunkIndex,
        chunkSize,
        pointCount: fileInfo.pointCount,
        dataOffset: fileInfo.dataOffset,
      })
      if (log) {
        console.log(`分块 ${chunkIndex + 1}/${totalChunks} 读取到 ${chunkData.pointsRead} 点`)
      }

      chunks.push(parseLasChunk(chunkData.arrayBuffer, fileInfo, offset, log))

      // 进度回调
      const progress = Math.floor(((chunkIndex + 1) / totalChunks) * 100)
      callback({
        progress,
        currentChunk: chunkIndex + 1,
        totalChunks,
        status: 'loading',
        message: `正在加载分块 ${chunkIndex + 1}/${totalChunks}`,
      })

      // 【核心】：释放呼吸权，防止读取大文件时界面白屏
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // 2.5 合并各块元数据（包围盒对原始 double 累积；globalShift 取基准点按值快照）
    const bbox = combineChunkBBoxes(chunks.map((c) => c.bbox))
    const pointCount = chunks.reduce((sum, c) => sum + c.pointCount, 0)
    const globalShift = {
      x: offset?.x ?? 0,
      y: offset?.y ?? 0,
      z: offset?.z ?? 0,
    }

    // 3. 组装 THREE.Points 并加入场景（PLY/LAS 共用）
    const pointsGroup = buildPointsGroup(
      chunks.map((c) => c.geometry),
      isFirstCloud,
      entityId !== undefined && bbox
        ? { entityId, bbox, pointCount, hasColor: fileInfo.hasColor, globalShift }
        : undefined
    )

    if (log) {
      console.log(`LAS 加载完成: ${fileInfo.pointCount} 点, ${totalChunks} 块`)
    }
    return pointsGroup
  }

  /**
   * 解析 PLY 分块数据（自定义格式：3*double 坐标 + 3*uchar 颜色 + uchar 分类 + ushort 树ID）
   * 包围盒在"减基准点之前"对原始 double 累积，保证属性面板的全局坐标精确。
   * @param {*} arrayBuffer 分块二进制数据
   * @param {*} plyUnitSize 每个点云数据的字节数
   * @param {*} log 是否打印日志
   */
  function parsePlyChunk(
    arrayBuffer: ArrayBuffer,
    plyUnitSize: number,
    log: boolean,
    offset: THREE.Vector3 | null = null
  ): ParsedChunk {
    const dataView = new DataView(arrayBuffer)
    const points = Math.floor(arrayBuffer.byteLength / plyUnitSize)
    if (log) {
      console.log(`解析 ${points} 个点，数据大小: ${arrayBuffer.byteLength} 字节`)
    }
    if (points === 0) return emptyParsedChunk()

    // 共享基准点偏移：double 阶段先减基准再转 Float32，避免大地坐标丢精度
    const offsetX = offset?.x ?? 0
    const offsetY = offset?.y ?? 0
    const offsetZ = offset?.z ?? 0

    const positions = new Float32Array(points * 3)
    const colors = new Float32Array(points * 3)
    const classifications = new Uint8Array(points)
    const treeIds = new Uint16Array(points)

    // 过滤 NaN/Infinity 无效点：不写入几何体，避免污染整个 chunk 渲染
    let w = 0
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < points; i++) {
      const byteOffset = i * plyUnitSize
      // 读取位置坐标（double x, y, z - 24字节）：原始值累积包围盒，减共享基准点后转存 Float32
      const x0 = dataView.getFloat64(byteOffset, true)
      const y0 = dataView.getFloat64(byteOffset + 8, true)
      const z0 = dataView.getFloat64(byteOffset + 16, true)
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0)) continue
      if (x0 < minX) minX = x0
      if (y0 < minY) minY = y0
      if (z0 < minZ) minZ = z0
      if (x0 > maxX) maxX = x0
      if (y0 > maxY) maxY = y0
      if (z0 > maxZ) maxZ = z0
      positions[w * 3] = x0 - offsetX
      positions[w * 3 + 1] = y0 - offsetY
      positions[w * 3 + 2] = z0 - offsetZ
      // 读取颜色 (uchar - 3字节)：文件字节为 sRGB 编码，顶点色属性要求线性值
      // （three r185 默认色彩管理，输出端会 sRGB 编码——直接写字节会发白发淡），
      // 故经 srgbU8ToLinear 解码后再写入
      colors[w * 3] = srgbU8ToLinear(dataView.getUint8(byteOffset + 24))
      colors[w * 3 + 1] = srgbU8ToLinear(dataView.getUint8(byteOffset + 25))
      colors[w * 3 + 2] = srgbU8ToLinear(dataView.getUint8(byteOffset + 26))
      // 读取分类 (uchar) 与树ID (ushort)
      classifications[w] = dataView.getUint8(byteOffset + 27)
      treeIds[w] = dataView.getUint16(byteOffset + 28, true)
      w++
    }
    if (w === 0) return emptyParsedChunk()

    // 截断到实际写入的点数（过滤后可能少于读入数）；无 NaN 的正常路径下 w === points，
    // truncateTo 直接返回原数组，四次整块拷贝全部省掉（见其注释）
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(truncateTo(positions, w * 3), 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(truncateTo(colors, w * 3), 3))
    geometry.setAttribute('classification', new THREE.BufferAttribute(truncateTo(classifications, w), 1))
    geometry.setAttribute('treeid', new THREE.BufferAttribute(truncateTo(treeIds, w), 1))
    // 包围体按**显示坐标**（已减基准点）显式填好，供视锥剔除与拾取使用（见 applyBoundingVolumes）
    applyBoundingVolumes(
      geometry,
      [minX - offsetX, minY - offsetY, minZ - offsetZ],
      [maxX - offsetX, maxY - offsetY, maxZ - offsetZ]
    )
    return {
      geometry,
      bbox: { minX, minY, minZ, maxX, maxY, maxZ },
      pointCount: w,
    }
  }

  /**
   * 解析 LAS 分块数据。
   *
   * LAS 坐标以 int32 存盘：真实坐标 = int32 × 缩放因子 + 头部偏移量（double 计算，
   * 减共享基准点后转 Float32，避免大地坐标丢精度）。字段偏移按点数据格式查表。
   * 包围盒在"减基准点之前"对原始 double 累积，保证属性面板的全局坐标精确。
   * @param {*} arrayBuffer 分块二进制数据
   * @param {*} fileInfo LAS 文件信息（点记录长度 / 点格式 / 缩放偏移）
   * @param {*} offset 全局基准点（null 表示未设置）
   * @param {*} log 是否打印日志
   */
  function parseLasChunk(
    arrayBuffer: ArrayBuffer,
    fileInfo: LasFileInfo,
    offset: THREE.Vector3 | null = null,
    log: boolean
  ): ParsedChunk {
    const dataView = new DataView(arrayBuffer)
    const pointRecordLength = fileInfo.pointRecordLength
    const points = Math.floor(arrayBuffer.byteLength / pointRecordLength)
    if (log) {
      console.log(`解析 ${points} 个点，数据大小: ${arrayBuffer.byteLength} 字节，步长: ${pointRecordLength} 字节`)
    }
    if (points === 0) return emptyParsedChunk()

    // 共享基准点偏移：double 阶段先减基准再转 Float32，避免大地坐标丢精度
    const offsetX = offset?.x ?? 0
    const offsetY = offset?.y ?? 0
    const offsetZ = offset?.z ?? 0

    // LAS 坐标还原系数（真实坐标 = int32 × scale + offset）
    const scaleX = fileInfo.scaleX
    const scaleY = fileInfo.scaleY
    const scaleZ = fileInfo.scaleZ
    const shiftX = fileInfo.offsetX
    const shiftY = fileInfo.offsetY
    const shiftZ = fileInfo.offsetZ

    // 字段偏移查表（不同点格式布局不同）
    const hasColor = fileInfo.hasColor
    const rgbOffset = LAS_RGB_OFFSETS[fileInfo.pointFormat] ?? -1
    const psidOffset = LAS_POINT_SOURCE_ID_OFFSETS[fileInfo.pointFormat] ?? 18

    const positions = new Float32Array(points * 3)
    const colors = new Float32Array(points * 3)
    const classifications = new Uint8Array(points)
    const treeIds = new Uint16Array(points)

    // 过滤无效点：LAS 整数坐标理论上不会产生 NaN，仅防御损坏文件
    let w = 0
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < points; i++) {
      const byteOffset = i * pointRecordLength
      // 读取位置坐标（int32 × scale + offset）：原始值累积包围盒，减共享基准点后转存 Float32
      const x0 = dataView.getInt32(byteOffset, true) * scaleX + shiftX
      const y0 = dataView.getInt32(byteOffset + 4, true) * scaleY + shiftY
      const z0 = dataView.getInt32(byteOffset + 8, true) * scaleZ + shiftZ
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0)) continue
      if (x0 < minX) minX = x0
      if (y0 < minY) minY = y0
      if (z0 < minZ) minZ = z0
      if (x0 > maxX) maxX = x0
      if (y0 > maxY) maxY = y0
      if (z0 > maxZ) maxZ = z0
      positions[w * 3] = x0 - offsetX
      positions[w * 3 + 1] = y0 - offsetY
      positions[w * 3 + 2] = z0 - offsetZ
      // 读取颜色：LAS RGB 为 uint16，存储单位因软件而异（移位 8 位或直接 8 位值），
      // 按主进程采样判定的约定还原（decodeLasRgb 得 sRGB 0-1），再解码为线性值
      // 写入顶点色属性（同 PLY 路径，见该处注释）；无颜色字段时给灰色
      if (hasColor && rgbOffset >= 0) {
        colors[w * 3] = srgbToLinear(decodeLasRgb(dataView.getUint16(byteOffset + rgbOffset, true), fileInfo.rgbMax))
        colors[w * 3 + 1] = srgbToLinear(
          decodeLasRgb(dataView.getUint16(byteOffset + rgbOffset + 2, true), fileInfo.rgbMax)
        )
        colors[w * 3 + 2] = srgbToLinear(
          decodeLasRgb(dataView.getUint16(byteOffset + rgbOffset + 4, true), fileInfo.rgbMax)
        )
      } else {
        colors[w * 3] = 0.7
        colors[w * 3 + 1] = 0.7
        colors[w * 3 + 2] = 0.7
      }
      // 读取分类：格式 0-5 在字节 15（低 5 位为分类，bit 5-7 是 synthetic/keypoint/withheld 标记），
      // 高位标记位必须掩掉；格式 6-10 在字节 16（完整 8 位分类，标记在独立的 flags 字节 15），
      // 不再掩码——ASPRS 预留类 32-63 与用户自定义类 64-255 得以保真，
      // 超出色表的取值由 classColors.userClassColor 生成色兜底着色
      const classOffset = fileInfo.pointFormat >= 6 ? 16 : 15
      const rawClass = dataView.getUint8(byteOffset + classOffset)
      classifications[w] = fileInfo.pointFormat >= 6 ? rawClass : rawClass & 0x1f
      // 读取树ID：映射 Point Source ID 字段（格式 0-5 与 6-10 偏移不同）
      treeIds[w] = dataView.getUint16(byteOffset + psidOffset, true)
      w++
    }
    if (w === 0) return emptyParsedChunk()

    // 截断到实际写入的点数（过滤后可能少于读入数）；无 NaN 的正常路径下 w === points，
    // truncateTo 直接返回原数组，四次整块拷贝全部省掉（见其注释）
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(truncateTo(positions, w * 3), 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(truncateTo(colors, w * 3), 3))
    geometry.setAttribute('classification', new THREE.BufferAttribute(truncateTo(classifications, w), 1))
    geometry.setAttribute('treeid', new THREE.BufferAttribute(truncateTo(treeIds, w), 1))
    // 包围体按**显示坐标**（已减基准点）显式填好，供视锥剔除与拾取使用（见 applyBoundingVolumes）
    applyBoundingVolumes(
      geometry,
      [minX - offsetX, minY - offsetY, minZ - offsetZ],
      [maxX - offsetX, maxY - offsetY, maxZ - offsetZ]
    )
    return {
      geometry,
      bbox: { minX, minY, minZ, maxX, maxY, maxZ },
      pointCount: w,
    }
  }

  /**
   * 把各分块几何体组装成 THREE.Points Group 并加入 3D 场景（PLY/LAS 共用）。
   * @param {*} geometries 各分块的 BufferGeometry
   * @param {*} isFirstCloud 是否首块点云（首块适配相机）
   * @param {*} meta 元数据（含 entityId）；传 undefined 表示不注册（向后兼容旧调用）
   * @returns 点云 Group
   */
  function buildPointsGroup(
    geometries: THREE.BufferGeometry[],
    isFirstCloud: boolean,
    meta?: {
      entityId: number
      bbox: EntityBBox
      pointCount: number
      hasColor: boolean
      globalShift: { x: number; y: number; z: number }
    }
  ): THREE.Group {
    // 每个分块一个 THREE.Points 装进 Group（不合并，避免大数组内存峰值）
    const pointsGroup = new THREE.Group()
    // CC 式像素点：不透明硬边、无贴图，sizeAttenuation=false 时 size 单位是屏幕像素，
    // 与云的距离/包围盒无关（放大不膨胀），小尺寸下方形硬件点肉眼即"点"；
    // 不透明管线无混合开销。splitEntity 克隆出的分割实体材质一并继承该渲染模式。
    // 实际尺寸在注册后由实体档位经 applyPointSize 覆盖。
    const material = new THREE.PointsMaterial({
      size: DEFAULT_POINT_PIXELS,
      vertexColors: true,
      sizeAttenuation: false,
    })
    // 分块标记写进 userData：拾取（measure）靠它把命中反查到 (entityId, chunkIndex)。
    // meta 缺省时不打标——该路径不登记 cloudRecords，拾取也不会把它当候选。
    geometries.forEach((geometry, i) => {
      const points = new THREE.Points(geometry, material)
      // 视锥剔除交给 three（Group 的 Z-up→Y-up 旋转由 matrixWorld 正确带入）。
      // geometry 的 boundingBox/boundingSphere 已在解析时按显示坐标显式填好，
      // 剔除因此是 O(1) 的；漏填才会退化成 O(N) 现算（见 applyBoundingVolumes）。
      points.frustumCulled = true
      if (meta) {
        const tag: PointsTag = { entityId: meta.entityId, chunkIndex: i }
        points.userData = tag
      }
      pointsGroup.add(points)
    })

    // 坐标转换：数据是 Z-up（测绘约定，头顶沿 +Z），转成 three.js 的 Y-up 显示
    // （只改 Group 旋转不改底层坐标，之后导出时数据保持原样）
    pointsGroup.rotation.x = -Math.PI / 2

    // 加入 3D 场景。坐标已统一减基准，不再平移；仅首块适配相机，
    // 后续块不打扰用户当前视角（它们保持与首块的真实相对位置）。
    const radius = addToScene(pointsGroup, isFirstCloud)
    // 名称标签尺寸基准在加载时算好（不再用于点大小；见 applyShowName）
    const labelBaseSize = Math.max(radius * LABEL_SIZE_RATIO, 0.01)

    if (meta) {
      // 留存渲染状态（普通 Map，不进 reactive），并回填面板元数据；
      // registerCloudRecord 内部按阈值决定是否挂 LOD 显示层
      registerCloudRecord(meta.entityId, {
        group: pointsGroup,
        material,
        geometries,
        rgbColorAttrs: geometries.map((g) => {
          // 我们只写入普通 BufferAttribute；Interleaved/缺失时记 null（安装时跳过）
          const attr = g.getAttribute('color')
          return attr instanceof THREE.BufferAttribute ? attr : null
        }),
        scalarColorAttrs: null,
        normalColorAttrs: null,
        elevationColor: null,
        colorAttrState: 'rgb',
        // 加载来的云没有分割色（那是分割产物的东西，见 setEntityLabelColor）
        labelColor: null,
        // 解析路径拿不到法向量（PLY 私有布局 / LAS 0-10 格式都无此字段），只能靠估计
        hasNormals: false,
        labelBaseSize,
        bbox: meta.bbox,
        pointCount: meta.pointCount,
        hasColor: meta.hasColor,
        globalShift: meta.globalShift,
        label: null,
        lod: null,
      })
      useSceneStore().updateEntityMeta(meta.entityId, {
        pointCount: meta.pointCount,
        hasColor: meta.hasColor,
        hasNormals: false,
        hasLabelColor: false,
        bbox: meta.bbox,
        globalShift: meta.globalShift,
      })
      // 应用当前 UI 状态（visible 等）到 three 对象，保证初态一致
      void syncAllToThree()
    }
    return pointsGroup
  }

  /**
   * 把点云 Group 加入 3D 场景。
   * 坐标已在解析阶段统一减去全局基准点（首块居中到原点，后续块保持真实相对位置），
   * 因此这里不再平移；仅首块加载时适配相机，后续块不打扰用户当前视角。
   * @param {*} pointsGroup 点云 Group
   * @param {*} fitCamera 是否重置相机对准点云（仅首块传 true）
   * @returns 点云包围盒对角线长度（用于自适应点大小）
   */
  function addToScene(pointsGroup: THREE.Group, fitCamera: boolean): number {
    const viewer = getViewer()
    if (!viewer) {
      console.warn('3D 视图尚未挂载，点云暂不显示')
      return 1
    }

    // 按包围盒尺寸确定点大小基准。
    // Box3.expandByObject 取 geometry.boundingBox（解析时已填好），逐块 O(1) 合并；
    // 此前 boundingBox 为 null，它会逐顶点现算——1 亿点加载末尾的白扫数秒即来自这里。
    const box = new THREE.Box3().setFromObject(pointsGroup)
    const radius = Math.max(box.getSize(new THREE.Vector3()).length(), 1)
    viewer.scene.add(pointsGroup)

    // 仅首块加载时适配相机（引擎内部按当前投影取景：透视/正射均正确对准点云）
    if (fitCamera) {
      viewer.fitView(radius)
    }
    return radius
  }

  /** 是否已加载过任何点云（`Zoom to fit` 的可用性判据：没有任何几何体时取景无意义）。 */
  function hasCloudRecords(): boolean {
    return cloudRecords.size > 0
  }

  /**
   * 缩放到视图（`View ▸ Zoom to fit` / `Zoom on selected`，Home / F 键）：
   * 省略 ids = 全部；给定 ids = 只对准这些实体（不存在或已隐藏的自动跳过）。
   *
   * 取景中心取自 **`rec.bbox`**（原始坐标，减 `globalShift` 得显示坐标）再经 Group 的
   * `localToWorld` 换到世界空间，而**不是** `Box3.setFromObject`：
   * - 后者在几何体 boundingBox 为 null 时会逐顶点现算（1 亿点就是数秒卡死，
   *   见 addToScene 的注释）；
   * - 分割产物挂在 geometry 上的 boundingBox 是**源几何体**的那一份
   *   （buildIndexedGeometry 直接拷的引用，片段只占源包围盒里的一角），
   *   按它取景会框出整片源云；而 `rec.bbox` 是分割时按片段点集**精确算过**的
   *   （splitEntityMany 逐块扫候选顶点，原始坐标），且 O(1) 可读。
   *
   * 半径用世界包围盒的对角线长（`getSize().length()`，与加载取景同一口径）：对角线是
   * 旋转不变量，不必纠缠 Group 上的 `rotation.x = -π/2`。8 个角点全部变换是刻意的——
   * 这次旋转把局部的 z 轴换到了世界的 y 轴，只变换中心会漏掉沿世界 y 的跨度。
   */
  function fitViewTo(entityIds?: number[]): void {
    const viewer = getViewer()
    if (!viewer) return
    const ids = entityIds ?? [...cloudRecords.keys()]

    const box = new THREE.Box3()
    const corner = new THREE.Vector3()
    let any = false
    for (const id of ids) {
      const rec = cloudRecords.get(id)
      // 隐藏的实体不参与取景：所见即所框，否则"框了一片看不见的云"更让人迷惑
      if (!rec || !rec.group.visible) continue
      rec.group.updateWorldMatrix(true, false)
      for (let k = 0; k < 8; k++) {
        corner.set(
          (k & 1 ? rec.bbox.maxX : rec.bbox.minX) - rec.globalShift.x,
          (k & 2 ? rec.bbox.maxY : rec.bbox.minY) - rec.globalShift.y,
          (k & 4 ? rec.bbox.maxZ : rec.bbox.minZ) - rec.globalShift.z
        )
        box.expandByPoint(rec.group.localToWorld(corner))
      }
      any = true
    }
    if (!any) return

    const center = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length()
    viewer.fitView(radius, center)
  }

  /**
   * 读取点云文件（统一入口，按扩展名分发到不同加载器）。
   * @param {string} path 文件路径
   * @param {number} entityId 场景树实体 id（注册渲染状态与回填元数据用）
   * @param {(progress: LoadProgress) => void} onProgress 分块加载进度回调（可选）
   */
  async function readPointCloud(path: string, entityId?: number, onProgress?: (progress: LoadProgress) => void) {
    const ext = path.split('.').pop()?.toLowerCase()
    // LAS 走专用加载器（头部自带包围盒，无需扫描整个文件）；其余按 PLY 处理
    if (ext === 'las') {
      return loadLargeLas(path, undefined, undefined, onProgress, entityId)
    }
    return loadLargePly(path, undefined, undefined, undefined, onProgress, entityId)
  }

  /**
   * 取分割目标（已加载实体的渲染状态）。
   * 过滤掉尚未加载完成（无 cloudRecord）的实体，startSegment 校验用。
   */
  function getSegmentTargets(entityIds: number[]): SegmentTarget[] {
    const targets: SegmentTarget[] = []
    for (const id of entityIds) {
      const rec = cloudRecords.get(id)
      if (rec) {
        targets.push({ entityId: id, group: rec.group, geometries: rec.geometries })
      }
    }
    return targets
  }

  /**
   * 取当前**可见**的点云目标（测量拾取用，全局、可跨实体）。
   *
   * 只按 `rec.group.visible` 过滤：它是渲染的最终真值，树勾选与分割预览的强制可见
   * （beginSegmentPreview / syncAllToThree）都写在这一处，无需在这里重推一遍。
   * 这一步不可省——Raycaster 只测 layers、**不看 object.visible**（three
   * Raycaster.js 的 intersect 只判 layers），隐藏的点云照样会被射线命中。
   * 分块级的隐藏（分割预览写的 index + drawRange）不用管：Points.raycast 自带尊重。
   */
  function getVisibleTargets(): SegmentTarget[] {
    const targets: SegmentTarget[] = []
    for (const [entityId, rec] of cloudRecords) {
      if (rec.group.visible) {
        targets.push({ entityId, group: rec.group, geometries: rec.geometries })
      }
    }
    return targets
  }

  /**
   * 按索引数组控制某实体各分块的可见点（分割预览用，零拷贝瞬时切换）。
   * @param chunkIndices null = 全部还原为全量渲染；否则第 i 块只显示
   *   chunkIndices[i] 里的点（空数组表示该块 0 点全隐藏）。
   */
  function setChunkVisibility(entityId: number, chunkIndices: (Uint32Array | null)[] | null) {
    const rec = cloudRecords.get(entityId)
    if (!rec) return
    rec.geometries.forEach((g, i) => {
      const indices = chunkIndices ? chunkIndices[i] : null
      if (indices === null) {
        // 还原必须同时移除索引并重置 drawRange：setIndex(null) 不会重置 drawRange，
        // 残留的 count 会截断渲染点数
        g.setIndex(null)
        const position = g.attributes.position
        if (position) g.setDrawRange(0, position.count)
      } else {
        g.setIndex(new THREE.BufferAttribute(indices, 1))
        g.setDrawRange(0, indices.length)
      }
    })
    applyLodPreviewFallback(rec, chunkIndices !== null)
    // 可见集变了 → 高程分布图过期（预览改 index/drawRange，不走 updateEntityMeta，
    // 故不 bump 就没人通知面板；分割确认后由 updateEntityMeta 侧再覆盖一次）
    elevationRevision.value++
    requestRender() // 直写 index/drawRange，不走 syncAllToThree
  }

  /**
   * LOD 实体的预览回退：预览走的是语义层的 index + drawRange（离散事件，只在 mouseup /
   * 多边形闭合时触发），而显示层是拷贝、不跟随 → 预览期整条切回旧路径（per-chunk
   * `Points` 恢复可见、staging 让位），还原时反向。
   *
   * 刻意不做逐点掩码：那要在 1 亿点上做 O(N) 重建，而预览正是用户做**精确**工作的
   * 时刻，走已知正确的旧路径比维护一条并行通道更稳。代价是预览期间回到全量渲染
   * ——可接受，此时用户在看局部。
   */
  function applyLodPreviewFallback(rec: CloudRecord, previewing: boolean) {
    if (!rec.lod) return
    rec.lod.points.visible = !previewing
    for (const child of rec.group.children) {
      const points = child as THREE.Points
      // ⚠ 方向与上一行**相反**，不是笔误：两者是接力关系，必须一显一隐。
      // 曾误写成 `!previewing`（与 staging 同值）→ 预览期两边都不可见，画面整个空掉。
      if (points.isPoints && points !== rec.lod.points) points.visible = previewing
    }
    // 还原时要重取：预览期相机可能动过，而隐藏的显示层不参与取点（视锥标记也早作废了）
    if (!previewing) invalidateLodDisplay(rec.lod)
  }

  /** 分割预览期间强制可见（防树勾选把目标云藏掉，见 previewForcedIds）。 */
  function beginSegmentPreview(entityIds: number[]) {
    for (const id of entityIds) {
      previewForcedIds.add(id)
      const rec = cloudRecords.get(id)
      if (rec) rec.group.visible = true
    }
    requestRender() // 直写 group.visible，不走 syncAllToThree（预览期的强制可见）
  }

  /** 结束分割预览：解除强制可见，并按当前树状态重新同步。 */
  function endSegmentPreview(entityIds: number[]) {
    for (const id of entityIds) {
      previewForcedIds.delete(id)
    }
    void syncAllToThree()
  }

  /**
   * 把多个已加载实体合并为一块（merge，分割/地面分割多片产物的逆操作）。
   *
   * 所有实体共享同一 globalShift（basePoint 永不重置），显示坐标同基准，因此产物
   * **零拷贝收养**各来源的分块 BufferGeometry（块级 index = 可见点集原样保留，
   * 不复制顶点缓冲），位置天然正确。
   *
   * 主导方 = entityIds[0]（最先点选）：归属项目 / path / 渲染设置
   * （visible / colorMode / pointSize / displayTarget / showNameIn3D）与
   * hasColor / globalShift 均沿用主导方；bbox / pointCount 按来源聚合。
   *
   * **身份**（编号 / 颜色 / 名字，见 utils/objectIdentity）：产物是"新物体"——任一来源带
   * 编号就取作用域内下一个空闲编号 + 全新色，名字由 `mergeProductName` 派生（`Tree 6 (3+5)`）；
   * 全部来源无编号则不加身份（普通点云合并仍是普通点云）。显示方式沿用主导方，
   * 故主导方正显示分割色时，合并后看到的是产物的新色。
   * 着色分歧按主导方统一：末尾 syncAllToThree 收敛（scalar/none 全实体重装；
   * rgb 主导时各块沿用现有 color attr——与 splitEntity 同风格的近似语义）。
   *
   * @param entityIds ≥2 个实体的 id（调用方按多选点击顺序传入；重复 id 自动去重，
   *   任一无效整体拒绝，防半合并）
   * @returns 合并产物实体 id；校验失败返回 null（已写 Merge 日志说明原因）
   */
  function mergeEntities(entityIds: number[]): number | null {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const ids = [...new Set(entityIds)]
    if (ids.length < 2) {
      log('Merge', '合并至少需要 2 片点云')
      return null
    }

    // 逐 id 校验已加载（有 cloudRecord）+ 树节点存在
    const sources: { id: number; rec: CloudRecord; entity: SceneEntity }[] = []
    for (const id of ids) {
      const rec = cloudRecords.get(id)
      const entity = sceneStore.getAllEntities().find((e) => e.id === id)
      if (!rec || !entity) {
        log('Merge', '存在未加载完成或已不存在的点云，已取消合并；请重新选择')
        return null
      }
      sources.push({ id, rec, entity })
    }
    const lead = sources[0]
    const leadProject = sceneStore.projects.find((p) => p.entities.some((e) => e.id === lead.id))
    if (!leadProject) return null // 树结构异常，正常路径不会发生

    // 1. 零拷贝收养各来源分块（index 可见子集原样保留）；聚合点数
    const geometries: THREE.BufferGeometry[] = []
    let pointCount = 0
    for (const s of sources) {
      geometries.push(...s.rec.geometries)
      pointCount += s.rec.pointCount
    }
    // 1.5 法向量**显式丢弃**：各来源的法向量是按各自邻域、各自定向算出来的，
    // 合并后毫无一致性可言（CC 会原样保留这些互相矛盾的向量，我们选择丢弃，
    // 用户重算一次即可）。逐块删属性——不能只把 hasNormals 置 false：属性还在
    // 几何体上，子实体的白名单会把它带进后续分割，状态与数据就对不上了。
    // `normalCode` 从不进 GPU、不参与算法输入，删除无副作用。
    for (const g of geometries) {
      g.deleteAttribute('normalCode')
    }
    // 2. bbox：各来源原始坐标包围盒直接合并（同基准，可直接逐轴取 min/max）
    const bbox = combineChunkBBoxes(sources.map((s) => s.rec.bbox)) ?? lead.rec.bbox

    // 2.5 物体身份：产物是**新物体** —— 任一来源带编号就取作用域内下一个空闲编号，
    //     颜色 = labelColor(新编号)（全新色，不暗示来源；"由哪几号合成"写在名字括号与日志里）。
    //     全部来源都无编号（普通点云合并）⇒ 产物是普通点云，不加编号不加色（今天的行为）。
    //     编号在此刻取"最大 + 1"：来源还在容器里（第 6 步才移除），故新号绝不会与它们相撞。
    const sourceNos = sources.map((s) => s.entity.labelNo).filter((n): n is number => n !== null)
    const identityScope = sourceNos.length > 0 ? sceneStore.labelScopeOf(lead.id) : null
    const mergedNo = identityScope ? sceneStore.nextLabelNo(identityScope) : null
    const mergedName = mergedNo !== null ? mergeProductName(lead.entity.name, sourceNos, mergedNo) : lead.entity.name

    // 3. 树节点：产物挂在主导方项目下
    const mergedEntity = sceneStore.addEntityToProject(leadProject.id, {
      name: mergedName,
      path: lead.entity.path,
      visible: lead.entity.visible,
      pointSize: lead.entity.pointSize,
      colorMode: lead.entity.colorMode,
      // 高程范围沿用主导方（同「着色方式分歧按主导方统一」的既有约定）
      elevationRange: lead.entity.elevationRange,
      showNameIn3D: lead.entity.showNameIn3D,
      displayTarget: lead.entity.displayTarget,
    })

    // 4. 材质克隆自主导方（点大小 / 顶点色开关全实体统一）；装组替换场景中的来源组
    const material = lead.rec.material.clone()
    const group = buildSplitGroup(geometries, material, mergedEntity.id)
    const viewer = getViewer()
    if (viewer) {
      for (const s of sources) {
        viewer.scene.remove(s.rec.group)
      }
    }
    // 名称标签尺寸基准沿用"装组即测半径"惯例（addToScene 不打扰相机视角）
    const radius = viewer ? addToScene(group, false) : 1
    const labelBaseSize = Math.max(radius * LABEL_SIZE_RATIO, 0.01)

    // 5. 登记合并记录：rgbColorAttrs 展开各来源的"应有 RGB"引用；scalar 颜色置 null，
    //    由首次标量着色统一懒重建（classColors 色表全局一致，重算视觉等价）
    for (const s of sources) {
      // 来源实体的显示层随它一起消亡：staging 几何体是它自有的（材质与来源记录共用、
      // 已 clone 给产物，不能在这里释放）
      releaseLod(s.rec)
      cloudRecords.delete(s.id)
    }
    registerCloudRecord(mergedEntity.id, {
      group,
      material,
      geometries,
      rgbColorAttrs: geometries.map((g) => {
        const attr = g.getAttribute('color')
        return attr instanceof THREE.BufferAttribute ? attr : null
      }),
      scalarColorAttrs: null,
      normalColorAttrs: null,
      // 高程色置 null：块序 = 各来源依次拼接，与任何单一来源都不对齐；且合并后
      // 包围盒变了（轴变），键必然对不上，首次高程着色时统一懒重建
      elevationColor: null,
      colorAttrState: 'rgb',
      // 合并不保留法向量（见 1.5 的理由）；主导方原有法向量也一并作废
      hasNormals: false,
      // 分割色**不再丢弃**：产物是新物体，拿全新编号 + 全新色（见 2.5 / 6.5）。
      // （旧实现丢弃它是因为各来源颜色互不相同、谈不上"一个纯色"，于是合并产物一律退回
      // 真彩色——物体的身份在合并处断掉。现在身份由编号续上，颜色自然是新的一个。）
      labelColor: null,
      labelBaseSize,
      bbox,
      pointCount,
      hasColor: lead.rec.hasColor,
      globalShift: lead.rec.globalShift,
      label: null,
      lod: null,
    })

    // 6. 元数据回填 + 移除来源实体（removeEntityFromProject 会从选中集合剔除）+ 选中产物
    sceneStore.updateEntityMeta(mergedEntity.id, {
      pointCount,
      hasColor: lead.rec.hasColor,
      hasNormals: false,
      // 必须如实声明（不能写 false 兜底）：本条会跑降级规则，写 false 会把主导方的
      // 'label' 意图压成 rgb，紧接着的颜色写入就白写了
      hasLabelColor: mergedNo !== null,
      bbox,
      globalShift: lead.rec.globalShift,
    })
    // 6.2 新编号 + 新色（activate: false：继承主导方的显示方式，不替用户改；
    //     主导方若正显示分割色，这一步之后看到的就是合并产物的新色）
    if (mergedNo !== null) {
      setEntityLabelColor(mergedEntity.id, labelColor(mergedNo), mergedNo, { activate: false })
    }
    // 6.5 归属：产物随**主导方**（sources[0]）所在容器，并顶替它的位置——同 splitEntity
    //     的 5.5，锚点必须在源被移除前还活着（合并容器内两棵树 ⇒ 产物留在容器里）
    const dropAt = sceneStore.dropTargetBeside(lead.id)
    if (dropAt) sceneStore.moveEntity(mergedEntity.id, dropAt)
    for (const s of sources) {
      sceneStore.removeEntityFromProject(s.id)
    }
    sceneStore.selectNode({ type: 'entity', id: mergedEntity.id })

    void syncAllToThree()
    log('Merge', `已合并 ${sources.length} 片点云 → 「${mergedEntity.name}」，总点数 ${pointCount.toLocaleString()}`)
    return mergedEntity.id
  }

  /**
   * 把实体按选区结果分割成两个新实体（共享底层顶点缓冲，零拷贝）。
   *
   * 树操作：原实体从项目移除，项目下追加 `<name><first 标签>`（选区内部分）与
   * `<name><second 标签>`（选取外部分）两个新实体；3D 场景同步替换。
   * 属性继承：visible / colorMode / pointSize / displayTarget；不继承 showNameIn3D。
   * bbox 由选区子集包围盒（显示坐标）+ globalShift 还原为原始坐标。
   *
   * **编号与颜色（`opts.deriveIds`）**：本实体是一个"物体"（带编号，如 `Tree 3`）且调用方
   * 要求派生身份（**分割工具**：框选 / 多边形；"把一棵树切成两棵"正是它）时，两个产物各拿
   * 作用域内的新编号（连号），颜色 = 父色按明度铺开的**同族两档**（选区内片取亮档、
   * 选区外片取暗档，见 derivedLabelColors）——"一分为二"于是既保持唯一身份、又能一眼看出
   * 同源。默认**不派生**：滤波 / CSF / RANSAC 走的是同一个函数，那些产物是"数据块"不是
   * "物体"，编号与颜色原样沿用源（今天的行为，`.removed` 这类残片不该占号）。
   *
   * @param entityId 原实体
   * @param selections 每块几何体的选区结果（与 geometries 对齐）
   * @param labels 两个产物的名称标签；分割默认 `.segmented` / `.remaining`，
   *   半径滤波传 `.filtered` / `.removed`。返回键 first/second 对应 labels 顺序。
   * @param opts.deriveIds 是否派生新编号与同族派生色（见上；默认 false）
   * @returns 新实体 id；目标不存在/未加载时返回 null
   */
  function splitEntity(
    entityId: number,
    selections: ChunkSelection[],
    labels?: { first: string; second: string },
    opts?: { deriveIds?: boolean }
  ): { firstId: number; secondId: number } | null {
    const sceneStore = useSceneStore()
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    const project = sceneStore.projects.find((p) => p.entities.some((e) => e.id === entityId))
    if (!rec || !entity || !project) {
      console.warn('分割目标不存在或尚未加载', entityId)
      return null
    }
    const firstLabel = labels?.first ?? '.segmented'
    const secondLabel = labels?.second ?? '.remaining'

    // 1. 按选区把每块几何体一分为二（共享顶点缓冲 + 独立索引）；
    //    逐块跟随收集源记录的两套规范色 attr（rgb = 原始 RGB；scalar = 懒构建标量色）
    const segGeos: THREE.BufferGeometry[] = []
    const remGeos: THREE.BufferGeometry[] = []
    const segRgb: (THREE.BufferAttribute | null)[] = []
    const remRgb: (THREE.BufferAttribute | null)[] = []
    const segScalar: (THREE.BufferAttribute | null)[] = []
    const remScalar: (THREE.BufferAttribute | null)[] = []
    // 法向量色 attr 与标量色同惯例：同一实例直接共享给两个产物（内容只依赖
    // `normalCode`，而码是 buildIndexedGeometry 零拷贝带过的同一批，故恒正确）
    const segNormal: (THREE.BufferAttribute | null)[] = []
    const remNormal: (THREE.BufferAttribute | null)[] = []
    let segCount = 0
    let remCount = 0
    rec.geometries.forEach((g, i) => {
      const sel = selections[i]
      if (!sel) return // 防御：块数对不齐时跳过（正常路径不会发生）
      segGeos.push(buildIndexedGeometry(g, sel.inside))
      remGeos.push(buildIndexedGeometry(g, sel.outside))
      segRgb.push(rec.rgbColorAttrs[i])
      remRgb.push(rec.rgbColorAttrs[i])
      segScalar.push(rec.scalarColorAttrs?.[i] ?? null)
      remScalar.push(rec.scalarColorAttrs?.[i] ?? null)
      segNormal.push(rec.normalColorAttrs?.[i] ?? null)
      remNormal.push(rec.normalColorAttrs?.[i] ?? null)
      segCount += sel.inside.length
      remCount += sel.outside.length
    })
    // 1.5 颜色语义校正：把源当前着色态的规范色 attr 装回两块新几何体
    //（rgb 源永远 = 源记录原始 RGB；scalar = 源标量实例；normal = 源法向量色实例，
    // 见 installCanonicalColorAttrs）
    installCanonicalColorAttrs(
      segGeos,
      rec.colorAttrState,
      segRgb,
      segScalar,
      segNormal,
      rec.elevationColor?.attrs ?? null
    )
    installCanonicalColorAttrs(
      remGeos,
      rec.colorAttrState,
      remRgb,
      remScalar,
      remNormal,
      rec.elevationColor?.attrs ?? null
    )

    // 1.6 编号 + 同族派生色（只有"再分割一个物体"才派生，见 opts.deriveIds 的注释）。
    //     父无编号 ⇒ 两片也无（切一片普通点云不该凭空生出身份）。
    //     两个产物**连号**（base / base+1）且只调一次 nextLabelNo：源此刻还在容器里，
    //     故新号绝不会与它的号相撞（"最大 + 1"永远越过所有现存成员）。
    //     父色取回 sRGB 字节再派生：材质里存的是线性浮点，而派生色的定义域在 sRGB 字节
    //     空间（与人眼一致）；`linearToSrgbU8` 与 `setEntityLabelColor` 的换算是互逆的，
    //     故派生链（切了再切）始终停在同一色相族里。
    const shades =
      opts?.deriveIds === true && entity.labelNo !== null && rec.labelColor
        ? derivedLabelColors(labelColorBytesOf(rec.labelColor), 2)
        : null
    const scope = shades ? sceneStore.labelScopeOf(entityId) : null
    const baseNo = scope ? sceneStore.nextLabelNo(scope) : null

    // 2. 新实体：bbox 还原原始坐标（显示坐标 + globalShift）；空子集退化为基准点
    const shift = rec.globalShift
    const restoreBBox = (b: EntityBBox | null): EntityBBox =>
      b
        ? {
            minX: b.minX + shift.x,
            minY: b.minY + shift.y,
            minZ: b.minZ + shift.z,
            maxX: b.maxX + shift.x,
            maxY: b.maxY + shift.y,
            maxZ: b.maxZ + shift.z,
          }
        : { minX: shift.x, minY: shift.y, minZ: shift.z, maxX: shift.x, maxY: shift.y, maxZ: shift.z }
    // 空块（EMPTY_BBOX 全 0）不参与合并，否则会污染真实包围盒
    const segBBox = restoreBBox(
      combineChunkBBoxes(selections.filter((s) => s.inside.length > 0).map((s) => s.insideBBox))
    )
    const remBBox = restoreBBox(
      combineChunkBBoxes(selections.filter((s) => s.outside.length > 0).map((s) => s.outsideBBox))
    )

    const segEntity = sceneStore.addEntityToProject(project.id, {
      name: `${entity.name}${firstLabel}`,
      path: entity.path,
      visible: entity.visible,
      pointSize: entity.pointSize,
      colorMode: entity.colorMode,
      // 高程范围随分割继承（产物与母云共享顶点缓冲，故范围在新实体上语义同样成立；
      // 若子集恰好落在范围之外，normalizeElevationRange 会规整回满量程，不会一片纯端色）
      elevationRange: entity.elevationRange,
      displayTarget: entity.displayTarget,
    })
    const remEntity = sceneStore.addEntityToProject(project.id, {
      name: `${entity.name}${secondLabel}`,
      path: entity.path,
      visible: entity.visible,
      pointSize: entity.pointSize,
      colorMode: entity.colorMode,
      // 高程范围随分割继承（产物与母云共享顶点缓冲，故范围在新实体上语义同样成立；
      // 若子集恰好落在范围之外，normalizeElevationRange 会规整回满量程，不会一片纯端色）
      elevationRange: entity.elevationRange,
      displayTarget: entity.displayTarget,
    })

    // 3. 材质克隆自原实体（独立调整互不影响；贴图与顶点缓冲共享）
    const segMaterial = rec.material.clone()
    const remMaterial = rec.material.clone()
    const segGroup = buildSplitGroup(segGeos, segMaterial, segEntity.id)
    const remGroup = buildSplitGroup(remGeos, remMaterial, remEntity.id)

    // 4. 场景与记录替换：移除原 group，挂入两个新 group
    const viewer = getViewer()
    if (viewer) {
      viewer.scene.remove(rec.group)
      viewer.scene.add(segGroup)
      viewer.scene.add(remGroup)
    }
    // 原实体的显示层随它一起消亡（产物各自按阈值新建，见 registerCloudRecord）
    releaseLod(rec)
    cloudRecords.delete(entityId)
    registerCloudRecord(segEntity.id, {
      group: segGroup,
      material: segMaterial,
      geometries: segGeos,
      rgbColorAttrs: segRgb,
      // 标量色 attribute 逐块原样共享（同一底层缓冲；null = 未构建，首次标量着色时懒构建）
      scalarColorAttrs: segScalar,
      normalColorAttrs: segNormal,
      // 高程色整对象带过：块序与母云逐块对齐、范围也随实体继承，键相同即内容相同
      // （若子集包围盒/范围与母云不同，键自然不等，首次高程着色时自建）
      elevationColor: rec.elevationColor,
      colorAttrState: rec.colorAttrState,
      // 法向量随分割整体继承（`normalCode` 由 buildIndexedGeometry 白名单零拷贝带过）
      hasNormals: rec.hasNormals,
      // 分割色默认随分割继承（滤波产物保持源色）；"再分割一个物体"（deriveIds）时
      // 紧接着的 5.2 会把它换成同族派生色 + 新编号——先继承再改，只为不必在两处写值
      labelColor: rec.labelColor,
      labelBaseSize: rec.labelBaseSize,
      bbox: segBBox,
      pointCount: segCount,
      hasColor: rec.hasColor,
      globalShift: rec.globalShift,
      label: null,
      lod: null,
    })
    registerCloudRecord(remEntity.id, {
      group: remGroup,
      material: remMaterial,
      geometries: remGeos,
      rgbColorAttrs: remRgb,
      scalarColorAttrs: remScalar,
      normalColorAttrs: remNormal,
      elevationColor: rec.elevationColor,
      colorAttrState: rec.colorAttrState,
      hasNormals: rec.hasNormals,
      labelColor: rec.labelColor,
      labelBaseSize: rec.labelBaseSize,
      bbox: remBBox,
      pointCount: remCount,
      hasColor: rec.hasColor,
      globalShift: rec.globalShift,
      label: null,
      lod: null,
    })

    // 5. 元数据回填 + 移除原实体（removeEntityFromProject 会把指向它的选中清空）
    sceneStore.updateEntityMeta(segEntity.id, {
      pointCount: segCount,
      hasColor: rec.hasColor,
      hasNormals: rec.hasNormals,
      hasLabelColor: rec.labelColor !== null,
      bbox: segBBox,
      globalShift: rec.globalShift,
    })
    sceneStore.updateEntityMeta(remEntity.id, {
      pointCount: remCount,
      hasColor: rec.hasColor,
      hasNormals: rec.hasNormals,
      hasLabelColor: rec.labelColor !== null,
      bbox: remBBox,
      globalShift: rec.globalShift,
    })
    // 5.2 编号与同族派生色（deriveIds 时才有）：亮档给选区内片、暗档给选区外片。
    //     走 setEntityLabelColor——编号与分割色的**唯一**写入口；activate: false = 只继承
    //     身份、不替用户改显示方式（末尾 syncAllToThree 会按当前 colorMode 落地材质）。
    if (shades && baseNo !== null) {
      setEntityLabelColor(segEntity.id, shades[0], baseNo, { activate: false })
      setEntityLabelColor(remEntity.id, shades[1], baseNo + 1, { activate: false })
    }
    // 5.5 归属：产物随源实体所在容器（不在容器内 = 项目顶层），并**顶替它原来的位置**。
    //     顺序是"先建 → 后挪 → 再删源"：挪的时候源还在，两个产物依次落在它正前方
    //     （`[A, seg, rem, 源, C]`），删掉源即得 `[A, seg, rem, C]`——若先删源就没锚点了。
    //     走 moveEntity 进容器 ⇒ 自动打上 manuallyPlaced（分割工具不是容器算法的产出，
    //     重跑单木分割时应当保留，见 sceneStore.SceneEntity.manuallyPlaced）。
    const dropAt = sceneStore.dropTargetBeside(entityId)
    if (dropAt) {
      sceneStore.moveEntity(segEntity.id, dropAt)
      sceneStore.moveEntity(remEntity.id, dropAt)
    }
    sceneStore.removeEntityFromProject(entityId)

    void syncAllToThree()
    return { firstId: segEntity.id, secondId: remEntity.id }
  }

  /**
   * 按分类值把实体拆成多片点云（DB Tree 右键 Split by classification）。
   *
   * 与 splitEntity 同构的零拷贝多片版：每个实际出现的分类值（升序）产出一片
   * `<name>.cls<N>` 子实体；未出现的类不建空实体。每片 = 逐块几何体各挂一份
   * 独立索引（partitionVisibleByClass 按 classification 字节分桶，分类 0-255
   * 全值保真），共享底层顶点缓冲，位置天然正确。
   * 逐块建几何体（无该类顶点的块挂空索引），保证与 rec.scalarColorAttrs /
   * rgbColorAttrs 的块序对齐，标量着色可直接共享既有 attr。
   * 树操作：原实体从项目移除；属性继承 visible / colorMode / pointSize /
   * displayTarget（不继承 showNameIn3D，同 splitEntity）。
   * bbox 由各片顶点子集包围盒（显示坐标）+ globalShift 还原为原始坐标。
   * 拆出的多片可用多选 merge 合并回去（着色按主导方收敛），工作流闭环。
   *
   * @param entityId 原实体
   * @returns 各片实体 id（升序对应分类）；目标不存在/未加载/分类不足两类时返回 null
   */
  function splitByClassification(entityId: number): number[] | null {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    const project = sceneStore.projects.find((p) => p.entities.some((e) => e.id === entityId))
    if (!rec || !entity || !project) {
      log('Split', '分割目标不存在或尚未加载，已取消按分类拆分')
      return null
    }

    // 1. 逐块取出分类字节（防御：缺属性的块中止，避免拆后丢点——正常每块都有）
    const classAttrs: (Uint8Array | null)[] = rec.geometries.map((g) => classificationBytesOf(g))
    if (classAttrs.some((c) => c === null)) {
      log('Split', '存在缺少分类属性的分块，已中止按分类拆分（避免丢点）')
      return null
    }

    // 2. 逐块分桶：可见点集语义见 geometryVisibleIndex（无 index 原始块 = 全量顶点；
    //    带 index 的分割产物 = drawRange 圈出的条目；整区间零拷贝，部分区间先切片）
    const chunkIndicesByClass = new Map<number, (Uint32Array | null)[]>()
    rec.geometries.forEach((g, i) => {
      const parts = partitionVisibleByClass(classAttrs[i] as Uint8Array, geometryVisibleIndex(g))
      for (const [c, indices] of parts) {
        if (!chunkIndicesByClass.has(c)) {
          chunkIndicesByClass.set(
            c,
            rec.geometries.map(() => null)
          )
        }
        chunkIndicesByClass.get(c)![i] = indices
      }
    })

    // 3. 少于两类 = 无可拆（全 0 未分类或单类文件），中止不生成全量复制片
    if (chunkIndicesByClass.size < 2) {
      const only = chunkIndicesByClass.size === 1 ? [...chunkIndicesByClass.keys()][0] : null
      log('Split', only === null ? '该点云没有分类数据，无可拆' : `该点云分类全部为 ${only}，无可拆`)
      return null
    }
    const classList = [...chunkIndicesByClass.keys()].sort((a, b) => a - b)

    // 4. 逐类汇总：点数 + 显示坐标包围盒（positions 全量缓冲按索引取顶点）
    const shift = rec.globalShift
    const perClassMeta = classList.map((cls) => {
      const list = chunkIndicesByClass.get(cls)!
      let pointCount = 0
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      rec.geometries.forEach((g, i) => {
        const idx = list[i]
        if (!idx || idx.length === 0) return
        pointCount += idx.length
        const pos = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
        for (let k = 0; k < idx.length; k++) {
          const p = idx[k] * 3
          minX = Math.min(minX, pos[p])
          minY = Math.min(minY, pos[p + 1])
          minZ = Math.min(minZ, pos[p + 2])
          maxX = Math.max(maxX, pos[p])
          maxY = Math.max(maxY, pos[p + 1])
          maxZ = Math.max(maxZ, pos[p + 2])
        }
      })
      // 显示坐标 → 原始坐标（+globalShift，与 splitEntity.restoreBBox 同语义）
      const hasPoints = Number.isFinite(minX)
      const restored: EntityBBox = hasPoints
        ? {
            minX: minX + shift.x,
            minY: minY + shift.y,
            minZ: minZ + shift.z,
            maxX: maxX + shift.x,
            maxY: maxY + shift.y,
            maxZ: maxZ + shift.z,
          }
        : { minX: shift.x, minY: shift.y, minZ: shift.z, maxX: shift.x, maxY: shift.y, maxZ: shift.z }
      return { cls, pointCount, bbox: restored }
    })

    // 4.5 编号 + 同族派生色：按分类拆开 = 把一个物体切成多层，各层拿作用域内的新编号、
    //     颜色按明度铺开（层序 = 分类值升序，见 derivedLabelColors）。源无编号（普通云
    //     按分类拆分）⇒ 不派生、颜色原样继承（今天的行为：拆出来仍是真彩色）。
    const shades =
      entity.labelNo !== null && rec.labelColor
        ? derivedLabelColors(labelColorBytesOf(rec.labelColor), perClassMeta.length)
        : null
    const scope = shades ? sceneStore.labelScopeOf(entityId) : null
    const baseNo = scope ? sceneStore.nextLabelNo(scope) : null

    // 5. 场景替换：移除原 group，逐类建子实体（空块挂共享空索引，块序与 attrs 对齐）
    const viewer = getViewer()
    if (viewer) {
      viewer.scene.remove(rec.group)
    }
    const emptyIndex = new Uint32Array(0)
    const childIds: number[] = []
    for (const [clsIndex, meta] of perClassMeta.entries()) {
      const childEntity = sceneStore.addEntityToProject(project.id, {
        name: `${entity.name}.cls${meta.cls}`,
        path: entity.path,
        visible: entity.visible,
        pointSize: entity.pointSize,
        colorMode: entity.colorMode,
        // 高程范围随分割继承（产物与母云共享顶点缓冲，故范围在新实体上语义同样成立；
        // 若子集恰好落在范围之外，normalizeElevationRange 会规整回满量程，不会一片纯端色）
        elevationRange: entity.elevationRange,
        displayTarget: entity.displayTarget,
      })
      const geoList = rec.geometries.map((g, i) =>
        buildIndexedGeometry(g, chunkIndicesByClass.get(meta.cls)![i] ?? emptyIndex)
      )
      // 颜色语义校正：rgb 源永远 = 源记录原始 RGB；scalar = 源标量实例。若沿用
      // buildIndexedGeometry 打包的"当前 geometry color"快照，scalar 模式下会丢
      // normalized 整片泛白、且切回 RGB 拿到的也是标量字节（见 installCanonicalColorAttrs）
      installCanonicalColorAttrs(
        geoList,
        rec.colorAttrState,
        rec.rgbColorAttrs,
        rec.scalarColorAttrs,
        rec.normalColorAttrs,
        rec.elevationColor?.attrs ?? null
      )
      const material = rec.material.clone()
      const group = buildSplitGroup(geoList, material, childEntity.id)
      const radius = viewer ? addToScene(group, false) : 1
      const labelBaseSize = Math.max(radius * LABEL_SIZE_RATIO, 0.01)

      registerCloudRecord(childEntity.id, {
        group,
        material,
        geometries: geoList,
        // 与 rec.geometries 逐块对齐，原样共享源记录的原始 RGB 实例
        rgbColorAttrs: rec.rgbColorAttrs,
        // 既有标量色 / 法向量色 attr 直接共享（全量缓冲，index 控制显示，同 splitEntity）
        scalarColorAttrs: rec.scalarColorAttrs,
        normalColorAttrs: rec.normalColorAttrs,
        elevationColor: rec.elevationColor,
        colorAttrState: rec.colorAttrState,
        hasNormals: rec.hasNormals,
        labelColor: rec.labelColor,
        labelBaseSize,
        bbox: meta.bbox,
        pointCount: meta.pointCount,
        hasColor: rec.hasColor,
        globalShift: rec.globalShift,
        label: null,
        lod: null,
      })
      sceneStore.updateEntityMeta(childEntity.id, {
        pointCount: meta.pointCount,
        hasColor: rec.hasColor,
        hasNormals: rec.hasNormals,
        hasLabelColor: rec.labelColor !== null,
        bbox: meta.bbox,
        globalShift: rec.globalShift,
      })
      // 各层拿新编号 + 同族派生色（activate: false，理由同 splitEntity 的 5.2）
      if (shades && baseNo !== null) {
        setEntityLabelColor(childEntity.id, shades[clsIndex], baseNo + clsIndex, { activate: false })
      }
      childIds.push(childEntity.id)
    }

    // 5.5 归属：各片随源实体所在容器（同 splitEntity 的 5.5：先建 → 后挪 → 再删源）。
    //      逐片按 childIds 顺序挪到源正前方，源被移除后即得到原来的相对次序。
    const dropAt = sceneStore.dropTargetBeside(entityId)
    if (dropAt) {
      for (const id of childIds) sceneStore.moveEntity(id, dropAt)
    }

    // 6. 移除原实体（removeEntityFromProject 会把指向它的选中一并剔除）并收敛渲染状态
    sceneStore.removeEntityFromProject(entityId)
    releaseLod(rec)
    cloudRecords.delete(entityId)
    void syncAllToThree()
    log(
      'Split',
      `已将「${entity.name}」按分类拆成 ${childIds.length} 片：` + classList.map((c) => `.cls${c}`).join(' ')
    )
    return childIds
  }

  /**
   * 按调用方给定的逐块顶点下标把实体拆成多片点云（TreeIso 单木分割产物用，
   * 与 splitByClassification 同构的零拷贝多片版）。
   *
   * 每片 = 逐块几何体各挂一份独立索引（parts[].chunkIndices，顶点缓冲空间、
   * 递增），共享底层顶点缓冲，位置天然正确。每片可分别选择归属：树项容器
   * （单木树实体，parts[].groupId）或项目顶层（残点等非树产物，缺省）。
   * 树实体的 treeObject 经 parts[].treeObject 透传给 sceneStore 建档（默认 null）。
   *
   * 树操作：原实体从项目移除；属性继承 visible / colorMode / pointSize /
   * displayTarget（不继承 showNameIn3D，同 splitByClassification）。
   * bbox 由各片顶点子集包围盒（显示坐标）+ globalShift 还原为原始坐标。
   *
   * @param entityId 原实体（拆完即从场景移除，调用方须保证 part 覆盖其全部可见点，
   *   否则点会丢失——与 splitByClassification 的"覆盖全量"语义相同）
   * @param parts   各片定义（顺序即建实体顺序；空片跳过不建）
   * @returns 实际建出的实体 id（顺序对应 parts 过滤空片后；目标不存在/未加载返回 null）
   */
  /**
   * 把实体拆成多个零拷贝索引产物（splitByClassification 泛化为任意多片）。
   *
   * 采样源固定是 entityId（其 cloudRecord 提供 position/颜色/材质/globalShift 等
   * 派生信息）；opts.removeEntityIds 用于"替换集 ≠ 采样源"的树项原地重建——
   * TreeIso 分割树项容器时，采样源取组内任一棵树（组内实体共享同一源顶点缓冲，
   * 见 splitEntityMany 的 chunkIndices 顶点空间语义），被整体替换的却是整个旧组，
   * 见 useTreeIsoStore。
   *
   * @param opts.removeEntityIds 被替换/移除的实体集（默认 [entityId]）。
   *   必须仍在 cloudRecords 或 project.entities 中（按记录逐个校验，
   *   缺记录的跳过——幂等）；会被移出 3D 场景 + 树节点 + 记录表。
   */
  function splitEntityMany(
    entityId: number,
    parts: SplitPart[],
    opts?: { removeEntityIds?: number[] }
  ): number[] | null {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    const project = sceneStore.projects.find((p) => p.entities.some((e) => e.id === entityId))
    if (!rec || !entity || !project) {
      log('Split', '分割目标不存在或尚未加载，已取消')
      return null
    }
    const nonEmpty = parts.filter((p) => p.chunkIndices.some((idx) => idx && idx.length > 0))
    if (nonEmpty.length === 0) {
      log('Split', `「${entity.name}」没有可拆分出的部分，已取消`)
      return null
    }

    // 1. 场景替换：移除原 group（各片零拷贝共享其顶点缓冲，见 buildIndexedGeometry）
    const viewer = getViewer()
    if (viewer) {
      viewer.scene.remove(rec.group)
    }
    const emptyIndex = new Uint32Array(0)
    const shift = rec.globalShift
    const childIds: number[] = []
    for (const part of nonEmpty) {
      // 2. 汇总该片点数 + 显示坐标包围盒（逐块按顶点下标采样全量 position 缓冲）
      let pointCount = 0
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      rec.geometries.forEach((g, i) => {
        const idx = part.chunkIndices[i]
        if (!idx || idx.length === 0) return
        pointCount += idx.length
        const pos = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
        for (let k = 0; k < idx.length; k++) {
          const p = idx[k] * 3
          minX = Math.min(minX, pos[p])
          minY = Math.min(minY, pos[p + 1])
          minZ = Math.min(minZ, pos[p + 2])
          maxX = Math.max(maxX, pos[p])
          maxY = Math.max(maxY, pos[p + 1])
          maxZ = Math.max(maxZ, pos[p + 2])
        }
      })
      const hasPoints = Number.isFinite(minX)
      const restored: EntityBBox = hasPoints
        ? {
            minX: minX + shift.x,
            minY: minY + shift.y,
            minZ: minZ + shift.z,
            maxX: maxX + shift.x,
            maxY: maxY + shift.y,
            maxZ: maxZ + shift.z,
          }
        : { minX: shift.x, minY: shift.y, minZ: shift.z, maxX: shift.x, maxY: shift.y, maxZ: shift.z }

      // 3. 树节点：树实体挂入树项容器（groupId），残点等非树产物直挂项目
      const base = {
        name: part.name,
        path: entity.path,
        visible: entity.visible,
        pointSize: entity.pointSize,
        colorMode: entity.colorMode,
        // 高程范围随分割继承（产物与母云共享顶点缓冲，故范围在新实体上语义同样成立；
        // 若子集恰好落在范围之外，normalizeElevationRange 会规整回满量程，不会一片纯端色）
        elevationRange: entity.elevationRange,
        displayTarget: entity.displayTarget,
        treeObject: part.treeObject ?? null,
      }
      const childEntity =
        part.groupId !== undefined
          ? sceneStore.addEntityToGroup(part.groupId, base)
          : sceneStore.addEntityToProject(project.id, base)
      if (!childEntity) continue // 防御：容器/项目异常（正常路径不会发生）

      // 4. 零拷贝索引几何 + 颜色语义校正（同 splitByClassification 的 geoList 惯例）
      const geoList = rec.geometries.map((g, i) => buildIndexedGeometry(g, part.chunkIndices[i] ?? emptyIndex))
      installCanonicalColorAttrs(
        geoList,
        rec.colorAttrState,
        rec.rgbColorAttrs,
        rec.scalarColorAttrs,
        rec.normalColorAttrs,
        rec.elevationColor?.attrs ?? null
      )
      const material = rec.material.clone()
      const group = buildSplitGroup(geoList, material, childEntity.id)
      const radius = viewer ? addToScene(group, false) : 1
      const labelBaseSize = Math.max(radius * LABEL_SIZE_RATIO, 0.01)

      registerCloudRecord(childEntity.id, {
        group,
        material,
        geometries: geoList,
        // 与 rec.geometries 逐块对齐，原样共享源记录的规范色 attr（语义同 split）
        rgbColorAttrs: rec.rgbColorAttrs,
        scalarColorAttrs: rec.scalarColorAttrs,
        normalColorAttrs: rec.normalColorAttrs,
        // 高程色整对象带过：产物块序与母云逐块对齐，且范围随实体一起继承，
        // 键相同即内容相同（键不同则首次着色时自建，见 elevationKeyOf）
        elevationColor: rec.elevationColor,
        colorAttrState: rec.colorAttrState,
        hasNormals: rec.hasNormals,
        labelColor: rec.labelColor,
        labelBaseSize,
        bbox: restored,
        pointCount,
        hasColor: rec.hasColor,
        globalShift: rec.globalShift,
        label: null,
        lod: null,
      })
      sceneStore.updateEntityMeta(childEntity.id, {
        pointCount,
        hasColor: rec.hasColor,
        hasNormals: rec.hasNormals,
        hasLabelColor: rec.labelColor !== null,
        bbox: restored,
        globalShift: rec.globalShift,
      })
      childIds.push(childEntity.id)
    }

    // 5. 移除被替换的实体集（默认 = 采样源本身；树项原地重建 = 旧组全部树实体，
    //    见 useTreeIsoStore）。与分割替换同一条保守路径：产物的几何/颜色/材质与
    //    旧实体共享底层缓冲或 attr 实例，不能 dispose（显式释放仅用于"无任何引用"
    //    的右键删除，见 deleteEntity/deleteTreeGroup 的 disposeCloudRecord），逐个
    //    移出场景 + 树节点（removeEntityFromProject 会把指向它的选中一并剔除，
    //    并同步从其所属树项容器的 entityIds 剔除）。
    const removals = opts?.removeEntityIds && opts.removeEntityIds.length > 0 ? opts.removeEntityIds : [entityId]
    for (const rid of removals) {
      const oldRec = cloudRecords.get(rid)
      if (oldRec) {
        viewer?.scene.remove(oldRec.group)
        // 显示层随旧实体消亡（几何/颜色/材质与产物共享，不能走 disposeCloudRecord 那条路）
        releaseLod(oldRec)
        cloudRecords.delete(rid)
      }
      sceneStore.removeEntityFromProject(rid)
    }
    void syncAllToThree()
    log('Split', `已将「${entity.name}」拆成 ${childIds.length} 片：` + nonEmpty.map((p) => `「${p.name}」`).join(' '))
    return childIds
  }

  /**
   * 统计实体可见点集的分类分布（属性面板 Classification 区，类号升序）。
   *
   * 与 setEntityClassification 同一"可见点集"语义（见 geometryVisibleIndex）。
   * 容错与写操作不同：缺分类属性的块直接跳过（统计只读不中止），
   * 全部缺失或实体未加载时返回空/null，调用方据此隐藏该区。
   * @returns 类号升序的 { value, count } 列表（count = 可见点数）；实体未加载返回 null
   */
  function getClassificationStats(entityId: number): { value: number; count: number }[] | null {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const totals = new Map<number, number>()
    for (const g of rec.geometries) {
      const cls = classificationBytesOf(g)
      if (!cls) continue
      const index = geometryVisibleIndex(g)
      const n = index ? index.length : cls.length
      for (let i = 0; i < n; i++) {
        const c = index ? cls[index[i]] : cls[i]
        totals.set(c, (totals.get(c) ?? 0) + 1)
      }
    }
    if (totals.size === 0) return []
    return [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }))
  }

  /**
   * 高程分布直方图（属性面板 CC Object 区，仅高程着色时调用，O(N) 懒计算）。
   *
   * 三条口径：
   *  - **可见点集**（geometryVisibleIndex 语义，同 getClassificationStats）：分割 / 滤波产物
   *    与母云共享同一份 position 缓冲，"滤波后跟着变"要看的正是按 index 取的那份分布；
   *  - **轴 = 显示坐标满量程**（elevationAxis(rec.bbox, rec.globalShift)），不随手柄范围缩放；
   *  - **分块 + 每 8 块让出主线程**（同 ensureScalarColorAttrs），1 亿点也不冻结 UI。
   *
   * 缓存是一槽（key 含实体 id，故换选中项必然重算）；戳 = 结构量 + elevationRevision：
   * 前者覆盖加载 / 分割 / 合并 / 烘焙（都走 updateEntityMeta），后者补 setChunkVisibility
   * 的预览路径——两条合起来免掉"谁改了忘了 bump"这一类漏。
   */
  async function getElevationHistogram(entityId: number): Promise<ElevationHistogram | null> {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const key =
      `${entityId}|${rec.pointCount}|${rec.geometries.length}|${elevationRevision.value}|` +
      `${rec.bbox.minZ}|${rec.bbox.maxZ}|${rec.globalShift.z}`
    if (elevationHistogramCache && elevationHistogramCache.key === key) return elevationHistogramCache.result

    const axis = elevationAxis(rec.bbox, rec.globalShift)
    const bins = new Uint32Array(ELEVATION_BINS)
    let total = 0
    for (let i = 0; i < rec.geometries.length; i++) {
      const attr = rec.geometries[i].getAttribute('position')
      if (attr && attr.array instanceof Float32Array) {
        total += histogramOfZ(attr.array, geometryVisibleIndex(rec.geometries[i]), axis, bins)
      }
      if ((i & 7) === 7) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const result: ElevationHistogram = { axis, bins, total }
    elevationHistogramCache = { key, result }
    return result
  }

  /**
   * 把实体可见点集的分类整体重写为同一值（DB Tree 右键 Set classification…）。
   *
   * 写时复制：分割/按分类拆分产物与兄弟实体共享同一批底层顶点缓冲（零拷贝的
   * 代价）——直接原地写 classification 数组会连坐改到别的实体。因此逐块复制一份
   * 分类数组、只在本实体的可见点（geometryVisibleIndex 语义：无 index 原始块 =
   * 全量顶点；带 index 的分割产物 = drawRange 圈出的条目）上写入目标值，再换装
   * 新的 BufferAttribute——兄弟实体仍引用旧数组，完全不受影响。
   * 标量着色缓存随之失效（scalarColorAttrs 可能被兄弟实体共享，不能原地改色），
   * 末尾 syncAllToThree 按当前着色态懒重建（scalar = 从新分类重建并重装；
   * rgb/none = 不动几何体上的 color attr）。RGB 数据永远不动。
   *
   * @param value 目标分类值（0-255 整数；LAS 1.4 全字节范围）
   * @returns 是否写入成功（目标缺失/未加载、值非法、存在缺分类属性的块时 false）
   */
  function setEntityClassification(entityId: number, value: number): boolean {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    if (!rec || !entity) {
      log('Set class', '设值目标不存在或尚未加载，已取消')
      return false
    }
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      log('Set class', `分类值需为 0-255 的整数（收到 ${value}），已取消`)
      return false
    }

    // 1. 校验：每块都要有分类属性，缺一块中止（避免改后丢点，同 splitByClassification）
    for (const g of rec.geometries) {
      if (!g.getAttribute('classification')) {
        log('Set class', '存在缺少分类属性的分块，已中止设值（避免丢点）')
        return false
      }
    }

    // 2. 逐块写时复制：全量复制分类数组 → 可见点写入新值 → 换装新属性实例。
    //    只改本实体自己的 geometry 引用，共享底层数组的兄弟实体不受影响
    for (const g of rec.geometries) {
      const next = rewriteVisibleClass(classificationBytesOf(g) as Uint8Array, geometryVisibleIndex(g), value)
      g.setAttribute('classification', new THREE.BufferAttribute(next, 1))
    }

    // 3. 标量着色缓存失效 + 收敛渲染：旧色实例内容基于旧分类且可能被兄弟实体
    //    共享，只能弃用；syncAllToThree 按当前着色态重建（含 revision 由面板感知）
    rec.scalarColorAttrs = null
    classificationRevision.value++
    void syncAllToThree()
    log(
      'Set class',
      `已将「${entity.name}」的 ${rec.pointCount.toLocaleString()} 点设为分类 ${value}（${className(value)}）`
    )
    return true
  }

  /**
   * 释放单个实体的全部 three.js 资源（DB Tree 右键 Delete 用；幂等，无记录直接返回）。
   *
   * 与分割/合并替换旧实体不同——那两处几何缓冲与产物共享、不能 dispose；被删除的
   * 实体已无任何引用，几何 / 材质 / 名称标签贴图 / 游离颜色 attr 全部释放。
   */
  function disposeCloudRecord(entityId: number) {
    const rec = cloudRecords.get(entityId)
    if (!rec) return
    const viewer = getViewer()
    viewer?.scene.remove(rec.group)
    // 名称标签：Sprite 材质带 Canvas 纹理，独立于实体材质，需单独释放
    if (rec.label) {
      rec.label.material.map?.dispose()
      rec.label.material.dispose()
      rec.label = null
    }
    // LOD 显示层：staging 几何体是该实体自有的，连带它的三个 attribute 一起释放；
    // 材质与语义层共用（下一行才 dispose），不能在这里重复释放
    releaseLod(rec)
    // 逐块几何体 dispose（连带释放挂在 geometry 上的 attribute 的 GPU 缓冲）
    for (const g of rec.geometries) g.dispose()
    // 游离于几何体外的颜色 attr（另一着色态构建、当前未挂载）逐个释放
    for (const attr of [
      ...(rec.rgbColorAttrs ?? []),
      ...(rec.scalarColorAttrs ?? []),
      ...(rec.normalColorAttrs ?? []),
    ]) {
      if (attr && !rec.geometries.some((g) => g.getAttribute('color') === attr)) {
        attr.dispose()
      }
    }
    rec.material.dispose()
    cloudRecords.delete(entityId)
    requestRender() // scene.remove 不会自己触发重绘
  }

  /**
   * 彻底删除单个实体（DB Tree 右键菜单 Delete）：释放 3D 资源 + 移除树节点
   * （removeEntityFromProject 会把指向它的选中一并剔除）。未加载完成时同样生效。
   */
  function deleteEntity(entityId: number) {
    disposeCloudRecord(entityId)
    useSceneStore().removeEntityFromProject(entityId)
  }

  /** 彻底删除整个项目（右键 Delete）：其下实体逐个释放资源 + 移除项目节点（含选中剔除）。 */
  function deleteProject(projectId: number) {
    const sceneStore = useSceneStore()
    const project = sceneStore.projects.find((p) => p.id === projectId)
    if (!project) return
    for (const entity of project.entities) {
      disposeCloudRecord(entity.id)
    }
    sceneStore.removeProject(projectId)
  }

  /**
   * 彻底删除整个树项容器（DB Tree 右键 Delete 树项）：组内实体逐个释放 3D 资源
   * 并移除树节点（removeEntityFromProject 同步从组 entityIds 剔除），最后移除容器
   * （sceneStore.removeTreeGroup）。sceneStore 注释引用的行为，语义同 deleteProject。
   */
  function deleteTreeGroup(groupId: number) {
    const sceneStore = useSceneStore()
    const group = sceneStore.treeGroupById(groupId)
    if (!group) return
    for (const entityId of [...group.entityIds]) {
      disposeCloudRecord(entityId)
      sceneStore.removeEntityFromProject(entityId)
    }
    sceneStore.removeTreeGroup(groupId)
  }

  /**
   * 写入实体的**编号 + 分割色**（两者同生共死，只有这一个写入口，见 sceneStore.labelNo）。
   * 消费方：单木分割 / 欧式聚类的逐株逐簇区分色（`labelColor(编号)`），以及分割 / 合并产物的
   * 继承色（`derivedLabelColors` 派生档 / 合并产物的新色）。
   *
   * 与直觉相反，这里**不碰任何顶点缓冲**：产物是单色的，所以只把颜色写到**材质**上
   * （见 setSolidMaterial）——O(1)、零字节；而原始 RGB（`rgbColorAttrs`，正是
   * `getSaveBatch` 读的那一格）原封不动 ⇒ 产物切回 RGB 看到的是母云真彩色、导出也是
   * 真彩色。旧实现逐块 `new Uint8Array(全量顶点数 × 3)` 顶掉 rgbColorAttrs，K 个簇就是
   * K 倍母云内存（理由与代价见 CloudRecord.labelColor 的注释）。
   *
   * 颜色按 **sRGB 字节**入参（与 `labelColors.labelColor` / `derivedLabelColors` 的产出同刻度，
   * 即"与人眼/取色器一致"），此处转线性 0-1 喂材质（`material.color` 只认线性，见 utils/srgb.ts）
   * ——与预览色的 `srgbByteToLinearByte` 是**同一换算**，只差中间那一步 8 位量化
   * （预览走 Uint8 顶点色、此处走浮点材质色，逐通道差 ≤ 半字节，视觉不可辨），故
   * "预览看到的颜色 == 拆出来的实体颜色"成立（单测钉住这条等价）。
   *
   * ⚠ 与旧实现的一处**行为差异**（有意的）：分割色不再受 `hasColor` 影响。无色云
   * （LAS 点格式 0）拆出来的簇以前一律灰显（rgb 被压成 none），现在同样能看到逐簇区分色
   * ——与预览色"连无色云也要看得见聚类边界"的既有约定对齐。
   *
   * `activate` 决定要不要**替用户切显示方式**，两类调用方的诉求正好相反：
   * - 算法产物（单木分割 / 欧式聚类）默认 `true`：跑完就该看见逐株逐簇的分色，
   *   那是这个操作的意义本身（源在 RGB 模式下也一样）；
   * - 分割 / 合并产物传 `false`：**继承**编号与色即可，不该顺手改显示方式——
   *   用户在 RGB 下切一刀，画面突然跳成分色是意外；源本来在 Label 模式下的话，
   *   继承来的 colorMode 自然就把新色显示出来了（色与号都已就位，随时可切）。
   *   这条路径**刻意不碰材质**：调用方（splitEntity / mergeEntities）末尾都会走一次
   *   `syncAllToThree()`，那个漏斗里的 applyColorMode 会按当前 colorMode 把材质落地
   *   ——包括"继承来就是 label"的情形（此刻材质装的还是 clone 自父物体的旧色，
   *   必须换成新的派生色才看得出浅/深档）。
   *
   * @param color    该物体的 sRGB 字节色（`labelColor(编号)` 或 `derivedLabelColors` 的产物）
   * @param labelNo  物体编号（作用域内唯一，见 sceneStore.nextLabelNo）
   * @returns 实体尚未加载时无操作（返回 false）
   */
  function setEntityLabelColor(
    entityId: number,
    color: { r: number; g: number; b: number },
    labelNo: number,
    opts?: { activate?: boolean }
  ): boolean {
    const sceneStore = useSceneStore()
    const rec = cloudRecords.get(entityId)
    if (!rec) return false
    rec.labelColor = {
      r: srgbToLinear(color.r / 255),
      g: srgbToLinear(color.g / 255),
      b: srgbToLinear(color.b / 255),
    }
    // 走 updateEntityMeta（而不是另开一个 setter）：hasLabelColor 与 hasColor / hasNormals
    // 同属"数据能力"标志，只有这一个写入口才不会与降级规则漂移
    sceneStore.updateEntityMeta(entityId, {
      pointCount: rec.pointCount,
      hasColor: rec.hasColor,
      hasNormals: rec.hasNormals,
      hasLabelColor: true,
      bbox: rec.bbox,
      globalShift: rec.globalShift,
    })
    sceneStore.setEntityLabelNo(entityId, labelNo)
    if (opts?.activate !== false) {
      sceneStore.setEntityColorMode(entityId, 'label')
      // 立即应用一次，不依赖 watch→syncAllToThree 的时序：setEntityColorMode 值未变时
      // 不触发 watch，而材质态是本函数的对外效果，必须自己落地
      setSolidMaterial(rec, rec.labelColor)
      requestRender()
    }
    return true
  }

  /**
   * 装 / 撤某实体的**预览色**（欧式聚类预览等"整片染色"型预览用；attrs = null 为撤下）。
   *
   * 与 setChunkVisibility 那类预览不同：本通道**不动 geometry 的 index**，只换 color
   * attribute —— "未入选"的点不是消失、而是显示为灰，于是能一眼看出聚类边界与残点。
   *
   * 两处必须显式处理（applyColorMode 自己管不到）：
   * - **撤下时要装回规范色**：applyColorMode 按 `mode !== rec.colorAttrState` 决定是否
   *   换装，撤预览时两者相等、它不动手，预览 attr 会留在 geometry 上。
   * - **LOD 显示层要重刷**：显示层的颜色字节是拷贝（见 refreshLod）。
   *
   * @param attrs 与 rec.geometries 逐块对齐的 Uint8 线性色（长度须 = 该块顶点数 × 3；
   *   块数不符直接拒绝，单块长度不符则该块跳过——不装坏数据）
   * @returns 是否已装/撤（实体尚未加载时为 false）
   */
  function setEntityPreviewColors(entityId: number, attrs: (Uint8Array | null)[] | null): boolean {
    const sceneStore = useSceneStore()
    const rec = cloudRecords.get(entityId)
    if (!rec) return false
    if (attrs) {
      if (attrs.length !== rec.geometries.length) return false
      rec.previewColors = rec.geometries.map((geo, i) => {
        const bytes = attrs[i]
        if (!bytes) return null
        const posAttr = geo.getAttribute('position')
        const vertexCount = posAttr ? (posAttr.array as Float32Array).length / 3 : 0
        if (bytes.length !== vertexCount * 3) return null
        return new THREE.BufferAttribute(bytes, 3, true)
      })
    } else {
      rec.previewColors = null
    }
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    if (!entity) return false
    void applyColorMode(rec, entity).then(() => {
      if (!attrs) {
        const canonical = canonicalColorAttrs(rec)
        if (canonical) installColorAttrs(rec, canonical)
      }
      refreshLod(rec)
      requestRender()
    })
    return true
  }

  /**
   * 施加 / 撤销某实体的**临时预览变换**（仿 CC `setGLTransformation`）：只写 Group 的
   * 四元数 + 位置 + 缩放，O(1)、不碰顶点缓冲；`t === null` 按基准快照还原。
   *
   * 唯一容易写错的地方是**合成顺序**：分块几何体装的是 Z-up **显示坐标**，Group 的基准
   * 位姿 B（加载时是 `rotation.x = -π/2`）负责把它摆到世界系。要让显示坐标系的变换 M
   * 作用上去，Group 的新位姿必须是 **`B·M`**（先 M 后 B），按 three 的 `matrix = T·R·S`
   * 合成序展开即：
   *
   *   quaternion = q0 ⊗ qM            // 左乘 = 先转 qM 再转 q0
   *   position   = p0 + s0·(R(q0)·T)  // T 先被 q0 旋转、再被基准缩放，最后加 p0
   *   scale      = s0 · s
   *
   * 之所以不能"直接给 group 加个 M"（也不能省掉 q0 的旋转），就是因为中间还夹着基准
   * 旋转 B；这也是 `scale` 要从 EntityTransform 里单独拿出来的原因——均匀缩放只能落在
   * `group.scale` 上，没法并进四元数或位置。
   * 基准按现状取而非硬编码（见 previewBaselines）。
   *
   * @returns 是否已应用 / 还原（实体尚未加载时为 false）
   */
  function setEntityPreviewTransform(entityId: number, t: EntityTransform | null): boolean {
    const rec = cloudRecords.get(entityId)
    if (!rec) return false
    const group = rec.group

    if (t) {
      let base = previewBaselines.get(entityId)
      if (!base) {
        base = {
          quaternion: group.quaternion.clone(),
          position: group.position.clone(),
          scale: group.scale.clone(),
        }
        previewBaselines.set(entityId, base)
      }
      // 合成公式与"为什么不能直接写 M"见 utils/registration.ts#composePreviewPose（有单测）
      const pose = composePreviewPose(base, t)
      group.quaternion.copy(pose.quaternion)
      group.position.copy(pose.position)
      group.scale.copy(pose.scale)
    } else {
      const base = previewBaselines.get(entityId)
      if (!base) return true // 从没预览过，已在基准位姿上
      group.quaternion.copy(base.quaternion)
      group.position.copy(base.position)
      group.scale.copy(base.scale)
      previewBaselines.delete(entityId)
    }

    // 拾取 / 视锥 / LOD 读的都是 matrixWorld，而它平时只在渲染时更新：预览后若立刻做
    // 射线拾取（还没渲染过一帧）会读到旧位姿，故显式刷新一次（子树一并刷）。
    group.updateMatrixWorld(true)
    // 显示层的视锥标记与取点缓存是按"相机 + 实体位姿"算的，实体自己动了它不知道
    // （调度器只在相机签名变化时自动置脏），这里补一次显式置脏。
    refreshLod(rec)
    requestRender()
    return true
  }

  /**
   * 把变换**永久烘焙进顶点缓冲**（仿 CC `applyGLTransformation_recursive`），并改名
   * `<名称>.registered`（照 CC 惯例，与本仓库 `.plane` / `.cls<N>` 同风格）。
   *
   * 五件必须一起做的事（漏任一处都是"不报错但会咬人"的不一致）：
   *
   * 1. **先撤预览**：预览改的是 Group、烘焙改的是缓冲，不撤就是同一变换作用两次。
   * 2. **写时复制**：分割/合并产物与源实体共享同一个 position 数组（由 buildIndexedGeometry
   *    登记进 sharedPositionBuffers），原地改会**改坏兄弟实体**。命中时新分配的是**整条
   *    缓冲**（母集全量顶点，12 B/点），不做"只留可见点"的压缩——压缩要同时改写 index 与
   *    各属性长度，而"逐块属性长度对齐"是本仓库到处依赖的不变量，为一个只在超大分割产物
   *    上才值得的优化去动它不划算。
   * 3. **重建包围体**：`geo.boundingBox/boundingSphere` 是加载时按旧坐标算的，而
   *    buildIndexedGeometry 还与源几何体**共享同一实例**（注释明写"任何调用方都不改写"），
   *    故必须 applyBoundingVolumes 换装新对象。按**全量顶点**算：它服务视锥剔除与射线早退，
   *    宁大勿小。空块（无顶点）跳过——它的盒是"空 Box3"，塞 Infinity 进去会让 isEmpty
   *    不再成立，measure 的 collectCandidates 就会去读它。
   * 4. **实体 bbox 按可见顶点集**：元数据语义是"自己那部分点"的范围，见 visibleBBoxOf。
   * 5. **重挂 LOD**：八叉树的空间划分（节点立方体、点在哪个节点）是按旧坐标建的，坐标一变
   *    就作废——不重建的话取点读的是新坐标却按旧节点分配，画面缺块 / 错位。releaseLod 顺带
   *    取消在飞建树，随即重挂（重新入队）。两步紧挨着做，不留"语义层裸奔一帧"的中间态。
   *
   * 元数据同步：`rec.bbox` 与 SceneEntity.bbox 都是**文件原始坐标**（显示坐标 + globalShift，
   * 与 splitEntity 的 restoreBBox 同惯例）；globalShift 自身不变（只在显示坐标系里动）。
   *
   * @returns 是否烘焙成功（实体尚未加载时为 false）
   */
  function bakeEntityTransform(entityId: number, t: EntityTransform): boolean {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    if (!rec || !entity) {
      log('Registration', '配准目标不存在或尚未加载，已取消')
      return false
    }
    setEntityPreviewTransform(entityId, null) // ① 同一变换不作用两次

    // three 的 matrix 元素是**列主序**存储：R 在 0..10（三列），T 在 12..14
    const e = t.matrix.elements
    const r00 = e[0]
    const r01 = e[4]
    const r02 = e[8]
    const r10 = e[1]
    const r11 = e[5]
    const r12 = e[9]
    const r20 = e[2]
    const r21 = e[6]
    const r22 = e[10]
    const tx = e[12]
    const ty = e[13]
    const tz = e[14]
    const s = t.scale

    // 全实体（可见集）包围盒：显示坐标，末尾统一 +globalShift 换回原始坐标
    let gMinX = Infinity
    let gMinY = Infinity
    let gMinZ = Infinity
    let gMaxX = -Infinity
    let gMaxY = -Infinity
    let gMaxZ = -Infinity

    for (const geo of rec.geometries) {
      const posAttr = geo.getAttribute('position')
      if (!posAttr || !(posAttr.array instanceof Float32Array)) continue
      const src = posAttr.array
      if (src.length === 0) continue // 空块：它的"空 Box3"要保留（见 ③）
      const dst = sharedPositionBuffers.has(src) ? new Float32Array(src.length) : src
      let cMinX = Infinity
      let cMinY = Infinity
      let cMinZ = Infinity
      let cMaxX = -Infinity
      let cMaxY = -Infinity
      let cMaxZ = -Infinity
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i]
        const y = src[i + 1]
        const z = src[i + 2]
        // P' = s·(R·P) + T，顺序见 EntityTransform 的注释（T 不被缩放）；
        // 逐点只走 double 标量算术，故不复用 utils/registration.ts#applyEntityTransformToPoint
        // （那是单测对照版，每点 new 一个 Vector3，百万点级就是灾难）
        const nx = s * (r00 * x + r01 * y + r02 * z) + tx
        const ny = s * (r10 * x + r11 * y + r12 * z) + ty
        const nz = s * (r20 * x + r21 * y + r22 * z) + tz
        dst[i] = nx
        dst[i + 1] = ny
        dst[i + 2] = nz
        if (nx < cMinX) cMinX = nx
        if (ny < cMinY) cMinY = ny
        if (nz < cMinZ) cMinZ = nz
        if (nx > cMaxX) cMaxX = nx
        if (ny > cMaxY) cMaxY = ny
        if (nz > cMaxZ) cMaxZ = nz
      }
      if (dst !== src) {
        geo.setAttribute('position', new THREE.BufferAttribute(dst, 3))
      } else {
        posAttr.needsUpdate = true // 原地改写：显式告知 GPU 重传
      }
      applyBoundingVolumes(geo, [cMinX, cMinY, cMinZ], [cMaxX, cMaxY, cMaxZ]) // ③
      // ④ 无索引块（加载时的原始分块）可见集就是全量，省一趟遍历
      const visibleIndex = geometryVisibleIndex(geo)
      const box = visibleIndex
        ? visibleBBoxOf(dst, visibleIndex)
        : { minX: cMinX, minY: cMinY, minZ: cMinZ, maxX: cMaxX, maxY: cMaxY, maxZ: cMaxZ }
      if (box) {
        if (box.minX < gMinX) gMinX = box.minX
        if (box.minY < gMinY) gMinY = box.minY
        if (box.minZ < gMinZ) gMinZ = box.minZ
        if (box.maxX > gMaxX) gMaxX = box.maxX
        if (box.maxY > gMaxY) gMaxY = box.maxY
        if (box.maxZ > gMaxZ) gMaxZ = box.maxZ
      }
    }

    const shift = rec.globalShift
    if (Number.isFinite(gMinX) && Number.isFinite(gMinY) && Number.isFinite(gMinZ)) {
      rec.bbox = {
        minX: gMinX + shift.x,
        minY: gMinY + shift.y,
        minZ: gMinZ + shift.z,
        maxX: gMaxX + shift.x,
        maxY: gMaxY + shift.y,
        maxZ: gMaxZ + shift.z,
      }
      // 标签位置取自 bbox 中心（见 createLabel），坐标变了必须重建：
      // 先释放，末尾 syncAllToThree → applyShowName 会按新 bbox 与（改名后的）文本重建
      disposeLabel(rec)
      releaseLod(rec) // ⑤ 旧八叉树作废
      // ⑥ 高程色作废：顶点被**原地改写**（同缓冲复用），而高程色的字节内容完全由 z 决定
      //     ——这是全仓库唯一一处原地改坐标的路径，不置 null 就会留下"颜色与高度对不上"
      //    的静默错色。语义层可能被兄弟实体共享，故只能弃用、不能原地重算
      rec.elevationColor = null
      applyLodPolicy(rec, entity) // 立即重挂（重新入队建树）
      sceneStore.updateEntityMeta(entityId, {
        pointCount: rec.pointCount,
        hasColor: rec.hasColor,
        hasNormals: rec.hasNormals,
        hasLabelColor: rec.labelColor !== null,
        bbox: rec.bbox,
        globalShift: shift,
      })
    }
    // 名字留记号（同名再配一次会得到 xxx.registered.registered，与 CC 一致）
    sceneStore.renameEntity(entityId, `${entity.name}.registered`)

    void syncAllToThree()
    return true
  }

  /**
   * 写入法向量（估计完成后由 normalStore 调用）。
   *
   * `codes` 是 native 回包的「**每候选一个码**」并行数组（本模块的契约特点，见
   * utils/normalEstimate.ts 的文件头说明），本函数负责摊成「每顶点一个码」再装成
   * `normalCode` 属性——把「属性长度 == position 顶点数」这条不变量收敛在一处。
   *
   * 逐块核对候选数后才写入：错位写入会污染相邻顶点（且很难从画面上看出来）。
   *
   * @param codes 与 rec.geometries 逐块对齐；`codes[c].length` 必须等于该块候选数
   *   （`index ? index.length : vertexCount`），否则整体拒绝（防错位）
   * @returns 是否写入成功
   */
  function setEntityNormalCodes(entityId: number, codes: Uint16Array[]): boolean {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    if (!rec || !entity) {
      log('Normals', '法向量写入目标不存在或尚未加载，已取消')
      return false
    }
    if (codes.length !== rec.geometries.length) {
      log(
        'Normals',
        `法向量块数不匹配（结果 ${codes.length} / 当前几何 ${rec.geometries.length}），已取消；实体可能已被分割或合并`
      )
      return false
    }
    const chunks = getFilterSourceChunks(entityId)
    if (!chunks) {
      log('Normals', `「${entity.name}」的几何缺少 position 属性，已取消`)
      return false
    }
    for (let i = 0; i < chunks.length; i++) {
      const expect = candidateCountOfChunk(chunks[i])
      if (codes[i].length !== expect) {
        log(
          'Normals',
          `法向量点数不匹配（第 ${i} 块：结果 ${codes[i].length} / 候选 ${expect}），已取消；实体可能已被分割`
        )
        return false
      }
    }

    // 摊成顶点缓冲空间（无 index 的块走零拷贝快路径，返回的就是 codes[c] 本身）
    const vertexSpace = scatterNormalCodes(chunks, codes)
    rec.geometries.forEach((g, i) => {
      g.setAttribute('normalCode', new THREE.BufferAttribute(vertexSpace[i], 1))
    })
    rec.hasNormals = true
    // 码变了 → 法向量颜色缓存作废（旧实例可能被兄弟实体共享，只能弃用不能原地改）
    rec.normalColorAttrs = null
    normalsRevision.value++
    sceneStore.updateEntityMeta(entityId, {
      pointCount: rec.pointCount,
      hasColor: rec.hasColor,
      hasNormals: true,
      hasLabelColor: rec.labelColor !== null,
      bbox: rec.bbox,
      globalShift: rec.globalShift,
    })
    // 当前着色态为 normal 时（重算场景）按新码重建色表；其余态按兵不动
    void syncAllToThree()
    return true
  }

  /**
   * 反转实体的全部法向量（`Edit > Normals > Invert`）。
   *
   * 只翻 3 个符号位（纯位运算，不解码重建）——与 CC 的 `ccPointCloud::invertNormals`
   * 完全一致。对**全量**顶点生效（无选区概念，同 CC）。
   *
   * 写时复制：分割产物与兄弟实体共享同一批底层数组（零拷贝的代价），原地 `^=` 会
   * 连坐改到别的实体，故逐块新建数组换装。空码取反仍是空码（`invertNormalCode` 保证）。
   *
   * @returns 是否反转成功（目标缺失/未加载/无法向量时 false）
   */
  function invertEntityNormals(entityId: number): boolean {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    if (!rec || !entity) {
      log('Normals', '反转目标不存在或尚未加载，已取消')
      return false
    }
    if (!rec.hasNormals) {
      log('Normals', `「${entity.name}」没有法向量，已取消反转；请先执行 Compute`)
      return false
    }

    let flipped = 0
    let nulls = 0
    for (const g of rec.geometries) {
      const attr = g.getAttribute('normalCode')
      if (!attr) continue
      const src = new Uint16Array(attr.array.buffer, attr.array.byteOffset, attr.array.length)
      const next = new Uint16Array(src.length)
      for (let i = 0; i < src.length; i++) {
        const code = src[i]
        if (code === NULL_NORM_CODE) nulls++
        else flipped++
        next[i] = invertNormalCode(code)
      }
      g.setAttribute('normalCode', new THREE.BufferAttribute(next, 1))
    }
    rec.normalColorAttrs = null
    normalsRevision.value++
    void syncAllToThree()
    log(
      'Normals',
      `已反转「${entity.name}」的 ${flipped.toLocaleString()} 个法向量` +
        (nulls > 0 ? `（${nulls.toLocaleString()} 个空码保持原样）` : '')
    )
    return true
  }

  /**
   * 清除实体的法向量（`Edit > Normals > Delete normals`）。
   *
   * 删除几何体上的 `normalCode` 属性（而不是只把 hasNormals 置 false：属性留着会被
   * buildIndexedGeometry 的白名单带进后续分割，状态与数据就对不上了）。
   * 若当前正以 `Normal RGB` 着色，sceneStore.updateEntityMeta 会把着色方式压回 none。
   *
   * @returns 是否真的清除了（目标缺失/本来就没有法向量时 false）
   */
  function clearEntityNormals(entityId: number): boolean {
    const sceneStore = useSceneStore()
    const log = useConsoleStore().log
    const rec = cloudRecords.get(entityId)
    const entity = sceneStore.getAllEntities().find((e) => e.id === entityId)
    if (!rec || !entity) {
      log('Normals', '清除目标不存在或尚未加载，已取消')
      return false
    }
    if (!rec.hasNormals) {
      log('Normals', `「${entity.name}」本来就没有法向量`)
      return false
    }

    for (const g of rec.geometries) {
      g.deleteAttribute('normalCode')
    }
    // 被删的 attr 从不进 GPU（无 shader 程序声明 'normalCode'），且底层数组可能被
    // 兄弟实体共享，故不调 attr.dispose()——与语义层其余共享属性的纪律一致
    rec.hasNormals = false
    rec.normalColorAttrs = null
    normalsRevision.value++
    sceneStore.updateEntityMeta(entityId, {
      pointCount: rec.pointCount,
      hasColor: rec.hasColor,
      hasNormals: false,
      hasLabelColor: rec.labelColor !== null,
      bbox: rec.bbox,
      globalShift: rec.globalShift,
    })
    void syncAllToThree()
    log('Normals', `已清除「${entity.name}」的法向量`)
    return true
  }

  /**
   * 统计实体可见点集的法向量覆盖情况（属性面板读数）。
   *
   * 与 getClassificationStats 同口径：只统计**可见点集**（带 index 的分割产物 =
   * 索引条目指向的顶点，无 index 的原始块 = 全量顶点）。
   * @returns { total, computed, nullCount }；实体未加载返回 null，无法向量返回 null
   */
  function getNormalStats(entityId: number): { total: number; computed: number; nullCount: number } | null {
    const rec = cloudRecords.get(entityId)
    if (!rec || !rec.hasNormals) return null
    let total = 0
    let nullCount = 0
    for (const g of rec.geometries) {
      const attr = g.getAttribute('normalCode')
      if (!attr) continue
      const codes = new Uint16Array(attr.array.buffer, attr.array.byteOffset, attr.array.length)
      const index = geometryVisibleIndex(g)
      const n = index ? index.length : codes.length
      for (let i = 0; i < n; i++) {
        total++
        if (codes[index ? index[i] : i] === NULL_NORM_CODE) nullCount++
      }
    }
    return { total, computed: total - nullCount, nullCount }
  }

  /**
   * 逐块取法向量量化码（零拷贝引用 `normalCode` 属性的底层数组），与 `rec.geometries` 对齐。
   *
   * **返回值是「顶点缓冲空间」的**（长度 = 该块顶点数，与 `normalCode` 属性同布局），
   * 不是候选子集——RANSAC 圆柱拟合的 `normals` 入参要的正是这个形态，故这里不做任何筛选或搬运
   * （筛选在 native 侧按 index 取 `codes[index[k]]`）。
   *
   * @returns 逐块数组，块上没法向量时该项为 null；实体未加载返回 null
   */
  function getNormalCodeChunks(entityId: number): (Uint16Array | null)[] | null {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const out: (Uint16Array | null)[] = []
    for (const g of rec.geometries) {
      const attr = g.getAttribute('normalCode')
      if (!attr) {
        out.push(null)
        continue
      }
      // 防御性再包一层视图（理由同 getNormalStats：attribute 的 array 可能是带 offset 的视图）
      out.push(new Uint16Array(attr.array.buffer, attr.array.byteOffset, attr.array.length))
    }
    return out
  }

  /**
   * 逐块取分类字节（零拷贝引用 `classification` 属性的底层数组），与 `rec.geometries` 对齐。
   *
   * **返回值是「顶点缓冲空间」的**（长度 = 该块顶点数，与属性同布局），与
   * `getNormalCodeChunks` 同款——消费方是电力线提取的地面参考面：`class == 2` 的点
   * 就是地面点，把它当"逐块地面点下标"直接喂 `utils/groundGrid.ts#buildGroundGrid`，
   * 后者要的正是顶点空间下标（不是候选子集）。
   *
   * ⚠ 与 `getSaveClassificationMax`（**只**统计可见点）的差别：这里是**整块全量**顶点，
   * 但电力线模态的目标是单实体、且 `identity` 情形下 index 就是全量（分割产物另说）——
   * 与 `getFilterSourceChunks` 一样，可见性由消费方用 index 圈定，本函数不做筛选。
   *
   * @returns 逐块字节，块上无该属性时该项为 null；实体未加载返回 null
   */
  function getClassificationChunks(entityId: number): (Uint8Array | null)[] | null {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const out: (Uint8Array | null)[] = []
    for (const g of rec.geometries) out.push(classificationBytesOf(g))
    return out
  }

  /**
   * 取半径滤波的候选源（逐块零拷贝引用 geometry 底层缓冲）。
   *
   * 候选语义与分割选区一致（见 segmentSelection 注释第 4 条）：可见点集 = 该块
   * geometry.index 条目的顶点下标（带 index 的分割产物），无 index 的原始块 = 全量
   * 顶点。positions 与 index 均直接引用 attribute 底层数组，不复制。
   *
   * @returns 与 rec.geometries 对齐的逐块候选源；实体未加载返回 null
   */
  function getFilterSourceChunks(entityId: number): RadiusFilterChunkSource[] | null {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const sources: RadiusFilterChunkSource[] = []
    for (const g of rec.geometries) {
      const positionAttr = g.getAttribute('position')
      if (!positionAttr) return null // 防御：正常路径每块都有 position
      sources.push({ positions: positionAttr.array as Float32Array, index: geometryVisibleIndex(g) })
    }
    return sources
  }

  /**
   * 另存为计划（File ▸ Save as…）：逐块可见点数、总点数、有无颜色、原始坐标包围盒、
   * 基准点。**不复制任何点数据**，O(块数)。
   *
   * 与 getFilterSourceChunks 同为云记录的只读出口，两处语义必须一致：
   * **可见子集由 geometry.index 圈定**（分割 / 滤波 / 配准产物与源实体共享同一份
   * 顶点缓冲，直接按 positions 全量取会把整片源点云写出去）。
   *
   * @returns 实体尚未加载返回 null
   */
  function getSavePlan(entityId: number): SavePlan | null {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const chunks: SavePlanChunk[] = []
    let totalPoints = 0
    rec.geometries.forEach((g, i) => {
      const positionAttr = g.getAttribute('position')
      const vertexCount = positionAttr ? Math.floor((positionAttr.array as Float32Array).length / 3) : 0
      const points = visibleCountOf(geometryVisibleIndex(g), vertexCount)
      if (points > 0) {
        chunks.push({ index: i, points })
        totalPoints += points
      }
    })
    return {
      chunks,
      totalPoints,
      hasColor: rec.hasColor,
      bbox: rec.bbox,
      basePoint: { x: rec.globalShift.x, y: rec.globalShift.y, z: rec.globalShift.z },
    }
  }

  /**
   * 取某实体第 `chunkIndex` 块的 [start, start + count) 个**可见点**的写盘数据。
   *
   * 颜色取 **rec.rgbColorAttrs**（实体自己的 RGB）而非 geometry 上当前装的 color
   * attribute：后者可能是标量分类色 / 法向量色 / 聚类预览色这类**显示态**，写进文件
   * 等于把"当前配色"永久烘焙（与 CloudCompare 一致：LAS/PLY 存的是实体的 RGB 字段，
   * 与着色模式的显示无关）。形态有 Float32 线性 0-1（加载来，绝大多数）与 Uint8 线性
   * 字节（防御性支持的历史形态）两种，buildSaveBatch 一并按 sRGB 编码落字节。
   * **分割色（label）不在这里**——它存在材质上（见 CloudRecord.labelColor），因此
   * 分割产物导出的是它继承来的原始真彩色，不是屏幕上那套分色。**编号走另一条路**：
   * 每点 treeid 由 `treeIdOverride` 写成实体编号（见那里），于是"哪棵树"随文件走。
   *
   * @returns 实体未加载 / 块号越界 / 区间越界返回 null（不抛：调用方按 getSavePlan 分批）
   */
  function getSaveBatch(entityId: number, chunkIndex: number, start: number, count: number): SaveBatch | null {
    const rec = cloudRecords.get(entityId)
    if (!rec) return null
    const g = rec.geometries[chunkIndex]
    if (!g) return null
    const positionAttr = g.getAttribute('position')
    if (!positionAttr) return null
    const colorAttr = rec.rgbColorAttrs[chunkIndex] ?? null
    // 编号落盘：实体带编号（是个"物体"）时，每点 treeid 一律写成它的编号——
    // **覆盖**掉几何体上从文件读来的 treeid 属性，而不是原地改写属性（产物与母云共享
    // 同一份顶点缓冲，改写会污染兄弟实体）。于是本仓库产出的文件里 treeid 恒等于导出
    // 实体的编号：CC 里能按 Point Source ID 分色，我们自己读回来也认得出是哪棵树。
    const labelNo =
      useSceneStore()
        .getAllEntities()
        .find((e) => e.id === entityId)?.labelNo ?? null
    try {
      return buildSaveBatch(
        {
          positions: positionAttr.array as Float32Array,
          index: geometryVisibleIndex(g),
          colors: colorAttr ? (colorAttr.array as Float32Array | Uint8Array) : null,
          classification: classificationBytesOf(g),
          treeIds: treeIdWordsOf(g),
          treeIdOverride: labelNo,
        },
        start,
        count
      )
    } catch {
      return null
    }
  }

  /**
   * 实体全部分类的最大值（LAS 可行性判定用；实体未加载返回 0）。
   *
   * LAS 1.2 的分类只有低 5 位，越界值写进去会**静默丢高位**，故保存前先扫一遍；
   * 越界时由调用方拒绝写 LAS 并提示改用 PLY（PLY 的分类是完整 uchar，无损）。
   */
  function getSaveClassificationMax(entityId: number): number {
    const rec = cloudRecords.get(entityId)
    if (!rec) return 0
    let max = 0
    for (const g of rec.geometries) {
      const m = maxClassificationOf(classificationBytesOf(g))
      if (m > max) max = m
    }
    return max
  }

  return {
    loadLargePly,
    loadLargeLas,
    readPointCloud,
    getSegmentTargets,
    getVisibleTargets,
    setChunkVisibility,
    beginSegmentPreview,
    endSegmentPreview,
    splitEntity,
    splitByClassification,
    getClassificationStats,
    setEntityClassification,
    mergeEntities,
    classificationRevision,
    normalsRevision,
    getElevationHistogram,
    elevationRevision,
    setEntityNormalCodes,
    invertEntityNormals,
    clearEntityNormals,
    getNormalStats,
    getNormalCodeChunks,
    getClassificationChunks,
    getFilterSourceChunks,
    getSavePlan,
    getSaveBatch,
    getSaveClassificationMax,
    hasCloudRecords,
    fitViewTo,
    deleteEntity,
    deleteProject,
    splitEntityMany,
    deleteTreeGroup,
    setEntityLabelColor,
    setEntityPreviewColors,
    setEntityPreviewTransform,
    bakeEntityTransform,
  }
}

/**
 * 取出某块几何体当前可见的顶点 id 列表（分割 / 滤波 / 统计 / 重设分类共用语义）：
 * 无 index 的原始块 = 全量顶点（返回 null）；带 index 的分割产物 = 其条目指向的
 * 顶点，drawRange 圈出显示区间。整区间时直接返回底层数组（零拷贝），部分区间
 * 先切片成独立数组（防读到区间外顶点；setChunkVisibility / buildIndexedGeometry
 * 目前都写全量，部分区间仅防御未来出现）。
 */
function geometryVisibleIndex(g: THREE.BufferGeometry): Uint32Array | null {
  const indexAttr = g.index
  if (!indexAttr) return null
  const arr = indexAttr.array as Uint32Array
  const count = indexAttr.count
  const start = Math.min(Math.max(g.drawRange.start, 0), count)
  const end = Number.isFinite(g.drawRange.count) ? Math.min(count, g.drawRange.start + g.drawRange.count) : count
  return start === 0 && end === arr.length ? arr : arr.slice(start, end)
}

/** 取某块几何体的分类字节（共享底层缓冲的视图；与 ensureScalarColorAttrs 同一取值惯例）。 */
function classificationBytesOf(g: THREE.BufferGeometry): Uint8Array | null {
  const attr = g.getAttribute('classification')
  if (!attr) return null
  return new Uint8Array(attr.array.buffer, attr.array.byteOffset, attr.array.length)
}

/** 取某块几何体的树 ID（Uint16 视图；无该属性返回 null）。语义同 classificationBytesOf。 */
function treeIdWordsOf(g: THREE.BufferGeometry): Uint16Array | null {
  const attr = g.getAttribute('treeid')
  if (!attr) return null
  return new Uint16Array(attr.array.buffer, attr.array.byteOffset, attr.array.length)
}

/**
 * 用"共享同一批 TypedArray"的新 BufferAttribute 包装原几何体的 attributes，
 * 并挂上独立索引。分割出的两块点云因此零拷贝共享顶点数据，各用一套索引
 * 表示自己那部分点（底层 ArrayBuffer 只有一份，顶点数据不复制）。
 */
function buildIndexedGeometry(src: THREE.BufferGeometry, indices: Uint32Array): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  // ⚠ 白名单：这里是"哪些属性跟着分割产物走"的唯一定义。漏一个名字，该属性会在
  // 第一次分割后**静默消失**（无报错）——'normalCode' 就是为此加的（法向量是
  // 每顶点数据，必须逐块带过，否则子实体切到 Normal RGB 会整片黑）。
  // 这些属性都从不进算法入口（那是 index 通道的事），故零拷贝带过没有副作用。
  for (const name of ['position', 'color', 'classification', 'treeid', 'normalCode'] as const) {
    const attr = src.getAttribute(name)
    if (!attr) continue
    // 同一 TypedArray 引用（零拷贝）：count 保持全量，由 index + drawRange 控制显示。
    // normalized 必须原样带过：scalar 着色装入的 color 是 Uint8 归一化属性
    // （normalized=true），漏掉会把 0-255 当线性值采样 → 整片泛白
    geo.setAttribute(name, new THREE.BufferAttribute(attr.array, attr.itemSize, attr.normalized))
    // 位置缓冲登记进"共享表"：配准烘焙原地改写坐标前靠它判定要不要写时复制
    // （见 sharedPositionBuffers 的注释；改坐标是唯一会破坏共享的写入）
    if (name === 'position') sharedPositionBuffers.add(attr.array as Float32Array)
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  // 包围体直接**共享**源几何体的实例：两者持有同一 position 数组（全量顶点），
  // 子集必然落在母集包围体内，故保守正确。共享而非克隆是为省掉 splitEntityMany
  // 上百实体 × 上百分块的小对象分配；任何调用方都不改写这两个对象。
  geo.boundingBox = src.boundingBox
  geo.boundingSphere = src.boundingSphere
  return geo
}

/**
 * 把"当前着色态对应的规范色 attr"装回新几何体（分割产物建档用）。
 *
 * 语义校正背景：buildIndexedGeometry 打包的 color 是"打包时刻 geometry 上装的
 * attr"——scalar 模式下是标量色字节，不能当作子实体的 RGB 源。子实体必须永远：
 *  - rgb 源 = 源记录 rgbColorAttrs 里的原始 RGB attr（原样共享同一实例）；
 *  - scalar 源 = 源记录 scalarColorAttrs（懒构建的归一化实例）；
 *  - normal 源 = 源记录 normalColorAttrs（懒构建的归一化实例；只依赖 `normalCode`，
 *    码未变即可安全共享——分割产物的码是零拷贝带过的同一批，故共享恒正确）；
 *  - elevation 源 = 源记录 elevationColor.attrs（懒构建的归一化实例；依赖
 *    `(positions, 规整后的范围)`——范围随分割继承且量程相同时键相同，故同样可安全共享，
 *    键不同时子实体在首次着色时自建，见 elevationKeyOf）。
 * 按源记录的着色态把对应规范实例装回各块（含 normalized 标志），之后
 * applyColorMode 切换各态都走这几套列表，语义不回串。
 * @param targets 逐块新几何体（块序与 attrs 列表对齐；空块也占位）
 * @param state 源记录的着色态
 * @param rgbAttrs 源记录原始 RGB attr（逐块对齐）
 * @param scalarAttrs 源记录标量 attr（逐块对齐；null = 从未构建 → 态不可能为 scalar）
 * @param normalAttrs 源记录法向量色 attr（逐块对齐；null = 从未构建 → 态不可能为 normal）
 * @param elevationAttrs 源记录高程色 attr（逐块对齐；null = 从未构建 → 态不可能为 elevation）
 */
function installCanonicalColorAttrs(
  targets: THREE.BufferGeometry[],
  state: 'rgb' | 'scalar' | 'normal' | 'elevation',
  rgbAttrs: (THREE.BufferAttribute | null)[],
  scalarAttrs: (THREE.BufferAttribute | null)[] | null,
  normalAttrs: (THREE.BufferAttribute | null)[] | null,
  elevationAttrs: (THREE.BufferAttribute | null)[] | null
) {
  targets.forEach((geo, i) => {
    const attr =
      state === 'scalar'
        ? (scalarAttrs?.[i] ?? null)
        : state === 'normal'
          ? (normalAttrs?.[i] ?? null)
          : state === 'elevation'
            ? (elevationAttrs?.[i] ?? null)
            : (rgbAttrs[i] ?? null)
    if (attr) geo.setAttribute('color', attr)
  })
}

/**
 * 把一组分块几何体装进新 Group（显示变换与原云一致：Z-up → Y-up）；分割/合并产物共用。
 * @param entityId 产物实体 id，写进各 Points 的 userData 供拾取反查（见 measure.ts 的 PointsTag）
 */
function buildSplitGroup(
  geometries: THREE.BufferGeometry[],
  material: THREE.PointsMaterial,
  entityId: number
): THREE.Group {
  const group = new THREE.Group()
  group.rotation.x = -Math.PI / 2
  geometries.forEach((geometry, i) => {
    const points = new THREE.Points(geometry, material)
    // 同 buildPointsGroup：包围体由 buildIndexedGeometry 从源几何体继承，剔除为 O(1)
    points.frustumCulled = true
    const tag: PointsTag = { entityId, chunkIndex: i }
    points.userData = tag
    group.add(points)
  })
  return group
}

/** 合并各分块的包围盒（逐轴取 min/max）；全部为 null 时返回 null。 */
function combineChunkBBoxes(bboxes: (EntityBBox | null)[]): EntityBBox | null {
  let combined: EntityBBox | null = null
  for (const b of bboxes) {
    if (!b) continue
    if (!combined) {
      combined = { ...b }
      continue
    }
    combined.minX = Math.min(combined.minX, b.minX)
    combined.minY = Math.min(combined.minY, b.minY)
    combined.minZ = Math.min(combined.minZ, b.minZ)
    combined.maxX = Math.max(combined.maxX, b.maxX)
    combined.maxY = Math.max(combined.maxY, b.maxY)
    combined.maxZ = Math.max(combined.maxZ, b.maxZ)
  }
  return combined
}
