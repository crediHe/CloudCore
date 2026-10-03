<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRansacPlaneStore } from '../stores/ransacPlaneStore'

/**
 * RANSAC 平面拟合横条工具栏（浮层，3D 视图区右上角，与 FilterToolBar 同款样式）。
 *
 * 点击竖栏 RANSAC 按钮后显示：距离阈值 + 最大迭代次数 + 系数优化开关 + 结果统计行 +
 * 预览/确定/取消。参数改动**不影响屏上已有的预览**（旧效果保留供对照微调），只有点
 * 「预览」才按原始数据 + 当前参数重算并整体替换（C++ node-addon 计算）。
 * 确定仅当预览由当前参数生成后可用；计算期间全部输入与按钮禁用。
 * 预览只显示平面内点并在 3D 里画出平面片与法线，不锁相机；Esc = 取消。
 *
 * 已知局限写进 title（别让用户当成 bug）：均匀采样 RANSAC 找不出占比过低的平面，
 * 需先框选局部再拟合、或先剥掉占比大的平面（见 native/ransac-plane/README-REF.md）。
 */

const {
  active,
  distanceThreshold,
  maxIterations,
  optimizeCoefficients,
  computing,
  previewed,
  stats,
  setParams,
  runPreview,
  applyExtract,
  exitRansacPlane,
} = useRansacPlaneStore()

/** 距离阈值输入 → setParams（钳制在 store 内；NaN 不更新）。 */
function onThresholdInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams(v, maxIterations.value, optimizeCoefficients.value)
}

/** 最大迭代次数输入 → setParams（store 内取整钳制）。 */
function onIterationsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams(distanceThreshold.value, v, optimizeCoefficients.value)
}

/** 系数优化开关 → setParams。 */
function onOptimizeChange(e: Event) {
  setParams(distanceThreshold.value, maxIterations.value, (e.target as HTMLInputElement).checked)
}

/** Esc = 取消并退出平面拟合模式（与其余模态的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitRansacPlane(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))

/** 内点占比百分数（候选为 0 时不显示，防除零）。 */
function shareText(inlier: number, total: number): string {
  return total > 0 ? `${((inlier / total) * 100).toFixed(2)}%` : '—'
}
</script>

<template>
  <div v-if="active" class="r-bar">
    <!-- 距离阈值 -->
    <div class="r-group">
      <label
        class="r-label"
        title="点到平面的距离 ≤ 它即算平面内点（与点云坐标同单位）；调大能把更稀疏的平面纳入内点，调小则更严格"
      >
        距离阈值
      </label>
      <input
        class="r-input"
        type="number"
        min="0"
        step="any"
        :value="distanceThreshold"
        :disabled="computing"
        title="与点云坐标同单位"
        @input="onThresholdInput"
      />
    </div>

    <!-- 最大迭代次数 -->
    <div class="r-group">
      <label class="r-label" title="假设循环的轮数上限；通常远早于此自动收敛，实际轮数见日志。平面占比低时要调大">
        最大迭代
      </label>
      <input
        class="r-input r-input--narrow"
        type="number"
        min="0"
        step="1"
        :value="maxIterations"
        :disabled="computing"
        @input="onIterationsInput"
      />
    </div>

    <!-- 系数优化 -->
    <div class="r-group">
      <label
        class="r-label"
        title="对内点集做最小二乘精修（对齐 PCL setOptimizeCoefficients）：法向更准，但精修后内点数可能略减——实现里会取内点更多的一版"
      >
        <input
          class="r-check"
          type="checkbox"
          :checked="optimizeCoefficients"
          :disabled="computing"
          @change="onOptimizeChange"
        />
        系数优化
      </label>
    </div>

    <!-- 引导提示（未按当前参数预览时显示；已有旧预览保留显示，仅提示需重新预览） -->
    <span v-if="!previewed && !computing" class="r-hint">{{
      stats ? '参数已变更，点击「预览」更新效果' : '点击「预览」生成效果'
    }}</span>

    <!-- 结果统计行 -->
    <div
      v-if="stats"
      class="r-stats"
      title="最近一次预览的统计（全部目标合计）；平面度取自内点最多的那个平面，逐实体明细见 Console"
    >
      内点 <b>{{ stats.inlierTotal.toLocaleString() }}</b>
      <span class="r-stats__sep">/</span>
      {{ shareText(stats.inlierTotal, stats.candidateTotal) }}
      <template v-if="stats.entitiesTotal > 1">
        <span class="r-stats__sep">·</span>
        平面 {{ stats.planesFound }}/{{ stats.entitiesTotal }}
      </template>
      <template v-if="stats.rms !== null">
        <span class="r-stats__sep">·</span>
        RMS {{ stats.rms.toExponential(2) }}
      </template>
    </div>

    <div class="r-group">
      <!-- 预览：手动触发计算（计算中禁用） -->
      <button
        class="r-btn r-btn--preview"
        title="按当前参数计算并只显示平面内点，同时在 3D 里画出平面片与法线（可旋转确认贴合）"
        :disabled="computing"
        @click="runPreview"
      >
        {{ computing ? '计算中…' : '预览' }}
      </button>
      <!-- 确定：须先按当前参数预览 -->
      <button
        class="r-btn r-btn--primary"
        title="按预览结果拆分 <名称>.plane / <名称>.remaining，并选中 remaining 以便连续剥离（需先点击预览）"
        :disabled="!previewed || computing"
        @click="applyExtract"
      >
        确定
      </button>
      <button class="r-btn" title="放弃并退出平面拟合模式（Esc）" :disabled="computing" @click="exitRansacPlane(false)">
        取消
      </button>
    </div>
  </div>
</template>

<style scoped>
.r-bar {
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
.r-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.r-group:last-child {
  padding-right: 0;
  border-right: none;
}
.r-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.r-check {
  margin: 0;
}
.r-input {
  width: 92px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.r-input--narrow {
  width: 60px;
}
.r-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.r-input:disabled {
  opacity: 0.5;
}
.r-hint {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
.r-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.r-stats__sep {
  opacity: 0.5;
}
.r-btn {
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
.r-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.r-btn--preview {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.r-btn--preview:hover {
  background: rgba(96, 0, 167, 0.16);
}
.r-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.r-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.r-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.r-btn:disabled:hover {
  background: transparent;
}
.r-btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
</style>
