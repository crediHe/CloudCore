/**
 * 标准视角方位表（仿 CloudCompare / 建模软件六向视图）。
 * 纯数据、零依赖（不碰 three/DOM），供引擎 engine.ts 与单测复用。
 *
 * 约定：dir 为"从观察目标(target)指向相机"的单位向量，即相机站在该方向
 * 看向 target。轴向为 three.js 右手系、Y 向上（与引擎的 GridHelper 一致）：
 *
 *   front 前：相机在 +Z 侧（视线朝 −Z）   top 上：相机在 +Y 俯视（视线朝 −Y）
 *   back  后：相机在 −Z 侧（视线朝 +Z）   bottom 下：相机在 −Y 仰视（视线朝 +Y）
 *   left  左：相机在 −X 侧（视线朝 +X）   right 右：相机在 +X 侧（视线朝 −X）
 *
 * 前后、左右的 ± 分配属惯例选择（不同软件略有出入），若要调整只改本表，
 * 引擎与 UI 无需任何改动。
 *
 * 注意：本表只给方向、不给 up——相机姿态由"位置 + lookAt/轨道控制器"决定
 * （上/下视时视线与世界 +Y 平行，OrbitControls 在 update() 内用 makeSafe()
 * 微偏极角，规避 lookAt 与 up 平行的退化，见 engine.setView 的实现注释）。
 */

/** 六个标准视角名。 */
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'

/** 单位方位向量（target → 相机），与 THREE.Vector3 同字段以便直接构造。 */
export interface ViewDirection {
  x: number
  y: number
  z: number
}

/** 视角名 → 相机方位。 */
export const VIEW_DIRECTIONS: Record<ViewName, ViewDirection> = {
  front: { x: 0, y: 0, z: 1 },
  back: { x: 0, y: 0, z: -1 },
  left: { x: -1, y: 0, z: 0 },
  right: { x: 1, y: 0, z: 0 },
  top: { x: 0, y: 1, z: 0 },
  bottom: { x: 0, y: -1, z: 0 },
}
