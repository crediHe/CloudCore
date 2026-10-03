<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useNormalStore } from '../stores/normalStore'
import { useSceneStore } from '../stores/sceneStore'
import { MODEL_OPTIONS, ORIENTATION_OPTIONS } from '../utils/normalEstimate'
import type { NormalModel, NormalOrientation } from '../utils/normalEstimate'
import { fmtThousands } from '../utils/format'

/**
 * 法向量计算对话框（`Edit > Normals > Compute…`），仓库里第一个 dialog 组件。
 *
 * 形态对齐 CloudCompare 的 `ccNormalComputationDlg`：局部模型 + 邻域半径（带 Auto）+
 * 定向方式，右下角 Cancel / Compute。**不是模态会话**（不进 useAlgorithmModals）：
 * 点 Compute 后结果直接落到实体上、对话框关闭，没有预览-确认两步。
 *
 * 两处刻意的差异：
 * - 没有 CC 的「扫描网格 / 传感器 / MST」定向分组——前两者依赖我们数据模型里不存在的
 *   关联信息，MST 需要建图（见 native/normal-estimate/README-REF.md）。
 * - 着色是 `ColorMode = 'normal'` 的静态烘焙（视无关），不是 CC 那种视相关的黑背面；
 *   计算完成后到属性面板把 Colors 切到 Normal RGB 即可查看（不破坏原始 RGB）。
 *
 * 计算中禁止关闭（Esc 与 Cancel 都失效，mask 点击一律不关）：native 侧没有取消通道，
 * 且关掉对话框会让结果无处可去（同 CC 的模态行为）。
 */

const {
  dialogOpen,
  targetEntityIds,
  radius,
  model,
  orientation,
  computing,
  guessing,
  guessStats,
  lastStats,
  setRadius,
  setModel,
  setOrientation,
  guessRadius,
  computeNormals,
  closeComputeDialog,
} = useNormalStore()

const sceneStore = useSceneStore()

/** 目标实体名（对话框「目标」行；多片时只列前几个，避免撑爆对话框）。 */
const targetNames = computed(() =>
  targetEntityIds.value.map(
    (id) => sceneStore.getAllEntities().find((e) => e.id === id)?.name ?? String(id)
  )
)

/** 目标点数合计（按**可见点集**口径提示；精确的候选数在 store 里，这里只作量级展示）。 */
const targetPoints = computed(() =>
  targetEntityIds.value.reduce((sum, id) => {
    const e = sceneStore.getAllEntities().find((x) => x.id === id)
    return sum + (e?.pointCount ?? 0)
  }, 0)
)

/** Auto 按钮：与 CC 一致，只在恰好一片点云时可用（半径是单一标量，多片云密度可能差很多）。 */
const autoAvailable = computed(() => targetEntityIds.value.length === 1)
const autoTitle = computed(() =>
  autoAvailable.value
    ? '按「球邻域内平均装 16 个点且密度均匀」自动估算半径（固定种子，同一片云结果可复现）'
    : 'Auto 仅在恰好选中一片点云时可用'
)

/** 半径输入 → setRadius（NaN 不更新；钳制在 store 内）。 */
function onRadiusInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setRadius(v)
}

function onModelChange(e: Event) {
  setModel((e.target as HTMLSelectElement).value as NormalModel)
}

function onOrientationChange(e: Event) {
  setOrientation((e.target as HTMLSelectElement).value as NormalOrientation)
}

/** Auto 统计的一行摘要（供用户判断推荐值是否可信）。 */
const guessSummary = computed(() => {
  const g = guessStats.value
  if (!g) return ''
  return `尝试 ${g.attempts} 轮，采样 ${g.sampledCount} 点；末轮邻域人口 均值 ${g.meanPopulation.toFixed(
    2
  )} / 标准差 ${g.stdDevPopulation.toFixed(2)} / 达标 ${(g.aboveMinRatio * 100).toFixed(1)}%`
})

/** Esc = 取消（计算中由 store 拦截，不会关掉正在跑的任务）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && dialogOpen.value) {
    closeComputeDialog()
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="dialogOpen" class="dlg-mask">
    <div class="dlg" @click.stop>
      <div class="dlg__title">Compute normals</div>

      <!-- 目标：只读摘要（多片只列前 3 个名字） -->
      <div class="dlg__row">
        <span class="dlg__label">目标</span>
        <span class="dlg__value" :title="targetNames.join('\n')">
          {{ targetNames.length }} 片点云 / 共 {{ fmtThousands(targetPoints) }} 点
          <span class="dlg__dim">
            （{{ targetNames.slice(0, 3).join('、') }}{{ targetNames.length > 3 ? ' 等' : '' }}）
          </span>
        </span>
      </div>

      <!-- 局部模型 -->
      <div class="dlg__row">
        <span class="dlg__label">局部模型</span>
        <select
          class="dlg__select"
          :value="model"
          :disabled="computing"
          @change="onModelChange"
        >
          <option v-for="opt in MODEL_OPTIONS" :key="opt.value" :value="opt.value" :title="opt.title">
            {{ opt.label }}
          </option>
        </select>
      </div>

      <!-- 半径 + Auto -->
      <div class="dlg__row">
        <span class="dlg__label">邻域半径</span>
        <div class="dlg__radius">
          <input
            class="dlg__input"
            type="number"
            min="0"
            step="any"
            :value="radius"
            :disabled="computing || guessing"
            title="以该点为球心、该长度为半径的球内所有点参与局部拟合（与点云坐标同单位）"
            @input="onRadiusInput"
          />
          <button
            class="dlg__btn dlg__btn--auto"
            :disabled="computing || guessing || !autoAvailable"
            :title="autoTitle"
            @click="guessRadius"
          >
            {{ guessing ? '估算中…' : 'Auto' }}
          </button>
        </div>
      </div>

      <!-- 定向 -->
      <div class="dlg__row">
        <span class="dlg__label">定向</span>
        <select
          class="dlg__select"
          :value="orientation"
          :disabled="computing"
          title="拟合本身不决定法向量的正负；这里统一翻转到指定一侧（可再次 Invert 整体反转）"
          @change="onOrientationChange"
        >
          <option v-for="opt in ORIENTATION_OPTIONS" :key="opt.value" :value="opt.value" :title="opt.title">
            {{ opt.label }}
          </option>
        </select>
      </div>

      <!-- Auto 依据 / 上一轮结果 -->
      <div v-if="guessSummary" class="dlg__note">{{ guessSummary }}</div>
      <div v-if="lastStats" class="dlg__note">
        上次：{{ lastStats.entities }}/{{ lastStats.entitiesTotal }} 片，{{
          fmtThousands(lastStats.computed)
        }}
        点已算，空码 {{ fmtThousands(lastStats.nullCount) }}（放大半径仍不足
        {{ fmtThousands(lastStats.capped) }}）
      </div>

      <div class="dlg__hint">
        提示：算完后在属性面板把 Colors 切到 <b>Normal RGB</b> 查看朝向；原始 RGB 不受影响，可随时切回。
      </div>

      <div class="dlg__footer">
        <button class="dlg__btn" :disabled="computing" title="放弃并关闭（Esc）" @click="closeComputeDialog">
          取消
        </button>
        <button
          class="dlg__btn dlg__btn--primary"
          :disabled="computing || guessing"
          title="按当前参数估计法向量并写入选中点云"
          @click="computeNormals"
        >
          {{ computing ? '计算中…' : 'Compute' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮幕：z-index 低于 GlobalProgress(9999)、高于菜单栏(100) */
.dlg-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
  z-index: 200;
}
.dlg {
  min-width: 420px;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.dlg__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--md-on-surface);
}
.dlg__row {
  display: grid;
  grid-template-columns: 80px 1fr;
  align-items: center;
  gap: 8px;
}
.dlg__label {
  font-size: 12px;
  color: var(--md-on-surface-variant);
}
.dlg__value {
  font-size: 12px;
  color: var(--md-on-surface);
  overflow-wrap: anywhere;
}
.dlg__dim {
  color: var(--md-on-surface-variant);
}
.dlg__select,
.dlg__input {
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-family: inherit;
  font-size: 12px;
  color: var(--md-on-surface);
}
.dlg__select:focus,
.dlg__input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.dlg__select:disabled,
.dlg__input:disabled {
  opacity: 0.5;
}
.dlg__radius {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dlg__input {
  flex: 1;
  min-width: 0;
}
.dlg__note {
  font-size: 11px;
  color: var(--md-on-surface-variant);
}
.dlg__hint {
  font-size: 11px;
  color: var(--md-primary);
}
.dlg__footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 2px;
}
.dlg__btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  background: transparent;
  white-space: nowrap;
}
.dlg__btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
}
.dlg__btn--auto {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.dlg__btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.dlg__btn--primary:hover:not(:disabled) {
  filter: brightness(0.95);
}
.dlg__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dlg__btn:disabled:hover {
  background: transparent;
}
.dlg__btn--auto:disabled:hover {
  background: rgba(96, 0, 167, 0.1);
}
.dlg__btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
</style>
