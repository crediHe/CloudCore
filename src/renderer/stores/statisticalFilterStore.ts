import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { loadNativeModule } from '../utils/nativeLoader'
import { candidateCountOfChunk, splitKeptRemoved } from '../utils/radiusFilter'
import type {
  SorFilterAddon,
  SorFilterChunkSource,
  SorFilterEntityResult,
  SorFilterRequest,
} from '../utils/statisticalFilter'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * 统计滤波（Statistical Outlier Removal）模式状态（模块级单例）。
 *
 * 与半径滤波（filterStore）同构的模态工具流：从右侧工具栏进入滤波模式后，3D 视图
 * 右上角浮出 StatisticalFilterToolBar。与分割的关键区别：
 * - 无绘制交互（参数即交互）：输入最近邻个数 K / 标准差倍数 λ，**手动点「预览」**
 *   触发 C++ 计算（native/statistical-filter，node-addon 零拷贝贴渲染缓冲），预览只
 *   显示保留点；预览期相机不锁，可自由旋转确认。
 * - 确定后原实体拆成 `<name>.sor`（保留）与 `<name>.removed`（剔除）两块（splitEntity
 *   labels 参数化），原实体删除，自动选中 .sor。
 *
 * 语义与半径滤波的互补定位：半径滤波按"固定半径内邻居数"判孤立（阈值是绝对尺度）；
 * 本滤波按"邻居距离的全局统计分布"判离群——每点取其 K 个最近邻的平均距离，与全体
 * 点距离均值 μ + λ × 标准差 σ 比较，超出即剔除（PCL StatisticalOutlierRemoval）。
 * 阈值随点云自身密度自适应，无绝对半径参数；采集密度不均匀的点云（半径滤波会把
 * 稀疏但有效的区域误杀）建议先做本滤波粗去噪、自动选中 .sor 后继续半径滤波精处理。
 *
 * 状态被 SideToolBar（按钮高亮/互斥禁用）、StatisticalFilterToolBar（显隐/输入/按钮
 * 状态）共享，因此不放在组件内部。
 *
 * 刻意不进 reactive 的数据（沿袭 segmentStore 模式）：目标 sources（持有 TypedArray
 * 引用）与预览结果 kept（Uint32Array 被深度代理会拖慢渲染）走模块级普通变量。
 */

/** 预览统计（纯数字，可进 reactive）。 */
export interface StatFilterStats {
  /** 全部目标实体保留点数合计。 */
  kept: number
  /** 全部目标实体剔除点数合计。 */
  removed: number
}

/** 进入模式时快照的滤波目标（sources 零拷贝引用渲染缓冲）。 */
interface StatFilterTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集，见 pointcloudStore）。 */
  sources: SorFilterChunkSource[]
  /** 候选点总数（= 该实体可见点数，剔除/保留校验用）。 */
  candidateTotal: number
}

const state = reactive({
  /** 是否处于统计滤波模式。 */
  active: false,
  /** 进入模式时快照的目标实体 id（场景树选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 最近邻个数 K（不含自身）；0 = 全部保留。默认 10（PCL 与文章推荐量级）。 */
  neighbors: 10,
  /** 标准差倍数 λ；判定阈值 = μ + λσ。默认 1.0（PCL 默认）。 */
  stddevMul: 1,
  /** 预览计算中（native 计算异步；期间禁用参数输入与按钮）。 */
  computing: false,
  /** 预览结果是否由**当前参数**生成；参数改动置 false（须重新预览后「确定」才可用）。 */
  previewed: false,
  /** 最近一次预览的统计（保留 / 剔除合计），供工具栏结果行显示。 */
  stats: null as StatFilterStats | null,
})

/** 目标快照与最近一次预览结果（Uint32Array 不进 reactive，沿袭 segmentStore 的缓存模式）。 */
let targets: StatFilterTarget[] = []
let previewKept: Map<number, Uint32Array[]> | null = null

export function useStatisticalFilterStore() {
  const { selectedNode, selectNode } = useSceneStore()
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /** 还原全部已预览目标的索引渲染（退出取消时用；无预览时幂等）。 */
  function restorePreview() {
    if (!previewKept) return
    const pcs = usePointCloudStore()
    for (const entityId of previewKept.keys()) {
      pcs.setChunkVisibility(entityId, null)
    }
    previewKept = null
    state.previewed = false
    state.stats = null
  }

  /**
   * 从工具栏进入统计滤波模式：解析当前选中节点为目标实体快照。
   * 与分割同款目标语义：项目 = 全部子实体；实体 = 仅它自己。
   * 目标全部未加载完成时提示并拒绝进入（无渲染缓冲无法贴数据计算）。
   * 统计滤波无绝对尺度参数（阈值随分布自适应），进入即用默认 K=10 / λ=1.0。
   */
  function startStatisticalFilter() {
    const node = selectedNode.value
    if (!node) return
    const candidates = node.type === 'project' ? node.entities.map((e) => e.id) : [node.id]
    const pcs = usePointCloudStore()
    const resolved: StatFilterTarget[] = []
    for (const id of candidates) {
      const entity = sceneStore.getAllEntities().find((e) => e.id === id)
      if (!entity || !entity.bbox || !entity.globalShift) continue // 未加载完成
      const sources = pcs.getFilterSourceChunks(id)
      if (!sources) continue
      const candidateTotal = sources.reduce((s, c) => s + candidateCountOfChunk(c), 0)
      if (candidateTotal === 0) continue
      resolved.push({ entityId: id, sources, candidateTotal })
    }
    if (resolved.length === 0) {
      log('Filter', '选中的点云尚未加载完成，无法滤波')
      return
    }
    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    state.neighbors = 10
    state.stddevMul = 1
    state.active = true
    state.computing = false
    state.previewed = false
    state.stats = null
    log(
      'Filter',
      `进入统计滤波模式，目标 ${resolved.length} 块点云；初始参数：邻居数 ${state.neighbors} / 标准差倍数 ${state.stddevMul}`
    )
  }

  /**
   * 更新滤波参数（StatisticalFilterToolBar 输入事件调用）。
   * 参数改动**不影响当前显示**：已有的预览原样保留（供对照旧效果微调参数），
   * 也不触发重算；仅将 previewed 置 false——「确定」必须等下一次「预览」按
   * 当前参数重新生成结果后才能用（防止用旧参数的结果去拆分）。
   */
  function setParams(neighbors: number, stddevMul: number) {
    if (!state.active || state.computing) return
    const k = Number.isFinite(neighbors) ? Math.max(0, Math.round(neighbors)) : state.neighbors
    const mul = Number.isFinite(stddevMul) ? Math.max(0, stddevMul) : state.stddevMul
    if (k === state.neighbors && mul === state.stddevMul) return
    state.neighbors = k
    state.stddevMul = mul
    state.previewed = false
  }

  /**
   * 手动触发预览：native 计算（异步，uv 线程池 + 内部硬件线程并行）→ 逐实体
   * setChunkVisibility 应用保留点。每次都按**原始数据 + 当前参数**重算，新结果
   * 整体替换旧预览（setIndex 整体换索引即可，无需先还原，避免闪烁）。
   * 预览期强制目标可见（防树勾选把云藏掉），不锁相机，可自由旋转确认剔除效果。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    if (targets.length === 0) return
    state.computing = true
    try {
      const addon = await loadNativeModule<SorFilterAddon>('statistical_filter')
      const request: SorFilterRequest = {
        neighbors: state.neighbors,
        stddevMul: state.stddevMul,
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const results = await new Promise<SorFilterEntityResult[]>((resolve, reject) => {
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
      const keptMap = new Map<number, Uint32Array[]>()
      let keptTotal = 0
      let removedTotal = 0
      for (const result of results) {
        const target = targets.find((t) => t.entityId === result.entityId)
        if (!target) continue
        const kept = result.kept
        if (kept.length !== target.sources.length) {
          // 契约防御：块数对不齐说明 native 输入解析与渲染侧不一致，跳过该实体
          log('Filter', `实体 ${result.entityId} 预览结果与块数不一致，已跳过`)
          continue
        }
        const keptN = kept.reduce((sum, a) => sum + a.length, 0)
        const removedN = target.candidateTotal - keptN
        keptMap.set(result.entityId, kept)
        keptTotal += keptN
        removedTotal += removedN
        const name = sceneStore.getAllEntities().find((e) => e.id === result.entityId)?.name ?? String(result.entityId)
        log('Filter', `实体「${name}」：保留 ${keptN.toLocaleString()}，剔除 ${removedN.toLocaleString()}`)
        pcs.setChunkVisibility(result.entityId, kept)
      }
      if (keptMap.size === 0) {
        throw new Error('预览结果为空（native 契约异常）')
      }
      previewKept = keptMap
      state.stats = { kept: keptTotal, removed: removedTotal }
      state.previewed = true
    } catch (err) {
      console.error('统计滤波预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('Filter', `预览失败：${message}`)
    } finally {
      // 仅当仍处于统计滤波模式时复位（退出后由 exitStatisticalFilter 复位；防迟到结果覆盖新模式的标志位）
      if (state.active) state.computing = false
    }
  }

  /**
   * 确定滤波：校验保留/剔除两侧非空（阻止产出空点云）→ 逐实体按预览结果拆分
   * `.sor` / `.removed`（原实体删除）→ 自动选中第一个 .sor → 退出模式。
   * .sor 后缀区别于半径滤波的 .filtered：链式处理（先统计滤波再半径滤波）时
   * 下一刀的产物是 `<name>.sor.filtered`，两侧命名不重不漏。
   */
  function applyFilter() {
    if (!state.active || state.computing || !state.previewed) return
    if (!previewKept) return
    for (const t of targets) {
      const keptArr = previewKept.get(t.entityId)
      if (!keptArr) {
        log('Filter', `实体 ${t.entityId} 缺少预览结果，无法确定（请重新预览）`)
        return
      }
      const keptN = keptArr.reduce((sum, a) => sum + a.length, 0)
      const removedN = t.candidateTotal - keptN
      if (removedN === 0) {
        log('Filter', '没有需要剔除的点（全部点都在统计正常范围），请调小邻居数或调大标准差倍数后重新预览')
        return
      }
      if (keptN === 0) {
        log('Filter', '全部点将被剔除（统计分布过于分散），请调大邻居数或调小标准差倍数后重新预览')
        return
      }
    }

    const pcs = usePointCloudStore()
    let firstFilteredId: number | null = null
    for (const t of targets) {
      const keptArr = previewKept.get(t.entityId)!
      // C++ kept → removed 补集 + 两侧包围盒（显示坐标），组装成 splitEntity 的选区输入
      const selections: ChunkSelection[] = t.sources.map((src, c) => {
        const kept = keptArr[c]
        const { removed, keptBBox, removedBBox } = splitKeptRemoved(src.positions, src.index, kept)
        return { inside: kept, outside: removed, insideBBox: keptBBox, outsideBBox: removedBBox }
      })
      const result = pcs.splitEntity(t.entityId, selections, { first: '.sor', second: '.removed' })
      if (result && firstFilteredId === null) {
        firstFilteredId = result.firstId
      }
    }
    if (firstFilteredId !== null) {
      selectNode({ type: 'entity', id: firstFilteredId })
    }
    exitStatisticalFilter(true)
  }

  /**
   * 退出统计滤波模式（确定 / 取消 / 再次点击按钮共用）。
   * @param completed true = 确定（applyFilter 内部调用，实体已拆分无需还原）；
   *   false = 取消（还原全部已预览目标的索引渲染）。
   */
  function exitStatisticalFilter(completed: boolean) {
    if (!state.active) return
    if (!completed) {
      restorePreview()
    }
    const ids = state.targetEntityIds.slice()
    state.active = false
    state.computing = false
    state.previewed = false
    state.stats = null
    state.neighbors = 10
    state.stddevMul = 1
    state.targetEntityIds = []
    targets = []
    previewKept = null
    // 解除预览期强制可见，按当前树状态重新同步（已拆分的原实体无记录，幂等）
    usePointCloudStore().endSegmentPreview(ids)
    log('Filter', completed ? '统计滤波确定，已生成 sor / removed 实体' : '已取消统计滤波，点云已还原')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    neighbors: computed(() => state.neighbors),
    stddevMul: computed(() => state.stddevMul),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    startStatisticalFilter,
    setParams,
    runPreview,
    applyFilter,
    exitStatisticalFilter,
  }
}
