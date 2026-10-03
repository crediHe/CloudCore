import { reactive, computed } from 'vue'
import { useConsoleStore } from './consoleStore'
import { MEASURE_CAPACITY, buildMeasureResult } from '../utils/measure'
import type { MeasureMode, PickedPoint } from '../utils/measure'

/**
 * 点云测量状态（模块级单例）。
 *
 * 仿 CloudCompare 的 "Point picking"（ccPointPropertiesDlg）：单点信息 /
 * 两点距离 / 三点角度三种模式，在 3D 视图里点击点云拾取顶点并实时给出结果。
 *
 * 与分割模式的差异（有意，注释见各 action）：
 *  - 无目标快照：拾取面向**视图内全部可见点云**、可跨对象（前遮挡后），故不需要
 *    targetEntityIds，也不需要分割那套「先选对象才能进入」的前置校验；
 *  - 单一结果组：凑满点数后再拾取一次即丢弃整组重开（CC 语义），
 *    因此没有"确定/应用"这一步。
 *
 * 状态被 ToolBar（按钮高亮）、MeasureToolBar（浮条显隐/计数）、
 * useMeasureInteraction（拾取写入）共享，因此不放在组件内部。
 * 拾取到的标记点/连线/标签等 THREE 对象不放这里——组合式函数自己持有并随模式存活。
 */

const state = reactive({
  /** 是否处于测量模式。 */
  active: false,
  /** 当前测量模式（默认单点信息）。 */
  mode: 'point' as MeasureMode,
  /** 已拾取的点（按点击顺序）。每次写入都换新数组，交互层的浅 watch 依赖此语义。 */
  picked: [] as PickedPoint[],
})

export function useMeasureStore() {
  const { log } = useConsoleStore()

  /** 进入测量模式（拾取全局，无需选中对象，故无前置校验）。 */
  function startMeasure() {
    if (state.active) return
    state.active = true
    state.picked = []
    log('Measure', '进入测量模式：在点云上点击拾取（1 点信息 / 2 点距离 / 3 点角度）')
  }

  /**
   * 退出测量模式（浮条退出按钮 / Esc / 与分割及其他模态互斥时调用）。
   *
   * 有意不带 `segmentStore.exitSegment(completed)` 那样的 completed 形参：
   * 测量没有"确定/应用"这一步，退出即清除全部拾取，不存在需要区分的收尾分支。
   */
  function exitMeasure() {
    if (!state.active) return
    state.active = false
    state.picked = []
    log('Measure', '已退出测量模式')
  }

  /** 切换测量模式：清空已拾取的点（换模式后旧点数量与语义都不再匹配）。 */
  function setMode(mode: MeasureMode) {
    if (state.mode === mode) return
    state.mode = mode
    state.picked = []
  }

  /**
   * 写入一个拾取点（唯一的保留规则 + 唯一的日志触发点）。
   *
   * 未满员则追加；**已满员则以本次拾取重开一组**（CC：凑满点数后再点一次就丢弃
   * 整组）。重开后未满员、故不产日志——只有"完成的一次测量"恰好写一行。
   * 拾取落空由交互层直接返回、不调用本函数，因此空点既不打日志也不重置已满的一组。
   */
  function pick(p: PickedPoint) {
    const cap = MEASURE_CAPACITY[state.mode]
    state.picked = state.picked.length < cap ? [...state.picked, p] : [p]
    const result = buildMeasureResult(state.mode, state.picked)
    if (result) log('Measure', result.summary)
  }

  /** 清除当前拾取结果（不退出模式）。 */
  function clearPicked() {
    state.picked = []
  }

  // 注意：原始值必须用 computed 包装返回，直接返回 state.active 会在
  // 解构时固化成布尔值，失去响应性（组件里 v-if 永远不更新）。
  return {
    active: computed(() => state.active),
    mode: computed(() => state.mode),
    picked: computed(() => state.picked),
    /** 当前模式下完成一次测量所需的点数。 */
    capacity: computed(() => MEASURE_CAPACITY[state.mode]),
    /** 是否已凑满一组（决定"清除"按钮可用与浮条计数显示）。 */
    isFull: computed(() => state.picked.length >= MEASURE_CAPACITY[state.mode]),
    /** 当前完成的结果，未满员为 null。 */
    result: computed(() => buildMeasureResult(state.mode, state.picked)),
    startMeasure,
    exitMeasure,
    setMode,
    pick,
    clearPicked,
  }
}

export type { MeasureMode, PickedPoint }
