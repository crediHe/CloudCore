import { useDialog } from './useDialog'          // 文件对话框（调用 Electron 原生文件选择）
import { useSceneStore } from '../stores/sceneStore'       // 场景树状态管理
import { useConsoleStore } from '../stores/consoleStore'   // 控制台日志
import { useProgressStore } from '../stores/progressStore' // 全局进度条
import { getBasePoint, usePointCloudStore } from '../stores/pointcloudStore' // 点云数据存储

/**
 * "打开点云文件"统一入口。
 *
 * 菜单栏 Open 与工具栏打开按钮共用：弹出文件对话框，
 * 把选中的文件加入场景树，并向 Console 输出日志。
 * 加载期间显示全局进度条（遮幕禁止点击 + 动态进度）。
 */

/** 从路径取扩展名作为来源标签，如 LAS。 */
function extOf(path: string) {
  const ext = path.split('.').pop()
  return (ext || 'FILE').toUpperCase()
}

/** 打开点云文件统一入口核心逻辑。 */
export function useOpenPointCloud() {
  // ① 从各 store / composable 中取出所需方法
  const { openFile } = useDialog()
  const { addProjectFromPath } = useSceneStore()
  const { readPointCloud } = usePointCloudStore()
  const { log } = useConsoleStore()
  const progress = useProgressStore()

  // ② 定义打开点云的主函数
  async function openPointCloud() {
    // 注：LAZ（压缩 LAS）需 laz-perf 解压，暂未支持，故不放入过滤器
    const paths = await openFile({
      title: '打开点云文件',
      filters: [{ name: '点云文件', extensions: ['pcd', 'ply', 'xyz', 'las'] }],
    })
    if (!paths?.length) return

    // 全局进度条：遮幕禁止点击 + 动态进度；点云加载暂不支持取消，也不显示文字
    const task = progress.start({ modal: true })

    try {
      // 逐文件顺序加载：避免多文件并发解析导致内存峰值；进度跨文件累计
      // （整体进度 = 已加载文件数占比 + 当前文件内分块进度占比）。
      let loaded = 0
      for (const p of paths) {
        // 加入场景树（返回新建实体，把 id 传给加载器用于回填元数据）
        const entity = addProjectFromPath(p)

        // 每文件开始先切回不确定进度（PLY 首载的扫描包围盒阶段没有分块进度）
        task.update(null)
        await readPointCloud(p, entity.id, (lp) => {
          const overall = Math.floor(((loaded + lp.progress / 100) / paths.length) * 100)
          task.update(overall)
        })
        loaded++

        // 输出日志（共享基准点信息，首块加载时由 loadLargePly 建立）
        const bp = getBasePoint()
        const bpText = bp ? `(${bp.x.toFixed(2)}; ${bp.y.toFixed(2)}; ${bp.z.toFixed(2)})` : '(未设置)'
        log(extOf(p), `已加载，共享基准点: ${bpText}`)
      }
      task.done()
    } catch (error) {
      // 失败：进度条转红并停留，由用户点击"关闭"；同时输出错误日志
      const message = error instanceof Error ? error.message : String(error)
      task.fail(message)
      log('ERR', `加载点云失败: ${message}`)
    }
  }

  return { openPointCloud }
}
