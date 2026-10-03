<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRansacCylinderStore, type CylinderAxisMode } from '../stores/ransacCylinderStore'

/**
 * RANSAC 圆柱拟合横条工具栏（浮层，3D 视图区右上角，与 RansacPlaneToolBar 同款样式）。
 *
 * 点击竖栏 RANSAC 圆柱按钮后显示：距离阈值 + 最大迭代 + 系数优化 + 半径范围 + **轴方向** +
 * 结果统计行 + 预览/确定/取消。参数改动**不影响屏上已有的预览**（旧效果保留供对照微调），
 * 只有点「预览」才按原始数据 + 当前参数重算并整体替换（C++ node-addon 计算）。
 * 确定仅当预览由当前参数生成后可用；计算期间全部输入与按钮禁用。
 * 预览只显示圆柱内点并在 3D 里画出圆柱线框与轴方向箭头，不锁相机；Esc = 取消。
 *
 * **轴方向那一行是本功能与平面拟合最大的界面差异**：圆柱比平面多一个自由度，这个自由度必须由
 * 别处提供，故给两条路——默认「用实体法向量」（拿 `Edit ▸ Normals` 算出的法线估轴，对齐 PCL
 * `SACSegmentationFromNormals`；预览后把估出来的向量与**轴得分**显示出来供核对），也可直接选
 * 竖直/水平/自定义（此时是**约束**，native 不做任何重估，也不需要法线）。
 *
 * **软堵**：点云没算过法线时，「用实体法向量」这一档不禁用（用户可能只是还没轮到这个下拉），
 * 而是禁用「预览」并显示一行操作指引；其余三档照常可用。详见 native/ransac-cylinder/README-REF.md。
 *
 * 已知局限写进 title（别让用户当成 bug）：均匀采样 RANSAC 找不出占比过低的圆柱；法线估轴的
 * 场合还有一层——点云里几乎没有圆柱面时轴得分会贴着闸门（0.02），此时判未找到。
 */

const {
  active,
  distanceThreshold,
  maxIterations,
  optimizeCoefficients,
  minRadius,
  maxRadius,
  axisMode,
  normalsReady,
  normalsCoverage,
  axisX,
  axisY,
  axisZ,
  computing,
  previewed,
  stats,
  setParams,
  setAxisMode,
  setCustomAxis,
  runPreview,
  applyExtract,
  exitRansacCylinder,
} = useRansacCylinderStore()

/** 「用实体法向量」模式但点云没法线：预览按钮禁用（软堵，指引见提示行）。 */
function needNormals(): boolean {
  return axisMode.value === 'normals' && !normalsReady.value
}

/** 参数输入的统一出口（未改动的项按当前值回填，store 内做钳制与去重）。 */
function pushParams(over: Partial<Record<'dt' | 'mi' | 'opt' | 'mn' | 'mx', number | boolean>>) {
  setParams(
    (over.dt as number) ?? distanceThreshold.value,
    (over.mi as number) ?? maxIterations.value,
    (over.opt as boolean) ?? optimizeCoefficients.value,
    (over.mn as number) ?? minRadius.value,
    (over.mx as number) ?? maxRadius.value
  )
}

/** 距离阈值输入 → setParams（钳制在 store 内；NaN 不更新）。 */
function onThresholdInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) pushParams({ dt: v })
}

/** 最大迭代次数输入 → setParams（store 内取整钳制）。 */
function onIterationsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) pushParams({ mi: v })
}

/** 系数优化开关 → setParams。 */
function onOptimizeChange(e: Event) {
  pushParams({ opt: (e.target as HTMLInputElement).checked })
}

/** 半径下限输入（0 = 不限制，由 store 归一）。 */
function onMinRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) pushParams({ mn: v })
}

/** 半径上限输入（0 = 不限制）。 */
function onMaxRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) pushParams({ mx: v })
}

/** 轴方向来源切换。 */
function onAxisModeChange(e: Event) {
  setAxisMode((e.target as HTMLSelectElement).value as CylinderAxisMode)
}

/** 自定义轴分量输入（三个分量共用一个出口，未改动的两个按当前值回填）。 */
function onCustomAxisInput(which: 'x' | 'y' | 'z', e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (Number.isNaN(v)) return
  const next = { x: axisX.value, y: axisY.value, z: axisZ.value }
  next[which] = v
  setCustomAxis(next.x, next.y, next.z)
}

/** Esc = 取消并退出圆柱拟合模式（与其余模态的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitRansacCylinder(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))

/** 内点占比百分数（候选为 0 时不显示，防除零）。 */
function shareText(inlier: number, total: number): string {
  return total > 0 ? `${((inlier / total) * 100).toFixed(2)}%` : '—'
}

/** 轴向量三点显示（法线估轴的结果核对用）。 */
function axisText(a: { x: number; y: number; z: number }): string {
  return `(${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${a.z.toFixed(3)})`
}

/** 轴得分显示（null = 显式轴/未找到，不显示）。 */
function axisScoreText(v: number | null): string {
  return v === null ? '' : `· 得分 ${v.toFixed(3)}`
}

/** 轴得分是否偏低（认轴闸门是 0.02，低于 0.1 就说明这个轴多半是勉强凑出来的）。 */
function axisScoreLow(v: number | null): boolean {
  return v !== null && v < 0.1
}

/** 半径/半高的显示（去掉浮点尾噪）。 */
function numText(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(4)
}
</script>

<template>
  <div v-if="active" class="r-bar">
    <!-- 距离阈值 -->
    <div class="r-group">
      <label
        class="r-label"
        title="点到圆柱面的距离（|到轴的垂距 − 半径|）≤ 它即算内点（与点云坐标同单位）；调大能把更稀疏/更噪的圆柱面纳入内点，调小更严格"
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
      <label class="r-label" title="假设循环的轮数上限；通常远早于此自动收敛，实际轮数见日志。圆柱占比低时要调大">
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

    <!-- 半径范围（文章的 RadiusLimits） -->
    <div class="r-group">
      <label
        class="r-label"
        title="半径的最小值 / 最大值（对齐 PCL 的 RadiusLimits）：越界的假设整轮丢弃。0 = 该侧不限制；知道大概半径时限定它可显著减少无效假设"
      >
        半径
      </label>
      <input
        class="r-input r-input--axis"
        type="number"
        min="0"
        step="any"
        :value="minRadius"
        :disabled="computing"
        title="半径下限；0 = 不限制"
        @input="onMinRadiusInput"
      />
      <span class="r-stats__sep">~</span>
      <input
        class="r-input r-input--axis"
        type="number"
        min="0"
        step="any"
        :value="maxRadius"
        :disabled="computing"
        title="半径上限；0 = 不限制"
        @input="onMaxRadiusInput"
      />
    </div>

    <!-- 轴方向（圆柱独有的自由度） -->
    <div class="r-group">
      <label
        class="r-label"
        title="圆柱的轴方向。「用实体法向量」= 拿本点云已有的法向量估轴（对齐 PCL SACSegmentationFromNormals：法线 ⊥ 轴 ⇒ 成对法线叉积定轴，再用一致法线的各向异性比排除平面主导的假轴）——要求先算过法线；选竖直/水平/自定义则为约束，native 只归一化、不做任何重估，也不需要法线"
      >
        轴方向
      </label>
      <select class="r-select" :value="axisMode" :disabled="computing" @change="onAxisModeChange">
        <option value="normals">用实体法向量</option>
        <option value="vertical">竖直 Z</option>
        <option value="horizontalX">水平 X</option>
        <option value="custom">自定义</option>
      </select>
      <template v-if="axisMode === 'custom'">
        <input
          class="r-input r-input--axis"
          type="number"
          step="any"
          :value="axisX"
          :disabled="computing"
          title="轴方向 X 分量（与 Y、Z 组成方向向量；无需归一化，不能全为 0）"
          @input="onCustomAxisInput('x', $event)"
        />
        <input
          class="r-input r-input--axis"
          type="number"
          step="any"
          :value="axisY"
          :disabled="computing"
          title="轴方向 Y 分量"
          @input="onCustomAxisInput('y', $event)"
        />
        <input
          class="r-input r-input--axis"
          type="number"
          step="any"
          :value="axisZ"
          :disabled="computing"
          title="轴方向 Z 分量"
          @input="onCustomAxisInput('z', $event)"
        />
      </template>
      <span
        v-else-if="axisMode === 'normals' && stats && stats.axisEstimated && stats.axis"
        class="r-axis"
        title="本次预览由法线估计出的轴方向（已归一化）；若明显不合理，说明点云里圆柱面占比低、投票抽不到成对法线——可先框选局部，或直接指定竖直/自定义轴"
      >
        {{ axisText(stats.axis) }}
        <span
          v-if="stats.axisScore !== null"
          class="r-axis__score"
          :class="{ 'r-axis__score--low': axisScoreLow(stats.axisScore) }"
          title="轴候选得分 = 票数占比 × 一致法线各向异性比 ∈ [0,1]；平面法线只有一个方向（比值≈0），柱面径向法线在垂直轴的面内各向同性（比值≈1）。0.02 是认轴闸门；低于 0.1 说明这个轴多半是勉强凑出来的"
        >
          {{ axisScoreText(stats.axisScore) }}
        </span>
      </span>
    </div>

    <!-- 系数优化 -->
    <div class="r-group">
      <label
        class="r-label"
        title="对内点集做精修（对齐 PCL setOptimizeCoefficients）：由法线估计轴时同时重估轴方向与圆参数，方向更准，但精修后内点数可能略减——实现里会取内点更多的一版"
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

    <!-- 没法线的软堵提示（盖过"点预览"提示：此时预览根本按不下去） -->
    <span v-if="needNormals()" class="r-hint r-hint--warn">
      该点云没有可用的法向量（覆盖 {{ (normalsCoverage * 100).toFixed(0) }}%）：先 Edit ▸ Normals ▸ Compute
      normals 计算（可先用 Auto 估半径），或把轴方向改成竖直 Z / 水平 X / 自定义
    </span>
    <!-- 引导提示（未按当前参数预览时显示；已有旧预览保留显示，仅提示需重新预览） -->
    <span v-else-if="!previewed && !computing" class="r-hint">{{
      stats ? '参数已变更，点击「预览」更新效果' : '点击「预览」生成效果'
    }}</span>

    <!-- 结果统计行 -->
    <div
      v-if="stats"
      class="r-stats"
      title="最近一次预览的统计（全部目标合计）；半径/圆柱度取自内点最多的那个圆柱，逐实体明细见 Console"
    >
      内点 <b>{{ stats.inlierTotal.toLocaleString() }}</b>
      <span class="r-stats__sep">/</span>
      {{ shareText(stats.inlierTotal, stats.candidateTotal) }}
      <template v-if="stats.entitiesTotal > 1">
        <span class="r-stats__sep">·</span>
        圆柱 {{ stats.cylindersFound }}/{{ stats.entitiesTotal }}
      </template>
      <template v-if="stats.radius !== null">
        <span class="r-stats__sep">·</span>
        R {{ numText(stats.radius) }}
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
        :title="
          needNormals()
            ? '该点云没有可用的法向量：先用 Edit ▸ Normals ▸ Compute normals 计算，或把轴方向改成竖直/水平/自定义（这三档不需要法线）'
            : '按当前参数计算并只显示圆柱内点，同时在 3D 里画出圆柱线框与轴方向箭头（可旋转确认贴合）'
        "
        :disabled="computing || needNormals()"
        @click="runPreview"
      >
        {{ computing ? '计算中…' : '预览' }}
      </button>
      <!-- 确定：须先按当前参数预览 -->
      <button
        class="r-btn r-btn--primary"
        title="按预览结果拆分 <名称>.cylinder / <名称>.remaining，并选中 remaining 以便连续剥离（需先点击预览）"
        :disabled="!previewed || computing"
        @click="applyExtract"
      >
        确定
      </button>
      <button
        class="r-btn"
        title="放弃并退出圆柱拟合模式（Esc）"
        :disabled="computing"
        @click="exitRansacCylinder(false)"
      >
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
  /* 控件比平面拟合多两组（半径范围 + 轴方向），窄窗口下换行而不是溢出 */
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: calc(100% - 16px);
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
.r-input--axis {
  width: 62px;
}
.r-select {
  height: 28px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.r-select:disabled {
  opacity: 0.5;
}
.r-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.r-input:disabled {
  opacity: 0.5;
}
.r-axis {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
/* 轴得分：附着在估出来的轴向量后面，低分时转警示色（"这个轴多半是凑的"） */
.r-axis__score {
  opacity: 0.8;
}
.r-axis__score--low {
  color: var(--md-error, #b3261e);
  opacity: 1;
}
.r-hint {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
/* 没法线的指引较长，允许换行（否则 nowrap 会横向撑破浮层） */
.r-hint--warn {
  color: var(--md-error, #b3261e);
  white-space: normal;
  max-width: 420px;
  line-height: 1.4;
  text-align: right;
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
