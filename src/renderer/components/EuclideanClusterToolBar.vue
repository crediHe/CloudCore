<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useEuclideanClusterStore } from '../stores/euclideanClusterStore'
import { CLUSTER_NOISE_SRGB } from '../utils/euclideanCluster'

/**
 * 欧式聚类分割参数横条（浮层，3D 视图区右上角，视觉体系同 TreeIsoToolBar）。
 * 对应 native/euclidean-cluster（PCL `EuclideanClusterExtraction` 语义）。
 *
 * 交互是**预览 + 分割**（聚类阈值天生靠试，必须"先看见再决定"）：
 * - 「预览」跑 native 算全部连通分量 → 每个入选簇染一个区分色、其余（含点数不足的碎簇）
 *   显示为灰，并在下面报数；
 * - 「最小点数 / 最大点数」只是渲染侧过滤，改它们**不重算**、画面与数字秒变；
 * - 只有「距离阈值」改了才需要重新预览（结果过期时下面会提示，直接点「分割」会按新
 *   参数自动重算，绝不拿旧阈值的结果去拆）；
 * - 「分割」把源点云替换成「`<源名> 聚类` 容器 + Cluster 1..N + `<源名>.noise` 残点」。
 *
 * 已知边界（算法固有，不是缺陷）：阈值大于两物体间隙时它们必然被并成一簇；
 * 预览里看到"粘连"就调小阈值，看到"碎片"就调大阈值或调小最小点数。
 */

const {
  active,
  targetName,
  tolerance,
  minPoints,
  maxPoints,
  computing,
  previewed,
  stats,
  setParams,
  runPreview,
  runAndSplit,
  exitEuclideanCluster,
} = useEuclideanClusterStore()

/** 数值展示去尾噪（用户输入的小数可能很长）。 */
function formatParam(x: number): number {
  return Number.isInteger(x) ? x : parseFloat(x.toFixed(6))
}

/** 预览结果行文案（零结果 / 无入选 / 过期 三种提示优先）。 */
const resultText = computed(() => {
  const s = stats.value
  if (!s) return '点「预览」查看聚类结果（逐簇异色，未入选的点显示为灰）'
  const head = `${s.clusterCount.toLocaleString()} 个聚类 · 入选 ${s.keptCount.toLocaleString()}（${s.keptPoints.toLocaleString()} 点）· 残点 ${s.noisePoints.toLocaleString()} 点`
  const largest = ` · 最大簇 ${s.largestClusterPoints.toLocaleString()} 点`
  if (!previewed.value) return `${head}${largest} —— 阈值已改，预览已过期（分割会按新参数重算）`
  if (s.keptCount === 0) return `${head}${largest} —— 没有入选的聚类：调大阈值或调小最小点数`
  return `${head}${largest}`
})

/** 输入 → setParams（钳制在 store 内；NaN 不更新）。 */
function onToleranceInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ tolerance: v })
}
function onMinPointsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ minPoints: v })
}
function onMaxPointsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ maxPoints: v })
}

/** Esc = 退出聚类模式（与其余模态一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitEuclideanCluster()
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="cluster-bar">
    <div class="cluster-bar__head">
      <span
        class="cluster-bar__name"
        title="欧式聚类分割（PCL EuclideanClusterExtraction 语义）：按距离阈值把空间上独立的物体切成一个个点云。阈值大于两物体间隙时它们会被并成一簇（算法固有）"
      >
        Euclidean Cluster · 欧式聚类
      </span>
      <span class="cluster-bar__target" title="聚类目标（进入模式时锁定）">目标：{{ targetName }}</span>
    </div>

    <!-- 参数行：阈值（算法参数）+ 最小/最大点数（渲染侧过滤） -->
    <div class="cluster-row">
      <div class="cluster-field">
        <label
          class="cluster-label"
          title="聚类距离阈值（m）：两点距离 ≤ 阈值即视为同一物体。调大 → 物体粘连，调小 → 碎成多块"
          >距离阈值(m)</label
        >
        <input
          class="cluster-input"
          type="number"
          min="0.000001"
          step="any"
          :value="formatParam(tolerance)"
          :disabled="computing"
          title="聚类距离阈值（m）：距离 ≤ 阈值的点归为同一簇；改它需要重新预览"
          @input="onToleranceInput"
        />
      </div>
      <div class="cluster-field">
        <label class="cluster-label" title="点数低于它的簇视为噪声，归入残点实体（不重算，立即生效）">最小点数</label>
        <input
          class="cluster-input cluster-input--narrow"
          type="number"
          min="1"
          step="1"
          :value="minPoints"
          :disabled="computing"
          title="簇有效点数下限（含）：低于它的簇归入残点实体。改它不重算，立即生效"
          @input="onMinPointsInput"
        />
      </div>
      <div class="cluster-field">
        <label class="cluster-label" title="点数高于它的簇视为背景/过大连通片，归入残点实体（0 = 不限）"
          >最大点数(0=不限)</label
        >
        <input
          class="cluster-input cluster-input--narrow"
          type="number"
          min="0"
          step="1"
          :value="maxPoints"
          :disabled="computing"
          title="簇有效点数上限（含）；0 = 不限。用来剔掉「背景连成一大片」的簇。改它不重算，立即生效"
          @input="onMaxPointsInput"
        />
      </div>
    </div>

    <!-- 操作行 + 结果行 -->
    <div class="cluster-row">
      <button
        class="cluster-btn"
        title="按当前阈值重跑聚类并把每个入选簇染成区分色（未入选的点显示为灰）"
        :disabled="computing"
        @click="runPreview"
      >
        {{ computing ? '计算中…' : previewed ? '重新预览' : '预览' }}
      </button>
      <button
        class="cluster-btn cluster-btn--primary"
        title="按当前参数把源点云拆成「聚类容器 + Cluster 1..N + 残点实体」；阈值若已改动会先自动重算"
        :disabled="computing || (previewed && !!stats && stats.keptCount === 0)"
        @click="runAndSplit"
      >
        分割
      </button>
      <button class="cluster-btn" title="放弃并退出（Esc）" @click="exitEuclideanCluster">取消</button>
      <span
        class="cluster-result"
        :class="{ 'cluster-result--warn': previewed && !!stats && stats.keptCount === 0 }"
        :title="`未入选的点在预览里显示为灰色（sRGB ${CLUSTER_NOISE_SRGB}）`"
        >{{ resultText }}</span
      >
    </div>
  </div>
</template>

<style scoped>
/* —— 视觉体系同 TreeIsoToolBar / CsfToolBar（白底毛玻璃浮层，右上角定位） —— */
.cluster-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 10;
  max-width: calc(100% - 16px);
}
.cluster-bar__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 6px 2px;
}
.cluster-bar__name {
  font-size: 12px;
  font-weight: 600;
  color: var(--md-primary);
  user-select: none;
  white-space: nowrap;
}
.cluster-bar__target {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cluster-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(255, 255, 255, 0.4);
  flex-wrap: wrap;
}
.cluster-field {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cluster-label {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
  user-select: none;
}
.cluster-input {
  width: 76px;
  height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  color: var(--md-on-surface);
  font-variant-numeric: tabular-nums;
}
.cluster-input--narrow {
  width: 56px;
}
.cluster-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.cluster-input:disabled {
  opacity: 0.5;
}
.cluster-btn {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  background: transparent;
  white-space: nowrap;
  cursor: pointer;
}
.cluster-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.cluster-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.cluster-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.cluster-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.cluster-btn:disabled:hover {
  background: transparent;
}
.cluster-btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
.cluster-result {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  user-select: none;
  white-space: nowrap;
}
.cluster-result--warn {
  color: var(--md-error, #b3261e);
}
</style>
