<script setup >
import { ref, onMounted } from 'vue'
import TitleBar from './TitleBar.vue'
import { useCrossWindow } from '../composables/useCrossWindow'   

const { on } = useCrossWindow()
const receivedTheme = ref('default')

onMounted(() => {
  on('theme-changed', (message) => {
    receivedTheme.value = message.payload.theme
  })
})
</script>

<template>
  <div class="settings">
    <TitleBar title="设置" />
    <main class="settings__content">
      <h1 class="settings__title">设置</h1>
      <p class="settings__desc">这是一个二级窗口，通过 Electron IPC 与主窗口通信。</p>
      <p class="settings__hint">
        当前从主窗口同步的主题：<strong>{{ receivedTheme }}</strong>
      </p>
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  background: var(--md-surface-container-lowest);
}

.settings__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  gap: 12px;
}

.settings__title {
  font-size: 24px;
  font-weight: 600;
  color: var(--md-on-surface);
  margin: 0;
}

.settings__desc {
  color: var(--md-on-surface-variant);
  font-size: 14px;
  margin: 0;
}

.settings__hint {
  margin-top: 8px;
  font-size: 14px;
  color: var(--md-on-surface-variant);
}
</style>
