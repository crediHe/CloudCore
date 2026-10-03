/**
 * LAS 1.2 写出（未压缩，点格式 0 / 3；纯函数，无 IO —— 落盘由 PointCloudSaveManager 负责）。
 *
 * **为什么手写而不引库**：CloudCompare 的 LAS 读写全靠 LASzip 插件
 * （plugins/core/IO/qLASIO/cmake/FindLASzip.cmake，qCC_io 里根本没有 LAS 过滤器），
 * 而 LAZ 压缩不在本项目范围内。未压缩 LAS 是定长记录的简单格式，写出来与
 * 现有读侧（src/main/core/LasManager.ts）严格对称，零依赖。
 *
 * 点记录布局（与 LasManager / 渲染侧 parseLasChunk 的偏移一一对应）：
 *
 * | 格式 | 长度 | 布局 |
 * | ---- | ---- | ---- |
 * | 0    | 20   | X,Y,Z(int32) + Intensity(u16) + 回波字节 + 分类(u8) + 扫描角(i8) + UserData(u8) + PointSourceID(u16) |
 * | 3    | 34   | 格式 0 + GPS 时间(double) + RGB(u16×3) |
 *
 * 两个格式的 RGB / 分类 / PointSourceID 偏移与 `shared/types/las.ts` 的常量表一致
 * （读侧就是按那张表解码的）。
 *
 * 内存里没有的字段一律写 0（强度、GPS 时间、扫描角、UserData）——加载时就没读进内存
 * （见渲染侧 parseLasChunk：只取坐标 / 颜色 / 分类 / Point Source ID），无从保真。
 * 回波字节写 `1 of 1` 而非 0：LAS 规范的回波号从 1 起算，写 0 是不合法值。
 */

import {
  LAS_12_MAX_CLASSIFICATION,
  type SaveBBox,
  type SaveChunkRequest,
  type SaveVec3,
} from '../../shared/types/pointcloud-save'

/** 头部大小（LAS 1.2 公共头部固定 227 字节）。 */
export const LAS_HEADER_SIZE = 227

/** 默认坐标缩放因子（毫米级，与多数机载/地基 LiDAR 产品一致）。 */
const DEFAULT_SCALE = 0.001

/** int32 可表示上限（坐标 = (原始 − offset) / scale，必须落在这个范围内）。 */
const INT32_MAX = 2147483647

/** 回波字节：低 3 位回波号 1、中 3 位总回波数 1（0b00001001）。 */
const RETURN_1_OF_1 = 0b00001001

/** 写入布局规划（渲染侧不含此逻辑：LAS 的坐标量化只发生在写侧）。 */
export interface LasPlan {
  /** 点格式：0（无 RGB）/ 3（含 RGB）。 */
  pointFormat: 0 | 3
  /** 点记录长度（20 / 34）。 */
  recordLength: number
  /** 坐标缩放因子。 */
  scale: number
  /** 坐标偏移量（取包围盒中心，使 int32 表示范围最大化）。 */
  offset: SaveVec3
}

/** int32 坐标包围盒（收尾回填头部包围盒时用真实值，而非请求里那个可能偏大的值）。 */
export interface LasIntBBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/**
 * 规划 LAS 写入布局。
 *
 * scale 默认 0.001，**当包围盒顶点相对 offset 的最大偏移超出 int32 / scale 时按 10 的幂粗化**
 * （否则坐标写出时会被 clamp，静默丢位置精度）。offset 取包围盒中心。
 */
export function planLasLayout(bbox: SaveBBox, hasColor: boolean): LasPlan {
  const offset: SaveVec3 = {
    x: (bbox.minX + bbox.maxX) / 2,
    y: (bbox.minY + bbox.maxY) / 2,
    z: (bbox.minZ + bbox.maxZ) / 2,
  }
  // 相对 offset 的最大绝对值（半对角线各分量取包围盒两端的较大者）
  const maxAbs = Math.max(
    Math.abs(bbox.maxX - offset.x),
    Math.abs(bbox.minX - offset.x),
    Math.abs(bbox.maxY - offset.y),
    Math.abs(bbox.minY - offset.y),
    Math.abs(bbox.maxZ - offset.z),
    Math.abs(bbox.minZ - offset.z)
  )
  let scale = DEFAULT_SCALE
  while (maxAbs / scale > INT32_MAX) {
    scale *= 10
  }
  return {
    pointFormat: hasColor ? 3 : 0,
    recordLength: hasColor ? 34 : 20,
    scale,
    offset,
  }
}

/** 取某年的"年第几天"（LAS 头部按 UTC 记录）。 */
function dayOfYearUTC(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  return Math.floor((date.getTime() - start) / 86400000)
}

/**
 * 构造 227 字节的 LAS 1.2 公共头部。
 *
 * @param bbox 包围盒（**启动时用请求里那份**；收尾时由 encodeLasBBoxPatch 换成真实值）
 */
export function buildLasHeader(plan: LasPlan, pointCount: number, bbox: SaveBBox): Buffer {
  const header = Buffer.alloc(LAS_HEADER_SIZE)
  const now = new Date()

  header.write('LASF', 0, 'ascii') // 文件签名
  header.writeUInt8(1, 24) // 版本主号
  header.writeUInt8(2, 25) // 版本次号 → LAS 1.2
  header.write('my-pointcloud-app', 58, 'ascii') // generating software（32 字节，余下自动补 0）
  header.writeUInt16LE(dayOfYearUTC(now), 90) // 文件创建日（一年中的第几天）
  header.writeUInt16LE(now.getUTCFullYear(), 92)
  header.writeUInt16LE(LAS_HEADER_SIZE, 94) // 头部大小
  header.writeUInt32LE(LAS_HEADER_SIZE, 96) // 点数据偏移（无 VLR）
  header.writeUInt32LE(0, 100) // VLR 数量
  header.writeUInt8(plan.pointFormat, 104) // 点数据格式
  header.writeUInt16LE(plan.recordLength, 105) // 点记录长度
  header.writeUInt32LE(pointCount, 107) // 点数（遗留字段；1.2 无扩展字段）
  // 按回波点数：本应用不保留回波信息，全部记在第 1 回波（与点记录里的 1 of 1 一致）
  header.writeUInt32LE(pointCount, 111)

  header.writeDoubleLE(plan.scale, 131)
  header.writeDoubleLE(plan.scale, 139)
  header.writeDoubleLE(plan.scale, 147)
  header.writeDoubleLE(plan.offset.x, 155)
  header.writeDoubleLE(plan.offset.y, 163)
  header.writeDoubleLE(plan.offset.z, 171)

  writeBBoxInto(header, bbox, 179)
  return header
}

/** 把包围盒写入头部/补丁缓冲的 48 字节包围盒区（顺序：maxX, minX, maxY, minY, maxZ, minZ）。 */
function writeBBoxInto(target: Buffer, bbox: SaveBBox, offset: number): void {
  target.writeDoubleLE(bbox.maxX, offset)
  target.writeDoubleLE(bbox.minX, offset + 8)
  target.writeDoubleLE(bbox.maxY, offset + 16)
  target.writeDoubleLE(bbox.minY, offset + 24)
  target.writeDoubleLE(bbox.maxZ, offset + 32)
  target.writeDoubleLE(bbox.minZ, offset + 40)
}

/**
 * 构造写回头部包围盒区的 48 字节补丁（收尾时用**实际写入的 int32 坐标**换算）。
 *
 * 为什么必须回填真实值：首片点云加载时**用头部包围盒中心当全局基准点**
 * （渲染侧 loadLas 的 `isFirstCloud` 分支），写一份偏大的包围盒会让下次打开时
 * 基准点偏移，虽然相对位置不变，但全局坐标读数会差一截。
 */
export function encodeLasBBoxPatch(plan: LasPlan, intBBox: LasIntBBox): Buffer {
  const patch = Buffer.allocUnsafe(48)
  writeBBoxInto(
    patch,
    {
      maxX: intBBox.maxX * plan.scale + plan.offset.x,
      minX: intBBox.minX * plan.scale + plan.offset.x,
      maxY: intBBox.maxY * plan.scale + plan.offset.y,
      minY: intBBox.minY * plan.scale + plan.offset.y,
      maxZ: intBBox.maxZ * plan.scale + plan.offset.z,
      minZ: intBBox.minZ * plan.scale + plan.offset.z,
    },
    0
  )
  return patch
}

/** 写出参数：把显示坐标还原成原始坐标需要基准点。 */
export interface LasWriteMeta {
  basePoint: SaveVec3
}

/** 一批点的编码结果：缓冲 + 本批 int32 坐标包围盒（供收尾回填头部用）。 */
export interface LasBatchResult {
  buffer: Buffer
  intBBox: LasIntBBox
}

/**
 * 编码一批点。
 *
 * @throws 当分类值超出 LAS 1.2 可表示范围（> 31）时抛错 —— **不静默截断**。
 *   渲染侧保存前已有一次 O(N) 预扫描并给出友好提示，这里是第二道闸，防止
 *   将来换个调用方静默丢分类高位。
 */
export function encodeLasBatch(plan: LasPlan, meta: LasWriteMeta, batch: SaveChunkRequest): LasBatchResult {
  const { pointCount, positions, colors, classification, treeIds } = batch
  // 必须 Buffer.alloc（零初始化）而非 allocUnsafe：点记录里有**刻意不写**的字段
  // （强度 12、扫描角 16、UserData 17、格式 3 的 GPS 时间 20），allocUnsafe 会把
  // 堆里的旧数据漏进文件 —— 输出不确定（同样的输入两次写出不同字节）且泄露内存内容。
  const out = Buffer.alloc(pointCount * plan.recordLength)
  const { scale, offset } = plan
  const hasRgb = plan.pointFormat === 3

  const intBBox: LasIntBBox = {
    minX: INT32_MAX,
    minY: INT32_MAX,
    minZ: INT32_MAX,
    maxX: -INT32_MAX - 1,
    maxY: -INT32_MAX - 1,
    maxZ: -INT32_MAX - 1,
  }

  for (let i = 0; i < pointCount; i++) {
    const o = i * plan.recordLength
    // 显示坐标 + 基准点 = 原始坐标；再量化成 int32（真实坐标 = int32 × scale + offset）
    const ix = clampInt32(Math.round((positions[i * 3] + meta.basePoint.x - offset.x) / scale))
    const iy = clampInt32(Math.round((positions[i * 3 + 1] + meta.basePoint.y - offset.y) / scale))
    const iz = clampInt32(Math.round((positions[i * 3 + 2] + meta.basePoint.z - offset.z) / scale))
    out.writeInt32LE(ix, o)
    out.writeInt32LE(iy, o + 4)
    out.writeInt32LE(iz, o + 8)
    // 强度（12，u16）写 0：加载时没读进内存
    out.writeUInt8(RETURN_1_OF_1, o + 14) // 回波字节：低 3 位回波号 1、中 3 位总回波数 1
    if (classification) {
      const cls = classification[i]
      if (cls > LAS_12_MAX_CLASSIFICATION) {
        throw new Error(
          `LAS 1.2 的分类字段只有低 5 位（最大 ${LAS_12_MAX_CLASSIFICATION}），` +
            `本批出现分类 ${cls}；请改用 PLY 保存（分类为完整 8 位，无损）`
        )
      }
      out.writeUInt8(cls, o + 15)
    }
    // 扫描角（16，i8）与 UserData（17）写 0
    if (treeIds) out.writeUInt16LE(treeIds[i], o + 18) // Point Source ID ← treeid
    if (hasRgb) {
      // GPS 时间（20，double）写 0
      if (colors) {
        // 与 CloudCompare 一致：16 位字段携带 8 位精度（c << 8），
        // 读侧的 decodeLasRgb 见 rgbMax ≥ 256 即按移位还原
        out.writeUInt16LE(colors[i * 3] << 8, o + 28)
        out.writeUInt16LE(colors[i * 3 + 1] << 8, o + 30)
        out.writeUInt16LE(colors[i * 3 + 2] << 8, o + 32)
      }
      // 无颜色却写了格式 3（调用方不该这么传）：RGB 留 0
    }

    if (ix < intBBox.minX) intBBox.minX = ix
    if (iy < intBBox.minY) intBBox.minY = iy
    if (iz < intBBox.minZ) intBBox.minZ = iz
    if (ix > intBBox.maxX) intBBox.maxX = ix
    if (iy > intBBox.maxY) intBBox.maxY = iy
    if (iz > intBBox.maxZ) intBBox.maxZ = iz
  }

  return { buffer: out, intBBox }
}

/** 把坐标夹进 int32（规划阶段已保证不会越界；此处防御 DataView 越界抛异常）。 */
function clampInt32(v: number): number {
  if (v > INT32_MAX) return INT32_MAX
  if (v < -INT32_MAX - 1) return -INT32_MAX - 1
  return v
}
