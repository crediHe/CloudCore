import { lodChildNode, lodNodeBoundingRadius, type LodOctreeEntityResult } from '../utils/lodOctree'

/**
 * LOD 遍历：视锥可见性标记 + 按预算的节点级配额下钻（gather）。
 *
 * 算法逐条对齐 CloudCompare（`ccPointCloudLOD.cpp` 的
 * `PointCloudLODVisibilityFlagger::flag` 与 `ccPointCloudLOD::addNPointsToIndexMap`），
 * 差别只在数据形态：CC 按**层级数组**（每层一片节点）走，本仓库的 native 结果是
 * **层序单表 + 子节点连续**（见 utils/lodOctree.ts 的契约），故一切下钻都从
 * `nodeChildMask` 的位与 `nodeChildBase` 的偏移算出。
 *
 * 三态视锥测试（节点的**外接球**：中心 = 立方体几何中心，半径 = 边长 × √3/2）：
 *  - OUTSIDE   整棵子树剪掉，一个点都不取；
 *  - INSIDE    整棵子树可见（不再下钻标记，子节点保持默认值，由 gather 的
 *              `insideAncestor` 接力——否则每个 INSIDE 节点的子节点都要重标一遍）；
 *  - INTERSECT 继续下钻；若所有子节点都不可见，本节点回落为 OUTSIDE。
 *
 * 取点走 CC 的配额规则：父节点把预算按各子节点**剩余量**成比例分发
 * （`ceil(childRemaining / thisRemaining × count)`），点只从叶子取；每个节点记录
 * 「已取出多少」（`displayed`）。叶子的点**按步长在整个区间上铺开取**，不是取前缀
 * （理由见 addNPoints 里的注释）——步长采样同样保有一个关键好处：预算变大时先前取
 * 的点必然还在集合里（步长减半，旧采样点落在新序列的偶数位），画面只增不减。
 *
 * 本模块是纯函数 + 注入式视锥：不碰 three 的渲染对象，也不做相机换算（那在
 * lodScheduler），单测可直接喂人造节点表与手写平面。
 */

/** 节点不可见（整棵子树剪掉）——也是 `states` 的初始值（全零数组）。 */
export const LOD_NODE_OUTSIDE = 0
/** 节点立方体外接球跨视锥边界，需下钻。 */
export const LOD_NODE_INTERSECT = 1
/** 节点立方体外接球完整落在视锥内，整棵子树可见。 */
export const LOD_NODE_INSIDE = 2

/**
 * 视锥的一个平面（法线朝视锥**内侧**，点 p 的带符号距离 = normal·p + constant）。
 * 刻意结构化定义而不 import THREE.Plane：`THREE.Frustum.planes` 天然满足本形状，
 * 单测则可以用手写字面量构造平面。
 */
export interface LodFrustumPlane {
  normal: { x: number; y: number; z: number }
  constant: number
}

/** 视锥（`THREE.Frustum` 结构兼容）。 */
export interface LodFrustum {
  planes: LodFrustumPlane[]
}

/** 一棵树的遍历状态（与 native 结果同生命周期，见 LodDisplay.tree）。 */
export interface LodTreeState {
  result: LodOctreeEntityResult
  /**
   * 每节点的可见性（LOD_NODE_*，与 nodeCount 等长）。
   * **全零初始化即"全部 OUTSIDE"**，故每次标记前要 fill(0)。
   */
  states: Uint8Array
  /** 每节点已取出的点数（gather 的输入输出）；每次全量重取前清零。 */
  displayed: Uint32Array
  /** 上一次 flagVisibility 的可见点数（实体级预算分配的权重，见 planLodBudget）。 */
  visiblePoints: number
  /** 上一次 flagVisibility 用的视锥是否仍是当前相机的（相机一变即失效）。 */
  valid: boolean
}

/** 建立某棵树的遍历状态（数组一次性分配，此后每次标记/取点复用）。 */
export function createLodTreeState(result: LodOctreeEntityResult): LodTreeState {
  return {
    result,
    states: new Uint8Array(result.nodeCount),
    displayed: new Uint32Array(result.nodeCount),
    visiblePoints: 0,
    valid: false,
  }
}

/**
 * 立方体外接球对 6 个平面的三态测试；遇任一平面在外侧即提前返回 OUTSIDE。
 * 与 CC 的 `Frustum::sphereInFrustum` 同判据（CC 的平面法线同样朝内）。
 */
function sphereState(frustum: LodFrustum, cx: number, cy: number, cz: number, radius: number): number {
  let state = LOD_NODE_INSIDE
  const planes = frustum.planes
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i]
    const distance = plane.normal.x * cx + plane.normal.y * cy + plane.normal.z * cz + plane.constant
    if (distance < -radius) return LOD_NODE_OUTSIDE
    if (distance < radius) state = LOD_NODE_INTERSECT
  }
  return state
}

/**
 * 标记整棵树的可见性并返回**可见点数**（实体级预算分配的权重）。
 *
 * 返回值的语义与 `pointCount` 同系：INSIDE 节点直接记整棵子树的点数，
 * INTERSECT 节点累加子节点——由于子节点的区间恰好划分父区间（native 契约），
 * 结果恰好等于"可见叶子的点数之和"。
 */
export function flagVisibility(tree: LodTreeState, frustum: LodFrustum): number {
  tree.states.fill(LOD_NODE_OUTSIDE)
  tree.valid = true
  tree.visiblePoints = tree.result.nodeCount > 0 ? flagNode(tree, frustum, 0) : 0
  return tree.visiblePoints
}

function flagNode(tree: LodTreeState, frustum: LodFrustum, node: number): number {
  const result = tree.result
  const center = node * 3
  const state = sphereState(
    frustum,
    result.nodeCenter[center],
    result.nodeCenter[center + 1],
    result.nodeCenter[center + 2],
    lodNodeBoundingRadius(result.nodeSize[node])
  )
  tree.states[node] = state
  if (state === LOD_NODE_OUTSIDE) return 0

  const count = result.nodePointCount[node]
  // INSIDE 的子树不必再走：子节点保持默认值，gather 靠 insideAncestor 接力
  const mask = result.nodeChildMask[node]
  if (state === LOD_NODE_INSIDE || mask === 0) return count

  let visible = 0
  let child = result.nodeChildBase[node]
  for (let octant = 0; octant < 8; octant++) {
    if (mask & (1 << octant)) {
      visible += flagNode(tree, frustum, child)
      child++
    }
  }
  if (visible === 0) {
    // 一个点都看不见就把自己降级为 OUTSIDE：gather 不必再走这条分支
    tree.states[node] = LOD_NODE_OUTSIDE
  }
  return visible
}

/** 一次实体级配额分配（见 planLodBudget）。 */
export interface LodBudgetEntry {
  /** 该实体当前视锥内的可见点数（flagVisibility 的返回值）。 */
  visible: number
  /** staging 槽位容量（min(实体点数, 每帧预算)），配额不会超过它。 */
  capacity: number
  /** 输出：本帧分给该实体的点数。 */
  quota: number
}

/**
 * 每帧预算的均衡项占比：先按实体数均分这部分，剩下的按可见点数成比例分。
 *
 * CC 的预算是**每点云**一份（`MAX_POINT_COUNT_PER_LOD_RENDER_PASS` 在
 * `ccPointCloud::drawMeOnly` 里逐云生效），多片产物场景下总额随实体数线性膨胀。
 * 本应用取**全局一份**（TreeIso 一次能切出上百个实体，逐实体一份会打死 GPU），
 * 代价是纯按比例分配时小实体会被大实体的数量级淹没（几百万比几千 → 小实体几乎
 * 一个点都分不到、整片消失）。均衡项就是为此：每个可见实体至少拿到
 * `budget × LOD_BALANCE_SHARE / 实体数`，其余按占比分——大头仍归大实体，
 * 小实体也保证看得见。
 */
export const LOD_BALANCE_SHARE = 0.25

/**
 * 二轮分配：先按可见点数统计，再给每个实体配额（总和不超预算，也不超各自容量）。
 * `entries` 里 visible === 0 的实体直接跳过（不可见就没有配额）。
 */
export function planLodBudget(entries: LodBudgetEntry[], budget: number): void {
  let active = 0
  for (const entry of entries) {
    if (entry.visible > 0) active++
    entry.quota = 0
  }
  if (active === 0 || budget <= 0) return

  // 第一轮：均衡项（同时被各自的容量与可见点数封顶）
  const floor = Math.ceil((budget * LOD_BALANCE_SHARE) / active)
  let rest = budget
  let needTotal = 0 // 还想要多少（可见点数与容量的较小者 - 已分到的）
  for (const entry of entries) {
    if (entry.visible <= 0) continue
    entry.quota = Math.min(entry.visible, entry.capacity, floor)
    rest -= entry.quota
    needTotal += Math.min(entry.visible, entry.capacity) - entry.quota
  }
  // 容量比可见点数还小的情况（实体点数 > staging 容量）已在上面被 need 归零，
  // 不参与占比——否则它会白吃掉一份永远分不出去的预算
  if (rest <= 0 || needTotal <= 0) return

  // 第二轮：余量按占比分发；最后一项吃掉剩额，避免逐项 ceil 的累计误差顶出预算
  let index = 0
  for (const entry of entries) {
    if (entry.visible <= 0) continue
    index++
    const need = Math.min(entry.visible, entry.capacity) - entry.quota
    if (need <= 0) continue
    const share = index === active ? rest : Math.ceil((need / needTotal) * rest)
    const add = Math.min(need, share, rest)
    entry.quota += add
    rest -= add
  }
}

/**
 * 按配额从树上取点，把**打包 id** 依序写进 `ids[0..n)`，返回取出的点数。
 *
 * `displayed` 是每节点已取计数：本次调用前必须清零（每帧全量重取）。同一个叶子在
 * 同一采样率下取出的点集是确定的（步长 = 区间长度 / 取点数），故预算变大时（步长
 * 减半）先前取的点集是新点集的子集——画面只增不减。
 *
 * 点**只从叶子取**：内部节点的区间是子节点区间的并，从内部节点取点会与其子孙
 * 重复（native 契约明确内部节点区间不保证块主序，也正是为了强调这一点）。
 */
export function gatherLodPoints(tree: LodTreeState, budget: number, ids: Uint32Array): number {
  if (budget <= 0 || tree.result.nodeCount === 0) return 0
  tree.displayed.fill(0)
  let cursor = 0

  /** 返回实际取出的点数（CC 的 addNPointsToIndexMap 逐句对应）。 */
  function addNPoints(node: number, count: number, insideAncestor: boolean): number {
    if (count <= 0) return 0
    const result = tree.result
    let displayedCount = 0
    const mask = result.nodeChildMask[node]

    if (mask !== 0) {
      const thisRemaining = result.nodePointCount[node] - tree.displayed[node]
      const displayAll = count >= thisRemaining
      const nodeInside = insideAncestor || tree.states[node] === LOD_NODE_INSIDE
      let child = result.nodeChildBase[node]
      for (let octant = 0; octant < 8 && displayedCount < count; octant++) {
        if ((mask & (1 << octant)) === 0) continue
        const childNode = child
        child++
        if (!nodeInside && tree.states[childNode] === LOD_NODE_OUTSIDE) continue
        const childRemaining = result.nodePointCount[childNode] - tree.displayed[childNode]
        if (childRemaining <= 0) continue
        let childMaxCount = displayAll
          ? childRemaining
          : Math.ceil((childRemaining / thisRemaining) * count)
        if (displayedCount + childMaxCount > count) childMaxCount = count - displayedCount
        displayedCount += addNPoints(childNode, childMaxCount, nodeInside)
      }
    } else {
      const start = result.nodePointStart[node]
      const leafCount = result.nodePointCount[node]
      // 本次取完后该叶子应显示的总数（一次取点里每个叶子只被访问一次，故 skip 恒为 0；
      // 保留一般形式是为了让"同一采样率 → 同一集合"这个性质不看调用方的脸色）
      const total = Math.min(tree.displayed[node] + count, leafCount)
      const skip = tree.displayed[node]
      const take = total - skip
      if (take > 0) {
        // **叶内按步长铺开**，而不是搬区间的前 take 个。叶子区间是块主序的（native
        // 契约）= 文件读取序 = 扫描序，于是"前缀"是空间连贯的一小块——一个叶子里最早
        // 的那几条扫描线。取出的点会挤在叶子的一角，而叶子又是规则的立方体网格，画面
        // 上就是规则条纹 / 栅格状缺失（实测 13% 的取点只覆盖叶子 y 跨度的 11%）。
        // 步长采样让取出的点铺满整个叶子区间（同 forEachSample 的块内等距取样）：
        // 预算翻倍 → 步长减半 → 旧采样点落在新序列的偶数位，点集严格嵌套，画面只增不减。
        const stride = leafCount / total
        for (let j = skip; j < total; j++) {
          ids[cursor + j - skip] = result.pointIds[start + Math.floor(j * stride)]
        }
        cursor += take
        displayedCount = take
      }
    }

    tree.displayed[node] += displayedCount
    return displayedCount
  }

  addNPoints(0, budget, false)
  return cursor
}

/** 便利包装：节点是否有子节点（与 utils 的 lodIsLeaf 同义，这里少一次结果对象解引用）。 */
export function lodTreeNodeHasChildren(tree: LodTreeState, node: number): boolean {
  return tree.result.nodeChildMask[node] !== 0
}

/** 取某节点在指定卦限的子节点（-1 = 不存在）；gather/标记之外的调用方用。 */
export function lodTreeNodeChild(tree: LodTreeState, node: number, octant: number): number {
  return lodChildNode(tree.result, node, octant)
}
