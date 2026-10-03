import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import {
  GICP_APPLY_TRANSFO,
  buildTransformationFilters,
  computeGicp,
  defaultGicpParams,
  describeGicpResult,
  resolveRegistrationPair,
  toEntityTransform,
} from '../utils/registration'
import type { GicpParams, GicpRequest, GicpResult, RotationFilterMode } from '../utils/registration'

/**
 * 精细配准（GICP）模式状态（模块级单例，仿 ransacPlaneStore 的模态工具会话形状）。
 *
 * 与点对对齐（alignStore）互补：那边靠人工拾取同名点给一个**粗**的初始位姿，这边在
 * 初始位姿的基础上迭代最近点做**精**配准。所以典型用法是"先 Align 粗配准，再 GICP 细修"，
 * 也可以在位姿差不大时直接用 GICP（dialog 的默认参数就是为这种情况准备的）。
 *
 * 计算全在 native/registration 的 `gicp`：两片点云的候选块零拷贝传进去，先各按
 * `correspondenceRandomness` 个近邻做 PCA 得逐点局部协方差（平面化正则化），再逐轮解
 * `min Σ dᵢᵀ(C_target + R·C_data·Rᵀ)⁻¹dᵢ` —— 线性化成 6x6 对称系统（Jacobi 伪逆）解出**刚体**
 * 增量（无缩放），回包一次给总变换。对应点仍取欧氏最近邻（马氏只进目标函数），故面板的
 * "初始 RMS → 最终 RMS"与 ICP 可直接横向比较。差异与教训见 native/registration/README-REF.md。
 *
 * 三条约定：
 * - **data（待配准，会动）/ model（参考，不动）的角色由面板选**，默认 = 选择顺序
 *   （上游 CC 是"先选中 = data、后选中 = model"）。对调角色后必须重跑——它是另一个方向的
 *   最小化问题，不是取逆。
 * - **参数改动不撤销已有预览**（同 ransacPlaneStore：留着旧效果供对照微调），但会把
 *   `previewed` 置 false ⇒「确定」不可用，直到按当前参数重新「预览」。**角色对调则撤销预览**
 *   ——预览是施加在某一个实体上的，换了 data 就张冠李戴了。
 * - **预览只改实体 Group 的位姿**（O(1)，见 pointcloudStore.setEntityPreviewTransform），
 *   「确定」才把变换烘焙进顶点缓冲并改名 `<名称>.registered`（写时复制 + 包围体/八叉树重建）。
 */

/** GICP 面板参数（= `GicpParams` 去掉 transformFilters 与仅供测试的 seed，另加三个过滤器开关）。 */
export interface GicpPanelParams {
  maxIterations: number
  minRMSDecrease: number
  samplingLimit: number
  finalOverlapRatio: number
  filterOutFarthestPoints: boolean
  /** 旋转过滤档（映射到 native 的位掩码）。 */
  rotFilterMode: RotationFilterMode
  skipTx: boolean
  skipTy: boolean
  skipTz: boolean
  // GICP 特有参数
  /** 协方差 PCA 的**近邻个数**（PCL `setCorrespondenceRandomness`，面板上叫「邻域点数」）。 */
  correspondenceRandomness: number
  /** 平面化正则化开关（法向 ε / 切平面 1）。 */
  useNormalCovariance: boolean
}

/** 最近一次预览的统计（纯数字，可进 reactive）。 */
export interface GicpStats {
  /** `GICP_RESULT_*` 结果码。 */
  result: number
  /** 结果码的人话（面板与日志共用 describeGicpResult）。 */
  message: string
  /** 首轮 RMS → 最终 RMS（面板结果行）。 */
  initialRms: number
  rms: number
  /** 参与最终 RMS 的点数（`finalOverlapRatio < 1` 时明显小于总点数）。 */
  pointCount: number
  /** 迭代轮数（0 起算）。 */
  iterations: number
  /**
   * 逐点马氏距离的 RMS（GICP 特有统计，**无量纲** = 标准差倍数）。
   *
   * 它是 GICP 目标函数在解处的开方值，故只作参考、不要与上面的 RMS 比大小（量纲不同）。
   */
  covarianceError: number
}

const state = reactive({
  /** 是否处于 GICP 模式。 */
  active: false,
  /** 进入模式时快照的两个目标实体 id（顺序 = 选择顺序，[0] 默认 data）。 */
  targetEntityIds: [] as number[],
  /** data：待配准、会动的点云。 */
  dataEntityId: 0,
  /** model：参考、不动的点云。 */
  modelEntityId: 0,
  /** 参数（初值 = CC 对话框默认值 + 不过滤，见 defaultPanelParams）。 */
  params: defaultPanelParams(),
  /** 计算中（native 异步；期间禁用参数输入与按钮）。 */
  computing: false,
  /** 预览是否由**当前参数**生成（参数/角色改动置 false，「确定」须重新预览）。 */
  previewed: false,
  /** 最近一次预览的统计，供结果行显示。 */
  stats: null as GicpStats | null,
})

/**
 * 面板参数初值：GicpParams 的默认值（`ccRegistrationDlg.cpp` 的对话框默认 + PCL 的
 * `correspondenceRandomness`，见 `defaultGicpParams`）+ 变换过滤器组的初值（不过滤）。
 * 没有缩放相关项：GICP 是刚体算法（见 `GicpParams` 的注释）。
 */
function defaultPanelParams(): GicpPanelParams {
  const d = defaultGicpParams()
  return {
    maxIterations: d.maxIterations,
    minRMSDecrease: d.minRMSDecrease,
    samplingLimit: d.samplingLimit,
    finalOverlapRatio: d.finalOverlapRatio,
    filterOutFarthestPoints: d.filterOutFarthestPoints,
    rotFilterMode: 'none',
    skipTx: false,
    skipTy: false,
    skipTz: false,
    correspondenceRandomness: d.correspondenceRandomness,
    useNormalCovariance: d.useNormalCovariance,
  }
}

/** 最近一次回包（非响应式；面板读的是上面那份精简过的 stats）。 */
let result: GicpResult | null = null
/** 自增请求号：连续重跑时丢弃过期回包，并让迟到的 finally 不误清 computing。 */
let requestId = 0

/** 能否跑：两片云都在，且点数不为 0（native 会对空输入报 GICP_ERROR_INVALID_INPUT）。 */
const canRun = computed(() => !state.computing && state.targetEntityIds.length === 2)

function logGicp(message: string): void {
  useConsoleStore().log('Registration', message)
}

export function useGicpStore() {
  const sceneStore = useSceneStore()

  /** 实体名（点云可能已被删除，故留 id 兜底）。 */
  function nameOf(id: number): string {
    return sceneStore.getAllEntities().find((e) => e.id === id)?.name ?? String(id)
  }

  /** 撤销预览（幂等）：把 Group 还回基准位姿。 */
  function revokePreview(): void {
    if (!state.previewed) return
    usePointCloudStore().setEntityPreviewTransform(state.dataEntityId, null)
    state.previewed = false
  }

  /**
   * 进入 GICP 模式：解析当前选中项为**恰好两个**已加载点云。
   * 与 Align 共用同一套解析（`resolveRegistrationPair`），故入口判据完全一致。
   */
  function startGicp(): void {
    const resolved = resolveRegistrationPair(sceneStore.selection.value, sceneStore.projects)
    if (!resolved.ok) {
      logGicp(resolved.reason)
      return
    }
    result = null
    state.targetEntityIds = [resolved.first, resolved.second]
    state.dataEntityId = resolved.first // 默认：先选中的那片待配准（同 CC 的 data/model 语义）
    state.modelEntityId = resolved.second
    state.params = defaultPanelParams()
    state.computing = false
    state.previewed = false
    state.stats = null
    state.active = true
    const p = state.params
    logGicp(
      `进入精细配准（GICP）模式：「${resolved.firstName}」待配准 ← 「${resolved.secondName}」参考；` +
        `参数：最大迭代 ${p.maxIterations} / RMS 变化阈值 ${p.minRMSDecrease} / 采样上限 ${p.samplingLimit.toLocaleString()} / ` +
        `重叠度 ${(p.finalOverlapRatio * 100).toFixed(0)}%；点「预览」开始迭代`
    )
  }

  /**
   * 更新参数（面板输入事件调用）。参数改动**不影响当前显示**（旧预览保留供对照微调），
   * 仅把 `previewed` 置 false——「确定」必须等下一次「预览」按当前参数重算后才能用。
   * 非法输入（NaN / 越界）就地忽略，不写回状态。
   */
  function setParams(patch: Partial<GicpPanelParams>): void {
    if (!state.active || state.computing) return
    const next = { ...state.params, ...patch }
    // 逐项校验：NaN 与越界一律丢弃（沿用当前值，避免把非法值喂给 native
    if (!Number.isFinite(next.maxIterations) || next.maxIterations < 1) next.maxIterations = state.params.maxIterations
    else next.maxIterations = Math.round(next.maxIterations)
    if (!Number.isFinite(next.minRMSDecrease) || next.minRMSDecrease < 0)
      next.minRMSDecrease = state.params.minRMSDecrease
    if (!Number.isFinite(next.samplingLimit) || next.samplingLimit < 1) next.samplingLimit = state.params.samplingLimit
    // 重叠度是 (0, 1] 的开区间上界闭：0 会让 native 直接报非法输入
    if (!Number.isFinite(next.finalOverlapRatio)) next.finalOverlapRatio = state.params.finalOverlapRatio
    else next.finalOverlapRatio = Math.min(1, Math.max(0.01, next.finalOverlapRatio))
    // 邻域点数 < 3 构不成散布矩阵，native 会直接报非法输入，故下界就卡在 3
    if (!Number.isFinite(next.correspondenceRandomness) || next.correspondenceRandomness < 3)
      next.correspondenceRandomness = state.params.correspondenceRandomness
    else next.correspondenceRandomness = Math.round(next.correspondenceRandomness)
    const same =
      next.maxIterations === state.params.maxIterations &&
      next.minRMSDecrease === state.params.minRMSDecrease &&
      next.samplingLimit === state.params.samplingLimit &&
      next.finalOverlapRatio === state.params.finalOverlapRatio &&
      next.filterOutFarthestPoints === state.params.filterOutFarthestPoints &&
      next.rotFilterMode === state.params.rotFilterMode &&
      next.skipTx === state.params.skipTx &&
      next.skipTy === state.params.skipTy &&
      next.skipTz === state.params.skipTz &&
      next.correspondenceRandomness === state.params.correspondenceRandomness &&
      next.useNormalCovariance === state.params.useNormalCovariance
    if (same) return
    state.params = next
    state.previewed = false
  }

  /**
   * 设定谁"待配准"（面板的角色切换 = 对调 data/model）。
   * 解出的变换方向随之反向（不是取逆），且预览必须撤销——它施加在旧 data 上。
   */
  function setDataEntity(entityId: number): void {
    if (!state.active || state.computing) return
    if (entityId !== state.targetEntityIds[0] && entityId !== state.targetEntityIds[1]) return
    if (entityId === state.dataEntityId) return
    revokePreview()
    state.dataEntityId = entityId
    state.modelEntityId = entityId === state.targetEntityIds[0] ? state.targetEntityIds[1] : state.targetEntityIds[0]
    state.previewed = false
    result = null
    state.stats = null
  }

  /** 组装 native 请求参数（面板参数 + 过滤器位掩码）。 */
  function buildParams(): GicpParams {
    const p = state.params
    return {
      maxIterations: p.maxIterations,
      minRMSDecrease: p.minRMSDecrease,
      samplingLimit: p.samplingLimit,
      finalOverlapRatio: p.finalOverlapRatio,
      filterOutFarthestPoints: p.filterOutFarthestPoints,
      transformationFilters: buildTransformationFilters(p.rotFilterMode, p.skipTx, p.skipTy, p.skipTz),
      correspondenceRandomness: p.correspondenceRandomness,
      useNormalCovariance: p.useNormalCovariance,
    }
  }

  /**
   * 预览（面板「预览」）：两片点云的候选块**零拷贝**传进 native 迭代，
   * 回来后把增量变换施加到 data 实体的 Group 上（只改位姿，不动数据）。
   * 不锁相机——贴合与否要绕一圈看；「确定」烘焙。
   */
  async function run(): Promise<void> {
    if (!state.active || state.computing) return
    const pcs = usePointCloudStore()
    const dataChunks = pcs.getFilterSourceChunks(state.dataEntityId)
    const modelChunks = pcs.getFilterSourceChunks(state.modelEntityId)
    if (!dataChunks || !modelChunks || dataChunks.length === 0 || modelChunks.length === 0) {
      logGicp('选中的点云尚未加载完成，无法精细配准')
      return
    }
    const id = ++requestId
    state.computing = true
    try {
      const request: GicpRequest = {
        data: { chunks: dataChunks },
        model: { chunks: modelChunks },
        params: buildParams(),
      }
      const res = await computeGicp(request) // computeGicp 内部按名加载 .node（模块缓存，第 2 次起是 O(1)）
      if (!state.active || id !== requestId) return // 计算期间已退出/重跑：丢弃过期结果
      result = res
      state.stats = {
        result: res.result,
        message: describeGicpResult(res.result),
        initialRms: res.initialRms,
        rms: res.rms,
        pointCount: res.pointCount,
        iterations: res.iterations,
        covarianceError: res.covarianceError,
      }
      const dataName = nameOf(state.dataEntityId)
      if (res.result === GICP_APPLY_TRANSFO) {
        const ok = pcs.setEntityPreviewTransform(state.dataEntityId, toEntityTransform(res.r, res.t, res.s))
        state.previewed = ok
        if (!ok) logGicp('待配准的点云尚未加载完成，无法预览')
        logGicp(
          `精细配准预览：「${dataName}」${res.pointCount.toLocaleString()} 点参与，${res.iterations} 轮迭代，` +
            `RMS ${res.initialRms.toExponential(3)} → ${res.rms.toExponential(3)}；确认无误后按「确定」烘焙`
        )
      } else {
        // 没有可用变换：把上一次的预览收掉，免得画面与结果行说的不是一回事
        revokePreview()
        logGicp(`精细配准未产出变换：${describeGicpResult(res.result)}`)
      }
    } catch (err) {
      // 入参非法时绑定层同步抛错（不走回调），一并收敛在这里
      console.error('GICP 精细配准失败', err)
      const message = err instanceof Error ? err.message : String(err)
      logGicp(`精细配准失败：${message}`)
      revokePreview()
      state.stats = null
    } finally {
      if (state.active && id === requestId) state.computing = false
    }
  }

  /**
   * 确定：把预览的变换永久烘焙进 data 实体的顶点缓冲（写时复制 + 包围体/八叉树重建，
   * 见 pointcloudStore.bakeEntityTransform），并按 CC 的惯例改名 `<名称>.registered`。
   * 烘焙后选中该实体，便于接着做下一步处理。
   */
  function applyGicp(): void {
    if (!state.active || state.computing || !state.previewed) return
    if (!result || result.result !== GICP_APPLY_TRANSFO) return
    const pcs = usePointCloudStore()
    const dataName = nameOf(state.dataEntityId)
    const dataId = state.dataEntityId
    const ok = pcs.bakeEntityTransform(dataId, toEntityTransform(result.r, result.t, result.s))
    if (!ok) {
      logGicp('烘焙失败：待配准的点云已不存在或尚未加载完成')
      return
    }
    state.previewed = false // 顶点缓冲已改，Group 也已被 bake 还原成基准位姿，无预览可撤
    logGicp(
      `已精细配准并烘焙：「${dataName}」→ 名称加后缀 .registered` +
        `（${result.pointCount.toLocaleString()} 点参与，${result.iterations} 轮，RMS ${result.rms.toExponential(3)}，协方差误差 ${result.covarianceError.toExponential(3)}）`
    )
    exitGicp(true)
    sceneStore.selectNode({ type: 'entity', id: dataId })
  }

  /**
   * 退出 GICP 模式（确定 / 取消 / Esc / 再次点击入口按钮共用）。
   * @param completed true = 确定（变换已烘焙，无需还原）；false = 取消（撤销预览）
   */
  function exitGicp(completed: boolean): void {
    if (!state.active) return
    if (!completed) revokePreview()
    state.active = false
    state.computing = false
    state.previewed = false
    state.targetEntityIds = []
    state.dataEntityId = 0
    state.modelEntityId = 0
    state.params = defaultPanelParams()
    state.stats = null
    result = null
    requestId++
    if (!completed) logGicp('已取消精细配准，点云已还原')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    dataEntityId: computed(() => state.dataEntityId),
    modelEntityId: computed(() => state.modelEntityId),
    params: computed(() => state.params),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    stats: computed(() => state.stats),
    canRun,
    startGicp,
    setParams,
    setDataEntity,
    run,
    applyGicp,
    exitGicp,
  }
}
