import type { CsfChunkSource } from './csf'

/**
 * 精准地面分割（csf-pro：老算法液体贴合语义 CSF）的渲染侧契约镜像。
 *
 * C++ 算法本体见 native/csf-pro/src/csf_pro.cc（逐式移植项目内老代码
 * doc/CSF地面识别算法/native_src/csf_algorithm.cc 的贴地布料语义——布料
 * 每轮只抬升不 pin，垂坠贴合丘陵/山脉坡面，分割精度高于 qCSF 机载语义的
 * native/csf-lidar，代价是收敛慢，需配进度条）；N-API 绑定壳的请求/响应契约
 * 见 native/csf-pro/src/addon.cc 顶部注释。**任何入参/出参语义改动必须两处同步**。
 *
 * 与 csf-lidar 的差异：
 * - compute(request, onProgress, callback) 三参：AsyncProgressWorker 每轮迭代
 *   回报进度，取消走 addon.cancel()（uv 线程池内每轮检查，提前中止）。
 * - request 含 convergenceEps（收敛阈值 1e-3）且**无** smoothSlope / heightAxis
 *   （老算法无陡坡后处理，几何恒 z-up）。
 * - 输出 ground[c] 语义与 csf-lidar 相同（第 c 块地面顶点下标，递增）。
 */

/** 单块候选源：结构与半径滤波/CSF 的块源完全相同（零拷贝引用渲染缓冲）。 */
export type CsfProChunkSource = CsfChunkSource

/** 单实体输入。 */
export interface CsfProEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: CsfProChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应；数字字段全必填）。 */
export interface CsfProRequest {
  /** 布料网格间距（与点云坐标同单位；支撑采样半径 = 其 1.5 倍）。 */
  clothResolution: number
  /** 布料刚性 1..3（1 最柔；内部约束强度 = (rigidness/3)×0.5）。 */
  rigidness: number
  /** 最大迭代次数（收敛早停通常先触发；无 pin 收敛慢，请配进度条）。 */
  iterations: number
  /** 时间步（默认 0.65；重力每轮 = timeStep×0.65，匀速下落模型）。 */
  timeStep: number
  /** 分类阈值：点到布料模拟地表的高度差小于它判为地面（与坐标同单位）。 */
  classThreshold: number
  /** 收敛阈值：连续 3 轮无抬升且内部最大位移小于它即提前结束（默认 1e-3）。 */
  convergenceEps: number
  entities: CsfProEntitySource[]
}

/** 迭代级进度（onProgress 回调参数；overall 0..1）。 */
export interface CsfProProgress {
  /** 整体进度 0..1（实体粒度均分 × 当前实体迭代占比）。 */
  overall: number
  /** 当前实体已完成迭代（1 起）。 */
  iteration: number
  /** 当前实体序（1 起）。 */
  entity: number
  /** 实体总数。 */
  entityTotal: number
}

/** 单实体结果：ground[c] = 第 c 块地面顶点下标（递增，顶点缓冲空间）。 */
export interface CsfProEntityResult {
  entityId: number
  ground: Uint32Array[]
}

/** native 模块导出契约（csf_pro.node）。 */
export interface CsfProAddon {
  compute: (
    request: CsfProRequest,
    onProgress: (p: CsfProProgress) => void,
    callback: (err: Error | null, results?: CsfProEntityResult[]) => void
  ) => void
  /** 请求取消当前活跃计算（幂等；uv 线程每轮检查后走错误回调中止）。 */
  cancel: () => void
}

/** 渲染侧与 C++ 对齐的隐藏参数（不暴露 UI；对齐老代码 CSFParams 默认）。 */
export const CSF_PRO_FIXED = {
  /** 最大模拟迭代（老代码默认 500）。 */
  iterations: 500,
  /** 时间步（老代码默认 0.65；每轮重力 = timeStep×0.65）。 */
  timeStep: 0.65,
  /** 收敛阈值下限（老代码 convergence_eps = 1e-3；实际容差 = max(该值, 布料分辨率×0.15)）。 */
  convergenceEps: 1e-3,
} as const

/** 进入模式的初始参数（对齐老界面 GroundClassification.vue 默认，不做数据量级估算）。 */
export const CSF_PRO_DEFAULT = {
  /** 布料网格间距（米，与坐标同单位）。 */
  clothResolution: 0.6,
  /** 分类阈值（米）。 */
  classThreshold: 0.4,
  /** 布料刚性 1..3。 */
  rigidness: 2,
} as const

/** 输入控件步进/提示范围（对齐老界面：分辨率 0.3-2.0 步进 0.1、阈值 0.1-1.0 步进 0.05）。 */
export const CSF_PRO_INPUT = {
  clothResolution: { min: 0.3, max: 2.0, step: 0.1 },
  classThreshold: { min: 0.1, max: 1.0, step: 0.05 },
} as const
