/**
 * 地面参考面（规则网格 DTM）——纯函数，不碰 three / DOM / store，node 环境可直接单测。
 *
 * 服务对象：电力线提取的**离地高（HAG = z − 地面高程）**闸门（`utils/powerline.ts`）。
 * native 侧 `sampleGround` 与本文件**逐位一致**（同一套公式、同样全 double），
 * 故单测能拿本文件的采样值去预测 native 的 `hag` 特征（见 powerline.spec.ts）。
 * 契约镜像：`native/powerline/src/powerline.cc#sampleGround`，
 * 网格约定见 `native/powerline/src/powerline.h#GroundGrid`——**任何改动两处同步**。
 *
 * 为什么要有这一层：导线离地 8–30 m，而地面本身在丘陵里起伏几十米。不减去地面高程，
 * 任何"绝对高程闸门"在丘陵都会把整片山坡当成候选。LAS 里带分类的文件可以直接用
 * class 2 当地面点（渲染侧一路零拷贝取字节），不带分类的才需要跑一次 CSF 地面识别
 * （见 powerlineStore 的地面来源三档）。
 */

/** 地面参考面数据（与 native `GroundGrid` 同构；`values[row * cols + col]`，行主序）。 */
export interface GroundGridData {
  /** 逐格地面高程（显示坐标 z）；**不得含 NaN**（空洞在本文件里已填平）。 */
  values: Float32Array
  cols: number
  rows: number
  cellSize: number
  /** 格 (0,0) 的**格心** x（= 地面点 x 的最小值）。 */
  originX: number
  /** 格 (0,0) 的格心 y。 */
  originY: number
}

/** 默认格边长（m）：5 m 对 HAG 足够（地面在这尺度上近似平面），格数也不至于爆。 */
export const GROUND_GRID_DEFAULT_CELL_SIZE = 5

/**
 * 格数上限（**自动放大格边长**而不是报错，见 buildGroundGrid）。
 * 100 万格 = values 4 MB + 填充队列 4 MB，是单次调用的峰值上限。
 */
export const GROUND_GRID_MAX_CELLS = 1_000_000

/**
 * 由**地面点**建参考面。
 *
 * 三条语义（都会**静默**影响 HAG，故写明）：
 *
 * 1. **格值 = 格内地面点的最低高程**（不是均值/中位数）。取最低是有意为之：HAG 偏大
 *    只是多留些点（后级三道闸门会滤），HAG 偏小会**静默丢掉导线**且画面看不出来。
 *    代价是坡度大的格子里 HAG 会整体偏高一点（≤ 一个格内的地形落差），方向安全。
 * 2. **空洞用邻格均值填**（不是最低）：格内一个离群低点若按"最低"向外扩散，会让整片
 *    空洞的地面被拉低 = 整片 HAG 虚高。填洞用 Laplacian 式均值把离群值平掉，且
 *    多源 BFS 一圈圈长出去，**每格的值一旦定下就不再改**（确定性：同一输入必得同一格网）。
 * 3. **格边长会自动放大**：`cols × rows > GROUND_GRID_MAX_CELLS` 时不断翻倍，
 *    直到落进上限（返回值里的 `cellSize` 是**实际用的那个**，调用方要显示它）。
 *
 * @param chunkPositions    逐块全量顶点坐标（3 float/点；**不是候选块**——地面下标已是顶点空间）
 * @param groundChunkIndices 逐块地面点下标（顶点缓冲空间，递增；无地面点的块给 null）；
 *                           长度须与 chunkPositions 一致
 * @param cellSize          期望格边长（m；非正/非有限时取 GROUND_GRID_DEFAULT_CELL_SIZE）
 * @returns 参考面；**一个地面点都没有**（或坐标非有限）时给 null（调用方据此提示"选地面来源"）
 */
export function buildGroundGrid(
  chunkPositions: Float32Array[],
  groundChunkIndices: (Uint32Array | null)[],
  cellSize: number
): GroundGridData | null {
  if (chunkPositions.length !== groundChunkIndices.length) {
    throw new Error(
      `地面参考面入参不一致（坐标块 ${chunkPositions.length} / 地面下标块 ${groundChunkIndices.length}），契约异常`
    )
  }

  // 1) 地面点包围盒（只要 x/y；z 在第二趟取）
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let groundCount = 0
  for (let c = 0; c < chunkPositions.length; c++) {
    const positions = chunkPositions[c]
    const indices = groundChunkIndices[c]
    if (!indices) continue
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i]
      const x = positions[v * 3]
      const y = positions[v * 3 + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      groundCount++
    }
  }
  if (groundCount === 0) return null

  // 2) 定格子尺寸：格心原点 =(minX, minY)，格边长按上限自动放大
  let size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : GROUND_GRID_DEFAULT_CELL_SIZE
  const extentX = maxX - minX
  const extentY = maxY - minY
  // 两个初值都在循环体内先赋值再被读（首次迭代即赋），故这里不写死初值
  let cols: number
  let rows: number
  for (;;) {
    cols = Math.floor(extentX / size) + 1
    rows = Math.floor(extentY / size) + 1
    if (cols * rows <= GROUND_GRID_MAX_CELLS) break
    size *= 2
  }

  // 3) 逐格取最低高程（NaN = 该格还没有地面点）
  const values = new Float32Array(cols * rows).fill(NaN)
  for (let c = 0; c < chunkPositions.length; c++) {
    const positions = chunkPositions[c]
    const indices = groundChunkIndices[c]
    if (!indices) continue
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i]
      const x = positions[v * 3]
      const y = positions[v * 3 + 1]
      const z = positions[v * 3 + 2]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      // 越界不需要夹：包围盒就是这些点算出来的，落在 [0, cols-1] 内
      const col = Math.min(cols - 1, Math.max(0, Math.round((x - minX) / size)))
      const row = Math.min(rows - 1, Math.max(0, Math.round((y - minY) / size)))
      const slot = row * cols + col
      if (Number.isNaN(values[slot]) || z < values[slot]) values[slot] = z
    }
  }

  fillHoles(values, cols, rows)

  return { values, cols, rows, cellSize: size, originX: minX, originY: minY }
}

/**
 * 多源 BFS 填洞（格值为 NaN 的格取**已定值的四邻均值**）。
 *
 * 一遍即填满（不用"反复扫到不动为止"）：初始种子里至少有一个有值格，四邻连通下
 * BFS 必然覆盖全图，且每格出队时其 BFS 父格**必已定值** ⇒ 不会有格留空。
 * 队列按"行主序扫初始种子 + 固定邻序"推进，故结果只由输入决定（与分块、线程无关）。
 */
function fillHoles(values: Float32Array, cols: number, rows: number): void {
  const total = cols * rows
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  for (let slot = 0; slot < total; slot++) {
    if (!Number.isNaN(values[slot])) queue[tail++] = slot
  }
  if (tail === 0) return // 无任何已知格（正常不可达：调用方已保证 groundCount > 0）
  if (tail === total) return // 无洞

  while (head < tail) {
    const slot = queue[head++]
    const col = slot % cols
    const row = (slot - col) / cols
    // 四邻（上/左/右/下，固定序）
    const neighbours = [
      row > 0 ? slot - cols : -1,
      col > 0 ? slot - 1 : -1,
      col + 1 < cols ? slot + 1 : -1,
      row + 1 < rows ? slot + cols : -1,
    ]
    for (const n of neighbours) {
      if (n < 0 || !Number.isNaN(values[n])) continue
      let sum = 0
      let count = 0
      const nCol = n % cols
      const nRow = (n - nCol) / cols
      // 该空格的已定值邻居（同样四邻固定序；父格必在其中）
      if (nRow > 0 && !Number.isNaN(values[n - cols])) {
        sum += values[n - cols]
        count++
      }
      if (nCol > 0 && !Number.isNaN(values[n - 1])) {
        sum += values[n - 1]
        count++
      }
      if (nCol + 1 < cols && !Number.isNaN(values[n + 1])) {
        sum += values[n + 1]
        count++
      }
      if (nRow + 1 < rows && !Number.isNaN(values[n + cols])) {
        sum += values[n + cols]
        count++
      }
      values[n] = count > 0 ? sum / count : values[slot]
      queue[tail++] = n
    }
  }
}

/**
 * 双线性采样地面高程（越界钳到边缘格）。**与 native `sampleGround` 逐位一致**：
 * 同样的除法/钳位/插值顺序，且全程 double（Float32Array 读出的 float 提升为 double 无损）。
 *
 * @returns 地面高程；网格非法（无 values / 尺寸 ≤ 0 / 格边长 ≤ 0）时给 NaN
 */
export function sampleGround(grid: GroundGridData, x: number, y: number): number {
  if (!grid.values || grid.cols <= 0 || grid.rows <= 0 || !(grid.cellSize > 0)) return NaN
  const fx = (x - grid.originX) / grid.cellSize
  const fy = (y - grid.originY) / grid.cellSize
  const cx = fx < 0 ? 0 : fx > grid.cols - 1 ? grid.cols - 1 : fx
  const cy = fy < 0 ? 0 : fy > grid.rows - 1 ? grid.rows - 1 : fy
  const c0 = Math.trunc(cx)
  const r0 = Math.trunc(cy)
  const c1 = c0 + 1 < grid.cols ? c0 + 1 : c0
  const r1 = r0 + 1 < grid.rows ? r0 + 1 : r0
  const du = cx - c0
  const dv = cy - r0
  const v00 = grid.values[r0 * grid.cols + c0]
  const v01 = grid.values[r0 * grid.cols + c1]
  const v10 = grid.values[r1 * grid.cols + c0]
  const v11 = grid.values[r1 * grid.cols + c1]
  const top = v00 + (v01 - v00) * du
  const bot = v10 + (v11 - v10) * du
  return top + (bot - top) * dv
}

/** 离地高 = 点高程 − 采样地面高程（`sampleGround` 的薄包装，供单测/工具用）。 */
export function sampleHag(grid: GroundGridData, x: number, y: number, z: number): number {
  return z - sampleGround(grid, x, y)
}
