import type { CsfChunkSource } from '../../../../src/renderer/utils/csf'

/**
 * csf_pro.cc 的 JS 逐式镜像（老算法液体贴合语义 CSF 精准地面分割参考实现）。
 *
 * 仅供单元测试对照 native/csf-pro 产物（build/Release/csf_pro.node）的正确性——
 * C++ 是唯一实现，本文件是"逐式复刻"的对照基准：每个常量、每条运算、每层循环
 * 顺序都与 csf_pro.cc 对应（csf_pro.cc 又逐式对应老代码
 * doc/CSF地面识别算法/native_src/csf_algorithm.cc 的液体贴合语义），用于在相同
 * 输入上逐元素比对地面分类结果。禁止 import 进生产代码。
 *
 * 位级一致性前提：csf_pro.cc 全程 double（JS number 同为 IEEE754 binary64），
 * float 输入升 double 无损，且 MSVC /O2 默认 /fp:precise 不重排、不 FMA 融合，
 * 故运算顺序一致时结果逐位一致。所有截断用 Math.trunc 镜像 C 的 (int) 强转。
 */

// ---- 常量（csf_pro.cc L14-16 的 constexpr 镜像）----
const kGravityFactor = 0.65
const kSearchRadiusFactor = 1.5

/** 支撑网格：cell = 搜索半径，前缀和 + 连续桶的 JS 镜像（语义同老代码 Grid2D）。 */
class Grid2D {
  cell = 0
  minX = 0
  minY = 0
  nx = 0
  ny = 0
  xs: Float32Array
  ys: Float32Array
  cellStart: number[] = []
  bucket: number[] = []

  constructor(xs: Float32Array, ys: Float32Array, cell: number, mnx: number, mny: number, mxx: number, mxy: number) {
    this.xs = xs
    this.ys = ys
    this.cell = cell
    this.minX = mnx
    this.minY = mny
    this.nx = Math.max(1, Math.trunc((mxx - mnx) / cell) + 2)
    this.ny = Math.max(1, Math.trunc((mxy - mny) / cell) + 2)
    const n = xs.length
    const ncells = this.nx * this.ny
    const cellStart = new Array<number>(ncells + 1).fill(0)
    for (let i = 0; i < n; i++) {
      cellStart[this.cellId(xs[i], ys[i]) + 1]++
    }
    for (let g = 0; g < ncells; g++) cellStart[g + 1] += cellStart[g]
    this.cellStart = cellStart
    const cursor = cellStart.slice()
    this.bucket = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) {
      this.bucket[cursor[this.cellId(xs[i], ys[i])]++] = i
    }
  }

  /** 格 id：double 除法后 (int) 截断 + clamp，镜像 C++ 的 std::clamp + 强转。 */
  cellId(x: number, y: number): number {
    const ix = Math.trunc(Math.min(Math.max((x - this.minX) / this.cell, 0), this.nx - 1))
    const iy = Math.trunc(Math.min(Math.max((y - this.minY) / this.cell, 0), this.ny - 1))
    return iy * this.nx + ix
  }

  /** 收集 (x,y) 半径 r 覆盖格内全部候选索引（圆形距离裁剪由调用方做）。 */
  collect(x: number, y: number, r: number, out: number[]) {
    const ix0 = Math.max(0, Math.trunc((x - r - this.minX) / this.cell))
    const ix1 = Math.min(this.nx - 1, Math.trunc((x + r - this.minX) / this.cell))
    const iy0 = Math.max(0, Math.trunc((y - r - this.minY) / this.cell))
    const iy1 = Math.min(this.ny - 1, Math.trunc((y + r - this.minY) / this.cell))
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const g = iy * this.nx + ix
        for (let p = this.cellStart[g]; p < this.cellStart[g + 1]; p++) out.push(this.bucket[p])
      }
    }
  }
}

/** 老算法镜像参数（对齐 csf_pro.h ClassifyParams 默认值）。 */
export interface CsfProParamsLike {
  clothResolution: number
  rigidness: number
  iterations: number
  timeStep: number
  classThreshold: number
  convergenceEps: number
}

/** 单实体（与 native 契约同构：chunks = 渲染块源；镜像内部只按块切分输出）。 */
export interface CsfProEntityLike {
  entityId: number
  chunks: CsfChunkSource[]
}

/**
 * csf_pro.cc classifyEntity 的 JS 逐式镜像。
 * @returns 每块地面点顶点下标（递增序，与输入 chunks 对齐）；非地面 = 候选补集。
 */
export function csfProJsReference(chunks: CsfChunkSource[], p: CsfProParamsLike): Uint32Array[] {
  const groundByChunk: Uint32Array[] = chunks.map(() => new Uint32Array(0))

  // ---- 1. 合并候选：包围盒（double）+ 倒置高度（候选 = index 条目或全部顶点） ----
  let total = 0
  for (const c of chunks) total += c.index ? c.index.length : c.positions.length / 3
  if (total === 0) return groundByChunk

  let mnx = Infinity
  let mxx = -Infinity
  let mny = Infinity
  let mxy = -Infinity
  let mxz = -Infinity
  for (const c of chunks) {
    const pos = c.positions
    const count = c.index ? c.index.length : pos.length / 3
    for (let j = 0; j < count; j++) {
      const v = c.index ? c.index[j] : j
      const x = pos[v * 3]
      const y = pos[v * 3 + 1]
      const z = pos[v * 3 + 2]
      mnx = Math.min(mnx, x)
      mxx = Math.max(mxx, x)
      mny = Math.min(mny, y)
      mxy = Math.max(mxy, y)
      mxz = Math.max(mxz, z)
    }
  }
  const xs = new Float32Array(total)
  const ys = new Float32Array(total)
  const invz = new Float32Array(total)
  let k = 0
  for (const c of chunks) {
    const pos = c.positions
    const count = c.index ? c.index.length : pos.length / 3
    for (let j = 0; j < count; j++) {
      const v = c.index ? c.index[j] : j
      xs[k] = pos[v * 3]
      ys[k] = pos[v * 3 + 1]
      invz[k] = -pos[v * 3 + 2]
      k++
    }
  }

  // ---- 2. 支撑均匀网格 ----
  const searchR = p.clothResolution * kSearchRadiusFactor
  const grid = new Grid2D(xs, ys, searchR, mnx, mny, mxx, mxy)

  // ---- 3. 初始化布料 ----
  const r = p.clothResolution
  const nx = Math.trunc((mxx - mnx) / r) + 2
  const ny = Math.trunc((mxy - mny) / r) + 2
  const top = -mxz + r * 2
  const z = new Array<number>(nx * ny).fill(top)

  // ---- 4. 布料模拟迭代（4a-4d，收敛判据镜像老工具 csf_native.cc） ----
  const gravity = p.timeStep * kGravityFactor
  const rigid = (p.rigidness / 3.0) * 0.5
  const r2 = searchR * searchR
  const buf: number[] = []
  const prevZ = new Array<number>(z.length).fill(top) // 收敛采样快照（上轮碰撞后）
  // 实际收敛容差 = max(convergenceEps, 布料分辨率×0.15)
  const effEps = Math.max(p.convergenceEps, r * 0.15)
  let settled = 0

  for (let it = 0; it < p.iterations; it++) {
    // 4a. 重力：所有粒子下落
    for (let i = 0; i < z.length; i++) z[i] -= gravity

    // 4b. 碰撞约束：圆形邻域内点云最高倒置点，只抬升不 pin
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = iy * nx + ix
        const cx = mnx + ix * r
        const cy = mny + iy * r
        buf.length = 0
        grid.collect(cx, cy, searchR, buf)
        let mz = z[idx]
        for (let b = 0; b < buf.length; b++) {
          const pi = buf[b]
          const dx = xs[pi] - cx
          const dy = ys[pi] - cy
          if (dx * dx + dy * dy <= r2 && invz[pi] > mz) mz = invz[pi]
        }
        if (mz > z[idx]) z[idx] = mz
      }
    }

    // 收敛采样：量"碰撞后"整轮位移（贴地粒子回到同一支撑高度 → 位移≈0；
    // 悬空粒子每轮位移 = 重力步长 → 不会提前悬停）
    let maxLiftDz = 0
    for (let i = 0; i < z.length; i++) {
      const dz = Math.abs(z[i] - prevZ[i])
      if (dz > maxLiftDz) maxLiftDz = dz
    }
    for (let i = 0; i < z.length; i++) prevZ[i] = z[i] // 快照滚动到本轮碰撞后状态

    // 4c. 内部约束：四邻域平均 × rigid，边界保持抬升高度
    const zNew = new Array<number>(z.length).fill(0)
    for (let iy = 1; iy < ny - 1; iy++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        const idx = iy * nx + ix
        const avg = (z[idx - nx] + z[idx + nx] + z[idx - 1] + z[idx + 1]) * 0.25
        const diff = (avg - z[idx]) * rigid
        zNew[idx] = z[idx] + diff
      }
    }
    for (let ix = 0; ix < nx; ix++) {
      zNew[ix] = z[ix]
      zNew[(ny - 1) * nx + ix] = z[(ny - 1) * nx + ix]
    }
    for (let iy = 0; iy < ny; iy++) {
      zNew[iy * nx] = z[iy * nx]
      zNew[iy * nx + nx - 1] = z[iy * nx + nx - 1]
    }
    // swap
    for (let i = 0; i < z.length; i++) z[i] = zNew[i]

    // 4d. 收敛（对齐老工具）：连续 3 轮整轮位移 < effEps 即停；空洞处粒子永不
    //     触地 → 每轮位移恒为重力步长 → 自然跑满迭代上限兜底（同老代码）
    if (maxLiftDz < effEps) {
      if (++settled >= 3) break
    } else {
      settled = 0
    }
  }

  // ---- 5. 分类：双线性插值布料高度（逐块输出，顶点下标递增） ----
  let globalK = 0
  for (let c = 0; c < chunks.length; c++) {
    const src = chunks[c]
    const pos = src.positions
    const count = src.index ? src.index.length : pos.length / 3
    const ground: number[] = []
    for (let j = 0; j < count; j++, globalK++) {
      const fx = (xs[globalK] - mnx) / r
      const fy = (ys[globalK] - mny) / r
      const ix0 = Math.trunc(Math.min(Math.max(fx, 0), nx - 2))
      const iy0 = Math.trunc(Math.min(Math.max(fy, 0), ny - 2))
      const tx = fx - ix0
      const ty = fy - iy0
      const z00 = z[iy0 * nx + ix0]
      const z10 = z[iy0 * nx + ix0 + 1]
      const z01 = z[(iy0 + 1) * nx + ix0]
      const z11 = z[(iy0 + 1) * nx + ix0 + 1]
      const zc = (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty
      if (Math.abs(invz[globalK] - zc) <= p.classThreshold) {
        ground.push(src.index ? src.index[j] : j)
      }
    }
    groundByChunk[c] = Uint32Array.from(ground)
  }
  return groundByChunk
}
