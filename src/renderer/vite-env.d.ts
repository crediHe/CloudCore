/// <reference types="vite/client" />

/** 让 vue-tsc 能识别 .vue 单文件组件的模块声明（缺失会导致 import App.vue 报 TS7016）。 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface ImportMetaEnv {
  /** 后端服务的基础 API URL。 */
  readonly VITE_API_URL: string
  /** 崩溃报告可选的 Sentry DSN。 */
  readonly VITE_SENTRY_DSN?: string
  /** electron-updater 可选的更新服务器 URL。 */
  readonly VITE_UPDATE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
