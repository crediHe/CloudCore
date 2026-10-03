import {
  LOD_OCTREE_DEFAULTS,
  type LodOctreeAddon,
  type LodOctreeChunkSource,
  type LodOctreeEntityResult,
} from '../utils/lodOctree'
import { loadNativeModule } from '../utils/nativeLoader'

/**
 * LOD 八叉树建树队列（渲染侧服务）。
 *
 * 为什么要有队列：native/lod-octree 的 `compute` 只维持**一个**活跃 worker，新调用会
 * 先把旧任务请退（addon.cc 的 `g_active->RequestCancel()`）。渲染侧却可能一次冒出一
 * 大批待建树的实体（TreeIso 一次切出上百棵树、按分类拆分），因此这里串行化——一次
 * 只发一个 compute，其余排队，绝不互相顶替。
 *
 * 建树**不阻塞任何东西**：树没就绪的实体会一直走显示层的等距取样回退（有画面、
 * 可拾取），树一到由 hooks.onReady 换装。这条回退路径也让"native 产物缺失"这种环境
 * 问题退化成"画面粗一些"，而不是白屏或卡死。
 *
 * 三条纪律：
 *  - **时效**：实体被删除 / 显示层被释放 → cancelLodTree 把在飞的 job 标记为 dropped，
 *    结果与错误一律不再回调（回调方若已换对象，写回去就是内存与画面的双重污染）。
 *  - **内存护栏**：每棵树的 pointIds 是 4 B/点，几百棵树叠加能吃掉几个 GB。预算在
 *    入队时按估算**预留**（含排队中的），超预算直接拒绝建树（该实体保持取样显示）。
 *  - **失败只报一次**：native 产物缺失是环境级失败，第一次就把整个通道标记为不可用，
 *    后续请求立即失败——避免每个实体都去踩一次 IPC + require。
 *
 * 本模块**不 import 任何 store**（three 层的依赖方向只有 three → utils，状态经 hooks 回调）。
 */

/** 单棵树的内存估算（pointIds 4 B/点 + 节点表，节点数约为点数 / 256，约 0.09 B/点）。 */
export const LOD_TREE_BYTES_PER_POINT = 4.1

/** 全部 LOD 树的估算内存预算（超出后新实体不再建树，停在取样回退路径）。 */
export const LOD_TREE_MEMORY_BUDGET = 512 * 1024 * 1024

/**
 * 建树失败原因分类——调用方据此决定"回退直绘"还是"保持取样显示"：
 *  - `unavailable`：模块加载/调用不了（没编译 native、产物缺失）。LOD 整条路不可用，
 *    该实体应回到语义层直绘，否则用户看到一朵被抽稀的云（像数据少了）；
 *  - `budget`：内存预算已满。显示层本身是好的，保持取样显示即可（成本仍与点数解耦）；
 *  - `compute`：算法异常（数据异常 / 内部 OOM）。同上，保持取样显示并记日志。
 */
export class LodTreeBuildError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'budget' | 'compute'
  ) {
    super(message)
    this.name = 'LodTreeBuildError'
  }
}

/** 建树回调（由调用方注入，见文件头"不 import store"）。 */
export interface LodTreeBuildHooks {
  /** 建树成功（节点数 > 0）。调用方负责把它装进对应显示层并置脏。 */
  onReady: (entityId: number, result: LodOctreeEntityResult) => void
  /** 建树失败 / 被拒绝（预算、环境、算法异常）。调用方据此决定是否回退直绘路径。 */
  onFailed: (entityId: number, error: Error) => void
  /** 进度（AsyncProgressWorker 按层回报，中间值可能被合并）。 */
  onProgress?: (entityId: number, overall: number, level: number) => void
}

interface LodTreeJob {
  entityId: number
  /** 入队时预留的估算字节（完成时按实际结果校正）。 */
  reservedBytes: number
  chunks: LodOctreeChunkSource[]
  hooks: LodTreeBuildHooks
  /** 已取消/被顶替：结果与错误一律丢弃（见文件头"时效"）。 */
  dropped: boolean
}

const queue: LodTreeJob[] = []
let inFlight: LodTreeJob | null = null
/** 已预留 / 已占用的树内存（含排队中的预留，完成时按实际值校正）。 */
let treeBytes = 0
let addon: LodOctreeAddon | null = null
let addonError: Error | null = null
let addonLoading: Promise<LodOctreeAddon> | null = null

/** 加载并缓存 addon；环境级失败只尝试一次（见文件头"失败只报一次"）。 */
function ensureAddon(): Promise<LodOctreeAddon> {
  if (addon) return Promise.resolve(addon)
  if (addonError) return Promise.reject(addonError)
  if (!addonLoading) {
    addonLoading = loadNativeModule<LodOctreeAddon>('lod_octree')
      .then((mod) => {
        addon = mod
        return mod
      })
      .catch((error: unknown) => {
        addonError = error instanceof Error ? error : new Error(String(error))
        throw addonError
      })
      .finally(() => {
        addonLoading = null
      })
  }
  return addonLoading
}

/**
 * 请求为某实体建树（同一实体重复请求会被忽略；native 缺失 / 超预算立即走 onFailed）。
 *
 * @param pointCount 该实体的可见点数（用于内存估算与预算判定）
 * @param chunks     逐块零拷贝候选源（positions + index，见 utils/lodOctree 的契约）
 */
export function enqueueLodTree(
  entityId: number,
  pointCount: number,
  chunks: LodOctreeChunkSource[],
  hooks: LodTreeBuildHooks
): void {
  if (inFlight?.entityId === entityId || queue.some((job) => job.entityId === entityId)) return
  if (addonError) {
    hooks.onFailed(entityId, addonError)
    return
  }
  const reservedBytes = Math.ceil(pointCount * LOD_TREE_BYTES_PER_POINT)
  if (treeBytes + reservedBytes > LOD_TREE_MEMORY_BUDGET) {
    hooks.onFailed(
      entityId,
      new LodTreeBuildError(
        `LOD 树内存预算已满（已用 ${(treeBytes / 1048576).toFixed(0)} MB / ` +
          `${(LOD_TREE_MEMORY_BUDGET / 1048576).toFixed(0)} MB），该实体保持取样显示`,
        'budget'
      )
    )
    return
  }
  treeBytes += reservedBytes
  queue.push({ entityId, reservedBytes, chunks, hooks, dropped: false })
  void pump()
}

/**
 * 取消某实体的建树（排队中直接移除；在飞的请 native 取消，回调按 dropped 丢弃后续队）。
 * 显示层释放 / 实体删除时必须调用，否则在飞的 job 会把结果写回一个已消失的对象。
 */
export function cancelLodTree(entityId: number): void {
  const index = queue.findIndex((job) => job.entityId === entityId)
  if (index >= 0) {
    const [job] = queue.splice(index, 1)
    treeBytes -= job.reservedBytes
    job.dropped = true
    return
  }
  if (inFlight?.entityId === entityId) {
    inFlight.dropped = true
    addon?.cancel()
  }
}

/** 队列与内存状态（调试 / 日志用）。 */
export function lodTreeBuilderStats(): { queued: number; inFlight: boolean; usedMb: number } {
  return { queued: queue.length, inFlight: inFlight !== null, usedMb: treeBytes / 1048576 }
}

/** 依次执行队列（一次一个，见文件头）。 */
async function pump(): Promise<void> {
  if (inFlight || queue.length === 0) return
  const job = queue.shift() as LodTreeJob
  inFlight = job

  let mod: LodOctreeAddon
  try {
    mod = await ensureAddon()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    finish(job, null, new LodTreeBuildError(message, 'unavailable'))
    return
  }
  // 加载期间可能已被取消（实体删了）——不必再发起计算
  if (job.dropped) {
    finish(job, null, null)
    return
  }

  mod.compute(
    {
      entities: [{ entityId: job.entityId, chunks: job.chunks }],
      maxPointsPerCell: LOD_OCTREE_DEFAULTS.maxPointsPerCell,
      maxLevel: LOD_OCTREE_DEFAULTS.maxLevel,
    },
    (progress) => {
      if (!job.dropped) job.hooks.onProgress?.(job.entityId, progress.overall, progress.level)
    },
    (error, results) => {
      const result = results?.[0]
      if (error) {
        finish(job, null, new LodTreeBuildError(error.message, 'compute'))
      } else if (!result) {
        finish(job, null, new LodTreeBuildError('建树未返回结果', 'compute'))
      } else if (result.nodeCount === 0) {
        finish(job, null, new LodTreeBuildError('该实体没有可建树的点（坐标全部无效）', 'compute'))
      } else {
        finish(job, result, null)
      }
    }
  )
}

/** 收尾一个 job：校正内存账、回调（被丢弃则静默）、续队。 */
function finish(job: LodTreeJob, result: LodOctreeEntityResult | null, error: Error | null): void {
  inFlight = null
  // 内存账校正：失败/取消归还预留，成功换成实际占用
  treeBytes -= job.reservedBytes
  if (result && !job.dropped) {
    // 节点表 30 B/节点（childBase 4 + childMask 1 + pointStart 4 + pointCount 4 + center 12 + size 4 + level 1）
    treeBytes += result.pointIds.length * 4 + result.nodeCount * 30
  }
  if (!job.dropped) {
    if (result) job.hooks.onReady(job.entityId, result)
    else if (error) job.hooks.onFailed(job.entityId, error)
  }
  void pump()
}
