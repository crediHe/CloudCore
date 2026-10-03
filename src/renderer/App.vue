<template>
  <!-- 页面 1：设置视图（通过 v-show 切换显示/隐藏，组件不销毁） -->
  <SettingsView v-show="route === '/settings'" />

  <!-- 页面 2：主应用界面 -->
  <div v-show="route !== '/settings'" class="app-layout">
    <!-- 标题栏：放大缩小标题 -->
    <TitleBar title="CloudCore" />
    <!-- 菜单栏：File... -->
    <MenuBar />
    <!-- 工具栏:logo图标按钮 -->
    <ToolBar />
    <!-- 工作空间 -->
    <Workspace />
  </div>

  <!-- 法向量计算对话框（Edit > Normals > Compute…）：固定浮层，dialogOpen 驱动显隐 -->
  <NormalComputeDialog />

  <!-- 树木信息计算对话框（Trees > Tree info > Compute tree info…）：同款固定浮层 -->
  <TreeInfoDialog />

  <!-- 全局进度条：遮幕/进度/文字/取消均由 progressStore 任务字段驱动 -->
  <GlobalProgress />
</template>
<script setup>
import { computed, onMounted } from 'vue'
import TitleBar from './components/TitleBar.vue'
import MenuBar from './components/MenuBar.vue'
import ToolBar from './components/ToolBar.vue'
import Workspace from './components/Workspace.vue'
import SettingsView from './components/SettingsView.vue'
import NormalComputeDialog from './components/NormalComputeDialog.vue'
import TreeInfoDialog from './components/TreeInfoDialog.vue'
import GlobalProgress from './components/GlobalProgress.vue'
import { useConsoleStore } from './stores/consoleStore'

// 设置窗口加载同一入口的 #/settings 路由，此分支必须保留。
const route = computed(() => window.location.hash.slice(1) || '/')

const { log } = useConsoleStore()

// 打印系统启动日志（仿 CloudCompare Console）。
onMounted(() => {
  log('App', 'Application started')
})
</script>
<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}
</style>
