<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useMeasureStore } from '../stores/measureStore'
import { MEASURE_MODE_LABELS } from '../utils/measure'
import type { MeasureMode } from '../utils/measure'

/**
 * 测量模式横条工具栏（浮层，3D 视图区右上角，与 FilterToolBar 同款样式）。
 *
 * 点击顶部工具栏标尺按钮后显示：模式三选一（单点信息 / 两点距离 / 三点角度）
 * + 已拾取计数 + 清除 + 退出。仿 CloudCompare 的 ccPointPropertiesDlg：
 * 切模式即清空已拾取的点（换模式后旧点数与语义都不再匹配）。
 * 测量不锁相机，可自由旋转缩放确认；Esc = 退出（与体素滤波同习惯）。
 */

const { active, mode, picked, capacity, setMode, clearPicked, exitMeasure } = useMeasureStore()

/** Esc = 退出测量模式（与体素滤波/单点拾取的习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitMeasure()
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))

/** 模式按钮的遍历源（值与标签成对，避免在模板里写两份列表）。 */
const MODES = Object.entries(MEASURE_MODE_LABELS) as [MeasureMode, string][]

const hint = computed(() => (picked.value.length === 0 ? '在点云上点击拾取' : ''))
</script>

<template>
  <div v-if="active" class="m-bar">
    <!-- 模式：三选一，切换即清空已拾取的点 -->
    <div class="m-group">
      <button
        v-for="[value, label] in MODES"
        :key="value"
        class="m-btn"
        :class="{ 'm-btn--active': mode === value }"
        :title="`${label}（切换会清空已拾取的点）`"
        @click="setMode(value)"
      >
        {{ label }}
      </button>
    </div>

    <!-- 拾取计数：未满员时给出引导语，满员时提示再点一次会重开一组 -->
    <span v-if="hint" class="m-hint">{{ hint }}</span>
    <div v-else class="m-count" :title="`已拾取 ${picked.length}/${capacity}；再点一次将丢弃本组重开`">
      <b>{{ picked.length }}</b> / {{ capacity }}
    </div>

    <div class="m-group">
      <button class="m-btn" title="清除当前测量结果（不退出模式）" :disabled="picked.length === 0" @click="clearPicked">
        清除
      </button>
      <button class="m-btn m-btn--primary" title="退出测量模式（Esc）" @click="exitMeasure">退出</button>
    </div>
  </div>
</template>

<style scoped>
.m-bar {
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
.m-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.m-group:last-child {
  padding-right: 0;
  border-right: none;
}
.m-btn {
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
.m-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.m-btn--active {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.m-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.m-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.m-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.m-btn:disabled:hover {
  background: transparent;
}
.m-hint {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
.m-count {
  padding: 0 8px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
</style>
