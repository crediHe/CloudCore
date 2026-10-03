import { computed } from 'vue'
import { useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useAlgorithmModals } from './useAlgorithmModals'

/**
 * 「合并选中点云」这一条命令的**唯一实现**：可用性判据 + 动作。
 *
 * 先前它内联在 MenuBar 里，现在多了一个调用方（快捷键 Ctrl+M，见 composables/useAppShortcuts），
 * 于是提出来共用 —— 判据（≥2 个已加载完成的实体、且无算法模态在飞）若各写一份，迟早出现
 * "菜单说不能点、快捷键却照做"的分裂。
 */
export function useMergeSelection() {
  const sceneStore = useSceneStore()
  const { selection } = sceneStore
  const { mergeEntities } = usePointCloudStore()
  const { anyModalActive } = useAlgorithmModals()

  /**
   * 可用性：选中 ≥2 项且全部为已加载完成的点云实体，且无算法模态进行中
   * （分割与各算法都持有启动时的目标实体快照，合并会使其失效）。
   */
  const mergeState = computed<{ ok: boolean; reason: string }>(() => {
    if (anyModalActive()) {
      return { ok: false, reason: '分割 / 滤波 / 识别算法进行中不可合并' }
    }
    const sels = selection.value
    if (sels.length < 2) {
      return { ok: false, reason: '请先在 DB Tree 中 Ctrl+点击选中 ≥2 片点云' }
    }
    const all = sceneStore.getAllEntities()
    const entities = sels.map((s) => (s.type === 'entity' ? all.find((e) => e.id === s.id) : undefined))
    if (entities.some((e) => !e)) {
      return { ok: false, reason: '选中项含项目节点，请只选中点云实体' }
    }
    if (entities.some((e) => !e!.bbox)) {
      return { ok: false, reason: '存在尚未加载完成的点云，请稍候' }
    }
    return {
      ok: true,
      reason: '把选中的多片点云合并为一个实体（设置沿用最先点选的；带编号的物体合并后拿新编号与新色）',
    }
  })

  /** 执行合并；判据不满足时原地不动（与菜单项的 :disabled 同一判据）。 */
  function mergeSelection() {
    if (!mergeState.value.ok) return
    const ids = selection.value.filter((s) => s.type === 'entity').map((s) => s.id)
    mergeEntities(ids)
  }

  return { mergeState, mergeSelection }
}
