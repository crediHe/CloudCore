<script setup lang="ts">
import { ref } from 'vue'
import TitleBar from '../components/TitleBar.vue'
import SideNav from './SideNav.vue'
import { useWindow } from '../composables/useWindow'
import { useLocalShortcut } from '../composables/useLocalShortcut'
import { useStore } from '../composables/useStore'
import { useNotification } from '../composables/useNotification'

/**
 * 模板演示首页（样式参考）。
 *
 * 原 App.vue 的完整视觉与交互副本，仅移除了 `#/settings` 路由分支
 * （该职责已移交新 App.vue）。保留 hero、bento 卡片、toast 等全部
 * 演示样式，供后续页面开发对照 MD3 玻璃拟态风格。
 */

const apiUrl = import.meta.env.VITE_API_URL

const { openSettings } = useWindow()
const store = useStore()
const { show: showNotification } = useNotification()

const launchCount = ref(0)
const shortcutToast = ref('')
const toastVisible = ref(false)

store.get<number>('launchCount', 0).then((c) => {
  launchCount.value = c ?? 0
})

function handleNotify() {
  showNotification('Electron Notification', '成功与主进程通信。')
  toastVisible.value = true
  setTimeout(() => {
    toastVisible.value = false
  }, 3000)
}

useLocalShortcut('Ctrl+K', () => {
  shortcutToast.value = '触发了局部快捷键 Ctrl+K'
  setTimeout(() => {
    shortcutToast.value = ''
  }, 2000)
})
</script>

<template>
  <div class="app-layout">
    <TitleBar />
    <div class="app-body">
      <SideNav active="dashboard" />
      <main class="main-content">
        <!-- Hero -->
        <section class="hero">
          <div class="hero__logos">
            <div class="hero__logo-card">
              <img src="/electron-vite.svg" alt="Vite" class="hero__logo-img" />
            </div>
            <span class="hero__plus">+</span>
            <div class="hero__logo-card">
              <img src="../assets/vue.svg" alt="Vue" class="hero__logo-img" />
            </div>
          </div>
          <h1 class="hero__title">Vite + Vue + Electron</h1>
          <div class="hero__url">
            <span class="hero__url-label">API_URL:</span>
            <code class="hero__url-value">{{ apiUrl }}</code>
            <span class="hero__url-copy">⎘</span>
          </div>
        </section>

        <!-- Bento Grid -->
        <div class="bento">
          <!-- Multi-window -->
          <div class="card card--span-4">
            <div class="card__icon card__icon--purple">
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.5" />
                <path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </div>
            <h3 class="card__title">Multi-window Demo</h3>
            <p class="card__desc">Spawns child windows with synchronized state using Electron's IPC bridge.</p>
            <button class="btn-primary" style="margin-top: auto; width: fit-content" @click="openSettings">
              Open New Window
            </button>
          </div>

          <!-- IPC Messages -->
          <div class="card card--span-4">
            <div class="card__header">
              <h3 class="card__title">IPC Messages</h3>
              <span class="badge">LIVE</span>
            </div>
            <div class="msg-row">
              <span class="msg-arrow">→</span>
              <div>
                <p class="msg-title">Renderer → Main</p>
                <p class="msg-sub">Requesting system specs...</p>
              </div>
            </div>
            <div class="msg-row msg-row--done">
              <span class="msg-check">✓</span>
              <div>
                <p class="msg-title">Main → Renderer</p>
                <p class="msg-sub">v8.2.1-electron.0</p>
              </div>
            </div>
          </div>

          <!-- Local Storage -->
          <div class="card card--span-4">
            <div class="card__header">
              <svg viewBox="0 0 24 24" fill="none" width="18" height="18" style="color: var(--md-primary)">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" />
                <polyline points="12 6 12 12 16 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
              <h3 class="card__title">Local Storage</h3>
            </div>
            <p class="card__desc">Last interactions cached via electron-store.</p>
            <div class="history-list">
              <div class="history-row">
                <span>launchCount</span><span>{{ launchCount }}</span>
              </div>
              <div class="history-row"><span>THEME_CHANGE</span><span>15m ago</span></div>
              <div class="history-row"><span>FS_WRITE_CONFIG</span><span>1h ago</span></div>
              <div class="history-row"><span>AUTH_SUCCESS</span><span>2h ago</span></div>
              <div class="history-row"><span>APP_STARTUP</span><span>2h ago</span></div>
            </div>
          </div>

          <!-- Notifications -->
          <div class="card card--span-8">
            <div class="card__row">
              <div class="card__text">
                <h3 class="card__title">System Notifications</h3>
                <p class="card__desc">
                  Integrate natively with the OS notification center using Electron's Notification API.
                </p>
                <div class="card__actions">
                  <button class="btn-primary" @click="handleNotify">
                    <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                      <path
                        d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
                    Test Notification
                  </button>
                  <button class="btn-secondary">Config API</button>
                </div>
              </div>
              <div class="card__preview">
                <div class="preview-notification">
                  <div class="preview-dot"></div>
                  <div class="preview-lines"><span></span><span></span></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Environment -->
          <div class="card card--span-4 card--purple">
            <span class="card__env-label">ENVIRONMENT</span>
            <h3 class="card__env-title">Production</h3>
            <div class="card__env-status">
              <span class="env-dot"></span>
              <span class="env-ver">Node: 20.10.0</span>
            </div>
            <svg class="card__env-bg" viewBox="0 0 24 24" fill="none">
              <polyline
                points="4 17 10 11 4 5M12 19h8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </div>
        </div>

        <!-- Shortcut toast -->
        <div v-if="shortcutToast" class="shortcut-toast">{{ shortcutToast }}</div>

        <!-- Footer -->
        <footer class="footer">
          <span class="footer__copy">© 2024 Electron-Vite Suite</span>
          <nav class="footer__links">
            <a href="#">Documentation</a>
            <a href="#">Release Notes</a>
            <a href="#">GitHub</a>
          </nav>
        </footer>
      </main>
    </div>
  </div>

  <!-- Toast -->
  <Teleport to="body">
    <div class="toast" :class="{ 'toast--show': toastVisible }">
      <div class="toast__icon">
        <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" />
          <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </div>
      <div>
        <p class="toast__title">Native API Triggered</p>
        <p class="toast__sub">Successfully communicated with the main process.</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ---- layout ---- */
.app-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  background: var(--md-surface-container-lowest);
}

/* ---- hero ---- */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 0 24px;
  gap: 16px;
}
.hero__logos {
  display: flex;
  align-items: center;
  gap: 40px;
}
.hero__logo-card {
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  transition: all 0.3s ease;
}
.hero__logo-card:hover {
  filter: drop-shadow(0 0 2em rgba(96, 0, 167, 0.3));
  transform: translateY(-2px);
}
.hero__logo-img {
  width: 64px;
  height: 64px;
}
.hero__plus {
  font-size: 36px;
  font-weight: 300;
  color: var(--md-on-surface-variant);
}
.hero__title {
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--md-primary);
  margin: 0;
}
.hero__url {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.9);
  padding: 8px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.hero__url-label {
  color: #4ade80;
  font-family: monospace;
  font-size: 14px;
}
.hero__url-value {
  color: var(--md-primary-container);
  font-family: monospace;
  font-size: 14px;
}
.hero__url-copy {
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  font-size: 14px;
}
.hero__url-copy:hover {
  color: #fff;
}

/* ---- bento ---- */
.bento {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto;
}
.card--span-4 {
  grid-column: span 4;
}
.card--span-8 {
  grid-column: span 8;
}

/* ---- card ---- */
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card__icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card__icon--purple {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card__title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}
.card__desc {
  font-size: 14px;
  color: var(--md-on-surface-variant);
  margin: 0;
}
.card__row {
  display: flex;
  gap: 24px;
}
.card__text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card__actions {
  display: flex;
  gap: 8px;
}

/* card -- purple */
.card--purple {
  background: var(--md-primary) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  color: #fff;
  position: relative;
  overflow: hidden;
  border: none;
}
.card__env-label {
  font-size: 12px;
  opacity: 0.8;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
}
.card__env-title {
  font-size: 32px;
  font-weight: 700;
  margin: 0;
}
.card__env-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}
.env-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4ade80;
  animation: pulse 2s infinite;
}
.env-ver {
  font-family: monospace;
  font-size: 14px;
}
.card__env-bg {
  position: absolute;
  right: -16px;
  bottom: -16px;
  width: 128px;
  height: 128px;
  opacity: 0.1;
  transition: transform 0.5s ease;
}
.card--purple:hover .card__env-bg {
  transform: rotate(12deg);
}

/* ---- messages ---- */
.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--md-surface-container-low);
  border: 1px solid rgba(0, 0, 0, 0.05);
}
.msg-row--done {
  background: rgba(96, 0, 167, 0.05);
  border-color: rgba(96, 0, 167, 0.1);
}
.msg-arrow,
.msg-check {
  color: var(--md-primary);
  font-size: 14px;
  margin-top: 1px;
}
.msg-check {
  font-weight: 700;
}
.msg-title {
  font-size: 14px;
  font-weight: 500;
  margin: 0;
}
.msg-sub {
  font-size: 12px;
  color: var(--md-on-surface-variant);
  margin: 0;
}

/* ---- badge ---- */
.badge {
  font-size: 10px;
  font-weight: 700;
  background: #ffdcc1;
  color: #6c3a00;
  padding: 2px 8px;
  border-radius: 999px;
}

/* ---- history ---- */
.history-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.history-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  font-size: 12px;
}
.history-row span:last-child {
  color: var(--md-on-surface-variant);
  font-size: 10px;
}

/* ---- preview ---- */
.card__preview {
  width: 256px;
  height: 160px;
  background: var(--md-surface-container-high);
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}
.preview-notification {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.preview-dot {
  width: 24px;
  height: 24px;
  background: var(--md-primary);
  border-radius: 8px;
  flex-shrink: 0;
}
.preview-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.preview-lines span {
  display: block;
  height: 8px;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}
.preview-lines span:last-child {
  width: 60%;
}

/* ---- footer ---- */
.footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 0 40px;
  margin-top: 24px;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  color: var(--md-on-surface-variant);
  font-size: 14px;
  max-width: 1200px;
  margin-left: auto;
  margin-right: auto;
}
.footer__links {
  display: flex;
  gap: 24px;
}
.footer__links a {
  color: var(--md-on-surface-variant);
  text-decoration: none;
  font-weight: 500;
}
.footer__links a:hover {
  color: var(--md-primary);
}

/* ---- toast ---- */
.toast {
  position: fixed;
  bottom: 32px;
  right: 32px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  display: flex;
  gap: 16px;
  align-items: center;
  max-width: 360px;
  transform: translateY(20px);
  opacity: 0;
  transition: all 0.3s ease;
  z-index: 100;
  pointer-events: none;
}
.toast--show {
  transform: translateY(0);
  opacity: 1;
}
.toast__icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--md-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.toast__title {
  font-size: 14px;
  font-weight: 700;
  margin: 0;
}
.toast__sub {
  font-size: 12px;
  color: var(--md-on-surface-variant);
  margin: 0;
}

/* ---- shortcut toast ---- */
.shortcut-toast {
  position: fixed;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--md-primary-container);
  color: var(--md-primary);
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

/* ---- animations ---- */
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* ---- responsive ---- */
@media (max-width: 900px) {
  .bento {
    grid-template-columns: 1fr;
  }
  .card--span-4,
  .card--span-8 {
    grid-column: span 1;
  }
  .card__row {
    flex-direction: column;
  }
  .card__preview {
    width: 100%;
    height: 120px;
  }
}
</style>
