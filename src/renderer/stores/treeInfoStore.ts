import { computed, reactive } from 'vue'
import { useAlgorithmModals } from '../composables/useAlgorithmModals'
import { candidateCountOfChunk } from '../utils/radiusFilter'
import type { RadiusFilterChunkSource } from '../utils/radiusFilter'
import {
  accumulateCrown,
  accumulateZ,
  createTreeAccumulator,
  DEFAULT_TREE_METRICS_OPTIONS,
  finishPass1,
  finishTree,
  isTreeClassification,
  normalizeTreeMetricsOptions,
} from '../utils/treeMetrics'
import type { TreeMetrics, TreeMetricsOptions } from '../utils/treeMetrics'
import { DEFAULT_TREE_MARKER_MODE } from '../utils/treeMarkers'
import type { TreeMarkerMode } from '../utils/treeMarkers'
import { useConsoleStore } from './consoleStore'
import { resolveNormalSelection } from './normalStore'
import { usePointCloudStore } from './pointcloudStore'
import { useProgressStore } from './progressStore'
import { useSceneStore } from './sceneStore'

/**
 * 树木基础信息（树高 / 代表点 / 冠幅 / 胸径）的状态与批量计算（模块级单例）。
 *
 * 三处入口共用本文件：
 * - `Trees ▸ Tree info ▸ Compute tree info…`（`MenuBar.vue`）→ `openComputeDialog()` + `TreeInfoDialog.vue`；
 * - 场景树右键 / `Trees ▸ Mark` → `markSelectionAsTree(4 | 5)`；
 * - `Trees ▸ Tree info ▸ Clear tree info` → `clearTreeInfo()`。
 * 属性面板的 Tree object 编辑区**不经过本文件**（它直接走 `sceneStore.setEntityTreeObject`，
 * 单棵手填与批量计算是两条互不干扰的路径）。
 *
 * **这不是算法模态**（同 normalStore）：不进 `useAlgorithmModals` 的入口表——它不占相机、
 * 没有"预览-确认"两步，一次 Compute 直接把指标写进实体的 `treeObject`。所以它没有 handles、
 * 没有目标快照失效问题；但**打开对话框前仍要 `exitOtherModals()`**：本功能是破坏性的属性写入，
 * 而在别人的临时索引预览（`setChunkVisibility`）之上算，预览还原时点集就变了。
 *
 * 「这片点云算不算树」全仓库只有 `utils/treeMetrics.isTreeClassification` 一个判据
 * （可见点分类 ∈ {4, 5}），本文件与属性面板共用它，不在这里做第二份判断。
 *
 * 刻意不进 reactive 的数据（沿袭 normalStore / filterStore 模式）：目标块的候选源
 * （持有 TypedArray 引用，被深度代理会拖垮渲染）。响应式侧只留 id 与纯数字统计。
 *
 * 另有一项与本文件的算法无关、但同属"树木信息"这个功能的显示偏好：`markerMode`
 * （3D 树木标记的显示档位，`View ▸ Tree markers` 三档）。放在这里的理由是它**不是引擎状态**
 * ——覆盖物与 LOD 四件套一样挂在 `three/` 侧、由自己的 watch 驱动（`three/treeInfoOverlay.ts`）。
 */

/** 逐次运行的汇总（对话框结果行 / 日志用；纯数字，可进 reactive）。 */
export interface TreeInfoRunStats {
  /** 算出并写入 `treeObject` 的树数。 */
  computed: number
  /** 本次的目标树总数（进入对话框时快照的数量）。 */
  total: number
  /** 无有效点（候选为空 / z 全是 NaN）而跳过的数量——`finishTree` 返回 null。 */
  skipped: number
  /** 目标已被删除（算的过程中实体没了）而失败的数量。 */
  failed: number
  /** 是否被用户取消（**取消时保留已写入的树**）。 */
  cancelled: boolean
  /** 耗时 [ms]。 */
  elapsedMs: number
}

/** 进入对话框时快照的目标树（sources 零拷贝引用渲染缓冲）。 */
interface TreeTarget {
  entityId: number
  /** 快照时的名字（实体可能中途被删，日志仍说得出是哪一棵）。 */
  name: string
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集）。 */
  chunks: RadiusFilterChunkSource[]
  /** 候选点总数（= 该实体可见点数），只为推导抽样步长。 */
  candidateTotal: number
  /** 显示坐标 → 文件原始坐标的平移（快照 `rec.globalShift`，与 `rec.bbox` 同口径）。 */
  globalShift: { x: number; y: number; z: number }
}

const state = reactive({
  /** 计算对话框是否打开。 */
  dialogOpen: false,
  /** 打开对话框时快照的目标实体 id（对话框打开期间选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 胸径测量高度 [m]（相对基准点；林业惯例 1.3 m）。 */
  dbhHeight: DEFAULT_TREE_METRICS_OPTIONS.dbhHeight,
  /** 胸径切片厚度 [m]。 */
  sliceThickness: DEFAULT_TREE_METRICS_OPTIONS.sliceThickness,
  /** 冠层比例 [%]（自上而下算冠层；30 = 顶部 30%）。界面用百分比，`currentOptions()` 换算成 0-1。 */
  crownPercent: DEFAULT_TREE_METRICS_OPTIONS.crownRatio * 100,
  /** 基准分位数 [%]（0 = 用真最低点；> 0 抗离群低点）。 */
  baseQuantilePercent: DEFAULT_TREE_METRICS_OPTIONS.baseQuantile * 100,
  /** 计算中（期间禁用对话框输入与按钮）。 */
  computing: false,
  /** 最近一次运行的汇总（对话框关闭后仍保留）。 */
  lastStats: null as TreeInfoRunStats | null,
  /**
   * 3D 树木标记的显示档位（`View ▸ Tree markers` 三档单选）。
   *
   * 放在这里而不是 `viewerStore`：它不是引擎状态——覆盖物（`three/treeInfoOverlay.ts`）
   * 与 LOD 四件套一样挂在引擎外，由自己的 watch 驱动；而显示偏好跟着"树木信息"这个功能走。
   */
  markerMode: DEFAULT_TREE_MARKER_MODE as TreeMarkerMode,
})

/** 目标快照（TypedArray 不进 reactive）。 */
let targets: TreeTarget[] = []

/** 本轮是否收到取消请求（非响应式：只被计算循环读，不显示）。 */
let cancelRequested = false

/**
 * 0-1 分数 → 百分比（保留 3 位小数）。
 * 取整是为了不把二进制浮点的尾噪写回输入框（如 `33.3 / 100 * 100` 可能显示成 33.300000000000004）。
 */
function toPercent(fraction: number): number {
  return Math.round(fraction * 100 * 1000) / 1000
}

/**
 * 当前选中项里合格的树林目标（**唯一的筛选实现**：对话框初值、菜单项可用性判据共用它）。
 * 逐项跳过理由分别是：未加载完成（无 bbox / globalShift）、分类不是 4/5、拿不到候选源、候选为空。
 */
function loadedTreeTargets(): TreeTarget[] {
  const sceneStore = useSceneStore()
  const pcs = usePointCloudStore()
  const out: TreeTarget[] = []
  for (const id of resolveNormalSelection(sceneStore.selection.value)) {
    const entity = sceneStore.getAllEntities().find((e) => e.id === id)
    // 未加载完成（无 bbox / globalShift / 渲染缓冲）⇒ 拿不到候选源，无法零拷贝读点
    if (!entity || !entity.bbox || !entity.globalShift) continue
    if (!isTreeClassification(pcs.getClassificationStats(id))) continue
    const chunks = pcs.getFilterSourceChunks(id)
    if (!chunks) continue
    const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
    if (candidateTotal === 0) continue
    out.push({
      entityId: id,
      name: entity.name,
      chunks,
      candidateTotal,
      globalShift: { x: entity.globalShift.x, y: entity.globalShift.y, z: entity.globalShift.z },
    })
  }
  return out
}

export function useTreeInfoStore() {
  const sceneStore = useSceneStore()
  const { log } = useConsoleStore()
  const pcs = usePointCloudStore()
  const { classificationRevision } = pcs

  /**
   * 当前选中项里「已加载 + 分类是 4/5」的实体数。
   * 菜单项 `Compute tree info…` 的可用性判据（0 时置灰并说明"要先标成 class 4/5"）。
   * `classificationRevision` 是依赖信号：`getClassificationStats` 是普通函数，不读它就永远不会重算。
   */
  const treeTargetCount = computed(() => {
    void classificationRevision.value
    return loadedTreeTargets().length
  })

  /** 当前选中项里**有树木信息**（`treeObject !== null`）的实体数（`Clear tree info` 的可用性判据）。 */
  const treeObjectCount = computed(() => {
    const all = sceneStore.getAllEntities()
    return resolveNormalSelection(sceneStore.selection.value).filter((id) => {
      const e = all.find((x) => x.id === id)
      return !!e && e.treeObject !== null
    }).length
  })

  /** 四个参数的当前值（百分比 → 0-1 分数；这个换算全仓库只在这一处）。 */
  function currentOptions(): TreeMetricsOptions {
    return {
      dbhHeight: state.dbhHeight,
      sliceThickness: state.sliceThickness,
      crownRatio: state.crownPercent / 100,
      baseQuantile: state.baseQuantilePercent / 100,
    }
  }

  /**
   * 写入参数（规整后回写 ⇒ 对话框显示的永远是**实际会用**的值）。
   * 非法值（NaN）由 `normalizeTreeMetricsOptions` 回落到默认值，故输入框清空不会把参数写坏。
   */
  function applyOptions(next: Partial<TreeMetricsOptions>) {
    const norm = normalizeTreeMetricsOptions({ ...currentOptions(), ...next })
    state.dbhHeight = norm.dbhHeight
    state.sliceThickness = norm.sliceThickness
    state.crownPercent = toPercent(norm.crownRatio)
    state.baseQuantilePercent = toPercent(norm.baseQuantile)
  }

  function setDbhHeight(v: number) {
    applyOptions({ dbhHeight: v })
  }

  function setSliceThickness(v: number) {
    applyOptions({ sliceThickness: v })
  }

  function setCrownPercent(v: number) {
    applyOptions({ crownRatio: v / 100 })
  }

  function setBaseQuantilePercent(v: number) {
    applyOptions({ baseQuantile: v / 100 })
  }

  /** 切换 3D 树木标记的显示档位（`MenuBar` 的 View 菜单三档；覆盖物由 watch 自动重画）。 */
  function setMarkerMode(mode: TreeMarkerMode) {
    state.markerMode = mode
  }

  /**
   * 打开「Tree info」计算对话框：把选中项解析成**树林目标快照**。
   *
   * 判据与 `treeTargetCount` 同源（同一份 `loadedTreeTargets()`）：已加载 + 分类 ∈ {4,5} + 有候选点。
   * 一个都不合格时**只记日志、不开对话框**——空对话框没有任何可操作的对象，比一句"请先标记为
   * class 4 / 5"更让人困惑。部分跳过时照常打开（合格的那些就是目标），跳过理由进日志。
   */
  function openComputeDialog() {
    if (state.dialogOpen || state.computing) return
    const sels = sceneStore.selection.value
    if (sels.length === 0) {
      log('Tree info', '请先在 DB Tree 中选中要计算树木信息的点云')
      return
    }
    // 先退掉算法模态：在别人的临时索引预览上算，预览还原时点集就变了
    useAlgorithmModals().exitOtherModals()

    const ids = resolveNormalSelection(sels)
    const resolved = loadedTreeTargets()
    if (resolved.length === 0) {
      log(
        'Tree info',
        `选中的 ${ids.length} 片点云都不是「树」（可见点分类需全部为 4 中等植被 / 5 高植被）` +
          '：可在场景树右键或菜单 Trees ▸ Mark 里标记；未加载完成的也会被跳过'
      )
      return
    }

    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    state.dialogOpen = true
    state.computing = false
    const pointTotal = resolved.reduce((s, t) => s + t.candidateTotal, 0)
    log(
      'Tree info',
      `打开树木信息计算：目标 ${resolved.length} 棵 / 候选 ${pointTotal.toLocaleString()} 点` +
        (resolved.length < ids.length ? `（跳过 ${ids.length - resolved.length} 个非树木或未加载完成的选中项）` : '')
    )
  }

  /** 关闭对话框（取消 / Esc）。计算中不允许关闭（按钮与 Esc 在组件侧同样置灰）。 */
  function closeComputeDialog() {
    if (state.computing) return
    state.dialogOpen = false
    state.targetEntityIds = []
    targets = []
  }

  /**
   * 逐棵计算并把结果写进实体的 `treeObject`（唯一的写入路径，经 `sceneStore.setEntityTreeObject`）。
   *
   * 每棵树两趟扫描：趟 1 求 z 极值与分位样本 ⇒ 定基准高程 / 冠层底 / 切片区间；趟 2 收冠层跨度与
   * 切片点 ⇒ 圆拟合定胸径与代表点。**只读不复制**（候选源是渲染缓冲的零拷贝引用）。
   *
   * 让出主线程：每 8 个「步」（一块或一棵树算一步）`setTimeout(0)` 一次。步数而不是块数是刻意的——
   * 单块云逐棵算时，按块计数永远凑不满 8，界面会整段卡住。
   *
   * 取消：置 `cancelRequested`，循环在两次让步之间退出，**已写入的树全部保留**（这与 normalStore
   * 不同——native 不能中途停、又必须防"关掉对话框结果无处可去"；这里每棵树的产物当场落盘，
   * 停在哪里都是自洽的）。
   */
  async function computeTreeInfo() {
    if (state.computing) return
    const total = targets.length
    if (total === 0) {
      log('Tree info', '没有可计算的树木目标，请重新打开计算对话框')
      return
    }
    const progress = useProgressStore()
    state.computing = true
    cancelRequested = false
    const startedAt = performance.now()
    const handle = progress.start({
      title: 'Tree info',
      message: `0 / ${total} 棵`,
      progress: 0,
      modal: false,
      cancellable: true,
      onCancel: () => {
        cancelRequested = true
      },
    })

    const options = currentOptions()
    let steps = 0
    /** 让步节流：每 8 步（块或树）交还一次主线程，让界面能重绘、取消按钮点得动。 */
    const tick = async () => {
      if ((steps++ & 7) === 7) await new Promise((resolve) => setTimeout(resolve, 0))
    }

    /** 单棵树的两趟累加；返回 null = 无有效点（调用方按 cancelled 区分是不是取消）。 */
    const computeOne = async (target: TreeTarget): Promise<TreeMetrics | null> => {
      const acc = createTreeAccumulator(target.candidateTotal)
      for (const chunk of target.chunks) {
        if (cancelRequested) return null
        accumulateZ(acc, chunk.positions, chunk.index)
        await tick()
      }
      finishPass1(acc, options)
      for (const chunk of target.chunks) {
        if (cancelRequested) return null
        accumulateCrown(acc, chunk.positions, chunk.index)
        await tick()
      }
      return finishTree(acc, options, target.globalShift)
    }

    const all = sceneStore.getAllEntities()
    let computed = 0
    let skipped = 0
    let failed = 0
    for (let t = 0; t < total; t++) {
      if (cancelRequested) break
      const target = targets[t]
      handle.update((t / total) * 100, `${t + 1} / ${total} 棵`, target.name)
      if (!all.find((e) => e.id === target.entityId)) {
        failed++ // 运行期被删除
        continue
      }
      const metrics = await computeOne(target)
      if (cancelRequested) break
      if (!metrics) {
        skipped++
        continue
      }
      sceneStore.setEntityTreeObject(target.entityId, metrics)
      computed++
      await tick()
    }

    const elapsedMs = Math.round(performance.now() - startedAt)
    state.computing = false
    state.lastStats = {
      computed,
      total,
      skipped,
      failed,
      cancelled: cancelRequested,
      elapsedMs,
    }

    if (cancelRequested) {
      // 取消时**不** handle.done()：任务已由 progressStore 标成 cancelled，再动它没有意义
      log('Tree info', `已取消：${computed} / ${total} 棵已写入（已算好的保留在实体上），其余未处理`)
      return
    }
    handle.done()
    log(
      'Tree info',
      `树木信息计算完成：${computed} / ${total} 棵` +
        (skipped > 0 ? `，${skipped} 棵无有效点被跳过` : '') +
        (failed > 0 ? `，${failed} 棵目标已删除` : '') +
        `；耗时 ${(elapsedMs / 1000).toFixed(1)} s`
    )
  }

  /**
   * 把当前选中项里的全部点云标记为树木类（4 中等植被 / 5 高植被）。
   *
   * 场景树右键与菜单栏 `Trees ▸ Mark` 共用这一份（与"菜单能点的、键盘/右键能做的必然同一份代码"
   * 的仓库约定一致）。直接写入、不做二次确认（批量重复动作，加确认会打断"分割完顺手标一遍"的流程）。
   * 逐实体结果汇总成一行日志；单片的失败原因由 `setEntityClassification` 自己写日志。
   */
  function markSelectionAsTree(value: 4 | 5) {
    const ids = resolveNormalSelection(sceneStore.selection.value)
    if (ids.length === 0) {
      log('Tree info', '请先选中要标记为树木的点云')
      return
    }
    const all = sceneStore.getAllEntities()
    let ok = 0
    const failedNames: string[] = []
    for (const id of ids) {
      const name = all.find((e) => e.id === id)?.name ?? `#${id}`
      if (pcs.setEntityClassification(id, value)) ok++
      else failedNames.push(name)
    }
    const label = value === 4 ? '中等植被' : '高植被'
    log(
      'Tree info',
      `已标记 ${ok} / ${ids.length} 片点云为 class ${value}（${label}）` +
        (failedNames.length > 0 ? `；失败：${failedNames.join('、')}（未加载完成 / 无分类属性）` : '')
    )
  }

  /**
   * 清空当前选中项的树木信息（把 `treeObject` 置回 null = "还没算过"）。
   * 只动 `treeObject`，**不动分类值**——"不是树了"用 Mark / 属性面板改分类，是另一回事。
   */
  function clearTreeInfo() {
    const ids = resolveNormalSelection(sceneStore.selection.value)
    if (ids.length === 0) {
      log('Tree info', '请先选中要清除树木信息的点云')
      return
    }
    const all = sceneStore.getAllEntities()
    let cleared = 0
    for (const id of ids) {
      const e = all.find((x) => x.id === id)
      if (e && e.treeObject !== null) {
        sceneStore.setEntityTreeObject(id, null)
        cleared++
      }
    }
    log(
      'Tree info',
      cleared > 0 ? `已清除 ${cleared} 片点云的树木信息` : '选中项里没有已算出的树木信息（都是"还没算"状态）'
    )
  }

  return {
    dialogOpen: computed(() => state.dialogOpen),
    targetEntityIds: computed(() => state.targetEntityIds),
    dbhHeight: computed(() => state.dbhHeight),
    sliceThickness: computed(() => state.sliceThickness),
    crownPercent: computed(() => state.crownPercent),
    baseQuantilePercent: computed(() => state.baseQuantilePercent),
    computing: computed(() => state.computing),
    lastStats: computed(() => state.lastStats),
    markerMode: computed(() => state.markerMode),
    treeTargetCount,
    treeObjectCount,
    setDbhHeight,
    setSliceThickness,
    setCrownPercent,
    setBaseQuantilePercent,
    setMarkerMode,
    openComputeDialog,
    closeComputeDialog,
    computeTreeInfo,
    markSelectionAsTree,
    clearTreeInfo,
  }
}
