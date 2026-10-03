import type { CsfChunkSource } from '../../../../src/renderer/utils/csf'

/**
 * csf.cc 的 JS 逐式镜像（CSF 布料模拟地面分割参考实现）。
 *
 * 仅供单元测试对照 native/csf-lidar 产物（build/Release/csf_lidar.node）的正确性——
 * C++ 是唯一实现，本文件是"逐式复刻"的对照基准：每个常量、每条运算、
 * 每层循环顺序都与 csf.cc 对应，用于在相同输入上逐元素比对地面分类结果。
 * 禁止 import 进生产代码；生产渲染侧调用走 csfStore + native addon。
 *
 * 位级一致性前提：csf.cc 全程 double（JS number 同为 IEEE754 binary64），
 * 只用 + - * / abs/floor 等基础运算（无超越函数），且 MSVC /O2 默认
 * /fp:precise 不重排、不 FMA 融合，故运算顺序一致时结果逐位一致。
 */

// ---- 常量（csf.cc L25-34 的 constexpr 镜像）----
const DAMPING = 0.01
const GRAVITY = 0.2
const CLOTH_Y_HEIGHT = 0.05
const CLOTH_BUFFER = 2
const SMOOTH_THRESHOLD = 0.3
const HEIGHT_THRESHOLD = 9999.0
const EARLY_STOP_DIFF = 0.005

/** 布料粒子数上限（csf.cc L34；参考实现不真抛错，仅哨兵）。 */
const kMaxClothParticles = 16777216

/** 约束位移系数表（csf.cc L41-46 原样数值）。 */
const SingleMove1 = [0, 0.3, 0.51, 0.657, 0.7599, 0.83193, 0.88235, 0.91765, 0.94235, 0.95965, 0.97175, 0.98023, 0.98616, 0.99031, 0.99322]
const DoubleMove1 = [0, 0.3, 0.42, 0.468, 0.4872, 0.4949, 0.498, 0.4992, 0.4997, 0.4999, 0.4999, 0.5, 0.5, 0.5, 0.5]

/** std::numeric_limits<double>::lowest() = -DBL_MAX（"无记录"哨兵）。 */
const NONE = -Number.MAX_VALUE
/** std::numeric_limits<double>::max()（nearestD 初值哨兵）。 */
const DBL_MAX = Number.MAX_VALUE

/** 布料状态（csf.cc Cloth 结构体 L69-103 的 JS 镜像）。 */
interface ClothRef {
  W: number
  H: number
  res: number
  originA: number
  originB: number
  startSimY: number
  posY: number[]
  oldY: number[]
  movable: Uint8Array
  heightvals: number[]
  nearestH: number[]
  nearestD: number[]
  rasterVis: Uint8Array
  compVis: Uint8Array
  compPos: Int32Array
  adjBegin: Uint32Array
  adjList: Uint32Array
}

/** 单实体候选点预解包（分类函数内 coordOf 的等价物，一次解包供多遍使用）。 */
interface Candidate {
  /** 所属块。 */
  chunk: number
  /** 顶点缓冲下标（已换算：带 index 时 = index[local]，否则 = local）。 */
  vertex: number
  pa: number
  pb: number
  simY: number
}

/** 解析实体全部候选点并平铺（语义同 csf.cc coordOf：候选按块连续）。 */
function unpackCandidates(chunks: CsfChunkSource[]): Candidate[] {
  const out: Candidate[] = []
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    const localN = chunk.index ? chunk.index.length : chunk.positions.length / 3
    for (let local = 0; local < localN; local++) {
      const vertex = chunk.index ? chunk.index[local] : local
      out.push({ chunk: c, vertex, pa: 0, pb: 0, simY: 0 })
      const cand = out[out.length - 1]
      cand.pa = chunk.positions[vertex * 3] // Float32 读入即 double（位级同 C++ float→double）
      cand.pb = chunk.positions[vertex * 3 + 1]
      cand.simY = -chunk.positions[vertex * 3 + 2]
    }
  }
  return out
}

/** 平面轴选择：up=2（z-up）→ {a:0, b:1}（csf.cc planeAxesOf）。 */
function planeAxesOf(up: number): { a: number; b: number } {
  if (up === 0) return { a: 1, b: 2 }
  if (up === 1) return { a: 0, b: 2 }
  return { a: 0, b: 1 }
}

/** 邻接表构建（csf.cc buildAdjacency L106-160：两遍循环，边顺序逐条一致）。 */
function buildAdjacency(cloth: ClothRef): void {
  const { W, H } = cloth
  const Np = W * H
  const deg = new Uint32Array(Np)
  const countEdge = (i: number, j: number) => {
    deg[i]++
    deg[j]++
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = y * W + x
      if (x < W - 1) countEdge(i, i + 1)
      if (y < H - 1) countEdge(i, i + W)
      if (x < W - 1 && y < H - 1) {
        countEdge(i, i + W + 1)
        countEdge(i + 1, i + W)
      }
      if (x < W - 2) countEdge(i, i + 2)
      if (y < H - 2) countEdge(i, i + 2 * W)
      if (x < W - 2 && y < H - 2) {
        countEdge(i, i + 2 * W + 2)
        countEdge(i + 2, i + 2 * W)
      }
    }
  }
  const adjBegin = new Uint32Array(Np + 1)
  for (let i = 0; i < Np; i++) adjBegin[i + 1] = adjBegin[i] + deg[i]
  const adjList = new Uint32Array(adjBegin[Np])
  const cursor = Uint32Array.from(adjBegin) // 拷贝含尾哨兵无妨，写入位 < Np
  const addEdge = (i: number, j: number) => {
    adjList[cursor[i]++] = j
    adjList[cursor[j]++] = i
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = y * W + x
      if (x < W - 1) addEdge(i, i + 1)
      if (y < H - 1) addEdge(i, i + W)
      if (x < W - 1 && y < H - 1) {
        addEdge(i, i + W + 1)
        addEdge(i + 1, i + W)
      }
      if (x < W - 2) addEdge(i, i + 2)
      if (y < H - 2) addEdge(i, i + 2 * W)
      if (x < W - 2 && y < H - 2) {
        addEdge(i, i + 2 * W + 2)
        addEdge(i + 2, i + 2 * W)
      }
    }
  }
  cloth.adjBegin = adjBegin
  cloth.adjList = adjList
}

/** 粒子时间步（csf.cc particleTimeStep L166-175）。 */
function particleTimeStep(cloth: ClothRef, acceleration: number): void {
  for (let i = 0; i < cloth.posY.length; i++) {
    if (cloth.movable[i]) {
      const deltaY = cloth.posY[i] - cloth.oldY[i]
      cloth.oldY[i] = cloth.posY[i]
      cloth.posY[i] += deltaY * (1.0 - DAMPING) + acceleration
    }
  }
}

/** 约束单遍满足（csf.cc satisfyConstraints L181-213）。 */
function satisfyConstraints(cloth: ClothRef, rigidness: number): void {
  const r = rigidness > 14 ? 14 : rigidness < 0 ? 0 : rigidness
  const singleF = rigidness > 14 ? 1.0 : SingleMove1[r]
  const doubleF = rigidness > 14 ? 0.5 : DoubleMove1[r]
  for (let p1 = 0; p1 < cloth.posY.length; p1++) {
    const begin = cloth.adjBegin[p1]
    const end = cloth.adjBegin[p1 + 1]
    const p1Movable = cloth.movable[p1] !== 0
    if (!p1Movable) {
      for (let e = begin; e < end; e++) {
        const p2 = cloth.adjList[e]
        if (cloth.movable[p2]) {
          const correction = cloth.posY[p2] - cloth.posY[p1]
          cloth.posY[p2] -= correction * singleF
        }
      }
      continue
    }
    for (let e = begin; e < end; e++) {
      const p2 = cloth.adjList[e]
      const correction = cloth.posY[p2] - cloth.posY[p1]
      if (cloth.movable[p2]) {
        const half = correction * doubleF
        cloth.posY[p1] += half
        cloth.posY[p2] -= half
      } else {
        cloth.posY[p1] += correction * singleF
      }
    }
  }
}

/** 碰撞检测（csf.cc terrainCollision L216-224）。 */
function terrainCollision(cloth: ClothRef): void {
  for (let i = 0; i < cloth.posY.length; i++) {
    if (cloth.posY[i] < cloth.heightvals[i]) {
      cloth.posY[i] = cloth.heightvals[i]
      cloth.movable[i] = 0
    }
  }
}

/** 本轮最大位移（csf.cc maxDiffOf L227-237）。 */
function maxDiffOf(cloth: ClothRef): number {
  let maxDiff = 0.0
  for (let i = 0; i < cloth.posY.length; i++) {
    if (cloth.movable[i]) {
      const diff = Math.abs(cloth.oldY[i] - cloth.posY[i])
      if (diff > maxDiff) maxDiff = diff
    }
  }
  return maxDiff
}

/** 空格高度补齐（csf.cc findHeightByScanline L243-296，含 BFS 兜底与 visited 清理）。 */
function findHeightByScanline(cloth: ClothRef, i: number): number {
  const W = cloth.W
  const H = cloth.H
  const col = i % W
  const row = Math.floor(i / W)

  for (let c = col + 1; c < W; c++) {
    const h = cloth.nearestH[row * W + c]
    if (h > NONE) return h
  }
  for (let c = col - 1; c >= 0; c--) {
    const h = cloth.nearestH[row * W + c]
    if (h > NONE) return h
  }
  for (let r = row - 1; r >= 0; r--) {
    const h = cloth.nearestH[r * W + col]
    if (h > NONE) return h
  }
  for (let r = row + 1; r < H; r++) {
    const h = cloth.nearestH[r * W + col]
    if (h > NONE) return h
  }

  // BFS 兜底：沿邻接表扩散找最近有值格
  const que: number[] = []
  for (let e = cloth.adjBegin[i]; e < cloth.adjBegin[i + 1]; e++) que.push(cloth.adjList[e])
  cloth.rasterVis[i] = 1
  const backlist: number[] = []
  while (que.length > 0) {
    const p = que.shift()!
    backlist.push(p)
    if (cloth.nearestH[p] > NONE) {
      for (const q of backlist) cloth.rasterVis[q] = 0
      for (const q of que) cloth.rasterVis[q] = 0
      return cloth.nearestH[p]
    }
    for (let e = cloth.adjBegin[p]; e < cloth.adjBegin[p + 1]; e++) {
      const q = cloth.adjList[e]
      if (!cloth.rasterVis[q]) {
        cloth.rasterVis[q] = 1
        que.push(q)
      }
    }
  }
  return NONE
}

/** 高度场光栅化（csf.cc rasterTerrain L304-328）。 */
function rasterTerrain(cloth: ClothRef, candidates: Candidate[]): void {
  for (const cand of candidates) {
    const col = Math.floor((cand.pa - cloth.originA) / cloth.res + 0.5)
    const row = Math.floor((cand.pb - cloth.originB) / cloth.res + 0.5)
    if (col < 0 || row < 0 || col >= cloth.W || row >= cloth.H) continue
    const i = row * cloth.W + col
    const dx = cloth.originA + col * cloth.res - cand.pa
    const dz = cloth.originB + row * cloth.res - cand.pb
    const dist = dx * dx + dz * dz
    if (dist < cloth.nearestD[i]) {
      cloth.nearestD[i] = dist
      cloth.nearestH[i] = cand.simY
    }
  }
  for (let i = 0; i < cloth.posY.length; i++) {
    cloth.heightvals[i] =
      cloth.nearestH[i] > NONE ? cloth.nearestH[i] : findHeightByScanline(cloth, i)
  }
}

/** 陡坡后处理（csf.cc movableFilter L336-444）。 */
function movableFilter(cloth: ClothRef): void {
  const W = cloth.W
  const H = cloth.H
  const Np = cloth.posY.length
  cloth.compVis.fill(0)
  cloth.compPos.fill(-1)

  for (let x0 = 0; x0 < W; x0++) {
    for (let y0 = 0; y0 < H; y0++) {
      const start = y0 * W + x0
      if (!cloth.movable[start] || cloth.compVis[start]) continue

      // BFS 收集连通块（顺序同 csf.cc：左 → 右 → 下 → 上）
      const connected: number[] = []
      const neibors: number[][] = []
      const que: number[] = [start]
      cloth.compVis[start] = 1
      cloth.compPos[start] = 0
      connected.push(start)
      const tryNeighbor = (nb: number, neighbor: number[]) => {
        if (!cloth.movable[nb]) return
        if (!cloth.compVis[nb]) {
          cloth.compVis[nb] = 1
          cloth.compPos[nb] = connected.length
          connected.push(nb)
          que.push(nb)
          neighbor.push(cloth.compPos[nb])
        } else {
          neighbor.push(cloth.compPos[nb])
        }
      }
      while (que.length > 0) {
        const cur = que.shift()!
        const col = cur % W
        const row = Math.floor(cur / W)
        const neighbor: number[] = []
        if (col > 0) tryNeighbor(cur - 1, neighbor)
        if (col < W - 1) tryNeighbor(cur + 1, neighbor)
        if (row > 0) tryNeighbor(cur - W, neighbor)
        if (row < H - 1) tryNeighbor(cur + W, neighbor)
        neibors.push(neighbor)
      }

      if (connected.length <= 100) continue // CC：小块不做陡坡处理

      // 找与已 pin 邻居接壤的块边粒子并 pin（csf.cc findUnmovablePoint）
      const edgePoints: number[] = []
      for (let ci = 0; ci < connected.length; ci++) {
        const i = connected[ci]
        const col = i % W
        const row = Math.floor(i / W)
        const tryPin = (nb: number, ncol: number, nrow: number) => {
          if (cloth.movable[nb]) return
          const iref = nrow * W + ncol
          if (
            Math.abs(cloth.heightvals[i] - cloth.heightvals[iref]) < SMOOTH_THRESHOLD &&
            cloth.posY[i] - cloth.heightvals[i] < HEIGHT_THRESHOLD
          ) {
            cloth.posY[i] = cloth.heightvals[i]
            cloth.movable[i] = 0
            edgePoints.push(ci)
          }
        }
        if (col > 0) {
          tryPin(i - 1, col - 1, row)
          if (!cloth.movable[i]) continue
        }
        if (col < W - 1) {
          tryPin(i + 1, col + 1, row)
          if (!cloth.movable[i]) continue
        }
        if (row > 0) {
          tryPin(i - W, col, row - 1)
          if (!cloth.movable[i]) continue
        }
        if (row < H - 1) {
          tryPin(i + W, col, row + 1)
        }
      }

      // 沿块内邻接关系扩散 pin（csf.cc handle_slop_connected）
      const visited = new Uint8Array(connected.length)
      const spread: number[] = []
      for (const ep of edgePoints) {
        spread.push(ep)
        visited[ep] = 1
      }
      while (spread.length > 0) {
        const ci = spread.shift()!
        const ic = connected[ci]
        for (const nj of neibors[ci]) {
          const inn = connected[nj]
          if (
            Math.abs(cloth.heightvals[ic] - cloth.heightvals[inn]) < SMOOTH_THRESHOLD &&
            Math.abs(cloth.posY[inn] - cloth.heightvals[inn]) < HEIGHT_THRESHOLD
          ) {
            cloth.posY[inn] = cloth.heightvals[inn]
            cloth.movable[inn] = 0
            if (!visited[nj]) {
              visited[nj] = 1
              spread.push(nj)
            }
          }
        }
      }
    }
  }
}

/** 双线性插值分类（csf.cc classifyEntity 第 6 步 L553-580）。 */
function classifyPoints(cloth: ClothRef, candidates: Candidate[], threshold: number): Uint8Array {
  const isGround = new Uint8Array(candidates.length)
  const W = cloth.W
  for (let g = 0; g < candidates.length; g++) {
    const cand = candidates[g]
    const deltaA = cand.pa - cloth.originA
    const deltaB = cand.pb - cloth.originB
    const col0 = Math.floor(deltaA / cloth.res)
    const row0 = Math.floor(deltaB / cloth.res)
    if (col0 < 0 || row0 < 0 || col0 + 1 >= W || row0 + 1 >= cloth.H) continue // 越界防御
    const subA = (deltaA - col0 * cloth.res) / cloth.res
    const subB = (deltaB - row0 * cloth.res) / cloth.res
    const y00 = cloth.posY[row0 * W + col0]
    const y01 = cloth.posY[(row0 + 1) * W + col0]
    const y11 = cloth.posY[(row0 + 1) * W + col0 + 1]
    const y10 = cloth.posY[row0 * W + col0 + 1]
    const fxy = y00 * (1.0 - subA) * (1.0 - subB) + y01 * (1.0 - subA) * subB + y11 * subA * subB + y10 * subA * (1.0 - subB)
    if (Math.abs(fxy - cand.simY) < threshold) isGround[g] = 1
  }
  return isGround
}

export interface CsfRefParams {
  clothResolution: number
  rigidness: number
  iterations: number
  timeStep: number
  classThreshold: number
  smoothSlope: boolean
  heightAxis: number
}

/**
 * classifyEntity 的 JS 镜像（csf.cc L448-599）。输出与 addon 同构：
 * ground[c] = 第 c 块地面顶点下标（递增，顶点缓冲空间）。
 */
export function csfJsReference(chunks: CsfChunkSource[], params: CsfRefParams): Uint32Array[] {
  const chunkCount = chunks.length
  const groundByChunk: Uint32Array[] = Array.from({ length: chunkCount }, () => new Uint32Array(0))
  if (chunkCount === 0) return groundByChunk
  if (!(params.clothResolution > 0)) return groundByChunk // 非法参数：全非地面（镜像 C++）

  const candidates = unpackCandidates(chunks)
  if (candidates.length === 0) return groundByChunk

  // 倒置空间：csf.cc 里 up 轴读 h、simY = -h；参考实现直接固定 z-up 读法
  // （heightAxis 支持由调用方保证为 2；如需一般化按 planeAxesOf 重排 pa/pb）
  const res = params.clothResolution
  const timeStep2 = params.timeStep * params.timeStep
  const acceleration = -GRAVITY * timeStep2

  // 1) 候选水平面范围
  let minA = Infinity
  let maxA = -Infinity
  let minB = Infinity
  let maxB = -Infinity
  let minH = Infinity // 向上轴坐标最小值（= -simY 最大值）
  for (const cand of candidates) {
    if (cand.pa < minA) minA = cand.pa
    if (cand.pa > maxA) maxA = cand.pa
    if (cand.pb < minB) minB = cand.pb
    if (cand.pb > maxB) maxB = cand.pb
    const h = -cand.simY
    if (h < minH) minH = h
  }

  // 2) 布网格 + 状态初始化（csf.cc L509-531）
  const cloth: ClothRef = {
    W: Math.floor((maxA - minA) / res) + 2 * CLOTH_BUFFER,
    H: Math.floor((maxB - minB) / res) + 2 * CLOTH_BUFFER,
    res,
    originA: minA - CLOTH_BUFFER * res,
    originB: minB - CLOTH_BUFFER * res,
    startSimY: -minH + CLOTH_Y_HEIGHT,
    posY: [],
    oldY: [],
    movable: new Uint8Array(0),
    heightvals: [],
    nearestH: [],
    nearestD: [],
    rasterVis: new Uint8Array(0),
    compVis: new Uint8Array(0),
    compPos: new Int32Array(0),
    adjBegin: new Uint32Array(0),
    adjList: new Uint32Array(0),
  }
  const Np = cloth.W * cloth.H
  if (Np > kMaxClothParticles) {
    throw new Error('CSF（参考实现）：布料网格粒子数超过上限，测试数据参数错误')
  }
  cloth.posY = new Array<number>(Np).fill(cloth.startSimY)
  cloth.oldY = new Array<number>(Np).fill(cloth.startSimY)
  cloth.movable = new Uint8Array(Np).fill(1)
  cloth.heightvals = new Array<number>(Np).fill(0)
  cloth.nearestH = new Array<number>(Np).fill(NONE)
  cloth.nearestD = new Array<number>(Np).fill(DBL_MAX)
  cloth.rasterVis = new Uint8Array(Np)
  cloth.compVis = new Uint8Array(Np)
  cloth.compPos = new Int32Array(Np).fill(-1)

  // 3) 邻接 + 光栅化
  buildAdjacency(cloth)
  rasterTerrain(cloth, candidates)

  // 4) 模拟迭代（镜像 C++ 主循环顺序与早停条件）
  const iterations = params.iterations > 0 ? params.iterations : 0
  for (let iter = 0; iter < iterations; iter++) {
    particleTimeStep(cloth, acceleration)
    satisfyConstraints(cloth, params.rigidness)
    const maxDiff = maxDiffOf(cloth)
    terrainCollision(cloth)
    if (maxDiff !== 0.0 && maxDiff < EARLY_STOP_DIFF) break
  }

  // 5) 陡坡后处理（可选）
  if (params.smoothSlope) {
    movableFilter(cloth)
  }

  // 6) 分类 + 按块回填（csf.cc L582-597：候选序自增 → 每块递增）
  const isGround = classifyPoints(cloth, candidates, params.classThreshold)
  for (let c = 0; c < chunkCount; c++) {
    const picks: number[] = []
    for (let g = 0; g < candidates.length; g++) {
      if (isGround[g] && candidates[g].chunk === c) picks.push(candidates[g].vertex)
    }
    groundByChunk[c] = new Uint32Array(picks)
  }
  return groundByChunk
}
