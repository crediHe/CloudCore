<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useOpenPointCloud } from '../composables/useOpenPointCloud'
import { savePointCloudAs, savePointCloudState } from '../composables/useSavePointCloud'
import { useMergeSelection } from '../composables/useMergeSelection'
import { useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { useNormalStore, resolveNormalSelection, selectedEntityIdsWithNormals } from '../stores/normalStore'
import { useTreeInfoStore } from '../stores/treeInfoStore'
import { useViewerStore } from '../stores/viewerStore'
import { ALGORITHM_MODAL_GROUPS, useAlgorithmModals, type AlgorithmModalKey } from '../composables/useAlgorithmModals'
import { hintOf, type ShortcutId } from '../utils/appShortcuts'
import { PIVOT_VISIBILITY_CYCLE, PIVOT_VISIBILITY_LABELS } from '../utils/pivotVisibility'
import { TREE_MARKER_LABELS, TREE_MARKER_MODES } from '../utils/treeMarkers'
import type { TreeMarkerMode } from '../utils/treeMarkers'
import type { ViewName } from '../utils/viewDirections'

/**
 * 顶部菜单栏：一级菜单 File（Open / Save as… / 分割线 / Quit）、Edit（Merge + Normals 分组）、
 * View（六个标准视角 + 取景 + 投影 + 旋转中心 + 树木标记三档）、Tools（十二个算法模态）、
 * Trees（树木基础信息：标记 / 计算 / 清除，见 stores/treeInfoStore.ts）。
 * Tools 的入口表、排列顺序、文案与互斥 toggle 都与右竖工具栏 SideToolBar 同源
 * （composables/useAlgorithmModals），不再各自维护一份清单。项的禁用判据**逐项**取
 * `disabledOf(key)`——两个配准入口要求恰好选中 2 个点云，比"有选中即可"严格，
 * 全表共用一个 `disabled` 会把它们错放行。
 *
 * Edit 的 Normals 分组走 CC 的布局（`Edit > Normals > Compute / Invert / Delete`），
 * 但**不进**算法模态表：它不是「占用相机 + 参数横条 + 预览-确认」的会话，而是一次成型
 * 的对话框 + 两个即时动作（详见 stores/normalStore.ts 的文件头）。Trees 菜单同理——
 * 它是「筛选目标 → 一次算完 → 写进实体属性」的批量动作，同样不进那张表。
 *
 * View 菜单里的东西（视角 / 投影 / 旋转中心）同样**不是**算法模态——它们不占相机、
 * 没有目标实体快照，只是引擎状态的开关，故与左竖工具栏一样走 viewerStore。
 * 六向视角的按键提示与 Ctrl+1..6 的实际绑定同源（utils/appShortcuts 那张表）。
 */
const openMenu = ref<'file' | 'edit' | 'view' | 'tools' | 'trees' | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const { openPointCloud } = useOpenPointCloud()
const sceneStore = useSceneStore()
const { selection } = sceneStore
const { fitViewTo, hasCloudRecords } = usePointCloudStore()
const { projection, setProjection, pivotVisibility, setPivotVisibility, setView } = useViewerStore()
const {
  disabledOf: toolDisabledOf,
  isActive: isToolActive,
  titleOf: toolTitle,
  toggle: toggleTool,
} = useAlgorithmModals()

function toggleMenu(menu: 'file' | 'edit' | 'view' | 'tools' | 'trees') {
  openMenu.value = openMenu.value === menu ? null : menu
}

function closeMenu() {
  openMenu.value = null
}

function handleOpen() {
  closeMenu()
  openPointCloud()
}

function handleQuit() {
  closeMenu()
  window.electronAPI.app.quit()
}

/**
 * Save as… 可用性：**恰好 1 个**已加载完成的选中实体，且无算法模态在进行中
 * （模态的预览改的正是要写出的 geometry.index）。判据本体在 useSavePointCloud，
 * 与保存流程同源，避免"菜单说能点、点了却报错"。
 */
const saveState = computed(() => savePointCloudState())

function handleSaveAs() {
  closeMenu()
  if (!saveState.value.ok) return
  void savePointCloudAs()
}

/** Tools 菜单项：切换算法模态（互斥与 toggle 语义都在 composables/useAlgorithmModals）。 */
function handleTool(key: AlgorithmModalKey) {
  closeMenu()
  toggleTool(key)
}

/**
 * Merge 的判据与动作在 composables/useMergeSelection（与快捷键 Ctrl+M 共用一份，
 * 避免"菜单说不能点、键盘却照做"的分裂）。
 */
const { mergeState, mergeSelection } = useMergeSelection()

function handleMerge() {
  closeMenu()
  mergeSelection()
}

/* ---------- View（六个标准视角 / 取景 / 投影 / 旋转中心 / 树木标记档位） ---------- */

/**
 * 六个标准视角：顺序与左竖工具栏完全一致，`id` 指向快捷键表里的条目
 * （按键提示从那儿取，改键位不必动本文件）。视角名 → 方位的约定在 utils/viewDirections。
 */
const VIEW_ITEMS: { view: ViewName; label: string; id: ShortcutId }[] = [
  { view: 'front', label: 'Front', id: 'viewFront' },
  { view: 'back', label: 'Back', id: 'viewBack' },
  { view: 'left', label: 'Left', id: 'viewLeft' },
  { view: 'right', label: 'Right', id: 'viewRight' },
  { view: 'top', label: 'Top', id: 'viewTop' },
  { view: 'bottom', label: 'Bottom', id: 'viewBottom' },
]

function handleView(view: ViewName) {
  closeMenu()
  setView(view)
}

/** Zoom on selected 可用性：选中项（含项目 / 容器展开）里至少有 1 片点云。 */
const fitSelectedState = computed<{ ok: boolean; reason: string }>(() => {
  const ids = resolveNormalSelection(selection.value)
  if (ids.length === 0) return { ok: false, reason: '请先在 DB Tree 中选中要取景的点云' }
  return { ok: true, reason: `把视图对准选中的 ${ids.length} 片点云` }
})

function handleFit(target: 'all' | 'selected') {
  closeMenu()
  if (target === 'all') {
    fitViewTo()
    return
  }
  const ids = resolveNormalSelection(selection.value)
  if (ids.length > 0) fitViewTo(ids)
}

/**
 * 切换树木 3D 标记的档位：只写状态，覆盖物由 `three/treeInfoOverlay` 的 watch 自动重画
 * （同 Pivot 三档：改状态即可，没有"立即重画"的动作要在这里调）。
 */
function handleMarkerMode(mode: TreeMarkerMode) {
  closeMenu()
  setMarkerMode(mode)
}

/* ---------- Edit > Normals（估计 / 反转 / 清除） ---------- */

const { openComputeDialog, invertNormals, deleteNormals, computing: normalComputing } = useNormalStore()

/**
 * Compute… 可用性：≥1 个选中实体已加载完成（有 bbox，即拿得到渲染缓冲），且无估计在飞。
 * 项目 / 树项容器节点可选中（展开成其下全部实体），未加载完成的会被 openComputeDialog 跳过。
 */
const normalsComputeState = computed<{ ok: boolean; reason: string }>(() => {
  if (normalComputing.value) return { ok: false, reason: '法向量计算进行中，请稍候' }
  const ids = resolveNormalSelection(selection.value)
  if (ids.length === 0) return { ok: false, reason: '请先在 DB Tree 中选中要计算法向量的点云' }
  const all = sceneStore.getAllEntities()
  const loaded = ids.filter((id) => {
    const e = all.find((x) => x.id === id)
    return !!e && !!e.bbox && !!e.globalShift
  })
  if (loaded.length === 0) return { ok: false, reason: '选中的点云尚未加载完成，请稍候' }
  return { ok: true, reason: `为选中的 ${loaded.length} 片点云估计法向量（局部拟合 + 定向）` }
})

/** Invert / Delete 可用性：≥1 个选中实体**已经有**法向量。 */
const normalsEditState = computed<{ ok: boolean; reason: string }>(() => {
  if (normalComputing.value) return { ok: false, reason: '法向量计算进行中，请稍候' }
  const ids = selectedEntityIdsWithNormals(selection.value)
  if (ids.length === 0) {
    return { ok: false, reason: '选中的点云没有法向量；请先执行 Compute normals' }
  }
  return { ok: true, reason: `作用于选中的 ${ids.length} 片点云` }
})

function handleNormals(kind: 'compute' | 'invert' | 'delete') {
  closeMenu()
  if (kind === 'compute') {
    if (normalsComputeState.value.ok) openComputeDialog()
  } else if (kind === 'invert') {
    if (normalsEditState.value.ok) invertNormals()
  } else if (normalsEditState.value.ok) {
    deleteNormals()
  }
}

/* ---------- Trees（树木基础信息：标记 / 计算 / 清除） ---------- */

const {
  treeTargetCount,
  treeObjectCount,
  computing: treeComputing,
  openComputeDialog: openTreeInfoDialog,
  clearTreeInfo,
  markSelectionAsTree,
  // 3D 树木标记的显示档位：**菜单项在 View 里**，状态却存在 treeInfoStore
  // （它不是引擎状态——覆盖物挂在 three/ 侧、由自己的 watch 驱动，见 treeInfoStore 文件头）
  markerMode,
  setMarkerMode,
} = useTreeInfoStore()

/** 选中项摊平出的实体数（Mark as tree 的可用性；多选解析口径与各算法一致）。 */
const selectionEntityCount = computed(() => resolveNormalSelection(selection.value).length)

/**
 * Compute tree info… 可用性：≥1 个选中实体「已加载 + 分类是 4/5」——判据与对话框的目标筛选**同源**
 * （`treeInfoStore.treeTargetCount`），不在这里重写一遍，避免"菜单说能点、点了只得到一句日志"。
 */
const treeComputeState = computed<{ ok: boolean; reason: string }>(() => {
  if (treeComputing.value) return { ok: false, reason: '树木信息计算进行中，请稍候' }
  const n = treeTargetCount.value
  if (n === 0) {
    return {
      ok: false,
      reason: '选中的点云都不是树（可见点分类需全部为 4 中等植被 / 5 高植被）；可先右键 Mark as tree',
    }
  }
  return { ok: true, reason: `为选中的 ${n} 片树点云计算树高 / 代表点 / 冠幅 / 胸径（非 4/5 的会被跳过）` }
})

/** Clear tree info 可用性：≥1 个选中实体已经有树木信息（只清信息，不动分类值）。 */
const treeClearState = computed<{ ok: boolean; reason: string }>(() => {
  const n = treeObjectCount.value
  return n > 0
    ? { ok: true, reason: `清空选中的 ${n} 片点云的树木信息（回到"还没算"状态，不影响分类）` }
    : { ok: false, reason: '选中的点云没有已算出的树木信息' }
})

/** Mark as tree 可用性：选中项里至少有 1 片点云（逐个写入分类，未加载的会失败并进日志）。 */
const markTreeState = computed<{ ok: boolean; reason: string }>(() => {
  const n = selectionEntityCount.value
  return n > 0
    ? { ok: true, reason: `作用于选中的 ${n} 片点云，属性面板随即出现 Tree object 区` }
    : { ok: false, reason: '请先在 DB Tree 中选中要标记的点云' }
})

function handleTreeCompute() {
  closeMenu()
  if (treeComputeState.value.ok) openTreeInfoDialog()
}

function handleTreeClear() {
  closeMenu()
  if (treeClearState.value.ok) clearTreeInfo()
}

/** 标记为树木类：右键菜单里的同名两项与这里是同一份实现（treeInfoStore.markSelectionAsTree）。 */
function handleMarkTree(value: 4 | 5) {
  closeMenu()
  if (markTreeState.value.ok) markSelectionAsTree(value)
}

// 点击菜单外部时收起下拉
function onDocClick(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <nav ref="menuRef" class="menu-bar">
    <div class="menu-item" :class="{ 'menu-item--open': openMenu === 'file' }" @click="toggleMenu('file')">
      <span>File</span>
      <div v-if="openMenu === 'file'" class="menu-dropdown" @click.stop>
        <button class="menu-option" @click="handleOpen">
          Open<span class="menu-option__hint">{{ hintOf('open') }}</span>
        </button>
        <!-- 另存为：单实体 PLY 二进制 / LAS 1.2 未压缩（见 composables/useSavePointCloud） -->
        <button class="menu-option" :disabled="!saveState.ok" :title="saveState.reason" @click="handleSaveAs">
          Save as…<span class="menu-option__hint">{{ hintOf('saveAs') }}</span>
        </button>
        <div class="menu-divider"></div>
        <button class="menu-option" @click="handleQuit">Quit</button>
      </div>
    </div>
    <div class="menu-item" :class="{ 'menu-item--open': openMenu === 'edit' }" @click="toggleMenu('edit')">
      <span>Edit</span>
      <div v-if="openMenu === 'edit'" class="menu-dropdown menu-dropdown--wide" @click.stop>
        <button class="menu-option" :disabled="!mergeState.ok" :title="mergeState.reason" @click="handleMerge">
          Merge<span class="menu-option__hint">{{ hintOf('merge') }}</span>
        </button>
        <div class="menu-divider"></div>
        <!-- 法向量分组：形态对齐 CloudCompare 的 Edit > Normals（本仓库不引入飞出式子菜单，
             与 Tools 菜单的「分组标题 + 组内项」同款） -->
        <div class="menu-group">Normals</div>
        <button
          class="menu-option"
          :disabled="!normalsComputeState.ok"
          :title="normalsComputeState.reason"
          @click="handleNormals('compute')"
        >
          Compute…
        </button>
        <button
          class="menu-option"
          :disabled="!normalsEditState.ok"
          :title="normalsEditState.reason"
          @click="handleNormals('invert')"
        >
          Invert
        </button>
        <button
          class="menu-option"
          :disabled="!normalsEditState.ok"
          :title="normalsEditState.reason"
          @click="handleNormals('delete')"
        >
          Delete normals
        </button>
      </div>
    </div>
    <div class="menu-item" :class="{ 'menu-item--open': openMenu === 'view' }" @click="toggleMenu('view')">
      <span>View</span>
      <div v-if="openMenu === 'view'" class="menu-dropdown menu-dropdown--wide" @click.stop>
        <!-- 六个标准视角：与左竖工具栏同一批命令（viewerStore.setView），按键提示取自
             utils/appShortcuts 的同一张表，键位变了这里自动跟着变 -->
        <div class="menu-group">Standard views</div>
        <button v-for="item in VIEW_ITEMS" :key="item.view" class="menu-option" @click="handleView(item.view)">
          {{ item.label }}<span class="menu-option__hint">{{ hintOf(item.id) }}</span>
        </button>

        <div class="menu-divider"></div>
        <!-- Zoom to fit 的禁用判据直接调 hasCloudRecords()：它读的 cloudRecords 是刻意
             非响应式的 Map（大数据不进响应式系统），包成 computed 会永久缓存首次结果 -->
        <button
          class="menu-option"
          :disabled="!hasCloudRecords()"
          :title="hasCloudRecords() ? '把视图对准全部可见点云' : '场景里还没有点云'"
          @click="handleFit('all')"
        >
          Zoom to fit<span class="menu-option__hint">{{ hintOf('fitAll') }}</span>
        </button>
        <button
          class="menu-option"
          :disabled="!fitSelectedState.ok"
          :title="fitSelectedState.reason"
          @click="handleFit('selected')"
        >
          Zoom on selected<span class="menu-option__hint">{{ hintOf('fitSelected') }}</span>
        </button>

        <div class="menu-divider"></div>
        <!-- 投影模式：二选一，当前项打勾（同 ToolBar 的投影按钮，同一个 setProjection） -->
        <div class="menu-group">Projection</div>
        <button
          class="menu-option"
          :class="{ 'menu-option--active': projection === 'perspective' }"
          @click="setProjection('perspective')"
        >
          <span class="menu-option__mark">{{ projection === 'perspective' ? '✓' : '' }}</span
          >Perspective
        </button>
        <button
          class="menu-option"
          :class="{ 'menu-option--active': projection === 'orthographic' }"
          @click="setProjection('orthographic')"
        >
          <span class="menu-option__mark">{{ projection === 'orthographic' ? '✓' : '' }}</span
          >Orthographic
        </button>

        <div class="menu-divider"></div>
        <!-- 旋转中心可见性：三档，当前档打勾（左竖工具栏那颗按钮是同一状态的循环版） -->
        <div class="menu-group">Pivot</div>
        <button
          v-for="mode in PIVOT_VISIBILITY_CYCLE"
          :key="mode"
          class="menu-option"
          :class="{ 'menu-option--active': pivotVisibility === mode }"
          @click="setPivotVisibility(mode)"
        >
          <span class="menu-option__mark">{{ pivotVisibility === mode ? '✓' : '' }}</span
          >{{ PIVOT_VISIBILITY_LABELS[mode] }}
        </button>

        <div class="menu-divider"></div>
        <!-- 树木 3D 标记（树心点 / 冠层圈 / 胸径圈）：三档，当前档打勾，写法与上一组逐字一致。
             标记本身由 three/treeInfoOverlay 的 watch 自动重画（这里的 setMarkerMode 只改状态） -->
        <div class="menu-group">Tree markers</div>
        <button
          v-for="mode in TREE_MARKER_MODES"
          :key="mode"
          class="menu-option"
          :class="{ 'menu-option--active': markerMode === mode }"
          @click="handleMarkerMode(mode)"
        >
          <span class="menu-option__mark">{{ markerMode === mode ? '✓' : '' }}</span
          >{{ TREE_MARKER_LABELS[mode] }}
        </button>
      </div>
    </div>
    <div class="menu-item" :class="{ 'menu-item--open': openMenu === 'tools' }" @click="toggleMenu('tools')">
      <span>Tools</span>
      <div v-if="openMenu === 'tools'" class="menu-dropdown menu-dropdown--wide" @click.stop>
        <template v-for="group in ALGORITHM_MODAL_GROUPS" :key="group.name">
          <div class="menu-group">{{ group.name }}</div>
          <button
            v-for="item in group.items"
            :key="item.key"
            class="menu-option"
            :class="{ 'menu-option--active': isToolActive(item.key) }"
            :disabled="toolDisabledOf(item.key)"
            :title="toolTitle(item.key)"
            @click="handleTool(item.key)"
          >
            <!-- 对勾标出当前激活的模态（与右竖工具栏的高亮同一状态） -->
            <span class="menu-option__mark">{{ isToolActive(item.key) ? '✓' : '' }}</span
            >{{ item.label }}
          </button>
        </template>
      </div>
    </div>
    <!-- Trees：树木基础信息（标记为 4/5 → 属性面板出现 Tree object 区 → 批量计算 → 清空）。
         判据全是分类值，故与属性面板同一个判据函数；不进算法模态表（一次成型，没有预览态） -->
    <div class="menu-item" :class="{ 'menu-item--open': openMenu === 'trees' }" @click="toggleMenu('trees')">
      <span>Trees</span>
      <div v-if="openMenu === 'trees'" class="menu-dropdown menu-dropdown--wide" @click.stop>
        <div class="menu-group">Tree info</div>
        <button
          class="menu-option"
          :disabled="!treeComputeState.ok"
          :title="treeComputeState.reason"
          @click="handleTreeCompute"
        >
          Compute tree info…
        </button>
        <button
          class="menu-option"
          :disabled="!treeClearState.ok"
          :title="treeClearState.reason"
          @click="handleTreeClear"
        >
          Clear tree info
        </button>

        <div class="menu-divider"></div>
        <div class="menu-group">Mark</div>
        <button
          class="menu-option"
          :disabled="!markTreeState.ok"
          :title="`设为 class 4（中等植被）：${markTreeState.reason}`"
          @click="handleMarkTree(4)"
        >
          Mark as tree (class 4)
        </button>
        <button
          class="menu-option"
          :disabled="!markTreeState.ok"
          :title="`设为 class 5（高植被）：${markTreeState.reason}`"
          @click="handleMarkTree(5)"
        >
          Mark as tree (class 5)
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.menu-bar {
  display: flex;
  align-items: center;
  height: 26px;
  flex-shrink: 0;
  padding: 0 4px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  user-select: none;
  -webkit-user-select: none;
  /* 让下拉菜单（绝对定位）浮在下方工具栏之上 */
  position: relative;
  z-index: 100;
}
.menu-item {
  position: relative;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--md-on-surface);
  cursor: pointer;
}
.menu-item:hover,
.menu-item--open {
  background: rgba(0, 0, 0, 0.06);
}
.menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 2px;
  min-width: 160px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: 100;
}
/* Tools 菜单比 File / Edit 宽：项名更长，且每项前有一个对勾占位 */
.menu-dropdown--wide {
  min-width: 190px;
}
.menu-option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: transparent;
  color: var(--md-on-surface);
}
.menu-option:hover {
  background: rgba(96, 0, 167, 0.08);
  color: var(--md-primary);
}
/* 当前激活的算法模态：菜单里打勾并高亮，与右竖工具栏的按钮状态同源 */
.menu-option--active,
.menu-option--active:hover {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
/* 对勾占位：无论有没有勾，项名都从同一列开始 */
.menu-option__mark {
  display: inline-block;
  width: 14px;
}
/*
 * 快捷键提示（菜单右侧）。用 float 而非 flex：`.menu-option` 是 block + text-align:left，
 * 改成 flex 会把"对勾 span + 文字节点"拆成两个 flex item，Tools 菜单那一列对勾的间距跟着变。
 * 文案来自 utils/appShortcuts 的同一张表（hintOf），与实际绑定同源。
 */
.menu-option__hint {
  float: right;
  margin-left: 12px;
  color: var(--md-on-surface-variant);
  font-size: 11px;
}
.menu-option:disabled {
  opacity: 0.4;
  cursor: default;
}
.menu-option:disabled:hover {
  background: transparent;
  color: var(--md-on-surface);
}
/* 分组标题（Filter / Segment / Fit / Registration） */
.menu-group {
  padding: 6px 10px 2px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--md-on-surface-variant);
}
.menu-divider {
  height: 1px;
  margin: 4px 6px;
  background: rgba(0, 0, 0, 0.08);
}
</style>
