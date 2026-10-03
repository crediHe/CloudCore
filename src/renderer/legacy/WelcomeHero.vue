<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ msg: string }>()

const count = ref(0)
</script>

<template>
  <h1>{{ msg }}</h1>

  <div class="card">
    <button type="button" @click="count++">计数：{{ count }}</button>
    <p>
      编辑
      <code>components/HelloWorld.vue</code> 以测试 HMR
    </p>
  </div>

  <p>
    查看官方 Vue + Vite 启动模板
    <a href="https://vuejs.org/guide/quick-start.html#local" target="_blank">create-vue</a>
  </p>
  <p>
    在 IDE 中安装
    <a href="https://github.com/vuejs/language-tools" target="_blank">Volar</a>
    以获得更好的开发体验
  </p>
  <p class="read-the-docs">点击 Vite 和 Vue 图标了解更多</p>
</template>

<style scoped>
.read-the-docs {
  color: #888;
}
</style>
