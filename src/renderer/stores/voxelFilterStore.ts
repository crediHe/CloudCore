import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import type { EntityBBox } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { loadNativeModule } from '../utils/nativeLoader'
import {
  candidateCountOfChunk,
  estimateMeanPointSpacing,
  splitKeptRemoved,
} from '../utils/radiusFilter'
import type {
  VoxelFilterAddon,
  VoxelFilterChunkSource,
  VoxelFilterEntityResult,
  VoxelFilterRequest,
} from '../utils/voxelFilter'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * 体素滤波模式状态（模块级单例）。
 *
 * 与半径滤波（filterStore）同构的模态工具流：工具栏进入后 3D 视图右上角浮出
 * VoxelToolBar，输入**体素边长**，手动点「预览」触发 C++ 计算（native/voxel-filter，
 * node-addon 零拷贝贴渲染缓冲），预览只显示代表点（每个占用体素 1 个真实原始点，
 * 取距体素重心最近者——语义对齐 PCL VoxelGrid，参考 doc/点云处理体素滤波/）。
 * 预览期相机不锁，可自由旋转确认。
 *
 * 确定后原实体按预览结果拆成 `<name>.voxelized`（代表点）与 `<name>.removed`
 * （其余点）两块（splitEntity labels 参数化），原实体删除，自动选中 .voxelized。
 * 与半径滤波的差异：参数语义是「体素边长」（越大保留越少），无最少邻居概念；
 * leafSize 极小时结果 ≈ 全保留，「确定」由两侧非空守卫拦截并给出提示。
 *
 * 状态被 SideToolBar（按钮高亮/互斥）、VoxelToolBar（显隐/输入/按钮状态）共享，
 * 因此不放在组件内部。
 *
 * 刻意不进 reactive 的数据（沿袭 segmentStore 模式）：目标 sources（持有 TypedArray
 * 引用）与预览结果 kept（Uint32Array 被深度代理会拖慢渲染）走模块级普通变量。
 */

/** 预览统计（纯数字，可进 reactive）。 */
export interface VoxelFilterStats {
  /** 全部目标实体保留点数合计（= 占用体素数）。 */
  kept: number
  /** 全部目标实体剔除点数合计。 */
  removed: number
}

/** 进入模式时快照的滤波目标（sources 零拷贝引用渲染缓冲）。 */
interface VoxelFilterTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集，见 pointcloudStore）。 */
  sources: VoxelFilterChunkSource[]
  /** 候选点总数（= 该实体可见点数，剔除/保留校验用）。 */
  candidateTotal: number
}

const state = reactive({
  /** 是否处于体素滤波模式。 */
  active: false,
  /** 进入模式时快照的目标实体 id（场景树选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 体素边长（与点云坐标同单位；进入模式时按平均点距 ×4 估算初始值）。 */
  leafSize: 0,
  /** 预览计算中（native 计算异步；期间禁用参数输入与按钮）。 */
  computing: false,
  /** 预览结果是否由**当前参数**生成；参数改动置 false（须重新预览后「确定」才可用）。 */
  previewed: false,
  /** 最近一次预览的统计（保留 / 剔除合计），供工具栏结果行显示。 */
  stats: null as VoxelFilterStats | null,
})

/** 目标快照与最近一次预览结果（Uint32Array 不进 reactive，沿袭 segmentStore 的缓存模式）。 */
let targets: VoxelFilterTarget[] = []
let previewKept: Map<number, Uint32Array[]> | null = null

/** 体素边长日志展示（去掉浮点尾噪）。 */
function formatLeafSize(l: number): number {
  return Number.isInteger(l) ? l : parseFloat(l.toFixed(6))
}

export function useVoxelFilterStore() {
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
   * 从工具栏进入体素滤波模式：解析当前选中节点为目标实体快照。
   * 与分割/半径滤波同款目标语义：项目 = 全部子实体；实体 = 仅它自己。
   * 目标全部未加载完成时提示并拒绝进入（无渲染缓冲无法贴数据计算）。
   */
  function startVoxelFilter() {
    const node = selectedNode.value
    if (!node) return
    const candidates = node.type === 'project' ? node.entities.map((e) => e.id) : [node.id]
    const pcs = usePointCloudStore()
    const resolved: VoxelFilterTarget[] = []
    // 聚合统计（默认参数估算用）：点数为可见点合计，包围盒取各目标合并
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
      log('Filter', '选中的点云尚未加载完成，无法滤波')
      return
    }
    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    // 初始参数 = 平均点距粗估 × 4（体素内期望 ≈ 4³ = 64 点，下采样效果明显；用户随后调整）
    if (bbox) {
      const spacing = estimateMeanPointSpacing(count, {
        x: bbox.maxX - bbox.minX,
        y: bbox.maxY - bbox.minY,
        z: bbox.maxZ - bbox.minZ,
      })
      state.leafSize = spacing * 4
    } else {
      state.leafSize = 1
    }
    state.active = true
    state.computing = false
    state.previewed = false
    state.stats = null
    log(
      'Filter',
      `进入体素滤波模式，目标 ${resolved.length} 块点云；初始体素边长 ${formatLeafSize(state.leafSize)}（≈ 平均点距 ×4，体素内约 64 点）`
    )
  }

  /**
   * 更新体素边长（VoxelToolBar 输入事件调用）。
   * 参数改动**不影响当前显示**：已有的预览原样保留（供对照旧效果微调参数），
   * 也不触发重算；仅将 previewed 置 false——「确定」必须等下一次「预览」按
   * 当前参数重新生成结果后才能用（防止用旧参数的结果去拆分）。
   */
  function setParams(leafSize: number) {
    if (!state.active || state.computing) return
    const l = Number.isFinite(leafSize) ? Math.max(leafSize, 0) : state.leafSize
    if (l === state.leafSize) return
    state.leafSize = l
    state.previewed = false
  }

  /**
   * 手动触发预览：native 计算（异步，uv 线程池 + 内部硬件线程并行）→ 逐实体
   * setChunkVisibility 应用代表点。每次都按**原始数据 + 当前参数**重算，新结果
   * 整体替换旧预览（setIndex 整体换索引即可，无需先还原，避免闪烁）。
   * 预览期强制目标可见（防树勾选把云藏掉），不锁相机，可自由旋转确认降采样效果。
   */
  async function runPreview() {
    if (!state.active || state.computing) return
    if (targets.length === 0) return
    state.computing = true
    try {
      const addon = await loadNativeModule<VoxelFilterAddon>('voxel_filter')
      const request: VoxelFilterRequest = {
        leafSize: state.leafSize,
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const results = await new Promise<VoxelFilterEntityResult[]>((resolve, reject) => {
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
        log('Filter', `实体「${name}」：保留 ${keptN.toLocaleString()}（每体素 1 点）· 剔除 ${removedN.toLocaleString()}`)
        pcs.setChunkVisibility(result.entityId, kept)
      }
      if (keptMap.size === 0) {
        throw new Error('预览结果为空（native 契约异常）')
      }
      previewKept = keptMap
      state.stats = { kept: keptTotal, removed: removedTotal }
      state.previewed = true
    } catch (err) {
      console.error('体素滤波预览失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('Filter', `预览失败：${message}`)
    } finally {
      // 仅当仍处于滤波模式时复位（退出后由 exitVoxelFilter 复位；防迟到结果覆盖新模式的标志位）
      if (state.active) state.computing = false
    }
  }

  /**
   * 确定滤波：校验保留/剔除两侧非空（阻止产出空点云）→ 逐实体按预览结果拆分
   * `.voxelized` / `.removed`（原实体删除）→ 自动选中第一个 .voxelized → 退出模式。
   */
  function applyVoxelFilter() {
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
        log('Filter', '没有需要剔除的点（体素边长过小，每个体素至多 1 点），请调大体素边长后重新预览')
        return
      }
      if (keptN === 0) {
        log('Filter', '全部点将被剔除（没有点满足条件），请调小体素边长后重新预览')
        return
      }
    }

    const pcs = usePointCloudStore()
    let firstVoxelizedId: number | null = null
    for (const t of targets) {
      const keptArr = previewKept.get(t.entityId)!
      // C++ kept → removed 补集 + 两侧包围盒（显示坐标），组装成 splitEntity 的选区输入
      const selections: ChunkSelection[] = t.sources.map((src, c) => {
        const kept = keptArr[c]
        const { removed, keptBBox, removedBBox } = splitKeptRemoved(src.positions, src.index, kept)
        return { inside: kept, outside: removed, insideBBox: keptBBox, outsideBBox: removedBBox }
      })
      const result = pcs.splitEntity(t.entityId, selections, { first: '.voxelized', second: '.removed' })
      if (result && firstVoxelizedId === null) {
        firstVoxelizedId = result.firstId
      }
    }
    if (firstVoxelizedId !== null) {
      selectNode({ type: 'entity', id: firstVoxelizedId })
    }
    exitVoxelFilter(true)
  }

  /**
   * 退出体素滤波模式（确定 / 取消 / 再次点击工具栏按钮共用）。
   * @param completed true = 确定（applyVoxelFilter 内部调用，实体已拆分无需还原）；
   *   false = 取消（还原全部已预览目标的索引渲染）。
   */
  function exitVoxelFilter(completed: boolean) {
    if (!state.active) return
    if (!completed) {
      restorePreview()
    }
    const ids = state.targetEntityIds.slice()
    state.active = false
    state.computing = false
    state.previewed = false
    state.stats = null
    state.leafSize = 0
    state.targetEntityIds = []
    targets = []
    previewKept = null
    // 解除预览期强制可见，按当前树状态重新同步（已拆分的原实体无记录，幂等）
    usePointCloudStore().endSegmentPreview(ids)
    log('Filter', completed ? '体素滤波确定，已生成 voxelized / removed 实体' : '已取消体素滤波，点云已还原')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    leafSize: computed(() => state.leafSize),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    startVoxelFilter,
    setParams,
    runPreview,
    applyVoxelFilter,
    exitVoxelFilter,
  }
}
