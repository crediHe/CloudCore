<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { usePowerlineStore } from '../stores/powerlineStore'
import type { PowerlineGroundSource } from '../stores/powerlineStore'
import {
  LINE_NOISE_SRGB,
  POWERLINE_LOOSE_MAX_SLOPE_DEG,
  POWERLINE_LOOSE_MIN_LINEARITY,
  POWERLINE_POOL_MAX_POINTS,
} from '../utils/powerline'

/**
 * 电力线提取参数横条（浮层，3D 视图区右上角，视觉体系同 EuclideanClusterToolBar）。
 * 对应 native/powerline（两阶段：候选提取 + 抛物线模型连线）。
 *
 * 交互是**预览 + 分割**（导线与假阳性只有看了才知道）：
 * - 「预览」建地面参考面 → 候选提取 → 精筛 → 连线 → 每条线一个区分色、未成线显示为灰；
 * - 参数**按代价分三级**，从标签上的角标一眼可辨：
 *   〔重〕离地高 / 邻域半径 —— 重跑全量 KD 树 + 逐点 PCA（秒级〜十秒级）；
 *   〔即时〕线性度 / 倾角 —— 只重跑渲染侧精筛 + 连线（毫秒级）；
 *   〔轻〕其余 —— 只重跑连线（候选只有几千〜几万点）；
 * - 改任何参数都让预览过期（下面会提示），直接点「分割」会按新参数自动重算，
 *   绝不拿旧参数的结果去拆；
 * - 「分割」把源点云替换成「`<源名> 电力线` 容器 + `Line <线号>` + `<源名>.noise` 残点」，
 *   线号同时是该实体的**编号**（属性面板 Tree ID），导出时写进 `treeid`。
 *
 * 已知边界（算法固有，不是缺陷）：屋脊 / 围栏 / 树枝段也可能局部线性；三道闸
 * （抛物线残差 / 最短线长 / 补全共线门限）能滤掉大部分，仍漏时请调大「最短线长」。
 */

const {
  active,
  targetName,
  params,
  groundSource,
  computing,
  previewed,
  stats,
  groundUsed,
  groundPoints,
  gridCellSize,
  setParams,
  setGroundSource,
  runPreview,
  runAndSplit,
  exitPowerline,
} = usePowerlineStore()

/** 数值展示去尾噪（用户输入的小数可能很长）。 */
function formatParam(x: number): number {
  return Number.isInteger(x) ? x : parseFloat(x.toFixed(4))
}

/** 地面来源三档（顺序与 store 的 GROUND_SOURCE_LABELS 一致）。 */
const GROUND_OPTIONS: { value: PowerlineGroundSource; label: string; title: string }[] = [
  {
    value: 'auto',
    label: '自动',
    title: '有 LAS 分类且含「2 = 地面」就用它，否则跑 CSF 自动识别地面（推荐）',
  },
  {
    value: 'classification',
    label: '用已有分类',
    title: '只用文件里的「2 = 地面」分类点；没有则报错并提示（不偷偷改跑 CSF）',
  },
  {
    value: 'csf',
    label: 'CSF 识别',
    title: '忽略已有分类，统一用 CSF 布料模拟识别地面（与 CSF 工具同参数推导）',
  },
]

/** 预览结果行文案（未预览 / 无结果 / 无成线 / 过期 四种提示优先）。 */
const resultText = computed(() => {
  const s = stats.value
  if (!s) return '点「预览」查看提取结果（每条线一个颜色，未成线的点显示为灰）'
  const head =
    `${s.lineCount.toLocaleString()} 条线 · 成线 ${s.linePoints.toLocaleString()} 点` +
    `（最长 ${formatParam(s.longestLine)} m、总长 ${formatParam(s.totalLength)} m）· ` +
    `残点 ${s.noisePoints.toLocaleString()} 点`
  const gaps = s.gapLines > 0 ? ` · ${s.gapLines} 条补过口` : ''
  if (!previewed.value) return `${head}${gaps} —— 参数已改，预览已过期（分割会按新参数重算）`
  if (s.lineCount === 0) return `${head} —— 一条线都没有：调小「线性度下限」「最短线长」或「最小离地高」`
  return `${head}${gaps}`
})

/** 地面参考面行（建面后才有效）：来源 + 地面点数 + 格边长。 */
const groundText = computed(() => {
  if (!groundUsed.value) return '地面参考面：预览时按「地面来源」现建'
  const source = groundUsed.value === 'classification' ? '已有分类 2' : 'CSF 识别'
  return `地面参考面：${source} · ${groundPoints.value.toLocaleString()} 个地面点 · 格边长 ${formatParam(
    gridCellSize.value
  )} m`
})

/** 输入 → setParams（钳制在 store 内；NaN 不更新）。逐字段一个处理器，与其它工具栏同构。 */
function onMinHeightInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ minHeight: v })
}
function onRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ radius: v })
}
function onLinearityInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ linearityMin: v })
}
function onSlopeInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ maxSlopeDeg: v })
}
function onConnectRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ connectRadius: v })
}
function onMinLinePointsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ minLinePoints: v })
}
function onMinLineLengthInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ minLineLength: v })
}
function onGapRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ gapRadius: v })
}

function onGroundChange(e: Event) {
  setGroundSource((e.target as HTMLSelectElement).value as PowerlineGroundSource)
}

/** 池子上限提示（超限时 native 直接报错，提前把话说清楚）。 */
const poolHint = (POWERLINE_POOL_MAX_POINTS / 1e6).toFixed(0) + 'M'

/** Esc = 退出电力线模式（与其余模态一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitPowerline()
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="pl-bar">
    <div class="pl-bar__head">
      <span
        class="pl-bar__name"
        title="电力线（导线）提取：离地高初筛 + PCA 线性特征 + 抛物线模型连线（跨塔缺口球面补全）。垂直于平面的悬链线在垂跨比 < 0.05 时与抛物线偏差 ~1e-3，故用可线性最小二乘求解的竖直平面抛物线当模型，靠'先连通、再按模型剥离'分开平行线与交叉线"
      >
        Power Line · 电力线提取
      </span>
      <span class="pl-bar__target" title="提取目标（进入模式时锁定；仅支持单个点云实体）">目标：{{ targetName }}</span>
    </div>

    <!-- 参数行 1：地面来源 + 两个【重】档参数 -->
    <div class="pl-row">
      <div class="pl-field">
        <label class="pl-label" title="地面参考面的来源（离地高 = 点高程 − 该面在此处的高程）">地面来源</label>
        <select
          class="pl-select"
          :value="groundSource"
          :disabled="computing"
          title="地面参考面的来源；换来源会让整个会话重算（它与滑杆无关，只由来源与目标决定）"
          @change="onGroundChange"
        >
          <option v-for="opt in GROUND_OPTIONS" :key="opt.value" :value="opt.value" :title="opt.title">
            {{ opt.label }}
          </option>
        </select>
      </div>
      <div class="pl-field">
        <label class="pl-label" title="离地高的下限（m）：低于它的点不进候选池。改它要重跑 KD 树 + 逐点 PCA（重）"
          >最小离地高(m)〔重〕</label
        >
        <input
          class="pl-input"
          type="number"
          min="0"
          step="any"
          :value="formatParam(params.minHeight)"
          :disabled="computing"
          title="离地高下限（m）：低于它的点不进候选池。宁可多留——偏大只是多算些点，偏小会静默丢掉低垂的导线。改它要重跑候选提取（重）"
          @input="onMinHeightInput"
        />
      </div>
      <div class="pl-field">
        <label
          class="pl-label"
          title="PCA 邻域半径（m）：须装下导线沿程 5–8 个点才算得出方向。改它要重跑 KD 树 + 逐点 PCA（重）"
          >邻域半径(m)〔重〕</label
        >
        <input
          class="pl-input"
          type="number"
          min="0.001"
          step="any"
          :value="formatParam(params.radius)"
          :disabled="computing"
          title="PCA 邻域半径（m）：进入模式时按平均点距 ×10 估（夹在 0.5–5 m）。稀疏 ALS 数据可上调，密林下可下调。改它要重跑候选提取（重）"
          @input="onRadiusInput"
        />
      </div>
    </div>

    <!-- 参数行 2：两个【即时】档（渲染侧精筛） -->
    <div class="pl-row">
      <div class="pl-field">
        <label
          class="pl-label"
          :title="`PCA 线性度下限：(λ1−λ2)/λ1，越大越要求'像一条线'。滑杆夹在 [${POWERLINE_LOOSE_MIN_LINEARITY}, 1]（native 宽松闸之内，否则滑到池外会静默无效）。只影响精筛，改它不重跑候选提取`"
          >线性度下限〔即时〕</label
        >
        <input
          class="pl-input"
          type="number"
          :min="POWERLINE_LOOSE_MIN_LINEARITY"
          max="1"
          step="0.01"
          :value="formatParam(params.linearityMin)"
          :disabled="computing"
          :title="`线性度下限：0.85 是通用起点；调小能少丢点（0.5 = 与 native 闸门齐平，一个不丢但候选更多）。夹在 [${POWERLINE_LOOSE_MIN_LINEARITY}, 1]`"
          @input="onLinearityInput"
        />
      </div>
      <div class="pl-field">
        <label
          class="pl-label"
          :title="`主方向与水平面的夹角上限（°）：导线近水平，屋顶脊线/围栏也近水平——它挡的是陡坡与立面上的线性结构。夹在 [0, ${POWERLINE_LOOSE_MAX_SLOPE_DEG}]`"
          >最大倾角(°)〔即时〕</label
        >
        <input
          class="pl-input pl-input--narrow"
          type="number"
          min="0"
          :max="POWERLINE_LOOSE_MAX_SLOPE_DEG"
          step="1"
          :value="formatParam(params.maxSlopeDeg)"
          :disabled="computing"
          :title="`主方向倾角上限（°）：夹在 [0, ${POWERLINE_LOOSE_MAX_SLOPE_DEG}]（= native 的 |v1.z| ≤ 0.5）`"
          @input="onSlopeInput"
        />
      </div>
    </div>

    <!-- 参数行 3：【轻】档 trace 参数 -->
    <div class="pl-row">
      <div class="pl-field">
        <label
          class="pl-label"
          title="连通半径（m）：候选点距离 ≤ 它即认为可能同一根。故意放大——平行线/交叉线粘在一起没关系，随后由抛物线模型剥离拆开"
          >连接半径(m)</label
        >
        <input
          class="pl-input pl-input--narrow"
          type="number"
          min="0.001"
          step="any"
          :value="formatParam(params.connectRadius)"
          :disabled="computing"
          title="连通半径（m）：允许把平行线 / 交叉线粘成一片（随后按模型剥离）。调大 → 更容易跨缺口连通，调小 → 更不容易粘连"
          @input="onConnectRadiusInput"
        />
      </div>
      <div class="pl-field">
        <label class="pl-label" title="一条线的点数下限（含）：低于它的整条降级为残点">最少点数</label>
        <input
          class="pl-input pl-input--narrow"
          type="number"
          min="3"
          step="1"
          :value="params.minLinePoints"
          :disabled="computing"
          title="一条线的点数下限（含 3，native 要求）；低于它的整条降级为残点"
          @input="onMinLinePointsInput"
        />
      </div>
      <div class="pl-field">
        <label class="pl-label" title="一条线的长度下限（m）：城市场景假阳性（屋顶脊线 / 树枝段）的主闸门"
          >最短线长(m)</label
        >
        <input
          class="pl-input pl-input--narrow"
          type="number"
          min="0"
          step="any"
          :value="formatParam(params.minLineLength)"
          :disabled="computing"
          title="一条线的长度下限（m）：短于此的整条降级为残点。城市场景里滤掉屋顶脊线 / 树枝段的主闸门"
          @input="onMinLineLengthInput"
        />
      </div>
      <div class="pl-field">
        <label class="pl-label" title="端点补全的搜索半径（m）：塔身遮挡 / 无回波造成的缺口通常在此范围内"
          >补全半径(m)</label
        >
        <input
          class="pl-input pl-input--narrow"
          type="number"
          min="0"
          step="any"
          :value="formatParam(params.gapRadius)"
          :disabled="computing"
          title="端点补全的搜索半径（m）：把同一条导线被塔身 / 无回波切断的两端重新连起来（连接方向须与两侧切向夹角 ≤ 12°、横向偏移 ≤ 0.5 m）。0 = 不补全"
          @input="onGapRadiusInput"
        />
      </div>
    </div>

    <!-- 操作行 + 结果行 -->
    <div class="pl-row">
      <button
        class="pl-btn"
        title="按当前参数重跑提取并把每条线染成区分色（未成线的点显示为灰）"
        :disabled="computing"
        @click="runPreview"
      >
        {{ computing ? '计算中…' : previewed ? '重新预览' : '预览' }}
      </button>
      <button
        class="pl-btn pl-btn--primary"
        title="按当前参数把源点云拆成「电力线容器 + Line 1..N + 残点实体」；参数若已改动会先自动重算"
        :disabled="computing || (previewed && !!stats && stats.lineCount === 0)"
        @click="runAndSplit"
      >
        分割
      </button>
      <button class="pl-btn" title="放弃并退出（Esc）" @click="exitPowerline">取消</button>
      <span
        class="pl-result"
        :class="{ 'pl-result--warn': previewed && !!stats && stats.lineCount === 0 }"
        :title="`未成线的点在预览里显示为灰色（sRGB ${LINE_NOISE_SRGB}）；候选池上限 ${poolHint} 点，超限请调大「最小离地高」`"
        >{{ resultText }}</span
      >
    </div>

    <!-- 地面参考面行（第二行结果，建面后才有值） -->
    <div class="pl-row pl-row--note">
      <span class="pl-note" title="离地高由这张面决定；面建得偏低估地面（宁可多留点）">{{ groundText }}</span>
    </div>
  </div>
</template>

<style scoped>
/* —— 视觉体系同 EuclideanClusterToolBar / TreeIsoToolBar（白底毛玻璃浮层，右上角定位） —— */
.pl-bar {
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
.pl-bar__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 6px 2px;
}
.pl-bar__name {
  font-size: 12px;
  font-weight: 600;
  color: var(--md-primary);
  user-select: none;
  white-space: nowrap;
}
.pl-bar__target {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(255, 255, 255, 0.4);
  flex-wrap: wrap;
}
.pl-row--note {
  border: none;
  background: transparent;
  padding: 0 6px;
}
.pl-field {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pl-label {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
  user-select: none;
}
.pl-input {
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
.pl-input--narrow {
  width: 62px;
}
.pl-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.pl-input:disabled {
  opacity: 0.5;
}
.pl-select {
  height: 24px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  color: var(--md-on-surface);
}
.pl-select:disabled {
  opacity: 0.5;
}
.pl-btn {
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
.pl-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.pl-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.pl-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.pl-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pl-btn:disabled:hover {
  background: transparent;
}
.pl-btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
.pl-result {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  user-select: none;
  white-space: nowrap;
}
.pl-result--warn {
  color: var(--md-error, #b3261e);
}
.pl-note {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  user-select: none;
  white-space: nowrap;
}
</style>
