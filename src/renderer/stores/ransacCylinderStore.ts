import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import type { EntityBBox } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { useViewerStore } from './viewerStore'
import { loadNativeModule } from '../utils/nativeLoader'
import { candidateCountOfChunk, splitKeptRemoved } from '../utils/radiusFilter'
import { CYLINDER_MIN_NORMAL_COVERAGE, estimateCylinderDefaults } from '../utils/ransacCylinder'
import type {
  RansacCylinderAddon,
  RansacCylinderAxis,
  RansacCylinderChunkSource,
  RansacCylinderEntityResult,
  RansacCylinderModel,
  RansacCylinderRequest,
} from '../utils/ransacCylinder'
import { createCylinderOverlay } from '../three/cylinderOverlay'
import type { CylinderOverlay, CylinderOverlayItem } from '../three/cylinderOverlay'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * RANSAC 圆柱拟合模式状态（模块级单例）。
 *
 * 与 ransacPlaneStore 逐条同构的**预览型**模态工具流：进入后 3D 视图角上浮出
 * RansacCylinderToolBar，点「预览」触发 C++ 计算（native/ransac-cylinder，零拷贝贴渲染缓冲），
 * 画面上只留圆柱内点 + 3D 里浮出圆柱线框与轴方向箭头，确认后拆分为
 * `<name>.cylinder` / `<name>.remaining` 并**自动选中后者**（剥一个再剥一个）。
 *
 * 与平面拟合的关键差异——**轴方向这一自由度**：
 * 平面没有轴，圆柱有，而自由给定的方向几乎总是错的，故这个自由度必须由别处提供。
 * 这里给两条路（`axisMode`）：
 * - `normals`（默认）：**用实体上已有的法向量自动估计**（对齐 PCL `SACSegmentationFromNormals`：
 *   法线 ⊥ 轴 ⇒ 成对法线叉积投票定轴，再看一致法线的各向异性比排除平面主导的假轴）。
 *   法线来自 `Edit ▸ Normals ▸ Compute normals` 的产物（`normalCode` 属性，2 字节量化码），
 *   由 pointcloudStore.getNormalCodeChunks 零拷贝取出。原理见 utils/ransacCylinder.ts 与
 *   native/ransac-cylinder/README-REF.md。预览后工具栏显示估出来的方向向量与得分供核对。
 *   **该模式要求点云已算法线**：没算过就禁用「预览」并给出指引（软堵，不是硬报错）。
 * - `vertical` / `horizontalX` / `custom`：用户直接给方向（竖直 Z、水平 X、任意向量），
 *   native 侧**只当归一化 + 统一符号，不做任何重估**——这是约束，不是初值。这三条路**不需要法线**。
 *
 * 已知局限（UI 要引导，别让用户当成 bug）：均匀采样 RANSAC 找不出占比过低的圆柱（采样集
 * 65536 点，占比 0.1% 的圆柱三点全落上的概率可忽略，PCL 同样如此）；法线估轴的场合还多一层
 * ——**法线里几乎没有圆柱面时得分必然贴着闸门**，此时回包判未找到。缓解：先框选局部再拟合、
 * 先剥掉占比大的结构，或直接切到竖直/自定义轴。详见 native/ransac-cylinder/README-REF.md。
 *
 * 刻意不进 reactive 的数据（沿袭 segmentStore/filterStore 模式）：目标 sources（持有
 * TypedArray 引用）、预览内点（Uint32Array 被深度代理会拖慢渲染）、线框覆盖层实例。
 */

/** 轴方向的来源（工具栏那一行下拉）。 */
export type CylinderAxisMode = 'normals' | 'vertical' | 'horizontalX' | 'custom'

/** 预览统计（纯数字，可进 reactive）。 */
export interface RansacCylinderStats {
  /** 全部目标实体内点数合计。 */
  inlierTotal: number
  /** 全部目标实体候选点数合计。 */
  candidateTotal: number
  /** 成功拟合出圆柱的实体数 / 目标实体总数。 */
  cylindersFound: number
  entitiesTotal: number
  /**
   * 「主要圆柱」（内点最多的那个）的几何与圆柱度指标；一个都没拟合出来时为 null。
   * 多目标时工具栏只显示主要圆柱的一组数字，逐实体的明细在 Console 日志里。
   */
  radius: number | null
  halfHeight: number | null
  rms: number | null
  maxDeviation: number | null
  /** 采样集点数（诊断：判断小圆柱是否可能被采样漏掉）。 */
  sampleCount: number
  /** 假设循环实际执行的轮数（自适应早停生效时小于最大迭代次数）。 */
  iterationsUsed: number
  /** 轴方向是否由 native 从法线自动估计。 */
  axisEstimated: boolean
  /**
   * 「主要圆柱」的轴候选得分（见 RansacCylinderModel.axisScore）；未找到 / 显式轴时为 null。
   * 平面主导的点云里它会贴着闸门（0.02）走——工具栏据此提示"轴可能是凑的"。
   */
  axisScore: number | null
  /** 主要圆柱的单位轴方向（用法线估计时供工具栏显示估出来的向量）。 */
  axis: RansacCylinderAxis | null
}

/**
 * 进入模式时快照的拟合目标（sources 零拷贝引用渲染缓冲）。
 *
 * sources 每块的 `normals` 在进入模式时就**一并挂上**（法线量化码，同样是零拷贝属性视图）：
 * 「用实体法向量」模式依赖它，而 axisMode 进入后还能随手改（竖直/自定义改回法线估计），
 * 届时若现取就又要一次跨 store 快照 —— 挂一次即可，显式轴模式下 native 直接忽略它。
 */
interface RansacTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集，见 pointcloudStore）。 */
  sources: RansacCylinderChunkSource[]
  /** 候选点总数（= 该实体可见点数，拆分校验用）。 */
  candidateTotal: number
}

const state = reactive({
  /** 是否处于圆柱拟合模式。 */
  active: false,
  /** 进入模式时快照的目标实体 id（场景树选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 距离阈值：|点到轴的垂距 − 半径| ≤ 它判内点（与点云坐标同单位；进入模式按平均点距 ×2 估算）。 */
  distanceThreshold: 0,
  /** 假设循环最大轮数（自适应早停会提前结束）。 */
  maxIterations: 1000,
  /** 是否对最优内点集做精修（对齐 PCL setOptimizeCoefficients）。 */
  optimizeCoefficients: true,
  /** 半径下限（文章的 RadiusLimits）；0 = 不限制。 */
  minRadius: 0,
  /** 半径上限；0 = 不限制。 */
  maxRadius: 0,
  /** 轴方向来源。 */
  axisMode: 'normals' as CylinderAxisMode,
  /**
   * 「用实体法向量」模式的前置条件是否满足（进入模式时按各目标**最差**的那个算）：
   * 覆盖率达到 CYLINDER_MIN_NORMAL_COVERAGE 且各块都拿得到 normalCode。不满足时预览禁用 + 提示。
   */
  normalsReady: false,
  /** 各目标法线覆盖率（computed / 候选总数）的最小值 ∈ [0, 1]，供提示行报告实情。 */
  normalsCoverage: 0,
  /** 自定义轴方向三分量（仅 axisMode === 'custom' 时使用；显示坐标空间，无需归一化）。 */
  axisX: 0,
  axisY: 0,
  axisZ: 1,
  /** 预览计算中（native 计算异步；期间禁用参数输入与按钮）。 */
  computing: false,
  /** 预览结果是否由**当前参数**生成；参数改动置 false（须重新预览后「确定」才可用）。 */
  previewed: false,
  /** 最近一次预览的统计，供工具栏结果行显示。 */
  stats: null as RansacCylinderStats | null,
})

/** 目标快照与最近一次预览结果（TypedArray 不进 reactive，沿袭 segmentStore 的缓存模式）。 */
let targets: RansacTarget[] = []
let previewInliers: Map<number, Uint32Array[]> | null = null
let previewCylinders: Map<number, RansacCylinderModel> | null = null
/** 目标合计包围盒的对角线长（进入模式时快照）：判"半径大得离谱"的量纲基准。 */
let targetDiagonal = 0
/** 圆柱线框覆盖层（懒创建；退出只 hide 不 dispose——下次进模式复用同一实例）。 */
let overlay: CylinderOverlay | null = null

/** 距离阈值/半径日志展示（去掉浮点尾噪）。 */
function formatNumber(v: number): number {
  return Number.isInteger(v) ? v : parseFloat(v.toFixed(6))
}

/** 惰性建覆盖层（3D 视图未挂载时返回 null，预览仍可算，只是不画线框）。 */
function ensureOverlay(): CylinderOverlay | null {
  const viewer = useViewerStore().getViewer()
  if (!viewer) return null
  if (!overlay) overlay = createCylinderOverlay(viewer.scene)
  return overlay
}

/** 画圆柱线框（顺带置脏；three 无变更通知，直写场景必须自己 requestRender）。 */
function showCylinders(items: CylinderOverlayItem[]): void {
  const instance = ensureOverlay()
  if (!instance) return
  if (items.length > 0) instance.show(items)
  else instance.hide()
  useViewerStore().getViewer()?.requestRender()
}

/** 轴方向来源 → native 入参（null = 由各块 normals 自动估计）。 */
function resolveAxis(): RansacCylinderAxis | null {
  switch (state.axisMode) {
    case 'normals':
      return null
    case 'vertical':
      return { x: 0, y: 0, z: 1 }
    case 'horizontalX':
      return { x: 1, y: 0, z: 0 }
    case 'custom':
      return { x: state.axisX, y: state.axisY, z: state.axisZ }
  }
}

/** 轴方向模式的日志文案。 */
function axisModeLabel(mode: CylinderAxisMode): string {
  switch (mode) {
    case 'normals':
      return '用实体法向量'
    case 'vertical':
      return '竖直 (0, 0, 1)'
    case 'horizontalX':
      return '水平 X 向 (1, 0, 0)'
    case 'custom':
      return `自定义 (${formatNumber(state.axisX)}, ${formatNumber(state.axisY)}, ${formatNumber(state.axisZ)})`
  }
}

export function useRansacCylinderStore() {
  const { selectedNode, selectNode } = useSceneStore()
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /** 还原全部已预览目标的索引渲染、并收掉线框（退出/取消时用；无预览时幂等）。 */
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
    previewCylinders = null
    state.previewed = false
    state.stats = null
  }

  /**
   * 从工具栏进入圆柱拟合模式：解析当前选中节点为目标实体快照。
   * 与分割/滤波/平面拟合同款目标语义：项目 = 全部子实体；实体 = 仅它自己。
   * 目标全部未加载完成时提示并拒绝进入（无渲染缓冲无法贴数据计算）。
   */
  function startRansacCylinder() {
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
      // 显式标注为目标侧类型：getFilterSourceChunks 声明的是半径滤波源（无 normals 字段），
      // 而本模块的契约里 normals 是可选的——下一行就地补上，不复制大数组
      const sources: RansacCylinderChunkSource[] | null = pcs.getFilterSourceChunks(id)
      if (!sources) continue
      const candidateTotal = sources.reduce((s, c) => s + candidateCountOfChunk(c), 0)
      if (candidateTotal === 0) continue
      // 法线量化码（零拷贝属性视图）与 sources 同批快照；该块没有 normalCode 属性时该项为 null
      const codes = pcs.getNormalCodeChunks(id)
      for (let c = 0; c < sources.length; c++) sources[c].normals = codes ? codes[c] : null
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
      log('RANSAC', '选中的点云尚未加载完成，无法拟合圆柱')
      return
    }
    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    // 「用实体法向量」的前置条件：**进入时算一次就够**——模式激活期间要新算法线必须先退出本模式
    // （Edit ▸ Normals 打开前会 exitOtherModals），故不会有"进来之后法线才变多"的情况。
    // 覆盖率取各目标最小值（一个目标没法线就整体挡下：多目标是同一次拟合，不该半个有半个没有）。
    let coverage = 1
    let normalsUsable = true
    for (const t of resolved) {
      const ns = pcs.getNormalStats(t.entityId)
      if (!ns || ns.total === 0) {
        coverage = 0
        normalsUsable = false
        break
      }
      coverage = Math.min(coverage, ns.computed / ns.total)
      if (t.sources.some((s) => !s.normals)) normalsUsable = false // 防御：属性缺块（正常不会发生）
    }
    state.normalsCoverage = coverage
    state.normalsReady = normalsUsable && coverage >= CYLINDER_MIN_NORMAL_COVERAGE
    // 初始参数 = 平均点距 ×2（与平面拟合 / 半径滤波 / CSF 分类阈值同一套量级依据）；
    // 半径上下限留 0 = 不限制（猜一个只会把假设全滤掉）
    const defaults = bbox
      ? estimateCylinderDefaults(count, {
          x: bbox.maxX - bbox.minX,
          y: bbox.maxY - bbox.minY,
          z: bbox.maxZ - bbox.minZ,
        })
      : estimateCylinderDefaults(0, { x: 0, y: 0, z: 0 })
    targetDiagonal = bbox ? Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, bbox.maxZ - bbox.minZ) : 0
    state.distanceThreshold = defaults.distanceThreshold
    state.maxIterations = defaults.maxIterations
    state.optimizeCoefficients = defaults.optimizeCoefficients
    state.minRadius = defaults.minRadius
    state.maxRadius = defaults.maxRadius
    state.axisMode = 'normals'
    state.axisX = 0
    state.axisY = 0
    state.axisZ = 1
    state.active = true
    state.computing = false
    state.previewed = false
    state.stats = null
    log(
      'RANSAC',
      `进入圆柱拟合模式，目标 ${resolved.length} 块点云；初始参数：距离阈值 ${formatNumber(
        state.distanceThreshold
      )}（≈ 平均点距 ×2）/ 最大迭代 ${state.maxIterations} / 系数优化 ${
        state.optimizeCoefficients ? '开' : '关'
      } / 半径不限 / 轴方向 ${axisModeLabel(state.axisMode)}` +
        (state.axisMode === 'normals'
          ? `（法线覆盖 ${(state.normalsCoverage * 100).toFixed(0)}%${
              state.normalsReady ? '' : '，不足以估轴 ⇒ 预览已禁用'
            }）`
          : '')
    )
  }

  /**
   * 更新拟合参数（RansacCylinderToolBar 输入事件调用）。
   * 参数改动**不影响当前显示**：已有的预览原样保留（供对照旧效果微调参数），
   * 也不触发重算；仅将 previewed 置 false——「确定」必须等下一次「预览」按当前参数
   * 重新生成结果后才能用（防止用旧参数的结果去拆分）。
   */
  function setParams(
    distanceThreshold: number,
    maxIterations: number,
    optimizeCoefficients: boolean,
    minRadius: number,
    maxRadius: number
  ) {
    if (!state.active || state.computing) return
    const dt = Number.isFinite(distanceThreshold) ? Math.max(distanceThreshold, 0) : state.distanceThreshold
    const mi = Number.isFinite(maxIterations) ? Math.max(0, Math.round(maxIterations)) : state.maxIterations
    // 半径：非有限值或 ≤ 0 一律归 0（= 不限制，与 C++ 侧的语义一致）
    const mn = Number.isFinite(minRadius) && minRadius > 0 ? minRadius : 0
    const mx = Number.isFinite(maxRadius) && maxRadius > 0 ? maxRadius : 0
    if (
      dt === state.distanceThreshold &&
      mi === state.maxIterations &&
      optimizeCoefficients === state.optimizeCoefficients &&
      mn === state.minRadius &&
      mx === state.maxRadius
    ) {
      return
    }
    state.distanceThreshold = dt
    state.maxIterations = mi
    state.optimizeCoefficients = optimizeCoefficients
    state.minRadius = mn
    state.maxRadius = mx
    state.previewed = false
  }

  /** 切换轴方向来源（下拉框）。改动同样只置 previewed = false，不触发重算。 */
  function setAxisMode(mode: CylinderAxisMode) {
    if (!state.active || state.computing) return
    if (mode === state.axisMode) return
    state.axisMode = mode
    state.previewed = false
  }

  /** 更新自定义轴方向（仅在 axisMode === 'custom' 时有意义；零向量由 runPreview 拦下）。 */
  function setCustomAxis(x: number, y: number, z: number) {
    if (!state.active || state.computing) return
    const nx = Number.isFinite(x) ? x : state.axisX
    const ny = Number.isFinite(y) ? y : state.axisY
    const nz = Number.isFinite(z) ? z : state.axisZ
    if (nx === state.axisX && ny === state.axisY && nz === state.axisZ) return
    state.axisX = nx
    state.axisY = ny
    state.axisZ = nz
    state.previewed = false
  }

  /**
   * 手动触发预览：native 计算（异步，uv 线程池 + 内部硬件线程并行）→ 逐实体
   * setChunkVisibility 只留圆柱内点，并在 3D 里画出圆柱线框与轴方向箭头。
   * 每次都按**原始数据 + 当前参数**重算，新结果整体替换旧预览（setIndex 整体换索引即可，
   * 无需先还原，避免闪烁）。预览期强制目标可见（防树勾选把云藏掉），不锁相机。
   *
   * 未拟合出圆柱的实体**保持原样可见**（不隐藏）：让用户直接看到"这块没找到圆柱"，
   * 比整片变空更好判断该调哪个参数。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    if (targets.length === 0) return
    const axis = resolveAxis()
    // 「用实体法向量」但没算法线：按钮侧已禁用，这里是纵深防御（native 侧同样会同步抛 TypeError）。
    // 与下面零向量那条同款处理：提前说清原因，避免"点了预览却什么都没有"。
    if (!axis && !state.normalsReady) {
      log(
        'RANSAC',
        '该点云没有可用的法向量，无法估计轴方向：先 Edit ▸ Normals ▸ Compute normals 计算（可先用 Auto 估半径），或把轴方向改成竖直 Z / 水平 X / 自定义'
      )
      return
    }
    // 自定义轴给了零向量：native 会判未找到，这里提前拦下并说清原因（避免"预览了但什么都没有"）
    if (axis && axis.x === 0 && axis.y === 0 && axis.z === 0) {
      log('RANSAC', '自定义轴方向是零向量，无法定义轴；请填入一个非零方向（如 0, 0, 1）')
      return
    }
    state.computing = true
    try {
      const addon = await loadNativeModule<RansacCylinderAddon>('ransac_cylinder')
      const request: RansacCylinderRequest = {
        distanceThreshold: state.distanceThreshold,
        maxIterations: state.maxIterations,
        optimizeCoefficients: state.optimizeCoefficients,
        minRadius: state.minRadius,
        maxRadius: state.maxRadius,
        axis,
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const results = await new Promise<RansacCylinderEntityResult[]>((resolve, reject) => {
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
      const cylinderMap = new Map<number, RansacCylinderModel>()
      const overlayItems: CylinderOverlayItem[] = []
      let inlierTotal = 0
      let candidateTotal = 0
      let mainCylinder: RansacCylinderModel | null = null
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
        if (!result.cylinder) {
          log('RANSAC', `实体「${name}」未找到圆柱（请调大距离阈值 / 调大迭代次数 / 放宽半径范围，或先框选局部）`)
          continue
        }
        const cylinder = result.cylinder
        const inliers = result.inliers
        const inlierN = inliers.reduce((sum, a) => sum + a.length, 0)
        const share = target.candidateTotal > 0 ? (inlierN / target.candidateTotal) * 100 : 0
        inlierMap.set(result.entityId, inliers)
        cylinderMap.set(result.entityId, cylinder)
        inlierTotal += inlierN
        if (!mainCylinder || inlierN > mainCylinder.inlierCount) {
          mainCylinder = cylinder
          mainEntityName = name
        }
        log(
          'RANSAC',
          `实体「${name}」：内点 ${inlierN.toLocaleString()} / 候选 ${target.candidateTotal.toLocaleString()}（${share.toFixed(
            2
          )}%），半径 ${formatNumber(cylinder.radius)}，半高 ${formatNumber(cylinder.halfHeight)}，轴 ${[
            cylinder.ax,
            cylinder.ay,
            cylinder.az,
          ]
            .map((v) => v.toFixed(4))
            .join(', ')}（${
            cylinder.axisEstimated ? `法线估计/轴得分 ${cylinder.axisScore.toFixed(4)}` : '按输入（约束）'
          }），RMS ${cylinder.rms.toExponential(3)}，最大偏差 ${cylinder.maxDeviation.toExponential(
            3
          )}，采样 ${cylinder.sampleCount} 点，迭代 ${cylinder.iterationsUsed} 轮` +
            (cylinder.inlierCount !== inlierN ? `（回传内点数 ${cylinder.inlierCount}，与索引总数不一致）` : '')
        )
        pcs.setChunkVisibility(result.entityId, inliers)
        overlayItems.push({
          center: { cx: cylinder.cx, cy: cylinder.cy, cz: cylinder.cz },
          axis: { ax: cylinder.ax, ay: cylinder.ay, az: cylinder.az },
          radius: cylinder.radius,
          halfHeight: cylinder.halfHeight,
          basis: cylinder.basis,
        })
      }

      if (inlierMap.size === 0) {
        // 一个圆柱都没找到：不置 previewed（「确定」不可用），把线框收掉
        restoreOverlayOnly()
        state.stats = {
          inlierTotal: 0,
          candidateTotal,
          cylindersFound: 0,
          entitiesTotal: targets.length,
          radius: null,
          halfHeight: null,
          rms: null,
          maxDeviation: null,
          sampleCount: 0,
          iterationsUsed: 0,
          axisEstimated: state.axisMode === 'normals',
          axisScore: null,
          axis: null,
        }
        log(
          'RANSAC',
          '未找到圆柱：请调大距离阈值或迭代次数、放宽半径范围；用法线估轴时若圆柱占比很低，投票可能抽不到成对法线' +
            '（轴得分会贴着闸门），建议先框选局部再拟合，或直接把轴方向改成竖直/自定义'
        )
        return
      }

      previewInliers = inlierMap
      previewCylinders = cylinderMap
      showCylinders(overlayItems)
      state.stats = {
        inlierTotal,
        candidateTotal,
        cylindersFound: cylinderMap.size,
        entitiesTotal: targets.length,
        radius: mainCylinder ? mainCylinder.radius : null,
        halfHeight: mainCylinder ? mainCylinder.halfHeight : null,
        rms: mainCylinder ? mainCylinder.rms : null,
        maxDeviation: mainCylinder ? mainCylinder.maxDeviation : null,
        sampleCount: mainCylinder ? mainCylinder.sampleCount : 0,
        iterationsUsed: mainCylinder ? mainCylinder.iterationsUsed : 0,
        axisEstimated: mainCylinder ? mainCylinder.axisEstimated : false,
        axisScore: mainCylinder && mainCylinder.axisEstimated ? mainCylinder.axisScore : null,
        axis: mainCylinder ? { x: mainCylinder.ax, y: mainCylinder.ay, z: mainCylinder.az } : null,
      }
      state.previewed = true
      if (cylinderMap.size > 1) {
        log('RANSAC', `工具栏显示的半径/圆柱度取自内点最多的「${mainEntityName}」；逐实体明细见上方日志`)
      }
      if (mainCylinder?.axisEstimated) {
        // 法线估轴的关键信息：估出来的方向就是这次拟合的"轴"、得分说明这个轴有多可信
        // （平面主导的点云里得分贴着闸门 0.02 —— 那是"碰巧凑的"信号，用户要能看出来）
        log(
          'RANSAC',
          `由法线估计的轴方向：(${mainCylinder.ax.toFixed(4)}, ${mainCylinder.ay.toFixed(
            4
          )}, ${mainCylinder.az.toFixed(4)})，轴得分 ${mainCylinder.axisScore.toFixed(4)}，半径 ${formatNumber(
            mainCylinder.radius
          )}`
        )
        if (mainCylinder.axisScore < 0.1) {
          log(
            'RANSAC',
            '轴得分偏低：点云里圆柱面占比不大，轴方向可能是勉强选出来的；建议先框选局部再拟合，或改用手动轴方向'
          )
        }
      }
      // 半径量级自检：轴一旦与一片主导平面平行，那片平面就落在"R → ∞ 的圆柱"的切平面上，
      // 按内点数它会合法胜出（实测水平地面 + 细管：R 上千、吞掉全部地面点；轴方向还是对的）。
      // 半径超过包围盒对角线 ⇒ 这个"圆柱"在点云尺度上已经是个平面了，提醒用户设半径上限。
      if (mainCylinder && targetDiagonal > 0 && mainCylinder.radius > targetDiagonal) {
        log(
          'RANSAC',
          `半径 ${formatNumber(mainCylinder.radius)} 超过点云包围盒对角线（${formatNumber(
            targetDiagonal
          )}）：多半是把一片平面拟成了超大半径圆柱，请设置"半径上限"后重新预览`
        )
      }
      if (state.axisMode === 'normals' && state.normalsCoverage < 0.9) {
        log(
          'RANSAC',
          `法线覆盖率只有 ${(state.normalsCoverage * 100).toFixed(0)}%：未覆盖的点不参与轴投票（不影响判内点），` +
            '若轴方向明显不对，可在 Edit ▸ Normals 里调小半径重算一遍法线'
        )
      }
    } catch (err) {
      console.error('RANSAC 圆柱拟合预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('RANSAC', `预览失败：${message}`)
    } finally {
      // 仅当仍处于圆柱拟合模式时复位（退出后由 exitRansacCylinder 复位；防迟到结果覆盖新模式的标志位）
      if (state.active) state.computing = false
    }
  }

  /** 只收线框（不改索引渲染）——预览失败路径用。 */
  function restoreOverlayOnly() {
    if (!overlay) return
    overlay.hide()
    useViewerStore().getViewer()?.requestRender()
  }

  /**
   * 确定提取：校验内点/其余两侧非空（阻止产出空点云）→ 逐实体按预览结果拆分
   * `<name>.cylinder` / `<name>.remaining`（原实体删除）→ **自动选中第一个 .remaining**
   * → 退出模式。
   *
   * 自动选中 `.remaining` 而非 `.cylinder`：剥掉一根圆柱（管道/杆件/树干）后，剩下的那堆
   * 就是下一次拟合的输入——用户接着点按钮即可连续剥离，不必回树里手动挑。
   */
  function applyExtract() {
    if (!state.active || state.computing || !state.previewed) return
    if (!previewInliers || !previewCylinders) return
    if (previewCylinders.size === 0) return

    for (const t of targets) {
      const cylinder = previewCylinders.get(t.entityId)
      if (!cylinder) continue // 该实体本就没找到圆柱，保持原样不动
      const inlierArr = previewInliers.get(t.entityId)!
      const inlierN = inlierArr.reduce((sum, a) => sum + a.length, 0)
      const restN = t.candidateTotal - inlierN
      if (restN === 0) {
        log('RANSAC', '全部点都在圆柱面上（没有要剩下的点），请调小距离阈值后重新预览')
        return
      }
      if (inlierN === 0) {
        log('RANSAC', '圆柱内点为空，请调大距离阈值后重新预览')
        return
      }
    }

    const pcs = usePointCloudStore()
    let firstRemainingId: number | null = null
    let cylinderCount = 0
    for (const t of targets) {
      const cylinder = previewCylinders.get(t.entityId)
      if (!cylinder) continue
      const inlierArr = previewInliers.get(t.entityId)!
      // C++ inliers → 其余点补集 + 两侧包围盒（显示坐标），组装成 splitEntity 的选区输入
      const selections: ChunkSelection[] = t.sources.map((src, c) => {
        const kept = inlierArr[c]
        const { removed, keptBBox, removedBBox } = splitKeptRemoved(src.positions, src.index, kept)
        return { inside: kept, outside: removed, insideBBox: keptBBox, outsideBBox: removedBBox }
      })
      const result = pcs.splitEntity(t.entityId, selections, { first: '.cylinder', second: '.remaining' })
      if (result) {
        cylinderCount++
        if (firstRemainingId === null) firstRemainingId = result.secondId
      }
    }
    if (firstRemainingId !== null) {
      selectNode({ type: 'entity', id: firstRemainingId })
    }
    exitRansacCylinder(true)
    log(
      'RANSAC',
      `已提取 ${cylinderCount} 个圆柱，产出 <名称>.cylinder / <名称>.remaining；已选中 remaining 以便连续剥离`
    )
  }

  /**
   * 退出圆柱拟合模式（确定 / 取消 / 再次点击按钮共用）。
   * @param completed true = 确定（applyExtract 内部调用，实体已拆分无需还原）；
   *   false = 取消（还原全部已预览目标的索引渲染并收掉线框）。
   */
  function exitRansacCylinder(completed: boolean) {
    if (!state.active) return
    if (!completed) {
      restorePreview()
    } else {
      restoreOverlayOnly() // 线框总要收；索引渲染随原实体一并消失，无需还原
    }
    const ids = state.targetEntityIds.slice()
    state.active = false
    state.computing = false
    state.previewed = false
    state.stats = null
    state.distanceThreshold = 0
    state.maxIterations = 1000
    state.optimizeCoefficients = true
    state.minRadius = 0
    state.maxRadius = 0
    state.axisMode = 'normals'
    state.normalsReady = false
    state.normalsCoverage = 0
    state.axisX = 0
    state.axisY = 0
    state.axisZ = 1
    state.targetEntityIds = []
    targets = []
    previewInliers = null
    previewCylinders = null
    // 解除预览期强制可见，按当前树状态重新同步（已拆分的原实体无记录，幂等）
    usePointCloudStore().endSegmentPreview(ids)
    // 确定性日志（不加完成/取消前缀：applyExtract 自己会报产出，这里报的是模式退出）
    if (!completed) log('RANSAC', '已取消圆柱拟合，点云已还原')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    distanceThreshold: computed(() => state.distanceThreshold),
    maxIterations: computed(() => state.maxIterations),
    optimizeCoefficients: computed(() => state.optimizeCoefficients),
    minRadius: computed(() => state.minRadius),
    maxRadius: computed(() => state.maxRadius),
    axisMode: computed(() => state.axisMode),
    normalsReady: computed(() => state.normalsReady),
    normalsCoverage: computed(() => state.normalsCoverage),
    axisX: computed(() => state.axisX),
    axisY: computed(() => state.axisY),
    axisZ: computed(() => state.axisZ),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    startRansacCylinder,
    setParams,
    setAxisMode,
    setCustomAxis,
    runPreview,
    applyExtract,
    exitRansacCylinder,
  }
}
