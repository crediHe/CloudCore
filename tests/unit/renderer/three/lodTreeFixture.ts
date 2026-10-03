import type { LodOctreeEntityResult } from '../../../../src/renderer/utils/lodOctree'

/**
 * 人造八叉树节点表（lodTraversal / lodScheduler 两个 spec 共用）。
 *
 * 本文件不是 .spec.ts，故不会被 vitest 收集，也不该被生产代码引用。
 *
 * 为什么不跑真 native 模块造树：遍历与调度测的是逻辑，人造表能把"某一支被剪掉"
 * "根节点整棵 INSIDE""预算小于一个叶子"这些边界造得明明白白，而真八叉树要靠
 * 数据碰运气才撞得上。native 侧另有 tests/unit/renderer/utils/lodOctree.spec.ts
 * 用真产物验结构不变量，两边的契约由 utils/lodOctree.ts 的字段表钉住。
 */

/** 测试用的树描述（层序下标、子节点连续性、区间划分都由 buildLodTreeResult 补齐）。 */
export interface SpecNode {
  center: [number, number, number]
  /** 立方体边长（外接球半径 = 边长 × √3/2，与 C++ 一致）。 */
  size: number
  /** 子节点（按卦限升序给定；省略 = 叶子）。 */
  children?: SpecNode[]
  /** 叶子点数（打包 id 由 buildLodTreeResult 顺序分配）。 */
  points?: number
}

/**
 * 把树描述编成 native 契约形状的节点表。
 *
 * 与 C++ 输出的一致处：层序排列；某节点的子节点**下标连续**（BFS 逐节点追加，
 * 中间不会插入别的节点的子节点）；父节点的区间恰好被子节点划分；叶子区间内 id 单调。
 * 与本测试无关处（卦限顺序、块主序）简化处理——遍历不使用它们。
 */
export function buildLodTreeResult(spec: SpecNode, entityId = 1): LodOctreeEntityResult {
  // 1) 层序编号 + 父子关系
  const nodes: SpecNode[] = []
  const childBase: number[] = []
  const childMask: number[] = []
  const level: number[] = []
  const childrenOf: number[][] = []

  const queue: { node: SpecNode; depth: number }[] = [{ node: spec, depth: 0 }]
  const indexOf = new Map<SpecNode, number>()
  while (queue.length > 0) {
    const { node, depth } = queue.shift() as { node: SpecNode; depth: number }
    indexOf.set(node, nodes.length)
    nodes.push(node)
    level.push(depth)
    queue.push(...(node.children ?? []).map((child) => ({ node: child, depth: depth + 1 })))
  }
  // 子节点下标：BFS 逐个节点展开，同一节点的子节点因此连续（契约同款）
  for (let i = 0; i < nodes.length; i++) {
    const kids = nodes[i].children ?? []
    childrenOf.push(kids.map((k) => indexOf.get(k) as number))
    childBase.push(kids.length > 0 ? (indexOf.get(kids[0]) as number) : 0)
    childMask.push(kids.length > 0 ? (1 << kids.length) - 1 : 0)
  }

  // 2) 区间与 id：DFS 铺开，父区间 = 子区间并集
  const pointStart = new Array<number>(nodes.length).fill(0)
  const pointCountArr = new Array<number>(nodes.length).fill(0)
  const pointIds: number[] = []
  let nextId = 0
  const layout = (index: number): number => {
    const kids = childrenOf[index]
    const start = pointIds.length
    if (kids.length === 0) {
      const count = nodes[index].points ?? 0
      for (let i = 0; i < count; i++) pointIds.push(nextId++)
    } else {
      for (const kid of kids) layout(kid)
    }
    pointStart[index] = start
    pointCountArr[index] = pointIds.length - start
    return pointIds.length
  }
  layout(0)

  // 3) 节点立方体几何（视锥剔除用）
  const center = new Float32Array(nodes.length * 3)
  const size = new Float32Array(nodes.length)
  nodes.forEach((node, i) => {
    center[i * 3] = node.center[0]
    center[i * 3 + 1] = node.center[1]
    center[i * 3 + 2] = node.center[2]
    size[i] = node.size
  })

  return {
    entityId,
    nodeCount: nodes.length,
    pointCount: pointIds.length,
    chunkBits: 1,
    vertexShift: 31,
    bounds: new Float32Array(6),
    nodeChildBase: Uint32Array.from(childBase),
    nodeChildMask: Uint8Array.from(childMask),
    nodePointStart: Uint32Array.from(pointStart),
    nodePointCount: Uint32Array.from(pointCountArr),
    nodeCenter: center,
    nodeSize: size,
    nodeLevel: Uint8Array.from(level),
    pointIds: Uint32Array.from(pointIds),
  }
}

/**
 * "沿 X 轴排开"的两支树：一根根节点，两个子节点各 100 点。
 * A 在 x = -100、B 在原点，边长 40（外接球半径 34.64）。
 * 改变正交视锥的半宽 W 就能精确控制谁可见（见 lodTraversal.spec 各用例）。
 */
export function twoBranchLodTree(): LodOctreeEntityResult {
  return buildLodTreeResult({
    center: [0, 0, 0],
    size: 400, // 外接球半径 346.4：小半宽下必为 INTERSECT
    children: [
      { center: [-100, 0, 0], size: 40, points: 100 },
      { center: [0, 0, 0], size: 40, points: 100 },
    ],
  })
}

/** 单根叶子节点（没有子节点）：测边界判据与零点输入用。 */
export function singleLeafLodTree(points: number, size = 40): LodOctreeEntityResult {
  return buildLodTreeResult({ center: [0, 0, 0], size, points })
}

/**
 * `leafCount` 片等大叶子的树（沿 X 轴排开，每片 pointsPerLeaf 点，id 顺序分配）。
 * 点数总量要能压过每帧预算（512K）时才看得出加密分档，故点数由调用方给。
 */
export function uniformLeafLodTree(leafCount: number, pointsPerLeaf: number): LodOctreeEntityResult {
  const children: SpecNode[] = []
  for (let i = 0; i < leafCount; i++) {
    children.push({ center: [(i - (leafCount - 1) / 2) * 40, 0, 0], size: 40, points: pointsPerLeaf })
  }
  return buildLodTreeResult({ center: [0, 0, 0], size: leafCount * 40, children })
}
