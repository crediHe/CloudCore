import { useDialog } from './useDialog'
import { useAlgorithmModals } from './useAlgorithmModals'
import { useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useConsoleStore } from '../stores/consoleStore'
import { useProgressStore } from '../stores/progressStore'
import { resolveNormalSelection } from '../stores/normalStore'
import { SAVE_BATCH_POINTS, defaultSaveName, type SaveBatch } from '../utils/pointcloudSave'
import { LAS_12_MAX_CLASSIFICATION, type SaveFormat } from '../../shared/types/pointcloud-save'

/**
 * `File ▸ Save as…`：把**恰好一个**已加载完成的实体写成 PLY（二进制）/ LAS 1.2（未压缩）。
 *
 * 与读侧严格对称的分块流式：save-begin（主进程开文件写头部）→ save-chunk × N →
 * save-end（LAS 回填精确包围盒）。每批 SAVE_BATCH_POINTS 点之间让出主线程，故 1 亿点
 * 也不卡界面；进度按已写点数上报，可取消（取消 = save-abort 删半成品文件，不留
 * truncate 的 .las / .ply）。
 *
 * 六处会静默出错的地方（都已在此处或更底层挡住）：
 * 1. **可见子集由 index 圈定** —— 取数一律走 pointcloudStore.getSaveBatch
 *    （分割 / 滤波 / 配准产物与源实体共享顶点缓冲，按 positions 全量取会把整片云写出去）。
 * 2. **坐标要加回基准点** —— 内存里是显示坐标，计划里的 basePoint 交给主进程加回去。
 * 3. **颜色是线性值** —— 渲染侧转成 sRGB 字节再进 IPC（buildSaveBatch 内部完成）。
 * 4. **LAS 分类越界（> 31）必须拒绝** —— 1.2 的分类字段只有低 5 位，写进去静默丢高位；
 *    这里在开始前扫一遍，明确报错并建议改用 PLY。
 * 5. **保存前退出算法模态** —— 预览型模态（分割 / 滤波 / RANSAC / 聚类）活着时改的正是
 *    `geometry.index`，此时保存会存下"预览的一半"。
 * 6. **每点 treeid 写的是实体的物体编号** —— 由 getSaveBatch 塞进 `treeIdOverride`
 *    （分割 / 合并后顶点缓冲里那份从输入文件读来的旧属性已经不描述现状），故本仓库
 *    产出的文件里 treeid 恒等于导出实体的编号。
 */

/** 取消信号（进度条 onCancel 置位后由写盘循环抛出）。 */
class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

/** 由文件扩展名定格式；对话框已限制过滤器，兜底按 PLY（无损布局）。 */
function formatOfExtension(path: string): SaveFormat {
  return path.toLowerCase().endsWith('.las') ? 'las' : 'ply'
}

/** 把一批数据经 IPC 交给主进程（TypedArray 经结构化克隆过去，主进程侧按 Buffer 读）。 */
async function sendBatch(batch: SaveBatch, sessionId: string): Promise<void> {
  await window.electronAPI.pointCloudSave.chunk({
    sessionId,
    pointCount: batch.pointCount,
    positions: batch.positions,
    colors: batch.colors,
    classification: batch.classification,
    treeIds: batch.treeIds,
  })
}

/**
 * 保存主流程（File ▸ Save as… 菜单项的唯一入口）。
 *
 * @param entityIdOverride 指定实体（测试 / 将来批量导出用）；省略则取当前选中项
 */
export async function savePointCloudAs(entityIdOverride?: number): Promise<void> {
  const sceneStore = useSceneStore()
  const pcs = usePointCloudStore()
  const { log } = useConsoleStore()
  const progress = useProgressStore()
  const { saveFile } = useDialog()

  // 1. 解析目标：复用 normalStore 的多选摊平（项目 / 树组 / 实体三态），要求**恰好 1 个**
  const all = sceneStore.getAllEntities()
  const ids = entityIdOverride !== undefined ? [entityIdOverride] : resolveNormalSelection(sceneStore.selection.value)
  const loaded = ids.filter((id) => {
    const e = all.find((x) => x.id === id)
    return !!e && !!e.bbox && !!e.globalShift
  })
  if (loaded.length !== 1) {
    log('ERR', loaded.length === 0 ? '保存失败：未选中已加载完成的点云' : '保存失败：请只选中一片点云')
    return
  }
  const entityId = loaded[0]
  const entity = all.find((e) => e.id === entityId)!
  const plan = pcs.getSavePlan(entityId)
  if (!plan || plan.totalPoints === 0) {
    log('ERR', `保存失败：${entity.name} 没有可写出的点`)
    return
  }

  // 2. 退出算法模态（决定 5）：预览态改的正是 geometry.index，存下去的会是"预览的一半"
  useAlgorithmModals().exitOtherModals()

  // 3. 选路径与格式
  const path = await saveFile({
    title: '另存为点云',
    defaultPath: defaultSaveName(entity.name, 'ply'),
    filters: [
      { name: 'PLY 二进制点云', extensions: ['ply'] },
      { name: 'LAS 1.2 点云（未压缩）', extensions: ['las'] },
    ],
  })
  if (!path) return

  const format = formatOfExtension(path)

  // 4. LAS 分类越界闸门（决定 4）：不静默截断，直接拒绝并给出替代方案
  if (format === 'las') {
    const maxClass = pcs.getSaveClassificationMax(entityId)
    if (maxClass > LAS_12_MAX_CLASSIFICATION) {
      const message =
        `LAS 1.2 的分类字段只有低 5 位（最大 ${LAS_12_MAX_CLASSIFICATION}），当前点云含分类 ${maxClass}，` +
        '写入会静默丢高位。请改用 PLY 保存（分类为完整 8 位，无损）。'
      log('ERR', `保存失败：${message}`)
      void window.electronAPI.notification.show('另存为失败', message)
      return
    }
  }

  // 5. 分块写盘：begin → chunk × N → end；任何一步失败或取消都 abort（删半成品文件）
  let cancelled = false
  const task = progress.start({
    modal: true,
    cancellable: true,
    title: `另存为 ${format.toUpperCase()}`,
    message: `${entity.name}（${plan.totalPoints.toLocaleString()} 点）`,
    onCancel: () => {
      cancelled = true
    },
  })
  let sessionId: string | null = null
  const startedAt = performance.now()

  try {
    const begun = await window.electronAPI.pointCloudSave.begin({
      path,
      format,
      pointCount: plan.totalPoints,
      basePoint: plan.basePoint,
      bbox: plan.bbox,
      hasColor: plan.hasColor,
    })
    sessionId = begun.sessionId

    let written = 0
    for (const chunk of plan.chunks) {
      for (let start = 0; start < chunk.points; start += SAVE_BATCH_POINTS) {
        if (cancelled) throw new CancelledError()
        const batch = pcs.getSaveBatch(entityId, chunk.index, start, Math.min(SAVE_BATCH_POINTS, chunk.points - start))
        // 计划与几何体在保存期间不一致（块被换装 / 释放）时干净失败，绝不写出错位的点
        if (!batch) throw new Error(`第 ${chunk.index} 块取数失败（点云在保存期间被改动）`)
        await sendBatch(batch, sessionId)
        written += batch.pointCount
        task.update(Math.floor((written / plan.totalPoints) * 100))
        // 让出主线程：1 亿点 = 200 批，期间界面仍可响应（含"取消"按钮）
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    if (written !== plan.totalPoints) {
      throw new Error(`点数不一致：计划 ${plan.totalPoints}，实写 ${written}`)
    }

    const done = await window.electronAPI.pointCloudSave.end({ sessionId })
    task.done()
    log(
      'Save',
      `${entity.name} 已保存为 ${format.toUpperCase()}：${done.points.toLocaleString()} 点，` +
        `${(done.bytes / 1024 / 1024).toFixed(2)} MB，耗时 ${((performance.now() - startedAt) / 1000).toFixed(1)} s → ${done.path}`
    )
  } catch (error) {
    // 取消与失败都要删半成品：会话已开始时 abort；abort 自身失败不覆盖原始错误
    if (sessionId) {
      try {
        await window.electronAPI.pointCloudSave.abort({ sessionId })
      } catch {
        // 主进程侧已尽力清理并记日志
      }
    }
    if (error instanceof CancelledError) {
      task.cancel()
      log('Save', `已取消保存 ${entity.name}`)
    } else {
      const message = error instanceof Error ? error.message : String(error)
      task.fail(message)
      log('ERR', `保存失败: ${message}`)
    }
  }
}

/**
 * 「另存为」可用性判据（菜单绑定 disabled / title 用；与 `mergeState` / `normalsComputeState` 同形）。
 *
 * 两条硬条件：没有算法模态在进行中（它们的预览改的正是要写出的 index）；
 * 摊平后**恰好 1 个**已加载完成的实体（保存是单实体操作）。
 */
export function savePointCloudState(): { ok: boolean; reason: string } {
  const { anyModalActive } = useAlgorithmModals()
  if (anyModalActive()) {
    return { ok: false, reason: '分割 / 滤波 / 拟合 / 配准进行中不可保存，请先确定或退出' }
  }
  const all = useSceneStore().getAllEntities()
  const ids = resolveNormalSelection(useSceneStore().selection.value)
  const loaded = ids.filter((id) => {
    const e = all.find((x) => x.id === id)
    return !!e && !!e.bbox && !!e.globalShift
  })
  if (loaded.length === 0) return { ok: false, reason: '请先在 DB Tree 中选中一片已加载完成的点云' }
  if (loaded.length > 1) return { ok: false, reason: '一次只能保存一片点云，请只选中一个实体' }
  const entity = all.find((e) => e.id === loaded[0])!
  return { ok: true, reason: `把 ${entity.name} 另存为 PLY（二进制）或 LAS 1.2（未压缩）` }
}
