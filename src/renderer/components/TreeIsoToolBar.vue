<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useTreeIsoStore } from '../stores/treeIsoStore'
import type { TreeIsoParams } from '../utils/treeIso'
import { LABEL_NOISE_SRGB } from '../utils/labelColors'

/**
 * 单木分割（TreeIso 图切分，CloudCompare qTreeIso 语义）参数横条工具栏
 * （浮层，3D 视图区右上角，与 CsfToolBar 同款视觉体系）。对应 native/treeiso 模块。
 *
 * 点击右竖工具栏「单木分割」按钮后显示：三阶段算法参数（Init 初始超分割 /
 * 中间间隙闭合 / Final 树冠-树干合并）+ 残点归拢的最小点数，以及「预览 / 分割 / 取消」。
 *
 * **预览**（同 EuclideanClusterToolBar）：跑一次 native 后**只染色不拆分**——每棵入选树
 * 一色、归拢残点的碎片为灰，于是"参数是不是把两棵树粘一起了"一眼可辨。参数分两类：
 * 算法参数（抽稀 / kNN / λ / 空隙 / 冠高比）改动只让预览"过期"（画面留着，分割前自动
 * 重算）；「最小点数」是**渲染侧过滤**，拖动它只重染（防抖 120ms）+ 换统计，**不重跑
 * native**。"拖着最小点数看哪两棵树分开"因此是秒回的。
 *
 * 「分割」把源点云原地替换成「树项」（每棵树一个独立点云实体 + 残点实体）并退出模式；
 * 计算期间全部输入禁用，Esc = 取消。树高/胸径/冠幅等指标算法后续实现
 * （产物 Tree object 当前为占位值）。
 */

const {
  active,
  targetName,
  params,
  minPoints,
  computing,
  previewed,
  stats,
  setParams,
  runPreview,
  runTreeIso,
  exitTreeIso,
} = useTreeIsoStore()

/** 结果行文案（无统计时给一句"先预览"的指引）。 */
const resultText = computed(() => {
  const s = stats.value
  if (!s) return '点「预览」查看分割效果（逐树异色，归拢残点的碎片为灰）'
  const head =
    `${s.treeCount.toLocaleString()} 棵树 · ${s.treePoints.toLocaleString()} 点 · ` +
    `残点 ${s.noisePoints.toLocaleString()} 点（${s.componentCount.toLocaleString()} 个组件）`
  const largest = ` · 最大 ${s.largestTreePoints.toLocaleString()} 点`
  if (!previewed.value) return `${head}${largest} —— 参数已改，预览已过期（分割会按新参数重算）`
  if (s.treeCount === 0) return `${head}${largest} —— 没有分出有效单木：请调小最小点数或检查参数`
  return `${head}${largest}`
})

/** 参数展示去尾噪（用户输入的小数可能很长）。 */
function formatParam(x: number): number {
  return Number.isInteger(x) ? x : parseFloat(x.toFixed(4))
}

interface FieldDef {
  key: keyof TreeIsoParams
  label: string
  /** 字段说明（中文，来自 utils/treeIso.ts 契约注释）。 */
  title: string
}

/** 三阶段算法参数分组（qTreeIso 对话框分组；Final 行并入归拢策略的最小点数）。 */
const GROUPS: { name: string; fields: FieldDef[] }[] = [
  {
    name: 'Init',
    fields: [
      {
        key: 'decimateRes1',
        label: '抽稀(m)',
        title: '初始超分割：体素抽稀分辨率（m）。越小保留细节越多，点数与耗时上升',
      },
      { key: 'minNN1', label: 'kNN', title: '初始 kNN 查询数（含自身；建图取前 minNN1−1 条）' },
      { key: 'regStrength1', label: 'λ₁', title: '初始图割边权乘子：越大超分割越整' },
    ],
  },
  {
    name: 'Gap',
    fields: [
      {
        key: 'decimateRes2',
        label: '抽稀(m)',
        title: '间隙闭合：各初始簇内体素抽稀分辨率（m）',
      },
      { key: 'minNN2', label: 'kNN', title: '质心/抽稀点 kNN 查询数（含自身）' },
      { key: 'maxGap', label: '空隙', title: '簇间可连边最大空隙（m；树冠间隙大于它不闭合）' },
      { key: 'regStrength2', label: 'λ₂', title: '间隙闭合图割边权乘子' },
    ],
  },
  {
    name: 'Final',
    fields: [
      { key: 'minNN3', label: 'kNN', title: '树冠-树干合并的组级 kNN 查询数（含自身）' },
      {
        key: 'relHeightLengthRatio',
        label: '冠高比',
        title: '相对高度判「树冠块」阈值（0-1，越大树冠判定越苛刻）',
      },
      { key: 'verticalWeight', label: '垂向', title: '合并打分中垂直重叠的权重' },
    ],
  },
]

/** 输入 → setParams（钳制在 store 内；NaN 不更新）。 */
function onParamInput(key: keyof TreeIsoParams, e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ [key]: v } as Partial<TreeIsoParams>)
}

/** 最小点数输入（残点归拢策略，非算法参数）→ setParams。 */
function onMinPointsInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ minPoints: v })
}

/** Esc = 取消并退出单木分割模式（与分割/CSF 的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitTreeIso()
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="tree-bar">
    <div class="tree-bar__head">
      <span
        class="tree-bar__name"
        title="TreeIso 三阶段图切分（Xi &amp; Hopkinson 2022）。建议流程：LAS → CSF 去地面 → 选中树木点云 → 单木分割，完成后源云被替换为「树项」容器 + 逐树点云 + 残点实体"
      >
        TreeIso · 单木分割
      </span>
      <span class="tree-bar__target" title="分割目标（进入模式时锁定）">目标：{{ targetName }}</span>
    </div>

    <!-- 三阶段参数分组行 -->
    <div v-for="group in GROUPS" :key="group.name" class="tree-row">
      <span class="tree-row__group">{{ group.name }}</span>
      <div v-for="field in group.fields" :key="field.key" class="tree-field">
        <label class="tree-label" :title="field.title">{{ field.label }}</label>
        <input
          class="tree-input"
          type="number"
          step="any"
          :value="formatParam(params[field.key])"
          :disabled="computing"
          :title="field.title"
          @input="onParamInput(field.key, $event)"
        />
      </div>
    </div>

    <!-- 残点归拢行 + 操作按钮 -->
    <div class="tree-row">
      <span class="tree-row__group" title="点数低于它的组件整体归拢为残点实体，不单独成树">残点</span>
      <div class="tree-field">
        <label class="tree-label" title="树组件有效点数下限（点数低于它的组件整体并入残点实体）">最小点数</label>
        <input
          class="tree-input tree-input--narrow"
          type="number"
          min="1"
          step="1"
          :value="minPoints"
          :disabled="computing"
          title="点数低于该阈值的组件归拢为残点。改它不重跑算法：统计与画面立即跟随（预览时拖动即可看哪两棵树分开）"
          @input="onMinPointsInput"
        />
      </div>
      <button
        class="tree-btn"
        title="跑一次三阶段图切分并逐树染色（不拆分）：每棵入选树一色、归拢残点的碎片为灰。算法参数改动会让预览过期，分割时会自动重算"
        :disabled="computing"
        @click="runPreview"
      >
        {{ computing ? '计算中…' : previewed ? '重新预览' : '预览' }}
      </button>
      <button
        class="tree-btn tree-btn--primary"
        title="运行三阶段图切分：完成后源点云被替换为树项（逐树点云 + 残点实体）。算法参数若已改动会先自动重算"
        :disabled="computing || (previewed && !!stats && stats.treeCount === 0)"
        @click="runTreeIso"
      >
        {{ computing ? '分割中…' : '分割' }}
      </button>
      <button class="tree-btn" title="放弃分割并退出（Esc）" @click="exitTreeIso">取消</button>
      <span
        class="tree-result"
        :class="{ 'tree-result--warn': previewed && !!stats && stats.treeCount === 0 }"
        :title="`归拢残点的碎片在预览里显示为灰色（sRGB ${LABEL_NOISE_SRGB}）；残点实体本身保留原色`"
        >{{ resultText }}</span
      >
    </div>
  </div>
</template>

<style scoped>
/* —— 视觉体系同 CsfToolBar（csf-bar：白底毛玻璃浮层，右上角定位） —— */
.tree-bar {
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
.tree-bar__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 6px 2px;
}
.tree-bar__name {
  font-size: 12px;
  font-weight: 600;
  color: var(--md-primary);
  user-select: none;
  white-space: nowrap;
}
.tree-bar__target {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(255, 255, 255, 0.4);
  flex-wrap: wrap;
}
.tree-row__group {
  width: 40px;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--md-on-surface-variant);
  user-select: none;
}
.tree-field {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tree-label {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
  user-select: none;
}
.tree-input {
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
.tree-input--narrow {
  width: 56px;
}
.tree-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.tree-input:disabled {
  opacity: 0.5;
}
.tree-btn {
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
.tree-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.tree-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.tree-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.tree-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tree-btn:disabled:hover {
  background: transparent;
}
.tree-btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
.tree-result {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  user-select: none;
  white-space: nowrap;
}
.tree-result--warn {
  color: var(--md-error, #b3261e);
}
</style>
