import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import type { EntityBBox, SceneSelection } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { useAlgorithmModals } from '../composables/useAlgorithmModals'
import { loadNativeModule } from '../utils/nativeLoader'
import { candidateCountOfChunk, estimateMeanPointSpacing } from '../utils/radiusFilter'
import { NORMAL_MODEL_CODES, NORMAL_ORIENTATION_CODES } from '../utils/normalEstimate'
import type {
  GuessRadiusRequest,
  GuessRadiusResult,
  NormalEstimateAddon,
  NormalEstimateChunkSource,
  NormalEstimateEntityResult,
  NormalEstimateRequest,
  NormalModel,
  NormalOrientation,
} from '../utils/normalEstimate'

/**
 * 法向量功能的状态（模块级单例）。承载 `Edit > Normals` 三个菜单项：
 * `Compute…`（本文件唯一有 UI 的动作）/ `Invert` / `Delete normals`。
 *
 * 与其余七个算法 store 的**根本差异：这不是算法模态**。
 * - 不进 `useAlgorithmModals` 的入口表（那是「占用相机 + 参数横条 + 预览-确认」的会话），
 *   本功能是**一次成型**：对话框点 Compute → 算完即结束 → 产物是实体的 `normalCode`
 *   属性 + 一个可真接切换的 `ColorMode = 'normal'`。没有预览态、没有目标快照失效问题
 *   （因此 Invert / Delete 直接作用于**当前选中项**，不依赖进入时快照）。
 * - 但是它是**破坏性写入**（改写实体属性），故进入对话框前仍要 `exitOtherModals()`：
 *   否则会在别人的预览（`setChunkVisibility` 临时索引）之上叠算，预览还原时
 *   语义层索引一变，法向量与点集的对应关系就在用户眼里失效了。
 *
 * 刻意不进 reactive 的数据（沿袭 filterStore / ransacPlaneStore 模式）：目标块的候选源
 * （持有 TypedArray 引用，被深度代理会拖垮渲染）。响应式侧只留 id 与纯数字统计。
 */

/** 逐实体汇总（对话框底部结果行 / 日志用；纯数字，可进 reactive）。 */
export interface NormalRunStats {
  /** 成功算出法向量的点数（不含空码）。 */
  computed: number
  /** 空码点数（邻域不足，半径偏小的信号）。 */
  nullCount: number
  /** 空码中「半径放大到 16 倍仍不足」的点数（nullCount 的子集）。占大头 ⇒ 半径明显偏小。 */
  capped: number
  /** 实际写入成功的实体数 / 目标实体总数。 */
  entities: number
  entitiesTotal: number
  /** 耗时（ms，含 native 计算与属性换装）。 */
  elapsedMs: number
}

/** 进入对话框时快照的估计目标（sources 零拷贝引用渲染缓冲）。 */
interface NormalTarget {
  entityId: number
  /** 各块候选源（与实体 geometry 顺序对齐；含 index = 该块可见点集，见 pointcloudStore）。 */
  sources: NormalEstimateChunkSource[]
  /** 候选点总数（= 该实体可见点数）。 */
  candidateTotal: number
}

const state = reactive({
  /** 对话框是否打开。 */
  dialogOpen: false,
  /** 打开对话框时快照的目标实体 id（对话框打开期间选中变化不影响目标）。 */
  targetEntityIds: [] as number[],
  /** 邻域球半径（与点云坐标同单位；打开时按平均点距 ×2 估算，Auto 按钮可回填）。 */
  radius: 0,
  /** 局部模型（LS / Quadric）。 */
  model: 'ls' as NormalModel,
  /** 定向方式（默认不处理，同 CC 的 UNDEFINED）。 */
  orientation: 'undefined' as NormalOrientation,
  /** 估计计算中（期间禁用输入与按钮、禁止关闭对话框）。 */
  computing: false,
  /** Auto 半径计算中。 */
  guessing: false,
  /** 最近一次 Auto 的统计（供对话框显示推荐依据）。 */
  guessStats: null as GuessRadiusResult | null,
  /** 最近一次 Compute 的汇总（对话框关闭后仍保留，供日志面板之外查看）。 */
  lastStats: null as NormalRunStats | null,
})

/** 目标快照（TypedArray 不进 reactive，沿袭 filterStore 的缓存模式）。 */
let targets: NormalTarget[] = []

/**
 * 把一组选中项摊成**实体 id 列表**（去重、保序）。
 *
 * 多选语义：项目 = 其全部子实体；树项容器 = 其 `entityIds`；实体 = 它自己。
 * 这是仓库里**唯一**一处多选 → 实体的解析（`SceneTree.vue` 只做高亮判断，
 * 合并走的是自己的实体限定版），语义与 `ransacPlaneStore` 的项目展开一致。
 */
export function resolveNormalSelection(sels: SceneSelection[]): number[] {
  const sceneStore = useSceneStore()
  const ids: number[] = []
  const seen = new Set<number>()
  const push = (id: number) => {
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  for (const sel of sels) {
    if (sel.type === 'entity') {
      push(sel.id)
    } else if (sel.type === 'project') {
      // SceneEntity 不带 parentId，项目 → 子实体只能走项目自己的 entities 列表
      for (const e of sceneStore.projects.find((p) => p.id === sel.id)?.entities ?? []) push(e.id)
    } else {
      const group = sceneStore.projects.flatMap((p) => p.treeGroups).find((g) => g.id === sel.id)
      for (const id of group?.entityIds ?? []) push(id)
    }
  }
  return ids
}

/** 选中项里**已加载完成且有法向量**的实体 id（Invert / Delete 的可用性判据）。 */
export function selectedEntityIdsWithNormals(sels: SceneSelection[]): number[] {
  const all = useSceneStore().getAllEntities()
  return resolveNormalSelection(sels).filter((id) => {
    const e = all.find((x) => x.id === id)
    return !!e && e.hasNormals
  })
}

export function useNormalStore() {
  const sceneStore = useSceneStore()
  const { log } = useConsoleStore()

  /** 半径展示（去掉浮点尾噪；对话框输入框与日志共用）。 */
  function formatRadius(v: number): string {
    return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(6)))
  }

  /**
   * 打开「Compute normals」对话框：解析当前选中项为估计目标快照。
   *
   * 目标筛选口径与其余算法 store 一致：必须有 bbox / globalShift（已加载完成）
   * 且有候选源（未加载完的实体拿不到渲染缓冲，无法零拷贝喂给 native）。
   * 初始半径 = 平均点距粗估 ×2（与半径滤波的初始半径同一套量级依据）。
   * 局部模型与定向方式**不重置**：它们是目标无关的偏好，保留上次选择（同 CC 的对话框行为）。
   */
  function openComputeDialog() {
    if (state.dialogOpen) return
    const sels = sceneStore.selection.value
    if (sels.length === 0) {
      log('Normals', '请先在 DB Tree 中选中要计算法向量的点云')
      return
    }
    // 先退掉算法模态：它们持有启动时的目标快照与临时索引预览，改几何属性会让其失效
    useAlgorithmModals().exitOtherModals()

    const ids = resolveNormalSelection(sels)
    const pcs = usePointCloudStore()
    const resolved: NormalTarget[] = []
    let count = 0
    let bbox: EntityBBox | null = null
    let skipped = 0
    for (const id of ids) {
      const entity = sceneStore.getAllEntities().find((e) => e.id === id)
      if (!entity || !entity.bbox || !entity.globalShift) {
        skipped++
        continue // 未加载完成
      }
      const sources = pcs.getFilterSourceChunks(id)
      if (!sources) {
        skipped++
        continue
      }
      const candidateTotal = sources.reduce((s, c) => s + candidateCountOfChunk(c), 0)
      if (candidateTotal === 0) {
        skipped++
        continue
      }
      resolved.push({ entityId: id, sources, candidateTotal })
      // 点距按**候选点数**（可见点集）计，不是实体的 pointCount：分割产物的候选是子集
      count += candidateTotal
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
      log('Normals', '选中的点云尚未加载完成，无法计算法向量')
      return
    }

    targets = resolved
    state.targetEntityIds = resolved.map((t) => t.entityId)
    if (bbox) {
      const spacing = estimateMeanPointSpacing(count, {
        x: bbox.maxX - bbox.minX,
        y: bbox.maxY - bbox.minY,
        z: bbox.maxZ - bbox.minZ,
      })
      state.radius = spacing * 2
    } else {
      state.radius = 1
    }
    state.dialogOpen = true
    state.computing = false
    state.guessing = false
    state.guessStats = null
    log(
      'Normals',
      `打开法向量计算：目标 ${resolved.length} 块点云 / 候选 ${count.toLocaleString()} 点` +
        (skipped > 0 ? `（跳过 ${skipped} 个未加载完成的选中项）` : '') +
        `；初始半径 ${formatRadius(state.radius)}（≈ 平均点距 ×2，可用 Auto 估算）`
    )
  }

  /**
   * 关闭对话框（取消 / Esc）。
   * 计算中**不允许关闭**：native 计算没有取消通道（同半径滤波），关掉对话框会让
   * 结果无处可去，也会给出「我取消了」的错误暗示——按钮侧同样置灰。
   */
  function closeComputeDialog() {
    if (state.computing) return
    state.dialogOpen = false
    state.guessing = false
    state.targetEntityIds = []
    targets = []
  }

  function setRadius(radius: number) {
    if (state.computing) return
    state.radius = Number.isFinite(radius) ? Math.max(radius, 0) : state.radius
    // 半径一改，上一轮的 Auto 统计就不再描述当前参数，撤掉展示
    state.guessStats = null
  }

  function setModel(model: NormalModel) {
    if (state.computing) return
    state.model = model
  }

  function setOrientation(orientation: NormalOrientation) {
    if (state.computing) return
    state.orientation = orientation
  }

  /**
   * Auto：调用 native 的 `guessRadius` 估算合适邻域半径（对齐 CC `Edit > Normals > Compute`
   * 对话框里的 Auto 按钮）。与 CC 一致，**只在恰好一片点云时可用**：半径是单一标量，
   * 套用到密度差异很大的多片云上必然有一片不合适。
   *
   * 结果回填 `state.radius`（用户可再手改）；统计量只作展示，不参与半径推导。
   */
  async function guessRadius() {
    if (!state.dialogOpen || state.computing || state.guessing) return
    if (targets.length !== 1) {
      log('Normals', 'Auto 半径仅在恰好选中一片点云时可用（半径是单一标量，多片云的密度可能差很多）')
      return
    }
    state.guessing = true
    try {
      const addon = await loadNativeModule<NormalEstimateAddon>('normal_estimate')
      const target = targets[0]
      const request: GuessRadiusRequest = { entityId: target.entityId, chunks: target.sources }
      const result = await new Promise<GuessRadiusResult>((resolve, reject) => {
        try {
          addon.guessRadius(request, (err, res) => {
            if (err) reject(err)
            else resolve(res as GuessRadiusResult)
          })
        } catch (e) {
          reject(e) // guessRadius 入参非法时绑定层同步抛错（不走回调）
        }
      })
      if (!state.dialogOpen) return // 计算期间对话框已关：丢弃过期结果
      state.radius = result.radius
      state.guessStats = result
      log(
        'Normals',
        `Auto 半径：${formatRadius(result.radius)}（尝试 ${result.attempts} 轮，采样 ${
          result.sampledCount
        } 点；末轮邻域人口 均值 ${result.meanPopulation.toFixed(2)} / 标准差 ${result.stdDevPopulation.toFixed(
          2
        )} / 达标占比 ${(result.aboveMinRatio * 100).toFixed(1)}%）`
      )
    } catch (e) {
      log('Normals', `Auto 半径失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      state.guessing = false
    }
  }

  /**
   * Compute：逐实体跑 native 估计并写入 `normalCode` 属性，然后关闭对话框。
   *
   * 计算是**一次成型**的（没有预览态）：结果直接落到实体上，可随时用 Invert 反转或用
   * Delete normals 清除，也可在属性面板把 Colors 切回 RGB 看原色——着色方式的切换
   * 不破坏数据，这是相对 CC `Convert to > Colors`（不可逆覆盖原 RGB）的刻意改进。
   */
  async function computeNormals() {
    if (!state.dialogOpen || state.computing) return
    if (targets.length === 0) return
    if (!(state.radius > 0)) {
      log('Normals', '半径必须大于 0；半径为 0 时所有点的邻域都是空的，全部会留空码')
      return
    }
    state.computing = true
    const t0 = performance.now()
    try {
      const addon = await loadNativeModule<NormalEstimateAddon>('normal_estimate')
      const request: NormalEstimateRequest = {
        radius: state.radius,
        model: NORMAL_MODEL_CODES[state.model],
        orientation: NORMAL_ORIENTATION_CODES[state.orientation],
        entities: targets.map((t) => ({ entityId: t.entityId, chunks: t.sources })),
      }
      const results = await new Promise<NormalEstimateEntityResult[]>((resolve, reject) => {
        try {
          addon.computeNormals(request, (err, res) => {
            if (err) reject(err)
            else resolve(res ?? [])
          })
        } catch (e) {
          reject(e) // computeNormals 入参非法时绑定层同步抛错（不走回调）
        }
      })

      const pcs = usePointCloudStore()
      let computed = 0
      let nullCount = 0
      let capped = 0
      let ok = 0
      for (const result of results) {
        const target = targets.find((t) => t.entityId === result.entityId)
        if (!target) continue
        const name = sceneStore.getAllEntities().find((e) => e.id === result.entityId)?.name ?? String(result.entityId)
        if (result.codes.length !== target.sources.length) {
          // 契约防御：块数对不齐说明解析与渲染侧不一致，跳过该实体（其余实体照常写入）
          log('Normals', `实体「${name}」结果块数（${result.codes.length}）与当前几何不一致，已跳过`)
          continue
        }
        if (!pcs.setEntityNormalCodes(result.entityId, result.codes)) continue // 失败原因由 store 记日志
        ok++
        computed += result.computed
        nullCount += result.nullCount
        capped += result.capped
        const share = target.candidateTotal > 0 ? (result.computed / target.candidateTotal) * 100 : 0
        log(
          'Normals',
          `实体「${name}」：已算 ${result.computed.toLocaleString()} / 候选 ${target.candidateTotal.toLocaleString()}（${share.toFixed(
            2
          )}%），空码 ${result.nullCount.toLocaleString()}` +
            (result.capped > 0 ? `（其中 ${result.capped.toLocaleString()} 点放大到 16 倍半径仍不足）` : '')
        )
      }

      const elapsedMs = performance.now() - t0
      state.lastStats = {
        computed,
        nullCount,
        capped,
        entities: ok,
        entitiesTotal: targets.length,
        elapsedMs,
      }
      log(
        'Normals',
        `${state.model === 'ls' ? 'Plane (LS)' : 'Quadric'} 法向量计算完成：${ok}/${targets.length} 块点云，` +
          `共 ${computed.toLocaleString()} 点（空码 ${nullCount.toLocaleString()}），耗时 ${elapsedMs.toFixed(0)} ms。` +
          '在属性面板把 Colors 切到 Normal RGB 即可查看朝向'
      )
      // 全部实体都失败时不关对话框：让用户能改参数重试（partial 失败照常关闭）
      if (ok > 0) {
        state.dialogOpen = false
        state.targetEntityIds = []
        targets = []
      }
    } catch (e) {
      log('Normals', `法向量计算失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      state.computing = false
    }
  }

  /**
   * 反转选中实体的全部法向量（`Edit > Normals > Invert`）。
   * 不弹确认（同 CC：纯位运算、可再次反转还原，代价极低）。
   * @returns 实际反转的实体数
   */
  function invertNormals(): number {
    const ids = selectedEntityIdsWithNormals(sceneStore.selection.value)
    if (ids.length === 0) {
      log('Normals', '选中的点云没有法向量；请先执行 Compute normals')
      return 0
    }
    const pcs = usePointCloudStore()
    let done = 0
    for (const id of ids) {
      if (pcs.invertEntityNormals(id)) done++
    }
    return done
  }

  /**
   * 清除选中实体的法向量（`Edit > Normals > Delete normals`）。
   * 删除属性本身而不是只置标志位（属性留着会被分割白名单带进子实体，见 pointcloudStore）；
   * 正在以 Normal RGB 着色的实体会被自动压回 `none`（否则画面会因缺色表而整片黑）。
   * @returns 实际清除的实体数
   */
  function deleteNormals(): number {
    const ids = selectedEntityIdsWithNormals(sceneStore.selection.value)
    if (ids.length === 0) {
      log('Normals', '选中的点云本来就没有法向量')
      return 0
    }
    const pcs = usePointCloudStore()
    let done = 0
    for (const id of ids) {
      if (pcs.clearEntityNormals(id)) done++
    }
    return done
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    dialogOpen: computed(() => state.dialogOpen),
    targetEntityIds: computed(() => state.targetEntityIds),
    radius: computed(() => state.radius),
    model: computed(() => state.model),
    orientation: computed(() => state.orientation),
    computing: computed(() => state.computing),
    guessing: computed(() => state.guessing),
    guessStats: computed(() => state.guessStats),
    lastStats: computed(() => state.lastStats),
    openComputeDialog,
    closeComputeDialog,
    setRadius,
    setModel,
    setOrientation,
    guessRadius,
    computeNormals,
    invertNormals,
    deleteNormals,
  }
}
