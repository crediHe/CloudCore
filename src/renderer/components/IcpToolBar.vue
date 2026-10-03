<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useIcpStore } from '../stores/icpStore'
import { useSceneStore } from '../stores/sceneStore'
import type { RotationFilterMode } from '../utils/registration'

/**
 * 精细配准（ICP）工具栏（浮层，3D 视图区右上角，与 FilterToolBar 同款样式母版）。
 *
 * 参数默认值全部照抄 CC 的 `ccRegistrationDlg`（最大迭代 20 / RMS 变化阈值 1e-5 /
 * 采样上限 50000 / 重叠度 100% / 不估计缩放 / 不剔最远点），面板上另加变换过滤器组
 * （与 Align 同一套语义与开关：旋转 5 档 + Tx·Ty·Tz）。
 *
 * 角色条与 AlignToolBar 同款：`待配准`（data，会动）在两个目标点云里二选一，另半边即对调。
 * 结果行显示 `初始 RMS → 最终 RMS`，这是 ICP 质量判断的主要依据：两片云真正贴合时最终 RMS
 * 会落到扫描噪声量级；只收敛到一个局部极小时它也会明显下降，但环顾画面能看出错位——
 * 所以预览要转一圈看（面板不锁相机）。
 *
 * 参数改动**不撤销已有预览**（留着旧效果对照），但「确定」会禁用直到重新「预览」；
 * 计算期间全部输入禁用；Esc = 取消。
 */

const {
  active,
  targetEntityIds,
  dataEntityId,
  modelEntityId,
  params,
  computing,
  previewed,
  stats,
  canRun,
  setParams,
  setDataEntity,
  run,
  applyIcp,
  exitIcp,
} = useIcpStore()
const { getAllEntities } = useSceneStore()

/** 实体名（点云可能已被删除，故留 id 兜底）。 */
function nameOf(id: number): string {
  return getAllEntities().find((e) => e.id === id)?.name ?? String(id)
}

/** 参考侧（角色条要显示）。 */
const modelName = computed(() => nameOf(modelEntityId.value))

/** 角色分段控件：两个目标点云（顺序 = 选择顺序）。 */
const roleChoices = computed(() => targetEntityIds.value)

/** 最大迭代轮数输入。 */
function onIterationsInput(e: Event) {
  setParams({ maxIterations: parseFloat((e.target as HTMLInputElement).value) })
}

/** RMS 变化阈值输入（相邻两轮下降小于它即收敛）。 */
function onMinRmsInput(e: Event) {
  setParams({ minRMSDecrease: parseFloat((e.target as HTMLInputElement).value) })
}

/** 采样上限输入（每片云参与计算的点数上限，超出则随机降采样）。 */
function onSamplingInput(e: Event) {
  setParams({ samplingLimit: parseFloat((e.target as HTMLInputElement).value) })
}

/** 重叠度输入（百分数 → 0~1；面板上按 % 显示更直观）。 */
function onOverlapInput(e: Event) {
  const pct = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isFinite(pct)) return
  setParams({ finalOverlapRatio: pct / 100 })
}

/** 剔除最远点开关（每轮先按 μ+2.5σ 滤一遍距离过大的点）。 */
function onFarthestChange(e: Event) {
  setParams({ filterOutFarthestPoints: (e.target as HTMLInputElement).checked })
}

/** 缩放估计开关。 */
function onScaleChange(e: Event) {
  setParams({ adjustScale: (e.target as HTMLInputElement).checked })
}

/** 旋转过滤档切换。 */
function onRotChange(e: Event) {
  setParams({ rotFilterMode: (e.target as HTMLSelectElement).value as RotationFilterMode })
}

/** 平移分量锁定开关。 */
function onSkipChange(axis: 'skipTx' | 'skipTy' | 'skipTz', e: Event) {
  const on = (e.target as HTMLInputElement).checked
  setParams(axis === 'skipTx' ? { skipTx: on } : axis === 'skipTy' ? { skipTy: on } : { skipTz: on })
}

/** Esc = 取消并退出 ICP 模式（与其余模态的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitIcp(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="i-bar">
    <!-- 第一行：角色 + 参数 -->
    <div class="i-row">
      <div class="i-group">
        <span class="i-label" title="「待配准」= 会被搬动的那一片（相当于 CC 的 data）；另一个是不动的参考（model）">
          待配准
        </span>
        <div class="i-seg">
          <button
            v-for="id in roleChoices"
            :key="id"
            class="i-seg__btn"
            :class="{ 'i-seg__btn--on': id === dataEntityId }"
            :disabled="computing"
            :title="`把「${nameOf(id)}」作为待配准（会被搬动）；点另一个即对调角色（会清空上一次结果）`"
            @click="setDataEntity(id)"
          >
            {{ nameOf(id) }}
          </button>
        </div>
        <span class="i-label i-label--dim" :title="`参考（不动）：${modelName}`">← {{ modelName }}</span>
      </div>

      <div class="i-group">
        <label class="i-label" title="迭代轮数上限；通常远早于此收敛（实际轮数见结果行）"> 最大迭代 </label>
        <input
          class="i-input i-input--narrow"
          type="number"
          min="1"
          step="1"
          :value="params.maxIterations"
          :disabled="computing"
          @input="onIterationsInput"
        />
        <label
          class="i-label"
          title="相邻两轮的 RMS 下降小于它就认为收敛（1e-5 是 CC 的默认值）；它只影响何时停，不影响每轮算出的变换"
        >
          RMS 阈值
        </label>
        <input
          class="i-input i-input--narrow"
          type="number"
          step="any"
          :value="params.minRMSDecrease"
          :disabled="computing"
          @input="onMinRmsInput"
        />
        <label
          class="i-label"
          title="每片点云参与计算的点数上限（超出则随机降采样）；配准精度与它关系不大，耗时与它成正比"
        >
          采样上限
        </label>
        <input
          class="i-input"
          type="number"
          min="1"
          step="1000"
          :value="params.samplingLimit"
          :disabled="computing"
          @input="onSamplingInput"
        />
        <label
          class="i-label"
          title="预期的重叠度（%）：两片云只重叠一部分时调小它，算法每轮只保留距离最近的这一部分点，否则不重叠的那部分会把结果拖偏"
        >
          重叠度%
        </label>
        <input
          class="i-input i-input--narrow"
          type="number"
          min="1"
          max="100"
          step="5"
          :value="Math.round(params.finalOverlapRatio * 100)"
          :disabled="computing"
          @input="onOverlapInput"
        />
      </div>

      <div class="i-group i-group--tail">
        <label class="i-label" title="每轮先按 μ+2.5σ 剔除距离过大的点（两片云有少量离群/非重叠点时有用）">
          <input
            class="i-check"
            type="checkbox"
            :checked="params.filterOutFarthestPoints"
            :disabled="computing"
            @change="onFarthestChange"
          />
          剔除最远点
        </label>
      </div>
    </div>

    <!-- 第二行：过滤器 + 按钮 -->
    <div class="i-row">
      <div class="i-group">
        <label class="i-label" title="旋转过滤：只允许绕某个轴的旋转（近似「先摆正一个方向」）；「不旋转」= 只解平移">
          旋转
        </label>
        <select class="i-select" :value="params.rotFilterMode" :disabled="computing" @change="onRotChange">
          <option value="none">不过滤</option>
          <option value="x">仅绕 X</option>
          <option value="y">仅绕 Y</option>
          <option value="z">仅绕 Z</option>
          <option value="fixed">不旋转</option>
        </select>
        <label class="i-label" title="锁定 Tx 平移分量">
          <input
            class="i-check"
            type="checkbox"
            :checked="params.skipTx"
            :disabled="computing"
            @change="onSkipChange('skipTx', $event)"
          />Tx
        </label>
        <label class="i-label" title="锁定 Ty 平移分量">
          <input
            class="i-check"
            type="checkbox"
            :checked="params.skipTy"
            :disabled="computing"
            @change="onSkipChange('skipTy', $event)"
          />Ty
        </label>
        <label class="i-label" title="锁定 Tz 平移分量">
          <input
            class="i-check"
            type="checkbox"
            :checked="params.skipTz"
            :disabled="computing"
            @change="onSkipChange('skipTz', $event)"
          />Tz
        </label>
        <label class="i-label" title="同时估计缩放（默认关：两片云应是同一个扫描比例，缩放多半是在吸收噪声）">
          <input
            class="i-check"
            type="checkbox"
            :checked="params.adjustScale"
            :disabled="computing"
            @change="onScaleChange"
          />
          调整比例
        </label>
      </div>

      <div class="i-group i-group--tail">
        <button
          class="i-btn i-btn--preview"
          title="按当前参数迭代求解，并把结果临时施加到待配准点云上（只改显示位姿，不动数据）；绕一圈确认贴合后再「确定」"
          :disabled="!canRun"
          @click="run"
        >
          {{ computing ? '计算中…' : '预览' }}
        </button>
        <button
          class="i-btn i-btn--primary"
          title="把预览的变换永久烘焙进顶点缓冲，并把点云改名为 <名称>.registered（需先「预览」）"
          :disabled="!previewed || computing"
          @click="applyIcp"
        >
          确定
        </button>
        <button
          class="i-btn"
          title="放弃并退出精细配准模式（Esc）；未烘焙的预览会被还原"
          :disabled="computing"
          @click="exitIcp(false)"
        >
          取消
        </button>
      </div>
    </div>

    <!-- 第三行：结果 -->
    <div class="i-row i-row--info">
      <!-- 结果码 1 = ICP_APPLY_TRANSFO（收敛，产出可用变换）；其余都算"没产出可用的变换" -->
      <span class="i-hint" :class="{ 'i-hint--warn': stats !== null && stats.result !== 1 }">
        <template v-if="!stats">点「预览」开始迭代（两片云位姿差大时先用「点对对齐」粗配准）</template>
        <template v-else>{{ stats.message }}</template>
      </span>
      <span v-if="stats" class="i-stats" title="首轮 RMS → 最终 RMS；参与点数与迭代轮数取最近一次预览">
        RMS <b>{{ stats.initialRms.toExponential(3) }}</b>
        <span class="i-stats__sep">→</span>
        <b>{{ stats.rms.toExponential(3) }}</b>
        <span class="i-stats__sep">·</span>
        {{ stats.iterations }} 轮
        <span class="i-stats__sep">·</span>
        {{ stats.pointCount.toLocaleString() }} 点
        <template v-if="params.adjustScale">
          <span class="i-stats__sep">·</span>
          缩放 {{ stats.scale.toPrecision(6) }}
        </template>
      </span>
      <span v-if="previewed" class="i-hint">已预览（改动参数后需重新预览才能「确定」）</span>
      <span v-else-if="stats" class="i-hint i-hint--warn">参数已变更，点击「预览」更新结果</span>
    </div>
  </div>
</template>

<style scoped>
.i-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  max-width: min(880px, calc(100% - 16px));
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 10;
}
.i-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.i-row--info {
  padding: 0 4px;
}
.i-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.i-group--tail {
  margin-left: auto;
  padding-right: 0;
  border-right: none;
}
.i-label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.i-label--dim {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
}
.i-check {
  margin: 0;
}
.i-input {
  width: 84px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.i-input--narrow {
  width: 56px;
}
.i-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.i-input:disabled {
  opacity: 0.5;
}
.i-select {
  height: 28px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.i-select:disabled {
  opacity: 0.5;
}
/* 角色分段控件（同 AlignToolBar）：点另半边即对调 data/model */
.i-seg {
  display: flex;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  overflow: hidden;
}
.i-seg__btn {
  height: 28px;
  max-width: 150px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--md-on-surface);
  background: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.i-seg__btn + .i-seg__btn {
  border-left: 1px solid rgba(0, 0, 0, 0.12);
}
.i-seg__btn--on {
  background: var(--md-primary);
  color: #fff;
}
.i-seg__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.i-hint {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
.i-hint--warn {
  color: var(--md-error, #b3261e);
}
.i-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.i-stats__sep {
  opacity: 0.5;
}
.i-btn {
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
.i-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
}
.i-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.i-btn--preview {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.i-btn--preview:hover:not(:disabled) {
  background: rgba(96, 0, 167, 0.16);
}
.i-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.i-btn--primary:hover:not(:disabled) {
  filter: brightness(0.95);
}
</style>
