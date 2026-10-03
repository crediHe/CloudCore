<script setup lang="ts">
defineProps<{ active?: string }>()
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__section">
      <p class="sidebar__label">PLATFORM</p>
      <nav class="sidebar__nav">
        <a class="sidebar__link" :class="{ 'sidebar__link--active': active === 'dashboard' }" href="#">
          <svg class="sidebar__svg" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <span>Dashboard</span>
        </a>
        <a class="sidebar__link" href="#">
          <svg class="sidebar__svg" viewBox="0 0 24 24" fill="none">
            <path
              d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </svg>
          <span>Projects</span>
        </a>
        <a class="sidebar__link" href="#">
          <svg class="sidebar__svg" viewBox="0 0 24 24" fill="none">
            <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <span>Analytics</span>
        </a>
      </nav>
    </div>
    <div class="sidebar__footer">
      <a class="sidebar__link" href="#">
        <svg class="sidebar__svg" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
        <span>Settings</span>
      </a>
      <div class="sidebar__badge">
        <div class="sidebar__avatar">P</div>
        <span class="sidebar__plan">Pro</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 80px;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 8px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
  border-right: 1px solid rgba(0, 0, 0, 0.05);
  user-select: none;
  -webkit-user-select: none;
  flex-shrink: 0;
}

.sidebar__section {
  margin-bottom: 24px;
}

.sidebar__label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--md-on-surface-variant);
  text-align: center;
  padding: 8px 0;
}

.sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar__link {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 8px;
  border-radius: 12px;
  color: var(--md-on-surface-variant);
  text-decoration: none;
  transition: all 0.15s ease;
}
.sidebar__link span {
  font-size: 10px;
  font-weight: 500;
}
.sidebar__link:hover {
  background: rgba(0, 0, 0, 0.05);
}
.sidebar__link--active {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
  font-weight: 600;
  border-left: 4px solid var(--md-primary);
  border-radius: 0 12px 12px 0;
}

.sidebar__svg {
  width: 20px;
  height: 20px;
}

.sidebar__footer {
  margin-top: auto;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.sidebar__badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px;
  background: var(--md-surface-container-low);
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.05);
}

.sidebar__avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--md-primary-container);
  color: var(--md-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
}

.sidebar__plan {
  font-size: 8px;
  color: var(--md-on-surface-variant);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
