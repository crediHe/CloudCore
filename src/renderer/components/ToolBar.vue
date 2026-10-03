<script setup lang="ts">
import { computed } from 'vue'
import { useOpenPointCloud } from '../composables/useOpenPointCloud'
import { useSceneStore } from '../stores/sceneStore'
import { useSegmentStore } from '../stores/segmentStore'
import { useMeasureStore } from '../stores/measureStore'
import { useViewerStore } from '../stores/viewerStore'
import { useAlgorithmModals } from '../composables/useAlgorithmModals'
import { savePointCloudAs, savePointCloudState } from '../composables/useSavePointCloud'

/** 顶部工具栏：一行 icon 按钮，仿 CloudCompare。 */
const { openPointCloud } = useOpenPointCloud()
const { selectedNode } = useSceneStore()
const { active: segmentActive, startSegment, exitSegment } = useSegmentStore()
const { active: measureActive, startMeasure, exitMeasure } = useMeasureStore()
const { projection, setProjection } = useViewerStore()
// 分割 / 测量不在算法入口表里（是拾取交互而非算法模态），但同样要与七个算法模态互斥：
// 进入前调 exitOtherModals() 一次退干净——清单在 composables/useAlgorithmModals，
// 此处不再逐个列出（其余算法的按钮见右竖工具栏 SideToolBar）。
const { exitOtherModals } = useAlgorithmModals()
// 另存为按钮：可用性判据与流程同源（File ▸ Save as… 那一份），避免"按钮亮着、点了却报错"
const saveState = computed(() => savePointCloudState())

/** 分割按钮：无选中时禁用；模式下再次点击 = 取消退出（toggle）。与其余模态互斥。 */
function onSegmentClick() {
  if (segmentActive.value) {
    exitSegment(false)
  } else {
    exitOtherModals()
    startSegment()
  }
}

/**
 * 测量按钮：模式下再次点击 = 退出（toggle）。与其余模态互斥。
 * **永不 disabled**——拾取面向视图内全部可见点云、可跨对象，不需要先选中什么。
 */
function onMeasureClick() {
  if (measureActive.value) {
    exitMeasure()
  } else {
    exitOtherModals()
    startMeasure()
  }
}

/** 投影切换按钮：图标显示当前投影，title 提示将切换到的另一模式。 */
const projectionTitle = computed(() =>
  projection.value === 'perspective' ? '切换为正射投影（无透视，分割框选所见即所得）' : '切换为透视投影（近大远小）'
)

function toggleProjection() {
  setProjection(projection.value === 'perspective' ? 'orthographic' : 'perspective')
}
</script>

<template>
  <div class="toolbar">
    <button class="toolbar__btn" title="打开点云文件" @click="openPointCloud">
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"
          stroke="currentColor"
          stroke-width="1.5"
        />
      </svg>
    </button>
    <button class="toolbar__btn" :disabled="!saveState.ok" :title="saveState.reason" @click="savePointCloudAs()">
      <!-- 另存为图标：软盘 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M8 3v6h7V3M7 21v-6h10v6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      class="toolbar__btn"
      :class="{ 'toolbar__btn--active': segmentActive }"
      :disabled="!selectedNode"
      :title="selectedNode ? '分割点云（多边形选点）' : '请先在 DB Tree 中选中点云'"
      @click="onSegmentClick"
    >
      <!-- 分割图标：五边形 + 虚线切割线 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path d="M5 16L8 6h8l3 10-4 2H9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M8 6l7 12" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2" />
      </svg>
    </button>
    <button
      class="toolbar__btn"
      :class="{ 'toolbar__btn--active': measureActive }"
      title="点云测量（单点信息 / 两点距离 / 三点角度）"
      @click="onMeasureClick"
    >
      <!-- 测量图标：标尺（斜置带刻度；整组一起转，刻度才落在尺身上） -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <g transform="rotate(-45 12 12)">
          <rect x="2" y="9" width="20" height="6" rx="1" stroke="currentColor" stroke-width="1.5" />
          <path d="M6 9v2.5M10 9v3.5M14 9v2.5M18 9v3.5" stroke="currentColor" stroke-width="1.5" />
        </g>
      </svg>
    </button>
    <button
      class="toolbar__btn"
      :title="projectionTitle"
      :aria-pressed="projection === 'orthographic'"
      @click="toggleProjection"
    >
      <!-- 当前投影图标：透视 = 视锥梯形（近大远小）；正射 = 平行六面体（棱线平行，无透视） -->
      <svg v-if="projection === 'perspective'" viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path d="M3 20 6 5h12l3 15H3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M3.3 7 12 12l8.7-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M12 22V12" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  height: 40px;
  flex-shrink: 0;
  gap: 4px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.toolbar__btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--md-on-surface);
  background: transparent;
}
.toolbar__btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--md-primary);
}
.toolbar__btn--active,
.toolbar__btn--active:hover {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.toolbar__btn:disabled {
  color: var(--md-on-surface-variant);
  opacity: 0.38;
  cursor: default;
}
.toolbar__btn:disabled:hover {
  background: transparent;
  color: var(--md-on-surface-variant);
}
</style>
