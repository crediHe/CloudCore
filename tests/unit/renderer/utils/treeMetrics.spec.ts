import { describe, it, expect } from 'vitest'
import {
  accumulateCrown,
  accumulateZ,
  createTreeAccumulator,
  DEFAULT_TREE_METRICS_OPTIONS,
  finishPass1,
  finishTree,
  fitCircleKasa,
  fitCircleRobust,
  isTreeClassification,
  SAMPLE_CAP,
} from '../../../../src/renderer/utils/treeMetrics'
import type { TreeAccumulator, TreeMetrics, TreeMetricsOptions } from '../../../../src/renderer/utils/treeMetrics'

/**
 * ⚠ 本文件的容差不按 double 卡：positions 是 **Float32Array**，写入时就有 ~1e-7 的相对量化误差
 * （10.15 存成 float32 是 10.1500005722…），故"解析解"的断言只能到 1e-5 量级（胸径 cm 值
 * 因此有 ~1e-4 的浮动）。这些是**输入精度**，不是算法误差——别为了"更严谨"把它们收紧。
 */

/** 把 [x, y, z] 列表铺成一块 positions。 */
function makeCloud(points: readonly number[][]): Float32Array {
  const out = new Float32Array(points.length * 3)
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0]
    out[i * 3 + 1] = points[i][1]
    out[i * 3 + 2] = points[i][2]
  }
  return out
}

/** 按块数切开（**保序**——分块不变性要求"拼起来还是原序"）。 */
function splitCloud(points: readonly number[][], chunks: number): Float32Array[] {
  const per = Math.ceil(points.length / chunks)
  const out: Float32Array[] = []
  for (let s = 0; s < points.length; s += per) out.push(makeCloud(points.slice(s, s + per)))
  return out
}

const NO_SHIFT = { x: 0, y: 0, z: 0 }

/** 跑完两趟（用于断言累加器中间状态）。 */
function runAcc(
  chunks: readonly Float32Array[],
  options: TreeMetricsOptions = DEFAULT_TREE_METRICS_OPTIONS,
  indexes: readonly (Uint32Array | null)[] = []
): TreeAccumulator {
  let total = 0
  for (let i = 0; i < chunks.length; i++) {
    const idx = indexes[i] ?? null
    total += idx ? idx.length : chunks[i].length / 3
  }
  const acc = createTreeAccumulator(total)
  for (let i = 0; i < chunks.length; i++) accumulateZ(acc, chunks[i], indexes[i] ?? null)
  finishPass1(acc, options)
  for (let i = 0; i < chunks.length; i++) accumulateCrown(acc, chunks[i], indexes[i] ?? null)
  return acc
}

/** 跑完两趟并组装（正常路径）。 */
function run(
  chunks: readonly Float32Array[],
  options: TreeMetricsOptions = DEFAULT_TREE_METRICS_OPTIONS,
  indexes: readonly (Uint32Array | null)[] = [],
  shift = NO_SHIFT
): TreeMetrics | null {
  return finishTree(runAcc(chunks, options, indexes), options, shift)
}

const TRUNK_R = 0.15
const TRUNK_CX = 10
const TRUNK_CY = 20

/** 树干：半径 TRUNK_R 的圆，给定层高、每层 perLevel 个方向。 */
function trunk(levels: readonly number[], perLevel = 8): number[][] {
  const out: number[][] = []
  for (const z of levels) {
    for (let k = 0; k < perLevel; k++) {
      const a = (k / perLevel) * Math.PI * 2
      out.push([TRUNK_CX + TRUNK_R * Math.cos(a), TRUNK_CY + TRUNK_R * Math.sin(a), z])
    }
  }
  return out
}

/**
 * 人造树：树干 13 层（含切片内 1.26 / 1.28 / 1.30 / 1.32 / 1.34 五层 = 40 点）
 * + 5 个冠层点（x/y 极值都是写死的整数，便于逐项对答案）。
 * 预期：树高 12、胸径 30 cm、冠幅 max(4, 3) = 4、冠层底高 8.4、切片点 40。
 */
const TREE: number[][] = [
  ...trunk([0, 0.5, 1.0, 1.26, 1.28, 1.3, 1.32, 1.34, 2.0, 3.0, 4.0, 5.0, 6.0]),
  [12, 20, 9], // 冠层 x 最大
  [8, 20, 8.6], // 冠层 x 最小
  [10, 21.5, 9.2], // 冠层 y 最大
  [10, 18.5, 10.5], // 冠层 y 最小
  [10, 20, 12], // 树顶
]

describe('isTreeClassification', () => {
  it('分类全落在 {4, 5} 且非空才算树', () => {
    expect(isTreeClassification([{ value: 4, count: 10 }])).toBe(true)
    expect(
      isTreeClassification([
        { value: 4, count: 10 },
        { value: 5, count: 3 },
      ])
    ).toBe(true)
  })

  it('混进别的类 / 全是别的类 / 空 / 未加载都不算树', () => {
    expect(
      isTreeClassification([
        { value: 4, count: 10 },
        { value: 2, count: 1 },
      ])
    ).toBe(false)
    expect(isTreeClassification([{ value: 2, count: 10 }])).toBe(false)
    expect(isTreeClassification([{ value: 6, count: 10 }])).toBe(false)
    expect(isTreeClassification([])).toBe(false)
    expect(isTreeClassification(null)).toBe(false)
    expect(isTreeClassification([{ value: 4, count: 0 }])).toBe(false)
  })
})

describe('treeMetrics 两趟扫描（人造树 → 已知答案）', () => {
  it('树高 / 胸径 / 冠幅 / 冠层底高 / 基准点 / 代表点逐项对上', () => {
    const m = run([makeCloud(TREE)])!
    expect(m.height).toBeCloseTo(12, 5)
    expect(m.dbh).toBeCloseTo(30, 3) // 半径 0.15 m ⇒ 30 cm
    expect(m.crownWidth).toBeCloseTo(4, 5)
    expect(m.crownWidthX).toBeCloseTo(4, 5)
    expect(m.crownWidthY).toBeCloseTo(3, 5)
    expect(m.crownBaseHeight).toBeCloseTo(8.4, 5) // (1 − 0.3) × 12
    expect(m.dbhHeight).toBe(1.3)
    expect(m.basePoint.x).toBeCloseTo(10.15, 4) // 层高 0 的第一个点（方向角 0）
    expect(m.basePoint.y).toBeCloseTo(20, 5)
    expect(m.basePoint.z).toBeCloseTo(0, 5)
    expect(m.representative!.x).toBeCloseTo(10, 4)
    expect(m.representative!.y).toBeCloseTo(20, 4)
    expect(m.representative!.z).toBeCloseTo(1.3, 5) // 基准 + 胸径高度
    // 冠层圈落点 = 冠层包围盒中心（x 8…12 / y 18.5…21.5）+ 冠层底高程
    expect(m.crownCenter!.x).toBeCloseTo(10, 9)
    expect(m.crownCenter!.y).toBeCloseTo(20, 9)
    expect(m.crownCenter!.z).toBeCloseTo(8.4, 9)
  })

  it('crownCenter 与冠幅严格同源（同出自那一对极值）：圈心必在包围盒中心', () => {
    // 偏心冠层：极值刻意不对称（x 8…14、y 16…21.5）⇒ 圈心必然跟到 (11, 18.75) 而不是原点方向
    const off: number[][] = [...trunk([0, 1.3, 2]), [14, 18, 9], [8, 21.5, 9.5], [11, 18, 12]]
    const m = run([makeCloud(off)])!
    expect(m.crownWidthX).toBeCloseTo(6, 9)
    expect(m.crownWidthY).toBeCloseTo(3.5, 9)
    expect(m.crownCenter!.x).toBeCloseTo((14 + 8) / 2, 9)
    expect(m.crownCenter!.y).toBeCloseTo((21.5 + 18) / 2, 9)
  })

  it('只要算得出结果，冠层必定非空 ⇒ crownCenter 非 null（null 只出现在 return null 那条路上）', () => {
    // 冠层底 = 基准 + (1 − 冠层比例) × 树高，恒 ≤ 最高点（比例被钳在 [0.01, 1]）
    // ⇒ 最高点永远落在冠层里，故 crownPoints ≥ 1。两条极端比例都验一遍。
    const lo = run([makeCloud(TREE)], { ...DEFAULT_TREE_METRICS_OPTIONS, crownRatio: 1 })!
    const hi = run([makeCloud(TREE)], { ...DEFAULT_TREE_METRICS_OPTIONS, crownRatio: 0.01 })!
    expect(lo.crownCenter).not.toBeNull()
    expect(hi.crownCenter).not.toBeNull()
    expect(hi.crownCenter!.z).toBeCloseTo(0 + 0.99 * 12, 9)
  })

  it('质量字段如实记录（切片点数 / 内点数 / rms / 冠层点数）', () => {
    const m = run([makeCloud(TREE)])!
    expect(m.quality.dbhMethod).toBe('circle')
    expect(m.quality.dbhSlicePoints).toBe(40)
    expect(m.quality.dbhInliers).toBe(40)
    expect(m.quality.dbhRms).toBeLessThan(1e-6)
    expect(m.quality.crownPoints).toBe(5)
  })

  it('坐标：算出来的三个点加回 globalShift，其余量与之无关', () => {
    const shift = { x: 100, y: -50, z: 300 }
    const m = run([makeCloud(TREE)], DEFAULT_TREE_METRICS_OPTIONS, [], shift)!
    const plain = run([makeCloud(TREE)])!
    expect(m.basePoint.x).toBeCloseTo(plain.basePoint.x + 100, 9)
    expect(m.basePoint.y).toBeCloseTo(plain.basePoint.y - 50, 9)
    expect(m.basePoint.z).toBeCloseTo(plain.basePoint.z + 300, 9)
    expect(m.representative!.z).toBeCloseTo(1.3 + 300, 9)
    expect(m.crownCenter!.x).toBeCloseTo(plain.crownCenter!.x + 100, 9)
    expect(m.crownCenter!.y).toBeCloseTo(plain.crownCenter!.y - 50, 9)
    expect(m.crownCenter!.z).toBeCloseTo(plain.crownCenter!.z + 300, 9)
    expect(m.height).toBe(plain.height)
    expect(m.dbh).toBe(plain.dbh)
    expect(m.crownWidth).toBe(plain.crownWidth)
  })

  it('分块不变性：同一点云切 1 / 3 / 7 块结果逐位相等', () => {
    const one = run([makeCloud(TREE)])!
    expect(run(splitCloud(TREE, 3))).toEqual(one)
    expect(run(splitCloud(TREE, 7))).toEqual(one)
  })

  it('index（候选子集）语义：只算被圈中的那些点', () => {
    // 两棵相距很远的树：A（半径 0.15，本测试的目标）与 B（半径 0.35，全在更高处）
    const a = trunk([0, 1.26, 1.28, 1.3, 1.32, 1.34, 2])
    const b = trunk([5, 6, 7], 8).map(([x, y, z]) => [x + 20, y, z + 5])
    const points = [...a, ...b]
    const idx = new Uint32Array(a.map((_, i) => i)) // 只圈 A
    const m = run([makeCloud(points)], DEFAULT_TREE_METRICS_OPTIONS, [idx])!
    expect(m.height).toBeCloseTo(2, 5) // 只数 A（0…2）
    expect(m.dbh).toBeCloseTo(30, 3)
    expect(m.representative!.x).toBeCloseTo(10, 4)
    expect(m.representative!.y).toBeCloseTo(20, 4)
  })

  it('矮树（不足 1.3 m）：切片为空 ⇒ 不报胸径、代表点为 null，其余照算', () => {
    const short = [
      [10, 20, 0],
      [10.2, 20, 0.5],
      [10, 20.2, 0.8],
      [10, 20, 1.0],
    ]
    const m = run([makeCloud(short)])!
    expect(m.height).toBeCloseTo(1.0, 5)
    expect(m.dbh).toBe(0)
    expect(m.quality.dbhMethod).toBe('none')
    expect(m.quality.dbhSlicePoints).toBe(0)
    expect(m.representative).toBeNull()
    expect(m.crownWidth).toBeCloseTo(0.2, 5) // 冠层只有 z ≥ 0.7 的两点
    expect(m.crownWidthX).toBeCloseTo(0, 5)
  })

  it('NaN 点被跳过，且不影响结果（与去掉它们逐位相同）', () => {
    const withNaN = [...TREE, [NaN, NaN, NaN], [10, 20, NaN]]
    expect(run([makeCloud(withNaN)])).toEqual(run([makeCloud(TREE)]))
  })

  it('空云 / 全 NaN ⇒ null（调用方当作不可算）', () => {
    expect(run([makeCloud([])])).toBeNull()
    expect(run([makeCloud([[NaN, NaN, NaN]])])).toBeNull()
  })

  it('基准分位数：q = 0 用真最低点，q > 0 把离群低点剔掉、树高随之变短', () => {
    // 101 个点（z = 0, 0.1, … 10）+ 1 个离群低点（z = −5）
    const pts: number[][] = [[10, 20, -5]]
    for (let i = 0; i <= 100; i++) pts.push([10, 20, i / 10])

    const plain = run([makeCloud(pts)], { ...DEFAULT_TREE_METRICS_OPTIONS, baseQuantile: 0 })!
    expect(plain.height).toBeCloseTo(15, 5) // 10 − (−5)
    expect(plain.basePoint.z).toBeCloseTo(-5, 5)

    // q = 0.05：102 个样本 ⇒ 升序第 ⌈0.05 × 102⌉ = 6 个 = idx 5 = 0.4（真实点的高程）
    const trimmed = run([makeCloud(pts)], { ...DEFAULT_TREE_METRICS_OPTIONS, baseQuantile: 0.05 })!
    expect(trimmed.basePoint.z).toBeCloseTo(0.4, 5)
    expect(trimmed.height).toBeCloseTo(9.6, 5)
  })

  it('极端参数被钳到可用区间（钳前 == 钳后，且不产生 NaN）', () => {
    const wild = run([makeCloud(TREE)], {
      dbhHeight: -5,
      sliceThickness: 0,
      crownRatio: 5,
      baseQuantile: 0.9,
    })!
    const clamped = run([makeCloud(TREE)], {
      dbhHeight: 0,
      sliceThickness: 0.001,
      crownRatio: 1,
      baseQuantile: 0.5,
    })!
    expect(wild).toEqual(clamped)
    expect(Number.isFinite(wild.height)).toBe(true)
    expect(wild.basePoint.z).toBeLessThanOrEqual(12)
    expect(wild.height).toBeGreaterThanOrEqual(0)
  })
})

describe('treeMetrics 抽样（SAMPLE_CAP）', () => {
  // 20 层 × 3000 点 = 60000 点（全部在半径 0.15 的圆上），其中 5 层落在切片内
  const LEVELS = [0, 0.4, 0.8, 1.0, 1.15, 1.26, 1.28, 1.3, 1.32, 1.34, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const DENSE = trunk(LEVELS, 3000)

  it('大云：样本数不超上限，切片点数仍是精确值，圆照样拟合出来', () => {
    const acc = runAcc([makeCloud(DENSE)])
    expect(acc.stride).toBe(Math.ceil(60000 / SAMPLE_CAP)) // 8
    expect(acc.zSamples.length).toBeLessThanOrEqual(SAMPLE_CAP)
    expect(acc.zSamples.length).toBeGreaterThan(SAMPLE_CAP / 2) // 步长就是按上限推的，不能抽得过稀
    const m = finishTree(acc, DEFAULT_TREE_METRICS_OPTIONS, NO_SHIFT)!
    expect(m.quality.dbhSlicePoints).toBe(15000) // 5 层 × 3000（精确统计，不受抽样影响）
    expect(m.quality.dbhMethod).toBe('circle')
    expect(m.dbh).toBeCloseTo(30, 3)
    expect(m.height).toBeCloseTo(10, 5)
    expect(m.crownWidth).toBeCloseTo(0.3, 5) // 冠层 = 半径 0.15 的圆环
  })

  it('大云的分块不变性（抽样计数器跨块共享，故切块不改结果）', () => {
    const one = run([makeCloud(DENSE)])!
    expect(run(splitCloud(DENSE, 3))).toEqual(one)
    expect(run(splitCloud(DENSE, 7))).toEqual(one)
  })
})

describe('fitCircleKasa', () => {
  it('已知圆 + 未知偏移：圆心 / 半径 / rms 都对上', () => {
    const xs: number[] = []
    const ys: number[] = []
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2
      xs.push(3 + 0.4 * Math.cos(a))
      ys.push(-2 + 0.4 * Math.sin(a))
    }
    const fit = fitCircleKasa(xs, ys)!
    expect(fit.cx).toBeCloseTo(3, 9)
    expect(fit.cy).toBeCloseTo(-2, 9)
    expect(fit.r).toBeCloseTo(0.4, 9)
    expect(fit.rms).toBeLessThan(1e-12)
  })

  it('正方形四角的外接圆（闭式解的手算例子）', () => {
    const fit = fitCircleKasa([0, 1, 0, 1], [0, 0, 1, 1])!
    expect(fit.cx).toBeCloseTo(0.5, 12)
    expect(fit.cy).toBeCloseTo(0.5, 12)
    expect(fit.r).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('坐标原点在 1e5 量级时不解出病态值（先中心化的意义）', () => {
    const xs: number[] = []
    const ys: number[] = []
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2
      xs.push(1e5 + 0.4 * Math.cos(a))
      ys.push(-1e5 + 0.4 * Math.sin(a))
    }
    const fit = fitCircleKasa(xs, ys)!
    expect(fit.cx).toBeCloseTo(1e5, 3)
    expect(fit.cy).toBeCloseTo(-1e5, 3)
    expect(fit.r).toBeCloseTo(0.4, 6)
  })

  it('点少于 3 个 / 全重合 / 全共线 ⇒ null（退化交给调用方兜底）', () => {
    expect(fitCircleKasa([1, 2], [3, 4])).toBeNull()
    expect(fitCircleKasa([1, 1, 1], [3, 3, 3])).toBeNull()
    const line = Array.from({ length: 40 }, (_, i) => i)
    expect(
      fitCircleKasa(
        line.map((i) => 10 + 0.01 * i),
        line.map((i) => 20 + 0.02 * i)
      )
    ).toBeNull()
  })
})

describe('fitCircleRobust', () => {
  /** 半径 0.15、圆心 (10, 20) 的圆上均匀取 n 个点。 */
  function ring(n: number, r = TRUNK_R, cx = TRUNK_CX, cy = TRUNK_CY): { xs: number[]; ys: number[] } {
    const xs: number[] = []
    const ys: number[] = []
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      xs.push(cx + r * Math.cos(a))
      ys.push(cy + r * Math.sin(a))
    }
    return { xs, ys }
  }

  it('注入 30% 同心外点（最坏情况：圆环被整体撑大）仍回到真圆', () => {
    const inner = ring(40)
    const outer = ring(12, 0.9)
    const res = fitCircleRobust([...inner.xs, ...outer.xs], [...inner.ys, ...outer.ys])!
    expect(res.fit.r).toBeCloseTo(TRUNK_R, 6)
    expect(res.fit.cx).toBeCloseTo(TRUNK_CX, 6)
    expect(res.fit.cy).toBeCloseTo(TRUNK_CY, 6)
    expect(res.inliers).toBe(40)
    // 直接 Kåsa（无抗差）在同一份数据上会被撑到 0.45 上下 —— 这正是需要 RANSAC 的理由
    expect(fitCircleKasa([...inner.xs, ...outer.xs], [...inner.ys, ...outer.ys])!.r).toBeGreaterThan(0.4)
  })

  it('一侧挂一团低枝（把最小二乘圆心整体拉偏）仍回到真圆', () => {
    const inner = ring(40)
    const branch: number[] = []
    const branchY: number[] = []
    for (let k = 0; k < 15; k++) {
      branch.push(11.5 + 0.1 * Math.cos(k))
      branchY.push(20 + 0.3 * Math.sin(k * 2))
    }
    const res = fitCircleRobust([...inner.xs, ...branch], [...inner.ys, ...branchY])!
    expect(res.fit.r).toBeCloseTo(TRUNK_R, 6)
    expect(res.fit.cx).toBeCloseTo(TRUNK_CX, 6)
    expect(res.inliers).toBe(40)
  })

  it('低枝离树干够远时，「大假圆同时吞下树干与低枝」不能成立（内点带 5 mm 的意义）', () => {
    // 树干 r = 0.15 与 1.35 m 外的枝团：弦高 L²/(16r) 说明内点带一大就能被大圆通吃，
    // 5 mm 的带 + 采纳区间（r ≤ 1.0）把这条路堵死——真圆仍以 40 个内点胜出
    const inner = ring(40)
    const branch: number[] = []
    const branchY: number[] = []
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2
      branch.push(11.35 + 0.05 * Math.cos(a))
      branchY.push(20 + 0.05 * Math.sin(a))
    }
    const res = fitCircleRobust([...inner.xs, ...branch], [...inner.ys, ...branchY])!
    expect(res.fit.r).toBeCloseTo(TRUNK_R, 6)
    expect(res.inliers).toBe(40) // 枝团的 20 个点一个都不算内点
  })

  it('确定性：同一切片两次逐位相等（RANSAC 用固定种子，不引 Math.random）', () => {
    const inner = ring(24)
    const outer = ring(9, 0.6)
    const a = fitCircleRobust([...inner.xs, ...outer.xs], [...inner.ys, ...outer.ys])
    const b = fitCircleRobust([...inner.xs, ...outer.xs], [...inner.ys, ...outer.ys])
    expect(a).toEqual(b)
  })

  it('点太少 / 共线 ⇒ null', () => {
    expect(fitCircleRobust([1, 2], [3, 4])).toBeNull()
    const line = Array.from({ length: 30 }, (_, i) => i)
    expect(
      fitCircleRobust(
        line.map((i) => 0.01 * i),
        line.map((i) => 0.02 * i)
      )
    ).toBeNull()
  })
})

describe('退化切片的兜底（不编造数字）', () => {
  it('切片点是一条直线（歪树干）⇒ 圆拟合拒绝、胸径报 0、代表点退回切片质心', () => {
    const slice = Array.from({ length: 40 }, (_, i) => [10 + 0.01 * i, 20 + 0.02 * i, 1.3])
    const crown = [
      [12.5, 20, 9],
      [8, 20, 8.5],
      [10, 22, 9.5],
      [10, 18, 10],
      [10, 20, 12],
    ]
    const m = run([makeCloud([[10, 20, 0], ...slice, ...crown])])!
    expect(m.quality.dbhMethod).toBe('centroid')
    expect(m.dbh).toBe(0)
    expect(m.quality.dbhInliers).toBe(0)
    expect(m.representative!.x).toBeCloseTo(10.195, 5) // 40 点的均值（10 + 0.01 × 19.5）
    expect(m.representative!.y).toBeCloseTo(20.39, 5)
    expect(m.representative!.z).toBeCloseTo(1.3, 5)
    expect(m.height).toBeCloseTo(12, 5)
    expect(m.crownWidth).toBeCloseTo(4.5, 5)
  })
})
