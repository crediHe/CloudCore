<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useAlignStore } from '../stores/alignStore'
import { useSceneStore } from '../stores/sceneStore'
import type { AlignedRole, RotationFilterMode } from '../utils/registration'

/**
 * 点对对齐（Align）工具栏（浮层，3D 视图区右上角，与 FilterToolBar 同款样式母版）。
 *
 * 内容分三层：
 * 1. 角色条——「待对齐」在两个目标点云里二选一（**分段控件**，点另一个即对调 data/model）。
 *    这是本仓库对 CC 的一处化简：CC 的点对对话框分上下两块分别显示 aligned/model 的点表，
 *    靠"你点在哪片云上"隐式决定角色；这里拾取路由同样按实体归属，但角色显式放在面板上
 *    （用户已确认），故不需要单独的「对调」按钮——分段控件的另半边就是它。
 * 2. 点对表——一行一对：# / 待对齐 X Y Z / 参考 X Y Z / 距离 / 两个 ×（删除该侧这一对）。
 *    两侧点数必须相等，多出来的一侧会只显示半边（靠这张表找出该删哪一个）。
 * 3. 过滤器 + 按钮——旋转 5 档 / Tx·Ty·Tz / 调整比例，`对齐`（预览）/`重置`/`确定`/`取消`。
 *
 * 任何改动（拾取、删对、换角色、改过滤器）都会先撤销预览再重算"可达 RMS"——覆盖物的标记
 * 不跟着预览变换走（见 stores/alignStore.ts 文件头），所以没有"预览中微调"这条路。
 * 计算期间全部输入禁用；Esc = 取消。
 */

const {
  active,
  targetEntityIds,
  alignedEntityId,
  referenceEntityId,
  alignedRole,
  alignedCount,
  referenceCount,
  rows,
  stats,
  options,
  computing,
  previewed,
  canCompute,
  canPreview,
  removePick,
  clearPicks,
  setRole,
  setOptions,
  align,
  reset,
  applyAlign,
  exitAlign,
} = useAlignStore()
const { getAllEntities } = useSceneStore()

/** 实体名（点云可能已被删除，故留 id 兜底）。 */
function nameOf(id: number): string {
  return getAllEntities().find((e) => e.id === id)?.name ?? String(id)
}

/** 参考侧（角色条与表头都要它）。 */
const referenceName = computed(() => nameOf(referenceEntityId.value))

/** 角色分段控件：两个目标点云（顺序 = 选择顺序）。 */
const roleChoices = computed(() => targetEntityIds.value)

/** 坐标显示（大坐标少留位，免得表格被撑爆）。 */
function fmt(v: number): string {
  return Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(3)
}

/** 距离/偏差显示（配准看的是量级，指数记法比定点更能分辨"0.001 还是 0.01"）。 */
function fmtSci(v: number | null): string {
  return v === null ? '—' : v.toExponential(2)
}

/** 旋转过滤档切换 → setOptions（会撤销预览并重算 RMS）。 */
function onRotChange(e: Event) {
  setOptions({ rotFilterMode: (e.target as HTMLSelectElement).value as RotationFilterMode })
}

/** 平移分量锁定开关（三个复选框共用一个入口；写成显式分支而不是计算属性名，便于类型收敛）。 */
function onSkipChange(axis: 'skipTx' | 'skipTy' | 'skipTz', e: Event) {
  const on = (e.target as HTMLInputElement).checked
  setOptions(axis === 'skipTx' ? { skipTx: on } : axis === 'skipTy' ? { skipTy: on } : { skipTz: on })
}

/** 缩放估计开关。 */
function onScaleChange(e: Event) {
  setOptions({ adjustScale: (e.target as HTMLInputElement).checked })
}

/** 删掉某一侧的第 index 个点（两个 × 按钮共用一个入口）。 */
function onRemove(role: AlignedRole, index: number) {
  removePick(role, index)
}

/** Esc = 取消并退出点对对齐模式（与其余模态的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitAlign(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="a-bar">
    <!-- 第一行：角色 + 过滤器 + 按钮 -->
    <div class="a-row">
      <div class="a-group">
        <span class="a-label" title="「待对齐」= 会被搬动的那一片；另一个即为不动的参考（相当于 ICP 的 data / model）">
          待对齐
        </span>
        <div class="a-seg">
          <button
            v-for="id in roleChoices"
            :key="id"
            class="a-seg__btn"
            :class="{ 'a-seg__btn--on': id === alignedEntityId }"
            :disabled="computing"
            :title="`把「${nameOf(id)}」作为待对齐（会被搬动）；点另一个即对调角色`"
            @click="setRole(id)"
          >
            {{ nameOf(id) }}
          </button>
        </div>
        <span class="a-label a-label--dim" :title="`参考（不动）：${referenceName}`">← {{ referenceName }}</span>
      </div>

      <div class="a-group">
        <label class="a-label" title="旋转过滤：只允许绕某个轴的旋转（近似「先摆正一个方向」）；「不旋转」= 只解平移">
          旋转
        </label>
        <select class="a-select" :value="options.rotFilterMode" :disabled="computing" @change="onRotChange">
          <option value="none">不过滤</option>
          <option value="x">仅绕 X</option>
          <option value="y">仅绕 Y</option>
          <option value="z">仅绕 Z</option>
          <option value="fixed">不旋转</option>
        </select>
        <label class="a-label" title="锁定某个平移分量（例如已知两片云只差水平位置，可锁住 Z）">
          <input
            class="a-check"
            type="checkbox"
            :checked="options.skipTx"
            :disabled="computing"
            @change="onSkipChange('skipTx', $event)"
          />Tx
        </label>
        <label class="a-label" title="锁定 Ty 平移分量">
          <input
            class="a-check"
            type="checkbox"
            :checked="options.skipTy"
            :disabled="computing"
            @change="onSkipChange('skipTy', $event)"
          />Ty
        </label>
        <label class="a-label" title="锁定 Tz 平移分量">
          <input
            class="a-check"
            type="checkbox"
            :checked="options.skipTz"
            :disabled="computing"
            @change="onSkipChange('skipTz', $event)"
          />Tz
        </label>
        <label class="a-label" title="同时估计缩放（默认关：两片云应是同一个扫描比例，缩放多半是在吸收拾取误差）">
          <input
            class="a-check"
            type="checkbox"
            :checked="options.adjustScale"
            :disabled="computing"
            @change="onScaleChange"
          />
          调整比例
        </label>
      </div>

      <div class="a-group a-group--tail">
        <button
          class="a-btn a-btn--preview"
          title="把解出的变换临时施加到待对齐点云上（只改显示位姿，不动数据）：绕一圈确认贴合后再「确定」"
          :disabled="!canPreview || computing"
          @click="align"
        >
          对齐
        </button>
        <button
          class="a-btn"
          title="撤销预览，回到对齐前的位姿（拾取点保留）"
          :disabled="!previewed || computing"
          @click="reset"
        >
          重置
        </button>
        <button
          class="a-btn a-btn--primary"
          title="把预览的变换永久烘焙进顶点缓冲，并把点云改名为 <名称>.registered（需先「对齐」预览）"
          :disabled="!previewed || computing"
          @click="applyAlign"
        >
          确定
        </button>
        <button
          class="a-btn"
          title="放弃并退出点对对齐模式（Esc）；未烘焙的预览会被还原"
          :disabled="computing"
          @click="exitAlign(false)"
        >
          取消
        </button>
      </div>
    </div>

    <!-- 第二行：状态与统计 -->
    <div class="a-row a-row--info">
      <span class="a-hint" :class="{ 'a-hint--warn': !canCompute }">
        <template v-if="!canCompute">
          两侧各拾取相同的点数、且 ≥ 3 对才能解算（当前 {{ alignedCount }} : {{ referenceCount }}）
        </template>
        <template v-else-if="previewed"
          >已预览（RMS {{ fmtSci(stats?.rms ?? null) }}）；改动任一项会先还原预览</template
        >
        <template v-else>点「对齐」预览</template>
      </span>
      <span v-if="stats" class="a-stats" title="最近一次解算的统计（过滤后的最终变换下）">
        可达 RMS <b>{{ fmtSci(stats.rms) }}</b>
        <span class="a-stats__sep">·</span>
        最大偏差 {{ fmtSci(stats.maxDistance) }}
        <span class="a-stats__sep">·</span>
        {{ stats.pairCount }} 对
        <template v-if="options.adjustScale">
          <span class="a-stats__sep">·</span>
          缩放 {{ stats.scale.toPrecision(6) }}
        </template>
      </span>
      <button
        class="a-btn a-btn--mini"
        title="清空两侧全部拾取点"
        :disabled="computing || rows.length === 0"
        @click="clearPicks"
      >
        清空拾取
      </button>
    </div>

    <!-- 点对表 -->
    <div v-if="rows.length > 0" class="a-table-wrap">
      <table class="a-table">
        <thead>
          <tr>
            <th>#</th>
            <th title="待对齐侧（会被搬动）的拾取点坐标（显示坐标）">待对齐 X / Y / Z</th>
            <th title="参考侧（不动）的拾取点坐标（显示坐标）">参考 X / Y / Z</th>
            <th title="该对在当前变换下的距离：参考点 − 变换后的待对齐点；明显偏大的一对多半是拾错了同名点">距离</th>
            <th aria-label="删除"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td class="a-table__idx">{{ i + 1 }}</td>
            <td class="a-table__cell" :class="{ 'a-table__cell--missing': !row.aligned }">
              <template v-if="row.aligned"
                >{{ fmt(row.aligned.x) }} / {{ fmt(row.aligned.y) }} / {{ fmt(row.aligned.z) }}</template
              >
              <template v-else>—</template>
            </td>
            <td class="a-table__cell" :class="{ 'a-table__cell--missing': !row.reference }">
              <template v-if="row.reference">
                {{ fmt(row.reference.x) }} / {{ fmt(row.reference.y) }} / {{ fmt(row.reference.z) }}
              </template>
              <template v-else>—</template>
            </td>
            <td class="a-table__cell a-table__cell--num">{{ fmtSci(row.distance) }}</td>
            <td class="a-table__cell a-table__cell--ops">
              <button
                class="a-x"
                :disabled="computing || !row.aligned"
                :title="`删除待对齐侧第 ${i + 1} 个点`"
                @click="onRemove(alignedRole, i)"
              >
                ×
              </button>
              <button
                class="a-x"
                :disabled="computing || !row.reference"
                :title="`删除参考侧第 ${i + 1} 个点`"
                @click="onRemove(alignedRole === 0 ? 1 : 0, i)"
              >
                ×
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.a-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  max-width: min(760px, calc(100% - 16px));
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 10;
}
.a-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.a-row--info {
  padding: 0 4px;
}
.a-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.a-group--tail {
  margin-left: auto;
  padding-right: 0;
  border-right: none;
}
.a-label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.a-label--dim {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.75;
}
.a-check {
  margin: 0;
}
.a-select {
  height: 28px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.a-select:disabled {
  opacity: 0.5;
}
/* 角色分段控件（替代 CC 的"上下两块点表"）：点另半边即对调 data/model */
.a-seg {
  display: flex;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  overflow: hidden;
}
.a-seg__btn {
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
.a-seg__btn + .a-seg__btn {
  border-left: 1px solid rgba(0, 0, 0, 0.12);
}
.a-seg__btn--on {
  background: var(--md-primary);
  color: #fff;
}
.a-seg__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.a-hint {
  font-size: 11px;
  color: var(--md-primary);
  white-space: nowrap;
}
.a-hint--warn {
  color: var(--md-error, #b3261e);
}
.a-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.a-stats__sep {
  opacity: 0.5;
}
.a-table-wrap {
  max-height: 172px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(255, 255, 255, 0.55);
}
.a-table {
  width: 100%;
  border-collapse: collapse;
  font:
    11px/1.5 ui-monospace,
    Consolas,
    monospace;
  color: var(--md-on-surface);
}
.a-table th {
  position: sticky;
  top: 0;
  padding: 2px 6px;
  text-align: left;
  font-weight: normal;
  font-size: 11px;
  color: var(--md-on-surface-variant);
  background: rgba(255, 255, 255, 0.92);
  white-space: nowrap;
}
.a-table td {
  padding: 1px 6px;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  white-space: nowrap;
}
.a-table__idx {
  color: var(--md-on-surface-variant);
  text-align: right;
}
.a-table__cell--num {
  text-align: right;
}
.a-table__cell--missing {
  color: var(--md-error, #b3261e);
}
.a-table__cell--ops {
  text-align: right;
}
.a-x {
  width: 18px;
  height: 18px;
  margin-left: 2px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1;
  color: var(--md-on-surface-variant);
  background: transparent;
}
.a-x:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.1);
}
.a-x:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}
.a-btn {
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
.a-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
}
.a-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.a-btn--preview {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.a-btn--preview:hover:not(:disabled) {
  background: rgba(96, 0, 167, 0.16);
}
.a-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.a-btn--primary:hover:not(:disabled) {
  filter: brightness(0.95);
}
.a-btn--mini {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}
</style>
