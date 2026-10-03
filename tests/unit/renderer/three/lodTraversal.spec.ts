import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  LOD_NODE_INSIDE,
  LOD_NODE_INTERSECT,
  LOD_NODE_OUTSIDE,
  LOD_BALANCE_SHARE,
  createLodTreeState,
  flagVisibility,
  gatherLodPoints,
  planLodBudget,
  type LodBudgetEntry,
  type LodFrustum,
  type LodFrustumPlane,
} from '../../../../src/renderer/three/lodTraversal'
import { buildLodTreeResult as buildResult, twoBranchLodTree, uniformLeafLodTree } from './lodTreeFixture'

// 纯函数 + 注入式视锥，node 环境即可（不依赖 DOM），无需 jsdom 注释。
// 人造节点表的构造见 ./lodTreeFixture（与 lodScheduler.spec 共用）。

/**
 * 正交视锥（相机在 +Z 朝原点看）：世界空间里就是一个轴对称的盒子
 * x ∈ [-W, W]、y ∈ [-W, W]、z ∈ [D-2000, D]，足以精确表达"看得见哪半边"。
 *
 * 用真相机而不是手写平面，是为了顺带验证「three 的 `Frustum.planes` 直接喂给
 * flagVisibility」这条生产路径的形状（法线朝内、constant 的符号约定）。
 */
function boxFrustum(halfWidth: number, distance = 1000): LodFrustum {
  const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfWidth, -halfWidth, 0.1, 2 * distance)
  camera.position.set(0, 0, distance)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const mvp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  return new THREE.Frustum().setFromProjectionMatrix(mvp)
}

/** 手写平面的视锥（法线朝内侧）：用来造"完全错开""恰好跨过外接球"这类精确边界。 */
function planesFrustum(...planes: LodFrustumPlane[]): LodFrustum {
  return { planes }
}

/** 沿 +X 的一个平面：点到平面的带符号距离 = x + constant。 */
function planeX(constant: number): LodFrustumPlane {
  return { normal: { x: 1, y: 0, z: 0 }, constant }
}

/** 取一次点（按预算取），返回 id 数组。 */
function gather(tree: ReturnType<typeof createLodTreeState>, budget: number): number[] {
  const ids = new Uint32Array(budget > 0 ? budget : 1)
  const count = gatherLodPoints(tree, budget, ids)
  return Array.from(ids.subarray(0, count))
}

describe('LOD 遍历：三态视锥标记', () => {
  it('视锥罩住整棵树：根标记 INSIDE 且不再下钻（子节点保持默认 OUTSIDE）', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    const visible = flagVisibility(tree, boxFrustum(400))
    expect(visible).toBe(200)
    expect(tree.visiblePoints).toBe(200)
    expect(tree.states[0]).toBe(LOD_NODE_INSIDE)
    // 关键：INSIDE 不下钻标记，子节点停在默认的 OUTSIDE —— gather 靠 insideAncestor 接力
    // （若这里被标成 OUTSIDE 而 gather 又没有接力，整棵树会一个点都取不出来）
    expect(tree.states[1]).toBe(LOD_NODE_OUTSIDE)
    expect(tree.states[2]).toBe(LOD_NODE_OUTSIDE)
  })

  it('视锥只罩住一支：该支 INSIDE、另一支 OUTSIDE、根 INTERSECT，可见点数只算前者', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    const visible = flagVisibility(tree, boxFrustum(50))
    expect(visible).toBe(100) // 只有原点那支（x = 0）在盒内
    expect(tree.states[0]).toBe(LOD_NODE_INTERSECT)
    expect(tree.states[1]).toBe(LOD_NODE_OUTSIDE) // x = -100：球心到面距离 -50 < -34.64
    expect(tree.states[2]).toBe(LOD_NODE_INSIDE)
  })

  it('视锥完全错开：整棵树 OUTSIDE，可见点数 0', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    // 平面在 x = -1000（法线朝 +X）→ 所有节点都在外侧，距离 < -半径
    const visible = flagVisibility(tree, planesFrustum(planeX(-1000)))
    expect(visible).toBe(0)
    expect(Array.from(tree.states)).toEqual([0, 0, 0])
  })

  it('INTERSECT 但子节点全不可见 → 自己降级为 OUTSIDE（gather 不必再走这条分支）', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    // 平面把根的外接球（半径 346.4，中心 0）切成 INTERSECT，却把两个子节点
    // （半径 34.64）都推到外侧：constant = -60 → 根 d = -60 > -346.4、子节点 d = -60-100 = -160 < -34.6
    const visible = flagVisibility(tree, planesFrustum(planeX(-60)))
    expect(visible).toBe(0)
    expect(tree.states[0]).toBe(LOD_NODE_OUTSIDE)
  })

  it('重新标记会先清空上一轮的标记（相机变了的语义）', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    flagVisibility(tree, boxFrustum(400))
    expect(tree.states[0]).toBe(LOD_NODE_INSIDE)
    flagVisibility(tree, boxFrustum(50))
    expect(tree.states[0]).toBe(LOD_NODE_INTERSECT)
    expect(tree.visiblePoints).toBe(100)
  })

  it('外接球跨过平面 → INTERSECT（半径余量参与判据）', () => {
    // 单个叶子节点：中心 x = 0、边长 40 → 半径 34.64
    const leaf = () => createLodTreeState(buildResult({ center: [0, 0, 0], size: 40, points: 10 }))
    // 距离 30 < 半径 → 既不在外侧也不在内侧
    const straddle = leaf()
    expect(flagVisibility(straddle, planesFrustum(planeX(30)))).toBe(10)
    expect(straddle.states[0]).toBe(LOD_NODE_INTERSECT)
    // 距离 40 > 半径 → INSIDE
    const inside = leaf()
    expect(flagVisibility(inside, planesFrustum(planeX(40)))).toBe(10)
    expect(inside.states[0]).toBe(LOD_NODE_INSIDE)
    // 距离 -40 < -半径 → OUTSIDE
    const outside = leaf()
    expect(flagVisibility(outside, planesFrustum(planeX(-40)))).toBe(0)
    expect(outside.states[0]).toBe(LOD_NODE_OUTSIDE)
  })
})

describe('LOD 遍历：实体级预算分配', () => {
  it('按可见点数成比例分配（不是先到先得），且预算被吃满', () => {
    const entries: LodBudgetEntry[] = [
      { visible: 900_000, capacity: 900_000, quota: 0 },
      { visible: 300_000, capacity: 300_000, quota: 0 },
    ]
    planLodBudget(entries, 400_000)
    expect(entries[0].quota + entries[1].quota).toBe(400_000) // 两者都还没拿满 → 预算不剩
    // 纯按比例是 3:1，均衡项把小实体抬到 300000/4 附近，故略低于 3（约 2.4）
    const ratio = entries[0].quota / entries[1].quota
    expect(ratio).toBeGreaterThan(2)
    expect(ratio).toBeLessThan(3)
  })

  it('均衡项保证小实体不被淹没（几百万点 vs 几千点）', () => {
    const entries: LodBudgetEntry[] = [
      { visible: 100_000_000, capacity: 524_288, quota: 0 },
      { visible: 2_000, capacity: 524_288, quota: 0 },
    ]
    planLodBudget(entries, 524_288)
    // 小实体直接拿满（它的需求量比均衡项还小），大实体吃掉剩下的全部
    expect(entries[1].quota).toBe(2_000)
    expect(entries[0].quota).toBe(524_288 - 2_000)
    expect(entries[0].quota).toBeGreaterThanOrEqual(Math.ceil((524_288 * LOD_BALANCE_SHARE) / 2))
  })

  it('小实体至少拿到均衡项份额（需求足够大时）', () => {
    const entries: LodBudgetEntry[] = [
      { visible: 100_000_000, capacity: 524_288, quota: 0 },
      { visible: 100_000, capacity: 524_288, quota: 0 },
    ]
    planLodBudget(entries, 524_288)
    // 1000:1 的悬殊下纯比例会给出约 524 点，均衡项把它抬到 budget×0.25/2
    expect(entries[1].quota).toBeGreaterThanOrEqual(Math.ceil((524_288 * LOD_BALANCE_SHARE) / 2))
    expect(entries[1].quota).toBeLessThanOrEqual(100_000)
    expect(entries[0].quota + entries[1].quota).toBe(524_288)
  })

  it('配额不超各自容量、不超可见点数、总和不超预算', () => {
    const entries: LodBudgetEntry[] = [
      { visible: 1_000_000, capacity: 1000, quota: 0 }, // 实体巨大但 staging 容量小
      { visible: 50, capacity: 524_288, quota: 0 },
      { visible: 0, capacity: 524_288, quota: 0 }, // 视锥外
    ]
    planLodBudget(entries, 100_000)
    expect(entries[0].quota).toBe(1000)
    expect(entries[1].quota).toBe(50)
    expect(entries[2].quota).toBe(0)
    expect(entries[0].quota + entries[1].quota).toBeLessThanOrEqual(100_000)
  })

  it('预算足够时每个可见实体都拿满（min(可见点数, 容量)）', () => {
    const entries: LodBudgetEntry[] = [
      { visible: 300, capacity: 524_288, quota: 0 },
      { visible: 900_000, capacity: 5000, quota: 0 },
    ]
    planLodBudget(entries, 524_288)
    expect(entries[0].quota).toBe(300)
    expect(entries[1].quota).toBe(5000)
  })

  it('无可见实体 / 零预算：全部配额为 0', () => {
    const none: LodBudgetEntry[] = [
      { visible: 0, capacity: 100, quota: 7 },
      { visible: 0, capacity: 100, quota: 7 },
    ]
    planLodBudget(none, 1000)
    expect(none.map((e) => e.quota)).toEqual([0, 0])
    const zero: LodBudgetEntry[] = [{ visible: 10, capacity: 10, quota: 5 }]
    planLodBudget(zero, 0)
    expect(zero[0].quota).toBe(0)
  })
})

describe('LOD 遍历：叶子取点', () => {
  it('根 INSIDE 时仍能取满（insideAncestor 接力，见三态标记用例）', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    flagVisibility(tree, boxFrustum(400))
    const ids = gather(tree, 1000)
    expect(ids).toHaveLength(200)
    expect(new Set(ids).size).toBe(200) // 无重复：点只从叶子取
    expect(ids.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i))
  })

  it('只取可见分支的点（被剪掉的子树一个点都不出）', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    flagVisibility(tree, boxFrustum(50))
    const ids = gather(tree, 1000)
    expect(ids).toHaveLength(100)
    // 叶子区间由 buildResult 顺序分配：先 A（0..99）后 B（100..199），可见的是 B
    expect(ids.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 100))
  })

  it('预算小于可见点数时按比例取、且不超预算', () => {
    const result = buildResult({
      center: [0, 0, 0],
      size: 400,
      children: [
        { center: [-10, 0, 0], size: 40, points: 1000 },
        { center: [10, 0, 0], size: 40, points: 3000 },
      ],
    })
    const tree = createLodTreeState(result)
    flagVisibility(tree, boxFrustum(400))
    const ids = gather(tree, 400)
    expect(ids).toHaveLength(400)
    expect(new Set(ids).size).toBe(400)
    // 1000:3000 = 1:3 → 各 100 / 300
    const fromFirst = ids.filter((id) => id < 1000).length
    expect(fromFirst).toBe(100)
  })

  it('叶内取点在整个区间上铺开（不是搬前 N 个：块主序前缀会让点挤在叶子一角）', () => {
    // 1000 点的单叶子，预算 100 → 步长 10。若退化成"搬区间的前 100 个"，取出的点就
    // 只覆盖区间的前 10%——而叶子区间是块主序（= 扫描序），画面上即规则条纹 / 栅格状缺失。
    const tree = createLodTreeState(uniformLeafLodTree(1, 1000))
    flagVisibility(tree, boxFrustum(400))
    const ids = gather(tree, 100)
    expect(ids).toHaveLength(100)
    expect(new Set(ids).size).toBe(100)
    expect(Math.min(...ids)).toBe(0)
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(985) // 铺到区间末尾
    // 相邻取点的间隔 ≈ 步长：既不会出现整段空洞（前缀），也不会重复取同一点
    const gaps = ids.slice(1).map((id, i) => id - ids[i])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(11)
  })

  it('预算变大时**取到的点集只增不减**（加密是纯加法，画面不会闪）', () => {
    const result = buildResult({
      center: [0, 0, 0],
      size: 400,
      children: [
        { center: [-10, 0, 0], size: 40, points: 5000 },
        { center: [10, 0, 0], size: 40, points: 5000 },
      ],
    })
    const tree = createLodTreeState(result)
    flagVisibility(tree, boxFrustum(400))
    let previous = new Set<number>()
    for (const budget of [1000, 2000, 4000, 8000, 10_000]) {
      const ids = new Set(gather(tree, budget))
      expect(ids.size).toBeLessThanOrEqual(budget)
      for (const id of previous) expect(ids.has(id)).toBe(true)
      expect(ids.size).toBeGreaterThanOrEqual(previous.size)
      previous = ids
    }
    expect(previous.size).toBe(10_000) // 预算覆盖全树 → 全量
  })

  it('同一状态重复取点结果一致（确定性，加密那几帧只靠配额区分）', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    flagVisibility(tree, boxFrustum(400))
    expect(gather(tree, 150)).toEqual(gather(tree, 150))
  })

  it('整棵树不可见 → 0 点；零预算 → 0 点', () => {
    const tree = createLodTreeState(twoBranchLodTree())
    flagVisibility(tree, planesFrustum(planeX(-1000)))
    expect(gather(tree, 1000)).toEqual([])
    flagVisibility(tree, boxFrustum(400))
    expect(gather(tree, 0)).toEqual([])
  })

  it('零点的叶子安全返回 0（空实体 / 解析期空块）', () => {
    const empty = createLodTreeState(buildResult({ center: [0, 0, 0], size: 1, points: 0 }))
    expect(empty.result.nodeCount).toBe(1)
    expect(flagVisibility(empty, boxFrustum(400))).toBe(0)
    expect(gather(empty, 100)).toEqual([])
  })

  it('多 chunk 的打包 id 原样取出（遍历不解释 id，只搬游程）', () => {
    // 两个叶子分属不同 chunk：遍历只负责把打包 id 搬出来，解码在显示层做
    const result = twoBranchLodTree()
    const packed = result.pointIds.map((id, i) => (i < 100 ? (((1 << 31) | i) >>> 0) : id))
    const tree = createLodTreeState({ ...result, pointIds: Uint32Array.from(packed) })
    flagVisibility(tree, boxFrustum(400))
    const ids = gather(tree, 1000)
    expect(ids).toHaveLength(200)
    expect(new Set(ids).size).toBe(200)
    expect(ids.filter((id) => id >>> 31 === 1)).toHaveLength(100)
  })
})
