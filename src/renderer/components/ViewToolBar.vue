<script setup lang="ts">
import { computed } from 'vue'
import { useViewerStore } from '../stores/viewerStore'
import { PIVOT_VISIBILITY_LABELS, nextPivotVisibility } from '../utils/pivotVisibility'
import { hintOf, type ShortcutId } from '../utils/appShortcuts'
import type { ViewName } from '../utils/viewDirections'

/**
 * 左侧竖向视图工具栏：6 个视角方向按钮 + 2 个旋转中心按钮。
 * 视角按钮把相机绕 target 转到该标准方位（保持距离/缩放）；
 * 旋转中心按钮对位 CC 视图工具栏上的 pivot 菜单（图标 ccPivotOn/Auto/Off）——
 * 本仓库无弹出菜单组件，故用单键循环三档代替。
 * 两者都不是算法模态：没有目标实体快照、不占用相机，故**不参与**
 * ToolBar.vue / SideToolBar.vue 那套模态互斥清单。
 */
const { setView, pivotVisibility, cyclePivotVisibility, resetPivot } = useViewerStore()

/** 循环按钮的 title：写明当前档位与下一档（单键无菜单可看，只能靠提示）。 */
const pivotTitle = computed(() => {
  const next = PIVOT_VISIBILITY_LABELS[nextPivotVisibility(pivotVisibility.value)]
  return `旋转中心：${PIVOT_VISIBILITY_LABELS[pivotVisibility.value]}（点击切换为「${next}」）`
})

/**
 * 视角按钮的 title = 中文名 + 快捷键提示。键位文案取自 utils/appShortcuts 那张表
 * （`hintOf`），与 Menu ▸ View 的 Standard views 分组、与实际绑定三处同源。
 */
const VIEW_TITLES: Record<ViewName, { label: string; id: ShortcutId }> = {
  front: { label: '前视图', id: 'viewFront' },
  back: { label: '后视图', id: 'viewBack' },
  left: { label: '左视图', id: 'viewLeft' },
  right: { label: '右视图', id: 'viewRight' },
  top: { label: '上视图', id: 'viewTop' },
  bottom: { label: '下视图', id: 'viewBottom' },
}

function viewTitle(view: ViewName): string {
  const item = VIEW_TITLES[view]
  return `${item.label}（${hintOf(item.id)}）`
}
</script>

<template>
  <aside class="view-toolbar">
    <button class="view-toolbar__btn" :title="viewTitle('front')" @click="setView('front')">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="5" y="7" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M12 3l3 3H9z" fill="currentColor" />
      </svg>
    </button>
    <button class="view-toolbar__btn" :title="viewTitle('back')" @click="setView('back')">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="5" y="7" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M12 21l-3-3h6z" fill="currentColor" />
      </svg>
    </button>
    <button class="view-toolbar__btn" :title="viewTitle('left')" @click="setView('left')">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="5" y="7" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M3 12l3-3v6z" fill="currentColor" />
      </svg>
    </button>
    <button class="view-toolbar__btn" :title="viewTitle('right')" @click="setView('right')">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="5" y="7" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M21 12l-3-3v6z" fill="currentColor" />
      </svg>
    </button>
    <button class="view-toolbar__btn" :title="viewTitle('top')" @click="setView('top')">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
    <button class="view-toolbar__btn" :title="viewTitle('bottom')" @click="setView('bottom')">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.5" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      </svg>
    </button>

    <div class="view-toolbar__sep"></div>

    <!-- 三档可见性循环：图标按档位切换（始终显示 = 黄球与三彩环的写意；仅旋转 = 旋转箭头；
         隐藏 = 划掉）。active 高亮表示"符号已启用"（onMove / always 两档都算）。 -->
    <button
      class="view-toolbar__btn"
      :class="{ 'view-toolbar__btn--active': pivotVisibility !== 'hide' }"
      :title="pivotTitle"
      @click="cyclePivotVisibility"
    >
      <svg v-if="pivotVisibility === 'always'" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.5" />
        <ellipse cx="12" cy="12" rx="8.2" ry="3.2" stroke="currentColor" stroke-width="1.5" />
        <ellipse cx="12" cy="12" rx="3.2" ry="8.2" stroke="currentColor" stroke-width="1.5" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      </svg>
      <svg v-else-if="pivotVisibility === 'onMove'" viewBox="0 0 24 24" fill="none">
        <path d="M3.8 12a8.2 8.2 0 1 0 8.2-8.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        <path d="M8.6 3.8L12 2.3v3z" fill="currentColor" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.5" />
        <ellipse cx="12" cy="12" rx="3.2" ry="8.2" stroke="currentColor" stroke-width="1.5" />
        <path d="M4.5 4.5l15 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>

    <!-- 复位：tooltip 顺带承担"双击可改旋转中心"的可见性说明（无菜单可挂） -->
    <button
      class="view-toolbar__btn"
      title="旋转中心复位到原点（在点云上双击可把该点设为旋转中心）"
      @click="resetPivot"
    >
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      </svg>
    </button>
  </aside>
</template>

<style scoped>
.view-toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 44px;
  flex-shrink: 0;
  padding: 8px 4px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border-right: 1px solid rgba(0, 0, 0, 0.05);
}
.view-toolbar__btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--md-on-surface-variant);
  background: transparent;
}
.view-toolbar__btn svg {
  width: 18px;
  height: 18px;
}
.view-toolbar__btn:hover {
  background: rgba(96, 0, 167, 0.08);
  color: var(--md-primary);
}
/* 与上方 6 个视角按钮分组：视角是"一次性动作"，旋转中心按钮带状态/可循环 */
.view-toolbar__sep {
  width: 20px;
  height: 1px;
  margin: 2px 0;
  background: rgba(0, 0, 0, 0.1);
}
.view-toolbar__btn--active,
.view-toolbar__btn--active:hover {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
</style>
