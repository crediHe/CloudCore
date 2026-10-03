import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import type { SplitPart } from './pointcloudStore'
import { candidateCountOfChunk } from '../utils/radiusFilter'
import {
  computeTreeIso,
  bucketCandidateLabels,
  buildEntityUnion,
  buildTreeColors,
  countLabels,
  keptLabelSet,
  sliceEntityLabels,
  summarizeTreeLabels,
  TREEISO_DEFAULTS,
} from '../utils/treeIso'
import type { TreeIsoChunkSource, TreeIsoParams, TreeIsoSummary } from '../utils/treeIso'
import { labelColor } from '../utils/labelColors'

/**
 * TreeIso 单木分割（Xi & Hopkinson 2022 三阶段图切分，native/treeiso）模式状态
 * （模块级单例）。算法本体与参数语义见 utils/treeIso.ts 契约镜像；本 store 只做
 * 装配：目标定位 → native 计算 → （预览）逐点染色 + 报数 → （分割）按标签拆实体
 * → 树项容器 + 单树实体 + 残点实体。
 *
 * 模态工具流（同 euclideanClusterStore）：从工具栏进入后 3D 视图浮出 TreeIsoToolBar。
 *
 * **预览是染色不是隐藏**：不像滤波预览那样改 index 隐藏点，而是每棵入选树一色、
 * 归拢残点的碎片显示为灰（见 pointcloudStore.setEntityPreviewColors）——于是"参数是不是
 * 把两棵树粘一起了"一眼可辨。**参数分两类，代价差一个量级**：
 * - 算法参数（抽稀分辨率 / kNN / λ / 空隙 / 冠高比）改了必须重跑 native（秒级~十几秒），
 *   故只置 `previewed = false`（**画面留着不动**，供对照微调），分割前会自动重算。
 * - `minPoints`（残点归拢下限）是**渲染侧过滤**（native 输出全部组件，见
 *   bucketCandidateLabels 的入参），改它只换统计（O(K)）与配色（O(N) 字节，防抖）
 *   ——"拖着最小点数看哪两棵树分开"是秒回的。
 *
 * 产物形态：分割不是「两块」而是「K 棵 + 残点」：
 * - 源实体被**替换**为：一个「树项」容器（`<源名> 树项`，SceneTreeGroup 第三级）
 *   + 容器下每棵树一个点云实体（`Tree <编号>`，**按标签**定编号与区分色；编号 = 标签 + base − 1，
 *   见 `TreeIsoCache.labelBase` 与 sceneStore.SceneEntity.labelNo），点数不足 minPoints 的
 *   碎片归拢成普通实体 `<源名>.noise`（直挂项目，无树属性）。
 * - 树实体**不挂** treeObject（树木信息）：它是"算过 / 手填过"才有值的东西，预挂 0 值会让
 *   属性面板把"还没算"显示成"算出来是 0"。判据是分类值（`isTreeClassification`），
 *   分割完先把它们标成 class 4/5，再用 `Trees ▸ Compute tree info…` 逐棵算。
 *
 * 目标语义（单目标，一次处理一个源云，避免误分 ground 等实体）：
 * - 选中点云实体 → 分割它并新建树项（采样源 = 实体自身，替换集 = 它自己；
 *   它若原在某树项内，父项可能因此变空，空容器保留，CC 行为——用户可右键删除）。
 * - 选中树项容器 → **原地重建**：把组内全部单树实体的可见点并集作为候选重新
 *   分割（参数调整后重跑入口；组内实体共享同一源顶点缓冲，见 pointcloudStore
 *   splitEntityMany，并集候选零拷贝可行），采样源取组内任一棵树，替换集 = 旧组里
 *   **算法产出的**那些实体，重建结果沿用旧组名。预览与分割走**同一份并集**
 *   （`utils/treeIso.buildEntityUnion` 连切回布局一起产出，见下）。
 *   ⚠ 候选与消费集都只含算法产出项（`sceneStore.algorithmMembersOf`）：手工拖入 /
 *   分割出的项刻意不参与重跑，否则会被 splitEntityMany 连根拔掉（见 SceneEntity.
 *   manuallyPlaced）；它们在新容器建好后原样搬过去，不会被丢下。
 * - 选中项目 → 拒绝并提示。
 *
 * 状态被 ToolBar（按钮高亮/互斥禁用）与 TreeIsoToolBar（显隐/输入/按钮状态）
 * 共享，因此不放在组件内部。候选源（持有 TypedArray 引用）在 run 时现取
 * （start 只记目标定位，目标在等待期间可能被删/改），与 csfStore 的 start 快照
 * 略异；其余沿用其模态约定。
 *
 * ⚠ 容器目标的预览是"逐实体装色"：native 的 labels 是**并集块主序**的一维数组，
 * 必须按 `buildEntityUnion` 的布局表切回各实体（`sliceEntityLabels`）才能装到
 * 各自的几何体上；而"哪棵树上色"用的 kept 集合取自**全局**计数，否则跨实体的
 * 同一棵树会在两个实体上显示成两种颜色。
 */

/** 目标定位（start 时快照；run 时按它现取候选源并校验仍有效）。 */
interface TreeIsoTargetRef {
  kind: 'entity' | 'treegroup'
  id: number
}

const state = reactive({
  /** 是否处于单木分割模式。 */
  active: false,
  /** 进入模式时快照的目标（场景树选中变化不影响目标）。 */
  targetRef: null as TreeIsoTargetRef | null,
  /** 目标显示名（日志/工具栏提示用；进入时快照）。 */
  targetName: '',
  /** 分割参数（TREEISO_DEFAULTS 起步；改动只在模式内生效）。 */
  params: { ...TREEISO_DEFAULTS } as TreeIsoParams,
  /** 树组件有效点数下限（点数低于它的组件整体归拢残点，见 bucketCandidateLabels）。 */
  minPoints: 100,
  /** 分割计算中（native 计算异步；期间禁用参数输入与按钮）。 */
  computing: false,
  /** 预览是否由**当前算法参数**生成（改算法参数置 false ⇒ 分割前必须重算）。 */
  previewed: false,
  /** 最近一次统计（minPoints 改动即时重算，O(K)）。 */
  stats: null as TreeIsoSummary | null,
})

/**
 * 最近一次 native 结果与目标布局：**大数据不进 reactive**，且这些字段必须
 * **同一次 run 产出**——labels 是并集块主序的一维数组，切回各实体的偏移完全
 * 依赖 countsByChunk，混用两次运行的结果会静默切错（颜色张冠李戴）。
 * 故打包成一个对象整体替换，而不是几个并列的模块级 let。
 */
interface TreeIsoCache {
  /** 参与本次计算的实体（单实体目标 = [目标自身]；容器 = 算法成员，顺序即布局序）。 */
  entityIds: number[]
  /** native 请求用的块源（容器 = 并集块源；与 labels 的候选序一一对应）。 */
  chunks: TreeIsoChunkSource[]
  /** 逐实体块源（单实体 = [chunks]；容器 = 各成员的原始块源，装色时逐块对齐）。 */
  perEntity: TreeIsoChunkSource[][]
  /** 容器 = labels 切回各实体的布局表；单实体 = null（labels 就是它的候选序）。 */
  countsByChunk: number[][] | null
  /** 逐标签候选数（统计与 kept 集合的来源，O(K) 复用）。 */
  countMap: Map<number, number>
  /** 候选总数（残点数 = 它 − 有效树点数）。 */
  candidateTotal: number
  /**
   * 本次运行的**编号基准**：这棵树将是 `base + 标签 − 1` 号。
   *
   * 实体目标 / 新容器 = 1（编号与 native 标签一一对应）。树项**原地重建**时容器里可能
   * 还留着带编号的手工项（分割出的片、拖进来的树），新一批树要从它们之后续，于是
   * base > 1——**预览色必须按同一个 base 位移**（见 utils/labelColors.buildLabelColorTable
   * 的 base 参数），否则预览是一套色、拆完是另一套色。
   * 与 labels 同批产出、随 cache 一起整体替换：混用两次 run 的 base 会让编号与色错位。
   */
  labelBase: number
}

let cached: TreeIsoCache | null = null
let labels: Int32Array | null = null

/** minPoints 改动后的重染防抖任务（见 scheduleRecolor）。 */
let recolorTimer: ReturnType<typeof setTimeout> | null = null

/**
 * minPoints 改动的重染防抖（ms）。统计数字（O(K)）**即时**更新，只有逐点重写颜色
 * （O(N) 字节）需要防抖——按住微调键连点时不该每个键位都全量刷一遍。
 */
const RECOLOR_DEBOUNCE_MS = 120

/**
 * 单字段参数收敛（各字段按量纲：抽稀分辨率须为正——native 内做体素网格除法；
 * 比率截断 [0,1]；kNN 取整；其余非负）。
 */
function clampTreeIsoParam(key: string, rawValue: number): number {
  if (key === 'decimateRes1' || key === 'decimateRes2') return Math.max(0.001, rawValue)
  if (key === 'maxGap' || key === 'regStrength1' || key === 'regStrength2' || key === 'verticalWeight') {
    return Math.max(0, rawValue)
  }
  if (key === 'relHeightLengthRatio') return Math.min(1, Math.max(0, rawValue))
  if (key === 'minNN1' || key === 'minNN2' || key === 'minNN3') return Math.max(1, Math.round(rawValue))
  return rawValue
}

export function useTreeIsoStore() {
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()
  const pcs = usePointCloudStore()

  /**
   * 从工具栏进入单木分割模式：解析当前选中节点为目标（单点云实体或树项容器）。
   * 项目节点拒绝（避免误把 ground 等实体一起分割）；目标失效由 run 时校验。
   */
  function startTreeIso() {
    const node = sceneStore.selectedNode.value
    if (!node) return
    if (node.type === 'project') {
      log('TreeIso', '请选中一个点云实体（或一个树项容器）后再进行单木分割')
      return
    }
    state.targetRef = node.type === 'treegroup' ? { kind: 'treegroup', id: node.id } : { kind: 'entity', id: node.id }
    state.targetName = node.name
    state.params = { ...TREEISO_DEFAULTS }
    state.minPoints = 100
    state.computing = false
    state.previewed = false
    state.stats = null
    cached = null
    labels = null
    if (recolorTimer !== null) {
      clearTimeout(recolorTimer)
      recolorTimer = null
    }
    state.active = true
    log(
      'TreeIso',
      `进入单木分割模式，目标「${node.name}」${node.type === 'treegroup' ? '（树项，将原地重建）' : ''}；` +
        '点「预览」可先染色看参数效果（预览不拆分，参数满意再点「分割」）'
    )
  }

  /**
   * 更新分割参数（TreeIsoToolBar 输入事件调用；部分字段省略 = 保持原值）。
   * 仅当处于模式且未在计算中时生效。
   *
   * 算法参数改动 ⇒ 预览过期（`previewed = false`，分割前会重算），但**不改动**
   * 已有预览画面（供用户对照旧效果微调，同 euclideanClusterStore / filterStore）。
   * minPoints 改动 ⇒ 立即更新统计 + 防抖重染（**不**重算 native）。
   */
  function setParams(partial: Partial<TreeIsoParams> & { minPoints?: number }) {
    if (!state.active || state.computing) return
    const { minPoints, ...rest } = partial
    let paramsChanged = false
    for (const [key, rawValue] of Object.entries(rest)) {
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue
      const value = clampTreeIsoParam(key, rawValue)
      const p = state.params as Record<string, number>
      if (p[key] !== value) {
        p[key] = value
        paramsChanged = true
      }
    }
    if (paramsChanged) state.previewed = false
    if (minPoints !== undefined && Number.isFinite(minPoints)) {
      const m = Math.max(1, Math.round(minPoints))
      if (m !== state.minPoints) {
        state.minPoints = m
        updateStats()
        scheduleRecolor()
      }
    }
  }

  /** minPoints 改动后统计即时刷新（O(K)；无缓存时是空操作）。 */
  function updateStats() {
    if (!cached) return
    state.stats = summarizeTreeLabels(cached.countMap, state.minPoints, cached.candidateTotal)
  }

  /** 防抖重染（见 RECOLOR_DEBOUNCE_MS）：只改颜色，不重算 native。 */
  function scheduleRecolor() {
    if (recolorTimer !== null) clearTimeout(recolorTimer)
    recolorTimer = setTimeout(() => {
      recolorTimer = null
      if (!state.active) return
      installPreviewColors()
    }, RECOLOR_DEBOUNCE_MS)
  }

  /**
   * 按当前 minPoints 装预览色（**唯一**的染色出口：预览、防抖重染、分割前刷新都走它）。
   *
   * 单实体目标一次装完；容器目标**逐实体**装——`kept` 取自全局计数（跨实体的同一棵树
   * 同色），点的选段按 `countsByChunk` 切回该实体自己那段（`sliceEntityLabels`）。
   * @returns 是否全部安装成功（目标已被删 / 块数不符 ⇒ false，见 setEntityPreviewColors）
   */
  function installPreviewColors(): boolean {
    if (!cached || !labels) return false
    const kept = keptLabelSet(cached.countMap, state.minPoints)
    let allOk = true
    for (const [e, entityId] of cached.entityIds.entries()) {
      const chunks = cached.perEntity[e]
      if (!chunks) continue
      const slice = cached.countsByChunk ? sliceEntityLabels(labels, cached.countsByChunk, e) : labels
      const ok = pcs.setEntityPreviewColors(entityId, buildTreeColors(chunks, slice, kept, cached.labelBase))
      if (!ok) allOk = false
    }
    return allOk
  }

  /**
   * run 前现取目标候选源（返回 null = 目标已失效，调用方终止并提示）。
   * 实体目标：其全部可见点（getFilterSourceChunks 语义，index = 可见子集）。
   * 树项目标：组内全部单树实体的可见点**逐块并集**——树项内实体共享同一源
   * 顶点缓冲（splitEntityMany 零拷贝拆分产物，块数一致、positions 同实例），
   * 候选 = 逐块 concat 各树 index（顶点空间），块主序分桶即可直接建新实体。
   *
   * 并集与「切回布局」由 `buildEntityUnion` **一起**产出（预览要按布局逐实体装色，
   * 分割要按块建索引几何）——偏移与拼接在同一处才可能互逆。
   */
  function resolveTargetChunks(): {
    entityIds: number[]
    chunks: TreeIsoChunkSource[]
    perEntity: TreeIsoChunkSource[][]
    countsByChunk: number[][] | null
  } | null {
    const ref = state.targetRef
    if (!ref) return null
    if (ref.kind === 'entity') {
      const chunks = pcs.getFilterSourceChunks(ref.id)
      if (!chunks || chunks.every((c) => candidateCountOfChunk(c) === 0)) return null
      return { entityIds: [ref.id], chunks, perEntity: [chunks], countsByChunk: null }
    }
    // treegroup：逐实体取块源，校验块数一致后逐块并集。
    // 候选只取**算法自己产出的**项（`algorithmMembersOf`）——手工拖入 / 分割出的项不参与：
    // 返回值里的 entityIds 同时是 runTreeIso 的 removeEntityIds（即"被消费掉的集合"），
    // 手工项混进去就会被 splitEntityMany 连根拔掉、用户手工的成果静默消失。
    const entityIds = sceneStore.algorithmMembersOf(ref.id)
    if (entityIds.length === 0) return null // 无算法成员：调用方给明确提示
    const perEntity: TreeIsoChunkSource[][] = []
    for (const entityId of entityIds) {
      const chunks = pcs.getFilterSourceChunks(entityId)
      if (!chunks) return null // 有实体尚未加载/已失效：整体放弃
      perEntity.push(chunks)
    }
    const union = buildEntityUnion(perEntity)
    if (!union) return null // 块数不一致（契约防御）
    return { entityIds, chunks: union.chunks, perEntity, countsByChunk: union.countsByChunk }
  }

  /**
   * 跑一次 native 三阶段分割并把结果收进模块级缓存（**不改画面**；调用方决定后续）。
   * 预览与分割共用：分割前若预览过期就是"再调一次本函数"。
   *
   * 校验 labels 长度 == 候选总数（契约防御，同 euclideanClusterStore.fetchClusters）：
   * 长度不符时后续的切片与分桶都会静默错位，宁可干净失败。
   * ⚠ 抛错即"目标不可用"（已删 / 未加载 / 只剩手工项 / 契约破损），调用方一律退出模态。
   */
  async function fetchLabels(): Promise<TreeIsoCache> {
    const ref = state.targetRef
    if (!ref) throw new Error('目标已失效')
    // 容器内只剩手工项时先给明确提示：否则会落到下面那句"已失效或尚未加载完成"，
    // 对"都是手工放进去的项"这种情况是误导（那时目标好端端地在树里）
    if (ref.kind === 'treegroup' && sceneStore.algorithmMembersOf(ref.id).length === 0) {
      throw new Error(`容器「${state.targetName}」内已无算法分割产物（都是手工放入的项），无可重建`)
    }
    const resolved = resolveTargetChunks()
    if (!resolved || resolved.chunks.every((c) => candidateCountOfChunk(c) === 0)) {
      throw new Error(`目标「${state.targetName}」已失效或尚未加载完成，请重新进入`)
    }
    const candidateTotal = resolved.chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
    // native 三阶段分割（entityId 透传给 native 仅作结果核对；树项重建时
    // 用组内任一树实体的 id 当标签，与候选并集无一对一关系）
    const requestEntityId = resolved.entityIds[0]
    const results = await computeTreeIso({
      params: { ...state.params },
      entities: [{ entityId: requestEntityId, chunks: resolved.chunks }],
    })
    const result = results.find((r) => r.entityId === requestEntityId)
    if (!result) throw new Error('native 未返回目标实体结果（契约异常）')
    if (result.labels.length !== candidateTotal) {
      throw new Error(
        `分割结果标签数与候选数不一致（labels ${result.labels.length} / 候选 ${candidateTotal}），契约异常`
      )
    }
    // 编号基准（见 TreeIsoCache.labelBase）：实体目标与新建容器都从 1 起；树项原地重建时
    // 容器里**会被保留**的手工项占着号，新一批树从它们之后续。排除集取本次的算法成员
    // （它们将被整体替换掉，此刻的号不算数）——预览与产物两侧都是这一句算出来的 base。
    const labelBase =
      ref.kind === 'treegroup' ? sceneStore.nextLabelNo({ kind: 'group', groupId: ref.id }, resolved.entityIds) : 1
    const fresh: TreeIsoCache = {
      entityIds: resolved.entityIds,
      chunks: resolved.chunks,
      perEntity: resolved.perEntity,
      countsByChunk: resolved.countsByChunk,
      countMap: countLabels(resolved.chunks, result.labels),
      candidateTotal,
      labelBase,
    }
    // 成员表可能已变（成员被拖出容器）：先把**掉出目标**的实体预览色撤掉——它们已经
    // 不属于本次结果，而 exitTreeIso 只认新成员表，不撤就会带着预览色永久留在场景里。
    if (cached) {
      const next = new Set(fresh.entityIds)
      for (const entityId of cached.entityIds) {
        if (!next.has(entityId)) pcs.setEntityPreviewColors(entityId, null)
      }
    }
    cached = fresh
    labels = result.labels
    return fresh
  }

  /**
   * 预览：native 算标签 → 逐点染色（每棵入选树一色 / 归拢残点的碎片为灰）+ 报数。
   * 每次都按当前算法参数重算，新结果整体替换旧预览（染色是整体换装，无闪烁）。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    state.computing = true
    const t0 = performance.now()
    try {
      const fresh = await fetchLabels()
      if (!state.active) return // 计算期间已退出模式：丢弃过期结果
      if (!installPreviewColors()) {
        throw new Error('预览色安装失败（目标已被删除或块数不符）')
      }
      state.stats = summarizeTreeLabels(fresh.countMap, state.minPoints, fresh.candidateTotal)
      state.previewed = true
      const s = state.stats
      log(
        'TreeIso',
        `预览完成：${s.treeCount.toLocaleString()} 棵树（${s.treePoints.toLocaleString()} 点，` +
          `最大 ${s.largestTreePoints.toLocaleString()} 点，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s），` +
          `残点 ${s.noisePoints.toLocaleString()} 点（灰色，含 ${s.componentCount.toLocaleString()} 个组件）`
      )
    } catch (err) {
      console.error('TreeIso 预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('TreeIso', `预览失败：${message}`)
      exitTreeIso()
    } finally {
      if (state.active) state.computing = false
    }
  }

  /** 一键分割：native 计算（异步，uv 线程池）→ 分桶 → 建树项/拆实体 → 收尾选中。 */
  async function runTreeIso() {
    if (!state.active || state.computing) return
    const ref = state.targetRef
    if (!ref) return
    state.computing = true
    const t0 = performance.now()
    const { targetName } = state
    try {
      // 1. 结果必须对应当前参数与当前目标（参数改过 / 还没预览过 / 目标布局变了 ⇒ 先重算）：
      //    绝不拿旧参数或旧布局的结果去拆（同 euclideanClusterStore.runAndSplit）。
      //    ⚠ "布局变了"这条对容器是必需的：预览后把某个成员实体拖出容器，缓存里的
      //    entityIds 仍是旧成员表，直接拆会按旧并集消费——用户刚拖出去的那项会被
      //    splitEntityMany 一起删掉（手工调整被静默撤销）。
      //    目标不可用（已删 / 未加载 / 容器只剩手工项 / 契约破损）由 fetchLabels 抛错，
      //    走下面的 catch 统一报出并退出模态。
      //    这里复用 resolveTargetChunks 取成员表（它在容器目标下会顺带 concat 一遍 index，
      //    与紧接着的分割相比可忽略；换成"只比 id 的轻量查法"则要多维护一份等价逻辑）。
      const currentIds = resolveTargetChunks()?.entityIds
      // 先落到局部常量：模块级 `cached` 的收窄在箭头函数体里会失效（它随时可能被重赋）
      const cachedIds = cached?.entityIds ?? null
      const sameTarget =
        !!currentIds &&
        !!cachedIds &&
        currentIds.length === cachedIds.length &&
        currentIds.every((id, i) => id === cachedIds[i])
      if (!state.previewed || !labels || !cached || !sameTarget) {
        await fetchLabels()
        if (!state.active) return // 计算期间已退出模式：丢弃过期结果（finally 兜底复位）
      }
      // 局部别名：cached / labels 是模块级 let，await 之后 TS 不再收窄
      const activeCache = cached
      const activeLabels = labels
      if (!activeCache || !activeLabels) return

      // 2. 分桶：点数 < minPoints 的组件归拢残点；无有效树 = 原目标不动，中止
      const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(
        activeCache.chunks,
        activeLabels,
        state.minPoints
      )
      const noiseCount = noiseChunkIndices?.reduce((s, idx) => s + (idx ? idx.length : 0), 0) ?? 0
      if (treeBuckets.length === 0) {
        log(
          'TreeIso',
          `没有分出有效单木（${activeCache.candidateTotal.toLocaleString()} 点全部归拢残点）。` +
            '请调小「最小点数」或检查参数（点云是否已去除地面？）'
        )
        exitTreeIso()
        return
      }

      // 3. 定位容器归属 + 命名（树项重建沿用旧组名；新容器先建，parts 需要它）
      const sourceEntity = ref.kind === 'entity' ? sceneStore.getAllEntities().find((e) => e.id === ref.id) : null
      const projectId =
        ref.kind === 'entity'
          ? sceneStore.projects.find((p) => p.entities.some((e) => e.id === ref.id))?.id
          : sceneStore.projects.find((p) => p.treeGroups.some((g) => g.id === ref.id))?.id
      if (projectId === undefined || (ref.kind === 'entity' && !sourceEntity)) {
        log('TreeIso', `目标「${targetName}」已不存在，请重新进入`)
        exitTreeIso()
        return
      }
      const oldGroup = ref.kind === 'treegroup' ? sceneStore.treeGroupById(ref.id) : null
      const groupName =
        ref.kind === 'treegroup' ? (oldGroup?.name ?? `${targetName} 树项`) : `${sourceEntity!.name} 树项`
      const treeGroup = sceneStore.createTreeItemGroup(projectId, groupName)
      if (!treeGroup) {
        throw new Error('创建树项容器失败（项目不存在）')
      }

      // 4. 组装 parts 并拆片：树实体挂新容器（**不挂 treeObject**——树木信息由
      //    `Trees ▸ Compute tree info…` 写入，null = "还没算"，见 treeIsoStore 文件头），
      //    残点实体 `<源名>.noise` 直挂项目顶层。
      //    采样源与替换集：实体目标 = 实体自身；树项重建 = 采样源取组内任一树
      //    （splitEntityMany 需其 cloudRecord 仍存活，此刻旧组尚未动），替换集 =
      //    旧组全部树实体——splitEntityMany 逐个移出场景/树节点后，旧组容器已空，
      //    随即 removeTreeGroup 清掉
      // 名字与编号都按 **native 标签**（不是保留序下标）：`编号 = base + 标签 − 1`。
      // 改 minPoints 让某棵树掉出保留集时，其余树的编号/名字不会像按下标命名那样整体错位
      // （"Tree 3 突然变成 Tree 2"），且与预览色同源（base 见 TreeIsoCache.labelBase）。
      const noiseName = `${sourceEntity?.name ?? targetName}.noise`
      const parts: SplitPart[] = treeBuckets.map((bucket) => ({
        name: `Tree ${activeCache.labelBase + bucket.label - 1}`,
        chunkIndices: bucket.chunkIndices,
        groupId: treeGroup.id,
      }))
      if (noiseChunkIndices) {
        parts.push({ name: noiseName, chunkIndices: noiseChunkIndices })
      }
      const createdIds = pcs.splitEntityMany(
        activeCache.entityIds[0],
        parts,
        ref.kind === 'treegroup' ? { removeEntityIds: activeCache.entityIds } : undefined
      )
      if (!createdIds || createdIds.length === 0) {
        sceneStore.removeTreeGroup(treeGroup.id) // 拆失败回滚：不留空容器
        throw new Error('拆分实体失败')
      }
      // 旧容器此刻**只剩手工项**：算法项都在 removeEntityIds 里、已随 removeEntityFromProject
      // 逐个从 entityIds 剔除，而手工项刻意不在消费集内、原地留着。容器一删它们的成员关系
      // 就一起没了、会静默掉到 2 级，故先记下再搬进新容器（追加 = 保持原有相对顺序）。
      // 搬过去走 moveEntity："从无容器进容器" ⇒ manuallyPlaced 仍为 true，语义不变。
      const survivors = ref.kind === 'treegroup' && oldGroup ? [...oldGroup.entityIds] : []
      if (ref.kind === 'treegroup' && oldGroup) {
        sceneStore.removeTreeGroup(oldGroup.id)
      }
      for (const id of survivors) {
        sceneStore.moveEntity(id, { kind: 'group', groupId: treeGroup.id })
      }

      // 5. 逐树落编号 + 染区分色（残点不染）；splitEntityMany 已把源/旧组整体移出场景。
      //    编号与颜色都按 **native 标签**定（不是保留序下标）：改 minPoints 让某棵树掉出
      //    保留集时，其余树的编号与颜色不会整体错位；色与预览色同一份 labelColor
      //    （差半字节量化，见 labelColors）。
      for (const [i, id] of createdIds.entries()) {
        const bucket = treeBuckets[i]
        if (!bucket) continue
        const no = activeCache.labelBase + bucket.label - 1
        pcs.setEntityLabelColor(id, labelColor(no), no)
      }

      // 6. 自动选中树项容器（场景树 + 属性面板联动），收尾日志
      sceneStore.selectNode({ type: 'treegroup', id: treeGroup.id })
      const treeTotal = treeBuckets.reduce((s, b) => s + b.pointCount, 0)
      log(
        'TreeIso',
        `单木分割完成：${treeBuckets.length} 棵树（${treeTotal.toLocaleString()} 点，` +
          `耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s），` +
          `残点 ${noiseCount.toLocaleString()} 点` +
          (noiseCount > 0 ? `（已存为「${noiseName}」）` : '')
      )
      exitTreeIso()
    } catch (err) {
      console.error('TreeIso 分割失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('TreeIso', `分割失败：${message}`)
      exitTreeIso()
    } finally {
      if (state.active) state.computing = false
    }
  }

  /**
   * 退出单木分割模式（完成 / 取消 / 目标失效共用；幂等）。
   * runTreeIso 内部在流程终止点统一调用；用户也可从工具栏 Esc/关闭退出。
   *
   * 撤下预览色（装回规范色）并清理缓存与防抖任务。目标实体已被拆掉时撤色是空操作
   * （记录已不在，见 setEntityPreviewColors 的返回值）——分割完成后的正常退出路径
   * 正是这一条（源实体已替换为产物）。
   */
  function exitTreeIso() {
    if (!state.active && !state.computing) return
    const wasActive = state.active
    if (recolorTimer !== null) {
      clearTimeout(recolorTimer)
      recolorTimer = null
    }
    if (cached) {
      // ⚠ 判据是 `cached` 而**不是** `state.previewed`：改算法参数会置 previewed = false
      // 而画面上的预览色**还装着**（刻意留着供对照微调），按 previewed 撤就会永久残留。
      // cached 非空 = 本会话至少跑过一次 native（预览过），撤色对"没装过的实体"是无操作
      // （setEntityPreviewColors 会把规范色装回去，且不改 colorMode）。
      for (const entityId of cached.entityIds) {
        pcs.setEntityPreviewColors(entityId, null)
      }
    }
    state.active = false
    state.computing = false
    state.targetRef = null
    state.targetName = ''
    state.params = { ...TREEISO_DEFAULTS }
    state.minPoints = 100
    state.previewed = false
    state.stats = null
    cached = null
    labels = null
    if (wasActive) log('TreeIso', '已退出单木分割')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetName: computed(() => state.targetName),
    params: computed(() => state.params),
    minPoints: computed(() => state.minPoints),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    startTreeIso,
    setParams,
    runPreview,
    runTreeIso,
    exitTreeIso,
  }
}
