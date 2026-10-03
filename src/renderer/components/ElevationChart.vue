<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useSceneStore } from '../stores/sceneStore'
import {
  ELEVATION_BINS,
  ELEVATION_RAMP_CSS,
  binIndexOf,
  countInRange,
  normalizeElevationRange,
  type ElevationHistogram,
} from '../utils/elevation'
import { fmtFixed, fmtThousands } from '../utils/format'

/**
 * 高程分布图（属性面板 CC Object 区，仅 `Colors = Elevation` 时渲染）。
 *
 * 三条要点：
 *  - **柱子是可见点集的分布**（getElevationHistogram 按 index 取），故滤波 / 分割之后
 *    图会跟着变——这正是用户看它的目的；轴恒为满量程（显示坐标 z），不随手柄缩放。
 *  - **手柄只夹色带、不删点**：拖动写 `SceneEntity.elevationRange`（显示坐标、吸附箱边界），
 *    经 pointcloudStore 的同步 watch → applyColorMode 收敛式重烘焙，3D 实时刷新。
 *  - **只有 fill 没有 stroke 的单个 path**：viewBox 是 `0 0 256 100` 而容器宽度随面板拖动
 *    而变（`preserveAspectRatio="none"` 非等比缩放），描边会被拉成粗细不匀。
 *
 * 本组件不进 `useAlgorithmModals` 那张表：它不是算法模态（不占相机、无目标实体快照），
 * 只是属性面板里的一个常驻控件。
 */
const props = defineProps<{ entityId: number }>()

const { getElevationHistogram, elevationRevision } = usePointCloudStore()
const { getAllEntities, setEntityElevationRange } = useSceneStore()

const entity = computed(() => getAllEntities().find((e) => e.id === props.entityId) ?? null)

/* ---------- 直方图（懒取 + 失效重算） ---------- */

const hist = ref<ElevationHistogram | null>(null)

/**
 * 失效戳：实体 id / 点数 / 包围盒 z 跨度 / 可见集修订号。四项覆盖了所有会改变分布的动作
 * ——加载、分割、合并（前两项）、配准烘焙（bbox）、滤波预览（revision，setChunkVisibility
 * 改 index 不走 updateEntityMeta）。与 pointcloudStore 内直方图缓存的戳同一口径。
 */
const histKey = computed(() => {
  const e = entity.value
  if (!e) return ''
  return `${e.id}|${e.pointCount}|${e.bbox?.minZ ?? ''}|${e.bbox?.maxZ ?? ''}|${elevationRevision.value}`
})

/** 当前 hist 属于哪个实体（-1 = 空）。 */
let loadedId = -1

async function refresh() {
  const id = props.entityId
  if (loadedId !== id) {
    // 换实体（v-if 未拆、只有 prop 变）：先清空——旧柱子的高度范围与读数都会误导
    hist.value = null
    loadedId = -1
  }
  const result = await getElevationHistogram(id)
  if (id !== props.entityId) return // 期间又换过目标，丢弃
  hist.value = result
  loadedId = result ? id : -1
}

watch(histKey, () => void refresh(), { immediate: true })

/* ---------- 范围（轴 / 规整 / 箱） ---------- */

/** 满量程轴（显示坐标）；图尚未就绪时为 null。 */
const axis = computed(() => hist.value?.axis ?? null)

/**
 * 当前生效范围 = 与着色**同一函数**规整（normalizeElevationRange）：图表上的手柄位置、
 * 读数与 3D 的颜色因此恒一致（例如范围整体落在轴外时两边都回满量程）。
 */
const range = computed(() => {
  const a = axis.value
  if (!a) return null
  return normalizeElevationRange(a, entity.value?.elevationRange ?? null)
})

/** 范围两端对应的箱号；右端满量程时用 BINS（= 轴右端，含最后一箱）。 */
const rangeBins = computed(() => {
  const a = axis.value
  const r = range.value
  if (!a || !r) return { lo: 0, hi: ELEVATION_BINS }
  return {
    lo: binIndexOf(r.min, a),
    hi: r.max >= a.max ? ELEVATION_BINS : binIndexOf(r.max, a),
  }
})

/** 已回到满量程（手柄贴两端）→ 重置按钮灰掉。 */
const isFullRange = computed(() => {
  const a = axis.value
  const r = range.value
  if (!a || !r) return true
  return r.min <= a.min && r.max >= a.max
})

/** 范围内点数与占比（箱级求和，O(256)，拖拽时实时）。 */
const inRange = computed(() => {
  const h = hist.value
  const a = axis.value
  const r = range.value
  if (!h || !a || !r) return { count: 0, percent: 0 }
  const count = countInRange(h.bins, a, r.min, r.max)
  const percent = h.total > 0 ? (count / h.total) * 100 : 0
  return { count, percent }
})

/** 轴位置 → 百分比（手柄与高亮带都按百分比定位，容器宽度可拖、无需测量）。 */
function pctOf(value: number): number {
  const a = axis.value
  if (!a) return 0
  const span = a.max - a.min
  if (!(span > 0)) return 0
  const t = (value - a.min) / span
  return Math.min(100, Math.max(0, t * 100))
}

const loPct = computed(() => (range.value ? pctOf(range.value.min) : 0))
const hiPct = computed(() => (range.value ? pctOf(range.value.max) : 100))

/**
 * 手柄的落点：两端各内缩半个手柄宽（2px），否则满量程时手柄有一半在容器外被裁掉，
 * 看不清也抓不住。屏幕上的偏差 ≤ 2px，肉眼不可察；拖拽取值仍走完整宽度（见 onDragMove）。
 */
function handleLeft(pct: number): string {
  return `calc(${pct}% + ${((50 - pct) * 0.04).toFixed(2)}px)`
}

/* ---------- 柱子路径 ---------- */

/** 单个 path（箱 k 画成 [k, k+1] 的矩形，viewBox 宽度 = ELEVATION_BINS）。 */
const barsPath = computed(() => {
  const h = hist.value
  if (!h) return ''
  let max = 0
  for (let k = 0; k < h.bins.length; k++) {
    if (h.bins[k] > max) max = h.bins[k]
  }
  if (max <= 0) return ''
  let d = 'M0,100'
  for (let k = 0; k < h.bins.length; k++) {
    // 峰值留 1 单位余量：贴边时柱顶会被容器裁掉一丝
    const y = (100 - (h.bins[k] / max) * 99).toFixed(2)
    d += `L${k},${y}L${k + 1},${y}`
  }
  return `${d}L${ELEVATION_BINS},100Z`
})

/* ---------- 手柄拖拽 ---------- */

/**
 * 吸附到箱边界：`round(t × BINS)` 得到箱号，取值 = 该箱下沿。
 *
 * 为什么吸附：`countInRange` 与 `fillElevationColors` 都按箱归属取整，取值停在箱边界上
 * 时"读数里的点数"与"3D 里非端点色的点数"严格相等；不吸附则读数会与画面差半个箱。
 * 吸附还有个副作用是免费的节流：鼠标在同一箱内移动不产生任何写入。
 */
function binEdge(b: number): number {
  const a = axis.value
  if (!a) return 0
  return a.min + (b / ELEVATION_BINS) * (a.max - a.min)
}

type Side = 'lo' | 'hi'
const dragging = ref<Side | null>(null)
const plotEl = ref<HTMLElement | null>(null)

function startDrag(side: Side, event: PointerEvent) {
  if (!axis.value) return
  dragging.value = side
  // 指针捕获：拖到图外（甚至面板外）仍持续收到 pointermove，松手必得 pointerup
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onDragMove(event: PointerEvent) {
  const side = dragging.value
  const a = axis.value
  const cur = rangeBins.value
  if (!side || !a) return
  const plot = plotEl.value
  if (!plot) return
  // 用**内边距盒**（clientWidth / clientLeft）而非 border box：绝对定位的子元素正是
  // 相对内边距盒定位的，两者同源，指针位置才与手柄落点严格一致（差 1px 边框宽）
  const rect = plot.getBoundingClientRect()
  const width = plot.clientWidth
  if (width <= 0) return
  const t = Math.min(1, Math.max(0, (event.clientX - rect.left - plot.clientLeft) / width))
  const b = Math.round(t * ELEVATION_BINS)
  if (side === 'lo') {
    // 两手柄不相交：至少留一箱宽（normalizeElevationRange 也会兜底，但别让用户拖出"一片纯色"）
    const lo = Math.max(0, Math.min(b, cur.hi - 1))
    setEntityElevationRange(props.entityId, { min: binEdge(lo), max: binEdge(cur.hi) })
  } else {
    const hi = Math.max(cur.lo + 1, Math.min(b, ELEVATION_BINS))
    setEntityElevationRange(props.entityId, { min: binEdge(cur.lo), max: binEdge(hi) })
  }
}

function endDrag(event: PointerEvent) {
  dragging.value = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

/** 重置到满量程（写 null，与"从未拖过"完全同态）。 */
function resetRange() {
  setEntityElevationRange(props.entityId, null)
}
</script>

<template>
  <div class="elev">
    <div class="elev__head">
      <span class="elev__title">Elevation distribution</span>
      <button
        class="elev__reset"
        type="button"
        :disabled="isFullRange"
        title="把色带范围重置为整片点云的高程跨度"
        @click="resetRange"
      >
        Reset
      </button>
    </div>

    <div v-if="hist && axis" class="elev__plot" ref="plotEl">
      <svg class="elev__bars" viewBox="0 0 256 100" preserveAspectRatio="none" aria-hidden="true">
        <path :d="barsPath" />
      </svg>

      <!-- 带外淡出（浅色面板用白色蒙版比压暗更清楚：带内满色、带外发灰），
           两个蒙版拼成 [0, lo] 与 [hi, 100%]，宽度按百分比定位 -->
      <div class="elev__dim" :style="{ width: loPct + '%' }"></div>
      <div class="elev__dim elev__dim--hi" :style="{ left: hiPct + '%' }"></div>

      <!-- 色带窗口：淡底 + 底部一条满饱和色带（左端 = 最低色，右端 = 最高色），
           与 3D 用的是同一份锚点的 CSS 渐变（ELEVATION_RAMP_CSS） -->
      <div class="elev__band" :style="{ left: loPct + '%', width: Math.max(0, hiPct - loPct) + '%' }">
        <div class="elev__ramp" :style="{ backgroundImage: ELEVATION_RAMP_CSS }"></div>
      </div>

      <div
        class="elev__handle"
        :class="{ 'elev__handle--active': dragging === 'lo' }"
        :style="{ left: handleLeft(loPct) }"
        title="拖动改变高程色带下限"
        @pointerdown="startDrag('lo', $event)"
        @pointermove="onDragMove"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      ></div>
      <div
        class="elev__handle"
        :class="{ 'elev__handle--active': dragging === 'hi' }"
        :style="{ left: handleLeft(hiPct) }"
        title="拖动改变高程色带上限"
        @pointerdown="startDrag('hi', $event)"
        @pointermove="onDragMove"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      ></div>
    </div>

    <div v-else class="elev__empty">统计中…</div>

    <div v-if="hist && axis && range" class="elev__axis">
      <span>{{ fmtFixed(axis.min, 2) }} m</span>
      <span>{{ fmtFixed(axis.max, 2) }} m</span>
    </div>
    <div v-if="hist && axis && range" class="elev__readout">
      <span>最低 {{ fmtFixed(range.min, 2) }} — 最高 {{ fmtFixed(range.max, 2) }} m</span>
      <span>
        范围内 {{ fmtThousands(inRange.count) }} / {{ fmtThousands(hist.total) }} 点（{{
          fmtFixed(inRange.percent, 1)
        }}%）
      </span>
    </div>
  </div>
</template>

<style scoped>
.elev {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 12px 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  /* 拖手柄时不要选中文本（面板里全是文字，默认会划出选区） */
  user-select: none;
}
.elev__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.elev__title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--md-on-surface-variant);
}
.elev__reset {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 8px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  background: var(--md-surface-container-lowest);
  color: var(--md-on-surface);
  cursor: pointer;
}
.elev__reset:disabled {
  opacity: 0.45;
  cursor: default;
}
.elev__plot {
  position: relative;
  height: 64px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.02);
}
.elev__bars {
  display: block;
  width: 100%;
  height: 100%;
}
.elev__bars path {
  fill: #7b8794;
  /* 非等比缩放下描边会粗细不匀，故只有 fill */
  stroke: none;
}
.elev__dim {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: rgba(255, 255, 255, 0.68);
  pointer-events: none;
}
.elev__dim--hi {
  left: auto;
  right: 0;
}
.elev__band {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.05);
  pointer-events: none;
}
.elev__ramp {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 5px;
  background-repeat: no-repeat;
  background-size: 100% 100%;
}
.elev__handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  margin-left: -2px;
  border-radius: 2px;
  background: #1f2933;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
  cursor: ew-resize;
  touch-action: none;
}
.elev__handle--active {
  background: var(--md-primary);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.95);
}
.elev__empty {
  font-size: 11px;
  color: var(--md-on-surface-variant);
  opacity: 0.7;
}
.elev__axis {
  display: flex;
  justify-content: space-between;
  font-family: monospace;
  font-size: 10px;
  color: var(--md-on-surface-variant);
}
.elev__readout {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-family: monospace;
  font-size: 11px;
  color: var(--md-on-surface);
  font-variant-numeric: tabular-nums;
}
</style>
