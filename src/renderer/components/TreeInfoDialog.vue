<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useTreeInfoStore } from '../stores/treeInfoStore'
import { useSceneStore } from '../stores/sceneStore'
import { fmtThousands } from '../utils/format'

/**
 * 树木信息计算对话框（`Trees ▸ Tree info ▸ Compute tree info…`）。
 *
 * 形态照 `NormalComputeDialog.vue`：目标摘要 + 参数 + Cancel / Compute，Esc = Cancel。
 * 同样是**一次成型**（不算算法模态、不进 useAlgorithmModals）：点 Compute 后逐棵树算完直接写进
 * 实体的 `treeObject`，没有预览态。差异只有两处：
 * - **可以取消**：每棵树的产物是当场落盘的，中途停下也自洽（`progressStore` 的可取消任务）。
 * - 计算期间对话框**不关闭**（同法向量对话框）：结果行与参数都要留在眼前，便于逐步调整参数重算。
 *
 * ⚠ 四个数字输入用 `@change` 而不是 `@input`：`:value` 的回写会按 DOM 当前值比对，
 * 若边打字边写 store，"0." 会被 `parseFloat` 读成 0、随即被规整后的 "0.001" 顶掉（小数点被吃掉，
 * 输不出 0.1）。`@change` 只在失焦 / 回车时提交，输入期间 DOM 不会被回写；提交时若被钳制，
 * 用户仍能立刻看到被改成什么值（这正是我们要的反馈）。
 */
const {
  dialogOpen,
  targetEntityIds,
  dbhHeight,
  sliceThickness,
  crownPercent,
  baseQuantilePercent,
  computing,
  lastStats,
  setDbhHeight,
  setSliceThickness,
  setCrownPercent,
  setBaseQuantilePercent,
  computeTreeInfo,
  closeComputeDialog,
} = useTreeInfoStore()

const sceneStore = useSceneStore()

/** 目标树名（对话框「目标」行；多棵时只列前几个，避免撑爆对话框）。 */
const targetNames = computed(() =>
  targetEntityIds.value.map((id) => sceneStore.getAllEntities().find((e) => e.id === id)?.name ?? String(id))
)

/** 目标点数合计（按实体 `pointCount` 的量级提示；精确的候选数在 store 里）。 */
const targetPoints = computed(() =>
  targetEntityIds.value.reduce((sum, id) => {
    const e = sceneStore.getAllEntities().find((x) => x.id === id)
    return sum + (e?.pointCount ?? 0)
  }, 0)
)

/** 上次运行的摘要（供用户判断这批数字算得顺不顺）。 */
const lastSummary = computed(() => {
  const s = lastStats.value
  if (!s) return ''
  return (
    `上次：${s.computed} / ${s.total} 棵已写入` +
    (s.skipped > 0 ? `，${s.skipped} 棵无有效点` : '') +
    (s.failed > 0 ? `，${s.failed} 棵目标已删除` : '') +
    (s.cancelled ? '（已取消）' : '') +
    `；耗时 ${(s.elapsedMs / 1000).toFixed(1)} s`
  )
})

/**
 * 数字输入 → setter（NaN 不更新；钳制在 store 内，写回后输入框显示的即实际会用值）。
 * 四个字段共用：`e.target.value` 空串时 parseFloat 为 NaN，直接跳过（清空输入不会把参数写坏）。
 */
function onNumberInput(setter: (v: number) => void, e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setter(v)
}

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
      <div class="dlg__title">Tree info</div>

      <!-- 目标：只读摘要（多棵只列前 3 个名字） -->
      <div class="dlg__row">
        <span class="dlg__label">目标</span>
        <span class="dlg__value" :title="targetNames.join('\n')">
          {{ targetNames.length }} 棵 / 共 {{ fmtThousands(targetPoints) }} 点
          <span class="dlg__dim">
            （{{ targetNames.slice(0, 3).join('、') }}{{ targetNames.length > 3 ? ' 等' : '' }}）
          </span>
        </span>
      </div>

      <!-- 胸径测量高度 -->
      <div class="dlg__row">
        <span class="dlg__label">胸径高度</span>
        <input
          class="dlg__input"
          type="number"
          min="0"
          max="20"
          step="any"
          :value="dbhHeight"
          :disabled="computing"
          title="从基准点往上多少米处量胸径（林业惯例 1.3 m）"
          @change="onNumberInput(setDbhHeight, $event)"
        />
      </div>

      <!-- 切片厚度 -->
      <div class="dlg__row">
        <span class="dlg__label">切片厚度</span>
        <input
          class="dlg__input"
          type="number"
          min="0.001"
          max="5"
          step="0.01"
          :value="sliceThickness"
          :disabled="computing"
          title="胸径切片的高度范围：± 厚度/2。越薄越贴近「某高度处的直径」，但点也越少（0.1 m 是常用值）"
          @change="onNumberInput(setSliceThickness, $event)"
        />
      </div>

      <!-- 冠层比例 -->
      <div class="dlg__row">
        <span class="dlg__label">冠层比例</span>
        <input
          class="dlg__input"
          type="number"
          min="1"
          max="100"
          step="1"
          :value="crownPercent"
          :disabled="computing"
          title="冠幅只统计自上而下这一比例的点（30 = 顶部 30%）；冠层底高随之确定"
          @change="onNumberInput(setCrownPercent, $event)"
        />
      </div>

      <!-- 基准分位数 -->
      <div class="dlg__row">
        <span class="dlg__label">基准分位数</span>
        <input
          class="dlg__input"
          type="number"
          min="0"
          max="50"
          step="1"
          :value="baseQuantilePercent"
          :disabled="computing"
          title="树高与胸径从哪个高程起算：0 = 用最低点；> 0 用该分位的 z（抗离群低点的残留地面点）"
          @change="onNumberInput(setBaseQuantilePercent, $event)"
        />
      </div>

      <div v-if="lastSummary" class="dlg__note">{{ lastSummary }}</div>

      <div class="dlg__hint">
        只处理分类为 <b>class 4 / 5</b> 的点云（判据：可见点分类全部落在 4 或 5）；其余选中项会被跳过。
        胸径与代表点来自胸径切片的稳健圆拟合，拟合不可信时不给数（见属性面板的 Fit 行）。
      </div>

      <div class="dlg__footer">
        <button class="dlg__btn" :disabled="computing" title="放弃并关闭（Esc）" @click="closeComputeDialog">
          取消
        </button>
        <button
          class="dlg__btn dlg__btn--primary"
          :disabled="computing"
          title="按当前参数逐棵计算树高 / 代表点 / 冠幅 / 胸径，结果写入各实体的 Tree object"
          @click="computeTreeInfo"
        >
          {{ computing ? '计算中…' : 'Compute' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮幕：z-index 低于 GlobalProgress(9999)、高于菜单栏(100)；与 NormalComputeDialog 同一套观感 */
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
.dlg__input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.dlg__input:disabled {
  opacity: 0.5;
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
.dlg__btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
</style>
