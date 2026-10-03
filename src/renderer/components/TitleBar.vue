<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const props = withDefaults(defineProps<{ title?: string }>(), { title: 'Windows Electron Vite' })

const isMaximized = ref(false)
let unsubscribe: (() => void) | null = null

function minimize() {
  window.electronAPI.windowControl.minimize()
}
function toggleMaximize() {
  if (isMaximized.value) {
    window.electronAPI.windowControl.unmaximize()
  } else {
    window.electronAPI.windowControl.maximize()
  }
}
function close() {
  window.electronAPI.windowControl.close()
}

onMounted(async () => {
  try {
    isMaximized.value = await window.electronAPI.windowControl.isMaximized()
  } catch {
    /* */
  }
  if (window.electronEvents?.onWindowStateChanged) {
    unsubscribe = window.electronEvents.onWindowStateChanged((_, s) => {
      isMaximized.value = s.isMaximized
    })
  }
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <header class="title-bar">
    <div class="title-bar__drag">
      <svg class="title-bar__icon" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="title-bar__title">{{ props.title }}</span>
    </div>
    <div class="title-bar__controls">
      <button class="ctrl" title="最小化" @click="minimize">
        <svg viewBox="0 0 12 12"><rect x="1.5" y="5.5" width="9" height="1.2" fill="currentColor" /></svg>
      </button>
      <button class="ctrl" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize">
        <svg v-if="!isMaximized" viewBox="0 0 12 12">
          <rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none" />
        </svg>
        <svg v-else viewBox="0 0 12 12">
          <rect x="3" y="1" width="7" height="7" rx="0.8" stroke="currentColor" stroke-width="1.2" fill="none" />
          <rect
            x="1"
            y="4"
            width="7"
            height="7"
            rx="0.8"
            fill="var(--md-surface-container)"
            stroke="currentColor"
            stroke-width="1.2"
          />
        </svg>
      </button>
      <button class="ctrl ctrl--close" title="关闭" @click="close">
        <svg viewBox="0 0 12 12">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 4px 0 16px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  color: var(--md-on-surface);
  user-select: none;
  -webkit-user-select: none;
  z-index: 50;
}

.title-bar__drag {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: drag;
  app-region: drag;
}

.title-bar__icon {
  width: 20px;
  height: 20px;
  color: var(--md-primary);
  flex-shrink: 0;
}

.title-bar__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--md-on-surface);
}

.title-bar__controls {
  display: flex;
  align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.ctrl {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--md-on-surface);
  cursor: pointer;
  transition: background 150ms ease;
}
.ctrl svg {
  width: 12px;
  height: 12px;
}
.ctrl:hover {
  background: rgba(0, 0, 0, 0.05);
}
.ctrl--close:hover {
  background: #e81123;
  color: #fff;
}
</style>
