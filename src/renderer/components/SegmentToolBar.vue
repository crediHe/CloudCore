<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSegmentStore } from '../stores/segmentStore'
import type { SegmentShape } from '../stores/segmentStore'

/**
 * 分割模式横条工具栏（浮层，3D 视图区右上角）。
 *
 * 点击工具栏 segment 按钮后显示：形状下拉（多边形/四边形）+ 选区
 * （选区内/选取外）+ 刷新 + 确定/取消。组件不接收 props，状态全部来自
 * segmentStore，为将来同类"横条工具栏"复用保留形状（换个组件即可）。
 */

const { active, shape, mode, hasRect, modeChosen, setShape, setMode, resetSelection, applySegment, exitSegment } =
  useSegmentStore()

/** 横条根元素（点击外部判定用；v-if 未挂载时为 null）。 */
const barRef = ref<HTMLElement | null>(null)

/** 形状下拉是否展开。 */
const dropdownOpen = ref(false)

const SHAPE_LABELS: Record<SegmentShape, string> = {
  polygon: '多边形',
  quadrangle: '四边形',
}

/** 选择形状并收起下拉（切换即清除未确定选区，重新绘制）。 */
function chooseShape(s: SegmentShape) {
  setShape(s)
  dropdownOpen.value = false
}

/** 点击组件外部时收起下拉。 */
function onDocumentClick(e: MouseEvent) {
  if (barRef.value && !barRef.value.contains(e.target as Node)) {
    dropdownOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onUnmounted(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <div v-if="active" ref="barRef" class="segment-bar">
    <!-- 形状下拉 -->
    <div class="seg-group">
      <button class="seg-btn seg-btn--dropdown" title="选择绘制形状" @click="dropdownOpen = !dropdownOpen">
        {{ SHAPE_LABELS[shape] }}
        <svg viewBox="0 0 12 12" fill="none" class="seg-btn__caret">
          <path d="M3 4.5l3 4 3-4z" fill="currentColor" />
        </svg>
      </button>
      <ul v-if="dropdownOpen" class="seg-menu">
        <li
          v-for="(label, value) in SHAPE_LABELS"
          :key="value"
          class="seg-menu__item"
          :class="{ 'seg-menu__item--active': shape === value }"
          @click="chooseShape(value as SegmentShape)"
        >
          {{ label }}
        </li>
      </ul>
    </div>

    <!-- 选区模式：选区内 / 选取外（互斥，绘制出选区后可用，切换即时预览） -->
    <div class="seg-group">
      <button
        class="seg-btn"
        :class="{ 'seg-btn--active': mode === 'inside' }"
        title="只显示选区内的点"
        :disabled="!hasRect"
        @click="setMode('inside')"
      >
        选区内
      </button>
      <button
        class="seg-btn"
        :class="{ 'seg-btn--active': mode === 'outside' }"
        title="只显示选区外的点"
        :disabled="!hasRect"
        @click="setMode('outside')"
      >
        选取外
      </button>
    </div>

    <!-- 刷新：清除当前选区重新绘制（选定选区模式后不可用） -->
    <div class="seg-group">
      <button class="seg-btn" title="清除当前选区，重新绘制" :disabled="!hasRect || modeChosen" @click="resetSelection">
        刷新
      </button>
    </div>

    <!-- 确定 / 取消（绘制出选区且选定选区内/选取外后确定才可用） -->
    <div class="seg-group">
      <button
        class="seg-btn seg-btn--primary"
        title="按当前选区分割点云（需先选择选区内/选取外）"
        :disabled="!hasRect || !modeChosen"
        @click="applySegment"
      >
        确定
      </button>
      <button class="seg-btn" title="放弃分割并退出" @click="exitSegment(false)">取消</button>
    </div>
  </div>
</template>

<style scoped>
.segment-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 10;
}
.seg-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.seg-group:last-child {
  padding-right: 0;
  border-right: none;
}
.seg-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  background: transparent;
  white-space: nowrap;
}
.seg-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.seg-btn--active {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.seg-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.seg-btn:disabled:hover {
  background: transparent;
}
.seg-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.seg-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.seg-btn__caret {
  width: 10px;
  height: 10px;
}
.seg-menu {
  position: absolute;
  top: 36px;
  left: 0;
  min-width: 96px;
  list-style: none;
  margin: 0;
  padding: 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  z-index: 11;
}
.seg-menu__item {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  cursor: pointer;
}
.seg-menu__item:hover {
  background: rgba(0, 0, 0, 0.06);
}
.seg-menu__item--active {
  color: var(--md-primary);
  font-weight: 600;
}
</style>
