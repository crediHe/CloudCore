import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'

// Vite 配置文档：https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 加载环境变量，使其在渲染进程与 Electron 主进程/预加载脚本构建中均可通过 import.meta.env 访问。
  // 默认情况下，以 VITE_ 为前缀的变量暴露给渲染进程；
  // 以 MAIN_VITE_ 为前缀的变量暴露给主进程。
  // 仅加载 MAIN_VITE_ 前缀的变量到 process.env，避免将系统环境变量全部泄漏到构建中。
  // Vite 内置支持 VITE_ 前缀，无需额外指定。
  loadEnv(mode, process.cwd(), 'MAIN_VITE_')

  return {
    // 同时允许 VITE_（渲染进程）和 MAIN_VITE_（主进程）两种前缀。
    envPrefix: ['VITE_', 'MAIN_VITE_'],
    plugins: [
      vue(),
      electron({
        main: {
          // 主进程入口，按宪法要求位于 src/main/。
          entry: 'src/main/main.ts',
        },
        preload: {
          // 预加载脚本入口，按宪法要求位于 src/preload/。
          // 预加载脚本可能包含 Web 资源，因此使用 build.rollupOptions.input 而非 build.lib.entry。
          input: path.join(__dirname, 'src/preload/preload.ts'),
        },
        // 为渲染进程 polyfill Electron 与 Node.js API。
        // 注意：本项目禁止在渲染进程中直接使用 Node.js 原生模块，因此请勿启用 nodeIntegration。
        // 如需了解该选项，请参阅：https://github.com/electron-vite/vite-plugin-electron-renderer
        renderer:
          process.env.NODE_ENV === 'test'
            ? // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
              undefined
            : {},
      }),
    ],
  }
})
