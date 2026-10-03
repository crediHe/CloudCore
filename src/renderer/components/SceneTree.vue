<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSceneStore } from '../stores/sceneStore'
import type { EntityDropTarget, SceneEntity, SceneProject, SceneSelection, SceneTreeGroup } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import { resolveNormalSelection } from '../stores/normalStore'
import { useTreeInfoStore } from '../stores/treeInfoStore'
import { classColorCss, className, CLASS_NAMES } from '../utils/classColors'

/**
 * DB Tree：一级项目节点 + 二级点云实体节点 + 三级容器节点（分割产物组：TreeIso 单木分割的
 * 「树项」、欧式聚类的「聚类容器」）。
 * 容器内的实体**平铺**在项目 entities 中（既有消费者只认扁平列表，sceneStore
 * addEntityToGroup 的注释约定），因此二级列表需把它们挑出去、改在三级容器行下
 * 渲染；其余交互（点选/多选/勾选/双击改名/右键菜单）三态共用一套。
 * 容器本身是节点（type: 'treegroup'）：可选中（属性面板联动）、可勾选显隐
 * （级联其下全部实体，toggleTreeGroupVisible）、右键 Delete 整组删除
 * （pointcloudStore.deleteTreeGroup：逐项实体释放 3D 资源后移除容器）。
 * 点击节点名选中（属性面板联动），Ctrl/⌘ + 点击加选/取消，Shift + 点击**从锚点连选**到本行
 * （两者都是多选入口，merge / 批量改属性等用）；
 * 点击箭头展开/折叠，勾选框控制显隐。
 * 右键节点：**节点已在选中集里就保留整个选中集**（资源管理器语义），否则先单选它，再弹上下文菜单
 * （点云实体：Split by classification 按分类拆分 / Set classification… 整片设为同一分类
 * （浮层选值 → 二次确认写入）/ Mark as tree (class 4 | 5) 批量标记树木 / Delete 删除；
 * 容器：Delete 删除整组；项目：Delete 删除整个项目）。
 * 菜单里除 Mark as tree 外都只作用于 `menu.node`（右键落在谁身上就是谁）；Mark as tree 是**批量**动作，
 * 作用于整个选中集（`treeInfoStore.markSelectionAsTree`，菜单栏 `Trees ▸ Mark` 同源）。
 *
 * 拖拽（仅点云实体可拖，且**仅同项目内**）：拖到实体行的上/下半 = 插到它前/后（同列表即重排序、
 * 跨列表即换容器），拖到容器行 = 移入并追加末尾，拖到项目行 = 移出到项目顶层。
 * 落点统一交给 `sceneStore.moveEntity`，本组件只负责"算落点 + 画提示 + 拦非法目标"；
 * 拖入容器的项会被标为 `manuallyPlaced`（重跑单木分割时不参与，见 SceneEntity 的注释）。
 */
const {
  projects,
  selection,
  toggleProject,
  toggleProjectVisible,
  toggleEntityVisible,
  toggleTreeGroup,
  toggleTreeGroupVisible,
  selectNode,
  toggleSelectNode,
  selectRange,
  renameProject,
  renameEntity,
  renameTreeGroup,
  moveEntity,
} = useSceneStore()

// 删除/拆分/设值走 pointcloudStore：先释放/改写 three.js 资源再移树节点（资源在树结构之外）
const { deleteEntity, deleteTreeGroup, deleteProject, splitByClassification, setEntityClassification } =
  usePointCloudStore()

// 批量标记树木（右键菜单与菜单栏 Trees ▸ Mark 同源；解析多选 → 实体由 treeInfoStore 内部完成）
const { markSelectionAsTree } = useTreeInfoStore()

/** 「Mark as tree」的可用性：选中项摊平出的实体 ≥ 1（与菜单栏那一项同一判据）。 */
const selectionEntityCount = computed(() => resolveNormalSelection(selection.value).length)

/** 树项内实体 id 集合（二级列表要跳过它们，避免与三级重复渲染）。 */
function treeGroupMemberIds(project: SceneProject): Set<number> {
  const ids = new Set<number>()
  for (const group of project.treeGroups) {
    for (const entityId of group.entityIds) ids.add(entityId)
  }
  return ids
}

/** 二级列表 = 项目直接实体（不在任何树项容器内；容器行下的树实体由三级渲染）。 */
function directEntities(project: SceneProject): SceneEntity[] {
  const memberIds = treeGroupMemberIds(project)
  return project.entities.filter((e) => !memberIds.has(e.id))
}

/** 树项容器下树实体的对象查表（实体平铺在所属项目的 entities 里）。 */
function groupEntity(project: SceneProject, entityId: number): SceneEntity | null {
  return project.entities.find((e) => e.id === entityId) ?? null
}

/** 容器行的展开子列表：组内实体按 entityIds 序渲染（防御悬空 id）。 */
function groupEntities(project: SceneProject, group: SceneTreeGroup): SceneEntity[] {
  return group.entityIds.map((id) => groupEntity(project, id)).filter((e): e is SceneEntity => e !== null)
}

/** 节点是否在选中集合中（多选时多个节点同时高亮）。 */
function isSelected(node: SceneSelection) {
  return selection.value.some((sel) => sel.type === node.type && sel.id === node.id)
}

/**
 * 三种节点行共用同一套点击语义：
 * 无修饰键 = 单选替换；Ctrl/⌘ = 加选切换；**Shift = 从锚点连选到本行**（段内可以跨容器 /
 * 跨项目，范围就是屏幕上高亮的那几行）。Ctrl+Shift 一并按 Shift 处理。
 */
function onClick(node: SceneSelection, e: MouseEvent) {
  if (e.shiftKey) {
    selectRange(node)
  } else if (e.ctrlKey || e.metaKey) {
    toggleSelectNode(node)
  } else {
    selectNode(node)
  }
}

function selectProject(project: SceneProject, e: MouseEvent) {
  onClick({ type: 'project', id: project.id }, e)
}

function selectEntity(entity: SceneEntity, e: MouseEvent) {
  onClick({ type: 'entity', id: entity.id }, e)
}

function selectTreeGroup(group: SceneTreeGroup, e: MouseEvent) {
  onClick({ type: 'treegroup', id: group.id }, e)
}

/* ---------- 右键上下文菜单 ---------- */

/** 弹出中的菜单：位置（视口坐标）+ 目标节点。 */
const menu = ref<{ x: number; y: number; node: SceneSelection } | null>(null)
const menuEl = ref<HTMLElement | null>(null)

/**
 * 右键：**节点已在选中集里就保留整个选中集**（资源管理器语义），否则先单选该节点，再弹菜单。
 * 菜单里除 Mark as tree 外都只作用于 `menu.node`，所以"保留多选"不会改变它们的语义；
 * 而 Mark as tree 本就是批量动作——右键一片已选中的树再点它，作用的是整个选中集。
 */
function openMenu(node: SceneSelection, e: MouseEvent) {
  if (!isSelected(node)) selectNode(node)
  // 固定定位的菜单，靠右下角时钳制坐标防溢出（五条目估算宽 ~220 / 高 ~230）
  menu.value = {
    x: Math.max(0, Math.min(e.clientX, window.innerWidth - 220)),
    y: Math.max(0, Math.min(e.clientY, window.innerHeight - 230)),
    node,
  }
}

function closeMenu() {
  menu.value = null
}

function onDelete() {
  const node = menu.value?.node
  closeMenu()
  if (!node) return
  if (node.type === 'entity') {
    deleteEntity(node.id)
  } else if (node.type === 'treegroup') {
    deleteTreeGroup(node.id)
  } else {
    deleteProject(node.id)
  }
}

/** 批量标记为树木类（4 中等植被 / 5 高植被）：作用于**选中集**，不是 menu.node。 */
function onMarkAsTree(value: 4 | 5) {
  closeMenu()
  markSelectionAsTree(value)
}

/** 按分类拆分（仅点云实体）：store 内部校验加载态与分类数，不在此重复判断。 */
function onSplitByClassification() {
  const node = menu.value?.node
  closeMenu()
  if (!node || node.type !== 'entity') return
  splitByClassification(node.id)
}

/* ---------- Set classification… 浮层（选值 → 二次确认写入） ---------- */

/** 弹出中的设值浮层：位置（视口坐标，沿用右键菜单坐标）+ 目标节点。 */
const setMenu = ref<{ x: number; y: number; node: SceneSelection } | null>(null)
const setEl = ref<HTMLElement | null>(null)
/** 输入框草稿（字符态；非法输入时应用键禁用）。 */
const setInput = ref('')
/** 是否处于"二次确认"步骤（防误触，确认后才真正写入）。 */
const setConfirming = ref(false)

/** 输入框当前解析出的目标值（0-255 整数；非法 → null）。 */
const targetValue = computed<number | null>(() => {
  const v = Number(setInput.value)
  return Number.isInteger(v) && v >= 0 && v <= 255 ? v : null
})

/** 设值目标实体（浮层打开期间可能已被删，按树查最新；仅点云实体可设）。 */
const targetEntity = computed<SceneEntity | null>(() => {
  const node = setMenu.value?.node
  if (!node || node.type !== 'entity') return null
  const found = findNode(node)
  return found?.type === 'pointcloud' ? found : null
})

function closeSetMenu() {
  setMenu.value = null
  setConfirming.value = false
  setInput.value = ''
}

/** 右键菜单项：关掉菜单后在原坐标弹浮层（输入 + 0-21 快捷列表，见模板）。 */
function onSetClassification() {
  const node = menu.value?.node
  const pos = menu.value
  closeMenu()
  if (!node || node.type !== 'entity') return
  setConfirming.value = false
  setInput.value = ''
  const W = 260
  const H = 320
  setMenu.value = {
    x: pos ? Math.max(0, Math.min(pos.x, window.innerWidth - W)) : 0,
    y: pos ? Math.max(0, Math.min(pos.y, window.innerHeight - H)) : 0,
    node,
  }
}

/** 快捷列表点行：回填输入框（仍要走二次确认）。 */
function pickClass(n: number) {
  setInput.value = String(n)
  setConfirming.value = false
}

/** 第一步（✓ / 回车）：值合法才进入二次确认步骤。 */
function onSetApply() {
  if (targetValue.value !== null) setConfirming.value = true
}

/** 第二步（Set class）：真正写入（store 内部再做加载/分类属性校验，失败写日志）。 */
function onSetCommit() {
  const node = setMenu.value?.node
  const value = targetValue.value
  closeSetMenu()
  if (!node || node.type !== 'entity' || value === null) return
  setEntityClassification(node.id, value)
}

/* ---------- 双击重命名 ---------- */

/** 编辑中的节点（同一时刻至多一个）；null = 无编辑。 */
const editing = ref<SceneSelection | null>(null)
/** 编辑框内草稿（只在编辑期有效）。 */
const draftName = ref('')
const editInput = ref<HTMLInputElement | null>(null)

/** 节点是否正处于编辑态。 */
function isEditing(node: SceneSelection): boolean {
  const cur = editing.value
  return cur !== null && cur.type === node.type && cur.id === node.id
}

/** 按 type + id 找树节点（编辑提交时可能已被删除，找不到则跳过）。 */
function findNode(sel: SceneSelection): SceneProject | SceneEntity | SceneTreeGroup | null {
  if (sel.type === 'project') {
    return projects.find((p) => p.id === sel.id) ?? null
  }
  if (sel.type === 'treegroup') {
    for (const p of projects) {
      const g = p.treeGroups.find((gr) => gr.id === sel.id)
      if (g) return g
    }
    return null
  }
  for (const p of projects) {
    const e = p.entities.find((en) => en.id === sel.id)
    if (e) return e
  }
  return null
}

/** 双击节点行进入重命名：复选框/展开箭头不触发；已有别的编辑则先提交再切入。 */
function startEdit(node: SceneSelection, e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.md-checkbox') || target.closest('.tree__arrow')) return
  if (isEditing(node)) return
  if (editing.value) commitEdit()
  editing.value = node
  draftName.value = findNode(node)?.name ?? ''
  void nextTick(() => {
    editInput.value?.focus()
    editInput.value?.select()
  })
}

/** 提交改名：写回 store。空名 / 名称未变 / 节点已删都直接收工。 */
function commitEdit() {
  const sel = editing.value
  if (!sel) return
  editing.value = null
  const next = draftName.value.trim()
  if (!next) return
  const node = findNode(sel)
  if (!node || node.name === next) return
  if (sel.type === 'project') {
    renameProject(sel.id, next)
  } else if (sel.type === 'treegroup') {
    renameTreeGroup(sel.id, next)
  } else {
    renameEntity(sel.id, next)
  }
}

/** 取消编辑（Esc / 失焦时空名视同取消）。 */
function cancelEdit() {
  editing.value = null
}

/* ---------- 拖拽（换容器 + 调顺序） ---------- */

/**
 * 拖拽中的实体。**载荷刻意不放进 dataTransfer**：HTML5 在 dragover 期读不到 data
 * （Chromium 的安全限制），而"这个目标能不能放"必须在那时就判定（不 preventDefault
 * 就不允许放下）。dataTransfer 只用于 `setData`（Chromium 需要里面有 data 才真正起拖）
 * 与 `effectAllowed`。
 *
 * 只有点云实体可拖：容器换项目、项目排序都没有实际语义。行级 draggable 挂在
 * `.tree__node` 的 span 上而非 `<li>`——`<li>` 还包含子级 `<ul>`，嵌套 draggable 会让
 * 拖子行时父子同时起拖。
 */
const dragging = ref<{ entityId: number; projectId: number } | null>(null)

/**
 * 放置提示：要执行的落点 + 提示画在哪一行、什么形态。
 * `anchorRow` 与 `half` 只服务视觉（插入线画在参照行的上/下半），
 * `target` 才是松手时交给 moveEntity 的东西。
 */
const dropHint = ref<{
  target: EntityDropTarget
  anchorRow: SceneSelection
  half: 'before' | 'after' | 'into'
} | null>(null)

/** 该行当前的落点提示类名（插入线 / 整体高亮）；无提示返回空串。 */
function dropClass(node: SceneSelection): string {
  const h = dropHint.value
  if (!h || h.anchorRow.type !== node.type || h.anchorRow.id !== node.id) return ''
  if (h.half === 'into') return 'tree__node--drop-into'
  return h.half === 'before' ? 'tree__node--drop-before' : 'tree__node--drop-after'
}

/* 悬停折叠容器时自动展开（拖到组内某个具体位置才可能），500ms 防手抖 */
let expandTimer: number | null = null

function clearExpandTimer() {
  if (expandTimer !== null) {
    window.clearTimeout(expandTimer)
    expandTimer = null
  }
}

function scheduleExpand(group: SceneTreeGroup) {
  if (group.expanded || expandTimer !== null) return
  expandTimer = window.setTimeout(() => {
    expandTimer = null
    // 期间可能已经拖走/松手：只在拖拽仍进行时展开
    if (dragging.value && !group.expanded) toggleTreeGroup(group.id)
  }, 500)
}

/** 起拖：同项目内移动（跨项目一律拒绝，moveEntity 里最终兜底）。 */
function onEntityDragStart(entity: SceneEntity, project: SceneProject, e: DragEvent) {
  dragging.value = { entityId: entity.id, projectId: project.id }
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(entity.id))
  }
}

/** 收尾：清载荷与提示（drop / dragend 共用；dragend 也兜住"拖到应用外松手"）。 */
function onEntityDragEnd() {
  dragging.value = null
  dropHint.value = null
  clearExpandTimer()
}

/**
 * 实体行的 dragover：按行的**中线**判上/下半——上半插到它之前、下半插到它之后。
 * 同一列表内即重排序，跨列表即换容器（落点由该行所属列表 `parent` 决定）。
 *
 * 落点用"下一个实体"当锚点：下半时插到 `list[idx + 1]` 之前，该处为空即追加到末尾
 * （正是"拖到最后一行的下半"该有的语义）。锚点的合法性由 moveEntity 兜底校验。
 */
function onEntityRowDragOver(
  entity: SceneEntity,
  project: SceneProject,
  list: SceneEntity[],
  parent: { kind: 'group'; groupId: number } | { kind: 'project'; projectId: number },
  e: DragEvent
) {
  const d = dragging.value
  // 非同项目 / 拖到自己身上：不 preventDefault ⇒ 光标显示"禁止"，松手无动作
  if (!d || d.projectId !== project.id || d.entityId === entity.id) return
  clearExpandTimer()
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const after = e.clientY > rect.top + rect.height / 2
  const idx = list.findIndex((x) => x.id === entity.id)
  dropHint.value = {
    target: { ...parent, beforeEntityId: after ? list[idx + 1]?.id : entity.id },
    anchorRow: { type: 'entity', id: entity.id },
    half: after ? 'after' : 'before',
  }
}

/** 容器行：拖到行上 = 移入该容器，追加到末尾（要精确定位就拖到组内某一行去）。 */
function onGroupRowDragOver(group: SceneTreeGroup, project: SceneProject, e: DragEvent) {
  const d = dragging.value
  if (!d || d.projectId !== project.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  scheduleExpand(group)
  dropHint.value = {
    target: { kind: 'group', groupId: group.id },
    anchorRow: { type: 'treegroup', id: group.id },
    half: 'into',
  }
}

/** 项目行：拖到行上 = 移出到项目顶层，追加到末尾。 */
function onProjectRowDragOver(project: SceneProject, e: DragEvent) {
  const d = dragging.value
  if (!d || d.projectId !== project.id) return
  clearExpandTimer()
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropHint.value = {
    target: { kind: 'project', projectId: project.id },
    anchorRow: { type: 'project', id: project.id },
    half: 'into',
  }
}

/** 松手：按当前提示的落点执行移动（合法性判定集中在 dragover，此处再兜一道）。 */
function onRowDrop(e: DragEvent) {
  e.preventDefault()
  const hint = dropHint.value
  const d = dragging.value
  if (hint && d && !moveEntity(d.entityId, hint.target)) {
    console.warn('[SceneTree] 拖拽落点无效，已忽略', d.entityId, hint.target)
  }
  onEntityDragEnd()
}

/** 真正离开树区域才清提示（relatedTarget 仍在树内 = 只是换行，下一次 dragover 会覆盖）。 */
function onTreeDragLeave(e: DragEvent) {
  const next = e.relatedTarget as Node | null
  if (next && (e.currentTarget as HTMLElement).contains(next)) return
  dropHint.value = null
}

// 关闭时机：菜单/浮层外任意处按下（含再次右键，pointerdown 先于 contextmenu 关闭旧的）、
// Esc、外部滚动。菜单与设值浮层互斥（开浮层先关菜单），同一套监听器分别判断归属。
function onWindowPointerDown(e: PointerEvent) {
  const t = e.target as Node
  if (menu.value && menuEl.value && !menuEl.value.contains(t)) {
    closeMenu()
  }
  if (setMenu.value && setEl.value && !setEl.value.contains(t)) {
    closeSetMenu()
  }
}
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeMenu()
    closeSetMenu()
  }
}
function onWindowScroll(e: Event) {
  // 捕获期会先于元素命中——菜单/浮层内部滚动（如分类快捷列表滚行）不算外部滚动
  const t = e.target as Node
  if (menuEl.value?.contains(t) || setEl.value?.contains(t)) return
  closeMenu()
  closeSetMenu()
}
onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown)
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('scroll', onWindowScroll, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('scroll', onWindowScroll, true)
  clearExpandTimer()
})
</script>

<template>
  <div class="scene-tree" @dragleave="onTreeDragLeave">
    <div class="panel-title">DB Tree</div>
    <ul v-if="projects.length" class="tree">
      <li v-for="project in projects" :key="project.id">
        <span
          class="tree__node"
          :class="[
            { 'tree__node--selected': isSelected({ type: 'project', id: project.id }) },
            dropClass({ type: 'project', id: project.id }),
          ]"
          @click="selectProject(project, $event)"
          @dblclick="startEdit({ type: 'project', id: project.id }, $event)"
          @contextmenu.prevent="openMenu({ type: 'project', id: project.id }, $event)"
          @dragover="onProjectRowDragOver(project, $event)"
          @drop="onRowDrop"
        >
          <input
            type="checkbox"
            class="md-checkbox"
            :checked="project.visible"
            title="显示/隐藏整个项目"
            @click.stop
            @change="toggleProjectVisible(project.id)"
          />
          <svg class="tree__arrow" viewBox="0 0 12 12" fill="none" @click.stop="toggleProject(project.id)">
            <path v-if="!project.expanded" d="M4.5 3l4 3-4 3z" fill="currentColor" />
            <path v-else d="M3 4.5l3 4 3-4z" fill="currentColor" />
          </svg>
          <span v-if="!isEditing({ type: 'project', id: project.id })" class="tree__name">{{ project.name }}</span>
          <input
            v-else
            ref="editInput"
            v-model="draftName"
            class="tree__input"
            spellcheck="false"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.prevent="cancelEdit"
            @blur="commitEdit"
          />
        </span>
        <ul v-if="project.expanded">
          <!-- 二级：项目直接实体（树项容器内的树实体不在此渲染，见三级）。
               ⚠ 本段的渲染顺序（直接实体 → 容器 → 容器成员）必须与 sceneStore.flattenVisibleRows
               一致：Shift 连选就是按那个顺序取"锚点 → 本行"这一段，顺序一改就连选错行 -->
          <li v-for="entity in directEntities(project)" :key="entity.id">
            <span
              class="tree__node tree__node--leaf"
              :class="[
                { 'tree__node--selected': isSelected({ type: 'entity', id: entity.id }) },
                dropClass({ type: 'entity', id: entity.id }),
              ]"
              :draggable="!isEditing({ type: 'entity', id: entity.id })"
              @click="selectEntity(entity, $event)"
              @dblclick="startEdit({ type: 'entity', id: entity.id }, $event)"
              @contextmenu.prevent="openMenu({ type: 'entity', id: entity.id }, $event)"
              @dragstart="onEntityDragStart(entity, project, $event)"
              @dragend="onEntityDragEnd"
              @dragover="
                onEntityRowDragOver(
                  entity,
                  project,
                  directEntities(project),
                  { kind: 'project', projectId: project.id },
                  $event
                )
              "
              @drop="onRowDrop"
            >
              <input
                type="checkbox"
                class="md-checkbox"
                :checked="entity.visible"
                title="显示/隐藏点云"
                @click.stop
                @change="toggleEntityVisible(entity.id)"
              />
              <svg class="tree__arrow tree__arrow--placeholder" viewBox="0 0 12 12" />
              <span v-if="!isEditing({ type: 'entity', id: entity.id })" class="tree__name">{{ entity.name }}</span>
              <input
                v-else
                ref="editInput"
                v-model="draftName"
                class="tree__input"
                spellcheck="false"
                @click.stop
                @dblclick.stop
                @keydown.enter.prevent="commitEdit"
                @keydown.esc.prevent="cancelEdit"
                @blur="commitEdit"
              />
            </span>
          </li>
          <!-- 三级：容器节点（分割产物组：单木分割的树项 / 欧式聚类的聚类容器） -->
          <li v-for="group in project.treeGroups" :key="'g' + group.id">
            <span
              class="tree__node"
              :class="[
                { 'tree__node--selected': isSelected({ type: 'treegroup', id: group.id }) },
                dropClass({ type: 'treegroup', id: group.id }),
              ]"
              title="容器（分割产物组）"
              @click="selectTreeGroup(group, $event)"
              @dblclick="startEdit({ type: 'treegroup', id: group.id }, $event)"
              @contextmenu.prevent="openMenu({ type: 'treegroup', id: group.id }, $event)"
              @dragover="onGroupRowDragOver(group, project, $event)"
              @drop="onRowDrop"
            >
              <input
                type="checkbox"
                class="md-checkbox"
                :checked="group.visible"
                title="显示/隐藏整个容器（级联其下全部实体）"
                @click.stop
                @change="toggleTreeGroupVisible(group.id)"
              />
              <svg class="tree__arrow" viewBox="0 0 12 12" fill="none" @click.stop="toggleTreeGroup(group.id)">
                <path v-if="!group.expanded" d="M4.5 3l4 3-4 3z" fill="currentColor" />
                <path v-else d="M3 4.5l3 4 3-4z" fill="currentColor" />
              </svg>
              <span v-if="!isEditing({ type: 'treegroup', id: group.id })" class="tree__name">{{ group.name }}</span>
              <input
                v-else
                ref="editInput"
                v-model="draftName"
                class="tree__input"
                spellcheck="false"
                @click.stop
                @dblclick.stop
                @keydown.enter.prevent="commitEdit"
                @keydown.esc.prevent="cancelEdit"
                @blur="commitEdit"
              />
            </span>
            <!-- 三级下的树实体：容器行展开时渲染（交互与二级实体行共用） -->
            <ul v-if="group.expanded">
              <li v-for="entity in groupEntities(project, group)" :key="entity.id">
                <span
                  class="tree__node tree__node--leaf"
                  :class="[
                    { 'tree__node--selected': isSelected({ type: 'entity', id: entity.id }) },
                    dropClass({ type: 'entity', id: entity.id }),
                  ]"
                  :draggable="!isEditing({ type: 'entity', id: entity.id })"
                  @click="selectEntity(entity, $event)"
                  @dblclick="startEdit({ type: 'entity', id: entity.id }, $event)"
                  @contextmenu.prevent="openMenu({ type: 'entity', id: entity.id }, $event)"
                  @dragstart="onEntityDragStart(entity, project, $event)"
                  @dragend="onEntityDragEnd"
                  @dragover="
                    onEntityRowDragOver(
                      entity,
                      project,
                      groupEntities(project, group),
                      { kind: 'group', groupId: group.id },
                      $event
                    )
                  "
                  @drop="onRowDrop"
                >
                  <input
                    type="checkbox"
                    class="md-checkbox"
                    :checked="entity.visible"
                    title="显示/隐藏点云"
                    @click.stop
                    @change="toggleEntityVisible(entity.id)"
                  />
                  <svg class="tree__arrow tree__arrow--placeholder" viewBox="0 0 12 12" />
                  <span v-if="!isEditing({ type: 'entity', id: entity.id })" class="tree__name">{{ entity.name }}</span>
                  <input
                    v-else
                    ref="editInput"
                    v-model="draftName"
                    class="tree__input"
                    spellcheck="false"
                    @click.stop
                    @dblclick.stop
                    @keydown.enter.prevent="commitEdit"
                    @keydown.esc.prevent="cancelEdit"
                    @blur="commitEdit"
                  />
                </span>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
    <p v-else class="tree__empty">尚未打开文件</p>

    <!-- 右键菜单：固定定位到视口坐标（.prevent 已拦掉浏览器原生菜单） -->
    <div
      v-if="menu"
      ref="menuEl"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @contextmenu.prevent="closeMenu"
    >
      <button
        v-if="menu.node.type === 'entity'"
        type="button"
        class="ctx-menu__item"
        title="按分类值拆成多片点云"
        @click="onSplitByClassification"
      >
        Split by classification
      </button>
      <button
        v-if="menu.node.type === 'entity'"
        type="button"
        class="ctx-menu__item"
        title="把整片点云设为同一分类值（写时复制，不影响拆分出的其他片）"
        @click="onSetClassification"
      >
        Set classification…
      </button>
      <!-- 批量标记树木：作用于**整个选中集**（不是 menu.node），判据与菜单栏 Trees ▸ Mark 同一份 -->
      <button
        v-if="selectionEntityCount > 0"
        type="button"
        class="ctx-menu__item"
        title="把选中的全部点云设为 class 4（中等植被）——属性面板随即出现 Tree object 区"
        @click="onMarkAsTree(4)"
      >
        Mark as tree (class 4)
      </button>
      <button
        v-if="selectionEntityCount > 0"
        type="button"
        class="ctx-menu__item"
        title="把选中的全部点云设为 class 5（高植被）——属性面板随即出现 Tree object 区"
        @click="onMarkAsTree(5)"
      >
        Mark as tree (class 5)
      </button>
      <button type="button" class="ctx-menu__item ctx-menu__item--danger" @click="onDelete">Delete</button>
    </div>

    <!-- Set classification 浮层：沿用右键菜单坐标；两级（选值 → 确认写入） -->
    <div
      v-if="setMenu"
      ref="setEl"
      class="cls-pop"
      :style="{ left: setMenu.x + 'px', top: setMenu.y + 'px' }"
      @contextmenu.prevent="closeSetMenu"
    >
      <template v-if="!setConfirming">
        <div class="cls-pop__title">Set classification…</div>
        <div class="cls-pop__pick">
          <input
            v-model="setInput"
            type="number"
            min="0"
            max="255"
            step="1"
            class="cls-pop__input"
            title="目标分类值 0-255"
            @keydown.enter.prevent="onSetApply"
          />
          <span class="cls-pop__hint">0-255</span>
          <button
            type="button"
            class="cls-pop__apply"
            :disabled="targetValue === null"
            title="应用并进入确认"
            @click="onSetApply"
          >
            ✓
          </button>
        </div>
        <div class="cls-pop__list">
          <button
            v-for="(name, n) in CLASS_NAMES"
            :key="n"
            type="button"
            class="cls-pop__row"
            :class="{ 'cls-pop__row--active': setInput === String(n) }"
            @click="pickClass(n)"
          >
            <span class="cls-pop__chip" :style="{ background: classColorCss(n) }"></span>
            <span class="cls-pop__row-text">{{ n }} {{ name }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <div class="cls-pop__title">确认写入</div>
        <p class="cls-pop__confirm">
          将「{{ targetEntity?.name ?? '' }}」全部 {{ (targetEntity?.pointCount ?? 0).toLocaleString() }} 点设为分类
          <span
            class="cls-pop__chip cls-pop__chip--inline"
            :style="{ background: classColorCss(targetValue ?? 0) }"
          ></span>
          {{ targetValue }}（{{ className(targetValue ?? 0) }}）？
        </p>
        <div class="cls-pop__actions">
          <button type="button" class="cls-pop__btn" @click="setConfirming = false">Back</button>
          <button type="button" class="cls-pop__btn cls-pop__btn--primary" @click="onSetCommit">Set class</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scene-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  /* DB Tree 仿 CloudCompare：节点文字不可被鼠标选中复制 */
  user-select: none;
  -webkit-user-select: none;
}
.tree {
  list-style: none;
  margin: 0;
  padding: 0 8px 12px;
  font-size: 12px;
  color: var(--md-on-surface);
}
.tree ul {
  list-style: none;
  margin: 0;
  padding-left: 14px;
}
.tree__node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  /* 拖拽插入线（--drop-before/after）的定位上下文 */
  position: relative;
}
.tree__node:hover {
  background: rgba(0, 0, 0, 0.05);
}
.tree__node--selected,
.tree__node--selected:hover {
  background: rgba(96, 0, 167, 0.1);
}
.tree__node--leaf {
  color: var(--md-on-surface-variant);
}
/* 拖拽落点提示。**必须排在 --selected 之后**：两者特异性相同，靠书写顺序决定胜负，
  拖拽提示要压过选中高亮，否则"拖着往已选中的行上放"时看不出要落在哪 */
.tree__node--drop-into {
  background: rgba(96, 0, 167, 0.16);
  box-shadow: inset 0 0 0 1px var(--md-primary);
}
.tree__node--drop-before::before,
.tree__node--drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--md-primary);
  pointer-events: none;
}
.tree__node--drop-before::before {
  top: 0;
}
.tree__node--drop-after::after {
  bottom: 0;
}
.tree__arrow {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--md-on-surface-variant);
  border-radius: 3px;
}
.tree__arrow:hover {
  background: rgba(0, 0, 0, 0.08);
}
.tree__arrow--placeholder {
  visibility: hidden;
  pointer-events: none;
}
.tree__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree__input {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  border: 1px solid rgba(96, 0, 167, 0.4);
  border-radius: 4px;
  outline: none;
  background: var(--md-surface, #ffffff);
  color: var(--md-on-surface);
  font: inherit;
  /* 编辑框内允许选择/复制（仅编辑期） */
  user-select: text;
  -webkit-user-select: text;
}
.tree__input:focus {
  border-color: var(--md-primary, #6200ee);
}
.tree__empty {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  opacity: 0.6;
}
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 120px;
  padding: 4px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  background: var(--md-surface-container-highest, #ffffff);
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.2),
    0 8px 24px rgba(0, 0, 0, 0.24);
}
.ctx-menu__item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  color: var(--md-on-surface);
}
.ctx-menu__item:hover {
  background: rgba(0, 0, 0, 0.06);
}
.ctx-menu__item--danger {
  color: var(--md-error, #b3261e);
}
.ctx-menu__item--danger:hover {
  background: rgba(179, 38, 30, 0.08);
}
.cls-pop {
  position: fixed;
  z-index: 1000;
  width: 260px;
  padding: 8px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  background: var(--md-surface-container-highest, #ffffff);
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.2),
    0 8px 24px rgba(0, 0, 0, 0.24);
}
.cls-pop__title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--md-on-surface);
}
.cls-pop__pick {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.cls-pop__input {
  width: 64px;
  padding: 3px 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  background: var(--md-surface, #ffffff);
  color: var(--md-on-surface);
  font: inherit;
}
.cls-pop__input:focus {
  outline: none;
  border-color: var(--md-primary, #6200ee);
}
.cls-pop__hint {
  flex: 1;
  font-size: 11px;
  color: var(--md-on-surface-variant);
}
.cls-pop__apply {
  padding: 3px 10px;
  border: none;
  border-radius: 6px;
  background: rgba(96, 0, 167, 0.08);
  color: var(--md-primary, #6200ee);
  font-size: 12px;
  cursor: pointer;
}
.cls-pop__apply:disabled {
  opacity: 0.4;
  cursor: default;
}
.cls-pop__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 168px;
  overflow-y: auto;
}
.cls-pop__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  color: var(--md-on-surface);
}
.cls-pop__row:hover {
  background: rgba(0, 0, 0, 0.06);
}
.cls-pop__row--active {
  background: rgba(96, 0, 167, 0.1);
}
.cls-pop__chip {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 3px;
  /* 白/浅色块（0 未定义点等）在浅底上需描边才看得见 */
  border: 1px solid rgba(0, 0, 0, 0.25);
}
.cls-pop__chip--inline {
  display: inline-block;
  vertical-align: -2px;
  margin: 0 2px;
}
.cls-pop__row-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cls-pop__confirm {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--md-on-surface);
  overflow-wrap: anywhere;
}
.cls-pop__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.cls-pop__btn {
  padding: 4px 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  color: var(--md-on-surface);
}
.cls-pop__btn--primary {
  border-color: var(--md-primary, #6200ee);
  background: var(--md-primary, #6200ee);
  color: #ffffff;
}
.cls-pop__btn:hover {
  filter: brightness(0.96);
}
</style>
