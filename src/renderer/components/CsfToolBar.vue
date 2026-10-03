<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useCsfStore } from '../stores/csfStore'

/**
 * LiDAR 地面分割（CSF 布料模拟，CloudCompare qCSF 机载语义）横条工具栏
 * （浮层，3D 视图区右上角，与 FilterToolBar 同款样式）。
 * 对应 native/csf-lidar 模块；起伏剧烈地形（丘陵/山脉）请用 csf-pro 精准版。
 *
 * 点击工具栏 LiDAR 地面分割按钮后显示：布料分辨率 + 分类阈值输入、刚性三档、
 * 陡坡后处理开关，以及「分割 / 取消」。
 * 与半径滤波不同——**无预览阶段**：点「分割」即跑 C++ 布料模拟（异步，
 * node-addon），完成后直接把每个目标原实体拆成 .ground / .offGround 两块并
 * 退出模式；计算期间全部输入禁用，Esc = 取消。
 */

const { active, clothResolution, classThreshold, rigidness, smoothSlope, computing, setParams, runCsf, exitCsf } =
  useCsfStore()

/** 参数展示去尾噪（初始值由平均点距估计，小数很长）。 */
function formatParam(x: number): number {
  return Number.isInteger(x) ? x : parseFloat(x.toFixed(4))
}

/** 分辨率输入 → setParams（钳制在 store 内；NaN 不更新）。 */
function onResolutionInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ clothResolution: v })
}

/** 阈值输入 → setParams。 */
function onThresholdInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isNaN(v)) setParams({ classThreshold: v })
}

/** 刚性档位按钮 → setParams（store 内钳制 1..3）。 */
function onRigidnessClick(v: number) {
  setParams({ rigidness: v })
}

/** 陡坡后处理开关 → setParams。 */
function onSlopeChange(e: Event) {
  setParams({ smoothSlope: (e.target as HTMLInputElement).checked })
}

/** Esc = 取消并退出分割模式（与分割多边形的 Esc 习惯一致）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    exitCsf(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <div v-if="active" class="csf-bar">
    <!-- 版本标识：与后续 csf-pro 精准版（起伏地形）区分 -->
    <span
      class="csf-group csf-name"
      title="LiDAR 地面分割：CSF 布料模拟（CloudCompare qCSF 机载语义）。起伏剧烈的丘陵/山脉数据贴合性弱，请用精准版"
      >LiDAR·CSF</span
    >
    <!-- 布料分辨率 -->
    <div class="csf-group">
      <label class="csf-label" title="布料网格间距（与点云坐标同单位）。越小越贴合地表细节，但粒子数随其平方反比增长、耗时激增；通常取平均点距的数倍">布料分辨率</label>
      <input
        class="csf-input"
        type="number"
        min="0"
        step="any"
        :value="formatParam(clothResolution)"
        :disabled="computing"
        title="与点云坐标同单位"
        @input="onResolutionInput"
      />
    </div>

    <!-- 分类阈值 -->
    <div class="csf-group">
      <label class="csf-label" title="点到布料面的高度差小于该值判为地面（与坐标同单位）。地形噪声大 / 低矮植被多时调大">分类阈值</label>
      <input
        class="csf-input"
        type="number"
        min="0"
        step="any"
        :value="formatParam(classThreshold)"
        :disabled="computing"
        title="与点云坐标同单位"
        @input="onThresholdInput"
      />
    </div>

    <!-- 刚性（CC 三档：1 软 / 2 中 / 3 硬） -->
    <div class="csf-group">
      <label class="csf-label">刚性</label>
      <div class="csf-rigids" role="radiogroup" aria-label="布料刚性">
        <button
          v-for="(desc, v) of ['最柔：贴合起伏强，易陷入低矮地物', '默认：机载地形常用', '最硬：近似刚性板，地形细节少时更稳']"
          :key="v + 1"
          class="csf-rigid"
          :class="{ 'csf-rigid--active': rigidness === v + 1 }"
          :disabled="computing"
          :title="`刚性 ${v + 1}（${desc}）`"
          @click="onRigidnessClick(v + 1)"
        >
          {{ v + 1 }}
        </button>
      </div>
    </div>

    <!-- 陡坡后处理 -->
    <label
      class="csf-group csf-check"
      title="移除因陡坡/突起地形而悬在空中的布料片（CC 的 smooth 选项），地形破碎时开启可减少误判"
    >
      <input type="checkbox" :checked="smoothSlope" :disabled="computing" @change="onSlopeChange" />
      <span class="csf-label">陡坡后处理</span>
    </label>

    <div class="csf-group">
      <!-- 分割：一次性计算并拆分（计算中禁用） -->
      <button
        class="csf-btn csf-btn--primary"
        title="运行布料模拟：完成后直接拆成 ground / offGround 两块实体"
        :disabled="computing"
        @click="runCsf"
      >
        {{ computing ? '分割中…' : '分割' }}
      </button>
      <button
        class="csf-btn"
        title="放弃分割并退出（Esc；计算中取消会丢弃本次结果）"
        @click="exitCsf(false)"
      >
        取消
      </button>
    </div>
  </div>
</template>

<style scoped>
.csf-bar {
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
.csf-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
}
.csf-group:last-child {
  padding-right: 0;
  border-right: none;
}
.csf-label {
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: nowrap;
}
.csf-input {
  width: 88px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  color: var(--md-on-surface);
}
.csf-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.csf-input:disabled {
  opacity: 0.5;
}
.csf-rigids {
  display: flex;
  gap: 2px;
}
.csf-rigid {
  width: 26px;
  height: 28px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(0, 0, 0, 0.12);
}
.csf-rigid--active,
.csf-rigid--active:hover {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
  border-color: var(--md-primary);
}
.csf-rigid:hover {
  background: rgba(0, 0, 0, 0.06);
}
.csf-rigid:disabled {
  opacity: 0.5;
}
.csf-name {
  font-weight: 600;
  padding-left: 6px;
  color: var(--md-primary);
  user-select: none;
}
.csf-check {
  cursor: pointer;
  user-select: none;
}
.csf-check input {
  accent-color: var(--md-primary);
}
.csf-btn {
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
.csf-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
.csf-btn--primary {
  background: var(--md-primary);
  color: #fff;
}
.csf-btn--primary:hover {
  background: var(--md-primary);
  filter: brightness(0.95);
}
.csf-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.csf-btn:disabled:hover {
  background: transparent;
}
.csf-btn--primary:disabled:hover {
  background: var(--md-primary);
  filter: none;
}
</style>
