<script setup>
import { ref } from 'vue'
import SceneTree from './SceneTree.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import ThreeView from './ThreeView.vue'
import SegmentToolBar from './SegmentToolBar.vue'
import StatisticalFilterToolBar from './StatisticalFilterToolBar.vue'
import FilterToolBar from './FilterToolBar.vue'
import VoxelToolBar from './VoxelToolBar.vue'
import CsfToolBar from './CsfToolBar.vue'
import CsfProToolBar from './CsfProToolBar.vue'
import TreeIsoToolBar from './TreeIsoToolBar.vue'
import EuclideanClusterToolBar from './EuclideanClusterToolBar.vue'
import PowerLineToolBar from './PowerLineToolBar.vue'
import RansacPlaneToolBar from './RansacPlaneToolBar.vue'
import RansacCylinderToolBar from './RansacCylinderToolBar.vue'
import AlignToolBar from './AlignToolBar.vue'
import IcpToolBar from './IcpToolBar.vue'
import GicpToolBar from './GicpToolBar.vue'
import MeasureToolBar from './MeasureToolBar.vue'
import Console from './Console.vue'
import SplitBar from './SplitBar.vue'

/**
 * 中部主区域：上（树状 ⇄ 3D 视图，宽度可横向拖拽）+ 下（Console，高度可纵向拖拽）。
 * 左侧面板内部：DB Tree ⇄ 详细信息，高度可纵向拖拽。
 */
const treeWidth = ref(260)
const detailsHeight = ref(140)
const consoleHeight = ref(160)

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
</script>

<template>
  <div class="main-area">
    <div class="main-area__top">
      <section class="tree-pane" :style="{ width: `${treeWidth}px` }">
        <SceneTree class="tree-pane__tree" />
        <!-- 详情面板顶边：鼠标上移（dy 为负）时面板变高 -->
        <SplitBar axis="vertical" @drag="(_, dy) => (detailsHeight = clamp(detailsHeight - dy, 60, 400))" />
        <PropertiesPanel class="tree-pane__details" :style="{ height: `${detailsHeight}px` }" />
      </section>

      <SplitBar axis="horizontal" @drag="(dx) => (treeWidth = clamp(treeWidth + dx, 160, 520))" />

      <section class="view-pane">
        <ThreeView />
        <!-- 分割 / 统计滤波 / 半径滤波 / 体素滤波 / LiDAR 地面分割 / 精准分割 / 单木分割 / RANSAC 平面拟合 / 测量模式横条：浮于 3D 视图右上角（view-pane 为定位基准），各模态互斥 -->
        <SegmentToolBar />
        <StatisticalFilterToolBar />
        <FilterToolBar />
        <VoxelToolBar />
        <CsfToolBar />
        <CsfProToolBar />
        <TreeIsoToolBar />
        <EuclideanClusterToolBar />
        <PowerLineToolBar />
        <RansacPlaneToolBar />
        <RansacCylinderToolBar />
        <AlignToolBar />
        <IcpToolBar />
        <GicpToolBar />
        <MeasureToolBar />
      </section>
    </div>

    <!-- Console 顶边：鼠标上移（dy 为负）时 Console 变高 -->
    <SplitBar axis="vertical" @drag="(_, dy) => (consoleHeight = clamp(consoleHeight - dy, 80, 400))" />

    <section class="console-pane" :style="{ height: `${consoleHeight}px` }">
      <Console />
    </section>
  </div>
</template>

<style scoped>
.main-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.main-area__top {
  display: flex;
  flex: 1;
  min-height: 0;
}
.tree-pane {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  background: var(--md-surface-container-lowest);
  border-right: 1px solid rgba(0, 0, 0, 0.06);
}
.tree-pane__tree {
  flex: 1;
  min-height: 0;
}
.tree-pane__details {
  flex-shrink: 0;
  min-height: 0;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}
.view-pane {
  position: relative;
  flex: 1;
  min-width: 0;
}
.console-pane {
  flex-shrink: 0;
  min-height: 0;
}
</style>
