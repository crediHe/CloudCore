import { ref } from 'vue'

/**
 * 通用分隔条拖拽 composable。
 *
 * 配合 SplitBar 组件使用：pointerdown 时捕获指针，
 * 拖动过程中把增量（dx/dy）通过回调交给调用方更新尺寸。
 * 横（调宽度）、纵（调高度）两种分隔条共用同一套逻辑。
 */
export function useDragResize(onDelta: (dx: number, dy: number) => void) {
  const dragging = ref(false)

  function onPointerDown(e: PointerEvent) {
    dragging.value = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging.value) return
    onDelta(e.movementX, e.movementY)
  }

  function onPointerUp() {
    dragging.value = false
  }

  return { dragging, onPointerDown, onPointerMove, onPointerUp }
}
