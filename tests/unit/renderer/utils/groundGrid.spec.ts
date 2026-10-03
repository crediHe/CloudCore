import { describe, it, expect } from 'vitest'
import {
  buildGroundGrid,
  sampleGround,
  sampleHag,
  GROUND_GRID_DEFAULT_CELL_SIZE,
  GROUND_GRID_MAX_CELLS,
} from '../../../../src/renderer/utils/groundGrid'

// 纯函数组：不碰 three / DOM / store，node 环境直接跑（无需 native 产物）。

/** 由 [x, y, z] 三元组建一个坐标块。 */
function positionsOf(points: number[][]): Float32Array {
  const arr = new Float32Array(points.length * 3)
  points.forEach((p, i) => {
    arr[i * 3] = p[0]
    arr[i * 3 + 1] = p[1]
    arr[i * 3 + 2] = p[2]
  })
  return arr
}

/** 全量下标（该块所有顶点都是地面点）。 */
function allIndices(count: number): Uint32Array {
  const idx = new Uint32Array(count)
  for (let i = 0; i < count; i++) idx[i] = i
  return idx
}

describe('groundGrid（地面参考面：逐格最低点 + 多源 BFS 填洞 + 双线性采样）', () => {
  it('格心原点与格数：包围盒按地面点算，格心在 origin + col*cellSize', () => {
    const grid = buildGroundGrid(
      [positionsOf([[0, 0, 10], [10, 0, 10], [0, 10, 10], [10, 10, 10]])],
      [allIndices(4)],
      10
    )
    expect(grid).not.toBeNull()
    expect(grid!.cols).toBe(2)
    expect(grid!.rows).toBe(2)
    expect(grid!.cellSize).toBe(10)
    expect(grid!.originX).toBe(0)
    expect(grid!.originY).toBe(0)
    expect(Array.from(grid!.values)).toEqual([10, 10, 10, 10])
  })

  it('格值取格内**最低**点：一个离群高点不抬高格子（HAG 只会偏大，不会偏小）', () => {
    // 同格（间距 1 m ≪ 10 m 格）三点，最高的是树冠/噪声
    const grid = buildGroundGrid([positionsOf([[1, 1, 5], [2, 2, 9], [3, 3, 7]])], [allIndices(3)], 10)
    expect(Array.from(grid!.values)).toEqual([5])
  })

  it('空洞用邻格均值填平：填后无 NaN，且落在初始格值区间内', () => {
    // 一行三格，中间格无地面点
    const grid = buildGroundGrid([positionsOf([[0, 0, 10], [20, 0, 30]])], [allIndices(2)], 10)
    expect(grid!.cols).toBe(3)
    expect(grid!.rows).toBe(1)
    expect(grid!.values[1]).toBe(20) // (10 + 30) / 2
    expect(Array.from(grid!.values).some((v) => Number.isNaN(v))).toBe(false)
  })

  it('双线性：格心取原值、两格中点取均值、越界钳到边缘格', () => {
    // z = x 的斜坡：格心在 x=0 / 10，值 0 / 10
    const grid = buildGroundGrid([positionsOf([[0, 0, 0], [10, 0, 10]])], [allIndices(2)], 10)!
    expect(sampleGround(grid, 0, 0)).toBe(0)
    expect(sampleGround(grid, 10, 0)).toBe(10)
    expect(sampleGround(grid, 5, 0)).toBe(5) // 线性场 → 双线性精确
    expect(sampleGround(grid, 2.5, 0)).toBe(2.5)
    expect(sampleGround(grid, -100, -100)).toBe(0) // 钳到 (0,0)
    expect(sampleGround(grid, 1e6, 1e6)).toBe(10) // 钳到 (1,0)
    expect(sampleGround(grid, 5, 1e6)).toBe(5) // y 越界钳位、x 照常插值
  })

  it('sampleHag = 点高程 − 采样地面高程', () => {
    const grid = buildGroundGrid([positionsOf([[0, 0, 100], [10, 0, 110]])], [allIndices(2)], 10)!
    expect(sampleHag(grid, 5, 0, 130)).toBe(25) // 地面上 105 → 离地 25
  })

  it('多块累加：地面点分散在多个块里也算同一张面', () => {
    const grid = buildGroundGrid(
      [positionsOf([[0, 0, 10]]), positionsOf([[20, 0, 30]])],
      [allIndices(1), allIndices(1)],
      10
    )!
    expect(grid.cols).toBe(3)
    expect(grid.values[0]).toBe(10)
    expect(grid.values[2]).toBe(30)
    expect(grid.values[1]).toBe(20)
  })

  it('只有部分块有地面点（其余块给 null）时照常建面，null 块的点完全不参与', () => {
    const grid = buildGroundGrid(
      [positionsOf([[50, 0, 999]]), positionsOf([[0, 0, 10], [10, 0, 20], [20, 0, 30]])],
      [null, allIndices(3)],
      10
    )!
    expect(grid.cols).toBe(3) // 第一块（null）若被误算进来会拉到 x=50 → 6 格
    expect(Array.from(grid.values)).toEqual([10, 20, 30])
  })

  it('格边长自动放大：超上限时不断翻倍，返回值里是**实际用的**那个', () => {
    const grid = buildGroundGrid([positionsOf([[0, 0, 0], [100000, 100000, 0]])], [allIndices(2)], 5)!
    expect(grid.cellSize).toBe(160)
    expect(grid.cols * grid.rows).toBeLessThanOrEqual(GROUND_GRID_MAX_CELLS)
    // 1024 格边长下 100000 m 跨度只需要 626 格
    expect(grid.cols).toBe(626)
  })

  it('退化输入：无地面点 → null；块数不一致 → 抛错；cellSize 非法 → 用默认值', () => {
    expect(buildGroundGrid([new Float32Array(0)], [null], 5)).toBeNull()
    expect(buildGroundGrid([new Float32Array(0)], [new Uint32Array(0)], 5)).toBeNull()
    expect(() => buildGroundGrid([positionsOf([[0, 0, 0]])], [], 5)).toThrow(/入参不一致/)
    const degenerate = buildGroundGrid([positionsOf([[0, 0, 0]])], [allIndices(1)], 0)!
    expect(degenerate.cellSize).toBe(GROUND_GRID_DEFAULT_CELL_SIZE)
    const nan = buildGroundGrid([positionsOf([[0, 0, 0]])], [allIndices(1)], Number.NaN)!
    expect(nan.cellSize).toBe(GROUND_GRID_DEFAULT_CELL_SIZE)
  })

  it('非有限的坐标被跳过（不会污染包围盒，也不会把 NaN 留在格网里）', () => {
    const grid = buildGroundGrid(
      [positionsOf([[0, 0, 5], [Number.NaN, 0, 99], [10, 10, 5]])],
      [allIndices(3)],
      10
    )!
    expect(Array.from(grid.values).some((v) => Number.isNaN(v))).toBe(false)
    expect(grid.originX).toBe(0)
    expect(grid.cols).toBe(2)
  })

  it('确定性：同输入两次构建逐位相等（填洞的 BFS 顺序也只由输入决定）', () => {
    const positions = positionsOf([[0, 0, 1], [40, 0, 2], [0, 40, 3], [40, 40, 4]])
    const a = buildGroundGrid([positions], [allIndices(4)], 10)!
    const b = buildGroundGrid([positions], [allIndices(4)], 10)!
    expect(Array.from(a.values)).toEqual(Array.from(b.values))
    expect(a.values.length).toBe(25) // 5×5，中间一片空洞被填满
  })
})
