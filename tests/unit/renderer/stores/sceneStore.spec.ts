import { describe, it, expect } from 'vitest'
import { createManualTreeObject, useSceneStore } from '../../../../src/renderer/stores/sceneStore'
import type { SceneSelection } from '../../../../src/renderer/stores/sceneStore'

// sceneStore 是模块级单例（reactive），项目在文件内累加；
// 断言全部基于各用例自己创建并捕获的实体，互不影响。
describe('sceneStore（场景树）', () => {
  it('addProjectFromPath 返回实体且新字段默认值正确', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/855.las')
    expect(entity.type).toBe('pointcloud')
    expect(entity.name).toBe('855.las')
    expect(entity.visible).toBe(true)
    expect(entity.pointCount).toBe(0)
    expect(entity.hasColor).toBe(false)
    expect(entity.bbox).toBeNull()
    expect(entity.globalShift).toBeNull()
    expect(entity.globalScale).toBe(1)
    expect(entity.colorMode).toBe('rgb')
    expect(entity.pointSize).toBe(1) // 默认 1px（CC 式像素点，最细一档）
    expect(entity.showNameIn3D).toBe(false)
    expect(entity.displayTarget).toBe('3D View 1')
    expect(entity.treeObject).toBeNull() // 非分割产物无树木属性
    // 项目节点下挂同一实体（reactive 代理与原始对象引用不同，按 id 断言）
    const projects = store.projects
    expect(projects[projects.length - 1].entities.map((e) => e.id)).toContain(entity.id)
    // 新项目默认无树项容器
    expect(projects[projects.length - 1].treeGroups).toEqual([])
  })

  it('updateEntityMeta 回填元数据；hasColor=false 时强制 colorMode 为 none', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/no-rgb.las')
    expect(entity.colorMode).toBe('rgb')
    store.updateEntityMeta(entity.id, {
      pointCount: 100,
      hasColor: false,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
      globalShift: { x: 1, y: 2, z: 3 },
    })
    expect(entity.pointCount).toBe(100)
    expect(entity.hasColor).toBe(false)
    expect(entity.bbox).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 })
    expect(entity.globalShift).toEqual({ x: 1, y: 2, z: 3 })
    expect(entity.colorMode).toBe('none')
  })

  it('updateEntityMeta hasColor=true 时保留 rgb', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/rgb.las')
    store.updateEntityMeta(entity.id, {
      pointCount: 5,
      hasColor: true,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      globalShift: { x: 0, y: 0, z: 0 },
    })
    expect(entity.colorMode).toBe('rgb')
  })

  // 第六个 ColorMode 取值 'label'（分割色：单木分割 / 欧式聚类产物，颜色存在材质上而
  // 不是顶点缓冲里）+ 它在元数据变化时的降级链（label → rgb → none，规则见
  // utils/colorMode.ts）。分割产物与 .noise / 合并产物正是靠这条链各自显示对的颜色。
  it("ColorMode 'label' 可写入；hasLabelColor 仍在时不被任何 updateEntityMeta 冲掉", () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/Tree 1.ply')
    const meta = {
      pointCount: 20,
      hasColor: true,
      hasNormals: false,
      hasLabelColor: true,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      globalShift: { x: 0, y: 0, z: 0 },
    }
    store.updateEntityMeta(entity.id, meta)
    store.setEntityColorMode(entity.id, 'label')
    expect(entity.colorMode).toBe('label')
    // 回落一次元数据（配准烘焙 / 法向量写入 / 再次 setEntityLabelColor 都会走这条路）——
    // 分割色还在就不该被压走，否则每次改点小事都要重新点一遍 Label
    store.updateEntityMeta(entity.id, meta)
    expect(entity.colorMode).toBe('label')
  })

  it('分割色丢失（`.noise` / `.remaining` / 普通云）→ 退回 rgb 而不是 none：产物仍要真彩色', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/Tree 2.ply')
    const base = {
      pointCount: 20,
      hasColor: true,
      hasNormals: false,
      hasLabelColor: true,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      globalShift: { x: 0, y: 0, z: 0 },
    }
    store.updateEntityMeta(entity.id, base)
    store.setEntityColorMode(entity.id, 'label')
    store.updateEntityMeta(entity.id, { ...base, hasLabelColor: false })
    expect(entity.colorMode).toBe('rgb')
  })

  it('降级链走满两跳：label 意图 + 无分割色 + 无颜色 → none', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/Tree 3.las')
    store.updateEntityMeta(entity.id, {
      pointCount: 20,
      hasColor: false,
      hasNormals: false,
      hasLabelColor: false,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      globalShift: { x: 0, y: 0, z: 0 },
    })
    store.setEntityColorMode(entity.id, 'label') // 意图（UI 写入不做校验，降级在消费侧）
    store.updateEntityMeta(entity.id, {
      pointCount: 20,
      hasColor: false,
      hasNormals: false,
      hasLabelColor: false,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      globalShift: { x: 0, y: 0, z: 0 },
    })
    expect(entity.colorMode).toBe('none')
  })

  it('setEntityPointSize 钳制 1-16', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/ps.las')
    store.setEntityPointSize(entity.id, 20)
    expect(entity.pointSize).toBe(16)
    store.setEntityPointSize(entity.id, 0)
    expect(entity.pointSize).toBe(1) // 钳制下限仍是 1px
  })

  it('elevationRange 默认 null；setEntityElevationRange 写值 / 置 null，且不与入参共享引用', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/elev.las')
    expect(entity.elevationRange).toBeNull() // 默认满量程（= 正常的 Z 最高最低着色）

    store.setEntityColorMode(entity.id, 'elevation') // 第五个 ColorMode 取值可写入
    expect(entity.colorMode).toBe('elevation')

    const first = { min: -1.5, max: 12.25 }
    store.setEntityElevationRange(entity.id, first)
    expect(entity.elevationRange).toEqual(first)
    // **新对象**：入参对象若被直接存下，调用方之后改它就会静默改掉色带（拖拽路径每帧传新对象）
    expect(entity.elevationRange).not.toBe(first)

    const second = { min: 0, max: 3 }
    store.setEntityElevationRange(entity.id, second)
    expect(entity.elevationRange).toEqual(second)
    // 前一对象不被原地改写：兄弟实体（分割产物）可能正共享它
    expect(first).toEqual({ min: -1.5, max: 12.25 })

    store.setEntityElevationRange(entity.id, null)
    expect(entity.elevationRange).toBeNull()
  })

  it('setEntityElevationRange 对不存在的 id 静默忽略', () => {
    expect(() => useSceneStore().setEntityElevationRange(-12345, { min: 0, max: 1 })).not.toThrow()
  })

  it('updateEntityMeta 不压高程着色（它不依赖 hasColor / hasNormals）', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/elev-plain.las')
    store.setEntityColorMode(entity.id, 'elevation')
    // 无色、无法向量的云（如 LAS 点格式 0）照样能按高程着色：压档只认 rgb / normal
    store.updateEntityMeta(entity.id, {
      pointCount: 3,
      hasColor: false,
      hasNormals: false,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      globalShift: { x: 0, y: 0, z: 0 },
    })
    expect(entity.colorMode).toBe('elevation')
  })

  // Show name 是**显式值**写入而不是切换：属性面板的该行是多选批量入口，半选态点一下要
  // "全部打开"，切换语义做不到（见 sceneStore.setEntityShowName / PropertiesPanel.onShowNameChange）
  it('setEntityShowName / setEntityDisplayTarget / setEntityColorMode', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/t.las')
    store.setEntityShowName(entity.id, true)
    expect(entity.showNameIn3D).toBe(true)
    store.setEntityShowName(entity.id, true) // 幂等：已是 true 再写 true 不该翻转
    expect(entity.showNameIn3D).toBe(true)
    store.setEntityShowName(entity.id, false)
    expect(entity.showNameIn3D).toBe(false)
    store.setEntityDisplayTarget(entity.id, 'None')
    expect(entity.displayTarget).toBe('None')
    store.setEntityColorMode(entity.id, 'scalar')
    expect(entity.colorMode).toBe('scalar')
    expect(() => store.setEntityShowName(999999, true)).not.toThrow()
  })

  it('toggleEntityVisible 切换实体可见性', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/v.las')
    expect(entity.visible).toBe(true)
    store.toggleEntityVisible(entity.id)
    expect(entity.visible).toBe(false)
  })

  it('removeEntityFromProject 移除实体，选中它时同步取消选中', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/rm.las')
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === entity.id))!.id
    store.selectNode({ type: 'entity', id: entity.id })
    store.removeEntityFromProject(entity.id)
    const project = store.projects.find((p) => p.id === projectId)!
    expect(project.entities.some((e) => e.id === entity.id)).toBe(false)
    // 项目节点保留（可能为空）
    expect(project.entities.length).toBe(0)
    expect(store.selected.value).toBeNull()
  })

  it('addEntityToProject 追加实体并支持 partial 覆盖；元数据可 updateEntityMeta 回填', () => {
    const store = useSceneStore()
    const orig = store.addProjectFromPath('E:/点云/orig.las')
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === orig.id))!.id
    const split = store.addEntityToProject(projectId, {
      name: 'orig.las.segmented',
      path: orig.path,
      visible: false,
      pointSize: 3,
      colorMode: 'scalar',
    })
    expect(split.name).toBe('orig.las.segmented')
    expect(split.path).toBe(orig.path)
    expect(split.visible).toBe(false)
    expect(split.pointSize).toBe(3)
    expect(split.colorMode).toBe('scalar')
    // 未指定的默认值
    expect(split.hasColor).toBe(false)
    expect(split.bbox).toBeNull()
    expect(split.showNameIn3D).toBe(false)
    expect(split.displayTarget).toBe('3D View 1')
    // 已挂入项目，且可回填元数据
    const project = store.projects.find((p) => p.id === projectId)!
    expect(project.entities.map((e) => e.id)).toContain(split.id)
    store.updateEntityMeta(split.id, {
      pointCount: 42,
      hasColor: true,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
      globalShift: { x: 0, y: 0, z: 0 },
    })
    expect(split.pointCount).toBe(42)
    expect(split.bbox).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 })
  })
})

describe('sceneStore（多选）', () => {
  it('selectNode 单选：整体替换选中集合，旧单选语义保持', () => {
    const store = useSceneStore()
    store.selectNode(null)
    const a = store.addProjectFromPath('E:/点云/a.las')
    const b = store.addProjectFromPath('E:/点云/b.las')
    store.selectNode({ type: 'entity', id: a.id })
    expect(store.selection.value).toHaveLength(1)
    expect(store.selected.value).toEqual({ type: 'entity', id: a.id })
    // 再次单选另一项 = 整体替换（不是追加）
    store.selectNode({ type: 'entity', id: b.id })
    expect(store.selection.value.map((s) => s.id)).toEqual([b.id])
    expect(store.selected.value).toEqual({ type: 'entity', id: b.id })
  })

  it('toggleSelectNode 追加/移除并保持点击顺序；锚点 = 末项，删除锚点后回退', () => {
    const store = useSceneStore()
    store.selectNode(null)
    const a = store.addProjectFromPath('E:/点云/a.las')
    const b = store.addProjectFromPath('E:/点云/b.las')
    const c = store.addProjectFromPath('E:/点云/c.las')
    store.toggleSelectNode({ type: 'entity', id: a.id })
    store.toggleSelectNode({ type: 'entity', id: b.id })
    store.toggleSelectNode({ type: 'entity', id: c.id })
    expect(store.selection.value.map((s) => s.id)).toEqual([a.id, b.id, c.id])
    expect(store.selected.value).toEqual({ type: 'entity', id: c.id })
    // 移除中间项：顺序保持，锚点不变
    store.toggleSelectNode({ type: 'entity', id: b.id })
    expect(store.selection.value.map((s) => s.id)).toEqual([a.id, c.id])
    expect(store.selected.value).toEqual({ type: 'entity', id: c.id })
    // 移除锚点：回退到剩余末项
    store.toggleSelectNode({ type: 'entity', id: c.id })
    expect(store.selection.value.map((s) => s.id)).toEqual([a.id])
    expect(store.selected.value).toEqual({ type: 'entity', id: a.id })
    // 移除最后一项：selected 为 null
    store.toggleSelectNode({ type: 'entity', id: a.id })
    expect(store.selection.value).toHaveLength(0)
    expect(store.selected.value).toBeNull()
  })

  it('多选可混合项目与实体节点；selectedNode 解析锚点', () => {
    const store = useSceneStore()
    store.selectNode(null)
    const entity = store.addProjectFromPath('E:/点云/mix.las')
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === entity.id))!.id
    store.toggleSelectNode({ type: 'entity', id: entity.id })
    store.toggleSelectNode({ type: 'project', id: projectId })
    // 点击顺序保持；锚点 = 项目节点，selectedNode 反查得到项目对象
    expect(store.selection.value).toEqual([
      { type: 'entity', id: entity.id },
      { type: 'project', id: projectId },
    ])
    expect(store.selectedNode.value?.type).toBe('project')
    // 移除项目节点 → 锚点回退到实体
    store.toggleSelectNode({ type: 'project', id: projectId })
    const anchor = store.selectedNode.value
    expect(anchor?.type).toBe('pointcloud')
    expect(anchor?.id).toBe(entity.id)
  })

  it('removeEntityFromProject 同步剔除多选成员并回退锚点', () => {
    const store = useSceneStore()
    store.selectNode(null)
    const a = store.addProjectFromPath('E:/点云/a.las')
    const b = store.addProjectFromPath('E:/点云/b.las')
    const aProjectId = store.projects.find((p) => p.entities.some((e) => e.id === a.id))!.id
    store.toggleSelectNode({ type: 'entity', id: a.id })
    store.toggleSelectNode({ type: 'entity', id: b.id })
    // 移除锚点 b：集合剩 a，锚点回退 a
    store.removeEntityFromProject(b.id)
    expect(store.selection.value.map((s) => s.id)).toEqual([a.id])
    expect(store.selected.value).toEqual({ type: 'entity', id: a.id })
    // 移除 a：集合清空，selected 为 null
    store.removeEntityFromProject(a.id)
    expect(store.selection.value).toHaveLength(0)
    expect(store.selected.value).toBeNull()
    // 项目节点保留（可能为空）
    expect(store.projects.find((p) => p.id === aProjectId)!.entities).toHaveLength(0)
  })
})

// Shift 连选（SceneTree 的 Shift + 点击）：范围 = 可见行序上「锚点 → 本行」那一段。
// 锚点是**最后一次无 Shift 的点选**，Shift 点击本身不移动它。
describe('sceneStore（Shift 连选：flattenVisibleRows / selectRange）', () => {
  /**
   * 建「项目 P + 直接实体 d1（源）/ d2 + 容器 G（成员 m1 / m2）」的场景。
   * 可见行序（无折叠时）应为 P → d1 → d2 → G → m1 → m2——即 SceneTree.vue 的渲染顺序。
   *
   * `rows()` 只取**本项目那一段**（走到下一个项目行为止）：sceneStore 是模块级单例，
   * 本文件里先前的用例已经建了一堆项目，全量断言会随用例顺序漂移。
   */
  function setup(name: string) {
    const store = useSceneStore()
    const d1 = store.addProjectFromPath(`E:/点云/${name}.las`)
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === d1.id))!.id
    const d2 = store.addEntityToProject(projectId, { name: 'd2', path: d1.path })
    const group = store.createTreeItemGroup(projectId, `${name} 树项`)!
    const m1 = store.addEntityToGroup(group.id, { name: 'm1', path: d1.path })!
    const m2 = store.addEntityToGroup(group.id, { name: 'm2', path: d1.path })!
    // id 全局单调且项目/容器/实体共用一个计数器 ⇒ id 到标签的映射无歧义
    const names = new Map<number, string>([
      [projectId, 'P'],
      [d1.id, 'd1'],
      [d2.id, 'd2'],
      [group.id, 'G'],
      [m1.id, 'm1'],
      [m2.id, 'm2'],
    ])
    const rows = (): SceneSelection[] => {
      const all = store.flattenVisibleRows()
      const at = all.findIndex((r) => r.type === 'project' && r.id === projectId)
      const out: SceneSelection[] = []
      for (let i = at; i < all.length; i++) {
        if (i > at && all[i].type === 'project') break
        out.push(all[i])
      }
      return out
    }
    const label = (sel: SceneSelection) => names.get(sel.id) ?? `?${sel.id}`
    const picked = () => store.selection.value.map((s) => label(s))
    return { store, projectId, d1, d2, group, m1, m2, rows, label, picked }
  }

  it('flattenVisibleRows：项目 → 直接实体 → 容器 → 容器成员；折叠的行不进列表', () => {
    const { store, projectId, group, rows, label } = setup('rows')
    expect(rows().map(label)).toEqual(['P', 'd1', 'd2', 'G', 'm1', 'm2'])
    // 容器折叠：成员行消失，容器行仍在
    store.toggleTreeGroup(group.id)
    expect(rows().map(label)).toEqual(['P', 'd1', 'd2', 'G'])
    store.toggleTreeGroup(group.id)
    // 项目折叠：其下全部行消失，项目行仍在
    store.toggleProject(projectId)
    expect(rows().map(label)).toEqual(['P'])
  })

  it('flattenVisibleRows：悬空成员 id（项目 entities 里已不存在）不占行', () => {
    const { group, rows, label } = setup('rows-dangling')
    // 正常路径（removeEntityFromProject）会同步清 entityIds，这里刻意绕过它，钉住防御分支
    group.entityIds.push(999999)
    expect(rows().map(label)).toEqual(['P', 'd1', 'd2', 'G', 'm1', 'm2'])
    // 断言完即刻还原：后面还有用例拿 999999 当"肯定不存在的 id"哨兵，
    // 而 store 是模块级单例（不还原会让那些用例反查到本容器）
    group.entityIds.pop()
    expect(rows().map(label)).toEqual(['P', 'd1', 'd2', 'G', 'm1', 'm2'])
  })

  it('selectRange：锚点 → 目标整段（含两端），可跨容器行 / 含项目行', () => {
    const { store, projectId, group, m1, picked } = setup('range-fwd')
    // 容器行 与 容器成员行 同在一段里（Shift 圈的是"看得见的行"，不挑类型）
    store.selectNode({ type: 'entity', id: m1.id })
    store.selectRange({ type: 'treegroup', id: group.id })
    // 向上连选 ⇒ 倒序：末项恒为刚点的那一行（属性面板 / 各算法锚点看的就是它）
    expect(picked()).toEqual(['m1', 'G'])
    expect(store.selected.value).toEqual({ type: 'treegroup', id: group.id })
    // 从项目行到容器行：整段包含直接实体行
    store.selectNode({ type: 'project', id: projectId })
    store.selectRange({ type: 'treegroup', id: group.id })
    expect(picked()).toEqual(['P', 'd1', 'd2', 'G'])
  })

  it('Shift 点击不移动锚点：再 Shift 一次是从原锚点重新圈定（末端可往回改）', () => {
    const { store, d1, d2, m2, picked } = setup('range-anchor')
    store.selectNode({ type: 'entity', id: d1.id })
    store.selectRange({ type: 'entity', id: m2.id })
    expect(picked()).toEqual(['d1', 'd2', 'G', 'm1', 'm2'])
    // 末端往回收：不必先取消再从头点一遍（锚点仍是 d1）
    store.selectRange({ type: 'entity', id: d2.id })
    expect(picked()).toEqual(['d1', 'd2'])
    // 向上连选：同一段，但首项 = 锚点、末项 = 刚点的 d2（倒序）
    store.selectNode({ type: 'entity', id: m2.id })
    store.selectRange({ type: 'entity', id: d2.id })
    expect(picked()).toEqual(['m2', 'm1', 'G', 'd2'])
    expect(store.selected.value).toEqual({ type: 'entity', id: d2.id })
  })

  it('Ctrl 加选会移动锚点；锚点 == 目标只选中它自己', () => {
    const { store, d1, d2, m2, picked } = setup('range-ctrl')
    store.selectNode({ type: 'entity', id: d1.id })
    store.toggleSelectNode({ type: 'entity', id: m2.id }) // 锚点跟到最后点的那一项
    store.selectRange({ type: 'entity', id: d2.id })
    expect(picked()).toEqual(['m2', 'm1', 'G', 'd2'])
    store.selectNode({ type: 'entity', id: d2.id })
    store.selectRange({ type: 'entity', id: d2.id })
    expect(picked()).toEqual(['d2'])
  })

  it('锚点不可见（容器被折叠 / 锚点已被删）⇒ 退化为单选目标', () => {
    const { store, d1, d2, group, m1, picked } = setup('range-stale')
    store.selectNode({ type: 'entity', id: m1.id })
    store.toggleTreeGroup(group.id) // m1 那行不在屏幕上了
    store.selectRange({ type: 'entity', id: d1.id })
    expect(picked()).toEqual(['d1'])
    store.toggleTreeGroup(group.id)
    // 锚点被删（removeEntityFromProject 会剔除选中项，留下一个失效锚点）：
    // id 永不复用，故它不会指向别的节点，selectRange 找不到就退化为单选
    store.selectNode({ type: 'entity', id: d2.id })
    store.removeEntityFromProject(d2.id)
    store.selectRange({ type: 'entity', id: d1.id })
    expect(picked()).toEqual(['d1'])
  })

  it('selectNode(null) 清空后 Shift 点击 = 单选（无锚点）', () => {
    const { store, d1, picked } = setup('range-noanchor')
    store.selectNode(null)
    store.selectRange({ type: 'entity', id: d1.id })
    expect(picked()).toEqual(['d1'])
    expect(store.selected.value).toEqual({ type: 'entity', id: d1.id })
  })
})

describe('sceneStore（重命名，仅显示名）', () => {
  it('renameEntity 只改实体显示名：path 与其他实体不受影响', () => {
    const store = useSceneStore()
    const a = store.addProjectFromPath('E:/点云/a.las')
    const b = store.addProjectFromPath('E:/点云/b.las')
    const aProject = store.projects.find((p) => p.entities.some((e) => e.id === a.id))!
    const projectNameBefore = aProject.name
    store.renameEntity(a.id, '改名后的云')
    expect(a.name).toBe('改名后的云')
    expect(a.path).toBe('E:/点云/a.las') // 磁盘路径不动
    expect(store.projects.find((p) => p.entities.some((e) => e.id === a.id))!.name).toBe(projectNameBefore)
    expect(b.name).toBe('b.las') // 其他实体不受影响
  })

  it('renameProject 只改项目显示名：其下实体与 path 不动', () => {
    const store = useSceneStore()
    const entity = store.addProjectFromPath('E:/点云/c.las')
    const project = store.projects.find((p) => p.entities.some((e) => e.id === entity.id))!
    const entityNameBefore = entity.name
    store.renameProject(project.id, '我的项目')
    expect(project.name).toBe('我的项目')
    expect(project.path).toBe('E:/点云/c.las')
    expect(entity.name).toBe(entityNameBefore)
  })

  it('对不存在的 id 重命名静默忽略', () => {
    const store = useSceneStore()
    expect(() => store.renameEntity(999999, 'x')).not.toThrow()
    expect(() => store.renameProject(999999, 'x')).not.toThrow()
  })
})

describe('sceneStore（树项容器）', () => {
  /** 建一个带单实体的项目，返回 { entity, projectId }。 */
  function openOne(filePath: string) {
    const store = useSceneStore()
    const entity = store.addProjectFromPath(filePath)
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === entity.id))!.id
    return { store, entity, projectId }
  }

  it('createTreeItemGroup 新建空容器：默认展开/可见，挂到项目下；treeObject 默认值与 partial 覆盖', () => {
    const { store, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 's.las 树项')!
    expect(group.type).toBe('treegroup')
    expect(group.name).toBe('s.las 树项')
    expect(group.expanded).toBe(true)
    expect(group.visible).toBe(true)
    expect(group.entityIds).toEqual([])
    const project = store.projects.find((p) => p.id === projectId)!
    expect(project.treeGroups.map((g) => g.id)).toContain(group.id)
    // 不存在的项目返回 null
    expect(store.createTreeItemGroup(999999, 'x')).toBeNull()
  })

  it('addEntityToGroup：实体平铺进项目 entities 且 entityIds 同步记入容器', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 's.las 树项')!
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path })!
    expect(tree).not.toBeNull()
    expect(tree.treeObject).toBeNull() // 树木信息只在真算过或手填过之后才有（不预挂 0 值）
    const project = store.projects.find((p) => p.id === projectId)!
    // 扁平列表：与直挂实体同数组（既有消费者只认它）
    expect(project.entities.map((e) => e.id)).toEqual([src.id, tree.id])
    // 容器引用：id 已记入
    expect(store.treeGroupById(group.id)!.entityIds).toEqual([tree.id])
    // 归属查询
    expect(store.groupOfEntity(tree.id)?.id).toBe(group.id)
    expect(store.groupOfEntity(src.id)).toBeNull()
  })

  it('addEntityToGroup 支持 partial.treeObject（整份透传，不再有"默认 0 值"）', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    const treeObject = createManualTreeObject({ height: 12.5, dbh: 31 })
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path, treeObject })!
    expect(tree.treeObject).toEqual(treeObject)
    // 不存在的容器返回 null
    expect(store.addEntityToGroup(999999, { name: 'x', path: src.path })).toBeNull()
  })

  describe('setEntityTreeObject（唯一写入口）', () => {
    it('对象 / null / 缺实体三种入参：整份替换、静默跳过已删实体', () => {
      const { store, entity } = openOne('E:/点云/s.las')
      expect(entity.treeObject).toBeNull() // 普通加载来的点云没有树木信息

      // 计算产物：整份替换（basePoint 非 null 是"带计算依据"的判据）
      const computed = {
        height: 18.4,
        dbh: 27.5,
        crownWidth: 4.2,
        crownWidthX: 4.2,
        crownWidthY: 3.1,
        crownBaseHeight: 12.9,
        dbhHeight: 1.3,
        basePoint: { x: 100, y: 200, z: 300 },
        representative: { x: 100.1, y: 200.2, z: 301.3 },
        crownCenter: { x: 100.2, y: 200.4, z: 312.9 },
        quality: {
          dbhMethod: 'circle' as const,
          dbhSlicePoints: 412,
          dbhInliers: 388,
          dbhRms: 0.004,
          crownPoints: 9021,
        },
      }
      store.setEntityTreeObject(entity.id, computed)
      expect(entity.treeObject).toEqual(computed)

      // 手填：没有计算依据（基准点 / 代表点 / 冠层圈落点为 null、dbhHeight 记 0、质量记 'none'）
      const manual = createManualTreeObject({ height: 20 })
      expect(manual.basePoint).toBeNull()
      expect(manual.representative).toBeNull()
      expect(manual.crownCenter).toBeNull()
      expect(manual.crownWidthX).toBe(manual.crownWidth)
      expect(manual.quality.dbhMethod).toBe('none')
      store.setEntityTreeObject(entity.id, manual)
      expect(entity.treeObject).toEqual(manual)
      expect(store.getAllEntities().find((e) => e.id === entity.id)!.treeObject).toEqual(manual)

      // 清空：回到"没有树木信息"（与"算出来是 0"是两回事）
      store.setEntityTreeObject(entity.id, null)
      expect(entity.treeObject).toBeNull()

      // 实体不存在：静默跳过，不抛错
      expect(() => store.setEntityTreeObject(999999, manual)).not.toThrow()
    })

    it('每次成功写入都自增 treeObjectRevision（3D 标记的失效信号）', () => {
      const { store, entity } = openOne('E:/点云/s.las')
      // 改一个坐标后 treeObject 仍是同一个非 null 对象 ⇒ 别的响应式字段看不出变化，
      // 3D 标记只能靠这个修订号感知（本地就复现了同一陷阱：改字段不换对象）
      const first = createManualTreeObject({ height: 12 })
      store.setEntityTreeObject(entity.id, first)
      const afterWrite = store.treeObjectRevision.value
      expect(afterWrite).toBeGreaterThan(0)

      const edited = { ...first, height: 13 }
      store.setEntityTreeObject(entity.id, edited)
      expect(store.treeObjectRevision.value).toBe(afterWrite + 1)

      // 清空也算一次写入
      store.setEntityTreeObject(entity.id, null)
      expect(store.treeObjectRevision.value).toBe(afterWrite + 2)

      // 缺实体：什么都没写 ⇒ 不动修订号（否则会白重画一帧）
      store.setEntityTreeObject(999999, first)
      expect(store.treeObjectRevision.value).toBe(afterWrite + 2)
    })
  })

  it('removeEntityFromProject 移除组内实体：扁平列表与容器 entityIds 同步剔除，容器保留', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path })!
    store.selectNode({ type: 'treegroup', id: group.id })
    store.toggleSelectNode({ type: 'entity', id: tree.id })
    store.removeEntityFromProject(tree.id)
    expect(store.groupOfEntity(tree.id)).toBeNull()
    expect(store.treeGroupById(group.id)!.entityIds).toEqual([]) // 容器保留（CC 行为）
    expect(store.projects.find((p) => p.id === projectId)!.entities.map((e) => e.id)).toEqual([src.id])
    // 选中集合：实体项被剔除、树项项保留
    expect(store.selection.value).toEqual([{ type: 'treegroup', id: group.id }])
  })

  it('removeTreeGroup 删容器并剔除其选中；组内实体需先删（不在此释放）', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path })!
    store.selectNode({ type: 'treegroup', id: group.id })
    // 删除容器前实体仍在扁平列表（pointcloudStore.deleteTreeGroup 先逐子删除）
    store.removeEntityFromProject(tree.id)
    store.removeTreeGroup(group.id)
    expect(store.treeGroupById(group.id)).toBeNull()
    expect(store.projects.find((p) => p.id === projectId)!.treeGroups).toEqual([])
    expect(store.selected.value).toBeNull()
    expect(store.selection.value).toHaveLength(0)
  })

  it('removeProject 整项目删除：树项容器与其下实体、选中一并剔除', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path })!
    store.toggleSelectNode({ type: 'treegroup', id: group.id })
    store.toggleSelectNode({ type: 'entity', id: tree.id })
    store.removeProject(projectId)
    expect(store.projects.some((p) => p.id === projectId)).toBe(false)
    expect(store.selection.value).toHaveLength(0)
  })

  it('toggleTreeGroup / toggleTreeGroupVisible / renameTreeGroup', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path })!
    store.toggleTreeGroup(group.id)
    expect(group.expanded).toBe(false)
    store.renameTreeGroup(group.id, '改名树项')
    expect(group.name).toBe('改名树项')
    store.toggleTreeGroupVisible(group.id) // 收起来：级联其下实体
    expect(group.visible).toBe(false)
    expect(tree.visible).toBe(false)
    store.toggleTreeGroupVisible(group.id)
    expect(group.visible).toBe(true)
    expect(tree.visible).toBe(true)
    // 对不存在的 id 静默忽略
    expect(() => store.toggleTreeGroupVisible(999999)).not.toThrow()
    expect(() => store.renameTreeGroup(999999, 'x')).not.toThrow()
  })

  it('toggleProjectVisible 级联到树项容器旗标', () => {
    const { store, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    store.toggleProjectVisible(projectId)
    expect(group.visible).toBe(false)
  })

  it('parentContainerOf：直挂实体归项目、组内实体归树项、不存在返回 null', () => {
    const { store, entity: src, projectId } = openOne('E:/点云/s.las')
    expect(store.parentContainerOf(src.id)).toEqual({ kind: 'project', projectId })
    const group = store.createTreeItemGroup(projectId, 'g')!
    const tree = store.addEntityToGroup(group.id, { name: '树1', path: src.path })!
    expect(store.parentContainerOf(tree.id)).toEqual({ kind: 'group', groupId: group.id, projectId })
    expect(store.parentContainerOf(999999)).toBeNull()
  })

  it('selectedNode 解析 treegroup 锚点', () => {
    const { store, projectId } = openOne('E:/点云/s.las')
    const group = store.createTreeItemGroup(projectId, 'g')!
    store.selectNode({ type: 'treegroup', id: group.id })
    const node = store.selectedNode.value
    expect(node?.type).toBe('treegroup')
    expect((node as { id: number }).id).toBe(group.id)
  })
})

// 物体编号（SceneEntity.labelNo）：分割 / 合并产物的身份，名字与分割色都由它派生，
// 导出时逐点写进 treeid。唯一性范围 = **容器或项目顶层**（LabelScope），分配 = 现存最大 + 1。
describe('sceneStore（物体编号：labelScopeOf / nextLabelNo / setEntityLabelNo）', () => {
  /** 建「项目 + 容器 + 容器内 N 个带号物体 + 项目顶层 M 个带号物体」的场景。 */
  function setup(name: string, groupNos: number[], directNos: number[]) {
    const store = useSceneStore()
    const source = store.addProjectFromPath(`E:/点云/${name}.las`)
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === source.id))!.id
    const group = store.createTreeItemGroup(projectId, `${name} 树项`)!
    const members = groupNos.map((no, i) => {
      const e = store.addEntityToGroup(group.id, { name: `Tree ${no}`, path: source.path })!
      if (no > 0) store.setEntityLabelNo(e.id, no)
      return e
    })
    const direct = directNos.map((no, i) => {
      const e = store.addEntityToProject(projectId, { name: `P${i}`, path: source.path })
      if (no > 0) store.setEntityLabelNo(e.id, no)
      return e
    })
    // source 本身不带编号（普通点云）
    return { store, source, projectId, group, members, direct }
  }

  it('labelScopeOf：直挂实体 → 项目顶层、组内实体 → 容器、不存在 → null', () => {
    const { store, source, projectId, group, members } = setup('scope', [1], [])
    expect(store.labelScopeOf(source.id)).toEqual({ kind: 'project', projectId })
    expect(store.labelScopeOf(members[0].id)).toEqual({ kind: 'group', groupId: group.id })
    expect(store.labelScopeOf(999999)).toBeNull()
  })

  it('nextLabelNo：空作用域 = 1；否则现存最大 + 1', () => {
    const { store, group, projectId } = setup('next', [3, 7], [2])
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(8)
    expect(store.nextLabelNo({ kind: 'project', projectId })).toBe(3)
    // 容器不存在 / 项目不存在 → 空作用域 → 1（防御：调用方随后会因目标失效而终止）
    expect(store.nextLabelNo({ kind: 'group', groupId: 999999 })).toBe(1)
  })

  it('无编号成员既不占号也不推高上限（"物体"与"数据块"是两回事）', () => {
    const { store, source, projectId, group } = setup('unnumbered', [5], [])
    // 项目顶层只有 source（无编号）→ 从 1 起，不受容器里 5 号的影响（作用域不同）
    expect(store.nextLabelNo({ kind: 'project', projectId })).toBe(1)
    // 往容器里再塞两个无编号实体（滤波产物 / .noise 残片）：容器的作用域仍是 6
    store.addEntityToGroup(group.id, { name: 'Tree 5.noise', path: source.path })
    const filtered = store.addEntityToGroup(group.id, { name: 'Tree 5.filtered', path: source.path })!
    expect(filtered.labelNo).toBeNull()
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(6)
  })

  it('excludeIds：即将被替换的成员不算进上限——新树只避开**留下来**的那些号', () => {
    // 树项原地重建：容器里 2 个算法项（8、9 号，本次会被整体替换）+ 1 个手工项（3 号，
    // 会被保留搬进新容器）。不排除算法项 ⇒ 新树从 10 起（号越用越大、且"上一个 9 号"
    // 其实已经不存在了）；排除它们 ⇒ 从 4 起，避开手工项 3 号即可。
    const { store, group, members } = setup('exclude', [8, 9], [])
    const manual = store.addEntityToGroup(group.id, { name: 'Tree 3', path: 'E:/点云/exclude.las' })!
    store.setEntityLabelNo(manual.id, 3)
    const algoIds = members.map((m) => m.id)
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(10)
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id }, algoIds)).toBe(4)
    // 排除集若给错人（把保留项当成了被替换项），新号就会撞上保留的手工项 3 号
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id }, [manual.id])).toBe(10)
  })

  it('删掉最大号后该号会被复用（唯一性只对现存物体；没有隐藏的高水位表）', () => {
    const { store, group, members } = setup('reuse', [1, 2, 3], [])
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(4)
    store.removeEntityFromProject(members[2].id) // 删掉 3 号（最大号）
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(3)
    // 删中间号不影响上限（4）
    store.removeEntityFromProject(members[0].id)
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(3)
  })

  it('作用域互不干扰：两个容器各自从 1 起编号（"1 号是那个颜色"跨容器可预期）', () => {
    const { store, source, projectId, group } = setup('two-groups', [4], [])
    const group2 = store.createTreeItemGroup(projectId, 'second')!
    const t = store.addEntityToGroup(group2.id, { name: 'Tree 1', path: source.path })!
    store.setEntityLabelNo(t.id, 1)
    expect(store.nextLabelNo({ kind: 'group', groupId: group2.id })).toBe(2)
    expect(store.nextLabelNo({ kind: 'group', groupId: group.id })).toBe(5)
  })

  it('setEntityLabelNo 可写 / 可置 null；不存在 id 静默忽略', () => {
    const { store, members } = setup('set', [0], [])
    store.setEntityLabelNo(members[0].id, 12)
    expect(members[0].labelNo).toBe(12)
    store.setEntityLabelNo(members[0].id, null)
    expect(members[0].labelNo).toBeNull()
    expect(() => store.setEntityLabelNo(999999, 1)).not.toThrow()
  })

  it('新实体默认无编号（addProjectFromPath / addEntityToProject / addEntityToGroup）', () => {
    const { store, source, projectId, group } = setup('defaults', [], [])
    expect(source.labelNo).toBeNull()
    const direct = store.addEntityToProject(projectId, { name: 'x', path: source.path })
    expect(direct.labelNo).toBeNull()
    const member = store.addEntityToGroup(group.id, { name: 'y', path: source.path })!
    expect(member.labelNo).toBeNull()
  })
})

describe('sceneStore（removeProject 整项目删除）', () => {
  it('删除项目：节点与其实体全部移除，选中集合中该项目及其实体项一并剔除', () => {
    const store = useSceneStore()
    const a = store.addProjectFromPath('E:/点云/a.las')
    const aProjectId = store.projects.find((p) => p.entities.some((e) => e.id === a.id))!.id
    // 项目下再挂一个实体，凑多实体场景
    store.addEntityToProject(aProjectId, { name: 'a.las.segmented', path: a.path })
    const entityIds = store.projects.find((p) => p.id === aProjectId)!.entities.map((e) => e.id)
    store.selectNode({ type: 'entity', id: entityIds[0] })
    store.toggleSelectNode({ type: 'entity', id: entityIds[1] })
    store.toggleSelectNode({ type: 'project', id: aProjectId })
    store.removeProject(aProjectId)
    expect(store.projects.some((p) => p.id === aProjectId)).toBe(false)
    expect(store.projects.every((p) => p.entities.every((e) => !entityIds.includes(e.id)))).toBe(true)
    expect(store.selection.value).toHaveLength(0)
    expect(store.selected.value).toBeNull()
  })

  it('删除项目不影响其他项目及其选中', () => {
    const store = useSceneStore()
    store.selectNode(null)
    const a = store.addProjectFromPath('E:/点云/a.las')
    const b = store.addProjectFromPath('E:/点云/b.las')
    const aProjectId = store.projects.find((p) => p.entities.some((e) => e.id === a.id))!.id
    const bProjectId = store.projects.find((p) => p.entities.some((e) => e.id === b.id))!.id
    const totalBefore = store.projects.length
    store.toggleSelectNode({ type: 'entity', id: a.id })
    store.toggleSelectNode({ type: 'entity', id: b.id })
    store.removeProject(bProjectId)
    expect(store.projects.some((p) => p.id === bProjectId)).toBe(false)
    // 模块级单例在文件内累加，只断言本次删掉了一个项目、a 的项目仍在
    expect(store.projects).toHaveLength(totalBefore - 1)
    expect(store.projects.some((p) => p.id === aProjectId)).toBe(true)
    expect(store.selection.value.map((s) => s.id)).toEqual([a.id])
    expect(store.selected.value).toEqual({ type: 'entity', id: a.id })
  })
})

describe('sceneStore（归属与拖拽：moveEntity / dropTargetBeside / algorithmMembersOf）', () => {
  /**
   * 建「项目 + 直接实体 directNames[] + 容器内实体 memberNames[]」的场景。
   * 扁平序 = 建档顺序：source → direct... → members...（addEntityToGroup 也是追加进
   * project.entities，成员关系只由 group.entityIds 表达，见 sceneStore 的扁平策略）。
   */
  function setup(name: string, directNames: string[], memberNames: string[]) {
    const store = useSceneStore()
    const source = store.addProjectFromPath(`E:/点云/${name}.las`)
    const projectId = store.projects.find((p) => p.entities.some((e) => e.id === source.id))!.id
    const group = store.createTreeItemGroup(projectId, `${name} 树项`)!
    const direct = directNames.map((n) => store.addEntityToProject(projectId, { name: n, path: source.path }))
    const members = memberNames.map((n) => store.addEntityToGroup(group.id, { name: n, path: source.path })!)
    const flat = () => store.projects.find((p) => p.id === projectId)!.entities.map((e) => e.id)
    return { store, source, projectId, group, direct, members, flat }
  }

  it('moveEntity 出组：落到项目顶层锚点之前，容器成员同步剔除', () => {
    const { store, source, projectId, group, direct, members, flat } = setup('mv-out', ['d1', 'd2'], ['m1', 'm2'])
    expect(flat()).toEqual([source.id, direct[0].id, direct[1].id, members[0].id, members[1].id])
    expect(store.moveEntity(members[0].id, { kind: 'project', projectId, beforeEntityId: direct[1].id })).toBe(true)
    // m1 挤到 d2 之前 ⇒ 直接实体显示序（= 扁平序滤掉组内成员）变成 source, d1, m1, d2
    expect(flat()).toEqual([source.id, direct[0].id, members[0].id, direct[1].id, members[1].id])
    expect(group.entityIds).toEqual([members[1].id])
  })

  it('moveEntity 进组：带锚点插到指定成员之前，且不动项目扁平存储', () => {
    const { store, projectId, group, direct, members, flat } = setup('mv-in', ['d1', 'd2'], ['m1'])
    const flatBefore = flat()
    expect(store.moveEntity(direct[1].id, { kind: 'group', groupId: group.id, beforeEntityId: members[0].id })).toBe(
      true
    )
    expect(group.entityIds).toEqual([direct[1].id, members[0].id])
    // 成员关系由 entityIds 表达，项目 entities 数组原样（扁平策略：既有消费者只认扁平列表）
    expect(flat()).toEqual(flatBefore)
    expect(store.parentContainerOf(direct[1].id)).toEqual({ kind: 'group', groupId: group.id, projectId })
  })

  it('moveEntity 组内重排：锚点前插；省略锚点 = 追加到末尾', () => {
    const { store, group, members } = setup('mv-order', [], ['m1', 'm2', 'm3'])
    expect(store.moveEntity(members[2].id, { kind: 'group', groupId: group.id, beforeEntityId: members[0].id })).toBe(
      true
    )
    expect(group.entityIds).toEqual([members[2].id, members[0].id, members[1].id])
    expect(store.moveEntity(members[2].id, { kind: 'group', groupId: group.id })).toBe(true)
    expect(group.entityIds).toEqual([members[0].id, members[1].id, members[2].id])
  })

  it('manuallyPlaced：仅跨组边界翻转（进组 true / 出组 false / 组内重排不变）', () => {
    const { store, projectId, group, direct, members } = setup('manual', ['d1'], ['m1'])
    expect(members[0].manuallyPlaced).toBe(false) // addEntityToGroup 建档 = 算法自身产出
    // 组内重排：不翻转（否则"把算法产的树在组内往上拖一格"会把它误标成手工项）
    store.moveEntity(members[0].id, { kind: 'group', groupId: group.id })
    expect(members[0].manuallyPlaced).toBe(false)
    // 出组 → false
    store.moveEntity(members[0].id, { kind: 'project', projectId })
    expect(members[0].manuallyPlaced).toBe(false)
    // 进组 → true（拖入的分割产物等不属于容器算法的产出）
    store.moveEntity(direct[0].id, { kind: 'group', groupId: group.id })
    expect(direct[0].manuallyPlaced).toBe(true)
    // 组内再重排：保持 true
    store.moveEntity(direct[0].id, { kind: 'group', groupId: group.id, beforeEntityId: members[0].id })
    expect(direct[0].manuallyPlaced).toBe(true)
    // 出组 → 复位 false
    store.moveEntity(direct[0].id, { kind: 'project', projectId })
    expect(direct[0].manuallyPlaced).toBe(false)
  })

  it('moveEntity 拒绝非法移动：跨项目 / 锚点不在目标列表 / 目标不存在', () => {
    const a = setup('mv-a', ['d1'], ['m1'])
    const b = setup('mv-b', ['d2'], [])
    // 跨项目（含容器目标在别的项目下）——一律拒绝，且**不改变任何状态**
    expect(a.store.moveEntity(a.members[0].id, { kind: 'project', projectId: b.projectId })).toBe(false)
    expect(a.store.moveEntity(a.members[0].id, { kind: 'group', groupId: b.group.id })).toBe(false)
    expect(a.group.entityIds).toEqual([a.members[0].id])
    expect(a.store.parentContainerOf(a.members[0].id)).toEqual({
      kind: 'group',
      groupId: a.group.id,
      projectId: a.projectId,
    })
    // 锚点不在目标列表：项目顶层锚点却是组内成员 / 组内锚点却是顶层实体
    expect(
      a.store.moveEntity(a.direct[0].id, {
        kind: 'project',
        projectId: a.projectId,
        beforeEntityId: a.members[0].id,
      })
    ).toBe(false)
    expect(
      a.store.moveEntity(a.members[0].id, {
        kind: 'group',
        groupId: a.group.id,
        beforeEntityId: a.direct[0].id,
      })
    ).toBe(false)
    expect(a.group.entityIds).toEqual([a.members[0].id])
    // 不存在的实体 / 不存在的容器
    expect(a.store.moveEntity(999999, { kind: 'project', projectId: a.projectId })).toBe(false)
    expect(a.store.moveEntity(a.members[0].id, { kind: 'group', groupId: 999999 })).toBe(false)
  })

  it('锚点 == 自身：无操作但**不算失败**（拖回原位），顺序不变', () => {
    const { store, group, members } = setup('noop', [], ['m1', 'm2'])
    expect(store.moveEntity(members[1].id, { kind: 'group', groupId: group.id, beforeEntityId: members[1].id })).toBe(
      true
    )
    expect(group.entityIds).toEqual([members[0].id, members[1].id])
  })

  it('拖进隐藏容器：实体显隐跟随容器（否则容器那个勾选框会撒谎）', () => {
    const { store, group, direct } = setup('hidden', ['d1'], [])
    store.toggleTreeGroupVisible(group.id)
    expect(group.visible).toBe(false)
    expect(direct[0].visible).toBe(true)
    store.moveEntity(direct[0].id, { kind: 'group', groupId: group.id })
    expect(direct[0].visible).toBe(false)
  })

  it('dropTargetBeside：组内实体 → 该容器、顶层实体 → 项目，锚点都是自身；不存在 → null', () => {
    const { store, projectId, group, direct, members } = setup('beside', ['d1'], ['m1'])
    expect(store.dropTargetBeside(members[0].id)).toEqual({
      kind: 'group',
      groupId: group.id,
      beforeEntityId: members[0].id,
    })
    expect(store.dropTargetBeside(direct[0].id)).toEqual({
      kind: 'project',
      projectId,
      beforeEntityId: direct[0].id,
    })
    expect(store.dropTargetBeside(999999)).toBeNull()
  })

  it('algorithmMembersOf：排除手工项，保持容器内顺序；容器不存在返回空', () => {
    const { store, group, direct, members } = setup('algo', ['d1'], ['m1', 'm2'])
    expect(store.algorithmMembersOf(group.id)).toEqual([members[0].id, members[1].id])
    store.moveEntity(direct[0].id, { kind: 'group', groupId: group.id, beforeEntityId: members[0].id })
    expect(store.algorithmMembersOf(group.id)).toEqual([members[0].id, members[1].id]) // 手工项不在内
    expect(store.algorithmMembersOf(999999)).toEqual([])
  })

  it('回归哨兵：分割产物接手源实体在容器里的位置（先建 → 后挪 → 再删源）', () => {
    const { store, projectId, group, members, flat } = setup('split-slot', [], ['m1', 'm2', 'm3'])
    expect(group.entityIds).toEqual([members[0].id, members[1].id, members[2].id])
    // 模拟 pointcloudStore.splitEntity 的建档：两个产物先追加到项目末尾
    const seg = store.addEntityToProject(projectId, { name: 'm2.segmented', path: 'E:/点云/split-slot.las' })
    const rem = store.addEntityToProject(projectId, { name: 'm2.remaining', path: 'E:/点云/split-slot.las' })
    expect(flat()[flat().length - 1]).toBe(rem.id) // 此刻确实在末尾——旧行为就此留在 2 级 ❌
    // 落点 = 源所在容器、锚定源自身；挪完两个产物再删源
    const dropAt = store.dropTargetBeside(members[1].id)!
    expect(store.moveEntity(seg.id, dropAt)).toBe(true)
    expect(store.moveEntity(rem.id, dropAt)).toBe(true)
    store.removeEntityFromProject(members[1].id)
    // 产物顶替 m2 那一格：仍在容器内、相对次序正确、名字贴着源
    expect(group.entityIds).toEqual([members[0].id, seg.id, rem.id, members[2].id])
    expect(store.parentContainerOf(seg.id)).toEqual({ kind: 'group', groupId: group.id, projectId })
    expect(store.parentContainerOf(rem.id)).toEqual({ kind: 'group', groupId: group.id, projectId })
    // 不是本容器算法的产出 ⇒ 重跑单木分割不会把它们消费掉
    expect(store.algorithmMembersOf(group.id)).toEqual([members[0].id, members[2].id])
  })
})
