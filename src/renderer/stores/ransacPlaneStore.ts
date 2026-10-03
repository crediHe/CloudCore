import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import type { EntityBBox } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { useViewerStore } from './viewerStore'
import { loadNativeModule } from '../utils/nativeLoader'
import { candidateCountOfChunk, splitKeptRemoved } from '../utils/radiusFilter'
import { estimateRansacDefaults } from '../utils/ransacPlane'
import type {
  RansacPlaneAddon,
  RansacPlaneChunkSource,
  RansacPlaneEntityResult,
  RansacPlaneModel,
  RansacPlaneRequest,
} from '../utils/ransacPlane'
import { createPlaneOverlay } from '../three/planeOverlay'
import type { PlaneOverlay, PlaneOverlayItem } from '../three/planeOverlay'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * RANSAC 平面拟合模式状态（模块级单例）。
 *
 * 仿半径滤波（filterStore）的**预览型**模态工具流：从工具栏进入后 3D 视图角上浮出
 * RansacPlaneToolBar，点「预览」触发 C++ 计算（native/ransac-plane，零拷贝贴渲染缓冲），
 * 画面上只留平面内点 + 3D 里浮出半透明平面片与法线，确认后拆分。
 *
 * 与滤波类工具的两处关键差异：
 * - **产出的是「平面」+「其余」**：`<name>.plane` / `<name>.remaining`，且**自动选中
 *   `.remaining`**——这是本功能的主线工作流：一次剥一个平面，剥完接着剥下一个
 *   （再点按钮 → 预览 → 确定），而不是一次拟合出全部平面。
 * - **回包多一个平面模型**（native 契约的第二处破模板，见 utils/ransacPlane.ts）：
 *   除了内点索引，还带回法向 / 偏移 / 平面度 / 平面片画布，用于 3D 可视化与质量报告。
 *
 * 已知局限（UI 要引导，别让用户当成 bug）：均匀采样 RANSAC 找不出占比过低的平面
 * （采样集 65536 点，占比 0.1% 的平面三点全落上的概率可忽略，PCL 同样如此）。
 * 缓解：先框选局部再拟合，或先剥掉占比大的平面。详见 native/ransac-plane/README-REF.md。
 *
 * 刻意不进 reactive 的数据（沿袭 segmentStore/filterStore 模式）：目标 sources（持有
 * TypedArray 引用）、预览内点（Uint32Array 被深度代理会拖慢渲染）、平面覆盖层实例。
 */

/** 预览统计（纯数字，可进 reactive）。 */
export interface RansacPlaneStats {
  /** 全部目标实体内点数合计。 */
  inlierTotal: number
  /** 全部目标实体候选点数合计。 */
  candidateTotal: number
  /** 成功拟合出平面的实体数 / 目标实体总数。 */
  planesFound: number
  entitiesTotal: number
  /**
   * 「主要平面」（内点最多的那块）的平面度指标；一块都没拟合出来时为 null。
   * 多目标时工具栏只显示主要平面的一组数字，逐实体的明细在 Console 日志里。
   */
  rms: number | null
  maxDeviation: number | null
  /** 采样集点数（诊断：判断小平面是否可能被采样漏掉）。 */
  sampleCount: number
  /** 假设循环实际执行的轮数（自适应早停生效时小于最大迭代次数）。 */
  iterationsUsed: number
}

/** 进入模式时快照的拟合目标（sources 零拷贝引用渲染缓冲）。 */
interface RansacTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集，见 pointcloudStore）。 */
  sources: RansacPlaneChunkSource[]
  /** 候选点总数（= 该实体可见点数，拆分校验用）。 */
  candidateTotal: number
}

const state = reactive({
  /** 是否处于平面拟合模式。 */
  active: false,
  /** 进入模式时快照的目标实体 id（场景树选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 距离阈值：点到平面的绝对距离 ≤ 它判内点（与点云坐标同单位；进入模式按平均点距 ×2 估算）。 */
  distanceThreshold: 0,
  /** 假设循环最大轮数（自适应早停会提前结束）。 */
  maxIterations: 1000,
  /** 是否对最优内点集做最小二乘精修（对齐 PCL setOptimizeCoefficients）。 */
  optimizeCoefficients: true,
  /** 预览计算中（native 计算异步；期间禁用参数输入与按钮）。 */
  computing: false,
  /** 预览结果是否由**当前参数**生成；参数改动置 false（须重新预览后「确定」才可用）。 */
  previewed: false,
  /** 最近一次预览的统计，供工具栏结果行显示。 */
  stats: null as RansacPlaneStats | null,
})

/** 目标快照与最近一次预览结果（TypedArray 不进 reactive，沿袭 segmentStore 的缓存模式）。 */
let targets: RansacTarget[] = []
let previewInliers: Map<number, Uint32Array[]> | null = null
let previewPlanes: Map<number, RansacPlaneModel> | null = null
/** 平面片覆盖层（懒创建；退出只 hide 不 dispose——下次进模式复用同一实例）。 */
let overlay: PlaneOverlay | null = null

/** 距离阈值日志展示（去掉浮点尾噪）。 */
function formatThreshold(v: number): number {
  return Number.isInteger(v) ? v : parseFloat(v.toFixed(6))
}

/** 惰性建覆盖层（3D 视图未挂载时返回 null，预览仍可算，只是不画平面片）。 */
function ensureOverlay(): PlaneOverlay | null {
  const viewer = useViewerStore().getViewer()
  if (!viewer) return null
  if (!overlay) overlay = createPlaneOverlay(viewer.scene)
  return overlay
}

/** 画平面片（顺带置脏；three 无变更通知，直写场景必须自己 requestRender）。 */
function showPlanes(items: PlaneOverlayItem[]): void {
  const instance = ensureOverlay()
  if (!instance) return
  if (items.length > 0) instance.show(items)
  else instance.hide()
  useViewerStore().getViewer()?.requestRender()
}

export function useRansacPlaneStore() {
  const { selectedNode, selectNode } = useSceneStore()
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /** 还原全部已预览目标的索引渲染、并收掉平面片（退出/取消时用；无预览时幂等）。 */
  function restorePreview() {
    if (overlay) {
      overlay.hide()
      useViewerStore().getViewer()?.requestRender()
    }
    if (previewInliers) {
      const pcs = usePointCloudStore()
      for (const entityId of previewInliers.keys()) {
        pcs.setChunkVisibility(entityId, null)
      }
    }
    previewInliers = null
    previewPlanes = null
    state.previewed = false
    state.stats = null
  }

  /**
   * 从工具栏进入平面拟合模式：解析当前选中节点为目标实体快照。
   * 与分割/滤波同款目标语义：项目 = 全部子实体；实体 = 仅它自己。
   * 目标全部未加载完成时提示并拒绝进入（无渲染缓冲无法贴数据计算）。
   */
  function startRansacPlane() {
    const node = selectedNode.value
    if (!node) return
    const candidates = node.type === 'project' ? node.entities.map((e) => e.id) : [node.id]
    const pcs = usePointCloudStore()
    const resolved: RansacTarget[] = []
    // 聚合统计（默认阈值估算用）：点数为可见点合计，包围盒取各目标合并
    let count = 0
    let bbox: EntityBBox | null = null
    for (const id of candidates) {
      const entity = sceneStore.getAllEntities().find((e) => e.id === id)
      if (!entity || !entity.bbox || !entity.globalShift) continue // 未加载完成
      const sources = pcs.getFilterSourceChunks(id)
      if (!sources) continue
      const candidateTotal = sources.reduce((s, c) => s + candidateCountOfChunk(c), 0)
      if (candidateTotal === 0) continue
      resolved.push({ entityId: id, sources, candidateTotal })
      count += entity.pointCount
      bbox = bbox
        ? {
            minX: Math.min(bbox.minX, entity.bbox.minX),
            minY: Math.min(bbox.minY, entity.bbox.minY),
            minZ: Math.min(bbox.minZ, entity.bbox.minZ),
            maxX: Math.max(bbox.maxX, entity.bbox.maxX),
            maxY: Math.max(bbox.maxY, entity.bbox.maxY),
            maxZ: Math.max(bbox.maxZ, entity.bbox.maxZ),
          }
        : { ...entity.bbox }
    }
    if (resolved.length === 0) {
      log('RANSAC', '选中的点云尚未加载完成，无法拟合平面')
      return
    }
    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    // 初始参数 = 平均点距 ×2（与半径滤波初始半径、CSF 分类阈值同一套量级依据）
    const defaults = bbox
      ? estimateRansacDefaults(count, {
          x: bbox.maxX - bbox.minX,
          y: bbox.maxY - bbox.minY,
          z: bbox.maxZ - bbox.minZ,
        })
      : estimateRansacDefaults(0, { x: 0, y: 0, z: 0 })
    state.distanceThreshold = defaults.distanceThreshold
    state.maxIterations = defaults.maxIterations
    state.optimizeCoefficients = defaults.optimizeCoefficients
    state.active = true
    state.computing = false
    state.previewed = false
    state.stats = null
    log(
      'RANSAC',
      `进入平面拟合模式，目标 ${resolved.length} 块点云；初始参数：距离阈值 ${formatThreshold(
        state.distanceThreshold
      )}（≈ 平均点距 ×2）/ 最大迭代 ${state.maxIterations} / 系数优化 ${state.optimizeCoefficients ? '开' : '关'}`
    )
  }

  /**
   * 更新拟合参数（RansacPlaneToolBar 输入事件调用）。
   * 参数改动**不影响当前显示**：已有的预览原样保留（供对照旧效果微调参数），
   * 也不触发重算；仅将 previewed 置 false——「确定」必须等下一次「预览」按当前参数
   * 重新生成结果后才能用（防止用旧参数的结果去拆分）。
   */
  function setParams(distanceThreshold: number, maxIterations: number, optimizeCoefficients: boolean) {
    if (!state.active || state.computing) return
    const dt = Number.isFinite(distanceThreshold) ? Math.max(distanceThreshold, 0) : state.distanceThreshold
    const mi = Number.isFinite(maxIterations) ? Math.max(0, Math.round(maxIterations)) : state.maxIterations
    if (
      dt === state.distanceThreshold &&
      mi === state.maxIterations &&
      optimizeCoefficients === state.optimizeCoefficients
    ) {
      return
    }
    state.distanceThreshold = dt
    state.maxIterations = mi
    state.optimizeCoefficients = optimizeCoefficients
    state.previewed = false
  }

  /**
   * 手动触发预览：native 计算（异步，uv 线程池 + 内部硬件线程并行）→ 逐实体
   * setChunkVisibility 只留平面内点，并在 3D 里画出平面片与法线。
   * 每次都按**原始数据 + 当前参数**重算，新结果整体替换旧预览（setIndex 整体换索引即可，
   * 无需先还原，避免闪烁）。预览期强制目标可见（防树勾选把云藏掉），不锁相机。
   *
   * 未拟合出平面的实体**保持原样可见**（不隐藏）：让用户直接看到"这块没找到平面"，
   * 比整片变空更好判断该调哪个参数。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    if (targets.length === 0) return
    state.computing = true
    try {
      const addon = await loadNativeModule<RansacPlaneAddon>('ransac_plane')
      const request: RansacPlaneRequest = {
        distanceThreshold: state.distanceThreshold,
        maxIterations: state.maxIterations,
        optimizeCoefficients: state.optimizeCoefficients,
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const results = await new Promise<RansacPlaneEntityResult[]>((resolve, reject) => {
        try {
          addon.compute(request, (err, res) => {
            if (err) reject(err)
            else resolve(res ?? [])
          })
        } catch (e) {
          reject(e) // compute 入参非法时绑定层同步抛错（不走回调）
        }
      })

      if (!state.active) return // 计算期间已退出模式（Esc/切换按钮）：丢弃过期结果
      const pcs = usePointCloudStore()
      pcs.beginSegmentPreview(state.targetEntityIds) // 预览期强制可见（幂等）
      const inlierMap = new Map<number, Uint32Array[]>()
      const planeMap = new Map<number, RansacPlaneModel>()
      const overlayItems: PlaneOverlayItem[] = []
      let inlierTotal = 0
      let candidateTotal = 0
      let mainPlane: RansacPlaneModel | null = null
      let mainEntityName = ''

      for (const result of results) {
        const target = targets.find((t) => t.entityId === result.entityId)
        if (!target) continue
        candidateTotal += target.candidateTotal
        const name = sceneStore.getAllEntities().find((e) => e.id === result.entityId)?.name ?? String(result.entityId)
        if (result.inliers.length !== target.sources.length) {
          // 契约防御：块数对不齐说明 native 输入解析与渲染侧不一致，跳过该实体
          log('RANSAC', `实体「${name}」预览结果与块数不一致，已跳过`)
          continue
        }
        if (!result.plane) {
          log('RANSAC', `实体「${name}」未找到平面（请调大距离阈值或迭代次数，或先框选局部）`)
          continue
        }
        const plane = result.plane
        const inliers = result.inliers
        const inlierN = inliers.reduce((sum, a) => sum + a.length, 0)
        const share = target.candidateTotal > 0 ? (inlierN / target.candidateTotal) * 100 : 0
        inlierMap.set(result.entityId, inliers)
        planeMap.set(result.entityId, plane)
        inlierTotal += inlierN
        if (!mainPlane || inlierN > mainPlane.inlierCount) {
          mainPlane = plane
          mainEntityName = name
        }
        log(
          'RANSAC',
          `实体「${name}」：内点 ${inlierN.toLocaleString()} / 候选 ${target.candidateTotal.toLocaleString()}（${share.toFixed(
            2
          )}%），RMS ${plane.rms.toExponential(3)}，最大偏差 ${plane.maxDeviation.toExponential(3)}，采样 ${
            plane.sampleCount
          } 点，迭代 ${plane.iterationsUsed} 轮` +
            (plane.inlierCount !== inlierN ? `（回传内点数 ${plane.inlierCount}，与索引总数不一致）` : '')
        )
        pcs.setChunkVisibility(result.entityId, inliers)
        overlayItems.push({ quad: plane.quad, normal: { nx: plane.nx, ny: plane.ny, nz: plane.nz } })
      }

      if (inlierMap.size === 0) {
        // 一块平面都没找到：不置 previewed（「确定」不可用），把平面片收掉
        restoreOverlayOnly()
        state.stats = {
          inlierTotal: 0,
          candidateTotal,
          planesFound: 0,
          entitiesTotal: targets.length,
          rms: null,
          maxDeviation: null,
          sampleCount: 0,
          iterationsUsed: 0,
        }
        log('RANSAC', '未找到平面：请调大距离阈值或迭代次数；若平面占比很低，先框选局部再拟合')
        return
      }

      previewInliers = inlierMap
      previewPlanes = planeMap
      showPlanes(overlayItems)
      state.stats = {
        inlierTotal,
        candidateTotal,
        planesFound: planeMap.size,
        entitiesTotal: targets.length,
        rms: mainPlane ? mainPlane.rms : null,
        maxDeviation: mainPlane ? mainPlane.maxDeviation : null,
        sampleCount: mainPlane ? mainPlane.sampleCount : 0,
        iterationsUsed: mainPlane ? mainPlane.iterationsUsed : 0,
      }
      state.previewed = true
      if (planeMap.size > 1) {
        log('RANSAC', `工具栏显示的平面度取自内点最多的「${mainEntityName}」；逐实体明细见上方日志`)
      }
    } catch (err) {
      console.error('RANSAC 平面拟合预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('RANSAC', `预览失败：${message}`)
    } finally {
      // 仅当仍处于平面拟合模式时复位（退出后由 exitRansacPlane 复位；防迟到结果覆盖新模式的标志位）
      if (state.active) state.computing = false
    }
  }

  /** 只收平面片（不改索引渲染）——预览失败路径用。 */
  function restoreOverlayOnly() {
    if (!overlay) return
    overlay.hide()
    useViewerStore().getViewer()?.requestRender()
  }

  /**
   * 确定提取：校验内点/其余两侧非空（阻止产出空点云）→ 逐实体按预览结果拆分
   * `<name>.plane` / `<name>.remaining`（原实体删除）→ **自动选中第一个 .remaining**
   * → 退出模式。
   *
   * 自动选中 `.remaining` 而非 `.plane` 是本功能的主线：剥掉一个平面后，剩下的那堆
   * 就是下一次拟合的输入——用户接着点按钮即可连剥第二个平面，不必回树里手动挑。
   */
  function applyExtract() {
    if (!state.active || state.computing || !state.previewed) return
    if (!previewInliers || !previewPlanes) return
    if (previewPlanes.size === 0) return

    for (const t of targets) {
      const plane = previewPlanes.get(t.entityId)
      if (!plane) continue // 该实体本就没找到平面，保持原样不动
      const inlierArr = previewInliers.get(t.entityId)!
      const inlierN = inlierArr.reduce((sum, a) => sum + a.length, 0)
      const restN = t.candidateTotal - inlierN
      if (restN === 0) {
        log('RANSAC', '全部点都在平面上（没有要剩下的点），请调小距离阈值后重新预览')
        return
      }
      if (inlierN === 0) {
        log('RANSAC', '平面内点为空，请调大距离阈值后重新预览')
        return
      }
    }

    const pcs = usePointCloudStore()
    let firstRemainingId: number | null = null
    let planeCount = 0
    for (const t of targets) {
      const plane = previewPlanes.get(t.entityId)
      if (!plane) continue
      const inlierArr = previewInliers.get(t.entityId)!
      // C++ inliers → 其余点补集 + 两侧包围盒（显示坐标），组装成 splitEntity 的选区输入
      const selections: ChunkSelection[] = t.sources.map((src, c) => {
        const kept = inlierArr[c]
        const { removed, keptBBox, removedBBox } = splitKeptRemoved(src.positions, src.index, kept)
        return { inside: kept, outside: removed, insideBBox: keptBBox, outsideBBox: removedBBox }
      })
      const result = pcs.splitEntity(t.entityId, selections, { first: '.plane', second: '.remaining' })
      if (result) {
        planeCount++
        if (firstRemainingId === null) firstRemainingId = result.secondId
      }
    }
    if (firstRemainingId !== null) {
      selectNode({ type: 'entity', id: firstRemainingId })
    }
    exitRansacPlane(true)
    log('RANSAC', `已提取 ${planeCount} 个平面，产出 <名称>.plane / <名称>.remaining；已选中 remaining 以便连续剥离`)
  }

  /**
   * 退出平面拟合模式（确定 / 取消 / 再次点击按钮共用）。
   * @param completed true = 确定（applyExtract 内部调用，实体已拆分无需还原）；
   *   false = 取消（还原全部已预览目标的索引渲染并收掉平面片）。
   */
  function exitRansacPlane(completed: boolean) {
    if (!state.active) return
    if (!completed) {
      restorePreview()
    } else {
      restoreOverlayOnly() // 平面片总要收；索引渲染随原实体一并消失，无需还原
    }
    const ids = state.targetEntityIds.slice()
    state.active = false
    state.computing = false
    state.previewed = false
    state.stats = null
    state.distanceThreshold = 0
    state.maxIterations = 1000
    state.optimizeCoefficients = true
    state.targetEntityIds = []
    targets = []
    previewInliers = null
    previewPlanes = null
    // 解除预览期强制可见，按当前树状态重新同步（已拆分的原实体无记录，幂等）
    usePointCloudStore().endSegmentPreview(ids)
    // 确定性日志（不加完成/取消前缀：applyExtract 自己会报产出，这里报的是模式退出）
    if (!completed) log('RANSAC', '已取消平面拟合，点云已还原')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    distanceThreshold: computed(() => state.distanceThreshold),
    maxIterations: computed(() => state.maxIterations),
    optimizeCoefficients: computed(() => state.optimizeCoefficients),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    startRansacPlane,
    setParams,
    runPreview,
    applyExtract,
    exitRansacPlane,
  }
}
