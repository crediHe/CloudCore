import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import { useViewerStore } from './viewerStore'
import {
  MIN_PAIRS_COUNT,
  buildOrientationPoints,
  buildTransformationFilters,
  findAbsoluteOrientation,
  resolveRegistrationPair,
  toEntityTransform,
} from '../utils/registration'
import type {
  AlignedRole,
  OrientationResult,
  RegistrationPair,
  RegistrationPick,
  RotationFilterMode,
} from '../utils/registration'
import { createRegistrationOverlay } from '../three/registrationOverlay'
import type { RegistrationOverlay, RegistrationOverlayItem } from '../three/registrationOverlay'

/**
 * 点对对齐（Align）模式状态（模块级单例，仿 ransacPlaneStore 的模态工具会话形状）。
 *
 * 与其余算法模态最大的不同：**计算不在点云上，而在"拾取点对"上**。
 * 拾取的每一对同名点给出一个方程，native/regulation 的 `findAbsoluteOrientation` 解出
 * 把「待对齐」搬到「参考」的刚体变换（Horn/Besl 四元数法，可选缩放），全程只碰几十个点，
 * 微秒级；而变换的作用对象是**整片点云**——预览时只改实体 Group 的位姿（O(1)，见
 * pointcloudStore.setEntityPreviewTransform），确认时才逐点烘焙进顶点缓冲。
 *
 * 三条与 CC（ccPointPairRegistrationDlg）一致或不一致的约定，改代码前先看：
 * - **角色由面板选，不由拾取顺序定**：两侧拾取集按**实体**分区（`picksByRole[0]` 恒属第 1 个
 *   目标实体），对调角色只是换一个 `alignedRole`，点本身一个不动。上游 CC 是按"命中哪个实体"
 *   路由到 aligned/model 两个集合，等价。
 * - **两侧点数必须相等**（多一个少一个都不算），这是上游 `callRegistration` 的硬前提：
 *   第 i 对的两点一一对应，错一个位置整组解就错。不等时`canCompute` 为假并提示删哪一个。
 * - **⚠ 预览期间不许改任何东西**：覆盖物的标记是独立场景对象，不跟点云一起被预览变换搬走
 *   （CC 挂成点云子对象，所以那边能边预览边加对）。故这里任何点对 / 过滤器 / 角色改动都先
 *   `revokePreview()` 还原 Group 再动状态——标记因此永远画在真实坐标上。
 */

/** 面板上的一项过滤器开关组（与 native 请求的位掩码一一对应）。 */
export interface AlignOptions {
  /** 是否同时估计缩放（关时 s 恒 1）。 */
  adjustScale: boolean
  /** 旋转过滤档：none=不过滤 / x|y|z=只留绕该轴 / fixed=完全不旋转（只平移）。 */
  rotFilterMode: RotationFilterMode
  /** 锁定对应平移分量。 */
  skipTx: boolean
  skipTy: boolean
  skipTz: boolean
}

/** 点对表格的一行（两侧各自的显示坐标；某一侧缺 = 该侧还没点上）。 */
export interface AlignRow {
  aligned: { x: number; y: number; z: number } | null
  reference: { x: number; y: number; z: number } | null
  /** 该对在当前变换下的距离；未配成对（或算不出）时 null。 */
  distance: number | null
  /** 逐分量偏差 = 参考点 − 变换后的待对齐点；同上为 null。 */
  delta: { x: number; y: number; z: number } | null
}

/** 解算统计（纯数字，可进 reactive）。 */
export interface AlignStats {
  /** 真正参与解算的点对数（= min(两侧点数)）。 */
  pairCount: number
  /** 可达 RMS（过滤后的最终变换下）；解算退化时 null。 */
  rms: number | null
  /** 逐对距离的最大值。 */
  maxDistance: number | null
  /** 解算是否成功；false = 退化（点数不足 / 三点共线 / 只够定平移）。 */
  ok: boolean
  /** 解出的缩放（`adjustScale` 关时恒 1）。 */
  scale: number
}

const state = reactive({
  /** 是否处于点对对齐模式。 */
  active: false,
  /** 进入模式时快照的两个目标实体 id（顺序 = 选择顺序，[0] 默认待对齐）。 */
  targetEntityIds: [] as number[],
  /** 待对齐（data）：会被搬动的那一片。 */
  alignedEntityId: 0,
  /** 参考（model）：不动的目标。 */
  referenceEntityId: 0,
  /** 两侧拾取数（**按实体下标**，与角色无关；表头与 canCompute 用）。 */
  pickCounts: [0, 0] as [number, number],
  /** 点对表格的行（角色决定左右两列谁是"待对齐"）。 */
  rows: [] as AlignRow[],
  /** 最近一次解算的统计。 */
  stats: null as AlignStats | null,
  /** 解算中（native 异步；期间禁用按钮）。 */
  computing: false,
  /** 预览是否已施加（「确定」的前置）。 */
  previewed: false,
  /** 过滤器开关组（任何改动都重算 + 撤销预览）。 */
  options: {
    adjustScale: false,
    rotFilterMode: 'none',
    skipTx: false,
    skipTy: false,
    skipTz: false,
  } as AlignOptions,
})

/** 两侧拾取点（按实体下标分区；TypedArray 之外的大数组不进 reactive 的约定这里同样适用）。 */
const picksByRole: [RegistrationPick[], RegistrationPick[]] = [[], []]
/** 最近一次解算的原始回包（非响应式；面板读的是上面那份精简过的 stats/rows）。 */
let result: OrientationResult | null = null
/** 自增请求号：点对连续变化时丢弃过期回包（native 往返虽快，但点击可以更快）。 */
let requestId = 0
/** 标记覆盖层（懒创建；退出只 hide 不 dispose——下次进模式复用同一实例）。 */
let overlay: RegistrationOverlay | null = null

/** 当前"待对齐"是第几个目标实体（面板随时可对调）。 */
const alignedRole = computed<AlignedRole>(() => (state.alignedEntityId === state.targetEntityIds[0] ? 0 : 1))
/** 待对齐侧拾取数 / 参考侧拾取数。 */
const alignedCount = computed(() => state.pickCounts[alignedRole.value])
const referenceCount = computed(() => state.pickCounts[alignedRole.value === 0 ? 1 : 0])
/** 可以解算：两侧数量相等且都够 3 对（上游 MIN_PAIRS_COUNT）。 */
const canCompute = computed(() => alignedCount.value === referenceCount.value && alignedCount.value >= MIN_PAIRS_COUNT)
/** 可以预览：已有一次成功解算，且当前尚未施加预览。 */
const canPreview = computed(() => !state.previewed && state.stats !== null && state.stats.ok)

/** 惰性建覆盖层（3D 视图未挂载时返回 null，解算照跑，只是不画标记）。 */
function ensureOverlay(): RegistrationOverlay | null {
  const viewer = useViewerStore().getViewer()
  if (!viewer) return null
  if (!overlay) overlay = createRegistrationOverlay(viewer.scene)
  return overlay
}

/** 按当前拾取重画标记（顺带置脏；three 无变更通知，直写场景必须自己 requestRender）。 */
function drawOverlay(): void {
  const instance = ensureOverlay()
  if (!instance) return
  const items: RegistrationOverlayItem[] = []
  const a = picksByRole[alignedRole.value]
  const r = picksByRole[alignedRole.value === 0 ? 1 : 0]
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    items.push({ aligned: a[i] ?? null, reference: r[i] ?? null })
  }
  if (items.length > 0) instance.show(items)
  else instance.hide()
  useViewerStore().getViewer()?.requestRender()
}

/**
 * 写一条 Console 日志。
 * 模块级的 refresh 与 store 工厂里的 action 都要记日志，故统一走这个助手，避免两处
 * `useConsoleStore()` 各解构一份、或者工厂内的局部 `log` 把同名函数遮蔽掉。
 */
function logRegistration(message: string): void {
  useConsoleStore().log('Registration', message)
}

/** 过滤器的人话描述（日志用）。 */
function describeFilters(): string {
  const rot =
    state.options.rotFilterMode === 'none'
      ? '旋转不过滤'
      : state.options.rotFilterMode === 'fixed'
        ? '不旋转（仅平移）'
        : `只保留绕 ${state.options.rotFilterMode.toUpperCase()} 轴的旋转`
  const locked = (['Tx', 'Ty', 'Tz'] as const).filter(
    (_, i) => [state.options.skipTx, state.options.skipTy, state.options.skipTz][i]
  )
  return `${rot}；${locked.length > 0 ? `锁定 ${locked.join('/')}` : '平移不过滤'}；缩放 ${state.options.adjustScale ? '估计' : '固定 1'}`
}

/**
 * 按"实体顺序"配对（`first` 恒属第 1 个目标实体）——`buildOrientationPoints` 的入参形态。
 * 角色不参与：它就是"左侧谁待对齐"的那个开关。
 */
function zippedPairs(): RegistrationPair[] {
  const n = Math.min(picksByRole[0].length, picksByRole[1].length)
  const out: RegistrationPair[] = []
  for (let i = 0; i < n; i++) out.push({ first: picksByRole[0][i], second: picksByRole[1][i] })
  return out
}

/** 用当前拾取重建表格（两侧数量不等时行数取多的那个，缺的那侧留空）。 */
function rebuildRows(): void {
  const a = picksByRole[alignedRole.value]
  const r = picksByRole[alignedRole.value === 0 ? 1 : 0]
  const paired = result && result.ok === true && result.distances.length >= Math.min(a.length, r.length)
  const rows: AlignRow[] = []
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const hasDelta = !!paired && i < Math.min(a.length, r.length)
    rows.push({
      aligned: a[i] ? { x: a[i].x, y: a[i].y, z: a[i].z } : null,
      reference: r[i] ? { x: r[i].x, y: r[i].y, z: r[i].z } : null,
      distance: hasDelta ? result!.distances[i] : null,
      delta: hasDelta ? { x: result!.deltas[i * 3], y: result!.deltas[i * 3 + 1], z: result!.deltas[i * 3 + 2] } : null,
    })
  }
  state.rows = rows
}

/** 清空解算结果（点对变了旧结果即失效；表格的偏差列同时清空）。 */
function clearResult(): void {
  result = null
  state.stats = null
  requestId++ // 在飞的回包一律作废
}

/**
 * 重算：点对 → native（解算 → 变换过滤 → RMS → 逐对偏差一次做完）→ 刷新表格与统计。
 * 不施加任何预览——预览由用户按「对齐」触发（同 CC：`callRegistration` 与 `align` 是两步）。
 */
async function refresh(): Promise<void> {
  if (!state.active) return
  if (!canCompute.value) {
    clearResult()
    rebuildRows()
    return
  }
  const id = ++requestId
  state.computing = true
  try {
    const { aligned, reference } = buildOrientationPoints(zippedPairs(), alignedRole.value)
    const res = await findAbsoluteOrientation({
      aligned,
      reference,
      adjustScale: state.options.adjustScale,
      filters: buildTransformationFilters(
        state.options.rotFilterMode,
        state.options.skipTx,
        state.options.skipTy,
        state.options.skipTz
      ),
    })
    if (!state.active || id !== requestId) return // 过期回包（点对/过滤器已变）：丢弃
    result = res
    const n = Math.min(picksByRole[0].length, picksByRole[1].length)
    let maxDistance: number | null = null
    if (res.ok && res.distances.length > 0) {
      maxDistance = 0
      for (const d of res.distances) if (d > maxDistance) maxDistance = d
    }
    state.stats = {
      pairCount: n,
      rms: res.ok ? res.rms : null,
      maxDistance,
      ok: res.ok,
      scale: res.s,
    }
    rebuildRows()
    if (!res.ok) logRegistration('点对解算退化（三点共线或点数不足）：无法解出旋转，请换几对位置更散的点')
    else
      logRegistration(
        `可达 RMS ${res.rms.toExponential(3)}（${n} 对点；${describeFilters()}）` +
          (state.options.adjustScale ? `；缩放 ${res.s.toPrecision(6)}` : '')
      )
  } catch (err) {
    // 入参非法时绑定层同步抛错（不走回调），一并收敛在这里
    const message = err instanceof Error ? err.message : String(err)
    logRegistration(`点对解算失败：${message}`)
    clearResult()
    rebuildRows()
  } finally {
    if (state.active && id === requestId) state.computing = false
  }
}

export function useAlignStore() {
  const sceneStore = useSceneStore()

  /** 撤销预览（幂等）：把 Group 还回基准位姿。任何会改变解算结果的操作都必须先调它。 */
  function revokePreview(): void {
    if (!state.previewed) return
    usePointCloudStore().setEntityPreviewTransform(state.alignedEntityId, null)
    state.previewed = false
  }

  /**
   * 从工具栏进入点对对齐模式：解析当前选中项为**恰好两个**已加载点云。
   * 严格 2 选（用户已确认）：配准是两片云之间的事，多选第三片只会让人误拾。
   */
  function startAlign(): void {
    // selection 是 computed，取 .value；projects 是 store 直接暴露的响应式数组
    const resolved = resolveRegistrationPair(sceneStore.selection.value, sceneStore.projects)
    if (!resolved.ok) {
      logRegistration(resolved.reason)
      return
    }
    picksByRole[0] = []
    picksByRole[1] = []
    clearResult()
    state.targetEntityIds = [resolved.first, resolved.second]
    state.alignedEntityId = resolved.first // 默认：先选中的那个待对齐（顺序 = 选择顺序）
    state.referenceEntityId = resolved.second
    state.pickCounts = [0, 0]
    state.rows = []
    state.options = { adjustScale: false, rotFilterMode: 'none', skipTx: false, skipTy: false, skipTz: false }
    state.computing = false
    state.previewed = false
    state.active = true
    logRegistration(
      `进入点对对齐模式：「${resolved.firstName}」待对齐 ← 「${resolved.secondName}」参考；` +
        `在点云上交替拾取 ≥ ${MIN_PAIRS_COUNT} 对同名点（可随时旋转缩放，Esc 取消）`
    )
  }

  /**
   * 记一个拾取点（交互层路由进来；`pick.entityId` 必须属于两个目标之一）。
   * @returns 是否被接收（非目标实体返回 false，由交互层提示）
   */
  function addPick(pick: RegistrationPick): boolean {
    if (!state.active) return false
    const index = state.targetEntityIds.indexOf(pick.entityId)
    if (index < 0) return false
    revokePreview() // 标记不跟预览走，先还原再改点对（见文件头第三条）
    picksByRole[index].push(pick)
    state.pickCounts = [picksByRole[0].length, picksByRole[1].length]
    clearResult()
    drawOverlay()
    void refresh()
    return true
  }

  /** 删除第 index 对点中的一侧（`role` = 哪一侧；行尾的 × 按钮）。 */
  function removePick(role: AlignedRole, index: number): void {
    if (!state.active || index < 0 || index >= picksByRole[role].length) return
    revokePreview()
    picksByRole[role].splice(index, 1)
    state.pickCounts = [picksByRole[0].length, picksByRole[1].length]
    clearResult()
    drawOverlay()
    void refresh()
  }

  /** 清空两侧全部拾取。 */
  function clearPicks(): void {
    if (!state.active) return
    revokePreview()
    picksByRole[0] = []
    picksByRole[1] = []
    state.pickCounts = [0, 0]
    clearResult()
    drawOverlay()
    rebuildRows()
  }

  /**
   * 设定谁"待对齐"（面板的角色切换 = 对调 data/model）。
   * 解出的变换方向随之反向，故旧结果一并作废重算。
   */
  function setRole(entityId: number): void {
    if (!state.active || state.computing) return
    if (entityId !== state.targetEntityIds[0] && entityId !== state.targetEntityIds[1]) return
    if (entityId === state.alignedEntityId) return
    revokePreview()
    state.alignedEntityId = entityId
    state.referenceEntityId =
      entityId === state.targetEntityIds[0] ? state.targetEntityIds[1] : state.targetEntityIds[0]
    clearResult()
    rebuildRows()
    void refresh()
  }

  /** 更新过滤器开关组（面板控件调用）：撤销预览 + 重算（RMS 会随过滤条件变）。 */
  function setOptions(patch: Partial<AlignOptions>): void {
    if (!state.active || state.computing) return
    const next = { ...state.options, ...patch }
    if (
      next.adjustScale === state.options.adjustScale &&
      next.rotFilterMode === state.options.rotFilterMode &&
      next.skipTx === state.options.skipTx &&
      next.skipTy === state.options.skipTy &&
      next.skipTz === state.options.skipTz
    ) {
      return
    }
    revokePreview()
    state.options = next
    void refresh()
  }

  /**
   * 预览（面板「对齐」）：把解出的变换临时施加到待对齐实体上（只改 Group 位姿，O(1)）。
   * 不锁相机——用户要能绕到侧面看是否贴合；「重置」还原、「确定」烘焙。
   */
  function align(): void {
    if (!state.active || state.computing) return
    if (!canPreview.value || !result || !result.ok) {
      logRegistration('尚无可用的解算结果：两侧各拾取相同的点数（≥ 3 对）后再对齐')
      return
    }
    const trans = toEntityTransform(result.r, result.t, result.s)
    const pcs = usePointCloudStore()
    if (!pcs.setEntityPreviewTransform(state.alignedEntityId, trans)) {
      logRegistration('待对齐的点云尚未加载完成，无法预览')
      return
    }
    state.previewed = true
    const name =
      sceneStore.getAllEntities().find((e) => e.id === state.alignedEntityId)?.name ?? String(state.alignedEntityId)
    logRegistration(
      `预览对齐：「${name}」已按 ${state.stats?.pairCount ?? 0} 对点搬动（RMS ${result.rms.toExponential(3)}），` +
        '确认无误后按「确定」烘焙'
    )
  }

  /** 重置：撤销预览（回到未对齐的样子），拾取与结果都保留。 */
  function reset(): void {
    if (!state.active || state.computing) return
    if (!state.previewed) return
    revokePreview()
    useViewerStore().getViewer()?.requestRender()
    logRegistration('已还原到对齐前的位姿（拾取点保留，可继续调整后重新「对齐」）')
  }

  /**
   * 确定：把预览的变换永久烘焙进待对齐实体的顶点缓冲（写时复制 + 包围体/八叉树重建，
   * 见 pointcloudStore.bakeEntityTransform），并按 CC 的惯例改名 `<名称>.registered`。
   * 烘焙后实体坐标已变、拾取坐标与顶点索引全部失效，故随即退出模态（偏差清单第 2 条）。
   */
  function applyAlign(): void {
    if (!state.active || state.computing || !state.previewed) return
    if (!result || !result.ok) return
    const pcs = usePointCloudStore()
    const name =
      sceneStore.getAllEntities().find((e) => e.id === state.alignedEntityId)?.name ?? String(state.alignedEntityId)
    const ok = pcs.bakeEntityTransform(state.alignedEntityId, toEntityTransform(result.r, result.t, result.s))
    if (!ok) {
      logRegistration('烘焙失败：待对齐的点云已不存在或尚未加载完成')
      return
    }
    state.previewed = false // 顶点缓冲已改，Group 也已被 bake 还原成基准位姿，无预览可撤
    logRegistration(
      `已对齐并烘焙：「${name}」→ 名称加后缀 .registered（RMS ${result.rms.toExponential(3)}，${
        state.stats?.pairCount ?? 0
      } 对点）`
    )
    exitAlign(true)
  }

  /**
   * 退出点对对齐模式（确定 / 取消 / Esc / 再次点击入口按钮共用）。
   * @param completed true = 确定（变换已烘焙，无需还原）；false = 取消（撤销预览）
   */
  function exitAlign(completed: boolean): void {
    if (!state.active) return
    if (!completed) revokePreview()
    if (overlay) {
      overlay.hide()
      useViewerStore().getViewer()?.requestRender()
    }
    const wasPicking = state.pickCounts[0] + state.pickCounts[1] > 0
    state.active = false
    state.computing = false
    state.previewed = false
    state.targetEntityIds = []
    state.alignedEntityId = 0
    state.referenceEntityId = 0
    state.pickCounts = [0, 0]
    state.rows = []
    state.stats = null
    picksByRole[0] = []
    picksByRole[1] = []
    clearResult()
    if (!completed) logRegistration(wasPicking ? '已取消点对对齐，点云已还原' : '已退出点对对齐模式')
  }

  // 原始值必须用 computed 包装返回（直接返回会固化成布尔值，解构后失去响应性）
  return {
    active: computed(() => state.active),
    targetEntityIds: computed(() => state.targetEntityIds),
    alignedEntityId: computed(() => state.alignedEntityId),
    referenceEntityId: computed(() => state.referenceEntityId),
    alignedRole,
    alignedCount,
    referenceCount,
    rows: computed(() => state.rows),
    stats: computed(() => state.stats),
    options: computed(() => state.options),
    computing: computed(() => state.computing),
    previewed: computed(() => state.previewed),
    canCompute,
    canPreview,
    startAlign,
    addPick,
    removePick,
    clearPicks,
    setRole,
    setOptions,
    align,
    reset,
    applyAlign,
    exitAlign,
  }
}
