import { estimateMeanPointSpacing } from './radiusFilter'
import type { RadiusFilterChunkSource } from './radiusFilter'

/**
 * LiDAR 地面分割（CSF 布料模拟滤波，CloudCompare qCSF 机载语义）的渲染侧契约镜像。
 * 丘陵/山脉等起伏地形的贴身高精度版另见 csf-proStore（native/csf-pro）。
 *
 * C++ 算法本体见 native/csf-lidar/src/csf.cc（语义对齐 CloudCompare qCSF）；
 * N-API 绑定壳的请求/响应契约见 native/csf-lidar/src/addon.cc 顶部注释。
 * **任何入参/出参语义改动必须两处同步**。
 *
 * 与半径滤波的关键差异：
 * - 布料网格铺在实体**全部候选点**的水平范围上（与块切分无关），一次迭代整块
 *   实体一起算；输出 ground[c] = 第 c 块地面顶点下标（顶点缓冲空间，递增）。
 * - 非地面 = 候选全集补集，渲染侧用 splitKeptRemoved（radiusFilter.ts）推导
 *   （kept ← ground，语义与 kept/removed 无关，纯补集 + 包围盒工具）。
 */

/** 单块候选源：结构与半径滤波的块源完全相同（零拷贝引用渲染缓冲）。 */
export type CsfChunkSource = RadiusFilterChunkSource

/** 单实体输入。 */
export interface CsfEntitySource {
  /** 透传给结果用于核对（约定为 sceneStore 实体 id）。 */
  entityId: number
  chunks: CsfChunkSource[]
}

/** compute 请求体（与 addon.cc 的 request 字段一一对应；数字字段全必填）。 */
export interface CsfRequest {
  /** 布料网格间距（与点云坐标同单位；越小越贴合细节，粒子数随其平方反比增长）。 */
  clothResolution: number
  /** 布料刚性 1..3（1 最柔；CC 三档，见系数表）。 */
  rigidness: number
  /** 最大迭代次数（模拟收敛即早停，非固定成本）。 */
  iterations: number
  /** 模拟时间步（CC 内部固定 0.65，此处随契约外露）。 */
  timeStep: number
  /** 分类阈值：点距布料面的高度差小于它判地面（与坐标同单位）。 */
  classThreshold: number
  /** 是否启用陡坡后处理（移除被突起地形牵住的布料孤岛，见 CC 文档）。 */
  smoothSlope: boolean
  /** 输入坐标竖直向上轴 0/1/2；本项目几何保持 Z-up，恒为 2。 */
  heightAxis: number
  entities: CsfEntitySource[]
}

/** 单实体结果：ground[c] = 第 c 块地面顶点下标（递增，顶点缓冲空间）。 */
export interface CsfEntityResult {
  entityId: number
  ground: Uint32Array[]
}

/** native 模块导出契约（csf_lidar.node）。 */
export interface CsfAddon {
  compute: (
    request: CsfRequest,
    callback: (err: Error | null, results?: CsfEntityResult[]) => void
  ) => void
}

/** 渲染侧与 C++ 对齐的隐藏参数（不暴露 UI；C++ 侧默认值相同）。 */
export const CSF_FIXED = {
  /** 最大模拟迭代（CC 固定 500）。 */
  iterations: 500,
  /** 模拟时间步（CC 内部 DT 0.65）。 */
  timeStep: 0.65,
  /** 几何坐标 Z-up → 竖直轴恒为第 2 轴（CSF 内部取负为模拟高度）。 */
  heightAxis: 2,
} as const

/**
 * 按数据量级估计 CSF 初始参数（纯量级参考，用户随后手动调整）。
 *
 * 布料分辨率须远大于典型点距（每粒子的格子内落多点做高度场、抗噪），
 * 又不能大到吞掉地形细节——取平均点距 ×4；分类阈值须覆盖点云表面噪声
 * 与布料网格自身拟合误差的量级，取平均点距 ×2。与坐标同单位（显示坐标
 * = 原始坐标 - 基准点，差分距离不变，直接用实体 bbox 差分算）。
 *
 * 极端退化输入（点数 < 2 / 各轴延伸均为 0）返回 1（estimateMeanPointSpacing
 * 的兜底），保证初始布料分辨率非 0。
 */
export function estimateCsfDefaults(
  count: number,
  extent: { x: number; y: number; z: number }
): { clothResolution: number; classThreshold: number } {
  const spacing = estimateMeanPointSpacing(count, extent)
  return { clothResolution: spacing * 4, classThreshold: spacing * 2 }
}
