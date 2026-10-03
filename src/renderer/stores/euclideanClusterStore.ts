import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import type { SplitPart } from './pointcloudStore'
import { candidateCountOfChunk, estimateMeanPointSpacing } from '../utils/radiusFilter'
import type { RadiusFilterChunkSource } from '../utils/radiusFilter'
import {
  bucketClusters,
  buildClusterColors,
  clusterColor,
  computeEuclideanClusters,
  defaultClusterTolerance,
  summarizeClusters,
  DEFAULT_CLUSTER_MAX_POINTS,
  DEFAULT_CLUSTER_MIN_POINTS,
} from '../utils/euclideanCluster'
import type { ClusterSummary } from '../utils/euclideanCluster'

/**
 * 欧式聚类分割（native/euclidean-cluster）模式状态（模块级单例）。
 *
 * 算法语义见 utils/euclideanCluster.ts 的契约镜像；本 store 只做装配：
 * 目标定位 → （预览）native 算全部连通分量 → 逐点染色 + 报数 → （分割）按
 * min/max 过滤成簇 → 拆成「聚类容器 + Cluster 1..N + `<源名>.noise`」。
 *
 * 与其余模态的两处关键设计（决定了本 store 的形状）：
 * 1. **参数分两类，代价差一个量级**：`tolerance`（距离阈值）是算法参数，改了必须重跑
 *    native（O(n log n)）；`minPoints` / `maxPoints` 只是**渲染侧过滤**（native 返回的是
 *    全部原始分量），改了只换统计数字（O(K)）与配色（O(N) 字节，防抖）。于是用户
 *    "拖着最小点数看画面怎么变"是秒回的——这正是把过滤放在渲染侧的全部理由。
 * 2. **预览是染色不是隐藏**：不像滤波预览那样改 index 隐藏点，本模态把每个入选簇染成
 *    区分色、未入选（含点数不足的碎簇）显示为灰，于是"阈值是不是把两个物体粘一起了"
 *    一眼可辨（见 pointcloudStore.setEntityPreviewColors）。
 *
 * 单目标模态（同 treeIso 的单实体语义）：一次只处理一个点云实体；项目 / 容器目标拒绝
 * （避免把 ground 等实体一起卷进来）。产物：源实体被替换为容器 + N 个实体 + 一个残点实体。
 */

/** 目标快照：进入模式时记下实体 id 与名字（run 时现取候选源并校验仍有效）。 */
const state = reactive({
  /** 是否处于欧式聚类模式。 */
  active: false,
  /** 目标实体 id（进入模式时快照；场景树选中变化不影响目标）。 */
  targetId: null as number | null,
  /** 目标显示名（日志/工具栏提示用；进入时快照）。 */
  targetName: '',
  /** 聚类距离阈值（m，算法参数；改它必须重跑 native）。 */
  tolerance: 0,
  /** 簇有效点数下限（渲染侧过滤；含端点）。 */
  minPoints: DEFAULT_CLUSTER_MIN_POINTS,
  /** 簇有效点数上限（渲染侧过滤；含端点；0 = 不限）。 */
  maxPoints: DEFAULT_CLUSTER_MAX_POINTS,
  /** 计算中（native 异步；期间禁用输入与按钮）。 */
  computing: false,
  /** 预览是否由**当前阈值**生成（改阈值置 false ⇒ 分割前必须重算，见 runAndSplit）。 */
  previewed: false,
  /** 最近一次统计（min/max 改动即时重算，O(K)）。 */
  stats: null as ClusterSummary | null,
})

/** 目标候选源（持有渲染缓冲引用）与最近一次 native 结果：大数据不进 reactive。 */
let sources: RadiusFilterChunkSource[] | null = null
let labels: Int32Array | null = null
let clusterSizes: Uint32Array | null = null

/** min/max 改动后的重染防抖任务（见 scheduleRecolor）。 */
let recolorTimer: ReturnType<typeof setTimeout> | null = null

/**
 * min/max 改动的重染防抖（ms）。
 * 统计数字（O(K)）是**即时**更新的，只有逐点重写颜色（O(N) 字节）需要防抖——
 * 用户按住微调键连点时，不该每个键位都全量刷一遍。
 */
const RECOLOR_DEBOUNCE_MS = 120

/**
 * 一次分割允许产出的实体数上限（超过就拒绝，让人回去调参数）。
 *
 * 不是内存限制而是**可用性**限制：聚类数过百后场景树与属性面板已经难以浏览，上千个
 * 实体的项目基本不可用；而产生上千簇几乎总是"阈值太小/最小点数太低"的信号，
 * 提示用户调参比让他拆出一个没法用的项目更有价值（预览不受此限，随便看）。
 */
export const MAX_SPLIT_CLUSTERS = 2000

/** 阈值日志展示（去掉浮点尾噪）。 */
function formatTolerance(v: number): number {
  return Number.isInteger(v) ? v : parseFloat(v.toFixed(6))
}

export function useEuclideanClusterStore() {
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /**
   * 从工具栏进入欧式聚类模式。
   * 目标 = 当前选中的点云实体（项目 / 容器节点拒绝并提示）；初始阈值按
   * 「平均点距 × 3」估一个量级（见 utils/euclideanCluster#defaultClusterTolerance）。
   */
  function startEuclideanCluster() {
    const node = sceneStore.selectedNode.value
    if (!node) return
    // 注意判据是 'pointcloud'（SceneEntity.type）而不是 SceneSelection 的 'entity'：
    // selectedNode 返回的是**节点对象**（SceneProject | SceneEntity | SceneTreeGroup）
    if (node.type !== 'pointcloud') {
      log('EuclideanCluster', '请选中一个点云实体后再进行欧式聚类（项目 / 容器暂不支持）')
      return
    }
    const entity = sceneStore.getAllEntities().find((e) => e.id === node.id)
    if (!entity || !entity.bbox) {
      log('EuclideanCluster', `「${node.name}」尚未加载完成，无法聚类`)
      return
    }
    const chunks = usePointCloudStore().getFilterSourceChunks(node.id)
    const candidateTotal = chunks ? chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0) : 0
    if (!chunks || candidateTotal === 0) {
      log('EuclideanCluster', `「${node.name}」没有可聚类的点，无法进入聚类模式`)
      return
    }
    const spacing = estimateMeanPointSpacing(entity.pointCount, {
      x: entity.bbox.maxX - entity.bbox.minX,
      y: entity.bbox.maxY - entity.bbox.minY,
      z: entity.bbox.maxZ - entity.bbox.minZ,
    })
    state.targetId = node.id
    state.targetName = node.name
    state.tolerance = defaultClusterTolerance(spacing)
    state.minPoints = DEFAULT_CLUSTER_MIN_POINTS
    state.maxPoints = DEFAULT_CLUSTER_MAX_POINTS
    state.computing = false
    state.previewed = false
    state.stats = null
    state.active = true
    sources = null
    labels = null
    clusterSizes = null
    log(
      'EuclideanCluster',
      `进入欧式聚类模式，目标「${node.name}」（${candidateTotal.toLocaleString()} 点）；` +
        `初始距离阈值 ${formatTolerance(state.tolerance)}（≈ 平均点距 ${formatTolerance(spacing)} × 3）`
    )
  }

  /**
   * 更新参数（工具栏输入事件调用；部分字段省略 = 保持原值）。
   *
   * tolerance 改动 ⇒ 预览过期（`previewed = false`，分割前会重算），但**不改动**
   * 已有预览画面（供用户对照旧效果微调，同 filterStore 的约定）。
   * min/max 改动 ⇒ 立即更新统计 + 防抖重染（无需重算 native）。
   */
  function setParams(partial: { tolerance?: number; minPoints?: number; maxPoints?: number }) {
    if (!state.active || state.computing) return
    let sizeChanged = false
    if (partial.tolerance !== undefined && Number.isFinite(partial.tolerance)) {
      const t = Math.max(1e-6, partial.tolerance)
      if (t !== state.tolerance) {
        state.tolerance = t
        state.previewed = false
      }
    }
    if (partial.minPoints !== undefined && Number.isFinite(partial.minPoints)) {
      const m = Math.max(1, Math.round(partial.minPoints))
      if (m !== state.minPoints) {
        state.minPoints = m
        sizeChanged = true
      }
    }
    if (partial.maxPoints !== undefined && Number.isFinite(partial.maxPoints)) {
      const m = Math.max(0, Math.round(partial.maxPoints))
      if (m !== state.maxPoints) {
        state.maxPoints = m
        sizeChanged = true
      }
    }
    if (sizeChanged) updateDisplay()
  }

  /** min/max 改动后：统计即时刷新 + 颜色防抖重染。 */
  function updateDisplay() {
    if (!clusterSizes) return
    state.stats = summarizeClusters(clusterSizes, state.minPoints, state.maxPoints)
    scheduleRecolor()
  }

  /** 防抖重染（见 RECOLOR_DEBOUNCE_MS）。 */
  function scheduleRecolor() {
    if (recolorTimer !== null) clearTimeout(recolorTimer)
    recolorTimer = setTimeout(() => {
      recolorTimer = null
      if (!state.active || state.targetId === null) return
      if (!labels || !clusterSizes || !sources) return
      const colors = buildClusterColors(sources, labels, clusterSizes, state.minPoints, state.maxPoints)
      usePointCloudStore().setEntityPreviewColors(state.targetId, colors)
    }, RECOLOR_DEBOUNCE_MS)
  }

  /**
   * 现取候选源（run 时调用；返回 null = 目标已失效/未加载完成）。
   * 单目标语义：实体自身的可见点（getFilterSourceChunks 语义，index = 可见子集）。
   */
  function resolveTargetChunks(): RadiusFilterChunkSource[] | null {
    if (state.targetId === null) return null
    const chunks = usePointCloudStore().getFilterSourceChunks(state.targetId)
    if (!chunks || chunks.every((c) => candidateCountOfChunk(c) === 0)) return null
    return chunks
  }

  /**
   * 跑一次 native 聚类并把结果收进模块级缓存（不改画面；调用方决定后续）。
   * 块数 / 候选数 / 簇大小表全核对一遍——不符即抛错（契约防御，宁可干净失败）。
   */
  async function fetchClusters(tolerance: number): Promise<{
    chunks: RadiusFilterChunkSource[]
    labels: Int32Array
    clusterSizes: Uint32Array
  }> {
    const targetId = state.targetId
    if (targetId === null) throw new Error('目标实体已失效')
    const chunks = resolveTargetChunks()
    if (!chunks) throw new Error('目标实体已失效或尚未加载完成')
    const results = await computeEuclideanClusters({
      tolerance,
      entities: [{ entityId: targetId, chunks }],
    })
    const result = results.find((r) => r.entityId === targetId)
    if (!result) throw new Error('native 未返回目标实体结果（契约异常）')
    const candidateTotal = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
    if (result.labels.length !== candidateTotal) {
      throw new Error(
        `聚类结果标签数与候选数不一致（labels ${result.labels.length} / 候选 ${candidateTotal}），契约异常`
      )
    }
    return { chunks, labels: result.labels, clusterSizes: result.clusterSizes }
  }

  /**
   * 预览：native 算全部连通分量 → 逐点染色（入选簇区分色 / 其余灰）+ 统计。
   * 每次都按当前阈值重算，新结果整体替换旧预览（染色是整体换装，无闪烁）。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    if (state.targetId === null) return
    state.computing = true
    const t0 = performance.now()
    try {
      const fresh = await fetchClusters(state.tolerance)
      if (!state.active) return // 计算期间已退出模式：丢弃过期结果
      sources = fresh.chunks
      labels = fresh.labels
      clusterSizes = fresh.clusterSizes
      const colors = buildClusterColors(sources, labels, clusterSizes, state.minPoints, state.maxPoints)
      const installed = usePointCloudStore().setEntityPreviewColors(state.targetId, colors)
      if (!installed) {
        throw new Error('预览色安装失败（目标实体尚未加载或块数不符）')
      }
      state.stats = summarizeClusters(clusterSizes, state.minPoints, state.maxPoints)
      state.previewed = true
      const s = state.stats
      log(
        'EuclideanCluster',
        `预览完成：${s.clusterCount.toLocaleString()} 个聚类（${((performance.now() - t0) / 1000).toFixed(1)}s），` +
          `入选 ${s.keptCount.toLocaleString()} 个（${s.keptPoints.toLocaleString()} 点，最大 ${s.largestClusterPoints.toLocaleString()} 点）` +
          `，残点 ${s.noisePoints.toLocaleString()} 点`
      )
    } catch (err) {
      console.error('欧式聚类预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('EuclideanCluster', `预览失败：${message}`)
    } finally {
      if (state.active) state.computing = false
    }
  }

  /**
   * 分割：结果必须对应当前阈值（过期就先重算）→ 按 min/max 分桶 → 拆实体。
   *
   * 产物：`<源名> 聚类` 容器（第三级容器节点）+ 容器下 `Cluster <簇号>`（逐簇区分色，
   * 与该簇的预览色一致；簇号同时是该实体的**编号**，见 sceneStore.SceneEntity.labelNo）
   * + 顶层 `<源名>.noise` 残点实体（未入选簇的全部点）。
   * 源实体被替换（splitEntityMany 的默认替换集 = 源自己）。
   */
  async function runAndSplit() {
    if (!state.active || state.computing) return
    const targetId = state.targetId
    if (targetId === null) return
    state.computing = true
    const t0 = performance.now()
    const { targetName, minPoints, maxPoints } = state
    try {
      // 1. 阈值改过（或还没预览过）⇒ 先重算：绝不拿旧参数的结果去拆
      if (!state.previewed || !labels || !clusterSizes || !sources) {
        const fresh = await fetchClusters(state.tolerance)
        if (!state.active) return
        sources = fresh.chunks
        labels = fresh.labels
        clusterSizes = fresh.clusterSizes
        state.stats = summarizeClusters(clusterSizes, minPoints, maxPoints)
        state.previewed = true
      }

      // 2. 按当前 min/max 分桶（native 结果按标签缓存，这里只做过滤 + 映射）
      //    局部别名：sources/labels/clusterSizes 是模块级 let，await 之后 TS 不再收窄
      const activeSources = sources
      const activeLabels = labels
      const activeSizes = clusterSizes
      if (!activeSources || !activeLabels || !activeSizes) return
      const { clusters, noiseChunkIndices } = bucketClusters(
        activeSources,
        activeLabels,
        activeSizes,
        minPoints,
        maxPoints
      )
      if (clusters.length === 0) {
        log(
          'EuclideanCluster',
          `没有入选的聚类（共 ${activeSizes.length.toLocaleString()} 个，最大 ${state.stats?.largestClusterPoints.toLocaleString() ?? '?'} 点）。` +
            `请调大「距离阈值」或调小「最小点数」（当前最小 ${minPoints}${maxPoints > 0 ? ` / 最大 ${maxPoints}` : ''}）`
        )
        return
      }
      if (clusters.length > MAX_SPLIT_CLUSTERS) {
        log(
          'EuclideanCluster',
          `入选聚类过多（${clusters.length.toLocaleString()} > ${MAX_SPLIT_CLUSTERS}），已取消分割。` +
            '拆出这么多实体后项目将难以使用，请调大「距离阈值」或调大「最小点数」后重试'
        )
        return
      }

      // 3. 目标定位（容器与残点实体的归属都要它）
      const entity = sceneStore.getAllEntities().find((e) => e.id === targetId)
      const projectId = sceneStore.projects.find((p) => p.entities.some((e) => e.id === targetId))?.id
      if (!entity || projectId === undefined) {
        log('EuclideanCluster', `目标「${targetName}」已不存在，请重新进入`)
        exitEuclideanCluster()
        return
      }
      const container = sceneStore.createTreeItemGroup(projectId, `${entity.name} 聚类`)
      if (!container) throw new Error('创建聚类容器失败（项目不存在）')

      // 4. 组装 parts：逐簇挂容器，残点直挂项目顶层（同 treeiso 的 `.noise` 惯例）。
      //    名字与编号都按 **native 簇号**（**不是**保留序下标 `i + 1`）：一旦某簇被 min/max
      //    滤掉，按下标命名/编号就会整体错位（"Cluster 3 变成 Cluster 2"），与颜色一样必须同源。
      //    编号基准恒为 1：本模式的产物是**新容器**（不像 treeiso 会原地重建旧容器），
      //    容器从空开始 ⇒ 簇号即编号，无需 labelBase 那套位移。
      const noiseName = `${entity.name}.noise`
      const parts: SplitPart[] = clusters.map((c) => ({
        name: `Cluster ${c.label}`,
        chunkIndices: c.chunkIndices,
        groupId: container.id,
      }))
      if (noiseChunkIndices) {
        parts.push({ name: noiseName, chunkIndices: noiseChunkIndices })
      }
      const createdIds = usePointCloudStore().splitEntityMany(targetId, parts)
      if (!createdIds || createdIds.length === 0) {
        sceneStore.removeTreeGroup(container.id) // 拆失败回滚：不留空容器
        throw new Error('拆分实体失败')
      }
      // 5. 逐簇落编号 + 染区分色（**native 簇号**既是编号也是配色输入 ⇒ 与预览色同源，
      //    见 buildClusterColors（差半字节量化）；残点不染）。⚠ 别写 `clusterColor(i + 1)` /
      //    `Cluster ${i + 1}`：那是保留序下标，一旦有簇被 min/max 滤掉，后面所有簇的
      //    编号与颜色就整体错位（与预览对不上）。
      const pcs = usePointCloudStore()
      for (const [i, id] of createdIds.entries()) {
        const cluster = clusters[i]
        if (cluster) pcs.setEntityLabelColor(id, clusterColor(cluster.label), cluster.label)
      }
      sceneStore.selectNode({ type: 'treegroup', id: container.id })

      const keptPoints = clusters.reduce((s, c) => s + c.pointCount, 0)
      const noiseCount = noiseChunkIndices?.reduce((s, a) => s + (a ? a.length : 0), 0) ?? 0
      log(
        'EuclideanCluster',
        `欧式聚类完成：${clusters.length} 个聚类（${keptPoints.toLocaleString()} 点，` +
          `耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s），已存入容器「${container.name}」` +
          (noiseCount > 0 ? `；残点 ${noiseCount.toLocaleString()} 点存为「${noiseName}」` : '')
      )
      exitEuclideanCluster()
    } catch (err) {
      console.error('欧式聚类分割失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('EuclideanCluster', `分割失败：${message}`)
      exitEuclideanCluster()
    } finally {
      if (state.active) state.computing = false
    }
  }

  /**
   * 退出欧式聚类模式（完成 / 取消 / 目标失效共用；幂等）。
   * 撤下预览色（装回规范色），清理模块级缓存与防抖任务。
   * 源实体已被拆掉时撤色是空操作（记录已不在，见 setEntityPreviewColors 的返回值）。
   */
  function exitEuclideanCluster() {
    if (!state.active && !state.computing) return
    const wasActive = state.active
    if (recolorTimer !== null) {
      clearTimeout(recolorTimer)
      recolorTimer = null
    }
    if (state.targetId !== null) {
      usePointCloudStore().setEntityPreviewColors(state.targetId, null)
    }
    state.active = false
    state.computing = false
    state.targetId = null
    state.targetName = ''
    state.tolerance = 0
    state.minPoints = DEFAULT_CLUSTER_MIN_POINTS
    state.maxPoints = DEFAULT_CLUSTER_MAX_POINTS
    state.previewed = false
    state.stats = null
    sources = null
    labels = null
    clusterSizes = null
    if (wasActive) log('EuclideanCluster', '已退出欧式聚类')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetName: computed(() => state.targetName),
    tolerance: computed(() => state.tolerance),
    minPoints: computed(() => state.minPoints),
    maxPoints: computed(() => state.maxPoints),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    startEuclideanCluster,
    setParams,
    runPreview,
    runAndSplit,
    exitEuclideanCluster,
  }
}
