import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  attachLodScheduler,
  trackLodDisplay,
  untrackLodDisplay,
  invalidateLodDisplay,
  lodSchedulerDebugState,
  LOD_DRAG_BUDGET,
  LOD_DENSIFY_PACE_MS,
  LOD_REFRESH_IDLE_MS,
} from '../../../../src/renderer/three/lodScheduler'
import { createLodDisplay, LOD_FRAME_BUDGET, type LodDisplay } from '../../../../src/renderer/three/lodRenderer'
import { createLodTreeState } from '../../../../src/renderer/three/lodTraversal'
import { uniformLeafLodTree } from './lodTreeFixture'
import type { FrameContext, FrameTask, ThreeViewer } from '../../../../src/renderer/three/engine'
import type { LodOctreeEntityResult } from '../../../../src/renderer/utils/lodOctree'

/**
 * 调度器状态机（阶段 3 的核心）：拖拽降质 → 松手逐档加密 → 满预算静止。
 *
 * 用假 viewer + 假时钟跑真实帧任务：调度器所有时间判据都读 `performance.now`，
 * 相机变化判据读相机矩阵，两者都能在 node 环境里精确构造，于是"拖拽 64K、
 * 松手 128K→256K→512K、相机连续运动期间一帧不取"这些**只能靠手感验证**的性质
 * 变成了确定性断言。
 *
 * 数据规模刻意压过每帧预算（80 万点 > 512K），否则配额永远被"可见点数"卡住、
 * 看不出预算分档。首帧兜底填充 + 每轮取点各几十毫秒，整个文件约 2 秒。
 */

const POINTS_PER_LEAF = 100_000
const LEAF_COUNT = 8
const TOTAL_POINTS = POINTS_PER_LEAF * LEAF_COUNT

/** 受控时钟：调度器只读 performance.now，帧的推进全由测试给定。 */
let now = 0

/** 假 viewer：只实现调度器用到的那几样（帧任务、controls 事件、requestRender）。 */
interface FakeViewer {
  viewer: ThreeViewer
  /** 推一帧；moveCamera 模拟 OrbitControls 正在改相机。 */
  tick: (opts?: { moveCamera?: boolean }) => void
  /** 派发 controls 的 start / end（拖拽起止）。 */
  dispatch: (type: 'start' | 'end') => void
  renders: () => number
}

function makeFakeViewer(): FakeViewer {
  const tasks = new Set<FrameTask>()
  const listeners = new Map<string, Set<() => void>>()
  let renders = 0

  // 正交相机罩住整棵树（人造节点都在原点附近、边长几百）
  const camera = new THREE.OrthographicCamera(-2000, 2000, 2000, -2000, 0.1, 10000)
  camera.position.set(0, 0, 1000)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()

  const controls = {
    addEventListener: (type: string, fn: () => void) => {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn)
    },
  }

  const viewer = {
    controls,
    addFrameTask: (task: FrameTask) => {
      tasks.add(task)
      return () => tasks.delete(task)
    },
    requestRender: () => {
      renders++
    },
  } as unknown as ThreeViewer

  const ctx = { camera, controls, width: 800, height: 600, delta: 16 } as unknown as FrameContext
  return {
    viewer,
    tick: (opts) => {
      if (opts?.moveCamera) {
        camera.position.x += 5
        camera.updateMatrixWorld()
      }
      for (const task of tasks) task(ctx)
    },
    dispatch: (type) => {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    renders: () => renders,
  }
}

/** 造一个带真树的显示层：单块几何体 + 覆盖它的八叉树。 */
function makeTreeDisplay(result: LodOctreeEntityResult, capacityPoints: number): LodDisplay {
  const positions = new Float32Array(capacityPoints * 3)
  for (let i = 0; i < capacityPoints; i++) positions[i * 3] = i
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(capacityPoints - 1, 0, 0)
  )
  const material = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false })
  const display = createLodDisplay([geometry], material, 1)
  if (!display) throw new Error('显示层创建失败（点数为 0）')
  display.tree = createLodTreeState(result)
  return display
}

/** 覆盖整棵树的树结果（80 万点，id 反序以区分"树路径"与"兜底取样路径"）。 */
function makeTreeResult(): LodOctreeEntityResult {
  const result = uniformLeafLodTree(LEAF_COUNT, POINTS_PER_LEAF)
  // 反序：兜底取样路径填的是 0,1,2…，树路径填的是 799999,799998…，
  // 于是 slotIds[0] 一路断言就能证明取的是哪条路径（两者填充量恰好相同）
  result.pointIds.reverse()
  return result
}

/** 首帧兜底填充的槽位数（= capacity，树结果点数为 0 时才是 0）。 */
function maxSlots(display: LodDisplay): number {
  return display.capacity
}

describe('LOD 调度器：相机运动 / 静止的取点时机', () => {
  let fake: FakeViewer
  let display: LodDisplay

  beforeEach(() => {
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fake = makeFakeViewer()
    attachLodScheduler(fake.viewer)
    display = makeTreeDisplay(makeTreeResult(), TOTAL_POINTS)
    trackLodDisplay(display)
  })

  afterEach(() => {
    untrackLodDisplay(display)
    attachLodScheduler(null)
    vi.restoreAllMocks()
  })

  it('相机连续运动期间一帧都不取（成本只剩"画上一帧的点集"）', () => {
    for (let i = 0; i < 8; i++) {
      now += 16
      fake.tick({ moveCamera: true })
    }
    expect(fake.renders()).toBe(0)
    expect(display.dirty).toBe(true) // 脏着等停稳，但不是每帧重取
    // 画幅还停在建立显示层时兜底取样填的那一版
    expect(display.filled).toBe(maxSlots(display))
    expect(display.slotIds[0]).toBe(0)
  })

  it('相机停稳超过空闲阈值后按树取点，且只请求一帧重绘', () => {
    now += 16
    fake.tick({ moveCamera: true })
    now += LOD_REFRESH_IDLE_MS + 1
    fake.tick()
    expect(fake.renders()).toBe(1)
    expect(display.dirty).toBe(false)
    // 取的是树路径（反序 id）而不是兜底取样
    expect(display.slotIds[0]).toBe(TOTAL_POINTS - 1)
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
  })

  it('空闲阈值之内不取点（滚轮缩放与慢速挪动都算连续运动）', () => {
    now += LOD_REFRESH_IDLE_MS
    fake.tick({ moveCamera: true })
    now += LOD_REFRESH_IDLE_MS - 1
    fake.tick()
    expect(fake.renders()).toBe(0)
    expect(display.slotIds[0]).toBe(0) // 还是兜底那版
  })

  it('隐藏的显示层不参与取点（预览回退 / 整体隐藏）', () => {
    display.points.visible = false
    invalidateLodDisplay(display)
    now += 1000
    fake.tick()
    expect(fake.renders()).toBe(0)
    display.points.visible = true
  })

  it('解除纳管后不再被调度', () => {
    untrackLodDisplay(display)
    invalidateLodDisplay(display)
    now += 1000
    fake.tick()
    expect(fake.renders()).toBe(0)
    trackLodDisplay(display)
  })

  it('换引擎（重挂载）会重置节奏状态：重新挂载后从满预算开始', () => {
    // 先把预算压到拖拽档
    fake.dispatch('start')
    now += 16
    fake.tick({ moveCamera: true })
    now += LOD_REFRESH_IDLE_MS + 1
    fake.tick()
    expect(lodSchedulerDebugState().budget).toBe(LOD_DRAG_BUDGET)

    const next = makeFakeViewer()
    attachLodScheduler(next.viewer)
    expect(lodSchedulerDebugState().budget).toBe(LOD_FRAME_BUDGET)
    expect(lodSchedulerDebugState().dragging).toBe(false)
    expect(lodSchedulerDebugState().ramping).toBe(false)
  })
})

describe('LOD 调度器：拖拽降质与逐档加密', () => {
  let fake: FakeViewer
  let display: LodDisplay

  /** 推进一帧；moveCamera 模拟拖拽中的相机。 */
  const step = (ms: number, opts?: { moveCamera?: boolean }) => {
    now += ms
    fake.tick(opts)
  }

  /** 拖拽到"停了一下"（真的取过一轮点），此时预算已压到拖拽档。 */
  function dragAndPause() {
    fake.dispatch('start')
    step(16, { moveCamera: true })
    step(LOD_REFRESH_IDLE_MS + 1)
  }

  beforeEach(() => {
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fake = makeFakeViewer()
    attachLodScheduler(fake.viewer)
    display = makeTreeDisplay(makeTreeResult(), TOTAL_POINTS)
    trackLodDisplay(display)
    // 先让画面到满预算（相机停稳一轮）
    step(16, { moveCamera: true })
    step(LOD_REFRESH_IDLE_MS + 1)
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
  })

  afterEach(() => {
    untrackLodDisplay(display)
    attachLodScheduler(null)
    vi.restoreAllMocks()
  })

  it('拖拽期停顿：预算压到拖拽档，画幅随之变粗（每帧成本降下来）', () => {
    dragAndPause()
    expect(lodSchedulerDebugState().dragging).toBe(true)
    expect(lodSchedulerDebugState().budget).toBe(LOD_DRAG_BUDGET)
    expect(display.filled).toBe(LOD_DRAG_BUDGET)
  })

  it('松手后逐档翻倍回到满预算，四档共约 200 ms', () => {
    dragAndPause()
    fake.dispatch('end')
    expect(lodSchedulerDebugState().ramping).toBe(true)

    // 第 1 档：当帧预算仍是拖拽档，取完点才涨到下一档
    step(LOD_REFRESH_IDLE_MS + 1)
    expect(display.filled).toBe(LOD_DRAG_BUDGET)
    expect(lodSchedulerDebugState().budget).toBe(LOD_DRAG_BUDGET * 2)
    // 加密节奏之内不重取（否则一松手就把几档一次全取完，等于没有"长出来"的过程）
    step(LOD_DENSIFY_PACE_MS - 1)
    expect(display.filled).toBe(LOD_DRAG_BUDGET)

    step(1)
    expect(display.filled).toBe(LOD_DRAG_BUDGET * 2)
    expect(lodSchedulerDebugState().budget).toBe(LOD_DRAG_BUDGET * 4)
    step(LOD_DENSIFY_PACE_MS)
    expect(display.filled).toBe(LOD_DRAG_BUDGET * 4)
    expect(lodSchedulerDebugState().budget).toBe(LOD_FRAME_BUDGET)
    step(LOD_DENSIFY_PACE_MS)
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
    expect(lodSchedulerDebugState().ramping).toBe(false)

    // 到顶后静止不再重取
    const renders = fake.renders()
    step(1000)
    expect(fake.renders()).toBe(renders)
  })

  it('拖完不停顿（一次都没取过点）：不进入加密，只按满预算取一次', () => {
    fake.dispatch('start')
    step(16, { moveCamera: true })
    fake.dispatch('end')
    expect(lodSchedulerDebugState().ramping).toBe(false)
    expect(lodSchedulerDebugState().budget).toBe(LOD_FRAME_BUDGET)
    // 拖拽中相机一直在动（脏着），停稳后按满预算取一次即可，没有"加密"这回事
    step(LOD_REFRESH_IDLE_MS + 1)
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
    const renders = fake.renders()
    step(1000)
    expect(fake.renders()).toBe(renders)
    expect(lodSchedulerDebugState().ramping).toBe(false)
  })

  it('原地点击不触发加密（预算没被压低过）', () => {
    fake.dispatch('start')
    fake.dispatch('end')
    expect(lodSchedulerDebugState().ramping).toBe(false)
    expect(lodSchedulerDebugState().budget).toBe(LOD_FRAME_BUDGET)
  })

  it('加密途中点一下不会卡住：接着加密到满预算', () => {
    dragAndPause()
    fake.dispatch('end')
    step(LOD_REFRESH_IDLE_MS + 1) // 第 1 档加密（预算 64K → 128K）
    expect(lodSchedulerDebugState().budget).toBe(LOD_DRAG_BUDGET * 2)

    // 手滑点一下：onStart/onEnd 挨着发生，中途没取点
    fake.dispatch('start')
    fake.dispatch('end')
    expect(lodSchedulerDebugState().ramping).toBe(true) // 仍处在加密中

    for (let i = 0; i < 6 && lodSchedulerDebugState().budget < LOD_FRAME_BUDGET; i++) {
      step(LOD_DENSIFY_PACE_MS + 1)
    }
    expect(lodSchedulerDebugState().budget).toBe(LOD_FRAME_BUDGET)
    // 到顶那一档取的是"上一档的预算"，所以还要多推一帧才真的画满
    step(LOD_DENSIFY_PACE_MS + 1)
    expect(display.filled).toBe(LOD_FRAME_BUDGET)
  })

  it('拖拽后的新相机运动立即置脏：停稳即重取（不会停在拖拽档）', () => {
    dragAndPause()
    fake.dispatch('end')
    // 松手后用户又转了一下相机
    step(16, { moveCamera: true })
    step(LOD_REFRESH_IDLE_MS + 1)
    expect(display.filled).toBeGreaterThanOrEqual(LOD_DRAG_BUDGET)
    expect(lodSchedulerDebugState().budget).toBeGreaterThan(LOD_DRAG_BUDGET)
  })

  it('可见性变化由 store 置脏触发重取（显隐翻转后画幅跟着更新）', () => {
    display.points.visible = false
    invalidateLodDisplay(display)
    step(1000)
    const renders = fake.renders()
    display.points.visible = true
    invalidateLodDisplay(display)
    step(1000)
    expect(fake.renders()).toBe(renders + 1)
  })
})
