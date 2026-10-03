<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useFilterStore } from '../stores/filterStore'

/**
 * 半径滤波横条工具栏（浮层，3D 视图区右上角，与 SegmentToolBar 同款样式）。
 *
 * 点击工具栏 filter 按钮后显示：搜索半径 + 最少邻居数输入 + 结果统计行 + 确定/取消。
 * 参数改动**不影响屏上已有的预览**（旧效果保留供对照微调），只有点「预览」才按
 * 原始数据 + 当前参数重算并整体替换（C++ node-addon 计算）。
 * 确定仅当预览由当前参数生成后可用；计算期间全部输入与按钮禁用。
 * 预览只显示保留点，不锁相机，可自由旋转确认；Esc = 取消。
 */

const { active, radius, minNeighbors, computing, previewed, stats, setParams, runPreview, applyFilter, exitFilter } =
  useFilterStore()

/** 半径输入 → setParams（钳制在 store 内；NaN 不更新）。 */
function onRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams(v, minNeighbors.value)
}

/** 邻居数输入 → setParams（store 内取整钳制）。 */
function onMinNeighborsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams(radius.value, v)
}

/** Esc = 取消并退出滤波模式（与分割多边形的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitFilter(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="filter-bar">
    <!-- 搜索半径 -->
    <div class="f-group">
      <label class="f-label" title="搜索半径（与点云坐标同单位）；半径内邻居数少于「最少邻居」的点被剔除">
        搜索半径
      </label>
      <input
        class="f-input"
        type="number"
        min="0"
        step="any"
        :value="radius"
        :disabled="computing"
        title="与点云坐标同单位"
        @input="onRadiusInput"
      />
    </div>

    <!-- 最少邻居数 -->
    <div class="f-group">
      <label class="f-label" title="半径内至少需要多少个邻居点（不含自身）才保留；0 = 全部保留">最少邻居</label>
      <input
        class="f-input f-input--narrow"
        type="number"
        min="0"
        step="1"
        :value="minNeighbors"
        :disabled="computing"
        @input="onMinNeighborsInput"
      />
    </div>

    <!-- 引导提示（未按当前参数预览时显示；已有旧预览保留显示，仅提示需重新预览） -->
    <span v-if="!previewed && !computing" class="f-hint">{{
      stats ? '参数已变更，点击「预览」更新效果' : '点击「预览」生成效果'
    }}</span>

    <!-- 结果统计行 -->
    <div v-if="stats" class="f-stats" title="最近一次预览的统计（全部目标合计）">
      保留 <b>{{ stats.kept.toLocaleString() }}</b>
      <span class="f-stats__sep">·</span>
      剔除 <b>{{ stats.removed.toLocaleString() }}</b>
    </div>

    <div class="f-group">
      <!-- 预览：手动触发计算（计算中禁用） -->
      <button
        class="f-btn f-btn--preview"
        title="按当前参数计算并只显示保留点（可旋转确认）"
        :disabled="computing"
        @click="runPreview"
      >
        {{ computing ? '计算中…' : '预览' }}
      </button>
      <!-- 确定：须先按当前参数预览 -->
      <button
        class="f-btn f-btn--primary"
        title="按预览结果拆分 filtered / removed 实体（需先点击预览）"
        :disabled="!previewed || computing"
        @click="applyFilter"
      >
        确定
      </button>
      <button class="f-btn" title="放弃滤波并退出（Esc）" :disabled="computing" @click="exitFilter(false)">取消</button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 10;
}
.f-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.f-group:last-child {
  padding-right: 0;
  border-right: none;
}
.f-label {
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.f-input {
  width: 92px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.f-input--narrow {
  width: 60px;
}
.f-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.f-input:disabled {
  opacity: 0.5;
}
.f-hint {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
.f-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.f-stats__sep {
  opacity: 0.5;
}
.f-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  background: transparent;
  white-space: nowrap;
}
.f-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.f-btn--preview {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.f-btn--preview:hover {
  background: rgba(96, 0, 167, 0.16);
}
.f-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.f-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.f-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.f-btn:disabled:hover {
  background: transparent;
}
.f-btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
</style>
