import { reactive, computed } from 'vue'
import { useSceneStore } from './sceneStore'
import { useConsoleStore } from './consoleStore'
import { usePointCloudStore } from './pointcloudStore'
import type { ChunkSelection } from '../utils/segmentSelection'

/**
 * 分割模式状态（模块级单例）。
 *
 * 仿 CloudCompare 的"分割"模态交互：从工具栏进入分割模式后，
 * 3D 视图右上角浮出横条工具栏，用户选择形状（多边形/四边形）、
 * 选区（选区内/选取外）后在点云上绘制图形。
 *
 * 该状态被 ToolBar（按钮高亮/禁用）、SegmentToolBar（横条显隐/按钮状态）、
 * 未来的 ThreeView 绘制交互（锁定相机、挂事件）共享，因此不放在组件内部。
 */

/** 绘制形状类型：四边形（拖拽矩形框选）/ 自由多边形（左键加点、右键闭合）。 */
export type SegmentShape = 'polygon' | 'quadrangle'

/** 选区模式：选区内（正向提取）/ 选取外（反向提取，即取补集）。 */
export type SegmentMode = 'inside' | 'outside'

const state = reactive({
  /** 是否处于分割模式。 */
  active: false,
  /** 当前绘制形状（默认四边形）。 */
  shape: 'quadrangle' as SegmentShape,
  /** 当前选区模式（默认选区内）。 */
  mode: 'inside' as SegmentMode,
  /**
   * 进入模式时快照的目标实体 ID 列表（选中项目 → 其所有子实体；
   * 选中实体 → 仅它自己；已过滤未加载实体）。模式期间场景树选中变化不影响目标。
   */
  targetEntityIds: [] as number[],
  /** 是否已绘制出有效选区（四边形拖拽完成 / 多边形右键闭合；决定选区切换按钮可用）。 */
  hasRect: false,
  /**
   * 是否已选定选区模式（选区内/选取外）。
   * 绘制完成只解锁选区切换；选定模式并应用预览后，确定按钮才可用、相机才解锁。
   */
  modeChosen: false,
})

/**
 * 选区结果缓存（entityId → 各块 ChunkSelection），mouseup 计算一次，预览切换
 * 只 swap 索引。刻意不进 reactive：Uint32Array 被深度代理会拖慢甚至破坏渲染。
 */
let selectionCache: Map<number, ChunkSelection[]> | null = null

export function useSegmentStore() {
  const { selectedNode, selectNode } = useSceneStore()
  const { log } = useConsoleStore()

  /**
   * 从工具栏进入分割模式：解析当前选中节点为目标实体快照。
   * 无选中时直接返回（工具栏按钮已禁用，此处仅防御）；
   * 目标全部未加载完成（无渲染记录）时提示并拒绝进入。
   */
  function startSegment() {
    const node = selectedNode.value
    if (!node) return
    const candidates = node.type === 'project' ? node.entities.map((e) => e.id) : [node.id]
    // 过滤尚未加载完成的实体（无 cloudRecord 无法索引/分割）
    const targets = usePointCloudStore().getSegmentTargets(candidates)
    if (targets.length === 0) {
      log('Segment', '选中的点云尚未加载完成，无法分割')
      return
    }
    state.targetEntityIds = targets.map((t) => t.entityId)
    state.active = true
    log('Segment', `进入分割模式，目标 ${state.targetEntityIds.length} 块点云`)
  }

  /**
   * 退出分割模式（确定/取消/再次点击 segment 按钮共用）。
   * @param completed true=确定（应用分割）；false=取消（丢弃，还原索引）。
   */
  function exitSegment(completed: boolean) {
    if (!state.active) return
    if (!completed) {
      // 取消：还原全部目标实体的索引渲染（未绘制的实体还原无副作用）
      for (const entityId of state.targetEntityIds) {
        usePointCloudStore().setChunkVisibility(entityId, null)
      }
    }
    state.active = false
    state.hasRect = false
    state.modeChosen = false
    state.targetEntityIds = []
    selectionCache = null
    log('Segment', completed ? '分割确定，已生成 segmented / remaining 实体' : '已取消分割，点云已还原')
  }

  /** 切换绘制形状（多边形/四边形）：先清除未确定选区（切形状即重画）。 */
  function setShape(shape: SegmentShape) {
    resetSelection()
    state.shape = shape
  }

  /**
   * 清除当前选区，回到可重画状态（刷新按钮 / Esc / 切形状共用）。
   * 顺带还原已应用的预览索引（防御性；当前刷新只在未选定选区模式时可用，索引未应用）。
   */
  function resetSelection() {
    selectionCache = null
    if (state.hasRect) {
      for (const entityId of state.targetEntityIds) {
        usePointCloudStore().setChunkVisibility(entityId, null)
      }
    }
    state.hasRect = false
    state.modeChosen = false
  }

  /**
   * 切换选区模式（选区内/选取外）。
   * 已有矩形时首次选择即"选定模式"：应用预览，此后确定可用、相机解锁。
   */
  function setMode(mode: SegmentMode) {
    state.mode = mode
    if (state.hasRect) {
      state.modeChosen = true
      applyPreview()
    }
  }

  /** 标记选区已绘制完成（交互层 mouseup / 右键闭合后调用）；清除选区时还原状态。 */
  function setHasRect(has: boolean) {
    state.hasRect = has
    if (!has) {
      state.modeChosen = false
    }
  }

  /** 交互层 mouseup 后写入选区结果缓存（applyPreview / applySegment 消费）。 */
  function storeSelection(selections: Map<number, ChunkSelection[]>) {
    selectionCache = selections
  }

  /**
   * 应用预览：按当前选区模式把各实体切到 inside/outside 索引（瞬时，零拷贝）。
   * 预览期强制目标可见（pointcloudStore.beginSegmentPreview 已处理）。
   */
  function applyPreview() {
    if (!selectionCache) return
    const pcs = usePointCloudStore()
    for (const [entityId, sels] of selectionCache) {
      const indices = sels.map((s) => (state.mode === 'inside' ? s.inside : s.outside))
      pcs.setChunkVisibility(entityId, indices)
    }
  }

  /**
   * 确定分割：校验选区非空 → 逐实体 splitEntity → 自动选中第一个 `.segmented`
   * 新实体（否则选中指向已删实体变 null，属性面板空白）→ 退出模式。
   */
  function applySegment() {
    if (!selectionCache) return
    // 空选择校验：mode 对应部分总点数为 0 → 分割会产出空点云，阻止并提示
    for (const sels of selectionCache.values()) {
      const total = sels.reduce((sum, s) => sum + (state.mode === 'inside' ? s.inside.length : s.outside.length), 0)
      if (total === 0) {
        log('Segment', '选区无效：未覆盖任何点或覆盖了全部点，请重新绘制后再确定')
        return
      }
    }
    const pcs = usePointCloudStore()
    let firstSegmentedId: number | null = null
    for (const [entityId, sels] of selectionCache) {
      // deriveIds：分割工具切的是**物体**（"把一棵树切成两棵"）——两片各拿新编号 +
      // 父色同族两档（亮 = 选区内、暗 = 选区外）。滤波 / CSF / RANSAC 走同一个函数但
      // 不传这个开关：那些产物是"数据块"，不该占号（见 pointcloudStore.splitEntity）。
      const result = pcs.splitEntity(entityId, sels, undefined, { deriveIds: true })
      if (result && firstSegmentedId === null) {
        firstSegmentedId = result.firstId
      }
    }
    if (firstSegmentedId !== null) {
      selectNode({ type: 'entity', id: firstSegmentedId })
    }
    exitSegment(true)
  }

  // 注意：原始值必须用 computed 包装返回，直接返回 state.active 会在
  // 解构时固化成布尔值，失去响应性（组件里 v-if 永远不更新）。
  return {
    active: computed(() => state.active),
    shape: computed(() => state.shape),
    mode: computed(() => state.mode),
    targetEntityIds: computed(() => state.targetEntityIds),
    hasRect: computed(() => state.hasRect),
    modeChosen: computed(() => state.modeChosen),
    startSegment,
    exitSegment,
    setShape,
    resetSelection,
    setMode,
    setHasRect,
    storeSelection,
    applyPreview,
    applySegment,
  }
}
