<script setup lang="ts">
import { computed } from 'vue'
import { createManualTreeObject, useSceneStore } from '../stores/sceneStore'
import { usePointCloudStore } from '../stores/pointcloudStore'
import type {
  SceneEntity,
  SceneProject,
  SceneTreeGroup,
  ColorMode,
  EntityDisplayTarget,
  LodMode,
  TreeObject,
} from '../stores/sceneStore'
import type { TreePoint } from '../utils/treeMetrics'
import { isTreeClassification } from '../utils/treeMetrics'
import { className, classColorCss } from '../utils/classColors'
import { resolveNormalSelection } from '../stores/normalStore'
import ElevationChart from './ElevationChart.vue'
import {
  fmtAxisCenter,
  fmtAxisDimensionLine,
  fmtFixed,
  fmtGlobalCenter,
  fmtGlobalShift,
  fmtNum,
  fmtShiftedCenter,
  fmtThousands,
} from '../utils/format'

/**
 * 详细信息面板（仿 CloudCompare 的 Properties 表格）。
 * 选中项目显示完整信息；选中点云实体显示 CC Object + Cloud 两个区块
 * （名称/可见性/着色方式/包围盒/点数/平移/点大小等）。
 * 区块标题只作分隔（不重复实体名，嵌套分割后缀会让名字超长，见 Name 行即可）。
 */
const {
  projects,
  selection,
  selectedNode,
  displayTarget,
  toggleProjectShowName,
  toggleEntityVisible,
  toggleTreeGroupVisible,
  setEntityColorMode,
  setEntityPointSize,
  setEntityLodEnabled,
  setEntityShowName,
  setEntityDisplayTarget,
  setEntityTreeObject,
} = useSceneStore()

/** 确定性伪随机 [0,1)：同一种子结果稳定，选中同一项目时数据显示一致。 */
function pseudoRandom(seed: number, salt: number) {
  const x = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** 占位包围盒假数据（待接入点云解析后替换为真实数据）。 */
function fakeBbox(project: SceneProject) {
  const seed = project.id
  const axes = (['X', 'Y', 'Z'] as const).map((name, i) => {
    const min = pseudoRandom(seed, i * 2) * 100 - 50
    const size = 50 + pseudoRandom(seed, i * 2 + 1) * 400
    return { name, min, max: min + size }
  })
  return { axes, center: axes.map((a) => (a.min + a.max) / 2) }
}

const projectBbox = computed(() => (selectedNode.value?.type === 'project' ? fakeBbox(selectedNode.value) : null))

const fmt = (n: number) => n.toFixed(3)

/** 当前选中的实体（仅选中二级点云节点时非 null）。 */
const entity = computed<SceneEntity | null>(() =>
  selectedNode.value?.type === 'pointcloud' ? (selectedNode.value as SceneEntity) : null
)

/** 当前选中的树项容器（仅选中第三级树项节点时非 null）。 */
const treeGroup = computed<SceneTreeGroup | null>(() =>
  selectedNode.value?.type === 'treegroup' ? (selectedNode.value as SceneTreeGroup) : null
)

/** 树项容器下各树实体点数合计（成员实体平铺在项目 entities，跨容器 id 匹配统计）。 */
const treeGroupPoints = computed(() => {
  const g = treeGroup.value
  if (!g) return 0
  const memberIds = new Set(g.entityIds)
  let total = 0
  for (const project of projects) {
    for (const entity of project.entities) {
      if (memberIds.has(entity.id)) total += entity.pointCount
    }
  }
  return total
})

/** 三个轴的包围盒尺寸行：尺寸为原始跨度，min/max 为显示坐标（原始 − 平移）。 */
const dims = computed(() => {
  const e = entity.value
  if (!e?.bbox || !e.globalShift) return null
  const { bbox: b, globalShift: s } = e
  const axes = [
    { name: 'X', min: b.minX, max: b.maxX, shift: s.x },
    { name: 'Y', min: b.minY, max: b.maxY, shift: s.y },
    { name: 'Z', min: b.minZ, max: b.maxZ, shift: s.z },
  ]
  return axes.map((a) => ({
    name: a.name,
    size: a.max - a.min,
    min: a.min - a.shift,
    max: a.max - a.shift,
  }))
})

/** 全局（文件原始坐标）包围盒中心。 */
const globalCenter = computed(() => {
  const b = entity.value?.bbox
  if (!b) return null
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 }
})

/** 显示坐标系包围盒中心（全局中心 − 全局平移）。 */
const shiftedCenter = computed(() => {
  const e = entity.value
  const g = globalCenter.value
  if (!e?.globalShift || !g) return null
  return { x: g.x - e.globalShift.x, y: g.y - e.globalShift.y, z: g.z - e.globalShift.z }
})

/* ---------- Colors / Show name 两行（多选批量） ---------- */

/**
 * 批量行的作用对象：把当前选中集**摊平成实体 id**（多选 / 选中容器 / 选中项目都算），
 * 复用 normalStore 里那唯一一处多选解析——与 Edit ▸ Normals 的 Invert / Delete 同语义。
 * 单选实体时结果恰是它自己，故单实体行为与从前一字不差。
 * Colors 与 Show name 两行**共用这一份**（各写一遍必然漂移）。
 */
const selectionTargetIds = computed(() => resolveNormalSelection(selection.value))

/** 目标实体的元数据（批量的可用性与当前值都要按**全体**算）。 */
const selectionTargets = computed<SceneEntity[]>(() => {
  const byId = new Map<number, SceneEntity>()
  for (const project of projects) {
    for (const e of project.entities) byId.set(e.id, e)
  }
  return selectionTargetIds.value.map((id) => byId.get(id)).filter((e): e is SceneEntity => !!e)
})

/**
 * 批量的当前值：全同 → 该值；不一致 → ''（模板渲染一个 Mixed 占位项）。
 * 选中项可能分属不同项目 / 容器，"统一改成 X"才是批量唯一有意义的语义。
 */
const selectionColorMode = computed(() => {
  const modes = selectionTargets.value.map((e) => e.colorMode)
  if (modes.length === 0) return ''
  return modes.every((m) => m === modes[0]) ? modes[0] : ''
})

/**
 * 选项可用性按**全体取或**：只要有一个带颜色就给 RGB……个别目标不支持所选项时
 * 不是报错而是降级（sceneStore.updateEntityMeta 收口的 resolveColorMode），与单选一致。
 */
const anyHasColor = computed(() => selectionTargets.value.some((e) => e.hasColor))
const anyHasNormals = computed(() => selectionTargets.value.some((e) => e.hasNormals))
const anyHasLabelColor = computed(() => selectionTargets.value.some((e) => e.hasLabelColor))

/**
 * Colors 下拉的选项表（实体分支与容器分支共用同一份——两处各写一遍必然漂移）。
 * 顺序与从前的硬编码选项一致，只是"哪些项在"改由上面三个判据定。
 */
const colorOptions = computed(() => {
  const options: { value: ColorMode | ''; label: string; title?: string }[] = []
  if (selectionColorMode.value === '') options.push({ value: '', label: 'Mixed', title: '选中项的着色方式不一致' })
  options.push({ value: 'none', label: 'None' })
  // 无颜色数据的云（如 LAS 格式 0）不提供 RGB 选项
  if (anyHasColor.value) options.push({ value: 'rgb', label: 'RGB' })
  options.push({ value: 'scalar', label: 'Scalar field' })
  // 法向量着色 = (N+1)/2 静态烘焙（视无关），无法向量时不提供
  if (anyHasNormals.value) options.push({ value: 'normal', label: 'Normal RGB' })
  // 高程着色：按 z 满量程上色，无颜色/无法向量的云同样可用
  options.push({ value: 'elevation', label: 'Elevation' })
  // 分割色：单木分割 / 欧式聚类产物（逐株逐簇纯色，存材质，不动原始 RGB）
  if (anyHasLabelColor.value) options.push({ value: 'label', label: 'Label' })
  return options
})

function onColorModeChange(event: Event) {
  const mode = (event.target as HTMLSelectElement).value as ColorMode | ''
  if (!mode) return // Mixed 占位项只表示"当前不一致"，选它不动作
  for (const id of selectionTargetIds.value) setEntityColorMode(id, mode)
}

/**
 * Show name 的批量当前值：全开 → true、全关 → false、**不一致 → 'mixed'**（模板用 checkbox
 * 的 indeterminate 表示半选）。语义与 Colors 行的 Mixed 占位项一致，只是控件是个勾选框。
 */
const selectionShowName = computed<boolean | 'mixed'>(() => {
  const list = selectionTargets.value
  if (list.length === 0) return false
  const on = list.filter((e) => e.showNameIn3D).length
  return on === list.length ? true : on === 0 ? false : 'mixed'
})

/** 悬停文案：批量的开启计数（"3 / 7 个目标已开"），单目标时就说清它自己。 */
const showNameTitle = computed(() => {
  const total = selectionTargets.value.length
  if (total <= 1) return '在 3D 视图中显示该实体的名称标签'
  const on = selectionTargets.value.filter((e) => e.showNameIn3D).length
  return `在 3D 视图中显示名称标签：${on} / ${total} 个目标已开（多选 / 容器 / 项目选中时对全部生效，半选态点一下 = 全部打开）`
})

/**
 * 批量开关名称标签。半选态点击时浏览器给出的 `checked` 为 **true**（勾选框的既有行为），
 * 于是"半开半关 → 点一下"自然就是**全部打开**，与资源管理器一致；要全关再点一下即可。
 */
function onShowNameChange(checked: boolean) {
  for (const id of selectionTargetIds.value) setEntityShowName(id, checked)
}

function onDisplayTargetChange(event: Event) {
  if (entity.value) {
    setEntityDisplayTarget(entity.value.id, (event.target as HTMLSelectElement).value as EntityDisplayTarget)
  }
}

function onPointSizeChange(event: Event) {
  if (entity.value) {
    setEntityPointSize(entity.value.id, Number((event.target as HTMLSelectElement).value))
  }
}

function onLodEnabledChange(event: Event) {
  if (entity.value) {
    setEntityLodEnabled(entity.value.id, (event.target as HTMLSelectElement).value as LodMode)
  }
}

/* ---------- 分类统计（Classification 区） ---------- */

/**
 * 分类统计入口与失效信号：getClassificationStats 是普通函数（扫描各块分类
 * attribute 计数），classificationRevision 是模块级 ref，setEntityClassification
 * 改写分类后 bump 一次——下面 computed 把它读进依赖，面板即自动刷新。
 */
const { getClassificationStats, classificationRevision } = usePointCloudStore()

/** 选中实体的分类分布（类号升序；未加载/无分类数据时 null/空 → 模板显示 —）。 */
const classificationStats = computed(() => {
  void classificationRevision.value // 依赖：重设分类后本 computed 失效重算
  const e = entity.value
  return e ? getClassificationStats(e.id) : null
})

/* ---------- 树木基础信息（Tree object 区） ---------- */

/**
 * 是不是树：**判据的唯一实现**在 `utils/treeMetrics.isTreeClassification`（可见点分类全部 ∈ {4,5}），
 * 与批量计算的目标筛选同源。这里只吃上面已有的 `classificationStats`，不另开扫描。
 */
const isTree = computed(() => isTreeClassification(classificationStats.value))

/** 选中实体的树木信息（null = 还没算过、也还没手填）。 */
const treeObject = computed(() => entity.value?.treeObject ?? null)

/**
 * **算出来**的那一份：`basePoint !== null` 是"有计算依据"的判据（`finishTree` 只在算过时才给基准点）。
 * 手填的（`createManualTreeObject`）只有三个数字，所以 Crown base / Fit 两行跟着它出现。
 *
 * ⚠ 树心点（`representative`）**不跟它出现**：它是可编辑的，手填的树也得能填（见 Tree center 行）。
 */
const computedTree = computed(() => (treeObject.value?.basePoint ? treeObject.value : null))

/**
 * Fit 行文案：把"胸径这个数可不可信"讲清楚（全部取自 quality，不重算）。
 * ⚠ rms **刻意是 3 位小数**（本面板其余读数一律 2 位）：它是"这个胸径可不可信"的判据本身，
 * 2 位会把 0.004 m 显示成 0.00，读起来像"误差为零"。
 */
const treeFitText = computed(() => {
  const t = computedTree.value
  if (!t) return ''
  const q = t.quality
  const crown = `冠层 ${fmtThousands(q.crownPoints)} 点`
  if (q.dbhMethod === 'circle') {
    return `圆拟合采纳：内点 ${fmtThousands(q.dbhInliers)} / 切片 ${fmtThousands(
      q.dbhSlicePoints
    )} 点，rms ${fmtFixed(q.dbhRms, 3)} m；${crown}`
  }
  if (q.dbhMethod === 'centroid') {
    return `圆拟合被拒（切片 ${fmtThousands(q.dbhSlicePoints)} 点）⇒ 代表点取切片质心、胸径不给数；${crown}`
  }
  return `基准 + ${fmtFixed(t.dbhHeight, 2)} m 处没有点（树太矮或该高度缺数据）⇒ 无胸径；${crown}`
})

/**
 * Note 行文案：区分三种状态——**还没算过** / **算出来的** / **手填的**。
 * （旧实现按 `treeObject !== null` 二分，于是算出来的那棵被写成"手填值"——基准点明明就在下面。）
 * 末句统一指路 3D 标记的开关（这是"我这个圈怎么没了"最可能的原因）。
 */
const treeNoteText = computed(() => {
  if (treeObject.value === null) {
    return '还没算过：可手填上面三行，或用 Trees ▸ Tree info ▸ Compute tree info… 批量计算；3D 标记见 View ▸ Tree markers'
  }
  if (computedTree.value) {
    return '算出来的：树心点可手改（改了 3D 标记与胸径圈一起跟着动）；3D 标记见 View ▸ Tree markers'
  }
  return '手填值（没有基准点 / 代表点 / 拟合质量）——想算这些就跑一次 Trees ▸ Tree info ▸ Compute tree info…；3D 标记见 View ▸ Tree markers'
})

/** 点的显示坐标 title（文件坐标 − 全局平移，2 位小数）；与 Shifted box center 的先例一致。 */
function treePointTitle(p: TreePoint | null): string {
  const s = entity.value?.globalShift
  if (!p || !s) return ''
  return `显示坐标 ${fmtAxisCenter({ x: p.x - s.x, y: p.y - s.y, z: p.z - s.z }, 2)}`
}

/**
 * 手填三个数字（Tree height / Trunk DBH / Crown width）——写的是实体的 Tree object。
 *
 * 实体还没有 treeObject 时先 materialize 一份（`createManualTreeObject`：冠幅 X/Y 取冠幅本身、
 * 其余 0 / null）——手填的没有基准点，故模板里那三行"算出来的读数"不出现。
 * `setEntityTreeObject` 是**整份替换**，所以这里合并后写；非法输入（空串 / 负数 / NaN）不写。
 */
function onTreeNumberChange(field: 'height' | 'dbh' | 'crownWidth', e: Event) {
  const target = entity.value
  if (!target) return
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v) || v < 0) return
  const base = target.treeObject ?? createManualTreeObject()
  const next: TreeObject =
    field === 'height'
      ? { ...base, height: v }
      : field === 'dbh'
        ? { ...base, dbh: v }
        : // 手填只有一个冠幅数：X/Y 分量一起跟上（两者不一致只可能来自实际计算）
          { ...base, crownWidth: v, crownWidthX: v, crownWidthY: v }
  setEntityTreeObject(target.id, next)
}

/**
 * 改**树心点**（Tree center）的一个分量——逐轴写，写入的始终是**文件原始坐标**
 * （面板显示与存储都是它；显示坐标只在 title 里给）。算错了要能改，故三格都可编辑。
 *
 * 点还不存在（没算过 / 算过但切片无点）时 materialize 一个：另外两轴取**基准点**
 * （它就在树干上，比 0 好得多的初值），z 取 `basePoint.z + dbhHeight`（就是那个切片的高度）；
 * 连基准点都没有（手填的树）时三格都得自己填，缺的落 0。
 *
 * 非法输入（空串 / NaN）**不写**——与上面三个数字行同款：清空输入不会把点写坏。
 * 注意 `setEntityTreeObject` 是整份替换，所以这里合并后写。
 */
function onTreePointChange(axis: 'x' | 'y' | 'z', e: Event) {
  const target = entity.value
  if (!target) return
  const v = parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  const base = target.treeObject ?? createManualTreeObject()
  const bp = base.basePoint
  const current: TreePoint = base.representative ?? {
    x: bp ? bp.x : 0,
    y: bp ? bp.y : 0,
    z: bp ? bp.z + base.dbhHeight : 0,
  }
  const next: TreePoint = { x: current.x, y: current.y, z: current.z }
  next[axis] = v
  setEntityTreeObject(target.id, { ...base, representative: next })
}

/* ---------- 法向量读数（Normals 行） ---------- */

/**
 * 与分类统计同一套失效模式：getNormalStats 是普通函数（扫各块 normalCode 计数，
 * 只统计可见点集），normalsRevision 在估计 / 反转 / 清除后 bump。
 */
const { getNormalStats, normalsRevision } = usePointCloudStore()

/** 选中实体的法向量覆盖情况（无法向量 / 未加载时 null → 模板不显示该行）。 */
const normalStats = computed(() => {
  void normalsRevision.value // 依赖：法向量被改写后本 computed 失效重算
  const e = entity.value
  return e ? getNormalStats(e.id) : null
})

/** 读数文案：`N / M 点已算（K 点为空码）`；空码为 0 时不啰嗦。 */
function fmtNormalStats(stats: { total: number; computed: number; nullCount: number } | null): string {
  if (!stats) return '—'
  const base = `${fmtThousands(stats.computed)} / ${fmtThousands(stats.total)} 点已算`
  return stats.nullCount > 0 ? `${base}（${fmtThousands(stats.nullCount)} 点为空码）` : base
}
</script>

<template>
  <div class="properties">
    <div class="panel-title">详细信息</div>

    <div v-if="selectedNode" class="prop-table">
      <div class="prop-row prop-row--header">
        <span>Property</span>
        <span>State/Value</span>
      </div>

      <!-- 选中项目：完整信息 -->
      <template v-if="selectedNode.type === 'project'">
        <div class="prop-row">
          <span>Name</span>
          <span>{{ selectedNode.name }}</span>
        </div>
        <div class="prop-row">
          <span>Show name (in 3D)</span>
          <input
            type="checkbox"
            class="md-checkbox"
            :checked="selectedNode.showNameIn3D"
            @change="toggleProjectShowName(selectedNode.id)"
          />
        </div>
        <div class="prop-row">
          <span>Box dimensions [m]</span>
          <span class="prop-value--multi">
            <span v-for="axis in projectBbox?.axes ?? []" :key="axis.name">
              {{ axis.name }}: {{ fmt(axis.max - axis.min) }} ({{ fmt(axis.min) }} : {{ fmt(axis.max) }})
            </span>
          </span>
        </div>
        <div class="prop-row">
          <span>Box center</span>
          <span class="prop-value--multi">
            <span>
              X: {{ fmt(projectBbox?.center[0] ?? 0) }}&nbsp;&nbsp;Y:
              {{ fmt(projectBbox?.center[1] ?? 0) }}&nbsp;&nbsp;Z:
              {{ fmt(projectBbox?.center[2] ?? 0) }}
            </span>
          </span>
        </div>
        <div class="prop-row">
          <span>Info</span>
          <span>Object ID: {{ selectedNode.id }} - Children: {{ selectedNode.entities.length }}</span>
        </div>
        <div class="prop-row">
          <span>Current Display</span>
          <select v-model="displayTarget" class="prop-select">
            <option value="None">None</option>
            <option value="3D View 1">3D View 1</option>
          </select>
        </div>
      </template>

      <!-- 选中容器节点（分割产物组：TreeIso 的树项 / 欧式聚类的聚类容器）：组概览，逐项属性见其下实体 -->
      <template v-else-if="treeGroup">
        <div class="prop-section-title">Group</div>
        <div class="prop-row">
          <span>Name</span>
          <span>{{ treeGroup.name }}</span>
        </div>
        <div class="prop-row">
          <span>Visible</span>
          <input
            type="checkbox"
            class="md-checkbox"
            :checked="treeGroup.visible"
            title="显示/隐藏整个容器（级联其下全部实体）"
            @change="toggleTreeGroupVisible(treeGroup.id)"
          />
        </div>
        <div class="prop-row">
          <span>Info</span>
          <span>Object ID: {{ treeGroup.id }} - Items: {{ treeGroup.entityIds.length }}</span>
        </div>
        <div class="prop-row">
          <span>Points</span>
          <span>{{ fmtThousands(treeGroupPoints) }}</span>
        </div>
        <div class="prop-row">
          <span>Show name (in 3D)</span>
          <!-- 与 Colors 行同款批量入口：选容器即对组内全部项开关名称标签 -->
          <input
            type="checkbox"
            class="md-checkbox"
            :checked="selectionShowName === true"
            :indeterminate="selectionShowName === 'mixed'"
            :title="showNameTitle"
            @change="onShowNameChange(($event.target as HTMLInputElement).checked)"
          />
        </div>
        <div class="prop-row">
          <span>Colors</span>
          <!-- 与实体分支同一份 colorOptions / onColorModeChange：选容器即对组内全部项批量切换 -->
          <select
            class="prop-select"
            :value="selectionColorMode"
            title="着色方式（对容器内全部项生效）"
            @change="onColorModeChange"
          >
            <option
              v-for="o in colorOptions"
              :key="o.value"
              :value="o.value"
              :disabled="o.value === ''"
              :title="o.title"
            >
              {{ o.label }}
            </option>
          </select>
        </div>
        <div class="prop-row">
          <span>Note</span>
          <span>容器内每项都是独立点云实体（单木分割的单株 / 欧式聚类的单个聚类）；选中单项可查看其属性</span>
        </div>
      </template>

      <!-- 选中实体：仿 CloudCompare 属性面板（CC Object + Cloud 两个区块） -->
      <template v-else-if="entity">
        <div class="prop-section-title">CC Object</div>

        <div class="prop-row">
          <span>Name</span>
          <span>{{ entity.name }}</span>
        </div>
        <div class="prop-row">
          <span>Visible</span>
          <input
            type="checkbox"
            class="md-checkbox"
            :checked="entity.visible"
            title="显示/隐藏点云（与 DB Tree 勾选框一致）"
            @change="toggleEntityVisible(entity.id)"
          />
        </div>
        <!-- 多选时的目标计数：Colors / Show name 两行作用在**选中集摊平后的全部实体**上
             （容器 / 项目选中同理） -->
        <div v-if="selectionTargets.length > 1" class="prop-row">
          <span>Selected</span>
          <span>{{ selectionTargets.length }} entities（Colors / Show name 对全部生效）</span>
        </div>
        <div class="prop-row">
          <span>Colors</span>
          <!-- 多选时全同显值、不一致显 Mixed；改一次 = 逐个应用（见 onColorModeChange） -->
          <select
            class="prop-select"
            :value="selectionColorMode"
            title="着色方式（多选 / 容器 / 项目选中时对全部目标生效）"
            @change="onColorModeChange"
          >
            <option
              v-for="o in colorOptions"
              :key="o.value"
              :value="o.value"
              :disabled="o.value === ''"
              :title="o.title"
            >
              {{ o.label }}
            </option>
          </select>
        </div>
        <!-- 高程分布图：仅高程着色时挂载（直方图是 O(N) 扫描，不开就不花这次钱）。
             两端手柄改的是色带上下限，不是裁剪点云 -->
        <ElevationChart v-if="entity.colorMode === 'elevation'" :entity-id="entity.id" />
        <div v-if="entity.hasNormals" class="prop-row">
          <span>Normals</span>
          <span>{{ fmtNormalStats(normalStats) }}</span>
        </div>
        <div class="prop-row">
          <span>Show name (in 3D)</span>
          <!-- 批量入口（同 Colors 行）：多选 / 选中容器 / 选中项目时对全部目标生效；
               目标之间不一致时呈半选态，点一下 = 全部打开（见 onShowNameChange） -->
          <input
            type="checkbox"
            class="md-checkbox"
            :checked="selectionShowName === true"
            :indeterminate="selectionShowName === 'mixed'"
            :title="showNameTitle"
            @change="onShowNameChange(($event.target as HTMLInputElement).checked)"
          />
        </div>
        <div class="prop-row">
          <span>Box dimensions</span>
          <span v-if="dims" class="prop-value--multi">
            <span v-for="d in dims" :key="d.name">{{ fmtAxisDimensionLine(d.name, d.size, d.min, d.max) }}</span>
          </span>
          <span v-else>—</span>
        </div>
        <div class="prop-row">
          <span>Shifted box center</span>
          <span class="prop-value--multi">
            <span>{{ shiftedCenter ? fmtShiftedCenter(shiftedCenter) : '—' }}</span>
          </span>
        </div>
        <div class="prop-row">
          <span>Global box center</span>
          <span class="prop-value--multi">
            <span>{{ globalCenter ? fmtGlobalCenter(globalCenter) : '—' }}</span>
          </span>
        </div>
        <div class="prop-row">
          <span>Info</span>
          <span>Object ID: {{ entity.id }} - Children: 0</span>
        </div>
        <!-- 物体编号（SceneEntity.labelNo）：Tree / Cluster 的显示编号，名字与区分色都由它定，
             导出时逐点写进 treeid / LAS Point Source ID。普通点云（含 .noise / .remaining /
             滤波产物）不带编号，故整行隐藏。与 Object ID 的区别见 sceneStore.SceneEntity.labelNo -->
        <div v-if="entity.labelNo !== null" class="prop-row">
          <span>Tree ID</span>
          <span :title="`物体编号 ${entity.labelNo}：名字 Tree/Cluster <编号> 与区分色都由它定，导出时逐点写进 treeid`">
            {{ entity.labelNo }}
          </span>
        </div>
        <div class="prop-row">
          <span>Current Display</span>
          <select class="prop-select" :value="entity.displayTarget" @change="onDisplayTargetChange">
            <option value="None">None</option>
            <option value="3D View 1">3D View 1</option>
          </select>
        </div>

        <div class="prop-section-title">Cloud</div>

        <div class="prop-row">
          <span>Points</span>
          <span>{{ fmtThousands(entity.pointCount) }}</span>
        </div>
        <div class="prop-row">
          <span>Classification</span>
          <!-- 升序完整列表：色块与 scalar 着色同源；条目多时区域内滚动 -->
          <div v-if="classificationStats && classificationStats.length" class="cls-list">
            <div v-for="s in classificationStats" :key="s.value" class="cls-list__row">
              <span class="cls-list__chip" :style="{ background: classColorCss(s.value) }"></span>
              <span class="cls-list__name">{{ className(s.value) }}</span>
              <span class="cls-list__count">{{ fmtThousands(s.count) }}</span>
            </div>
          </div>
          <span v-else>—</span>
        </div>
        <div class="prop-row">
          <span>Global shift</span>
          <span>{{ entity.globalShift ? fmtGlobalShift(entity.globalShift) : '—' }}</span>
        </div>
        <div class="prop-row">
          <span>Global scale</span>
          <span>{{ fmtFixed(entity.globalScale, 6) }}</span>
        </div>
        <div class="prop-row">
          <span>Point size</span>
          <select class="prop-select" :value="entity.pointSize" @change="onPointSizeChange">
            <option v-for="n in 16" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <div class="prop-row">
          <span>Enable LoD</span>
          <!-- 对齐 CloudCompare 每片点云的同名勾选框：Auto 按规模判据，
               Never 回到逐块直绘（排查"画面少了点"这类问题时的开关） -->
          <select
            class="prop-select"
            :value="entity.lodEnabled"
            title="Auto：按规模自动启用流式 LOD；Always：强制启用；Never：强制逐块直绘（排查渲染问题用）"
            @change="onLodEnabledChange"
          >
            <option value="auto">Auto</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>

        <!-- Tree object（树木基础信息）：出现的判据是**分类值**（isTreeClassification，与批量计算同源）。
             treeObject === null = "还没算过 / 还没填" ⇒ 输入框留空 + 占位 `—`（**不显示 0.00**：
             "没算过"与"算出来是 0"是两种状态，显示成一样的会误导）。
             读数一律 **2 位小数**（`fmtNum`；存储仍是全精度，只有显示被舍入）。
             三个数字 + 树心点都可手填（写实体的 Tree object）；Crown base / Fit 只在**真算过**
             （有基准点）时出现——手填值没有那些依据。
             ⚠ 基准点（Base point）**刻意不显示**：它是算树高/胸径的起算点，属于内部依据；
             用户看的、能改的是"树心点"（Tree center = 代表点，文件原始坐标）。 -->
        <template v-if="isTree">
          <div class="prop-section-title">Tree object (class 4/5)</div>
          <div class="prop-row">
            <span>Tree height [m]</span>
            <input
              class="prop-input"
              type="number"
              min="0"
              step="any"
              placeholder="—"
              :value="fmtNum(treeObject?.height)"
              title="树高：最高点 − 基准高程。可手填；批量计算见 Trees ▸ Tree info"
              @change="onTreeNumberChange('height', $event)"
            />
          </div>
          <div class="prop-row">
            <span>Trunk DBH [cm]</span>
            <input
              class="prop-input"
              type="number"
              min="0"
              step="any"
              placeholder="—"
              :value="fmtNum(treeObject?.dbh)"
              title="胸径（厘米）：默认在基准点往上 1.3 m 的切片上做稳健圆拟合；拟合不可信时不给数（见 Fit 行）"
              @change="onTreeNumberChange('dbh', $event)"
            />
          </div>
          <div class="prop-row">
            <span>Crown width [m]</span>
            <input
              class="prop-input"
              type="number"
              min="0"
              step="any"
              placeholder="—"
              :value="fmtNum(treeObject?.crownWidth)"
              title="冠幅：冠层点 X / Y 跨度取大者（手填时两个分量一起写成同一个值）"
              @change="onTreeNumberChange('crownWidth', $event)"
            />
          </div>
          <!-- 树心点（Tree center）= 代表点：胸径圆心 / 树干位置。三格都可改——算错了要能改；
               改它 3D 标记里的树心点与胸径圈一起跟着动（见 utils/treeMarkers）。
               title 给的是**显示坐标**（面板显示与存储的都是文件原始坐标）。 -->
          <div class="prop-row">
            <span>Tree center</span>
            <span class="prop-vector" :title="treePointTitle(treeObject?.representative ?? null)">
              <input
                class="prop-input"
                type="number"
                step="any"
                placeholder="—"
                :value="fmtNum(treeObject?.representative?.x)"
                title="X（文件原始坐标）"
                @change="onTreePointChange('x', $event)"
              />
              <input
                class="prop-input"
                type="number"
                step="any"
                placeholder="—"
                :value="fmtNum(treeObject?.representative?.y)"
                title="Y（文件原始坐标）"
                @change="onTreePointChange('y', $event)"
              />
              <input
                class="prop-input"
                type="number"
                step="any"
                placeholder="—"
                :value="fmtNum(treeObject?.representative?.z)"
                title="Z（文件原始坐标）"
                @change="onTreePointChange('z', $event)"
              />
            </span>
          </div>
          <template v-if="computedTree">
            <div class="prop-row">
              <span>Crown base [m]</span>
              <span title="冠层底高：基准点到冠层下沿的高度（= (1 − 冠层比例) × 树高）">
                {{ fmtFixed(computedTree.crownBaseHeight, 2) }}
              </span>
            </div>
            <div class="prop-row">
              <span>Fit</span>
              <span>{{ treeFitText }}</span>
            </div>
          </template>
          <div class="prop-row">
            <span>Note</span>
            <span>{{ treeNoteText }}</span>
          </div>
        </template>
      </template>
    </div>

    <p v-else class="properties__empty">未选择对象</p>
  </div>
</template>

<style scoped>
.properties {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}
.prop-table {
  display: flex;
  flex-direction: column;
  font-size: 12px;
}
.prop-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  color: var(--md-on-surface);
  overflow-wrap: anywhere;
}
.prop-row > span:first-child {
  color: var(--md-on-surface-variant);
}
.prop-row--header {
  font-weight: 600;
  color: var(--md-on-surface);
  background: rgba(0, 0, 0, 0.03);
}
.prop-section-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--md-on-surface-variant);
  background: rgba(0, 0, 0, 0.03);
  padding: 6px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
.prop-value--multi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: monospace;
  font-size: 11px;
}
.prop-select {
  font-family: inherit;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  background: var(--md-surface-container-lowest);
  color: var(--md-on-surface);
}
.prop-select:focus {
  outline: none;
  border-color: var(--md-primary);
}
/* 可手填的数字输入（Tree object 三行）：与 .prop-select 同一套观感，铺满列宽 */
.prop-input {
  width: 100%;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  background: var(--md-surface-container-lowest);
  color: var(--md-on-surface);
  font-variant-numeric: tabular-nums;
}
/* 三个分量并排的输入行（Tree center 的 x/y/z）：等宽三格，间距比行距小一点 */
.prop-vector {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.prop-input:focus {
  outline: none;
  border-color: var(--md-primary);
}
.prop-input::placeholder {
  color: var(--md-on-surface-variant);
}
.properties__empty {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  opacity: 0.6;
}
.cls-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 140px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 11px;
}
.cls-list__row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
}
.cls-list__chip {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  /* 白/浅色块（0 未定义点等）在浅底上需描边才看得见 */
  border: 1px solid rgba(0, 0, 0, 0.25);
}
.cls-list__name {
  color: var(--md-on-surface);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cls-list__count {
  color: var(--md-on-surface-variant);
  font-variant-numeric: tabular-nums;
}
</style>
