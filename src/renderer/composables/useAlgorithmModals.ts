import { computed, type ComputedRef } from 'vue'
import { useSceneStore } from '../stores/sceneStore'
import { useSegmentStore } from '../stores/segmentStore'
import { useMeasureStore } from '../stores/measureStore'
import { useStatisticalFilterStore } from '../stores/statisticalFilterStore'
import { useFilterStore } from '../stores/filterStore'
import { useVoxelFilterStore } from '../stores/voxelFilterStore'
import { useCsfStore } from '../stores/csfStore'
import { useCsfProStore } from '../stores/csfProStore'
import { useTreeIsoStore } from '../stores/treeIsoStore'
import { useRansacPlaneStore } from '../stores/ransacPlaneStore'
import { useRansacCylinderStore } from '../stores/ransacCylinderStore'
import { useEuclideanClusterStore } from '../stores/euclideanClusterStore'
import { usePowerlineStore } from '../stores/powerlineStore'
import { useAlignStore } from '../stores/alignStore'
import { useIcpStore } from '../stores/icpStore'
import { useGicpStore } from '../stores/gicpStore'
import { resolveRegistrationPair } from '../utils/registration'

/**
 * 十三个算法模态的**统一入口表 + 互斥切换**（右竖工具栏 SideToolBar 与顶部 Tools 菜单共用）。
 *
 * 十三个算法模态都是"模态工具会话"（见各 store 的文件头）：active + 启动时的目标实体快照 +
 * 参数，同一时刻只允许一个激活，故每个入口在进入前都要把其余模态逐个退出。这份清单原先是
 * SideToolBar 与 ToolBar 各抄一份（多一个入口就多一处可能漏掉），现在收敛到这里：
 * **ALGORITHM_MODALS = 顺序 + 分组 + 文案 + 各自的可用性判据，handles = 每个模态的
 * active/start/exit**。新增算法模态改这两处（互斥自动生效），再补 SideToolBar 的图标按钮
 * 与 MainArea 的参数横条；Tools 菜单会自动多出一项。
 *
 * 顺序（也是右竖工具栏与 Tools 菜单的排列）：统计滤波排在半径滤波前——采集密度不均匀的
 * 点云先用统计滤波粗去噪（产物 .sor 自动选中），再对 .sor 做半径滤波精处理，稀疏但有效的
 * 区域不会被误杀；单木分割与欧式聚类排在地面分割后——业务流为 LAS → CSF 去地面 → 选中
 * 点云 → TreeIso（树木，几何/拓扑驱动）或欧式聚类（任意独立物体，只看距离），聚类排在其后
 * 因为它是通用兜底（不知道要找什么形状时用它）；两个 RANSAC 拟合——常作为后续算法的
 * 预处理（剥掉地面/墙面/作业面、管道/杆件），且都自带"剥一层再剥一层"的循环。平面在圆柱
 * 之前：平面是更常见的第一步（找地面、找基准面），且平面拟合不需要用户关心轴方向。
 * **电力线提取排在 Segment 组最后**：它是组里唯一的**专用目标**提取器（前四个都是通用分割，
 * 不知道要找什么形状时用；它只找导线），且它自带地面参考面——不需要用户先跑 CSF，
 * 因此放在"通用工具都列完了"之后，避免被误当成第四个通用分割入口。
 * **配准（Registration）排在最末**：它是"两片云之间"的操作，要等各片云自己都处理干净
 * （去噪、去地面、分割掉无关部分）之后再做；组内点对对齐在 ICP 前——粗配准在精配准前，
 * ICP 的收敛依赖一个不太差的初始位姿。
 *
 * 入口本身的可用性判据：**无选中目标时全部禁用**（`enabled` 未定义时的默认判据），
 * 悬停说明改为讲原因；treeIso 另接受树项容器（欧式聚类只接受点云实体），两个配准入口
 * 要求**恰好 2 个已加载的点云**（`enabled` 自定义判据，与各 store 的 startXxx 同源——
 * 都走 `utils/registration.ts#resolveRegistrationPair`，判据只有一份）。
 */

/** 算法模态的键：互斥清单、入口表与 handles 的标识（三者一一对应）。 */
export type AlgorithmModalKey =
  | 'statisticalFilter'
  | 'radiusFilter'
  | 'voxelFilter'
  | 'csf'
  | 'csfPro'
  | 'treeIso'
  | 'euclideanCluster'
  | 'powerLine'
  | 'ransacPlane'
  | 'ransacCylinder'
  | 'align'
  | 'icp'
  | 'gicp'

/** Tools 菜单的分组名（同组连排，组前一条组标题）。 */
export type AlgorithmModalGroup = 'Filter' | 'Segment' | 'Fit' | 'Registration'

/** 一个算法入口的静态元数据（与算法实现无关，供菜单项与按钮 title 使用）。 */
export interface AlgorithmModalItem {
  key: AlgorithmModalKey
  /** Tools 菜单的项名（与 File / Edit 的 Open / Merge 同风格，英文短语）。 */
  label: string
  /** 菜单分组。 */
  group: AlgorithmModalGroup
  /** 可用时的悬停说明（讲算法用途；侧栏 icon 按钮的 title 也用它）。 */
  title: string
  /** 禁用时的悬停说明（讲禁用原因）；省略则用通用的"请先选中点云"。 */
  disabledTitle?: string
  /**
   * 该入口的可用性判据（在"有选中目标"之外**追加**的条件）；省略 = 有选中目标即可。
   * 只在 `useAlgorithmModals` 里求值（每次访问即建立响应式依赖），故可以是读 store 的闭包。
   */
  enabled?: () => boolean
}

/** 两个配准入口的禁用文案（它们要的选中形态比别的入口严格得多）。 */
const NEED_PAIR = '请先在 DB Tree 中选中恰好 2 个已加载完成的点云（Ctrl+点选第二个）'

/** 无选中目标时的通用禁用文案。 */
const NEED_SELECTION = '请先在 DB Tree 中选中点云'

/** 入口表（顺序 = 右竖工具栏从上到下 = Tools 菜单从上到下）。 */
export const ALGORITHM_MODALS: readonly AlgorithmModalItem[] = [
  {
    key: 'statisticalFilter',
    label: 'Statistical Filter',
    group: 'Filter',
    title: '统计滤波（按邻居距离的统计分布剔除离群点，密度不均的点云建议先用再半径滤波）',
  },
  {
    key: 'radiusFilter',
    label: 'Radius Filter',
    group: 'Filter',
    title: '半径滤波（按半径内邻居数剔除孤立点）',
  },
  {
    key: 'voxelFilter',
    label: 'Voxel Filter',
    group: 'Filter',
    title: '体素滤波（按体素栅格下采样，每个格子保留 1 个代表点，体素越大保留越少）',
  },
  {
    key: 'csf',
    label: 'CSF Ground',
    group: 'Segment',
    title: 'LiDAR 地面分割（CSF 布料模拟，qCSF 机载语义；起伏地形请用精准版）',
  },
  {
    key: 'csfPro',
    label: 'CSF Pro Ground',
    group: 'Segment',
    title: '精准地面分割（csf-pro 布料贴地模拟，丘陵/山脉高精度；较慢，运行弹进度条可取消）',
  },
  {
    key: 'treeIso',
    label: 'Tree Iso',
    group: 'Segment',
    title:
      '单木分割（TreeIso 三阶段图切分）：把选中的树木点云分成一棵棵独立点云，挂到树项容器下（建议先 CSF 去地面再分割）',
    disabledTitle: '请先在 DB Tree 中选中点云或树项容器',
  },
  {
    key: 'euclideanCluster',
    label: 'Euclidean Cluster',
    group: 'Segment',
    title:
      '欧式聚类分割（PCL EuclideanClusterExtraction 语义）：只按点间距离把空间上独立的物体切成一个个点云，挂到聚类容器下（阈值靠试，先「预览」看逐簇异色再分割）',
    disabledTitle: '请先在 DB Tree 中选中点云（聚类不支持项目 / 容器目标）',
  },
  {
    key: 'powerLine',
    label: 'Power Line',
    group: 'Segment',
    title:
      '电力线提取（离地高初筛 + PCA 线性特征 + 竖直平面抛物线模型连线）：把导线从丘陵/城市点云里一条条拆出来，挂到电力线容器下（先「预览」看逐线异色再分割；地面参考面自动建，不需要先跑 CSF）',
    disabledTitle: '请先在 DB Tree 中选中点云（电力线提取只支持单个点云实体）',
  },
  {
    key: 'ransacPlane',
    label: 'RANSAC Plane',
    group: 'Fit',
    title:
      'RANSAC 平面拟合：从带噪声/外点的点云里找出占比最大的平面（地面、墙面、作业面），拆分出 <名称>.plane 与 <名称>.remaining 并选中后者，可连续剥离多个平面',
  },
  {
    key: 'ransacCylinder',
    label: 'RANSAC Cylinder',
    group: 'Fit',
    title:
      'RANSAC 圆柱拟合：从带噪声/外点的点云里找出占比最大的圆柱（管道、杆件、树干），轴方向可自动估计或直接指定，拆分出 <名称>.cylinder 与 <名称>.remaining 并选中后者，可连续剥离',
  },
  {
    key: 'align',
    label: 'Align (point pairs)',
    group: 'Registration',
    title:
      '点对对齐（粗配准）：在两片点云上交替拾取 ≥3 对同名点，解出把「待对齐」搬到「参考」的刚体变换，预览确认后烘焙并改名为 <名称>.registered。两片云位姿差大、重叠度低时先用它，再上 ICP 精配准',
    disabledTitle: NEED_PAIR,
    enabled: () => resolveRegistrationPair(useSceneStore().selection.value, useSceneStore().projects).ok,
  },
  {
    key: 'icp',
    label: 'Fine Registration (ICP)',
    group: 'Registration',
    title:
      '精细配准（ICP）：在当前位置上迭代最近点求解，把「待配准」对齐到「参考」。合适位姿差下可直接用；差得大时先做点对对齐粗配准，ICP 才不会收敛到错误的局部极小',
    disabledTitle: NEED_PAIR,
    enabled: () => resolveRegistrationPair(useSceneStore().selection.value, useSceneStore().projects).ok,
  },
  {
    key: 'gicp',
    label: 'Fine Registration (GICP)',
    group: 'Registration',
    title:
      '精细配准（GICP）：邻域协方差加权的面到面精配准（对应点仍取最近点，每轮解马氏距离最小化）。位姿差不大时比 ICP 更抗"沿平面滑动"，代价是慢一个量级；差得大时先做点对对齐粗配准',
    disabledTitle: NEED_PAIR,
    enabled: () => resolveRegistrationPair(useSceneStore().selection.value, useSceneStore().projects).ok,
  },
]

/** 入口表按分组切好的渲染视图（Tools 菜单用；表是静态的，故在模块级算一次）。 */
export const ALGORITHM_MODAL_GROUPS: readonly { name: AlgorithmModalGroup; items: AlgorithmModalItem[] }[] =
  ALGORITHM_MODALS.reduce<{ name: AlgorithmModalGroup; items: AlgorithmModalItem[] }[]>((groups, item) => {
    const last = groups[groups.length - 1]
    if (last && last.name === item.group) last.items.push(item)
    else groups.push({ name: item.group, items: [item] })
    return groups
  }, [])

const ITEM_BY_KEY = new Map(ALGORITHM_MODALS.map((item) => [item.key, item]))

/** 一个模态的进入/退出/状态（键与入口表一一对应）。 */
interface AlgorithmModalHandle {
  /** 是否已激活。 */
  active: ComputedRef<boolean>
  /** 进入模态（各 store 的 startXxx）。 */
  start: () => void
  /** 退出模态，**恒为取消语义**（还原预览 / 中止 native）；"已完成"路径由各 store 的 apply/run 内部自己调用。 */
  exit: () => void
}

/**
 * 算法模态入口的读与写（各组件调它，不各自维护互斥清单）。
 * 返回值里 `disabled` 是 ref（模板顶层绑定自动解包）；其余是普通函数，模板里调用照样
 * 响应式——函数体内读了 store 的 computed，渲染期即建立依赖。
 * ⚠ 判"某个入口能不能点"一律用 `disabledOf(key)`，**不要**用 `disabled`：后者只是
 * "有没有选中目标"这个默认判据（内部第一道闸），两个配准入口的要求比它严格。
 */
export function useAlgorithmModals() {
  const { selectedNode } = useSceneStore()
  const { active: segmentActive, exitSegment } = useSegmentStore()
  const { active: measureActive, exitMeasure } = useMeasureStore()
  const { active: statFilterActive, startStatisticalFilter, exitStatisticalFilter } = useStatisticalFilterStore()
  const { active: filterActive, startFilter, exitFilter } = useFilterStore()
  const { active: voxelFilterActive, startVoxelFilter, exitVoxelFilter } = useVoxelFilterStore()
  const { active: csfActive, startCsf, exitCsf } = useCsfStore()
  const { active: csfProActive, startCsfPro, exitCsfPro } = useCsfProStore()
  const { active: treeIsoActive, startTreeIso, exitTreeIso } = useTreeIsoStore()
  const { active: euclideanActive, startEuclideanCluster, exitEuclideanCluster } = useEuclideanClusterStore()
  const { active: ransacPlaneActive, startRansacPlane, exitRansacPlane } = useRansacPlaneStore()
  const { active: powerlineActive, startPowerline, exitPowerline } = usePowerlineStore()
  const { active: ransacCylinderActive, startRansacCylinder, exitRansacCylinder } = useRansacCylinderStore()
  const { active: alignActive, startAlign, exitAlign } = useAlignStore()
  const { active: icpActive, startIcp, exitIcp } = useIcpStore()
  const { active: gicpActive, startGicp, exitGicp } = useGicpStore()

  /** 每个模态的 active/start/exit（Record 的键即 AlgorithmModalKey，漏一个就编译不过）。 */
  const handles: Record<AlgorithmModalKey, AlgorithmModalHandle> = {
    statisticalFilter: {
      active: statFilterActive,
      start: startStatisticalFilter,
      exit: () => exitStatisticalFilter(false),
    },
    radiusFilter: { active: filterActive, start: startFilter, exit: () => exitFilter(false) },
    voxelFilter: { active: voxelFilterActive, start: startVoxelFilter, exit: () => exitVoxelFilter(false) },
    csf: { active: csfActive, start: startCsf, exit: () => exitCsf(false) },
    csfPro: { active: csfProActive, start: startCsfPro, exit: () => exitCsfPro(false) },
    // exitTreeIso / exitEuclideanCluster / exitMeasure 无 completed 形参：三者没有"确定/应用"这一步
    // （分割产物由各 store 的 runAndSplit / split 内部直接落地）
    treeIso: { active: treeIsoActive, start: startTreeIso, exit: exitTreeIso },
    euclideanCluster: {
      active: euclideanActive,
      start: startEuclideanCluster,
      exit: exitEuclideanCluster,
    },
    powerLine: { active: powerlineActive, start: startPowerline, exit: exitPowerline },
    ransacPlane: { active: ransacPlaneActive, start: startRansacPlane, exit: () => exitRansacPlane(false) },
    ransacCylinder: {
      active: ransacCylinderActive,
      start: startRansacCylinder,
      exit: () => exitRansacCylinder(false),
    },
    align: { active: alignActive, start: startAlign, exit: () => exitAlign(false) },
    icp: { active: icpActive, start: startIcp, exit: () => exitIcp(false) },
    gicp: { active: gicpActive, start: startGicp, exit: () => exitGicp(false) },
  }

  /** 无选中目标时全部算法入口禁用（这是**默认**判据，逐项判据见 enabledOf）。 */
  const disabled = computed(() => !selectedNode.value)

  /**
   * 该入口当前的可用性：先看有没有选中目标（默认判据），再看它自己的 `enabled` 追加条件
   * （如两个配准入口要求"恰好 2 个已加载的点云"）。判据读的是 store，故在渲染期调用即自动
   * 建立依赖；`disabled` 这里读的是同一个 computed，两条路径不会漂移。
   */
  function enabledOf(key: AlgorithmModalKey): boolean {
    if (disabled.value) return false
    const item = ITEM_BY_KEY.get(key)!
    return item.enabled ? item.enabled() : true
  }

  /** 该入口当前是否禁用（SideToolBar / MenuBar 逐项绑定用；不要再用全局 disabled 判入口）。 */
  function disabledOf(key: AlgorithmModalKey): boolean {
    return !enabledOf(key)
  }

  /** 该模态当前是否激活（菜单项打勾 / 按钮高亮）。 */
  function isActive(key: AlgorithmModalKey): boolean {
    return handles[key].active.value
  }

  /** 悬停说明：可用时讲用途，否则讲为什么不可用。 */
  function titleOf(key: AlgorithmModalKey): string {
    const item = ITEM_BY_KEY.get(key)!
    return disabledOf(key) ? (item.disabledTitle ?? NEED_SELECTION) : item.title
  }

  /**
   * 进入 / 退出某算法模态（toggle）：已激活则退出；未激活则**先退出其余全部模态**再进入。
   * 不满足该入口判据时不动（入口本就禁用，这里是第二道闸——各 store 的 startXxx 也各自校验，
   * 比如两个配准 store 会各自用 resolveRegistrationPair 再解析一次并给出精确原因）。
   */
  function toggle(key: AlgorithmModalKey): void {
    const handle = handles[key]
    if (handle.active.value) {
      handle.exit()
      return
    }
    if (disabledOf(key)) return
    exitOtherModals(key)
    handle.start()
  }

  /**
   * 退出除 `except` 之外的全部模态（分割与测量永远退出）；省略 `except` = 连算法模态一起
   * 全退，供分割 / 测量入口进入前调用（它们不在算法入口表里）。
   */
  function exitOtherModals(except?: AlgorithmModalKey): void {
    if (segmentActive.value) exitSegment(false)
    if (measureActive.value) exitMeasure()
    for (const item of ALGORITHM_MODALS) {
      if (item.key === except) continue
      const handle = handles[item.key]
      if (handle.active.value) handle.exit()
    }
  }

  /**
   * 是否有任一模态（含分割）正在激活——合并等"会动实体集合"的操作的前置闸：各模态持有
   * 启动时的目标实体快照，合并会让快照失效。测量不算：它只持有拾取点，不动实体。
   */
  function anyModalActive(): boolean {
    if (segmentActive.value) return true
    return ALGORITHM_MODALS.some((item) => handles[item.key].active.value)
  }

  return { disabled, disabledOf, isActive, titleOf, toggle, exitOtherModals, anyModalActive }
}
