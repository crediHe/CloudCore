<script setup lang="ts">
import { useDragResize } from '../composables/useDragResize'

/**
 * 通用分隔条。
 * axis="horizontal"：竖条，拖动调整左右两侧宽度（cursor: col-resize）
 * axis="vertical"：横条，拖动调整上下两侧高度（cursor: row-resize）
 */
const props = withDefaults(defineProps<{ axis?: 'horizontal' | 'vertical' }>(), {
  axis: 'horizontal',
})

const emit = defineEmits<{ (e: 'drag', dx: number, dy: number): void }>()

const { dragging, onPointerDown, onPointerMove, onPointerUp } = useDragResize((dx, dy) => {
  emit('drag', dx, dy)
})
</script>

<template>
  <div
    class="split-bar"
    :class="[`split-bar--${props.axis}`, { 'split-bar--dragging': dragging }]"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  ></div>
</template>

<style scoped>
.split-bar {
  flex-shrink: 0;
  background: transparent;
  transition: background 150ms ease;
  z-index: 1;
}
.split-bar:hover,
.split-bar--dragging {
  background: var(--md-primary-container);
}
.split-bar--horizontal {
  width: 5px;
  cursor: col-resize;
}
.split-bar--vertical {
  height: 5px;
  cursor: row-resize;
}
</style>
