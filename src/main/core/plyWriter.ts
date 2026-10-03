/**
 * PLY 二进制写出（纯函数，无 IO —— 落盘由 PointCloudSaveManager 负责）。
 *
 * ⚠ **布局是写死的 30 字节，与读侧 `parsePlyChunk` 的偏移一一对应**：
 *
 * | 偏移 | 类型          | 含义           |
 * | ---- | ------------- | -------------- |
 * | 0    | double × 3    | x, y, z        |
 * | 24   | uchar × 3     | red, green, blue |
 * | 27   | uchar         | classification |
 * | 28   | ushort LE     | treeid         |
 *
 * 原因是**读侧按偏移硬编码、根本不解析 property 名**（见
 * renderer/stores/pointcloudStore.ts 的 parsePlyChunk 与 shared/types/ply.ts 的
 * `plyUnitSize` 注释）。因此这里即使某个属性全为 0 也必须写出来占位 ——
 * 少写一个属性，读回来整片点云错位（且不会报错）。
 *
 * 坐标写 **double**：内存里是"显示坐标"（原始坐标 − 全局基准点），写盘时加回基准点。
 * 判据与 CloudCompare 相同（qCC_io/src/PlyFilter.cpp: `isShifted() → PLY_DOUBLE`）：
 * 1e6 量级的大地坐标落进 float32 会丢掉全部小数精度。
 *
 * 头部的属性名沿用 PLY 惯例（x/y/z/red/green/blue），CloudCompare 能按名识别；
 * `classification` / `treeid` 是自定义属性，CC 读进来会成为同名标量字段。
 */

import type { SaveChunkRequest, SaveVec3 } from '../../shared/types/pointcloud-save'

/** 每点字节数（读侧 shared/types/ply.ts 的 plyUnitSize 必须与它相等）。 */
export const PLY_UNIT_SIZE = 30

/** 各字段偏移（与读侧 parsePlyChunk 的偏移一一对应，改动必须两处同步）。 */
const OFFSET_XYZ = 0
const OFFSET_RGB = 24
const OFFSET_CLASS = 27
const OFFSET_TREE = 28

/**
 * 无颜色实体的填充灰度（**sRGB 编码的字节**）。
 *
 * 218 = round(linearToSrgb(0.7) × 255)：0.7 是 applyColorMode 在无色云上给材质设的
 * 中性灰（见 pointcloudStore.ts），这里写成字节，读回来与画面上看到的一致。
 */
const NEUTRAL_GREY_BYTE = 218

/** PLY 头部（ASCII，LF 换行 —— 读侧按 `end_header\n` 定位数据起点，不能写成 CRLF）。 */
export function buildPlyHeader(pointCount: number): Buffer {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment Created by my-pointcloud-app\n' +
    `element vertex ${pointCount}\n` +
    'property double x\n' +
    'property double y\n' +
    'property double z\n' +
    'property uchar red\n' +
    'property uchar green\n' +
    'property uchar blue\n' +
    'property uchar classification\n' +
    'property ushort treeid\n' +
    'end_header\n'
  return Buffer.from(header, 'ascii')
}

/** 写出参数：把显示坐标还原成原始坐标需要基准点。 */
export interface PlyWriteMeta {
  basePoint: SaveVec3
}

/**
 * 编码一批点（长度 = 30 × pointCount 的 Buffer）。
 * @param batch 渲染侧摊好的批：显示坐标 + **已转 sRGB 的 8 位颜色**（可为 null）
 */
export function encodePlyBatch(meta: PlyWriteMeta, batch: SaveChunkRequest): Buffer {
  const { pointCount, positions, colors, classification, treeIds } = batch
  // Buffer.alloc（零初始化）而非 allocUnsafe：本函数目前确实写满 30 字节的每一格，
  // 但布局是"读侧按偏移硬编码"的（见文件头），将来少写一个属性时 allocUnsafe 会把
  // 堆里的旧数据漏进文件（输出不确定 + 泄露内存内容）。零初始化的代价在编码循环面前可忽略。
  const out = Buffer.alloc(pointCount * PLY_UNIT_SIZE)
  const bx = meta.basePoint.x
  const by = meta.basePoint.y
  const bz = meta.basePoint.z

  for (let i = 0; i < pointCount; i++) {
    const o = i * PLY_UNIT_SIZE
    // 显示坐标 + 基准点 = 原始坐标，double 写出（内存里的 Float32 显示坐标精度更高，
    // 因为减去基准点后数值回到 0 附近，float32 的有效位全用在小数上）
    out.writeDoubleLE(positions[i * 3] + bx, o + OFFSET_XYZ)
    out.writeDoubleLE(positions[i * 3 + 1] + by, o + OFFSET_XYZ + 8)
    out.writeDoubleLE(positions[i * 3 + 2] + bz, o + OFFSET_XYZ + 16)
    if (colors) {
      out[o + OFFSET_RGB] = colors[i * 3]
      out[o + OFFSET_RGB + 1] = colors[i * 3 + 1]
      out[o + OFFSET_RGB + 2] = colors[i * 3 + 2]
    } else {
      // 无色云：写中性灰占位（布局要求恒有 RGB，见文件头）
      out[o + OFFSET_RGB] = NEUTRAL_GREY_BYTE
      out[o + OFFSET_RGB + 1] = NEUTRAL_GREY_BYTE
      out[o + OFFSET_RGB + 2] = NEUTRAL_GREY_BYTE
    }
    out[o + OFFSET_CLASS] = classification ? classification[i] : 0
    out.writeUInt16LE(treeIds ? treeIds[i] : 0, o + OFFSET_TREE)
  }
  return out
}
