import { describe, it, expect } from 'vitest'
import { useMeasureStore } from '../../../../src/renderer/stores/measureStore'
import { useConsoleStore } from '../../../../src/renderer/stores/consoleStore'
import type { PickedPoint } from '../../../../src/renderer/utils/measure'

/** 造一个拾取点（默认两点重合的退化输入，只关心保留语义时够用）。 */
function makePicked(over: Partial<PickedPoint> = {}): PickedPoint {
  return {
    entityId: 1,
    entityName: 'a.las',
    chunkIndex: 0,
    vertexIndex: 0,
    local: { x: 0, y: 0, z: 0 },
    world: { x: 0, y: 0, z: 0 },
    original: { x: 0, y: 0, z: 0 },
    globalShift: { x: 0, y: 0, z: 0 },
    classification: null,
    ...over,
  }
}

/** 取某模式下第 i 个拾取点（坐标沿 X 轴递增，便于区分）。 */
function at(i: number): PickedPoint {
  return makePicked({ vertexIndex: i, local: { x: i, y: 0, z: 0 } })
}

/**
 * measureStore 是模块级单例，用例之间共享状态：每个用例开头显式复位
 * （退出模式 + 清空拾取 + 模式回单点）。setMode 对同值早退、不清空，故模式单独判断。
 */
function reset() {
  const store = useMeasureStore()
  if (store.active.value) store.exitMeasure()
  store.clearPicked()
  if (store.mode.value !== 'point') store.setMode('point')
}

/** 读 Console 尾部新增的日志（用例内只关心自己新增的那几条）。 */
function tailLogs(since: number) {
  const { entries } = useConsoleStore()
  return entries.slice(since)
}

describe('measureStore（模式生命周期）', () => {
  it('startMeasure 进入模式：清空拾取并写一行日志；重复调用被守卫挡下', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    expect(store.active.value).toBe(true)
    expect(store.mode.value).toBe('point') // 默认单点信息
    expect(store.picked.value).toEqual([])
    const after = tailLogs(0)
    const entry = after[after.length - 1]
    expect(entry.source).toBe('Measure')
    expect(entry.message).toContain('测量')

    // 重复调用：不清空已拾取的点、不重复写日志（active 守卫）
    store.pick(at(7))
    const n = useConsoleStore().entries.length
    store.startMeasure()
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([7])
    expect(useConsoleStore().entries.length).toBe(n)
  })

  it('exitMeasure 退出：清空拾取并写日志；未激活时静默返回', () => {
    reset()
    const store = useMeasureStore()
    const n0 = useConsoleStore().entries.length
    store.exitMeasure() // 未激活 → 无副作用
    expect(store.active.value).toBe(false)
    expect(useConsoleStore().entries.length).toBe(n0)

    store.startMeasure()
    store.pick(at(1))
    const n1 = useConsoleStore().entries.length
    store.exitMeasure()
    expect(store.active.value).toBe(false)
    expect(store.picked.value).toEqual([])
    const added = tailLogs(n1)
    expect(added).toHaveLength(1)
    expect(added[0].source).toBe('Measure')
  })
})

describe('measureStore（保留语义：单组，满员后重开）', () => {
  it('单点模式：容量 1，每次拾取都替换并产出一行日志', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    const n0 = useConsoleStore().entries.length

    store.pick(at(1))
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([1])
    expect(store.isFull.value).toBe(true)
    expect(store.result.value?.title).toBe('P#1')

    store.pick(at(2))
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([2])
    expect(tailLogs(n0)).toHaveLength(2) // 两次拾取 = 两次完成的测量
  })

  it('两点模式：第 1 点未满不产日志，第 2 点完成并写日志，第 3 点丢弃整组重开', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    store.setMode('distance')
    expect(store.capacity.value).toBe(2)
    const n0 = useConsoleStore().entries.length

    store.pick(at(1))
    expect(store.picked.value).toHaveLength(1)
    expect(store.result.value).toBeNull()
    expect(store.isFull.value).toBe(false)
    expect(tailLogs(n0)).toHaveLength(0) // 未满员：不打日志

    store.pick(at(2))
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([1, 2])
    expect(store.result.value?.title).toContain('距离')
    expect(tailLogs(n0)).toHaveLength(1)

    // 满员后再拾取：整组丢弃、只剩新点（CC 语义），重开未满员故不产日志
    store.pick(at(3))
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([3])
    expect(store.result.value).toBeNull()
    expect(tailLogs(n0)).toHaveLength(1)
  })

  it('三点模式：容量 3；第 4 点重开后，再凑满可再次产出结果', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    store.setMode('angle')
    expect(store.capacity.value).toBe(3)
    const n0 = useConsoleStore().entries.length

    store.pick(at(1))
    store.pick(at(2))
    expect(store.picked.value).toHaveLength(2)
    expect(store.result.value).toBeNull()
    expect(tailLogs(n0)).toHaveLength(0)

    store.pick(at(3))
    expect(store.picked.value).toHaveLength(3)
    expect(store.result.value?.title).toContain('角度')
    expect(tailLogs(n0)).toHaveLength(1)

    store.pick(at(4))
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([4])
    expect(tailLogs(n0)).toHaveLength(1)

    // 重开后再次凑满 → 第二次完成，日志再 +1
    store.pick(at(5))
    store.pick(at(6))
    expect(store.picked.value.map((p) => p.vertexIndex)).toEqual([4, 5, 6])
    expect(tailLogs(n0)).toHaveLength(2)
  })

  it('distance/angle 计算结果用 local 坐标（不受 world/位移影响）', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    store.setMode('distance')
    // world 差异巨大且带位移，结果必须仍按 local 算
    store.pick(
      makePicked({
        vertexIndex: 1,
        local: { x: 0, y: 0, z: 0 },
        world: { x: 1e6, y: 0, z: 0 },
        globalShift: { x: 500, y: 0, z: 0 },
      })
    )
    store.pick(
      makePicked({
        vertexIndex: 2,
        local: { x: 3, y: 4, z: 0 },
        world: { x: -1e6, y: 0, z: 0 },
        globalShift: { x: 501, y: 1, z: 1 },
      })
    )
    expect(store.result.value?.title).toBe('距离 5.0000')
  })
})

describe('measureStore（切模式 / 清除）', () => {
  it('setMode 清空已拾取的点；切到相同模式是空操作（保留已拾取的点）', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    store.setMode('distance')
    store.pick(at(1))
    expect(store.picked.value).toHaveLength(1)

    // 同值早退：不清空（浮条上重复点同一个模式按钮不应清掉进度）
    store.setMode('distance')
    expect(store.picked.value).toHaveLength(1)

    store.setMode('angle')
    expect(store.mode.value).toBe('angle')
    expect(store.picked.value).toEqual([])
    expect(store.result.value).toBeNull()
  })

  it('clearPicked 只清空拾取：不退出模式、不切模式、不写日志', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    store.pick(at(1))
    const n0 = useConsoleStore().entries.length

    store.clearPicked()
    expect(store.picked.value).toEqual([])
    expect(store.active.value).toBe(true)
    expect(useConsoleStore().entries.length).toBe(n0)
  })
})

describe('measureStore（响应性）', () => {
  it('解构出的 active/mode/capacity 是 computed 包装（原始值解构会失去响应性）', () => {
    reset()
    const { active, mode, capacity, picked } = useMeasureStore()
    expect(active.value).toBe(false)
    expect(capacity.value).toBe(1)

    useMeasureStore().startMeasure()
    expect(active.value).toBe(true)

    useMeasureStore().setMode('angle')
    expect(mode.value).toBe('angle')
    expect(capacity.value).toBe(3)
    expect(picked.value).toEqual([])
  })
})

describe('measureStore（日志内容）', () => {
  it('完成一次测量恰好一行：来源 Measure、含实体名与顶点号', () => {
    reset()
    const store = useMeasureStore()
    store.startMeasure()
    store.setMode('distance')
    const n0 = useConsoleStore().entries.length

    store.pick(makePicked({ entityName: 'a.las', vertexIndex: 11, local: { x: 0, y: 0, z: 0 } }))
    store.pick(makePicked({ entityName: 'b.las', vertexIndex: 22, local: { x: 3, y: 4, z: 0 } }))

    const added = tailLogs(n0)
    expect(added).toHaveLength(1)
    expect(added[0].source).toBe('Measure')
    expect(added[0].message).toBe('距离 5.0000（A P#11 ↔ B P#22）')
  })
})
