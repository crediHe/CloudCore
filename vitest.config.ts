import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  test: {
    // 默认使用 Node 环境，适合主进程测试。
    // 渲染进程测试请在文件顶部添加 `// @vitest-environment jsdom`。
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.spec.ts'],
    // 在所有测试文件之前加载全局 mock，拦截 electron-log/main。
    // LoggerManager → electron-log/main → require('electron') 这条依赖链
    // 在 CI 环境中因 Electron 二进制未安装而失败，必须提前 mock 掉。
    setupFiles: ['./tests/unit/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
      '@main': path.resolve(__dirname, './src/main'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
})
