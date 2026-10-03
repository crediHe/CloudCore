<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useConsoleStore } from '../stores/consoleStore'

/** Console 区域：CC 风格日志列表，新日志自动滚动到底部。 */
const { entries } = useConsoleStore()
const bodyRef = ref<HTMLElement | null>(null)

watch(
  () => entries.length,
  async () => {
    await nextTick()
    if (bodyRef.value) {
      bodyRef.value.scrollTop = bodyRef.value.scrollHeight
    }
  }
)
</script>

<template>
  <div class="console">
    <div class="panel-title">Console</div>
    <div ref="bodyRef" class="console__body">
      <p v-for="entry in entries" :key="entry.id" class="console__line">
        <span class="console__time">[{{ entry.time }}]</span>
        <span class="console__source">[{{ entry.source }}]</span>
        <span class="console__message">{{ entry.message }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.console {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--md-surface-container-lowest);
}
.console__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 12px;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.8;
}
.console__line {
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.console__time {
  color: var(--md-on-surface-variant);
  opacity: 0.7;
}
.console__source {
  color: var(--md-primary);
  font-weight: 600;
}
.console__message {
  color: var(--md-on-surface);
}
</style>
