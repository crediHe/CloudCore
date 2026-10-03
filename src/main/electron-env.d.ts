/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * 构建后的目录结构
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.mjs
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ 或 /public/ */
    VITE_PUBLIC: string
  }
}

// 在渲染进程中使用，需在 `preload.ts` 中暴露
interface Window {
  ipcRenderer: import('electron').IpcRenderer
}
