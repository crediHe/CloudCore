import { candidateCountOfChunk } from './radiusFilter'

/**
 * 体素滤波的渲染侧契约镜像 + JS 暴力参考。
 *
 * C++ 算法本体见 native/voxel-filter/src/voxel_filter.cc；N-API 绑定壳的请求/
 * 响应契约见 native/voxel-filter/src/addon.cc 顶部注释。**任何入参/出参语义改动
 * 必须两处同步**。
 *
 * 核心语义（与 C++ 一致，语义对齐 PCL VoxelGrid，文章参考 doc/点云处理体素滤波/）：
 * - 单实体 = 多块；候选点集 = 各块 index 条目的顶点下标（带 index 的分割产物），
 *   无 index = 该块全量顶点（0..vertexCount-1）。网格划分只覆盖候选点。
 * - 按体素边长把空间划成均匀立方体网格，每个占用的体素输出 1 个代表点 =
 *   体素内**距重心（坐标算术平均）最近的原始点**（重心本身非原始点不可输出，
 *   受应用"索引空间"架构约束；仅 1 点的体素天然保留自身）。
 * - kept 一律为「顶点缓冲空间」的下标（递增）：可直接喂 pointcloudStore 的
 *   setChunkVisibility 换索引渲染 / splitKeptRemoved 求补集拆分。
 * - 边界：leafSize <= 0（退化格）→ 全部保留（与半径滤波 radius<=0 全剔除有意不同：
 *   leaf→0 是"每格 1 点"的连续极限，全保留避免退化输入清空点云）。
 *
 * **位级确定性契约**（防止 JS/C++ 对照测试在 ulp 舍入差上抖动）：
 * 重心求和必须按「块序升序 → 块内候选升序」遍历（与 C++ 桶内存储序一致），
 * double 累加 → 重心与 C++ 位级一致；代表点 = 距重心平方距离最小者，
 * 严格 < 更新 → 距离并列时取遍历序先者（候选序号更小者）。改动必须两处同步。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组，见 pointcloudStore.getFilterSourceChunks）。 */
export interface VoxelFilterChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（递增，顶点缓冲空间）。null = 候选为全量顶点。 */
  index: Uint32Array | null
}

/** 单实体滤波源。 */
export interface VoxelFilterEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: VoxelFilterChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface VoxelFilterRequest {
  /** 体素边长（与坐标同单位；平移/旋转不改变距离，显示坐标直接用）。 */
  leafSize: number
  entities: VoxelFilterEntitySource[]
}

/** 单实体结果：kept[c] = 第 c 块保留顶点下标（递增，与输入 chunks 对齐；每格至多 1 点）。 */
export interface VoxelFilterEntityResult {
  entityId: number
  kept: Uint32Array[]
}

/** native 模块导出契约（voxel_filter.node）。 */
export interface VoxelFilterAddon {
  compute: (
    request: VoxelFilterRequest,
    callback: (err: Error | null, results?: VoxelFilterEntityResult[]) => void
  ) => void
}

/**
 * 体素滤波暴力参考实现（语义逐条镜像 C++ filterEntity）。
 *
 * 仅供单元测试对照 native 产物正确性用，生产禁止调用（渲染进程里请走 native）。
 * 输出与 addon 同构：逐块 kept（顶点下标，递增）。复杂度 O(n)（哈希分组 + 每格
 * 双扫），不参与生产路径。
 */
export function voxelFilterBruteForce(chunks: VoxelFilterChunkSource[], leafSize: number): Uint32Array[] {
  // 镜像 C++ 边界分支：leafSize <= 0 → 全部保留（保序全量，逐块填）
  if (leafSize <= 0) {
    return chunks.map((chunk) => {
      const n = candidateCountOfChunk(chunk)
      const kept = new Uint32Array(n)
      for (let i = 0; i < n; i++) {
        kept[i] = chunk.index ? chunk.index[i] : i
      }
      return kept
    })
  }

  // 平铺候选全集：块序升序 → 块内升序（同 C++ 桶构建的 push 序，求和序位级一致）
  const total = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
  const chunkStart: number[] = []
  let acc = 0
  for (const c of chunks) {
    chunkStart.push(acc)
    acc += candidateCountOfChunk(c)
  }
  if (total === 0) return chunks.map(() => new Uint32Array(0))

  const uChunk = new Uint32Array(total)
  const uVertex = new Uint32Array(total)
  const uX = new Float64Array(total)
  const uY = new Float64Array(total)
  const uZ = new Float64Array(total)
  // cells：key = 格号串（格号 = floor(坐标 / leafSize)，与 C++ 同式；键偏移不影响
  // 分组，仅需两侧同式），值 = 该格成员全局候选序号（按升序扫描追加 → 格内升序）
  const cells = new Map<string, number[]>()
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    const n = candidateCountOfChunk(chunk)
    const base = chunkStart[c]
    for (let i = 0; i < n; i++) {
      const v = chunk.index ? chunk.index[i] : i
      const idx = base + i
      uChunk[idx] = c
      uVertex[idx] = v
      const x = chunk.positions[v * 3]
      const y = chunk.positions[v * 3 + 1]
      const z = chunk.positions[v * 3 + 2]
      uX[idx] = x
      uY[idx] = y
      uZ[idx] = z
      const key = `${Math.floor(x / leafSize)},${Math.floor(y / leafSize)},${Math.floor(z / leafSize)}`
      const members = cells.get(key)
      if (members) {
        members.push(idx)
      } else {
        cells.set(key, [idx])
      }
    }
  }

  // keptFlags[全局候选序号]：代表点在各自格内唯一（每候选只属于一格），置位无冲突；
  // 收尾按候选升序压缩即得每块递增 kept（镜像 C++ pass5）
  const keptFlags = new Uint8Array(total)
  for (const members of cells.values()) {
    // 按格内成员序（= 全局候选升序）累加重心和 → 与 C++ 同序，位级一致
    let sumX = 0
    let sumY = 0
    let sumZ = 0
    for (const idx of members) {
      sumX += uX[idx]
      sumY += uY[idx]
      sumZ += uZ[idx]
    }
    const inv = 1 / members.length
    const cx = sumX * inv
    const cy = sumY * inv
    const cz = sumZ * inv

    // 同序二次扫描：取距重心平方距离最小者；严格 < → 距离并列取先出现者（候选更小）
    let best = members[0]
    let bestDistSq = Number.POSITIVE_INFINITY
    for (const idx of members) {
      const dx = cx - uX[idx]
      const dy = cy - uY[idx]
      const dz = cz - uZ[idx]
      const distSq = dx * dx + dy * dy + dz * dz
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        best = idx
      }
    }
    keptFlags[best] = 1
  }

  // 按块升序压缩（候选块序内自增 → 每块 kept 顶点下标递增，与 C++ 输出一致）
  const keptByChunk: Uint32Array[] = []
  for (let c = 0; c < chunks.length; c++) {
    const start = chunkStart[c]
    const end = c + 1 < chunks.length ? chunkStart[c + 1] : total
    let k = 0
    for (let t = start; t < end; t++) {
      if (keptFlags[t]) k++
    }
    const kept = new Uint32Array(k)
    k = 0
    for (let t = start; t < end; t++) {
      if (keptFlags[t]) kept[k++] = uVertex[t]
    }
    keptByChunk.push(kept)
  }
  return keptByChunk
}
