import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import type { EntityBBox } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { loadNativeModule } from '../utils/nativeLoader'
import { candidateCountOfChunk, splitKeptRemoved } from '../utils/radiusFilter'
import { CSF_FIXED, estimateCsfDefaults } from '../utils/csf'
import type { CsfAddon, CsfChunkSource, CsfEntityResult, CsfRequest } from '../utils/csf'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * LiDAR 地面分割（CSF 布料模拟，CloudCompare qCSF 机载语义）模式状态（模块级单例）。
 * 语义取向：布料 pin + 结构约束，适合机载/平坦地形；丘陵山脉等起伏地形请用
 * 地形贴身高精度版（csf-proStore，见 native/csf-pro）。
 *
 * 与半径滤波（filterStore）同为模态工具流：从工具栏进入后，3D 视图右上角
 * 浮出 CsfToolBar。关键差异——**无预览阶段**：
 * - 点「分割」即触发 C++ 计算（native/csf-lidar，node-addon 零拷贝贴渲染缓冲），
 *   完成后**直接**把原实体拆成 `<name>.ground`（地面）与 `<name>.offGround`
 *   （非地面）两块（splitEntity labels 参数化），原实体删除，自动选中 .ground。
 * - 一次运行到底、随即退出模式；无屏上中间态，因此也没有"还原预览"逻辑。
 *
 * 状态被 ToolBar（按钮高亮/互斥禁用）、CsfToolBar（显隐/输入/按钮状态）共享，
 * 因此不放在组件内部。目标 sources（持有 TypedArray 引用）走模块级普通变量
 * （同 filterStore：进 reactive 会被深度代理拖慢）。
 */

/** 进入模式时快照的分割目标（sources 零拷贝引用渲染缓冲）。 */
interface CsfTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集，见 pointcloudStore）。 */
  sources: CsfChunkSource[]
  /** 候选点总数（= 该实体可见点数，地面/非地面校验用）。 */
  candidateTotal: number
}

const state = reactive({
  /** 是否处于地面分割模式。 */
  active: false,
  /** 进入模式时快照的目标实体 id（场景树选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 布料网格间距（与点云坐标同单位；进入模式时按平均点距 ×4 估算初始值）。 */
  clothResolution: 0,
  /** 分类阈值：点距布料面的高度差小于它判地面（与坐标同单位）。 */
  classThreshold: 0,
  /** 布料刚性 1..3（1 最柔）。 */
  rigidness: 2,
  /** 陡坡后处理开关。 */
  smoothSlope: false,
  /** 分割计算中（native 计算异步；期间禁用参数输入与按钮）。 */
  computing: false,
})

/** 目标快照（TypedArray 不进 reactive）。 */
let targets: CsfTarget[] = []

/** 参数展示去尾噪（估出的小数很长）。 */
function formatParam(x: number): number {
  return Number.isInteger(x) ? x : parseFloat(x.toFixed(4))
}

export function useCsfStore() {
  const { selectedNode, selectNode } = useSceneStore()
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /**
   * 从工具栏进入地面分割模式：解析当前选中节点为目标实体快照。
   * 与分割/滤波同款目标语义：项目 = 全部子实体；实体 = 仅它自己。
   * 目标全部未加载完成时提示并拒绝进入（无渲染缓冲无法贴数据计算）。
   */
  function startCsf() {
    const node = selectedNode.value
    if (!node) return
    const candidates = node.type === 'project' ? node.entities.map((e) => e.id) : [node.id]
    const pcs = usePointCloudStore()
    const resolved: CsfTarget[] = []
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
      log('LiDAR-CSF', '选中的点云尚未加载完成，无法分割')
      return
    }
    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    // 初始参数 = 平均点距比例估计（量级参考，与具体单位无关，用户随后调整）
    if (bbox) {
      const defaults = estimateCsfDefaults(count, {
        x: bbox.maxX - bbox.minX,
        y: bbox.maxY - bbox.minY,
        z: bbox.maxZ - bbox.minZ,
      })
      state.clothResolution = defaults.clothResolution
      state.classThreshold = defaults.classThreshold
    } else {
      state.clothResolution = 1
      state.classThreshold = 0.5
    }
    state.rigidness = 2
    state.smoothSlope = false
    state.active = true
    state.computing = false
    log(
      'LiDAR-CSF',
      `进入地面分割模式，目标 ${resolved.length} 块点云；初始参数：布料分辨率 ${formatParam(state.clothResolution)}（≈ 平均点距 ×4）/ 分类阈值 ${formatParam(state.classThreshold)}（≈ 平均点距 ×2）`
    )
  }

  /**
   * 更新分割参数（CsfToolBar 输入事件调用；部分字段省略 = 保持原值）。
   * 仅当处于模式且未在计算中时生效。
   */
  function setParams(partial: {
    clothResolution?: number
    classThreshold?: number
    rigidness?: number
    smoothSlope?: boolean
  }) {
    if (!state.active || state.computing) return
    if (partial.clothResolution !== undefined && Number.isFinite(partial.clothResolution)) {
      state.clothResolution = Math.max(partial.clothResolution, 0)
    }
    if (partial.classThreshold !== undefined && Number.isFinite(partial.classThreshold)) {
      state.classThreshold = Math.max(partial.classThreshold, 0)
    }
    if (partial.rigidness !== undefined && Number.isFinite(partial.rigidness)) {
      state.rigidness = Math.min(3, Math.max(1, Math.round(partial.rigidness)))
    }
    if (partial.smoothSlope !== undefined) {
      state.smoothSlope = partial.smoothSlope
    }
  }

  /**
   * 一键分割：native 计算（异步，uv 线程池）→ 双侧非空校验 → 逐实体把原点云
   * 拆成 `.ground` / `.offGround`（splitEntity，零拷贝共享顶点缓冲）→ 自动选中
   * 第一个 .ground → 退出模式。计算期间可 Esc 取消，迟到结果直接丢弃。
   */
  async function runCsf() {
    if (!state.active || state.computing) return
    if (targets.length === 0) return
    state.computing = true
    const t0 = performance.now()
    try {
      const addon = await loadNativeModule<CsfAddon>('csf_lidar')
      const request: CsfRequest = {
        clothResolution: state.clothResolution,
        rigidness: state.rigidness,
        iterations: CSF_FIXED.iterations,
        timeStep: CSF_FIXED.timeStep,
        classThreshold: state.classThreshold,
        smoothSlope: state.smoothSlope,
        heightAxis: CSF_FIXED.heightAxis,
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const results = await new Promise<CsfEntityResult[]>((resolve, reject) => {
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
      // 双侧非空校验（防止产出空点云实体）；地面空 = 阈值过小吞掉了整块布面？
      // 实际语义：全点高于布料（阈值过小）或布料没沉下去 → 提示调大分类阈值。
      for (const result of results) {
        const target = targets.find((t) => t.entityId === result.entityId)
        if (!target) continue
        const groundN = result.ground.reduce((sum, a) => sum + a.length, 0)
        const offN = target.candidateTotal - groundN
        if (offN === 0) {
          log('LiDAR-CSF', '所有点都判为地面（阈值过大或数据本就全为地面），请调小分类阈值后重试')
          return
        }
        if (groundN === 0) {
          log('LiDAR-CSF', '没有点判为地面（布料未能贴合地表），请调大分类阈值或布料分辨率后重试')
          return
        }
      }

      const pcs = usePointCloudStore()
      let firstGroundId: number | null = null
      for (const result of results) {
        const target = targets.find((t) => t.entityId === result.entityId)
        if (!target) continue
        const ground = result.ground
        if (ground.length !== target.sources.length) {
          // 契约防御：块数对不齐说明 native 输入解析与渲染侧不一致，跳过该实体
          log('LiDAR-CSF', `实体 ${result.entityId} 分割结果与块数不一致，已跳过`)
          continue
        }
        // C++ ground → offGround 补集 + 两侧包围盒（显示坐标），组装 splitEntity 选区
        const selections: ChunkSelection[] = target.sources.map((src, c) => {
          const gnd = ground[c]
          const { removed, keptBBox, removedBBox } = splitKeptRemoved(src.positions, src.index, gnd)
          return { inside: gnd, outside: removed, insideBBox: keptBBox, outsideBBox: removedBBox }
        })
        const split = pcs.splitEntity(target.entityId, selections, { first: '.ground', second: '.offGround' })
        const groundN = ground.reduce((sum, a) => sum + a.length, 0)
        const offN = target.candidateTotal - groundN
        const name = sceneStore.getAllEntities().find((e) => e.id === target.entityId)?.name ?? String(target.entityId)
        log('LiDAR-CSF', `实体「${name}」：地面 ${groundN.toLocaleString()}，非地面 ${offN.toLocaleString()}`)
        if (split && firstGroundId === null) {
          firstGroundId = split.firstId
        }
      }
      if (firstGroundId === null) {
        throw new Error('分割结果为空（native 契约异常）')
      }
      log('LiDAR-CSF', `分割完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      selectNode({ type: 'entity', id: firstGroundId })
      exitCsf(true)
    } catch (err) {
      console.error('LiDAR-CSF 分割失败', err)
      const message = err instanceof Error ? err.message : String(err)
      log('LiDAR-CSF', `分割失败：${message}`)
    } finally {
      // 仅当仍处于模式时复位（退出后由 exitCsf 复位；防迟到结果覆盖新模式的标志位）
      if (state.active) state.computing = false
    }
  }

  /**
   * 退出分割模式（完成 / 取消 / 再次点击分割按钮共用）。
   * 无预览中间态，取消不需要还原任何渲染状态。
   * @param completed true = 完成（runCsf 内部调用，实体已拆分）；false = 取消。
   */
  function exitCsf(completed: boolean) {
    if (!state.active) return
    state.active = false
    state.computing = false
    state.clothResolution = 0
    state.classThreshold = 0
    state.rigidness = 2
    state.smoothSlope = false
    state.targetEntityIds = []
    targets = []
    log('LiDAR-CSF', completed ? '分割完成，已生成 ground / offGround 实体' : '已取消分割')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    clothResolution: computed(() => state.clothResolution),
    classThreshold: computed(() => state.classThreshold),
    rigidness: computed(() => state.rigidness),
    smoothSlope: computed(() => state.smoothSlope),
    computing: computed(() => state.computing),
    startCsf,
    setParams,
    runCsf,
    exitCsf,
  }
}
