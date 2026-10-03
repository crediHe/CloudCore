import { reactive, computed, ref } from 'vue'
import { resolveColorMode } from '../utils/colorMode'
import type { TreeMetrics, TreePoint } from '../utils/treeMetrics'

/**
 * 场景树状态（模块级单例）。
 *
 * 结构仿 CloudCompare 的 DB Tree：每次打开一个文件创建一个"项目"节点，
 * 项目下挂实际的点云实体；层级上可有第三级「树项」容器（TreeIso 单木分割
 * 产物，见 SceneTreeGroup）——实体始终平铺在项目 entities 下，容器只记 id。
 * 树状态需要被 3D 视图、属性面板等组件共享，因此不放在组件内部。
 */

/** 点云包围盒（文件原始坐标，double 精度）。 */
export interface EntityBBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/**
 * 点云着色方式（仿 CloudCompare Colors）。
 * `normal` = 法向量 RGB（`(N+1)/2` 静态烘焙，见 utils/normalEstimate.ts）——**视无关**，
 * 与 CC 那套「背面发黑」的绘制期光照是刻意差异（见 native/normal-estimate/README-REF.md）。
 * `label` = **分割色**（单木分割 / 欧式聚类产物的逐株逐簇区分色）：它不是一套逐点颜色
 * 数组，而是"整个实体一个纯色"存在**材质**上（见 pointcloudStore.setEntityLabelColor），
 * 因此切回 rgb 仍能看到原始真彩色——RGB 字段全程没被动过（这是刻意的：分色不该毁原色）。
 */
export type ColorMode = 'none' | 'rgb' | 'scalar' | 'normal' | 'elevation' | 'label'

/** 实体当前显示目标（本应用目前只有一个 3D 视图，纯 UI 状态）。 */
export type EntityDisplayTarget = 'None' | '3D View 1'

/**
 * 实体 LOD 开关三态（见 SceneEntity.lodEnabled）。
 * `auto` 按规模判据；`always` / `never` 是人工强制，后者用于排查渲染问题。
 */
export type LodMode = 'auto' | 'always' | 'never'

/**
 * 树木基础信息（「Tree object」区数据，见 PropertiesPanel）——**存储形态**。
 *
 * 形状 = `utils/treeMetrics.ts#TreeMetrics`（计算的输出形态），只有一处放宽：`basePoint`
 * 允许为 null——那是**手工填写**的情形（在一棵没跑过计算的树上直接改数字时，我们**不编**一个
 * 基准点出来，宁可让面板显示 `—`）。因此 `basePoint !== null` 就是"这份数据带计算依据"的判据，
 * 面板据此决定显示"计算依据"几行还是一行 `manual`。
 *
 * ⚠ `treeObject` 与"分类是不是 4/5"无关：**是不是树看分类值**（`isTreeClassification`），
 * 有没有基础信息看这里是不是 null。两者组合出四种状态，各自都有确定的显示（见面板）。
 */
export type TreeObject = Omit<TreeMetrics, 'basePoint'> & { basePoint: TreePoint | null }

/**
 * 手工填写的 Tree object（用户在面板上直接改数字）：**没有计算依据**——
 * 基准点 / 代表点 / 冠层圈落点为 null、quality 记 `'none'`、`dbhHeight` 记 0（"不是在某个高度量出来的"）。
 * 手工只有一个冠幅值 ⇒ X/Y 都记它（面板的冠幅行显示 max(X, Y)，仍是这个数）。
 *
 * 计算产物不走这里（那是 `utils/treeMetrics.ts#finishTree` 的返回值）；本函数只服务"手填"。
 */
export function createManualTreeObject(
  init: Partial<Pick<TreeObject, 'height' | 'dbh' | 'crownWidth'>> = {}
): TreeObject {
  const crownWidth = init.crownWidth ?? 0
  return {
    height: init.height ?? 0,
    dbh: init.dbh ?? 0,
    crownWidth,
    crownWidthX: crownWidth,
    crownWidthY: crownWidth,
    crownBaseHeight: 0,
    dbhHeight: 0,
    basePoint: null,
    representative: null,
    crownCenter: null,
    quality: { dbhMethod: 'none', dbhSlicePoints: 0, dbhInliers: 0, dbhRms: 0, crownPoints: 0 },
  }
}

/** 点云实体（二级节点）。 */
export interface SceneEntity {
  id: number
  /** 完整文件名，如 3H1-RGB-2025.11.17.las */
  name: string
  /** 完整文件路径。 */
  path: string
  type: 'pointcloud'
  /** 是否在 3D 视图中显示（勾选框状态，默认勾选）。 */
  visible: boolean
  /** 点数（加载完成后由 pointcloudStore 回填）。 */
  pointCount: number
  /** 是否带 RGB 颜色（LAS 按点格式判断；PLY 固定带）。 */
  hasColor: boolean
  /**
   * 是否已有法向量（2 字节量化码，见 utils/normalEstimate.ts）。构成事件（估计完成）
   * 与销毁事件（清除法向量、合并）由 pointcloudStore 回填；`Normal RGB` 着色选项、
   * Invert / Delete 菜单项的可用性都看它。
   */
  hasNormals: boolean
  /**
   * 是否带**分割色**（单木分割 / 欧式聚类产物的逐株逐簇纯色，见 ColorMode 的 `label`）。
   * 构成事件由 pointcloudStore 回填：分割 / 按分类拆分随源继承（源有则产物有），合并看
   * **有没有拿到新编号**（任一来源带编号就会拿到 ⇒ 产物是新物体、有新色，不再是"各来源
   * 颜色互不相同所以没有纯色"）；`.noise` / `.remaining` / 普通点云一律 false。
   * `Label` 着色选项的可用性看它。
   */
  hasLabelColor: boolean
  /**
   * **物体编号**（"树 ID"）：`null` = 该实体不是一个"物体"（普通点云、滤波产物、
   * `.noise` / `.remaining` 这类残片）。三处消费它，且三处都**只认编号**：
   * 1. **名字**：单木分割 / 欧式聚类产物名为 `Tree <labelNo>` / `Cluster <labelNo>`
   *    （不再按保留序下标命名——那在 minPoints 滤掉某棵时与颜色对不上）；
   * 2. **颜色**：分割色由编号派生（`labelColor(labelNo)`，见 pointcloudStore.setEntityLabelColor）；
   * 3. **落盘**：另存为时按它写每点 `treeid`（LAS Point Source ID / PLY treeid）。
   *
   * **作用域内唯一**：编号在"容器（树项/聚类容器）"或"项目顶层"内唯一，分配一律走
   * `nextLabelNo`（= 作用域内现存最大编号 + 1）。分割 / 合并 / 按分类拆分都产出新编号
   * （一分为二 = 两个新编号 + 父色同族派生色，合并 = 一个新编号 + 新色），于是"每种操作
   * 都保证物体有唯一编号、着色只由编号与父色决定"。
   * ⚠ 唯一性是**对现存物体**而言：删掉最大号那个物体后，下一个新物体仍拿"现存最大 + 1"
   * ——也就是复用刚空出来的号（没有隐藏的高水位表，见 `nextLabelNo`）。这不构成歧义：
   * 一个号只属于一个**活着**的物体（拿该号的旧物体已经不在场景里了），而号的**色**
   * 本身只是"编号 + 父色"的函数（算法产物 = `labelColor(号)`；同族派生档的色相随父色，
   * 故复用的号可能落回一个不同的色相——不影响"哪个号是哪个物体"）。
   *
   * ⚠ 与 `id` 的分工：`id` 是**技术身份**（全局单调、永不复用，属性面板显示 Object ID），
   * 编号是**可显示、可继承、可导出**的物体号（小整数，能落进 u16 treeid）。两者都不会
   * 出现"两个活着的物体同一号"，但只有编号会随分割 / 合并演化。
   *
   * ⚠ 与 per-point `treeid` **属性**的分工：属性是"文件里读来的、跟着顶点缓冲走的数据"，
   * 本字段是"实体自己的编号"，导出时**覆盖**属性（见 pointcloudStore.getSaveBatch 的
   * treeIdOverride），故本仓库产出的文件里 treeid 恒等于导出实体的编号。
   */
  labelNo: number | null
  /** 包围盒（文件原始坐标）；未加载完成前为 null。 */
  bbox: EntityBBox | null
  /** 加载时应用的全局平移（basePoint 按值快照）；显示坐标 = 原始坐标 − globalShift。 */
  globalShift: { x: number; y: number; z: number } | null
  /** 全局缩放（当前恒为 1）。 */
  globalScale: number
  /** 着色方式（默认 RGB）。 */
  colorMode: ColorMode
  /**
   * 高程着色的色带范围（**显示坐标** z，见 utils/elevation.ts 的 elevationAxis；
   * `null` = 满量程 = 按实体自身的最高最低高程着色，即默认态）。
   *
   * 刻意是"实体显示参数"而非 pointcloudStore 里渲染态的一部分：它要跟着实体走，
   * 分割 / 合并产物继承（见 splitEntity / mergeEntities），与 colorMode / pointSize 同级。
   * 规整（倒置 / 越界 / 退化）一律走 normalizeElevationRange，图表与着色同源。
   */
  elevationRange: { min: number; max: number } | null
  /** 点大小档位 1-16，单位：屏幕像素（默认 1，渲染见 pointcloudStore.applyPointSize）。 */
  pointSize: number
  /** 是否在 3D 视图中显示名称标签。 */
  showNameIn3D: boolean
  /**
   * LOD（流式显示层）开关三态，对齐 CloudCompare 每片点云的 "Enable LoD" 勾选框：
   * `auto` = 按规模自动判据（默认）；`always` = 强制走显示层；`never` = 强制直绘
   * （排查渲染问题用）。生效点在 pointcloudStore 的 shouldUseLod / applyLodPolicy。
   */
  lodEnabled: LodMode
  /** 当前显示目标（默认 3D View 1）。 */
  displayTarget: EntityDisplayTarget
  /** 树木属性（Tree object）：仅 TreeIso 单木分割产物非 null；属性算法后置，当前为默认值 0。 */
  treeObject: TreeObject | null
  /**
   * 该实体是**被手工放进当前容器的**（拖拽、或分割/合并/按分类拆分等非本容器算法的产物），
   * 而不是容器所属算法自己跑出来的。默认 false。
   *
   * 唯一消费者是 TreeIso 的「原地重建」（选中树项重跑）：它把组内实体当作候选并集重算、
   * 并把它们整体消费掉——手工项若一并参与，用户手工拆出来的片会被**静默销毁**。
   * 故重跑的候选与消费集取 `algorithmMembersOf`（= 本字段为 false 的那些）。
   *
   * 只在 `moveEntity` 里维护，且**跨组边界才翻转**：进组 → true、出组 → false、
   * 组内重排不变（否则"把算法产的 Tree 3 在组内往上拖一格"会把它误标成手工项）。
   */
  manuallyPlaced: boolean
}

/**
 * 树项（TreeIso 分割产物容器，DB Tree 第三级）：一个源点云对应一个树项，
 * 重复分割同一源云 = 原地重建（见 treeIsoStore）。实体本身仍平铺在所属项目的
 * entities（扁平策略——3D 同步/合并/删除等现有消费者只认扁平列表），
 * 本容器仅按创建顺序记实体 id，层级结构由 SceneTree 据此呈现。
 */
export interface SceneTreeGroup {
  id: number
  /** 显示名（默认由 treeIsoStore 按源实体起，如 `xxx.offGround 树项`）。 */
  name: string
  type: 'treegroup'
  /** 是否展开显示其下单树点云。 */
  expanded: boolean
  /** 是否在 3D 视图中显示；控制整个树项（勾选框级联其下点云）。 */
  visible: boolean
  /** 是否在 3D 视图中显示名称标签（当前未渲染容器名，保留字段与项目节点对齐）。 */
  showNameIn3D: boolean
  /** 其下单树点云的实体 id（按分割顺序；与所属项目 entities 保持一一同步）。 */
  entityIds: number[]
}

/** 项目（一级节点）：一次打开操作产生一个项目。 */
export interface SceneProject {
  id: number
  /** 显示名：文件名(所在目录)，如 3H1-RGB-2025.11.17.las(E:/点云文件) */
  name: string
  /** 完整文件路径。 */
  path: string
  type: 'project'
  expanded: boolean
  /** 是否在 3D 视图中显示；控制整个子树。 */
  visible: boolean
  /** 是否在 3D 视图中显示名称标签。 */
  showNameIn3D: boolean
  entities: SceneEntity[]
  /** 树项容器列表（TreeIso 分割产物；无则空数组）。 */
  treeGroups: SceneTreeGroup[]
}

/** 选中节点定位。 */
export type SceneSelection =
  { type: 'project'; id: number } | { type: 'entity'; id: number } | { type: 'treegroup'; id: number }

/**
 * 实体在树中的落点（`moveEntity` 的目标）。
 *
 * 用 `beforeEntityId` **锚点**而非数组下标：源实体从同一列表里被摘掉时不会有一处
 * off-by-one，调用方也不必自己算索引；UI 的「拖到某行上半/下半」天然就是这个参数。
 * 省略锚点 = 追加到该列表末尾。
 */
export type EntityDropTarget =
  | { kind: 'project'; projectId: number; beforeEntityId?: number }
  | { kind: 'group'; groupId: number; beforeEntityId?: number }

/**
 * **编号作用域**（`SceneEntity.labelNo` 的唯一性范围）：容器或项目顶层。
 *
 * 编号刻意**不跨作用域**：每个容器各自从 1 起编号，于是"同一片云跑两次分割、或两片云
 * 各跑一次"得到的 `Tree 1` 都是同一号同一色——这正是"着色保持规律性"想要的（跨容器
 * 同号同色是可预期的，用户能记住"1 号是那个颜色"）。项目顶层的产物（未入容器的树 /
 * 聚类）同样自成一体。
 */
export type LabelScope = { kind: 'group'; groupId: number } | { kind: 'project'; projectId: number }

/** 选中定位相等判断（type + id）。 */
function isSameSelection(a: SceneSelection, b: SceneSelection): boolean {
  return a.type === b.type && a.id === b.id
}

let nextId = 1

/**
 * Shift 连选的锚点 = 最后一次**无 Shift 的点选**（单选 / Ctrl 加选都会移动它，Shift 点击本身
 * 不移动）。刻意与 `state.selection` 的末项（属性面板锚点）分开：连选时选中集按显示序排列，
 * "点击端"不一定是末项，而**下一次 Shift 点击必须从原锚点重新圈定**（见 selectRange）。
 *
 * 不需要响应式（没有任何渲染读它）。节点被删后这里可能留着一个失效引用——id 全局单调、
 * 永不复用，故它**永远不会**指向另一个活着的节点；selectRange 找不到就退化为单选。
 */
let rangeAnchor: SceneSelection | null = null

/**
 * 树木信息修订号（ref 只作失效信号）：`setEntityTreeObject` **成功写入**时自增。
 *
 * 与 `pointcloudStore` 的 classificationRevision / elevationRevision 同一套惯用法——
 * 3D 树木标记（three/treeInfoMarkers）是普通 watch 驱动的，而"某棵树的树信息被改了"
 * 在别的响应式字段上**看不出来**：改一个坐标后 `treeObject` 仍是那个非 null 对象，
 * 签名里的 `T` / `0` 不变。不读这个 ref 就永远不会重画，而且**无报错**
 * （同 pointcloudStore 那条"高程范围必须进签名"的教训）。
 */
const treeObjectRevision = ref(0)

const state = reactive({
  projects: [] as SceneProject[],
  /**
   * 选中节点集合（保持点选顺序：末项 = 最近点选）。
   * 单选语义由锚点（末项）继承给旧消费者——属性面板、工具栏按钮禁用、各算法 startXxx 等
   * 只看锚点；merge 等多选消费者读整个集合（Shift 连选时首项 = 最先点的那一片，
   * 见 selectRange）。
   */
  selection: [] as SceneSelection[],
  /** 全局显示目标（目前只有一个 3D 视图，先全局；多视图时再细分）。 */
  displayTarget: '3D View 1' as 'None' | '3D View 1',
})

/** 手写路径解析：渲染进程禁用 Node 模块，没有 path 包。兼容 \ 与 /。 */
function splitPath(filePath: string): { dirname: string; basename: string } {
  const sepIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (sepIndex === -1) {
    return { dirname: '', basename: filePath }
  }
  return {
    dirname: filePath.slice(0, sepIndex),
    basename: filePath.slice(sepIndex + 1),
  }
}

export function useSceneStore() {
  /** 打开一个文件：生成项目节点（一级）+ 点云实体节点（二级）。允许重复打开。返回新建的实体。 */
  function addProjectFromPath(filePath: string): SceneEntity {
    const { dirname, basename } = splitPath(filePath)
    const entity: SceneEntity = {
      id: nextId++,
      name: basename,
      path: filePath,
      type: 'pointcloud',
      visible: true,
      pointCount: 0,
      hasColor: false,
      hasNormals: false,
      hasLabelColor: false,
      labelNo: null,
      bbox: null,
      globalShift: null,
      globalScale: 1,
      colorMode: 'rgb',
      elevationRange: null,
      pointSize: 1,
      showNameIn3D: false,
      lodEnabled: 'auto',
      displayTarget: '3D View 1',
      treeObject: null,
      manuallyPlaced: false,
    }
    state.projects.push({
      id: nextId++,
      name: `${basename}(${dirname})`,
      path: filePath,
      type: 'project',
      expanded: true,
      visible: true,
      showNameIn3D: false,
      entities: [entity],
      treeGroups: [],
    })
    return entity
  }

  /** 全部实体（跨项目拍平）。 */
  function getAllEntities(): SceneEntity[] {
    return state.projects.flatMap((p) => p.entities)
  }

  /**
   * 加载完成后回填点云元数据（pointcloudStore 调用）。
   *
   * `hasNormals` / `hasLabelColor` 是**必填**：分割 / 合并等路径必须显式声明产物有没有
   * 这些数据（合并**刻意丢法向量**——各来源法向量互相矛盾；分割色则由产物有没有拿到编号
   * 决定，见 pointcloudStore.mergeEntities），留可选位会让忘了传的调用点静默沿用陈旧值。
   */
  function updateEntityMeta(
    id: number,
    meta: {
      pointCount: number
      hasColor: boolean
      hasNormals: boolean
      hasLabelColor: boolean
      bbox: EntityBBox
      globalShift: { x: number; y: number; z: number }
    }
  ) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (!entity) return
    entity.pointCount = meta.pointCount
    entity.hasColor = meta.hasColor
    entity.hasNormals = meta.hasNormals
    entity.hasLabelColor = meta.hasLabelColor
    entity.bbox = meta.bbox
    entity.globalShift = meta.globalShift
    // 数据能力变了就把用户的着色意图压回可用值（降级链 label → rgb → none：无分割色退回
    // RGB 而不是 None——.noise / 合并产物仍该看真彩色）。规则只有一份，见 utils/colorMode.ts；
    // scalar / elevation 不在降级之列（不依赖这三种数据：LAS 0-10 格式没有颜色却可以有
    // 法向量，一刀切压 none 会把用户的 Normal RGB / 分类色选择清掉）。
    entity.colorMode = resolveColorMode(entity.colorMode, meta)
  }

  /** 切换实体着色方式（None / RGB / Scalar field / Normal RGB / Elevation / Label）。 */
  function setEntityColorMode(id: number, mode: ColorMode) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.colorMode = mode
    }
  }

  /**
   * 设置高程色带范围（`null` = 满量程）。
   *
   * **写新对象、不原地改**：拖拽时每帧写一次，新对象让"值变了"这件事对 watch 毫无歧义
   * （pointcloudStore 的同步 watch 按字符串签名比对，本字段也在签名里——见那里的注释）。
   * 范围不必在此规整：着色与图表两侧都走 normalizeElevationRange，读数与画面恒一致。
   */
  function setEntityElevationRange(id: number, range: { min: number; max: number } | null) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.elevationRange = range ? { min: range.min, max: range.max } : null
    }
  }

  /** 设置实体点大小档位（钳制 1-16）。 */
  function setEntityPointSize(id: number, size: number) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.pointSize = Math.min(16, Math.max(1, Math.round(size)))
    }
  }

  /**
   * 设置实体 LOD 开关（auto / always / never）。
   * pointcloudStore 的 watch 会据此重建或拆掉显示层（见 applyLodPolicy）。
   */
  function setEntityLodEnabled(id: number, mode: LodMode) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.lodEnabled = mode
    }
  }

  /** 重命名项目节点（仅改显示名，不动 path，不影响磁盘文件）。 */
  function renameProject(id: number, name: string) {
    const project = state.projects.find((p) => p.id === id)
    if (project) {
      project.name = name
    }
  }

  /** 重命名实体节点（仅改显示名，不动 path，不影响磁盘文件）。 */
  function renameEntity(id: number, name: string) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.name = name
    }
  }

  /**
   * 设置实体"在 3D 中显示名称标签"（**显式值**而非切换）。
   *
   * 属性面板的 Show name 行是多选批量入口（同 Colors 行）：选中项一半开一半关时（checkbox
   * 呈半选态）点一下要**统一设成勾选态**，切换语义做不到这件事；单选实体只是"目标恰好 1 个"。
   */
  function setEntityShowName(id: number, show: boolean) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.showNameIn3D = show
    }
  }

  /** 设置实体当前显示目标。 */
  function setEntityDisplayTarget(id: number, target: EntityDisplayTarget) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) {
      entity.displayTarget = target
    }
  }

  /** 展开/折叠项目节点。 */
  function toggleProject(id: number) {
    const project = state.projects.find((p) => p.id === id)
    if (project) {
      project.expanded = !project.expanded
    }
  }

  /** 切换项目显隐，并同步整个子树（点云实体 + 树项容器旗标；树项下点云平铺在 entities 中一并级联）。 */
  function toggleProjectVisible(id: number) {
    const project = state.projects.find((p) => p.id === id)
    if (!project) return
    project.visible = !project.visible
    project.entities.forEach((entity) => {
      entity.visible = project.visible
    })
    project.treeGroups.forEach((group) => {
      group.visible = project.visible
    })
  }

  /** 切换单个实体显隐（不回写项目状态）。 */
  function toggleEntityVisible(id: number) {
    const entity = state.projects.flatMap((p) => p.entities).find((e) => e.id === id)
    if (entity) {
      entity.visible = !entity.visible
    }
  }

  /** 切换项目"在 3D 中显示名称标签"。 */
  function toggleProjectShowName(id: number) {
    const project = state.projects.find((p) => p.id === id)
    if (project) {
      project.showNameIn3D = !project.showNameIn3D
    }
  }

  /**
   * 从所属项目中移除实体（分割替换 / 合并等场景用）。
   * 若它在选中集合中则同步剔除（锚点回退到剩余末项；集合空则 selected 为 null）；
   * 若它属于某树项容器则同步从其 entityIds 剔除（容器可能因此变空，保留容器，CC 行为）；
   * 项目节点保留（可能为空，CC 行为）。
   */
  function removeEntityFromProject(entityId: number) {
    for (const project of state.projects) {
      const idx = project.entities.findIndex((e) => e.id === entityId)
      if (idx === -1) continue
      project.entities.splice(idx, 1)
      for (const group of project.treeGroups) {
        const gi = group.entityIds.indexOf(entityId)
        if (gi !== -1) group.entityIds.splice(gi, 1)
      }
      const selIdx = state.selection.findIndex((s) => s.type === 'entity' && s.id === entityId)
      if (selIdx !== -1) {
        state.selection.splice(selIdx, 1)
      }
      return
    }
  }

  /**
   * 删除整个项目（连同其下所有实体与树项容器；右键菜单 Delete 项目用）。
   * 选中集合中该项目节点及其全部实体/树项一律剔除；其他项目与选中不受影响。
   */
  function removeProject(projectId: number) {
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) return
    const entityIds = new Set(project.entities.map((e) => e.id))
    const treeGroupIds = new Set(project.treeGroups.map((g) => g.id))
    const idx = state.projects.indexOf(project)
    state.projects.splice(idx, 1)
    state.selection = state.selection.filter(
      (s) =>
        !(
          s.id === projectId ||
          (s.type === 'entity' && entityIds.has(s.id)) ||
          (s.type === 'treegroup' && treeGroupIds.has(s.id))
        )
    )
  }

  /**
   * 实体工厂：默认字段 + partial 覆盖（addEntityToProject / addEntityToGroup 共用）。
   * 元数据（pointCount/bbox/globalShift 等）由调用方随后 updateEntityMeta 回填。
   */
  function buildEntity(partial: Partial<SceneEntity> & { name: string; path: string }): SceneEntity {
    return {
      id: nextId++,
      name: partial.name,
      path: partial.path,
      type: 'pointcloud',
      visible: partial.visible ?? true,
      pointCount: partial.pointCount ?? 0,
      hasColor: partial.hasColor ?? false,
      hasNormals: partial.hasNormals ?? false,
      hasLabelColor: partial.hasLabelColor ?? false,
      labelNo: partial.labelNo ?? null,
      bbox: partial.bbox ?? null,
      globalShift: partial.globalShift ?? null,
      globalScale: partial.globalScale ?? 1,
      colorMode: partial.colorMode ?? 'rgb',
      elevationRange: partial.elevationRange ?? null,
      pointSize: partial.pointSize ?? 1,
      showNameIn3D: partial.showNameIn3D ?? false,
      lodEnabled: partial.lodEnabled ?? 'auto',
      displayTarget: partial.displayTarget ?? '3D View 1',
      treeObject: partial.treeObject ?? null,
      manuallyPlaced: partial.manuallyPlaced ?? false,
    }
  }

  /**
   * 向指定项目追加实体（自动分配 id；分割出的新实体等场景用，产物直挂项目）。
   */
  function addEntityToProject(
    projectId: number,
    partial: Partial<SceneEntity> & { name: string; path: string }
  ): SceneEntity {
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    const entity = buildEntity(partial)
    project.entities.push(entity)
    return entity
  }

  /**
   * 向树项容器追加实体（TreeIso 分割产物用）：实体平铺进所属项目的 entities
   * （既有消费者只认扁平列表），entityIds 同步记入容器。容器/项目不存在返回 null。
   */
  function addEntityToGroup(
    groupId: number,
    partial: Partial<SceneEntity> & { name: string; path: string }
  ): SceneEntity | null {
    for (const project of state.projects) {
      const group = project.treeGroups.find((g) => g.id === groupId)
      if (!group) continue
      const entity = buildEntity(partial)
      project.entities.push(entity)
      group.entityIds.push(entity.id)
      return entity
    }
    return null
  }

  /**
   * 在项目下新建空树项容器（名称由调用方按源实体起，如 `xxx.offGround 树项`）。
   * 项目不存在返回 null。
   */
  function createTreeItemGroup(projectId: number, name: string): SceneTreeGroup | null {
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) return null
    const group: SceneTreeGroup = {
      id: nextId++,
      name,
      type: 'treegroup',
      expanded: true,
      visible: true,
      showNameIn3D: false,
      entityIds: [],
    }
    project.treeGroups.push(group)
    return group
  }

  /**
   * 删除树项容器（右键 Delete 树项用；其下实体需调用方先逐子删除——pointcloudStore
   * deleteTreeGroup 里先 disposeCloudRecord 再走 removeEntityFromProject，entityIds
   * 随各次删除被清空）。选中集合中的容器节点同步剔除。
   */
  function removeTreeGroup(groupId: number) {
    for (const project of state.projects) {
      const idx = project.treeGroups.findIndex((g) => g.id === groupId)
      if (idx === -1) continue
      project.treeGroups.splice(idx, 1)
      state.selection = state.selection.filter((s) => !(s.type === 'treegroup' && s.id === groupId))
      return
    }
  }

  /** 实体所属树项容器（不在任何树项内返回 null）。 */
  function groupOfEntity(entityId: number): SceneTreeGroup | null {
    for (const project of state.projects) {
      const group = project.treeGroups.find((g) => g.entityIds.includes(entityId))
      if (group) return group
    }
    return null
  }

  /** 按 id 找树项容器（跨项目）。 */
  function treeGroupById(groupId: number): SceneTreeGroup | null {
    for (const project of state.projects) {
      const group = project.treeGroups.find((g) => g.id === groupId)
      if (group) return group
    }
    return null
  }

  /**
   * 实体当前所属容器：树项或项目（后处理产物随父容器的依据——对树项内的树做
   * 滤波/拆分/合并时，新产物应留在同一树项内，见 pointcloudStore 各 split/merge）。
   * 实体不存在返回 null。
   */
  function parentContainerOf(
    entityId: number
  ): { kind: 'group'; groupId: number; projectId: number } | { kind: 'project'; projectId: number } | null {
    const group = groupOfEntity(entityId)
    if (group) {
      const project = state.projects.find((p) => p.treeGroups.includes(group))
      return project ? { kind: 'group', groupId: group.id, projectId: project.id } : null
    }
    for (const project of state.projects) {
      if (project.entities.some((e) => e.id === entityId)) {
        return { kind: 'project', projectId: project.id }
      }
    }
    return null
  }

  /** 项目顶层实体 id（= 扁平 entities 里不属于任何容器的那些，按显示序）。 */
  function directEntityIdsOf(project: SceneProject): number[] {
    const memberIds = new Set<number>()
    for (const group of project.treeGroups) {
      for (const id of group.entityIds) memberIds.add(id)
    }
    return project.entities.filter((e) => !memberIds.has(e.id)).map((e) => e.id)
  }

  /**
   * 实体当前所属的编号作用域（容器内 → 该容器；否则 → 所在项目的顶层）。
   * 实体不存在、或树结构异常（无父）时返回 null。
   *
   * 分割 / 合并的产物落在源实体原处（`dropTargetBeside`），作用域与源实体相同——故
   * 分配编号时直接取源实体的作用域即可，不必再解析落点。
   */
  function labelScopeOf(entityId: number): LabelScope | null {
    const parent = parentContainerOf(entityId)
    if (!parent) return null
    return parent.kind === 'group'
      ? { kind: 'group', groupId: parent.groupId }
      : { kind: 'project', projectId: parent.projectId }
  }

  /** 作用域内的成员 id（容器成员 / 项目顶层实体，按显示序）。作用域不存在 → 空数组。 */
  function memberIdsOf(scope: LabelScope): number[] {
    if (scope.kind === 'group') return treeGroupById(scope.groupId)?.entityIds ?? []
    const project = state.projects.find((p) => p.id === scope.projectId)
    return project ? directEntityIdsOf(project) : []
  }

  /**
   * 作用域内下一个空闲编号 = 现存成员最大编号 + 1（无编号的成员记 0）。
   *
   * 三条语义：
   * - **只认编号**：`labelNo` 为 null 的成员（普通云 / 滤波产物 / `.noise` 残片）既不占号
   *   也不推高上限——"物体"与"数据块"是两回事，编号只属于前者。
   * - **唯一性只对现存物体**：取"最大 + 1"而不是"第一个空缺"，于是新号必然大于现存所有号
   *   （不会撞上任何一个活着的物体）。**但删掉最大号之后，新物体会复用那个号**——不藏
   *   高水位表（省一份要随容器/项目增删维护的状态）。这不构成歧义：一个号只属于一个活着
   *   的物体（见 `labelNo` 那条的 ⚠）。
   * - `excludeIds` = **即将被移除的成员**（树项原地重建的旧算法产物）：它们此刻还在容器里、
   *   但编号分配发生在替换之后，故两侧必须排除同一批人。预览侧的 base 也必须用同一个
   *   排除集算，否则预览一套色、拆完另一套色（见 treeIsoStore 的 labelBase）。
   */
  function nextLabelNo(scope: LabelScope, excludeIds?: readonly number[]): number {
    const excluded = excludeIds && excludeIds.length > 0 ? new Set(excludeIds) : null
    const byId = new Map(getAllEntities().map((e) => [e.id, e]))
    let max = 0
    for (const id of memberIdsOf(scope)) {
      if (excluded?.has(id)) continue
      const no = byId.get(id)?.labelNo ?? null
      if (no !== null && no > max) max = no
    }
    return max + 1
  }

  /**
   * 写实体编号（**只由 pointcloudStore.setEntityLabelColor 调用**）：编号与分割色同生
   * 共死——两者由一个函数一起写，"有色无号"（颜色无法导出、改名无从对应）或"有号无色"
   * （面板说 Label 却画不出来）这类半截状态才不可能出现。
   */
  function setEntityLabelNo(id: number, labelNo: number | null) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (entity) entity.labelNo = labelNo
  }

  /**
   * 写实体的树木基础信息（**唯一写入口**：批量计算、面板手填、清空三处都走它）。
   *
   * 之所以要有这个函数而不是各处直接 `entity.treeObject = ...`：
   * - 计算产物必须整份替换（`TreeObject` 是一次算完的整体，逐字段改会留下"树高是新的、
   *   质量字段是上一版的"这种半截状态）；
   * - 实体可能已被删除（批量算的过程中用户在别处删了它）⇒ 静默跳过，不抛错
   *   （同 `setEntityLabelNo`）；
   * - 将来若要给"有没有树木信息"加派生标志（如面板的高亮/图标），只有这一处要改。
   *
   * `null` = 清空（回到"没有树木信息"），**不是**"算出来是 0"——面板对两者的显示不同（`—` vs 0.00）。
   */
  function setEntityTreeObject(id: number, value: TreeObject | null) {
    const entity = getAllEntities().find((e) => e.id === id)
    if (!entity) return
    entity.treeObject = value
    // 3D 标记的失效信号（没写成任何东西 ⇒ 不动它，否则会白重画一帧）
    treeObjectRevision.value++
  }

  /**
   * 分割 / 合并产物的落点：**随源实体当前所属容器**，锚点固定为源实体自身。
   *
   * 用法（pointcloudStore 的 split / merge 统一走这个形状）：产物先追加到项目末尾 →
   * `moveEntity(产物, dropTargetBeside(源))` → 再移除源。产物落在源正前方，源被移除后
   * 恰好占住它原来的格子；多个产物按顺序各调一次即得 `[A, seg, rem, C]`。
   *
   * **这就是本 store 里 `parentContainerOf` 当初写下却一直没人调的用途**——四个写树节点的
   * 地方各写一遍落点逻辑，正是「工具 A 的产物留在容器里、工具 B 的掉到 2 级」的成因。
   *
   * 实体不存在返回 null。
   */
  function dropTargetBeside(entityId: number): EntityDropTarget | null {
    const parent = parentContainerOf(entityId)
    if (!parent) return null
    return parent.kind === 'group'
      ? { kind: 'group', groupId: parent.groupId, beforeEntityId: entityId }
      : { kind: 'project', projectId: parent.projectId, beforeEntityId: entityId }
  }

  /**
   * 把实体挪到目标落点（拖拽 / 分割产物就位共用的**唯一**树结构变更原语）。
   *
   * 三条纪律：
   * - **仅同项目**：目标必须与实体同属一个项目，跨项目一律拒绝（实体的 path 指向原文件，
   *   挂到另一个项目节点下会自相矛盾）。返回 false 表示"这次移动不合法"，调用方无动作。
   * - **锚点必须在目标列表里**（`kind:'project'` ⇒ 该项目的**直接**实体；`kind:'group'` ⇒
   *   该容器成员），否则拒绝——锚点与目标列表错配会写出谁也渲染不出的悬空位置。
   * - **`manuallyPlaced` 只跨组边界才翻转**（进组 → true、出组 → false、组内重排不变）。
   *
   * 不需要 `syncAllToThree`：树嵌套不参与 three 场景（pointcloudStore 的同步 watch 只认
   * 扁平列表的 id/name/visible/... 签名）。进组时若对齐了显隐，`visible` 本就在签名里。
   */
  function moveEntity(entityId: number, target: EntityDropTarget): boolean {
    const entity = getAllEntities().find((e) => e.id === entityId)
    if (!entity) return false
    const project = state.projects.find((p) => p.entities.some((e) => e.id === entityId))
    if (!project) return false

    // 分支按 `target.kind` 展开（而非先算 toGroup 再判断）：TS 的收窄是跟着 kind 走的，
    // 绕一层就会在 `target.projectId` / `target.groupId` 上报"属性不存在"
    let toGroup: SceneTreeGroup | null = null
    let targetProjectId: number | undefined
    if (target.kind === 'group') {
      const group = treeGroupById(target.groupId)
      if (!group) return false
      toGroup = group
      targetProjectId = state.projects.find((p) => p.treeGroups.includes(group))?.id
    } else {
      targetProjectId = target.projectId
    }
    if (targetProjectId === undefined || targetProjectId !== project.id) return false

    if (target.beforeEntityId !== undefined) {
      if (target.beforeEntityId === entityId) return true // 拖回原位：无操作（不算失败）
      const anchored = toGroup
        ? toGroup.entityIds.includes(target.beforeEntityId)
        : directEntityIdsOf(project).includes(target.beforeEntityId)
      if (!anchored) return false
    }

    const fromGroup = groupOfEntity(entityId)
    if (fromGroup) {
      const gi = fromGroup.entityIds.indexOf(entityId)
      if (gi !== -1) fromGroup.entityIds.splice(gi, 1)
    }

    if (toGroup) {
      const at =
        target.beforeEntityId === undefined
          ? toGroup.entityIds.length
          : Math.max(0, toGroup.entityIds.indexOf(target.beforeEntityId))
      toGroup.entityIds.splice(at, 0, entityId)
      // 显隐对齐容器：toggleTreeGroupVisible 是级联语义，拖进隐藏的容器却不跟着隐藏，
      // 容器那个勾选框就会撒谎（勾着、其下却有可见的点）
      entity.visible = toGroup.visible
    } else {
      // 项目顶层：project.entities 是**扁平存储**，直接实体的显示序 = 该数组里过滤掉
      // 容器成员后的顺序，故"插到直接实体 X 之前" = 在扁平数组里挪到 X 的位置之前
      const from = project.entities.findIndex((e) => e.id === entityId)
      const anchorIndex =
        target.beforeEntityId === undefined
          ? project.entities.length
          : project.entities.findIndex((e) => e.id === target.beforeEntityId)
      if (from === -1 || anchorIndex === -1) return false
      const [moved] = project.entities.splice(from, 1)
      project.entities.splice(from < anchorIndex ? anchorIndex - 1 : anchorIndex, 0, moved)
    }

    const inGroup = toGroup !== null
    if (inGroup !== (fromGroup !== null)) entity.manuallyPlaced = inGroup
    return true
  }

  /**
   * 容器里**算法自己产出的**成员 id（按容器内顺序）。
   *
   * TreeIso 的「原地重建」用它在候选并集与消费集里排除手工项——手工项混进去会被
   * 静默销毁（splitEntityMany 的 removeEntityIds 会把它们连根拔掉）。语义见
   * `SceneEntity.manuallyPlaced`。
   */
  function algorithmMembersOf(groupId: number): number[] {
    const group = treeGroupById(groupId)
    if (!group) return []
    return group.entityIds.filter((id) => {
      const entity = getAllEntities().find((e) => e.id === id)
      return entity ? !entity.manuallyPlaced : false
    })
  }

  /** 展开/折叠树项容器。 */
  function toggleTreeGroup(id: number) {
    const group = treeGroupById(id)
    if (group) {
      group.expanded = !group.expanded
    }
  }

  /** 切换树项显隐，并级联其下点云（语义同项目级联；只改写容器旗标与组内实体）。 */
  function toggleTreeGroupVisible(id: number) {
    const group = treeGroupById(id)
    if (!group) return
    group.visible = !group.visible
    for (const project of state.projects) {
      if (!project.treeGroups.includes(group)) continue
      for (const entity of project.entities) {
        if (group.entityIds.includes(entity.id)) {
          entity.visible = group.visible
        }
      }
    }
  }

  /** 重命名树项容器（仅改显示名）。 */
  function renameTreeGroup(id: number, name: string) {
    const group = treeGroupById(id)
    if (group) {
      group.name = name
    }
  }

  /** 单选：整体替换选中集合（无修饰键点击、流程完成后自动选中产物等场景用）；传 null 清空。 */
  function selectNode(sel: SceneSelection | null) {
    state.selection = sel ? [sel] : []
    rangeAnchor = sel
  }

  /**
   * 多选切换（Ctrl/⌘ + 点击）：已在集合中则移除（锚点回退到剩余末项），
   * 否则追加到末尾并成为新锚点。集合被清空后 selected 为 null。
   * 连选锚点一律跟着走（加选与取消都是"刚点过这里"）。
   */
  function toggleSelectNode(sel: SceneSelection) {
    const idx = state.selection.findIndex((s) => isSameSelection(s, sel))
    if (idx !== -1) {
      state.selection.splice(idx, 1)
    } else {
      state.selection.push(sel)
    }
    rangeAnchor = sel
  }

  /**
   * 树中**当前可见行**的扁平顺序（= SceneTree.vue 实际渲染出来的那些行，含项目行与容器行）。
   *
   * 折叠起来的行不在屏幕上，自然也不能被 Shift 连选圈进去（"选中的就是看得见的那些"）：
   * 项目折叠 ⇒ 其下直接实体与容器都不算可见，容器折叠 ⇒ 其下成员不算可见。
   *
   * ⚠ 行序必须与 `SceneTree.vue` 的模板一致：**项目 → 其直接实体 → 容器 → 容器的成员**
   * （容器排在直接实体之后，见模板里"三级"那段的 v-for 顺序）。两处任何一处改了顺序，
   * 连选圈出来的段就会与高亮的行对不上。
   */
  function flattenVisibleRows(): SceneSelection[] {
    const rows: SceneSelection[] = []
    for (const project of state.projects) {
      rows.push({ type: 'project', id: project.id })
      if (!project.expanded) continue
      for (const id of directEntityIdsOf(project)) {
        rows.push({ type: 'entity', id })
      }
      for (const group of project.treeGroups) {
        rows.push({ type: 'treegroup', id: group.id })
        if (!group.expanded) continue
        for (const id of group.entityIds) {
          // 防御悬空 id（与 SceneTree.groupEntities 同一口径：渲染不出来的行不进连选范围）
          if (project.entities.some((e) => e.id === id)) rows.push({ type: 'entity', id })
        }
      }
    }
    return rows
  }

  /**
   * Shift + 点击：把**锚点**到目标之间的可见行整段设为选中集（含两端）。
   *
   * 锚点取 `rangeAnchor`（最后一次无 Shift 的点选），**Shift 点击本身不移动它**——于是再
   * Shift 点一处是从原锚点重新圈定（资源管理器语义）：想把选区末端往回改，只要 Shift 点
   * 近一点，不必先取消再从头点一遍。
   *
   * **选中集的排列 = 首项锚点、末项刚点的那一行**（向上连选时即显示序的倒序）：这条让
   * "末项 = 最近点选" 这个既有约定对连选同样成立——属性面板与各算法看的是锚点
   * `selectedNode`（= 末项），于是它们看到的恒是**刚点的那一行**（与 Ctrl 加选一致）；
   * merge 的主导方 `sources[0]`（= 首项）则恒是**最先点的那一片**。
   *
   * 锚点或目标不在可见行里（项目/容器被折叠、节点已被删）⇒ 退化为单选目标（并重置锚点）。
   * 段内可以混着项目行 / 容器行——"选中的就是高亮的那些行"，多选消费者各自的判据不变
   * （如合并要求全是实体，混进项目行会给出既有提示）。
   */
  function selectRange(target: SceneSelection) {
    const rows = flattenVisibleRows()
    const anchor = rangeAnchor
    const from = anchor ? rows.findIndex((row) => isSameSelection(row, anchor)) : -1
    const to = rows.findIndex((row) => isSameSelection(row, target))
    if (from === -1 || to === -1) {
      selectNode(target)
      return
    }
    const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
    state.selection = from <= to ? range : range.reverse()
  }

  /** 当前选中集合（点击顺序，只读副本）。 */
  const selection = computed(() => state.selection.slice())

  /** 当前选中锚点（集合末项 = 最近点选）；null 表示未选中。 */
  const selected = computed(() => (state.selection.length > 0 ? state.selection[state.selection.length - 1] : null))

  /** 当前锚点对应的节点对象（项目 / 点云实体 / 树项容器）。 */
  const selectedNode = computed<SceneProject | SceneEntity | SceneTreeGroup | null>(() => {
    const sel = selected.value
    if (!sel) return null
    if (sel.type === 'project') {
      return state.projects.find((p) => p.id === sel.id) ?? null
    }
    if (sel.type === 'treegroup') {
      return treeGroupById(sel.id)
    }
    return state.projects.flatMap((p) => p.entities).find((e) => e.id === sel.id) ?? null
  })

  /** 全局显示目标（v-model 双向绑定）。 */
  const displayTarget = computed<'None' | '3D View 1'>({
    get: () => state.displayTarget,
    set: (value) => {
      state.displayTarget = value
    },
  })

  return {
    projects: state.projects,
    selection,
    selected,
    selectedNode,
    displayTarget,
    /** 树木信息修订号（只作失效信号，见模块级注释）。 */
    treeObjectRevision,
    addProjectFromPath,
    getAllEntities,
    updateEntityMeta,
    setEntityColorMode,
    setEntityLabelNo,
    setEntityTreeObject,
    setEntityElevationRange,
    setEntityPointSize,
    setEntityLodEnabled,
    renameProject,
    renameEntity,
    setEntityShowName,
    setEntityDisplayTarget,
    toggleProject,
    toggleProjectVisible,
    toggleEntityVisible,
    toggleProjectShowName,
    selectNode,
    toggleSelectNode,
    selectRange,
    flattenVisibleRows,
    removeEntityFromProject,
    removeProject,
    addEntityToProject,
    addEntityToGroup,
    createTreeItemGroup,
    removeTreeGroup,
    toggleTreeGroup,
    toggleTreeGroupVisible,
    renameTreeGroup,
    groupOfEntity,
    treeGroupById,
    parentContainerOf,
    dropTargetBeside,
    moveEntity,
    algorithmMembersOf,
    labelScopeOf,
    nextLabelNo,
  }
}
