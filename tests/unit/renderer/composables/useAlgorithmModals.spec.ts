import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ALGORITHM_MODALS,
  ALGORITHM_MODAL_GROUPS,
  useAlgorithmModals,
} from '../../../../src/renderer/composables/useAlgorithmModals'

/**
 * 十三个算法模态的入口表与互斥 toggle（composables/useAlgorithmModals）。
 *
 * 十六个 store（含 sceneStore）全部 mock：被测的是**协调逻辑**——进入一个模态前退出其余
 * 模态、toggle 的进出语义、无选中目标时不动、各入口自己的可用性判据——而不是各算法本身
 *（那有各自的 store / 契约单测）。之所以能纯 mock：本 composable 只读各 store 的
 * `active.value` 并调 start/exit（详见其文件头）。
 * **新增算法模态时这份 mock 也要跟着加一项**：漏了的话会真的把该 store 及其依赖
 * （pointcloudStore 等）拉进 node 环境，模块级 watch 立刻炸——见本文件末尾那条护栏断言。
 *
 * 唯一**不** mock 的是 `resolveRegistrationPair`（两个配准入口的 `enabled` 判据）：它是纯
 * 函数且正是"恰好 2 个已加载点云"这条判据的唯一实现，mock 掉等于把这组用例的验证对象抽走。
 * 于是 sceneStore 的假身要给全它读的三个字段（selection / projects / 实体上的 bbox+globalShift）。
 *
 * 纯逻辑，无 DOM 需求，node 环境即可（不 mount 组件，故不需要 jsdom）。
 */

/** 各 store 的假身：`active` 只被读 `.value`，故普通对象即可（不进响应式）。 */
const { fake, makeProjects } = vi.hoisted(() => {
  /** 一个模态：active 状态 + start/exit 调用计数。 */
  const modal = () => ({ active: { value: false }, starts: 0, exits: 0 })

  /** 一个点云实体（`resolveRegistrationPair` 只读 id/name/bbox/globalShift）。 */
  const cloud = (id: number, ready: boolean) => ({
    id,
    name: `cloud${id}.las`,
    path: '',
    type: 'pointcloud',
    visible: true,
    pointCount: 0,
    hasColor: false,
    hasNormals: false,
    bbox: ready ? { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 } : null,
    globalShift: ready ? { x: 0, y: 0, z: 0 } : null,
  })

  /** 一个项目（3 个点云实体）；`ready = false` 造"尚未加载完成"（bbox / globalShift 为 null）。 */
  const makeProjects = (ready: boolean) => [
    {
      id: 1,
      name: 'proj',
      path: '',
      type: 'project',
      expanded: true,
      visible: true,
      showNameIn3D: false,
      entities: [cloud(10, ready), cloud(11, ready), cloud(12, ready)],
      treeGroups: [],
    },
  ]

  const fake = {
    scene: {
      selectedNode: { value: null as unknown as { type: string; id: number } | null },
      selection: { value: [] as { type: string; id: number }[] },
      projects: makeProjects(true) as unknown[],
    },
    segment: modal(),
    measure: modal(),
    statisticalFilter: modal(),
    radiusFilter: modal(),
    voxelFilter: modal(),
    csf: modal(),
    csfPro: modal(),
    treeIso: modal(),
    euclideanCluster: modal(),
    powerLine: modal(),
    ransacPlane: modal(),
    ransacCylinder: modal(),
    align: modal(),
    icp: modal(),
    gicp: modal(),
  }
  return { fake, makeProjects }
})

vi.mock('../../../../src/renderer/stores/sceneStore', () => ({ useSceneStore: () => fake.scene }))
vi.mock('../../../../src/renderer/stores/segmentStore', () => ({
  useSegmentStore: () => ({
    active: fake.segment.active,
    exitSegment: () => {
      fake.segment.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/measureStore', () => ({
  useMeasureStore: () => ({
    active: fake.measure.active,
    exitMeasure: () => {
      fake.measure.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/statisticalFilterStore', () => ({
  useStatisticalFilterStore: () => ({
    active: fake.statisticalFilter.active,
    startStatisticalFilter: () => {
      fake.statisticalFilter.starts++
    },
    exitStatisticalFilter: () => {
      fake.statisticalFilter.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/filterStore', () => ({
  useFilterStore: () => ({
    active: fake.radiusFilter.active,
    startFilter: () => {
      fake.radiusFilter.starts++
    },
    exitFilter: () => {
      fake.radiusFilter.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/voxelFilterStore', () => ({
  useVoxelFilterStore: () => ({
    active: fake.voxelFilter.active,
    startVoxelFilter: () => {
      fake.voxelFilter.starts++
    },
    exitVoxelFilter: () => {
      fake.voxelFilter.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/csfStore', () => ({
  useCsfStore: () => ({
    active: fake.csf.active,
    startCsf: () => {
      fake.csf.starts++
    },
    exitCsf: () => {
      fake.csf.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/csfProStore', () => ({
  useCsfProStore: () => ({
    active: fake.csfPro.active,
    startCsfPro: () => {
      fake.csfPro.starts++
    },
    exitCsfPro: () => {
      fake.csfPro.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/treeIsoStore', () => ({
  useTreeIsoStore: () => ({
    active: fake.treeIso.active,
    startTreeIso: () => {
      fake.treeIso.starts++
    },
    exitTreeIso: () => {
      fake.treeIso.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/euclideanClusterStore', () => ({
  useEuclideanClusterStore: () => ({
    active: fake.euclideanCluster.active,
    startEuclideanCluster: () => {
      fake.euclideanCluster.starts++
    },
    exitEuclideanCluster: () => {
      fake.euclideanCluster.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/powerlineStore', () => ({
  usePowerlineStore: () => ({
    active: fake.powerLine.active,
    startPowerline: () => {
      fake.powerLine.starts++
    },
    exitPowerline: () => {
      fake.powerLine.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/ransacPlaneStore', () => ({
  useRansacPlaneStore: () => ({
    active: fake.ransacPlane.active,
    startRansacPlane: () => {
      fake.ransacPlane.starts++
    },
    exitRansacPlane: () => {
      fake.ransacPlane.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/ransacCylinderStore', () => ({
  useRansacCylinderStore: () => ({
    active: fake.ransacCylinder.active,
    startRansacCylinder: () => {
      fake.ransacCylinder.starts++
    },
    exitRansacCylinder: () => {
      fake.ransacCylinder.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/alignStore', () => ({
  useAlignStore: () => ({
    active: fake.align.active,
    startAlign: () => {
      fake.align.starts++
    },
    exitAlign: () => {
      fake.align.exits++
    },
  }),
}))
vi.mock('../../../../src/renderer/stores/icpStore', () => ({
  useIcpStore: () => ({
    active: fake.icp.active,
    startIcp: () => {
      fake.icp.starts++
    },
    exitIcp: () => {
      fake.icp.exits++
    },
  }),
}))

vi.mock('../../../../src/renderer/stores/gicpStore', () => ({
  useGicpStore: () => ({
    active: fake.gicp.active,
    startGicp: () => {
      fake.gicp.starts++
    },
    exitGicp: () => {
      fake.gicp.exits++
    },
  }),
}))

/** 全部模态的 start 调用总数（断言"一次 toggle 只启动一个模态"）。 */
function totalStarts(): number {
  return [
    fake.statisticalFilter,
    fake.radiusFilter,
    fake.voxelFilter,
    fake.csf,
    fake.csfPro,
    fake.treeIso,
    fake.euclideanCluster,
    fake.powerLine,
    fake.ransacPlane,
    fake.ransacCylinder,
    fake.align,
    fake.icp,
    fake.gicp,
  ].reduce((sum, modal) => sum + modal.starts, 0)
}

beforeEach(() => {
  for (const modal of [
    fake.segment,
    fake.measure,
    fake.statisticalFilter,
    fake.radiusFilter,
    fake.voxelFilter,
    fake.csf,
    fake.csfPro,
    fake.treeIso,
    fake.euclideanCluster,
    fake.powerLine,
    fake.ransacPlane,
    fake.ransacCylinder,
    fake.align,
    fake.icp,
    fake.gicp,
  ]) {
    modal.active.value = false
    modal.starts = 0
    modal.exits = 0
  }
  fake.scene.selectedNode.value = { type: 'pointcloud', id: 1 }
  fake.scene.selection.value = []
  fake.scene.projects = makeProjects(true)
})

describe('算法模态入口表', () => {
  it('键唯一，且分组只是把表切开、不重不漏', () => {
    const keys = ALGORITHM_MODALS.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
    // 同名组只允许出现一段：Tools 菜单按组的连续段画组头，断开就会画出两个同名组头
    const names = ALGORITHM_MODAL_GROUPS.map((group) => group.name)
    expect(new Set(names).size).toBe(names.length)
    expect(ALGORITHM_MODAL_GROUPS.flatMap((group) => group.items)).toEqual([...ALGORITHM_MODALS])
  })

  it('每个入口都有项名与用途说明（菜单项与按钮 title 都取自这里）', () => {
    for (const item of ALGORITHM_MODALS) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.title.length).toBeGreaterThan(0)
    }
  })

  it('入口表的顺序与 keys 契约一致（统计滤波在半径滤波前，分割组里聚类在单木后、电力线在最后，两个 RANSAC 拟合随后且平面在圆柱前，两个配准排在最末且点对对齐在 ICP 前）', () => {
    expect(ALGORITHM_MODALS.map((item) => item.key)).toEqual([
      'statisticalFilter',
      'radiusFilter',
      'voxelFilter',
      'csf',
      'csfPro',
      'treeIso',
      'euclideanCluster',
      'powerLine',
      'ransacPlane',
      'ransacCylinder',
      'align',
      'icp',
      'gicp',
    ])
    // 分组顺序（Tools 菜单的组头顺序）：配准组排在最后——先把各片云自己处理干净，最后才做两云之间的事
    expect(ALGORITHM_MODAL_GROUPS.map((group) => group.name)).toEqual(['Filter', 'Segment', 'Fit', 'Registration'])
  })

  it('每个入口键在本文件的 mock 表里都有对应项（漏加会把真 store 拖进 node 环境后炸在别处）', () => {
    // 这条护栏的价值：新增模态时若忘了在上面的 fake 里加一项，症状是**别的文件**（真 store 的
    // 模块级 watch 拉到 pointcloudStore）报一个毫不相干的 TypeError。这里直接点名漏了哪个键。
    const mocked = new Set(Object.keys(fake).filter((k) => k !== 'scene' && k !== 'segment' && k !== 'measure'))
    for (const item of ALGORITHM_MODALS) expect(mocked, `入口 ${item.key} 缺 mock`).toContain(item.key)
  })
})

describe('算法模态互斥与 toggle', () => {
  it('进入某模态先退出其余全部模态（含分割与测量）', () => {
    const { toggle } = useAlgorithmModals()
    fake.segment.active.value = true
    fake.measure.active.value = true
    fake.voxelFilter.active.value = true
    toggle('radiusFilter')
    expect(fake.segment.exits).toBe(1)
    expect(fake.measure.exits).toBe(1)
    expect(fake.voxelFilter.exits).toBe(1)
    expect(fake.radiusFilter.starts).toBe(1)
    expect(fake.radiusFilter.exits).toBe(0) // 进入自己时不该把自己退掉
    expect(totalStarts()).toBe(1) // 其余模态一个都不许被启动
  })

  it('已激活时 toggle = 退出，且不启动任何模态', () => {
    const { toggle } = useAlgorithmModals()
    fake.radiusFilter.active.value = true
    fake.csf.active.value = true
    toggle('radiusFilter')
    expect(fake.radiusFilter.exits).toBe(1)
    expect(fake.csf.exits).toBe(0) // 退出路径不碰别的模态
    expect(totalStarts()).toBe(0)
  })

  it('无选中目标时不动（入口本就禁用，这里是第二道闸）', () => {
    fake.scene.selectedNode.value = null
    const { toggle, disabled } = useAlgorithmModals()
    expect(disabled.value).toBe(true)
    toggle('csf')
    expect(totalStarts()).toBe(0)
  })

  it('exitOtherModals() 省略参数 = 连算法模态一起全退（分割 / 测量入口用）', () => {
    const { exitOtherModals } = useAlgorithmModals()
    fake.csf.active.value = true
    fake.treeIso.active.value = true
    fake.segment.active.value = true
    exitOtherModals()
    expect(fake.csf.exits).toBe(1)
    expect(fake.treeIso.exits).toBe(1)
    expect(fake.segment.exits).toBe(1)
    expect(totalStarts()).toBe(0)
  })

  it('同一个 RANSAC 组内也互斥：进入圆柱拟合会退出平面拟合（最常见的一对切换）', () => {
    const { toggle } = useAlgorithmModals()
    fake.ransacPlane.active.value = true
    toggle('ransacCylinder')
    expect(fake.ransacPlane.exits).toBe(1)
    expect(fake.ransacCylinder.starts).toBe(1)
    expect(fake.ransacCylinder.exits).toBe(0)
    // 反向：圆柱 → 平面。假身不改 active（只计数），故这里显式模拟"圆柱已激活"
    fake.ransacCylinder.active.value = true
    fake.ransacPlane.active.value = false
    toggle('ransacPlane')
    expect(fake.ransacCylinder.exits).toBe(1) // 经 () => exitRansacCylinder(false) 包装退出
    expect(fake.ransacPlane.starts).toBe(1)
  })

  it('anyModalActive 计入分割与十二个算法、不计测量', () => {
    const { anyModalActive } = useAlgorithmModals()
    expect(anyModalActive()).toBe(false)
    fake.measure.active.value = true
    expect(anyModalActive()).toBe(false)
    fake.ransacPlane.active.value = true
    expect(anyModalActive()).toBe(true)
    fake.ransacPlane.active.value = false
    fake.segment.active.value = true
    expect(anyModalActive()).toBe(true)
  })

  it('titleOf：无选中时讲禁用原因（treeIso 另提树项容器、聚类与电力线另提不接受容器），有选中时讲用途', () => {
    fake.scene.selectedNode.value = null
    const withoutSelection = useAlgorithmModals()
    expect(withoutSelection.titleOf('statisticalFilter')).toContain('请先在 DB Tree 中选中点云')
    expect(withoutSelection.titleOf('treeIso')).toContain('树项容器')
    expect(withoutSelection.titleOf('euclideanCluster')).toContain('聚类不支持项目 / 容器目标')
    expect(withoutSelection.titleOf('powerLine')).toContain('只支持单个点云实体')
    fake.scene.selectedNode.value = { type: 'pointcloud', id: 1 }
    const withSelection = useAlgorithmModals()
    expect(withSelection.disabled.value).toBe(false)
    expect(withSelection.titleOf('treeIso')).toContain('单木分割')
    expect(withSelection.titleOf('euclideanCluster')).toContain('欧式聚类分割')
    expect(withSelection.titleOf('powerLine')).toContain('电力线提取')
  })

  it('三个配准入口的判据是"恰好 2 个已加载点云"：1 片 / 3 片 / 未加载完都禁用，恰好 2 片才放行', () => {
    const { disabledOf, titleOf, toggle } = useAlgorithmModals()
    const sel = (...ids: number[]) => (fake.scene.selection.value = ids.map((id) => ({ type: 'entity', id })))

    sel(10) // 只选中 1 片
    expect(disabledOf('align')).toBe(true)
    expect(disabledOf('icp')).toBe(true)
    expect(disabledOf('gicp')).toBe(true)
    expect(titleOf('align')).toContain('恰好 2 个')
    expect(disabledOf('csf')).toBe(false) // 其余入口仍只要求"有选中目标"，不被这条判据牵连

    sel(10, 11) // 恰好 2 片：放行
    expect(disabledOf('align')).toBe(false)
    expect(disabledOf('icp')).toBe(false)
    expect(disabledOf('gicp')).toBe(false)
    expect(titleOf('align')).toContain('点对对齐')
    expect(titleOf('icp')).toContain('精细配准')
    expect(titleOf('gicp')).toContain('精细配准')

    sel(10, 11, 12) // 3 片：又禁用（严格 2 选，多选第三片只会让人误拾）
    expect(disabledOf('align')).toBe(true)

    fake.scene.projects = makeProjects(false) // 2 片，但都还没加载完（拿不到渲染缓冲）
    sel(10, 11)
    expect(disabledOf('icp')).toBe(true)
    expect(disabledOf('gicp')).toBe(true)
    expect(titleOf('icp')).toContain('已加载完成')

    // 禁用时 toggle 不许启动（第二道闸）；各 store 的 startXxx 还会各自再解析一次并给出精确原因
    toggle('align')
    expect(fake.align.starts).toBe(0)
    expect(fake.icp.starts).toBe(0)
    expect(fake.gicp.starts).toBe(0)
    expect(totalStarts()).toBe(0)

    fake.scene.projects = makeProjects(true)
    toggle('align')
    expect(fake.align.starts).toBe(1)
    expect(fake.icp.starts).toBe(0)
    expect(fake.gicp.starts).toBe(0)
    expect(totalStarts()).toBe(1)

    // 测试 GICP 单独启动
    toggle('gicp')
    expect(fake.gicp.starts).toBe(1)
    expect(fake.align.starts).toBe(1) // 之前已经启动过
    expect(totalStarts()).toBe(2) // 两个启动了
  })
})
