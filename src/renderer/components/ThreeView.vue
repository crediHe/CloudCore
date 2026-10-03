<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { createViewer } from '../three/engine'
import type { ThreeViewer } from '../three/engine'
import { attachLodScheduler } from '../three/lodScheduler'
import { attachTreeMarkers } from '../three/treeInfoOverlay'
import { useViewerStore } from '../stores/viewerStore'
import { useSegmentInteraction } from '../composables/useSegmentInteraction'
import { useMeasureInteraction } from '../composables/useMeasureInteraction'
import { useAlignInteraction } from '../composables/useAlignInteraction'
import { usePivotInteraction } from '../composables/usePivotInteraction'

/** 3D 视图：挂载 three 引擎，向 viewerStore 注册实例供点云加载使用。 */
const containerRef = ref<HTMLElement | null>(null)
let viewer: ThreeViewer | null = null
const { registerViewer } = useViewerStore()

onMounted(() => {
  if (!containerRef.value) return
  viewer = createViewer(containerRef.value)
  registerViewer(viewer)
  // LOD 调度器（每帧取点）随引擎一起装/卸；引擎重建（HMR、组件重挂载）时换绑
  attachLodScheduler(viewer)
  // 树木 3D 标记覆盖物（选中集 / 树信息变化时整批重填，非每帧）；引擎重建时按场景身份重建
  attachTreeMarkers(viewer)
  // 引擎实例的调试出口（DevTools 控制台与 e2e 自动化共用）。
  // 按需渲染的验收靠它——静止时 `__viewer.getRenderStats().frame` 应当停止增长。
  // 刻意不按 DEV 条件裁剪：e2e 跑的是生产构建（pnpm build:test），
  // 而这里暴露的只是一个已挂在 window 上的对象的引用，不扩大攻击面
  // （本应用已开 nodeIntegration，渲染主世界本就能 require）。
  ;(window as unknown as { __viewer?: ThreeViewer }).__viewer = viewer
  // 分割模式交互（绘制矩形、锚定覆盖物；生命周期挂在 segmentStore.active 上）
  useSegmentInteraction(containerRef)
  // 测量模式交互（点击拾取、标记/连线/浮动标签；生命周期挂在 measureStore.active 上）
  useMeasureInteraction(containerRef)
  // 点对对齐交互（点击拾取同名点，标记由 registrationOverlay 画；挂在 alignStore.active 上）
  useAlignInteraction(containerRef)
  // 双击设旋转中心（常驻，无模态；测量/框选激活时自行让位）
  usePivotInteraction(containerRef)
})

onUnmounted(() => {
  delete (window as unknown as { __viewer?: ThreeViewer }).__viewer
  attachLodScheduler(null) // 先摘调度器（它持有引擎的 controls 与帧任务），再销毁引擎
  attachTreeMarkers(null) // 覆盖物也要先摘（dispose 掉它自己的 Group），再销毁引擎
  viewer?.dispose()
  registerViewer(null)
  viewer = null
})
</script>

<template>
  <div ref="containerRef" class="three-view"></div>
</template>

<style scoped>
.three-view {
  position: relative; /* 分割预览框等浮层按此定位 */
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.three-view :deep(canvas) {
  display: block;
}
</style>
