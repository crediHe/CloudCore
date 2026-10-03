<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useCsfProStore } from '../stores/csfProStore'
import { CSF_PRO_INPUT } from '../utils/csfPro'

/**
 * 精准地面分割（csf-pro：老算法液体贴合语义 CSF）横条工具栏（浮层，3D 视图区
 * 右上角，与 CsfToolBar / FilterToolBar 同款样式）。对应 native/csf-pro 模块。
 *
 * 点击工具栏精准分割按钮后显示：布料分辨率 + 分类阈值输入、刚性三档，以及
 * 「分割 / 取消」。
 * 与 LiDAR 版（CsfToolBar）的差异——运行期间弹全局进度条（GlobalProgress，
 * modal 遮幕 + 可取消）：点「分割」即跑 C++ 布料模拟（异步，node-addon，
 * AsyncProgressWorker 每轮迭代回报），用户可在进度条上中止；完成后直接把每个
 * 目标原实体拆成 .ground / .offGround 两块并退出模式。计算期间全部输入禁用，
 * Esc = 中止计算并退出。
 */

const { active, clothResolution, classThreshold, rigidness, computing, setParams, cancelRun, runCsfPro, exitCsfPro } =
  useCsfProStore()

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

/** Esc = 取消并退出精准分割模式；计算中先中止 native（异步收尾，见 store）。 */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && active.value) {
    if (computing.value) cancelRun()
    exitCsfPro(false)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeyDown))
</script>

<template>
  <!-- 样式与 CsfToolBar 同款（类名 csf- 系；scoped 隔离，两面板互斥不同时出现） -->
  <div v-if="active" class="csf-bar">
    <!-- 版本标识：精准语义（贴地垂坠），与 LiDAR 版区分 -->
    <span class="csf-group csf-name" title="精准地面分割（csf-pro）：布料垂坠贴身的老算法语义，丘陵/山脉等高精度；收敛慢，运行弹进度条可取消">csf-pro</span>
    <!-- 布料分辨率 -->
    <div class="csf-group">
      <label class="csf-label" title="布料网格间距（与点云坐标同单位）。越小越贴合地表细节，但粒子数随其平方反比增长、耗时激增；通常取平均点距的数倍">布料分辨率</label>
      <input
        class="csf-input"
        type="number"
        :min="CSF_PRO_INPUT.clothResolution.min"
        :max="CSF_PRO_INPUT.clothResolution.max"
        :step="CSF_PRO_INPUT.clothResolution.step"
        :value="formatParam(clothResolution)"
        :disabled="computing"
        title="与点云坐标同单位；步进 0.1（老界面同款范围 0.3-2.0）"
        @input="onResolutionInput"
      />
    </div>

    <!-- 分类阈值 -->
    <div class="csf-group">
      <label class="csf-label" title="点到布料面的高度差小于该值判为地面（与坐标同单位）。地形噪声大 / 低矮植被多时调大">分类阈值</label>
      <input
        class="csf-input"
        type="number"
        :min="CSF_PRO_INPUT.classThreshold.min"
        :max="CSF_PRO_INPUT.classThreshold.max"
        :step="CSF_PRO_INPUT.classThreshold.step"
        :value="formatParam(classThreshold)"
        :disabled="computing"
        title="与点云坐标同单位；步进 0.05（老界面同款范围 0.1-1.0）"
        @input="onThresholdInput"
      />
    </div>

    <!-- 刚性（老算法三档：1 软 / 2 中 / 3 硬） -->
    <div class="csf-group">
      <label class="csf-label">刚性</label>
      <div class="csf-rigids" role="radiogroup" aria-label="布料刚性">
        <button
          v-for="(desc, v) of ['最柔：贴合起伏最强', '默认：地形常用', '最硬：近似刚性板，地形细节少时更稳']"
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

    <div class="csf-group">
      <!-- 分割：一次性计算并拆分（计算中禁用；进度与取消在全局进度条） -->
      <button
        class="csf-btn csf-btn--primary"
        title="运行布料贴地模拟（较慢，弹全局进度条）：完成后直接拆成 ground / offGround 两块实体"
        :disabled="computing"
        @click="runCsfPro"
      >
        {{ computing ? '分割中…' : '分割' }}
      </button>
      <button
        class="csf-btn"
        :title="computing ? '中止计算并退出（进度条上也可取消）' : '放弃分割并退出（Esc）'"
        @click="exitCsfPro(false)"
      >
        取消
      </button>
    </div>
  </div>
</template>

<style scoped>
/* —— 样式同 CsfToolBar（csf-bar 视觉体系） —— */
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
.csf-name {
  font-weight: 600;
  padding-left: 6px;
  color: var(--md-primary);
  user-select: none;
}
</style>
