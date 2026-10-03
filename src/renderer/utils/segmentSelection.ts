import * as THREE from 'three'
import type { EntityBBox } from '../stores/sceneStore'

/**
 * 分割的选区计算（纯算法，可单测）。
 *
 * 思路源自 doc/多边形分割/PlyUtils.js 的 findPointsInQuadrangle /
 * findPointsInArbitraryPolygon：
 * 把 NDC 图形（矩形或自由多边形）当成屏幕框，逐点用 viewProj 矩阵投影到 NDC
 * 做内部判定，命中即"选区内"。与老代码的关键区别：
 *  1. 本项目点云挂在 rotation.x=-π/2 的 Group 内（局部坐标 ≠ 世界坐标），
 *     viewProj 必须乘上 group.matrixWorld（S1，单测含旋转 group 回归用例）；
 *  2. 相机背后的点（w<=0）归入 outside（老四边形函数直接丢弃，正反选不对称）；
 *  3. 分块遍历之间让出主线程（呼吸权），不阻塞 UI。
 *  4. 分割产物是"共享全量顶点缓冲 + index 子集"（pointcloudStore.buildIndexedGeometry），
 *     可见点集必须走 index 条目而非 position.count——后者是整块缓冲的点数，直接遍历
 *     会把兄弟子集（同一缓冲里另一半的点）也纳入选区，是二次分割混入他块点的根因；
 *     inside/outside 输出 index 条目指向的顶点下标，新子集换索引即可复用同一缓冲。
 *
 * 真实选择语义是"过图形窗口的视锥"（含平面后方、前后纵深上的点），
 * 与 CloudCompare 屏空间选取一致；3D 覆盖物只是该窗口在锚定平面上的截面。
 *
 * 算法只用相机投影矩阵族（projectionMatrix / matrixWorldInverse / updateMatrixWorld），
 * 对透视/正交相机类型中性，见各入口形参注释与 computeSelectionCore 的 z 裁剪分支。

/**
 * 单块点云的选区结果：inside/outside 两个递增序索引数组 + 两侧显示坐标包围盒。
 * 索引始终是"顶点缓冲空间"的下标（不是几何体可见条目的序号）：对分割产物
 * （共享全量缓冲 + index 子集）即 index 条目指向的顶点下标，新子集可直接换用同一缓冲。
 */
export interface ChunkSelection {
  inside: Uint32Array
  outside: Uint32Array
  /** 显示坐标（已减共享基准点）下的子集包围盒；还原原始坐标时 +globalShift。 */
  insideBBox: EntityBBox
  outsideBBox: EntityBBox
}

/** 分割目标：一个点云实体 = Group + 分块几何体列表（与 cloudRecords 对齐）。 */
export interface SegmentTarget {
  entityId: number
  group: THREE.Group
  geometries: THREE.BufferGeometry[]
}

/** NDC 矩形（[-1,1] 空间，Y 已翻转）。 */
export interface NdcRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** NDC 空间二维点（[-1,1]，Y 已翻转），自由多边形的顶点（点击顺序）。 */
export interface NdcPoint {
  x: number
  y: number
}

/** 空分块的选区结果（0 点块防御用）。 */
const EMPTY_BBOX: EntityBBox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }

/**
 * 选区计算共享核心：对每个目标实体的每块 geometry 生成 inside/outside 索引。
 * 两遍遍历的骨架（矩阵刷新、viewProj、w<=0 归外部、包围盒累积、onChunk 让出主线程）
 * 与图形形状无关，只有"内部判定"由 isInside 谓词决定：
 * 四边形 = NDC 包围盒比较；自由多边形 = NDC AABB 预过滤 + even-odd 射线法。
 * 可见点集：无 index 的原始几何体 = 整条顶点缓冲；带 index 的分割产物 = 其 index
 * 条目（drawRange 作用在条目上），输出条目指向的顶点下标（见 ChunkSelection）。
 * 只读 camera.projectionMatrix / matrixWorldInverse 并调 updateMatrixWorld，对相机类型中性，
 * 透视与正交（正射投影）均适用。
 * @param camera 相机（选区时视角，绘制期间应已锁定）
 * @param scene  场景（用于刷新 group.matrixWorld）
 * @param targets 分割目标列表
 * @param isInside NDC 内部判定谓词（nx/ny 为投影后的 NDC 坐标）
 * @param onChunk 每处理完一块回调（让出主线程用；可异步）
 * @returns entityId → 各块 ChunkSelection（顺序与 target.geometries 对齐）
 */
async function computeSelectionCore(
  camera: THREE.Camera,
  scene: THREE.Scene,
  targets: SegmentTarget[],
  isInside: (nx: number, ny: number) => boolean,
  onChunk?: () => void | Promise<void>
): Promise<Map<number, ChunkSelection[]>> {
  // 刷新矩阵：camera 不在 scene 里（不随 scene.updateMatrixWorld 更新），需单独刷新；
  // matrixWorldInverse 由 Camera.updateMatrixWorld 内部同步。
  camera.updateMatrixWorld(true)
  scene.updateMatrixWorld(true)

  // 正交相机时 w≡1 恒正，可见性须走 clip z 裁剪（见循环内注释）。
  // isOrthographicCamera 只声明在具体子类上，此处对 Camera 类型做窄化。
  const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true

  const result = new Map<number, ChunkSelection[]>()
  for (const target of targets) {
    // viewProj = projection × matrixWorldInverse × group.matrixWorld（局部坐标 → 世界 → 视口）
    const viewProj = new THREE.Matrix4()
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    viewProj.multiply(target.group.matrixWorld)
    const m = viewProj.elements

    const perChunk: ChunkSelection[] = []
    for (const geometry of target.geometries) {
      const position = geometry.attributes.position
      const positions = position.array as Float32Array
      // 可见点集合：分割产物（buildIndexedGeometry）的几何体共享整块顶点缓冲，只靠
      // index + drawRange 圈出属于自己的点。此刻 position.count 是整块缓冲的点数，
      // 若按它遍历会把兄弟子集（如第一次分割出的另一半）的点一并筛进选区——必须改走
      // index 条目；无索引的原始几何体退化为遍历整条缓冲（可见点 = 顶点）。
      const indexAttr = geometry.index
      // indexArr 仅供 vertexAt 复用数组引用；count/drawRange 窄化直接用 indexAttr（别名不参与窄化）
      const indexArr = indexAttr ? (indexAttr.array as unknown as ArrayLike<number>) : null
      // 迭代区间：有索引时遍历 index 条目 [rangeStart, end)（drawRange 作用于条目，
      // 默认 count=Infinity 表示取完）；无索引时即 [0, position.count)
      let rangeStart = 0
      let visibleCount = position.count
      if (indexAttr) {
        const count = indexAttr.count
        rangeStart = Math.min(Math.max(geometry.drawRange.start, 0), count)
        const end = Number.isFinite(geometry.drawRange.count)
          ? Math.min(count, geometry.drawRange.start + geometry.drawRange.count)
          : count
        visibleCount = Math.max(end - rangeStart, 0)
      }
      // 可见点条目 i → 顶点缓冲下标（无索引时即 i 本身）
      const vertexAt = (i: number) => (indexArr ? indexArr[rangeStart + i] : i)
      if (visibleCount === 0) {
        perChunk.push({
          inside: new Uint32Array(0),
          outside: new Uint32Array(0),
          insideBBox: EMPTY_BBOX,
          outsideBBox: EMPTY_BBOX,
        })
        if (onChunk) await onChunk()
        continue
      }

      // 第一遍：统计 inside 数量 + 累积 inside 包围盒（显示坐标）
      let insideCount = 0
      let inMinX = Infinity,
        inMinY = Infinity,
        inMinZ = Infinity
      let inMaxX = -Infinity,
        inMaxY = -Infinity,
        inMaxZ = -Infinity
      for (let i = 0; i < visibleCount; i++) {
        const vi = vertexAt(i)
        const i3 = vi * 3
        const x = positions[i3],
          y = positions[i3 + 1],
          z = positions[i3 + 2]
        const w = m[3] * x + m[7] * y + m[11] * z + m[15]
        // 正交相机投影矩阵第 4 行为 (0,0,0,1)，w≡1——"相机背后/超出近远平面"的点与
        // 前方同 NDC，必须用 clip z（投影矩阵第 3 行）排除，否则被误判进选区内。
        const zc = isOrtho ? m[2] * x + m[6] * y + m[10] * z + m[14] : 0
        if (isOrtho ? zc < -w || zc > w : w <= 0) continue
        const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w
        const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w
        if (!isInside(nx, ny)) continue
        insideCount++
        if (x < inMinX) inMinX = x
        if (y < inMinY) inMinY = y
        if (z < inMinZ) inMinZ = z
        if (x > inMaxX) inMaxX = x
        if (y > inMaxY) inMaxY = y
        if (z > inMaxZ) inMaxZ = z
      }

      // 第二遍：填 inside / outside 数组（递增序），并累积 outside 包围盒
      const inside = new Uint32Array(insideCount)
      const outside = new Uint32Array(visibleCount - insideCount)
      let wi = 0,
        wo = 0
      let outMinX = Infinity,
        outMinY = Infinity,
        outMinZ = Infinity
      let outMaxX = -Infinity,
        outMaxY = -Infinity,
        outMaxZ = -Infinity
      for (let i = 0; i < visibleCount; i++) {
        const vi = vertexAt(i)
        const i3 = vi * 3
        const x = positions[i3],
          y = positions[i3 + 1],
          z = positions[i3 + 2]
        // 单一出口判断（相机背后/超近远直接判定为外部），避免三处 continue 重复累积包围盒；
        // 正交时 w≡1，"外部"判据退化为 clip z 越界（见第一遍循环内注释）
        const w = m[3] * x + m[7] * y + m[11] * z + m[15]
        const zc = isOrtho ? m[2] * x + m[6] * y + m[10] * z + m[14] : 0
        let isIn = false
        if (isOrtho ? zc >= -w && zc <= w : w > 0) {
          const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w
          const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w
          isIn = isInside(nx, ny)
        }
        if (isIn) {
          inside[wi++] = vi
        } else {
          outside[wo++] = vi
          if (x < outMinX) outMinX = x
          if (y < outMinY) outMinY = y
          if (z < outMinZ) outMinZ = z
          if (x > outMaxX) outMaxX = x
          if (y > outMaxY) outMaxY = y
          if (z > outMaxZ) outMaxZ = z
        }
      }

      perChunk.push({
        inside,
        outside,
        insideBBox: { minX: inMinX, minY: inMinY, minZ: inMinZ, maxX: inMaxX, maxY: inMaxY, maxZ: inMaxZ },
        outsideBBox: { minX: outMinX, minY: outMinY, minZ: outMinZ, maxX: outMaxX, maxY: outMaxY, maxZ: outMaxZ },
      })
      if (onChunk) await onChunk()
    }
    result.set(target.entityId, perChunk)
  }
  return result
}

/**
 * 计算四边形选区：对每个目标实体的每块 geometry 生成 inside/outside 索引。
 * 四边形是 NDC 轴对齐矩形（AABB）特例，共享 computeSelectionCore 骨架。
 * @param camera 相机（选区时视角，绘制期间应已锁定）
 * @param scene  场景（用于刷新 group.matrixWorld）
 * @param rect   NDC 矩形（调用方由像素坐标换算）
 * @param targets 分割目标列表
 * @param onChunk 每处理完一块回调（让出主线程用；可异步）
 * @returns entityId → 各块 ChunkSelection（顺序与 target.geometries 对齐）
 */
export async function computeQuadrangleSelection(
  camera: THREE.Camera,
  scene: THREE.Scene,
  rect: NdcRect,
  targets: SegmentTarget[],
  onChunk?: () => void | Promise<void>
): Promise<Map<number, ChunkSelection[]>> {
  const { minX, minY, maxX, maxY } = rect
  return computeSelectionCore(
    camera,
    scene,
    targets,
    (nx, ny) => nx >= minX && nx <= maxX && ny >= minY && ny <= maxY,
    onChunk
  )
}

/**
 * 计算自由多边形选区：顶点为 NDC 空间（点击顺序，≥3），even-odd 射线法判内外。
 * 思路源自 doc/多边形分割/PlyUtils.js 的 findPointsInArbitraryPolygon，
 * 共享 computeSelectionCore 骨架（w<=0 归外部、viewProj 乘 group.matrixWorld 等）。
 * 凹多边形/自相交均可用 even-odd 规则（自相交仅填充无意义，选区判定仍正确）。
 * @param camera 相机（选区时视角，绘制期间应已锁定）
 * @param scene  场景（用于刷新 group.matrixWorld）
 * @param polygon NDC 多边形顶点（≥3；少于 3 直接返回空 Map）
 * @param targets 分割目标列表
 * @param onChunk 每处理完一块回调（让出主线程用；可异步）
 * @returns entityId → 各块 ChunkSelection（顺序与 target.geometries 对齐）
 */
export async function computePolygonSelection(
  camera: THREE.Camera,
  scene: THREE.Scene,
  polygon: NdcPoint[],
  targets: SegmentTarget[],
  onChunk?: () => void | Promise<void>
): Promise<Map<number, ChunkSelection[]>> {
  const n = polygon.length
  if (n < 3) return new Map()

  // 预处理：NDC AABB（预过滤，避免 AABB 外的点进射线法）+ 平铺顶点数组（内层循环缓存友好）
  const polyX = new Float32Array(n)
  const polyY = new Float32Array(n)
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const p = polygon[i]
    polyX[i] = p.x
    polyY[i] = p.y
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  return computeSelectionCore(
    camera,
    scene,
    targets,
    (nx, ny) => {
      // AABB 预过滤：多边形外框之外的点直接判外
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) return false
      // even-odd 射线法：从点向右水平射线与边的交点个数为奇则在内
      // （逐字对齐 PlyUtils.js L453-457；边界情形结果实现定义）
      let inside = false
      for (let pi = 0, pj = n - 1; pi < n; pj = pi++) {
        const xi = polyX[pi],
          yi = polyY[pi]
        const xj = polyX[pj],
          yj = polyY[pj]
        if (yi > ny !== yj > ny && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi) {
          inside = !inside
        }
      }
      return inside
    },
    onChunk
  )
}
