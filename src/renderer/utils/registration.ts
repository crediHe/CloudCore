import * as THREE from 'three'
import { loadNativeModule } from './nativeLoader'
import type { RadiusFilterChunkSource } from './radiusFilter'
import type { EntityTransform } from '../stores/pointcloudStore'
import type { SceneProject, SceneSelection } from '../stores/sceneStore'

/**
 * 配准（Registration）渲染侧契约镜像 + 纯函数工具。
 *
 * C++ 算法本体见 native/registration/src/registration.cc（Horn/Besl 四元数解 + Jacobi +
 * FilterTransformation + KD 树 + ICP 主循环），N-API 绑定壳的请求/响应契约见
 * native/registration/src/addon.cc 顶部注释；**任何入参/出参语义改动必须两处同步**。
 * 与 CloudCompare 的逐项差异见 native/registration/README-REF.md。
 *
 * 两个能力（一个 native 模块两个导出，同 normal-estimate 的先例）：
 * - `findAbsoluteOrientation`：点对粗配准（对齐同名点，闭式解）。
 * - `icp`：以当前位姿为起点做迭代最近点精配准。
 *
 * 变换约定与 native/上游一致：**P' = s·(R·P) + T**，R 是 3×3 **行主序**。
 * 两处坐标空间：native 全程在**显示坐标**（= 原始坐标 − 全局基准点）上算 —— 平移/旋转/
 * 均匀缩放都不改变"显示坐标里的相对位姿"，故两片云共用一个 `basePoint` 不影响结果
 *（这也是本仓库不必做 CC 那种 global shift 协调的原因）。
 *
 * 本文件**不 import 任何 store**（只 import type），因此可在 node 环境的单测里直接跑；
 * 选中项 → 实体的解析由 `resolveRegistrationPair` 接收 `projects` 参数完成（纯函数）。
 */

// ---------------------------------------------------------------------------
// 变换过滤器位掩码（镜像 CCCoreLib `TRANSFORMATION_FILTERS`，RegistrationTools.h）
// ---------------------------------------------------------------------------

/** 不限制（默认）。 */
export const SKIP_NONE = 0
/** 只保留绕 Z 轴的旋转（丢弃绕 X / Y 的分量）。 */
export const SKIP_RXY = 1
/** 只保留绕 X 轴的旋转。 */
export const SKIP_RYZ = 2
/** 只保留绕 Y 轴的旋转。 */
export const SKIP_RXZ = 4
/** 完全不旋转（= SKIP_RXY | SKIP_RYZ | SKIP_RXZ）。 */
export const SKIP_ROTATION = 7
/** 平移 X 分量置 0。 */
export const SKIP_TX = 8
/** 平移 Y 分量置 0。 */
export const SKIP_TY = 16
/** 平移 Z 分量置 0。 */
export const SKIP_TZ = 32
/** 完全不平移（= SKIP_TX | SKIP_TY | SKIP_TZ）。 */
export const SKIP_TRANSLATION = 56

/** 面板的旋转过滤档位（比位掩码好读；档位 → 掩码见 `rotationFilterMask`）。 */
export type RotationFilterMode = 'none' | 'x' | 'y' | 'z' | 'fixed'

/**
 * 旋转过滤档位 → 位掩码（0 = 不过滤）。
 *
 * ⚠ 语义容易记反：`SKIP_RYZ` 是"**跳过**绕 Y、Z 的旋转"⇒ **只剩下绕 X 的旋转**，
 * 故面板的「仅绕 X」对应它，而不是「仅绕 Y/Z」。三个档位与上游枚举一一对应：
 * 仅绕 X = SKIP_RYZ(2)、仅绕 Y = SKIP_RXZ(4)、仅绕 Z = SKIP_RXY(1)。
 */
export function rotationFilterMask(mode: RotationFilterMode): number {
  switch (mode) {
    case 'x':
      return SKIP_RYZ
    case 'y':
      return SKIP_RXZ
    case 'z':
      return SKIP_RXY
    case 'fixed':
      return SKIP_ROTATION
    default:
      return SKIP_NONE
  }
}

/** 组装完整的过滤器掩码（旋转档位 + 三个平移分量开关）。 */
export function buildTransformationFilters(
  mode: RotationFilterMode,
  skipTx: boolean,
  skipTy: boolean,
  skipTz: boolean
): number {
  let mask = rotationFilterMask(mode)
  if (skipTx) mask |= SKIP_TX
  if (skipTy) mask |= SKIP_TY
  if (skipTz) mask |= SKIP_TZ
  return mask
}

// ---------------------------------------------------------------------------
// 导出 1：findAbsoluteOrientation（点对粗配准）
// ---------------------------------------------------------------------------

/** 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface OrientationRequest {
  /** 3N，待对齐点（显示坐标）。 */
  aligned: Float64Array
  /** 3N，参考点（同名点，与 aligned 一一对应）。 */
  reference: Float64Array
  /** 是否同时估计缩放（缺省 false ⇒ 结果 s 恒 1）。 */
  adjustScale?: boolean
  /** `TRANSFORMATION_FILTERS` 位掩码（缺省 0 = 不过滤）。 */
  filters?: number
}

/** 回包。 */
export interface OrientationResult {
  /** false = 退化（点数不等 / < 3 / 三点共线 / 面内旋转不确定）；此时变换与 rms 无意义。 */
  ok: boolean
  /** 9，**行主序** R；`rValid === false` 时这里是单位矩阵（native 保证，不是零矩阵）。 */
  r: Float64Array
  /** 3。 */
  t: Float64Array
  /** 缩放（`adjustScale` 关时恒 1）。 */
  s: number
  /** R 是否已初始化；false = 解算走了"只平移"的退化路径。 */
  rValid: boolean
  /** 过滤后的最终变换下的 RMS；`ok === false` 时 -1。 */
  rms: number
  /** N，逐对距离（过滤后的最终变换下）。 */
  distances: Float64Array
  /** 3N，逐对 (X,Y,Z) 偏差 = 参考点 − 变换后的待对齐点。 */
  deltas: Float64Array
}

// ---------------------------------------------------------------------------
// 导出 2：icp（精细配准）
// ---------------------------------------------------------------------------

/** ICP 结果码（与 native/上游 `ICPRegistrationTools::RESULT_TYPE` **数值一致**）。 */
export const ICP_NOTHING_TO_DO = 0
export const ICP_APPLY_TRANSFO = 1
export const ICP_ERROR = 100
export const ICP_ERROR_REGISTRATION_STEP = 101
export const ICP_ERROR_DIST_COMPUTATION = 102
export const ICP_ERROR_NOT_ENOUGH_MEMORY = 103
export const ICP_ERROR_CANCELED_BY_USER = 104
export const ICP_ERROR_INVALID_INPUT = 105

/** 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface IcpRequest {
  /** **待配准**（会动）的点云。 */
  data: { chunks: RadiusFilterChunkSource[] }
  /** **参考**（不动）的点云。 */
  model: { chunks: RadiusFilterChunkSource[] }
  params: IcpParams
}

/** ICP 参数（字段名与 native/上游 `Parameters` 一致，默认值见 `defaultIcpParams`）。 */
export interface IcpParams {
  /** 最大迭代轮数；与 `minRMSDecrease` **取并集**（任一满足即停，见 README-REF.md）。 */
  maxIterations?: number
  /** 相邻两轮的 RMS 下降小于它就收敛。 */
  minRMSDecrease?: number
  /** 每片云参与计算的点数上限（超出则随机降采样）。 */
  samplingLimit?: number
  /** 预期的重叠度（0 < ratio ≤ 1）；< 1 时每轮只保留距离最小的那一部分点。 */
  finalOverlapRatio?: number
  /** 是否释放缩放（Zinsser 估计）。 */
  adjustScale?: boolean
  /** 缩放下界；NaN = 不限。 */
  minScale?: number
  /** 缩放上界；NaN = 不限。 */
  maxScale?: number
  /** 是否每轮先按 μ+2.5σ 剔除距离过大的点。 */
  filterOutFarthestPoints?: boolean
  /** 每轮对增量变换施加的过滤器（`TRANSFORMATION_FILTERS` 位掩码）。 */
  transformationFilters?: number
  /** 随机降采样种子（**仅供单测**钉"确定性"；缺省 = native 的固定默认种子）。 */
  seed?: number
}

/** 回包。 */
export interface IcpResult {
  /** `ICP_RESULT_*`。 */
  result: number
  /** 最终 RMS（失败时 -1）。 */
  rms: number
  /** 首轮的 RMS（面板"初始 RMS → 最终 RMS"用）。 */
  initialRms: number
  /** 参与最终 RMS 的点数。 */
  pointCount: number
  /** 结束时的迭代轮号（0 起算）。 */
  iterations: number
  r: Float64Array
  t: Float64Array
  s: number
  rValid: boolean
}

// ---------------------------------------------------------------------------
// 导出 3：gicp（GICP 精配准）
// ---------------------------------------------------------------------------

/** GICP 结果码（与 native `GicpResultCode` **数值一致**；那套码本身沿用 ICP 的）。 */
export const GICP_NOTHING_TO_DO = 0
export const GICP_APPLY_TRANSFO = 1
export const GICP_ERROR = 100
export const GICP_ERROR_REGISTRATION_STEP = 101
export const GICP_ERROR_DIST_COMPUTATION = 102
export const GICP_ERROR_NOT_ENOUGH_MEMORY = 103
export const GICP_ERROR_CANCELED_BY_USER = 104
export const GICP_ERROR_INVALID_INPUT = 105

/** 请求体（与 addon.cc 的 request 字段一一对应）。 */
export interface GicpRequest {
  /** **待配准**（会动）的点云。 */
  data: { chunks: RadiusFilterChunkSource[] }
  /** **参考**（不动）的点云。 */
  model: { chunks: RadiusFilterChunkSource[] }
  params: GicpParams
}

/**
 * GICP 参数（字段名与 native `GicpParams` 一致，默认值见 `defaultGicpParams`）。
 *
 * **刻意没有** `adjustScale` / `minScale` / `maxScale`：GICP 是**刚体**（6 自由度）算法，
 * 缩放不在它的模型里（协方差本身就把局部尺度吃掉了）。
 */
export interface GicpParams {
  /** 最大迭代轮数；与 `minRMSDecrease` **取并集**（任一满足即停，见 README-REF.md）。 */
  maxIterations?: number
  /** 相邻两轮的 RMS 下降小于它就收敛。 */
  minRMSDecrease?: number
  /** 每片云参与计算的点数上限（超出则随机降采样）。 */
  samplingLimit?: number
  /** 预期的重叠度（0 < ratio ≤ 1）；< 1 时每轮只保留距离最小的那一部分点。 */
  finalOverlapRatio?: number
  /** 是否每轮先按 μ+2.5σ 剔除距离过大的点。 */
  filterOutFarthestPoints?: boolean
  /** 每轮对增量变换施加的过滤器（`TRANSFORMATION_FILTERS` 位掩码）。 */
  transformationFilters?: number
  /** 随机降采样种子（**仅供单测**钉"确定性"；缺省 = native 的固定默认种子）。 */
  seed?: number
  /**
   * GICP 特有：估计每点局部协方差时的**近邻个数**（对齐 PCL `setCorrespondenceRandomness`，默认 20）。
   *
   * 用个数而不是半径：与点云密度无关，同一份默认值在室内扫描与机载 LiDAR 上都成立。< 3 时
   * 构不成散布矩阵，native 直接报 `GICP_ERROR_INVALID_INPUT`。
   */
  correspondenceRandomness?: number
  /**
   * GICP 特有：是否做**平面化正则化**（局部协方差特征值替换为 `(ε, 1, 1)` = 法向 ε、切平面 1）。
   * 这是经典 GICP 的面到面形态；关掉用原始散布矩阵（对照用，可能病态）。
   */
  useNormalCovariance?: boolean
}

/** 回包。 */
export interface GicpResult {
  /** `GICP_RESULT_*`。 */
  result: number
  /** 最终 RMS（失败时 -1）。 */
  rms: number
  /** 首轮的 RMS（面板"初始 RMS → 最终 RMS"用）。 */
  initialRms: number
  /** 参与最终 RMS 的点数。 */
  pointCount: number
  /** 结束时的迭代轮号（0 起算）。 */
  iterations: number
  r: Float64Array
  t: Float64Array
  s: number
  rValid: boolean
  // GICP 统计信息
  covarianceError: number
}

// ---------------------------------------------------------------------------
// 模块导出契约 + Promise 包装
// ---------------------------------------------------------------------------

/** native 模块导出契约（registration.node，**三个导出**）。 */
export interface RegistrationAddon {
  findAbsoluteOrientation: (
    request: OrientationRequest,
    callback: (err: Error | null, result?: OrientationResult) => void
  ) => void
  icp: (request: IcpRequest, callback: (err: Error | null, result?: IcpResult) => void) => void
  gicp: (request: GicpRequest, callback: (err: Error | null, result?: GicpResult) => void) => void
}

/**
 * 点对粗配准（uv 线程池异步；Promise 化，compute 同步抛错一并收敛）。
 *
 * 点数极少（几对同名点），耗时在微秒级；**解算 → 变换过滤 → RMS → 逐对偏差全在 native 内一次做完**
 *（避免在 JS 里复制一份 FilterTransformation / ComputeRMS —— 两处实现必然漂移）。
 */
export async function findAbsoluteOrientation(request: OrientationRequest): Promise<OrientationResult> {
  const addon = await loadNativeModule<RegistrationAddon>('registration')
  return new Promise<OrientationResult>((resolve, reject) => {
    try {
      addon.findAbsoluteOrientation(request, (err, result) => {
        if (err) reject(err)
        else if (!result) reject(new Error('registration.findAbsoluteOrientation 未返回结果'))
        else resolve(result)
      })
    } catch (e) {
      reject(e) // 入参非法时绑定层同步抛错（不走回调）
    }
  })
}

/** ICP 精配准（uv 线程池异步；≤5 万采样点 × 20 轮 = 百毫秒级）。 */
export async function computeIcp(request: IcpRequest): Promise<IcpResult> {
  const addon = await loadNativeModule<RegistrationAddon>('registration')
  return new Promise<IcpResult>((resolve, reject) => {
    try {
      addon.icp(request, (err, result) => {
        if (err) reject(err)
        else if (!result) reject(new Error('registration.icp 未返回结果'))
        else resolve(result)
      })
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * GICP 精配准（uv 线程池异步，单线程计算）。
 *
 * 比 `computeIcp` 贵一个量级：两侧协方差 PCA ≈ `2n` 次 kNN 查询，之后每轮还有 N 次
 * 3x3 求逆 + 一次 6x6 特征分解。默认 5 万采样点 × 20 轮是**秒级**（ICP 是百毫秒级）。
 */
export async function computeGicp(request: GicpRequest): Promise<GicpResult> {
  const addon = await loadNativeModule<RegistrationAddon>('registration')
  return new Promise<GicpResult>((resolve, reject) => {
    try {
      addon.gicp(request, (err, result) => {
        if (err) reject(err)
        else if (!result) reject(new Error('registration.gicp 未返回结果'))
        else resolve(result)
      })
    } catch (e) {
      reject(e)
    }
  })
}

// ---------------------------------------------------------------------------
// 参数默认值（照抄 CC 的对话框默认值，qCC/ccRegistrationDlg.cpp:L36-160）
// ---------------------------------------------------------------------------

/** ICP 参数默认值（也是面板初值；改成这里即改面板）。 */
export function defaultIcpParams(): Required<Omit<IcpParams, 'seed'>> {
  return {
    maxIterations: 20,
    minRMSDecrease: 1.0e-5,
    samplingLimit: 50000,
    finalOverlapRatio: 1.0,
    adjustScale: false,
    minScale: NaN, // NaN = 不限（同上游 Parameters 构造函数）
    maxScale: NaN,
    filterOutFarthestPoints: false,
    transformationFilters: SKIP_NONE,
  }
}

/**
 * GICP 参数默认值（也是面板初值；改成这里即改面板）。
 *
 * 前七项与 `defaultIcpParams` 逐字一致（GICP 的迭代/采样/过滤与 ICP 同源）；
 * `correspondenceRandomness: 20` 对齐 PCL `setCorrespondenceRandomness` 的默认值。
 */
export function defaultGicpParams(): Required<Omit<GicpParams, 'seed'>> {
  return {
    maxIterations: 20,
    minRMSDecrease: 1.0e-5,
    samplingLimit: 50000,
    finalOverlapRatio: 1.0,
    filterOutFarthestPoints: false,
    transformationFilters: SKIP_NONE,
    correspondenceRandomness: 20,
    useNormalCovariance: true,
  }
}

/** ICP 结果码 → 人话（面板结果行与 Console 共用；未知码回落到泛化文案）。 */
export function describeIcpResult(code: number): string {
  switch (code) {
    case ICP_NOTHING_TO_DO:
      return '两片点云已经重合（初始 RMS 已达精度下限），无需移动'
    case ICP_APPLY_TRANSFO:
      return '收敛'
    case ICP_ERROR_REGISTRATION_STEP:
      return '解算退化（到位姿解不出旋转，如参考点集缩成一个点）'
    case ICP_ERROR_DIST_COMPUTATION:
      return '最近邻距离计算失败'
    case ICP_ERROR_NOT_ENOUGH_MEMORY:
      return '内存不足'
    case ICP_ERROR_CANCELED_BY_USER:
      return '被用户取消'
    case ICP_ERROR_INVALID_INPUT:
      return '入参非法（点数不足 / 重叠度或采样上限越界 / 索引越界）'
    default:
      return `未知错误（结果码 ${code}）`
  }
}

/** GICP 结果码 → 人话（面板结果行与 Console 共用；未知码回落到泛化文案）。 */
export function describeGicpResult(code: number): string {
  switch (code) {
    case GICP_NOTHING_TO_DO:
      return '两片点云已经重合（初始 RMS 已达精度下限），无需移动'
    case GICP_APPLY_TRANSFO:
      return '收敛'
    case GICP_ERROR_REGISTRATION_STEP:
      return '解算退化（到位姿解不出旋转，如参考点集缩成一个点）'
    case GICP_ERROR_DIST_COMPUTATION:
      return '最近邻距离计算失败'
    case GICP_ERROR_NOT_ENOUGH_MEMORY:
      return '内存不足'
    case GICP_ERROR_CANCELED_BY_USER:
      return '被用户取消'
    case GICP_ERROR_INVALID_INPUT:
      return '入参非法（点数不足 / 重叠度或采样上限越界 / 索引越界）'
    default:
      return `未知错误（结果码 ${code}）`
  }
}

// ---------------------------------------------------------------------------
// 变换：native 回包 → pointcloudStore 的 EntityTransform
// ---------------------------------------------------------------------------

/**
 * native 的三件套（行主序 R + T + s）→ `{ matrix, scale }`。
 *
 * `Matrix4.set` 的入参是**行主序**（内部转列主序存储），与 native 的 9 个元素同序，故直接铺。
 * `rValid === false` 时 native 已发单位矩阵（见 addon.cc 的 WriteTransform），这里不再分叉。
 */
export function toEntityTransform(r: Float64Array, t: Float64Array, s: number): EntityTransform {
  const matrix = new THREE.Matrix4()
  matrix.set(r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2], 0, 0, 0, 1)
  return { matrix, scale: s }
}

/**
 * 在 JS 侧复算"变换作用于一点"（单测对照用；生产不调用，避免与 native 两份实现漂移）。
 *
 * ⚠ **顺序不能反**：约定是 `P' = s·(R·P) + T`（T 不被缩放）。`Vector3` 上两种写法只差一步
 * 却完全不同——`.multiplyScalar(s)` 必须在 `applyMatrix4` **之前**，否则连平移一起被缩放，
 * 得到 `s·R·P + s·T`（实测偏 `(s−1)·T`，s = 2 时正好差一个 T 那么大）。
 * 与 three 的 Group 合成（`matrix = T·R·S`，平移最后生效）正好一致。
 */
export function applyEntityTransformToPoint(trans: EntityTransform, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).multiplyScalar(trans.scale).applyMatrix4(trans.matrix)
}

/** Group 位姿（three 的 `matrix = T·R·S` 三个分量）。 */
export interface PreviewPose {
  quaternion: THREE.Quaternion
  position: THREE.Vector3
  scale: THREE.Vector3
}

/**
 * 在基准位姿 B 上合成显示坐标系的变换 M，得到预览时 Group 应有的位姿 **B·M**。
 *
 * 背景：分块几何体装的是 Z-up **显示坐标**，Group 的基准位姿 B（加载时是
 * `rotation.x = -π/2`）负责把它摆到世界系。所以"让变换 M 作用在显示坐标上"等价于
 * 让 Group 变成 `B·M`（先 M 后 B）—— 不能直接把 M 写进 group，也不能丢掉 q0：
 * 中间夹着的这个基准旋转正是本函数存在的理由。
 *
 * 按 three 的 `matrix = T·R·S` 合成序展开（`B = T(p0)·R(q0)·S(s0)`）：
 *
 *     B·M = T(p0)·R(q0)·S(s0)·T(T)·Rm·S(s)
 *         = T(p0 + s0·R(q0)·T)·R(q0 ⊗ qm)·S(s0·s)
 *
 * 即：
 *   - `quaternion = q0 ⊗ qm`（**左乘**：three 的乘法是"右操作数先作用"，故先转 M 再转基准）
 *   - `position = p0 + s0·(R(q0)·T)`（T 先被基准旋转、再被基准缩放，最后加 p0）
 *   - `scale = s0 · s`（均匀缩放只能落在 scale 上，没法并进四元数或位置）
 *
 * ⚠ 位置项最容易漏掉 `s0`（基准缩放）与 `R(q0)`（基准旋转）之一：只写 `p0 + T` 在
 * "基准无旋转、无缩放"的直觉下看着对，实际会整体偏掉一个基准旋转的量。
 *
 * @param base 基准位姿（**首次预览时**从 Group 上快照的 T·R·S；必须是原值，不是上一次
 *   预览后的值，否则连续预览会层层叠加）
 * @param t    显示坐标系的变换（native 回包 → toEntityTransform）
 * @param out  复用同一对象可避免每帧分配；省略则新建
 */
export function composePreviewPose(base: PreviewPose, t: EntityTransform, out?: PreviewPose): PreviewPose {
  const pose: PreviewPose = out ?? {
    quaternion: new THREE.Quaternion(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
  }
  // 基准缩放是均匀的（加载 / 分割产物都由 setScalar 或默认 1 得到），取 x 分量即可
  const s0 = base.scale.x
  const qm = new THREE.Quaternion().setFromRotationMatrix(t.matrix)
  pose.quaternion.copy(base.quaternion).multiply(qm)
  pose.position
    .set(t.matrix.elements[12], t.matrix.elements[13], t.matrix.elements[14])
    .applyQuaternion(base.quaternion) // R(q0)·T
    .multiplyScalar(s0) // s0·(R(q0)·T)
    .add(base.position)
  pose.scale.copy(base.scale).multiplyScalar(t.scale)
  return pose
}

// ---------------------------------------------------------------------------
// 点对会话（拾取点 / 同名点对 / 请求构建）
// ---------------------------------------------------------------------------

/** 一个拾取点的精简体（坐标是**显示坐标**；三个 id 供覆盖物与"点对表格"定位）。 */
export interface RegistrationPick {
  entityId: number
  chunkIndex: number
  vertexIndex: number
  x: number
  y: number
  z: number
}

/**
 * 一对同名点：`first` 属于第 1 个目标实体、`second` 属于第 2 个（实体顺序见 store 的 targetIds）。
 *
 * 两侧点的归属由**实体**决定而不是"拾取顺序"：面板可以在两个实体间切换角色
 *（谁待对齐、谁参考），切换只是把 `first`/`second` 映射到另一个角色，点本身不动。
 */
export interface RegistrationPair {
  first: RegistrationPick
  second: RegistrationPick
}

/** 角色：0 = 第 1 个实体待对齐（data），1 = 第 2 个实体待对齐。 */
export type AlignedRole = 0 | 1

/**
 * 点对 → native 的两串坐标（纯函数，可单测）。
 *
 * @param pairs       同名点对（`first`/`second` 分属两个目标实体）
 * @param alignedRole 哪个实体待对齐（决定两组点的方向，也就决定解出的变换方向）
 */
export function buildOrientationPoints(
  pairs: RegistrationPair[],
  alignedRole: AlignedRole
): { aligned: Float64Array; reference: Float64Array } {
  const n = pairs.length
  const aligned = new Float64Array(n * 3)
  const reference = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = alignedRole === 0 ? pairs[i].first : pairs[i].second
    const r = alignedRole === 0 ? pairs[i].second : pairs[i].first
    aligned[i * 3] = a.x
    aligned[i * 3 + 1] = a.y
    aligned[i * 3 + 2] = a.z
    reference[i * 3] = r.x
    reference[i * 3 + 1] = r.y
    reference[i * 3 + 2] = r.z
  }
  return { aligned, reference }
}

/** 解算所需的最小同名点对数（上游 `ccPointPairRegistrationDlg::MIN_PAIRS_COUNT = 3`）。 */
export const MIN_PAIRS_COUNT = 3

// ---------------------------------------------------------------------------
// 「恰好 2 个点云」的选择解析（模态入口判据 + 两个 store 的启动判据）
// ---------------------------------------------------------------------------

/** 解析结果：成功给两个实体（**顺序 = 选择顺序**），失败给人话原因。 */
export type RegistrationPairResult =
  { ok: true; first: number; second: number; firstName: string; secondName: string } | { ok: false; reason: string }

/** 点云是否已加载完成（bbox 与 globalShift 由加载流程回填，未加载完拿不到渲染缓冲）。 */
function isEntityReady(entity: { bbox: unknown; globalShift: unknown } | undefined): boolean {
  return !!entity && !!entity.bbox && !!entity.globalShift
}

/**
 * 把选中项解析成**恰好两个**已加载完成的点云（纯函数）。
 *
 * 多选语义与 `normalStore.resolveNormalSelection` 一致：项目 = 其全部子实体、
 * 容器 = 其 `entityIds`、实体 = 它自己；去重保序，故**顺序就是选择顺序**
 *（对项目/容器展开的情况则是其内部顺序）——上游 CC 用"先选中 = data、后选中 = model"，
 * 本应用把角色选择交给面板（可在两个实体间对调），顺序只决定面板的默认角色。
 *
 * 严格 2 选是**刻意**的（用户已确认）：配准是两片云之间的事，多选第三片只会让人误拾。
 *
 * @param sels     选中集合（`sceneStore.selection`）
 * @param projects 项目列表（`sceneStore.projects`；只读，不改）
 */
export function resolveRegistrationPair(sels: SceneSelection[], projects: SceneProject[]): RegistrationPairResult {
  const entityIds: number[] = []
  const seen = new Set<number>()
  const push = (id: number) => {
    if (!seen.has(id)) {
      seen.add(id)
      entityIds.push(id)
    }
  }
  for (const sel of sels) {
    if (sel.type === 'entity') {
      push(sel.id)
    } else if (sel.type === 'project') {
      // SceneEntity 不带 parentId，项目 → 子实体只能走项目自己的 entities 列表
      for (const e of projects.find((p) => p.id === sel.id)?.entities ?? []) push(e.id)
    } else {
      const group = projects.flatMap((p) => p.treeGroups).find((g) => g.id === sel.id)
      for (const id of group?.entityIds ?? []) push(id)
    }
  }

  if (entityIds.length !== 2) {
    return {
      ok: false,
      reason: `配准需要恰好 2 个点云（当前 ${entityIds.length} 个）—— 在 DB Tree 里点选第一个，按住 Ctrl 点选第二个`,
    }
  }

  const all = projects.flatMap((p) => p.entities)
  const first = all.find((e) => e.id === entityIds[0])
  const second = all.find((e) => e.id === entityIds[1])
  if (!isEntityReady(first) || !isEntityReady(second)) {
    return { ok: false, reason: '选中的点云尚未加载完成' }
  }
  return {
    ok: true,
    first: entityIds[0],
    second: entityIds[1],
    firstName: first?.name ?? '',
    secondName: second?.name ?? '',
  }
}
