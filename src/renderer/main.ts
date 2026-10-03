import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

/**
 * 注册渲染进程全局错误兜底。
 *
 * 将未捕获的异常与未处理的 Promise 拒绝转发到主进程日志，
 * 便于排查线上问题。所有通信均通过 Preload 暴露的 logger API。
 */
window.addEventListener('error', (event) => {
  window.electronAPI.logger.error('渲染进程未捕获异常：', {
    message: event.message,
    source: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  window.electronAPI.logger.error('渲染进程未处理的 Promise 拒绝：', {
    reason: String(event.reason),
  })
})

createApp(App)
  .mount('#app')
  .$nextTick(() => {
    // 通过安全的 Preload 桥接监听主进程推送消息。
    const unsubscribe = window.electronEvents?.onMainProcessMessage((_event, message) => {
      console.log('[renderer] main-process-message:', message)
    })

    // 此处清理是可选的，因为应用根实例会存活整个会话，
    // 但保留引用可以体现生命周期意识。
    if (unsubscribe) {
      window.addEventListener('beforeunload', unsubscribe)
    }
  })
