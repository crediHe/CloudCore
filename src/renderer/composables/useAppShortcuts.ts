import { onMounted, onUnmounted } from 'vue'
import { findShortcut, type ShortcutId } from '../utils/appShortcuts'
import { isTypingInInput } from './useLocalShortcut'
import { useOpenPointCloud } from './useOpenPointCloud'
import { savePointCloudAs, savePointCloudState } from './useSavePointCloud'
import { useAlgorithmModals } from './useAlgorithmModals'
import { useMergeSelection } from './useMergeSelection'
import { useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useViewerStore } from '../stores/viewerStore'
import { useSegmentStore } from '../stores/segmentStore'
import { useMeasureStore } from '../stores/measureStore'
import { resolveNormalSelection } from '../stores/normalStore'
import type { ViewName } from '../utils/viewDirections'

/**
 * 应用级快捷键宿主：**一个** window keydown 监听，把命中的组合分派到既有命令上。
 *
 * 三条纪律：
 * 1. **不新增命令实现**：每一项都调用既有入口（openPointCloud / savePointCloudAs /
 *    mergeSelection / exitOtherModals / deleteXxx / fitViewTo / setView）。菜单里能点的
 *    与键盘上能按的必然是同一份代码，判据（如"恰好 1 个实体才能另存为"）也只写一遍。
 * 2. **不抢输入框的键**：焦点在 input / textarea / select / contenteditable 里时一律让位
 *    （复用 useLocalShortcut 的 isTypingInInput）。
 * 3. **不越权**：设置路由下工作区虽被 `v-show` 藏起但组件仍在、监听仍在，故按路由让位。
 *
 * 组合键表（含菜单要显示的提示文案）在 utils/appShortcuts，本文件只负责落地。
 */
export function useAppShortcuts() {
  const { openPointCloud } = useOpenPointCloud()
  const { mergeSelection } = useMergeSelection()
  const { exitOtherModals, anyModalActive } = useAlgorithmModals()
  const { setView } = useViewerStore()
  const sceneStore = useSceneStore()
  const pointCloudStore = usePointCloudStore()
  // 分割 / 测量不在算法模态表里（是拾取交互而非算法模态），Delete 的让位判据要把它们算上
  const { active: segmentActive } = useSegmentStore()
  const { active: measureActive } = useMeasureStore()

  const VIEW_BY_ID: Partial<Record<ShortcutId, ViewName>> = {
    viewFront: 'front',
    viewBack: 'back',
    viewLeft: 'left',
    viewRight: 'right',
    viewTop: 'top',
    viewBottom: 'bottom',
  }

  /**
   * 删除选中项（Delete 键）：与场景树右键菜单的 Delete 同语义、同实现
   * （SceneTree 的 onDelete 逐个分派到以下三个删除函数）。
   *
   * 顺序与重查都是必要的：**项目与它下面的实体可能同时被选中**（选中集是独立记录的），
   * 先删项目再按 id 删实体就会走到已释放的记录上。故按"项目 → 容器 → 实体"从大到小删，
   * 每一步删前重新确认目标还在——重叠选择自然被消化掉，也不会误删别人的子实体。
   *
   * 刻意**不加二次确认**：与右键菜单的删除保持一致（两个入口弹出不同的确认行为
   * 比没有确认更让人措手不及）。真要加，应在 SceneTree 与这里同时加。
   */
  function deleteSelection() {
    const sels = [...sceneStore.selection.value]
    if (sels.length === 0) return
    // 存在性判据每次现查（不拍快照）：上一轮级联删除刚移除的实体，这一轮就不该再动
    const entityExists = (id: number) => sceneStore.getAllEntities().some((e) => e.id === id)

    for (const sel of sels) {
      if (sel.type === 'project' && sceneStore.projects.some((p) => p.id === sel.id)) {
        pointCloudStore.deleteProject(sel.id)
      }
    }
    for (const sel of sels) {
      if (sel.type === 'treegroup' && sceneStore.treeGroupById(sel.id)) {
        pointCloudStore.deleteTreeGroup(sel.id)
      }
    }
    for (const sel of sels) {
      if (sel.type === 'entity' && entityExists(sel.id)) {
        pointCloudStore.deleteEntity(sel.id)
      }
    }
  }

  /** 缩放到选中：多选 / 项目 / 容器都摊成实体 id（复用 normalStore 那唯一一处多选解析）。 */
  function fitSelected() {
    const ids = resolveNormalSelection(sceneStore.selection.value)
    if (ids.length === 0) return
    pointCloudStore.fitViewTo(ids)
  }

  function run(id: ShortcutId) {
    switch (id) {
      case 'open':
        void openPointCloud()
        break
      case 'saveAs':
        // 判据与 File ▸ Save as… 同源：不满足就什么都不做（菜单项此刻也是灰的）
        if (savePointCloudState().ok) void savePointCloudAs()
        break
      case 'merge':
        mergeSelection()
        break
      case 'exitModal':
        exitOtherModals()
        break
      case 'deleteSelection':
        // 有模态在飞时忽略：分割 / 测量 / 算法预览都持有目标实体的快照与缓冲引用，
        // 把实体从它们脚下删掉会留下悬空引用（右键菜单那条路同样允许这么做，但那是
        // "打开菜单再点"的刻意动作，键盘误触的概率高得多，所以这里偏保守）
        if (!anyModalActive() && !segmentActive.value && !measureActive.value) deleteSelection()
        break
      case 'fitAll':
        pointCloudStore.fitViewTo()
        break
      case 'fitSelected':
        fitSelected()
        break
      default: {
        const view = VIEW_BY_ID[id]
        if (view) setView(view)
      }
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTypingInInput(event)) return
    if (window.location.hash.startsWith('#/settings')) return
    const id = findShortcut(event)
    if (!id) return
    // 命中即拦下：Ctrl+S / Ctrl+O 在 Electron 里本就无默认行为，但 F / Home / Delete
    // 在某些焦点状态下会触发滚动或"历史前进"，拦住它们才是可预期的行为
    event.preventDefault()
    run(id)
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
}
