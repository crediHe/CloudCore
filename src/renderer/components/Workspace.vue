<script setup>
import ViewToolBar from './ViewToolBar.vue'
import SideToolBar from './SideToolBar.vue'
import MainArea from './MainArea.vue'
import { useAppShortcuts } from '../composables/useAppShortcuts'

/** 主体工作区：左竖工具栏 + 中部主区域 + 右竖工具栏。 */

/**
 * 全局快捷键宿主（Ctrl+O / Ctrl+S / Ctrl+1..6 / Esc / Delete / Home / F / Ctrl+M）。
 * 挂在这里 = **只在主工作区存在时生效**：设置页（`#/settings`）走另一条路由分支，
 * 那里根本不渲染本组件，键盘自然不会误触。清单见 utils/appShortcuts。
 */
useAppShortcuts()
</script>

<template>
  <div class="workspace">
    <!-- 左竖工具栏 -->
    <ViewToolBar />
    <!-- 中部主区域 -->
    <MainArea />
    <!-- 右竖工具栏 -->
    <SideToolBar />
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
