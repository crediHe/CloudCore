import { srgbToLinear } from './srgb'

/**
 * 法向量估计的渲染侧契约镜像 + JS 纯函数工具。
 *
 * C++ 算法本体见 native/normal-estimate/src/normal_estimate.cc，定点编解码见
 * src/normal_compressor.cc；N-API 绑定壳的请求/响应契约见 src/addon.cc 顶部注释。
 * **任何入参/出参语义改动必须两处同步**。算法语义与已知偏差见
 * native/normal-estimate/README-REF.md。
 *
 * 核心语义（与 C++ 一致，对齐 CloudCompare）：
 * - 单实体 = 多块；候选点集 = 各块 index 条目的顶点下标（带 index 的分割产物），
 *   无 index = 该块全量顶点（0..vertexCount-1）。邻居搜索**跨块**（模型建在实体级）。
 * - 法向量存成 **2 字节量化码**（`Uint16Array`，itemSize 1，属性名 `'normalCode'`），
 *   不是 3 个 float——对齐 CC 的 ccNormalCompressor（QUANTIZE_LEVEL = 6，本仓库取值）。
 * - **本模块是继 lod-octree、ransac-plane 之后第三处破模板的契约**，且破坏面更大：
 *   1. **两个导出**（`computeNormals` / `guessRadius`），其余模块只有一个 `compute`；
 *   2. `codes` 是「**每候选一个值**」的并行数组（`codes[c][k]` = 第 c 块第 k 个候选点的码），
 *      其余算法模块回传的是「顶点缓冲空间」的子集。摊平进顶点缓冲是
 *      `scatterNormalCodes` 的职责，**不是** native 侧。
 */

/** 单块候选源（零拷贝引用 geometry 的底层数组，与半径滤波同构）。 */
export interface NormalEstimateChunkSource {
  /** 块内全量顶点坐标（3 float/点，显示坐标 = 原始坐标 - 全局基准点）。 */
  positions: Float32Array
  /** 候选顶点下标（递增，顶点缓冲空间）。null = 候选为全量顶点。 */
  index: Uint32Array | null
}

/** 单实体估计源。 */
export interface NormalEstimateEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: NormalEstimateChunkSource[]
}

/**
 * 局部模型。TS/UI 侧用字符串（仓库惯例：如 `ColorMode` 用字符串联合，便于 v-model 与
 * JSON 序列化，也避免 `const enum` 与 `isolatedModules` 的纠葛）；**线协议用数字**，
 * 由 `NORMAL_MODEL_CODES` 映射到 C++ 的 LocalModel。
 */
export type NormalModel = 'ls' | 'quadric'

/** 局部模型 → C++ `LocalModel` 取值（与 normal_estimate.h 一一对应）。 */
export const NORMAL_MODEL_CODES: Record<NormalModel, number> = {
  /** 最小二乘平面（邻域协方差最小特征值特征向量）。 */
  ls: 0,
  /** 局部二次曲面 `z = h0 + h1u + h2v + h3u² + h4uv + h5v²`，取查询点处梯度。 */
  quadric: 1,
}

/**
 * 定向方式。**线协议数值逐一镜像** `ccNormalVectors::Orientation`
 * （ccNormalVectors.h:65-81），与 native/normal-estimate/src/normal_estimate.h 的
 * NormOrientation 同源。
 *
 * CC 的 `PREVIOUS`(10) / `PLUS_SENSOR_ORIGIN`(11) / `MINUS_SENSOR_ORIGIN`(12) **刻意不列**：
 * 它们分别依赖「上一轮法向量」与「关联传感器」，二者在我们的数据模型里都不存在。
 * C++ 侧收到这三个值也按 `undefined`（255）处理（不过定向），故不给出码值。
 */
export type NormalOrientation =
  | 'undefined'
  | 'plus-x'
  | 'minus-x'
  | 'plus-y'
  | 'minus-y'
  | 'plus-z'
  | 'minus-z'
  | 'plus-barycenter'
  | 'minus-barycenter'
  | 'plus-origin'
  | 'minus-origin'

/** 定向方式 → C++ `NormOrientation` 取值。`undefined` = 255 = 不做定向。 */
export const NORMAL_ORIENTATION_CODES: Record<NormalOrientation, number> = {
  undefined: 255,
  'plus-x': 0,
  'minus-x': 1,
  'plus-y': 2,
  'minus-y': 3,
  'plus-z': 4,
  'minus-z': 5,
  'plus-barycenter': 6,
  'minus-barycenter': 7,
  'plus-origin': 8,
  'minus-origin': 9,
}

/** `computeNormals` 请求体（与 addon.cc 的 request 字段一一对应，**数值为线协议值**）。 */
export interface NormalEstimateRequest {
  /** 邻域球半径（与坐标同单位，显示坐标）。<= 0 = 全部候选留空码。 */
  radius: number
  /** 局部模型（见 `NORMAL_MODEL_CODES`）。 */
  model: number
  /** 定向方式（见 `NORMAL_ORIENTATION_CODES`；255 = 不过定向）。 */
  orientation: number
  entities: NormalEstimateEntitySource[]
}

/** 单实体估计结果。 */
export interface NormalEstimateEntityResult {
  entityId: number
  /** 逐块量化码，与输入 chunks 逐一对应；`codes[c].length` = 第 c 块的候选数。 */
  codes: Uint16Array[]
  /** 成功算出法向量的点数（不含空码）。 */
  computed: number
  /** 空码点数。computed + nullCount == 候选总数。 */
  nullCount: number
  /** 空码中「半径放大到 16 倍仍不足」的点数（nullCount 的子集）。占大头 ⇒ 半径偏小。 */
  capped: number
}

/** `guessRadius` 请求体。 */
export interface GuessRadiusRequest {
  entityId: number
  /** 单实体（与 CC 一致：Auto 只在恰好选中一片点云时可用）。 */
  chunks: NormalEstimateChunkSource[]
  /** PRNG 种子（默认与 C++ 的 kRandomSeed 一致；同种子 ⇒ 同结果，可复现）。 */
  seed?: number
  /** 目标邻域点数（默认 16，同 CC BestRadiusParams）。 */
  aimedPopulationPerCell?: number
  /** 命中半宽（默认 4）。 */
  aimedPopulationRange?: number
  /** 「人口充足」样本下限（默认 6）。 */
  minCellPopulation?: number
  /** 密度均匀判据（默认 0.97）。 */
  minAboveMinRatio?: number
}

/** `guessRadius` 结果（统计量只供展示，不参与半径推导）。 */
export interface GuessRadiusResult {
  entityId: number
  /** 推荐半径；实体为空或退化时为 0。 */
  radius: number
  /** 实际尝试轮数（C++ 上限 10；0 = 点数 < 100 走了朴素半径分支）。 */
  attempts: number
  /** 采样点数（CC = min(200, N/10)）。 */
  sampledCount: number
  /** 最后一轮的邻域人口均值 / 标准差 / 「人口 ≥ 下限」占比。 */
  meanPopulation: number
  stdDevPopulation: number
  aboveMinRatio: number
}

/** native 模块导出契约（normal_estimate.node）——两个导出，非标准模板。 */
export interface NormalEstimateAddon {
  computeNormals: (
    request: NormalEstimateRequest,
    callback: (err: Error | null, results?: NormalEstimateEntityResult[]) => void
  ) => void
  guessRadius: (
    request: GuessRadiusRequest,
    callback: (err: Error | null, result?: GuessRadiusResult) => void
  ) => void
}

/**
 * 量化层数（每层 2 位）。与 native/normal-estimate/src/normal_compressor.h 的
 * QUANTIZE_LEVEL 必须一致（两处同步）。6 ⇒ 码占 3 + 2×6 = 15 位，Uint16 装得下。
 */
export const NORMAL_QUANTIZE_LEVEL = 6

/** 空码（无法计算）：紧接最大有效码 32767 之后。 */
export const NULL_NORM_CODE = 32768

/** 反转掩码：只翻 3 个符号位（= 7 << 12）。 */
export const INVERT_XOR = 7 << (2 * NORMAL_QUANTIZE_LEVEL)

/** LUT 项数（0..NULL_NORM_CODE 闭区间）。 */
export const NORMAL_LUT_SIZE = NULL_NORM_CODE + 1

/**
 * 解码单个量化码（JS 镜像 `normal_estimate.cc` 的 `decompressNormal`）。
 *
 * 输出是**未归一化**的向量（箱角之和，模长 ≈ 1/√3 量级）；归一化由调用方做
 * （建 LUT 时统一归一化，与 CC `ccNormalVectors::Init` 一致）。
 * 空码返回全 0。结果写进调用方给的 `out`（避免逐码分配三元组）。
 *
 * 箱细分记账（`flip` 与 `sector !== 3` 的中箱分支）**必须与 C++ 逐字对应**，抄错就跟 CC 对不上。
 */
export function decompressNormalCode(code: number, out: Float64Array | number[]): void {
  if (code === NULL_NORM_CODE) {
    out[0] = 0
    out[1] = 0
    out[2] = 0
    return
  }

  // box[0..2] = 下界，box[3..5] = 上界，初值单位立方体 [0,1]^3
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 1
  let b4 = 1
  let b5 = 1
  let flip = false

  for (let k = 0, shift = 2 * NORMAL_QUANTIZE_LEVEL - 2; k < NORMAL_QUANTIZE_LEVEL; ++k, shift -= 2) {
    const sector = (code >> shift) & 3
    if (flip) {
      const tmp = sector === 0 ? b0 : sector === 1 ? b1 : sector === 2 ? b2 : 0
      const h0 = (b0 + b3) / 2
      const h1 = (b1 + b4) / 2
      const h2 = (b2 + b5) / 2
      b0 = h0
      b1 = h1
      b2 = h2
      if (sector !== 3) {
        // box[3 + sector] = box[sector]; box[sector] = tmp
        const keep = tmp
        if (sector === 0) {
          b3 = b0
          b0 = keep
        } else if (sector === 1) {
          b4 = b1
          b1 = keep
        } else {
          b5 = b2
          b2 = keep
        }
      } else {
        flip = false
      }
    } else {
      const tmp = sector === 0 ? b3 : sector === 1 ? b4 : sector === 2 ? b5 : 0
      const h0 = (b0 + b3) / 2
      const h1 = (b1 + b4) / 2
      const h2 = (b2 + b5) / 2
      b3 = h0
      b4 = h1
      b5 = h2
      if (sector !== 3) {
        const keep = tmp
        if (sector === 0) {
          b0 = b3
          b3 = keep
        } else if (sector === 1) {
          b1 = b4
          b4 = keep
        } else {
          b2 = b5
          b5 = keep
        }
      } else {
        flip = true
      }
    }
  }

  // 符号位在 bit14..12
  const sector = code >> (2 * NORMAL_QUANTIZE_LEVEL)
  out[0] = (sector & 4) !== 0 ? -(b3 + b0) : b3 + b0
  out[1] = (sector & 2) !== 0 ? -(b4 + b1) : b4 + b1
  out[2] = (sector & 1) !== 0 ? -(b5 + b2) : b5 + b2
}

/**
 * 法向量码 → 单位向量的查找表（`NORMAL_LUT_SIZE × 3`，逐码紧凑排列）。
 *
 * 这是**渲染侧唯一**的解码入口：着色、反转预览、调试显示都查它，不重复解码。
 * 用 `Math.sqrt`（IEEE754 正确舍入，与 C++ `std::sqrt` 逐位一致）。
 *
 * LUT 是纯函数产物（同一份输入总产出同一份表），调用方自行缓存——见 `normalStore`。
 */
export function buildNormalLut(): Float32Array {
  const lut = new Float32Array(NORMAL_LUT_SIZE * 3)
  const raw = new Float64Array(3)
  for (let code = 0; code <= NULL_NORM_CODE; ++code) {
    decompressNormalCode(code, raw)
    const len = Math.sqrt(raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2])
    if (len > 0) {
      lut[code * 3] = raw[0] / len
      lut[code * 3 + 1] = raw[1] / len
      lut[code * 3 + 2] = raw[2] / len
    }
    // len == 0（空码，或理论上的退化箱）⇒ 保持 (0,0,0)，渲染侧按黑色处理
  }
  return lut
}

/**
 * 法向量码 → 线性空间 RGB（写入 `out`，三槽）。
 *
 * 语义 = CC 的 `Edit > Normals > Convert to > Colors`：`RGB = (N + 1) / 2`，
 * 即每个分量从 [-1,1] 重映射到 [0,1]。**视无关**——不随相机变化，这是与 CC
 * 「背面发黑」那套绘制期光照的**刻意差异**（理由见 README-REF.md）。
 *
 * 结果经 `srgbToLinear`（three r152+ 色彩管理的硬要求：喂顶点色的必须是线性值，
 * 否则显示端再提亮一次，颜色发白）。空码 / 零向量 → 黑色。
 */
export function normalCodeToRgbLinear(lut: Float32Array, code: number, out: Uint8Array | number[]): void {
  const i = code * 3
  const nx = lut[i]
  const ny = lut[i + 1]
  const nz = lut[i + 2]
  if (nx === 0 && ny === 0 && nz === 0) {
    out[0] = 0
    out[1] = 0
    out[2] = 0
    return
  }
  out[0] = Math.round(srgbToLinear((nx + 1) / 2) * 255)
  out[1] = Math.round(srgbToLinear((ny + 1) / 2) * 255)
  out[2] = Math.round(srgbToLinear((nz + 1) / 2) * 255)
}

/**
 * 反转一个量化码（等价于对解码向量取反后重新压缩）。
 *
 * **只翻 3 个符号位**：箱细分只依赖绝对值，故 `Compress(-n) === Compress(n) ^ INVERT_XOR`
 * （精确零分量是唯一例外，`-0.0 >= 0` 为真，实际影响不可测）。
 * 空码原样返回——「无法计算」取反仍是「无法计算」。
 */
export function invertNormalCode(code: number): number {
  return code === NULL_NORM_CODE ? code : code ^ INVERT_XOR
}

/**
 * 把 native 的「每候选一个码」摊成「每顶点一个码」（顶点缓冲空间）。
 *
 * - 无 `index` 的块**直接返回 `codes[c]` 本身**（零拷贝快路径）：候选就是全量顶点，
 *   两者长度一致，无需搬运。**调用方不得原地修改返回值**——它可能与调用方传入的
 *   数组是同一个（native 回包是刚 memcpy 出来的新数组，但语义上仍应视作只读）。
 * - 带 `index` 的块新建 `Uint16Array(vertexCount)` 填 `NULL_NORM_CODE`，
 *   再按 `index[k]` 散写：未入选的顶点保持空码，与语义层 `index` 筛选一致。
 *
 * 这是分割产物（带 index）与原始块（不带）共用同一条渲染路径的关键——
 * 两边最终都变成「顶点缓冲空间、长度 = vertexCount」的属性。
 */
export function scatterNormalCodes(chunks: NormalEstimateChunkSource[], codes: Uint16Array[]): Uint16Array[] {
  return chunks.map((chunk, c) => {
    const src = codes[c]
    if (!chunk.index) {
      return src
    }
    const out = new Uint16Array(chunk.positions.length / 3)
    out.fill(NULL_NORM_CODE)
    const n = Math.min(chunk.index.length, src.length)
    for (let k = 0; k < n; ++k) {
      out[chunk.index[k]] = src[k]
    }
    return out
  })
}

/** 对话框定向下拉的选项（只列我们支持的项；顺序按「常用在前」）。 */
export const ORIENTATION_OPTIONS: { value: NormalOrientation; label: string; title: string }[] = [
  { value: 'undefined', label: '不处理', title: '法向量符号由拟合过程任意给出，不做统一定向' },
  { value: 'plus-z', label: '+Z', title: '强制 N.z > 0（适合地面点云朝上）' },
  { value: 'minus-z', label: '−Z', title: '强制 N.z < 0' },
  { value: 'plus-x', label: '+X', title: '强制 N.x > 0' },
  { value: 'minus-x', label: '−X', title: '强制 N.x < 0' },
  { value: 'plus-y', label: '+Y', title: '强制 N.y > 0' },
  { value: 'minus-y', label: '−Y', title: '强制 N.y < 0' },
  {
    value: 'plus-barycenter',
    label: '背离基准点',
    title: '法向量背离选中点云的重心（适合封闭物体的外表面）',
  },
  { value: 'minus-barycenter', label: '朝向基准点', title: '法向量朝向选中点云的重心' },
  { value: 'plus-origin', label: '背离原点', title: '法向量背离显示坐标原点（原始坐标 - 全局基准点）' },
  { value: 'minus-origin', label: '朝向原点', title: '法向量朝向显示坐标原点' },
]

/** 局部模型下拉的选项。 */
export const MODEL_OPTIONS: { value: NormalModel; label: string; title: string }[] = [
  {
    value: 'ls',
    label: 'Plane (LS)',
    title: '最小二乘平面拟合。快、稳，平面上无系统偏差；曲面上有轻微偏差',
  },
  {
    value: 'quadric',
    label: 'Quadric',
    title: '局部二次曲面拟合，取查询点处梯度。曲面上更准，慢一些，邻域几何退化的点会留空',
  },
]
