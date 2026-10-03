<script setup lang="ts">
import { computed } from 'vue'
import { useProgressStore } from '../stores/progressStore'
import type { ProgressTask } from '../stores/progressStore'

/**
 * 全局进度条（挂在 App.vue 根级）。
 *
 * 纯展示组件，无业务逻辑：订阅 progressStore 的活跃任务，
 * 按任务字段渲染遮幕 / 进度条 / 文字 / 取消按钮。
 */

const { activeTask, close } = useProgressStore()

/** 当前展示的任务（null 表示无任务，组件隐藏）。 */
const task = computed<ProgressTask | null>(() => activeTask())

/** 进度条填充宽度；不确定进度（null）时交给 CSS 动画。 */
const fillStyle = computed(() => {
  const t = task.value
  if (!t || t.progress === null) return {}
  const pct = Math.min(100, Math.max(0, t.progress))
  return { width: `${pct}%` }
})

function onCancel() {
  if (task.value) void close(task.value)
}

function onClose() {
  if (task.value) void close(task.value)
}
</script>

<template>
  <div v-if="task" class="progress-root" :class="{ 'is-modal': task.modal }">
    <div class="progress-card" :class="{ 'is-failed': task.status === 'failed' }">
      <div v-if="task.title" class="progress-title">{{ task.title }}</div>

      <div class="progress-track" :class="{ 'is-indeterminate': task.progress === null }">
        <div class="progress-fill" :style="fillStyle"></div>
      </div>

      <div v-if="task.message || task.detail" class="progress-text">
        <span class="progress-message">{{ task.message }}</span>
        <span v-if="task.detail" class="progress-detail">{{ task.detail }}</span>
      </div>

      <div v-if="task.cancellable || task.status === 'failed'" class="progress-actions">
        <button v-if="task.cancellable" class="progress-btn" @click="onCancel">取消</button>
        <button
          v-if="task.status === 'failed'"
          class="progress-btn progress-btn--close"
          @click="onClose"
        >
          关闭
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.progress-root {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 非遮幕任务（modal: false）不拦截任何点击 */
  pointer-events: none;
}
.progress-root.is-modal {
  background: rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}

.progress-card {
  min-width: 280px;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  /* 不透明底色，刻意不用 backdrop-filter：卡片浮在 WebGL canvas 之上，
     模糊滤镜会强迫合成器每帧回读整屏重新模糊（加载全程掉帧），
     而这里视觉上只差一层毛玻璃，不值得。 */
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(0, 0, 0, 0.05);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  pointer-events: none;
}
.progress-card.is-failed {
  border-color: rgba(217, 48, 37, 0.4);
}

.progress-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--md-on-surface);
  user-select: none;
  -webkit-user-select: none;
}

.progress-track {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--md-primary);
  transition: width 0.2s ease;
}
.is-failed .progress-fill {
  background: #d93025;
}
/* 不确定进度：填充块循环平移 */
.progress-track.is-indeterminate .progress-fill {
  width: 40%;
  animation: progress-slide 1.2s ease-in-out infinite;
}
@keyframes progress-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}

.progress-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  user-select: none;
  -webkit-user-select: none;
}
.progress-detail {
  font-size: 11px;
  opacity: 0.8;
}

.progress-actions {
  display: flex;
  gap: 8px;
  pointer-events: auto;
}
.progress-btn {
  padding: 6px 16px;
  font-size: 13px;
  background: var(--md-surface-container-high);
  color: var(--md-on-surface);
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.progress-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.progress-btn--close {
  background: var(--md-primary);
  color: var(--md-on-primary);
}
.progress-btn--close:hover {
  filter: brightness(1.15);
}
</style>
