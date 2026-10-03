import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import type { SplitPart } from './pointcloudStore'
import { candidateCountOfChunk, estimateMeanPointSpacing } from '../utils/radiusFilter'
import type { RadiusFilterChunkSource } from '../utils/radiusFilter'
import { loadNativeModule } from '../utils/nativeLoader'
import { CSF_FIXED, estimateCsfDefaults } from '../utils/csf'
import type { CsfAddon, CsfEntityResult, CsfRequest } from '../utils/csf'
import { buildGroundGrid, GROUND_GRID_DEFAULT_CELL_SIZE } from '../utils/groundGrid'
import type { GroundGridData } from '../utils/groundGrid'
import { residualChunkIndices } from '../utils/labelBuckets'
import {
  bucketLines,
  buildExtractRequest,
  buildLineColors,
  buildTraceRequest,
  clampLinearityMin,
  clampMaxSlopeDeg,
  defaultPowerlineParams,
  extractParamsChanged,
  extractPowerlineCandidates,
  lineColor,
  refineChunkIndices,
  refinedCandidateCount,
  summarizeLines,
  tracePowerlineLines,
  MAX_SPLIT_LINES,
} from '../utils/powerline'
import type {
  PowerlineExtractEntityResult,
  PowerlineLineInfo,
  PowerlineParams,
  PowerlineSummary,
} from '../utils/powerline'

/**
 * 电力线提取（native/powerline）模式状态（模块级单例）。
 *
 * 算法语义、契约镜像与「为什么是两阶段」见 `utils/powerline.ts` 文件头；本 store 只做装配：
 *
 *   地面参考面（分类 2 / CSF）→ native #1 候选提取 → 渲染侧精筛 → native #2 连线
 *   → 预览染色 → 拆成「电力线容器 + `Line 1..K` + `<源名>.noise`」
 *
 * 三处与其它模态不同的设计，都决定了本文件的形状：
 *
 * 1. **参数代价分三级，缓存也分三层**（照 euclideanClusterStore 的 tolerance/minPoints 先例）：
 *    【重】`minHeight` / `radius` 动 ⇒ 重跑 native #1（KD 树 + 逐点 PCA，秒级〜十秒级）；
 *    【即时】线性度 / 倾角是**渲染侧精筛**，动它只重跑精筛 + native #2（毫秒级）；
 *    【轻】其余 trace 参数 ⇒ 只重跑 native #2（候选只有几千〜几万点，快）。
 *    三层缓存 `extract` / `refined` / `labels+lines` 各自带参数快照，`extractParamsChanged`
 *    是唯一判据——**不许拿旧参数的结果去拆**（同 treeIso 的"算法参数变了必须重算"）。
 * 2. **地面参考面是模态的前置条件，不是参数**：它只由「地面来源 + 目标实体」决定，与任何
 *    滑杆无关，故整个会话算一次即可（换地面来源才失效）。
 * 3. **预览是染色**（同欧式聚类/单木分割）：成线点按线号上色、其余（残点 + 非候选）灰，
 *    于是"哪根线没连上、哪两根粘在一起了"一眼可辨。
 *
 * 单目标模态：一次只处理一个点云实体（项目 / 容器目标拒绝），产物替换源实体。
 */

/** 地面来源三档（UI 下拉）。 */
export type PowerlineGroundSource = 'auto' | 'classification' | 'csf'

/** 地面来源的中文名（结果行 / 日志）。 */
const GROUND_SOURCE_LABELS: Record<PowerlineGroundSource, string> = {
  auto: '自动（有分类 2 用分类，否则跑 CSF）',
  classification: '仅用已有分类 2（地面）',
  csf: '仅用 CSF 地面识别',
}

const state = reactive({
  /** 是否处于电力线提取模式。 */
  active: false,
  /** 目标实体 id（进入模式时快照；场景树选中变化不影响目标）。 */
  targetId: null as number | null,
  /** 目标显示名（日志 / 工具栏提示用）。 */
  targetName: '',
  /** 全部旋钮（默认值见 defaultPowerlineParams；进入模式时按平均点距重推）。 */
  params: { ...defaultPowerlineParams() } as PowerlineParams,
  /** 地面来源档位。 */
  groundSource: 'auto' as PowerlineGroundSource,
  /** 计算中（native 异步；期间禁用输入与按钮）。 */
  computing: false,
  /** 预览是否由**当前参数**生成（任一参数改动置 false ⇒ 分割前必须重算）。 */
  previewed: false,
  /** 最近一次线统计（O(K)，不扫点）。 */
  stats: null as PowerlineSummary | null,
  /** 实际用上的地面来源与格边长 / 地面点数（结果行显示，建面后才有效）。 */
  groundUsed: '' as '' | 'classification' | 'csf',
  groundPoints: 0,
  gridCellSize: 0,
})

/** 目标候选源（全量可见点）、地面参考面与三层结果：大数据不进 reactive。 */
let sources: RadiusFilterChunkSource[] | null = null
let grid: GroundGridData | null = null
/** 地面参考面的失效键（`目标:来源`）：换目标或换来源必须重建。 */
let gridKey = ''
let extract: PowerlineExtractEntityResult | null = null
/** extract 对应的【重】档参数快照（判据 = extractParamsChanged）。 */
let extractParams: PowerlineParams | null = null
/** 精筛后的候选源（index = 候选；喂 native #2 与分桶都用它）。 */
let candidateChunks: RadiusFilterChunkSource[] | null = null
let labels: Int32Array | null = null
let lines: PowerlineLineInfo[] | null = null

/** 参数展示去尾噪（估出的小数很长）。 */
function formatParam(x: number): number {
  return Number.isInteger(x) ? x : parseFloat(x.toFixed(4))
}

export function usePowerlineStore() {
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /**
   * 从工具栏进入电力线提取模式。
   * 目标 = 当前选中的点云实体（项目 / 容器节点拒绝并提示）；邻域半径按目标平均点距推一个量级。
   */
  function startPowerline() {
    const node = sceneStore.selectedNode.value
    if (!node) return
    // 判据是 'pointcloud'（SceneEntity.type），不是 SceneSelection 的 'entity'
    if (node.type !== 'pointcloud') {
      log('PowerLine', '请选中一个点云实体后再提取电力线（项目 / 容器暂不支持）')
      return
    }
    const entity = sceneStore.getAllEntities().find((e) => e.id === node.id)
    if (!entity || !entity.bbox) {
      log('PowerLine', `「${node.name}」尚未加载完成，无法提取电力线`)
      return
    }
    const chunks = usePointCloudStore().getFilterSourceChunks(node.id)
    const candidateTotal = chunks ? chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0) : 0
    if (!chunks || candidateTotal === 0) {
      log('PowerLine', `「${node.name}」没有可处理的点，无法进入电力线提取模式`)
      return
    }
    const spacing = estimateMeanPointSpacing(entity.pointCount, {
      x: entity.bbox.maxX - entity.bbox.minX,
      y: entity.bbox.maxY - entity.bbox.minY,
      z: entity.bbox.maxZ - entity.bbox.minZ,
    })
    Object.assign(state.params, defaultPowerlineParams(spacing))
    state.targetId = node.id
    state.targetName = node.name
    state.groundSource = 'auto'
    state.computing = false
    state.previewed = false
    state.stats = null
    state.groundUsed = ''
    state.groundPoints = 0
    state.gridCellSize = 0
    state.active = true
    sources = chunks
    grid = null
    gridKey = ''
    extract = null
    extractParams = null
    candidateChunks = null
    labels = null
    lines = null
    log(
      'PowerLine',
      `进入电力线提取模式，目标「${node.name}」（${candidateTotal.toLocaleString()} 点）；` +
        `初始邻域半径 ${formatParam(state.params.radius)} m（≈ 平均点距 ${formatParam(spacing)} × 10）、` +
        `离地高 ≥ ${formatParam(state.params.minHeight)} m`
    )
  }

  /**
   * 更新参数（工具栏输入事件调用；部分字段省略 = 保持原值）。
   *
   * 任一改动都让预览过期（本模态没有"纯渲染侧"的旋钮：最小点数 / 最短线长也在 native #2 里，
   * 见 utils/powerline.ts 的 bucketLines 注释），但**不动已有画面**——供用户对照旧效果微调，
   * 分割前会自动重算。
   */
  function setParams(partial: Partial<PowerlineParams>) {
    if (!state.active || state.computing) return
    const p = state.params
    let changed = false
    const set = (key: keyof PowerlineParams, value: number) => {
      if (Number.isFinite(value) && value !== p[key]) {
        p[key] = value
        changed = true
      }
    }
    if (partial.minHeight !== undefined) set('minHeight', Math.max(0, partial.minHeight))
    if (partial.radius !== undefined) set('radius', Math.max(1e-3, partial.radius))
    if (partial.linearityMin !== undefined) set('linearityMin', clampLinearityMin(partial.linearityMin))
    if (partial.maxSlopeDeg !== undefined) set('maxSlopeDeg', clampMaxSlopeDeg(partial.maxSlopeDeg))
    if (partial.connectRadius !== undefined) set('connectRadius', Math.max(1e-3, partial.connectRadius))
    if (partial.residualTolerance !== undefined) set('residualTolerance', Math.max(1e-3, partial.residualTolerance))
    if (partial.minLinePoints !== undefined) {
      set('minLinePoints', Math.max(3, Math.round(partial.minLinePoints))) // native 要求 ≥ 3
    }
    if (partial.minLineLength !== undefined) set('minLineLength', Math.max(0, partial.minLineLength))
    if (partial.gapRadius !== undefined) set('gapRadius', Math.max(0, partial.gapRadius))
    if (partial.gapAngleDeg !== undefined) set('gapAngleDeg', Math.min(90, Math.max(0, partial.gapAngleDeg)))
    if (partial.dirRadius !== undefined) set('dirRadius', Math.max(1e-3, partial.dirRadius))
    if (changed) state.previewed = false
  }

  /**
   * 换地面来源：地面参考面及其下游（池子 / 候选 / 线）全部失效。
   * 只标记过期，不立刻重算（用户接着点「预览」或「分割」时才跑）。
   */
  function setGroundSource(source: PowerlineGroundSource) {
    if (!state.active || state.computing || source === state.groundSource) return
    state.groundSource = source
    invalidateFromGround()
  }

  /** 地面参考面失效（换来源 / 换目标）：清掉它下游的全部缓存。 */
  function invalidateFromGround() {
    grid = null
    gridKey = ''
    extract = null
    extractParams = null
    candidateChunks = null
    labels = null
    lines = null
    state.previewed = false
    state.stats = null
    state.groundUsed = ''
    state.groundPoints = 0
    state.gridCellSize = 0
  }

  /**
   * 逐块筛出「分类 == 2」的顶点下标（顶点缓冲空间，递增；无分类的块给 null）。
   * 与可见子集求交：带 index 的块只在其候选之内取（分割产物的旧分类可能来自母云）。
   */
  function classificationGroundIndices(
    chunks: RadiusFilterChunkSource[],
    classBytes: (Uint8Array | null)[]
  ): (Uint32Array | null)[] {
    const out: (Uint32Array | null)[] = []
    for (let c = 0; c < chunks.length; c++) {
      const bytes = classBytes[c]
      if (!bytes) {
        out.push(null)
        continue
      }
      const index = chunks[c].index
      const n = index ? index.length : bytes.length
      const keep: number[] = []
      for (let i = 0; i < n; i++) {
        const v = index ? index[i] : i
        if (bytes[v] === 2) keep.push(v)
      }
      out.push(keep.length > 0 ? new Uint32Array(keep) : null)
    }
    return out
  }

  /** 跑一次 CSF 地面识别，取逐块地面点下标（参数照 csfStore 的默认推导）。 */
  async function runCsfGround(targetId: number): Promise<(Uint32Array | null)[]> {
    const entity = sceneStore.getAllEntities().find((e) => e.id === targetId)
    if (!entity || !entity.bbox) throw new Error('目标实体已失效')
    const defaults = estimateCsfDefaults(entity.pointCount, {
      x: entity.bbox.maxX - entity.bbox.minX,
      y: entity.bbox.maxY - entity.bbox.minY,
      z: entity.bbox.maxZ - entity.bbox.minZ,
    })
    const addon = await loadNativeModule<CsfAddon>('csf_lidar')
    const request: CsfRequest = {
      clothResolution: defaults.clothResolution,
      rigidness: 2,
      iterations: CSF_FIXED.iterations,
      timeStep: CSF_FIXED.timeStep,
      classThreshold: defaults.classThreshold,
      smoothSlope: false,
      heightAxis: CSF_FIXED.heightAxis,
      entities: [{ entityId: targetId, chunks: sources ?? [] }],
    }
    const results = await new Promise<CsfEntityResult[]>((resolve, reject) => {
      try {
        addon.compute(request, (err, res) => (err ? reject(err) : resolve(res ?? [])))
      } catch (e) {
        reject(e) // 入参非法时绑定层同步抛错（不走回调）
      }
    })
    const result = results.find((r) => r.entityId === targetId)
    if (!result) throw new Error('CSF 未返回目标实体结果（契约异常）')
    if (result.ground.length !== (sources?.length ?? 0)) {
      throw new Error('CSF 结果的块数与目标不一致（契约异常）')
    }
    return result.ground
  }

  /**
   * 现取 / 现建地面参考面（**整个会话只算一次**：它只由「目标 + 地面来源」决定，与滑杆无关）。
   *
   * 三档语义见 GROUND_SOURCE_LABELS：`auto` 先试分类 2，没有才跑 CSF；两档显式档宁可报错
   * 也不静默换路（`classification` 档没分类 2 时给明确指引，而不是偷偷跑 CSF —— 那会让
   * "我选的是分类" 与 "结果来自 CSF" 对不上）。
   */
  async function resolveGroundGrid(): Promise<GroundGridData> {
    const targetId = state.targetId
    if (targetId === null || !sources) throw new Error('目标实体已失效')
    const key = `${targetId}:${state.groundSource}`
    if (grid && gridKey === key) return grid

    let groundIndices: (Uint32Array | null)[] | null = null
    // 两条分支都会赋值（下面 if/else 穷尽），故不写初值
    let used: 'classification' | 'csf'
    if (state.groundSource !== 'csf') {
      const classBytes = usePointCloudStore().getClassificationChunks(targetId)
      if (classBytes) groundIndices = classificationGroundIndices(sources, classBytes)
    }
    const classifiedGround = groundIndices?.reduce((s, a) => s + (a ? a.length : 0), 0) ?? 0
    if (classifiedGround > 0) {
      used = 'classification'
    } else {
      if (state.groundSource === 'classification') {
        throw new Error('该点云没有「分类 = 2（地面）」的点，请把地面来源改为「自动」或「CSF」')
      }
      used = 'csf'
      groundIndices = await runCsfGround(targetId)
    }

    const built = buildGroundGrid(
      sources.map((c) => c.positions),
      groundIndices ?? [],
      GROUND_GRID_DEFAULT_CELL_SIZE
    )
    if (!built) throw new Error('没能建出地面参考面（地面点为空），请检查地面来源')
    grid = built
    gridKey = key
    state.groundUsed = used
    state.gridCellSize = built.cellSize
    state.groundPoints = (groundIndices ?? []).reduce((s, a) => s + (a ? a.length : 0), 0)
    log(
      'PowerLine',
      `地面参考面：${used === 'classification' ? '用已有分类 2' : 'CSF 自动识别'}` +
        `（${state.groundPoints.toLocaleString()} 个地面点），格网 ${built.cols}×${built.rows}、` +
        `格边长 ${formatParam(built.cellSize)} m`
    )
    return built
  }

  /** 阶段 1（【重】档）：池子 + 逐池点特征；重档参数没变就复用缓存。 */
  async function fetchExtract(g: GroundGridData): Promise<PowerlineExtractEntityResult> {
    const targetId = state.targetId
    if (targetId === null || !sources) throw new Error('目标实体已失效')
    if (extract && extractParams && !extractParamsChanged(extractParams, state.params)) return extract
    const results = await extractPowerlineCandidates(buildExtractRequest(state.params, g, targetId, sources))
    const result = results.find((r) => r.entityId === targetId)
    if (!result) throw new Error('native 未返回目标实体结果（契约异常）')
    if (result.chunks.length !== sources.length) {
      throw new Error(`候选结果块数与目标不一致（${result.chunks.length} / ${sources.length}），契约异常`)
    }
    const poolTotal = result.chunks.reduce((s, c) => s + c.kept.length, 0)
    if (result.features.linearity.length !== poolTotal || result.features.hag.length !== poolTotal) {
      throw new Error('逐池点特征长度与池子点数不一致（契约异常）')
    }
    extract = result
    extractParams = { ...state.params }
    if (result.stats.poolCount === 0) {
      log('PowerLine', '没有点的离地高达到阈值（池子为空）：请调小「最小离地高」或检查地面参考面')
    }
    return result
  }

  /**
   * 精筛 + 阶段 2（【即时】/【轻】档）：重算候选 → 跑连线 → 收进模块级缓存。
   * 两处契约核对（候选数、labels 长度）不符即抛错——宁可干净失败也别把错的标签拆成实体。
   */
  async function fetchLines(g: GroundGridData): Promise<void> {
    const targetId = state.targetId
    if (targetId === null || !sources) throw new Error('目标实体已失效')
    const ex = await fetchExtract(g)
    const refined = refineChunkIndices(ex, state.params.linearityMin, state.params.maxSlopeDeg)
    const chunks: RadiusFilterChunkSource[] = sources.map((c, i) => ({ positions: c.positions, index: refined[i] }))
    const candidateTotal = refinedCandidateCount(chunks)
    const results = await tracePowerlineLines(buildTraceRequest(state.params, targetId, chunks))
    const result = results.find((r) => r.entityId === targetId)
    if (!result) throw new Error('native 未返回目标实体结果（契约异常）')
    if (result.labels.length !== candidateTotal) {
      throw new Error(
        `连线结果标签数与候选数不一致（labels ${result.labels.length} / 候选 ${candidateTotal}），契约异常`
      )
    }
    candidateChunks = chunks
    labels = result.labels
    lines = result.lines
    state.stats = summarizeLines(result.lines, candidateTotal)
  }

  /** 结果行人话（预览与分割共用）。 */
  function describeStats(): string {
    const s = state.stats
    if (!s) return ''
    return (
      `${s.lineCount} 条（${s.linePoints.toLocaleString()} 点，最长 ${formatParam(s.longestLine)} m，` +
      `总长 ${formatParam(s.totalLength)} m${s.gapLines > 0 ? `，${s.gapLines} 条补过口` : ''}），` +
      `残点 ${s.noisePoints.toLocaleString()} 点`
    )
  }

  /**
   * 预览：建面（若需要）→ 阶段 1（若需要）→ 精筛 + 阶段 2 → 逐点染色 + 统计。
   * 每次按当前参数重算被改动的层，新结果整体替换旧预览（染色是整体换装，无闪烁）。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    const targetId = state.targetId
    if (targetId === null || !sources) return
    state.computing = true
    const t0 = performance.now()
    try {
      const g = await resolveGroundGrid()
      if (!state.active) return // 计算期间已退出模式：丢弃过期结果
      await fetchLines(g)
      if (!state.active) return
      const activeLabels = labels
      const activeLines = lines
      const activeChunks = candidateChunks
      if (!activeLabels || !activeLines || !activeChunks) throw new Error('连线结果缺失（契约异常）')
      const colors = buildLineColors(activeChunks, activeLabels, activeLines.length)
      const installed = usePointCloudStore().setEntityPreviewColors(targetId, colors)
      if (!installed) throw new Error('预览色安装失败（目标实体尚未加载或块数不符）')
      state.previewed = true
      log(
        'PowerLine',
        `预览完成（${((performance.now() - t0) / 1000).toFixed(1)}s）：${describeStats()}` +
          `；池子 ${extract?.stats.poolCount.toLocaleString() ?? '?'} 点、精筛后候选 ${refinedCandidateCount(
            activeChunks
          ).toLocaleString()} 点`
      )
    } catch (err) {
      console.error('电力线预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('PowerLine', `预览失败：${message}`)
    } finally {
      if (state.active) state.computing = false
    }
  }

  /**
   * 分割：结果必须对应当前参数（过期就先重算）→ 按线号分桶 → 拆实体。
   *
   * 产物：`<源名> 电力线` 容器（第三级容器节点）+ 容器下 `Line <线号>`（颜色 = `lineColor(线号)`，
   * 与预览同源；线号同时是该实体的**编号** labelNo）+ 顶层 `<源名>.noise` 残点实体
   * （**源点云减各线**，故地面 / 植被 / 建筑也在里面，不只是池子里的残点）。
   */
  async function runAndSplit() {
    if (!state.active || state.computing) return
    const targetId = state.targetId
    if (targetId === null || !sources) return
    state.computing = true
    const t0 = performance.now()
    const { targetName } = state
    try {
      // 1. 参数改过（或还没预览过）⇒ 先重算：绝不拿旧参数的结果去拆
      if (!state.previewed || !labels || !lines || !candidateChunks) {
        const g = await resolveGroundGrid()
        if (!state.active) return
        await fetchLines(g)
        if (!state.active) return
      }

      // 局部别名：模块级 let 在 await 之后 TS 不再收窄
      const activeSources = sources
      const activeChunks = candidateChunks
      const activeLabels = labels
      const activeLines = lines
      if (!activeSources || !activeChunks || !activeLabels || !activeLines) return

      // 2. 守卫：一条线都没有 / 线太多（同 MAX_SPLIT_CLUSTERS 的理由：可用性上限）
      if (activeLines.length === 0) {
        log(
          'PowerLine',
          `没有提取到电力线（池子 ${extract?.stats.poolCount.toLocaleString() ?? '?'} 点、候选 ${refinedCandidateCount(
            activeChunks
          ).toLocaleString()} 点）。请调小「线性度下限」「最短线长」或「最小离地高」后重试`
        )
        return
      }
      if (activeLines.length > MAX_SPLIT_LINES) {
        log(
          'PowerLine',
          `提取到 ${activeLines.length.toLocaleString()} 条线（> ${MAX_SPLIT_LINES}），已取消分割。` +
            '拆出这么多实体后项目将难以使用，请调大「最短线长」或「最小点数」后重试'
        )
        return
      }

      // 3. 目标定位（容器与残点实体的归属都要它）
      const entity = sceneStore.getAllEntities().find((e) => e.id === targetId)
      const projectId = sceneStore.projects.find((p) => p.entities.some((e) => e.id === targetId))?.id
      if (!entity || projectId === undefined) {
        log('PowerLine', `目标「${targetName}」已不存在，请重新进入`)
        exitPowerline()
        return
      }
      const container = sceneStore.createTreeItemGroup(projectId, `${entity.name} 电力线`)
      if (!container) throw new Error('创建电力线容器失败（项目不存在）')

      // 4. 分桶 → parts：逐线挂容器，残点直挂项目顶层（同 .noise 惯例）。
      //    名字与编号都按 **native 线号**（不是保留序下标）：一旦某条线没被提取出来，
      //    按下标命名/编号就会整体错位，与颜色一样必须同源。
      const { lines: buckets } = bucketLines(activeChunks, activeLabels, activeLines.length)
      const parts: SplitPart[] = buckets.map((b) => ({
        name: `Line ${b.label}`,
        chunkIndices: b.chunkIndices,
        groupId: container.id,
      }))
      const noiseName = `${entity.name}.noise`
      // 残点 = **源点云**减各线（不是"候选里的残点"）：地面 / 植被 / 建筑都得留给用户
      const residual = residualChunkIndices(
        activeSources,
        buckets.map((b) => b.chunkIndices)
      )
      if (residual) parts.push({ name: noiseName, chunkIndices: residual })

      const createdIds = usePointCloudStore().splitEntityMany(targetId, parts)
      if (!createdIds || createdIds.length === 0) {
        sceneStore.removeTreeGroup(container.id) // 拆失败回滚：不留空容器
        throw new Error('拆分实体失败')
      }
      // 5. 逐线落编号 + 染线色（**native 线号**既是编号也是配色输入 ⇒ 与预览色同源）。
      //    残点那一片没有 bucket（下标越界 → undefined），跳过不染。
      const pcs = usePointCloudStore()
      let linePoints = 0
      for (const [i, id] of createdIds.entries()) {
        const bucket = buckets[i]
        if (!bucket) continue
        pcs.setEntityLabelColor(id, lineColor(bucket.label), bucket.label)
        linePoints += bucket.chunkIndices.reduce((s, a) => s + (a ? a.length : 0), 0)
      }
      sceneStore.selectNode({ type: 'treegroup', id: container.id })

      const noiseCount = residual?.reduce((s, a) => s + (a ? a.length : 0), 0) ?? 0
      log(
        'PowerLine',
        `电力线提取完成：${buckets.length} 条（${linePoints.toLocaleString()} 点，` +
          `耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s），已存入容器「${container.name}」；` +
          (noiseCount > 0 ? `残点 ${noiseCount.toLocaleString()} 点存为「${noiseName}」` : '源点云全被提取')
      )
      exitPowerline()
    } catch (err) {
      console.error('电力线提取失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('PowerLine', `提取失败：${message}`)
      exitPowerline()
    } finally {
      if (state.active) state.computing = false
    }
  }

  /**
   * 退出电力线模式（完成 / 取消 / 目标失效共用；幂等）。
   * 撤下预览色（装回规范色），清空三层缓存。源实体已被拆掉时撤色是空操作
   * （记录已不在，见 setEntityPreviewColors 的返回值）。
   */
  function exitPowerline() {
    if (!state.active && !state.computing) return
    const wasActive = state.active
    if (state.targetId !== null) {
      usePointCloudStore().setEntityPreviewColors(state.targetId, null)
    }
    state.active = false
    state.computing = false
    state.targetId = null
    state.targetName = ''
    Object.assign(state.params, defaultPowerlineParams())
    state.groundSource = 'auto'
    state.previewed = false
    state.stats = null
    state.groundUsed = ''
    state.groundPoints = 0
    state.gridCellSize = 0
    sources = null
    grid = null
    gridKey = ''
    extract = null
    extractParams = null
    candidateChunks = null
    labels = null
    lines = null
    if (wasActive) log('PowerLine', '已退出电力线提取')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化，解构后失去响应性）；
  // params 返回的是 reactive 代理本身（不是快照）——它始终是同一个对象、只改字段，
  // 故解构 `params.value.minHeight` 仍随输入响应。
  return {
    active: computed(() => state.active),
    targetName: computed(() => state.targetName),
    params: computed(() => state.params),
    groundSource: computed(() => state.groundSource),
    groundSourceLabel: computed(() => GROUND_SOURCE_LABELS[state.groundSource]),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    groundUsed: computed(() => state.groundUsed),
    groundPoints: computed(() => state.groundPoints),
    gridCellSize: computed(() => state.gridCellSize),
    startPowerline,
    setParams,
    setGroundSource,
    runPreview,
    runAndSplit,
    exitPowerline,
  }
}
