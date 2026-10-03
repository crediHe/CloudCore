import { reactive, computed } from 'vue'
// 仅类型引用：store 不在运行时依赖 three（引擎实例从 getViewer() 拿）
import type { Vector3 } from 'three'
import type { ThreeViewer } from '../three/engine'
import type { ProjectionMode } from '../utils/cameraProjection'
import type { ViewName } from '../utils/viewDirections'
import { DEFAULT_PIVOT_VISIBILITY, nextPivotVisibility, type PivotVisibility } from '../utils/pivotVisibility'

/**
 * 3D 视图引擎实例与投影模式（模块级单例）。
 *
 * 引擎实例由 ThreeView.vue 挂载/卸载时注册；
 * 点云加载等场景操作通过它把对象加入场景。
 *
 * projection 与 pivotVisibility 是该单例里的两个响应式字段（UI 按钮高亮/图标
 * 依赖它们；引擎自身不读 store）。引擎创建时默认正射 + 旋转中心"仅旋转时显示"，
 * 故注册新实例时按 state 幂等拉齐一次，保证 HMR/重挂载后 UI 状态与引擎实际一致。
 */
let viewer: ThreeViewer | null = null

const state = reactive({
  projection: 'orthographic' as ProjectionMode,
  pivotVisibility: DEFAULT_PIVOT_VISIBILITY as PivotVisibility,
})

export function useViewerStore() {
  /** 注册（或注销）当前 3D 视图引擎实例。 */
  function registerViewer(instance: ThreeViewer | null) {
    viewer = instance
    // 引擎每次重建都回到默认值：注册时按记录的 state 幂等拉齐（默认值下为空操作）
    instance?.setProjection(state.projection)
    instance?.setPivotVisibility(state.pivotVisibility)
  }

  /** 获取当前 3D 视图引擎实例；3D 视图未挂载时为 null。 */
  function getViewer() {
    return viewer
  }

  /** 当前投影模式（透视/正射）。 */
  const projection = computed(() => state.projection)

  /** 当前旋转中心可见性档位。 */
  const pivotVisibility = computed(() => state.pivotVisibility)

  /**
   * 切换投影模式：先记录状态（引擎未挂载也成立），再同步引擎。
   * 注意 store 返回的原始值必须经 computed 包装（见 segmentStore 注释），
   * 否则解构后固化失去响应。
   */
  function setProjection(mode: ProjectionMode) {
    state.projection = mode
    viewer?.setProjection(mode)
  }

  /** 设置旋转中心可见性（三档，语义见 three/viewingPivot.ts）。 */
  function setPivotVisibility(mode: PivotVisibility) {
    state.pivotVisibility = mode
    viewer?.setPivotVisibility(mode)
  }

  /** 按 PIVOT_VISIBILITY_CYCLE 前进一档（工具栏按钮用，顺序见 utils/pivotVisibility.ts）。 */
  function cyclePivotVisibility() {
    setPivotVisibility(nextPivotVisibility(state.pivotVisibility))
  }

  /**
   * 把旋转中心设到世界点（双击点云拾取用）。
   * 两台相机会同步平移（见 engine.setPivot），故调用方只需给世界坐标。
   */
  function setPivot(p: Vector3) {
    viewer?.setPivot(p)
  }

  /**
   * 切到标准视角（前/后/左/右/上/下）。
   * 一次性动作、无 UI 持久状态（不像投影需要高亮/幂等拉齐），
   * 引擎未挂载（3D 视图未创建）时安全 no-op。
   */
  function setView(view: ViewName) {
    viewer?.setView(view)
  }

  /** 旋转中心复位到原点（一次性动作，同 setView 的约定）。 */
  function resetPivot() {
    viewer?.resetPivot()
  }

  return {
    registerViewer,
    getViewer,
    projection,
    pivotVisibility,
    setProjection,
    setPivotVisibility,
    cyclePivotVisibility,
    setPivot,
    setView,
    resetPivot,
  }
}
