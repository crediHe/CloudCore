/**
 * 相机投影切换的纯数学（透视 ↔ 正射，仿 CloudCompare）。
 *
 * 纯函数、零依赖（不碰 three/DOM），供引擎 engine.ts 与单测复用。
 *
 * 语义约定：
 *  - fov 为垂直视场角（度，three.PerspectiveCamera.fov 同款）；
 *  - d 为相机到 controls.target 的距离；
 *  - 透视下目标平面（过 target、垂直于视线）可见半高 = d·tan(fov/2)；
 *  - 正射有效可视范围 = bounds/zoom（three 约定：updateProjectionMatrix
 *    用 1/zoom 缩放 left/right/top/bottom）。故"切换不跳变"取
 *    top = d·tanHalf、zoom=1；正射内滚轮只改 zoom，返回透视时
 *    d' = top/(zoom·tanHalf)，与透视 dolly 语义同构，往返不漂移。
 */

export type ProjectionMode = 'perspective' | 'orthographic'

/** fov/2 的正切（fov 为垂直视场角，度）。 */
export function tanHalfFov(fovDeg: number): number {
  return Math.tan((fovDeg * Math.PI) / 360)
}

/** 距离 d 处透视目标平面的可见半高。 */
export function orthoHalfHeight(fovDeg: number, distance: number): number {
  return distance * tanHalfFov(fovDeg)
}

/** 正射相机的近平面矩形（对称于视线，垂直方向由 fov+distance 决定，水平随 aspect）。 */
export interface OrthoBounds {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * 由透视参数换算正射 bounds：切换瞬间目标平面画面不跳变。
 * @param fovDeg 垂直视场角（度，来自透视相机 fov）
 * @param distance 相机到 target 距离
 * @param aspect 画布宽高比
 */
export function computeOrthoBounds(fovDeg: number, distance: number, aspect: number): OrthoBounds {
  const top = orthoHalfHeight(fovDeg, distance)
  return { top, bottom: -top, right: top * aspect, left: -top * aspect }
}

/**
 * 正射 → 透视的距离还原：由正射 top（进入时半高）与当前 zoom 反推
 * 等价的透视相机到 target 距离。
 * zoom 为 0 时返回 Infinity，为负时返回负值（均属非法输入，调用方须兜底）。
 */
export function perspectiveDistanceFromOrtho(orthoTop: number, fovDeg: number, zoom: number): number {
  return orthoTop / (zoom * tanHalfFov(fovDeg))
}
