import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { useProgressStore } from './progressStore'
import type { ProgressTaskHandle } from './progressStore'
import { loadNativeModule } from '../utils/nativeLoader'
import { candidateCountOfChunk, splitKeptRemoved } from '../utils/radiusFilter'
import { CSF_PRO_DEFAULT, CSF_PRO_FIXED } from '../utils/csfPro'
import type { CsfProAddon, CsfProChunkSource, CsfProEntityResult, CsfProProgress, CsfProRequest } from '../utils/csfPro'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * 精准地面分割（csf-pro：老算法液体贴合语义 CSF）模式状态（模块级单例）。
 *
 * 与 LiDAR 地面分割（csfStore）的差异在 C++ 语义（布料垂坠贴身、丘陵/山脉精度
 * 高、收敛慢）与交互（运行期间弹全局进度条 GlobalProgress，可取消）：
 * - 点「分割」→ progressStore.start({ modal:true, cancellable:true })，native
 *   AsyncProgressWorker 每轮迭代回报进度（节流 ~100ms 刷一次条），完成后把每个
 *   目标原实体拆成 `.ground` / `.offGround` 两块并退出模式。
 * - 取消：进度条「取消」按钮或 Esc → addon.cancel()（uv 线程池内每轮检查后走
 *   错误回调"已取消"），迟到结果直接丢弃。
 * - **无预览阶段**（同 csfStore）：一次运行到底随即拆分，无屏上中间态。
 *
 * 状态被 ToolBar（按钮高亮/互斥禁用）、CsfProToolBar（显隐/输入）共享，
 * 因此不放在组件内部。目标 sources（持有 TypedArray 引用）走模块级普通变量
 * （进 reactive 会被深度代理拖慢）。
 */

/** 进入模式时快照的分割目标（sources 零拷贝引用渲染缓冲）。 */
interface CsfProTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集）。 */
  sources: CsfProChunkSource[]
  /** 候选点总数（= 该实体可见点数，地面/非地面校验用）。 */
  candidateTotal: number
}

const state = reactive({
  /** 是否处于精准分割模式。 */
  active: false,
  /** 进入模式时快照的目标实体 id（场景树选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 布料网格间距（与点云坐标同单位；进入模式时重置为老代码默认 0.6）。 */
  clothResolution: CSF_PRO_DEFAULT.clothResolution as number,
  /** 分类阈值：点距布料面的高度差小于它判地面（与坐标同单位；进入模式时重置为 0.4）。 */
  classThreshold: CSF_PRO_DEFAULT.classThreshold as number,
  /** 布料刚性 1..3（1 最柔；进入模式时重置为 2）。 */
  rigidness: CSF_PRO_DEFAULT.rigidness as number,
  /** 分割计算中（native 异步；期间弹全局进度条，参数输入与按钮禁用）。 */
  computing: false,
})

/** 目标快照（TypedArray 不进 reactive）。 */
let targets: CsfProTarget[] = []

/** 本次运行的 native 模块与进度条句柄（模块级：Esc/取消按钮需要越过组件作用域调用）。 */
let currentAddon: CsfProAddon | null = null
let progressHandle: ProgressTaskHandle | null = null
/** 用户主动取消（区别于失败：取消静默收尾，不弹错误、不算失败）。 */
let cancelledByUser = false

/** 进度事件去抖（native 每轮迭代都可能触发，条不追帧，~100ms 刷一次足够）。 */
let lastProgressAt = 0

export function useCsfProStore() {
  const { selectedNode, selectNode } = useSceneStore()
  const { log } = useConsoleStore()
  const sceneStore = useSceneStore()

  /**
   * 从工具栏进入精准分割模式：解析当前选中节点为目标实体快照。
   * 与分割/滤波/LiDAR 地面分割同款目标语义：项目 = 全部子实体；实体 = 仅它自己。
   * 目标全部未加载完成时提示并拒绝进入（无渲染缓冲无法贴数据计算）。
   */
  function startCsfPro() {
    const node = selectedNode.value
    if (!node) return
    const candidates = node.type === 'project' ? node.entities.map((e) => e.id) : [node.id]
    const pcs = usePointCloudStore()
    const resolved: CsfProTarget[] = []
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
      log('CSF-Pro', '选中的点云尚未加载完成，无法分割')
      return
    }
    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    // 初始参数固定为老代码实测默认（不做点距估算——估算会随数据变密把参数压小，
    // 粒子数平方爆炸且布料落到植被顶；与老界面一致，由用户按数据手动调整）
    state.clothResolution = CSF_PRO_DEFAULT.clothResolution
    state.classThreshold = CSF_PRO_DEFAULT.classThreshold
    state.rigidness = CSF_PRO_DEFAULT.rigidness
    state.active = true
    state.computing = false
    log(
      'CSF-Pro',
      `进入精准分割模式，目标 ${resolved.length} 块点云；初始参数（对齐老代码默认）：布料分辨率 ${CSF_PRO_DEFAULT.clothResolution} / 分类阈值 ${CSF_PRO_DEFAULT.classThreshold} / 刚性 ${CSF_PRO_DEFAULT.rigidness}，可按数据手动调整。布料贴合语义收敛较慢，将显示进度并可取消`
    )
  }

  /**
   * 更新分割参数（CsfProToolBar 输入事件调用；部分字段省略 = 保持原值）。
   * 仅当处于模式且未在计算中时生效。
   */
  function setParams(partial: {
    clothResolution?: number
    classThreshold?: number
    rigidness?: number
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
  }

  /** 请求中止本次计算（进度条「取消」按钮与 Esc 共用；幂等）。 */
  function cancelRun() {
    cancelledByUser = true
    if (currentAddon) currentAddon.cancel()
  }

  /**
   * 一键分割：native 计算（异步，uv 线程池，逐轮进度 → GlobalProgress）→ 双侧
   * 非空校验 → 逐实体把原点云拆成 `.ground` / `.offGround`（splitEntity，零拷贝
   * 共享顶点缓冲）→ 自动选中第一个 .ground → 退出模式。计算期间可取消，迟到
   * 结果直接丢弃。
   */
  async function runCsfPro() {
    if (!state.active || state.computing) return
    if (targets.length === 0) return
    state.computing = true
    cancelledByUser = false
    const t0 = performance.now()
    const progress = useProgressStore()
    try {
      const addon = await loadNativeModule<CsfProAddon>('csf_pro')
      currentAddon = addon
      if (!state.active) return // 加载期间已退出模式：丢弃（finally 复位标志）
      const request: CsfProRequest = {
        clothResolution: state.clothResolution,
        rigidness: state.rigidness,
        iterations: CSF_PRO_FIXED.iterations,
        timeStep: CSF_PRO_FIXED.timeStep,
        classThreshold: state.classThreshold,
        convergenceEps: CSF_PRO_FIXED.convergenceEps,
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const handle = progress.start({
        title: '精准地面分割（csf-pro）',
        message: '布料贴地模拟中…',
        modal: true,
        cancellable: true,
        onCancel: cancelRun, // 真正的取消逻辑：置标志 + 中止 native 计算
      })
      progressHandle = handle
      const results = await new Promise<CsfProEntityResult[]>((resolve, reject) => {
        try {
          addon.compute(
            request,
            (p: CsfProProgress) => {
              // 进度节流：AsyncProgressWorker 每轮都可能触发，~100ms 刷一次条
              const now = performance.now()
              if (now - lastProgressAt > 100) {
                lastProgressAt = now
                handle.update(p.overall * 100, `布料贴地模拟中… 实体 ${p.entity}/${p.entityTotal} · 迭代 ${p.iteration}`)
              }
            },
            (err, res) => {
              if (err) reject(err)
              else resolve(res ?? [])
            }
          )
        } catch (e) {
          reject(e) // compute 入参非法时绑定层同步抛错（不走回调）
        }
      })
      handle.done()
      progressHandle = null
      currentAddon = null
      if (cancelledByUser || !state.active) return // 计算期间已取消/退出：丢弃过期结果

      // 双侧非空校验（防止产出空点云实体）；提示语义同 csfStore
      for (const result of results) {
        const target = targets.find((t) => t.entityId === result.entityId)
        if (!target) continue
        const groundN = result.ground.reduce((sum, a) => sum + a.length, 0)
        const offN = target.candidateTotal - groundN
        if (offN === 0) {
          log('CSF-Pro', '所有点都判为地面（阈值过大或数据本就全为地面），请调小分类阈值后重试')
          return
        }
        if (groundN === 0) {
          log('CSF-Pro', '没有点判为地面（布料未能贴合地表），请调大分类阈值或布料分辨率后重试')
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
          log('CSF-Pro', `实体 ${result.entityId} 分割结果与块数不一致，已跳过`)
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
        log('CSF-Pro', `实体「${name}」：地面 ${groundN.toLocaleString()}，非地面 ${offN.toLocaleString()}`)
        if (split && firstGroundId === null) {
          firstGroundId = split.firstId
        }
      }
      if (firstGroundId === null) {
        throw new Error('分割结果为空（native 契约异常）')
      }
      log('CSF-Pro', `分割完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      selectNode({ type: 'entity', id: firstGroundId })
      exitCsfPro(true)
    } catch (err) {
      currentAddon = null
      const handle = progressHandle
      progressHandle = null
      if (cancelledByUser) {
        // 主动取消：进度条已由取消按钮/close 关掉，静默退出模式（exit 内记日志）
        exitCsfPro(false)
      } else {
        console.error('CSF-Pro 分割失败', err)
        const message = err instanceof Error ? err.message : String(err)
        handle?.fail(message) // 进度条转红停留，供用户查看原因后点关闭
        log('CSF-Pro', `分割失败：${message}`)
      }
    } finally {
      // 仅当仍处于模式时复位（退出后由 exitCsfPro 复位；防迟到结果覆盖新模式的标志位）
      if (state.active) state.computing = false
    }
  }

  /**
   * 退出精准分割模式（完成 / 取消 / 再次点击按钮共用）。
   * 无预览中间态，取消不需要还原任何渲染状态。
   * @param completed true = 完成（runCsfPro 内部调用，实体已拆分）；false = 取消。
   */
  function exitCsfPro(completed: boolean) {
    if (!state.active) return
    // 计算中退出 = 主动放弃：一并中止 native（若有），避免后台空跑
    if (state.computing && !completed) cancelRun()
    state.active = false
    state.computing = false
    state.clothResolution = 0
    state.classThreshold = 0
    state.rigidness = 2
    state.targetEntityIds = []
    targets = []
    currentAddon = null
    progressHandle = null
    log('CSF-Pro', completed ? '分割完成，已生成 ground / offGround 实体' : '已取消分割')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    clothResolution: computed(() => state.clothResolution),
    classThreshold: computed(() => state.classThreshold),
    rigidness: computed(() => state.rigidness),
    computing: computed(() => state.computing),
    startCsfPro,
    setParams,
    cancelRun,
    runCsfPro,
    exitCsfPro,
  }
}
