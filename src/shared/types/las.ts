/**
 * LAS 文件共享类型与点格式布局常量。
 *
 * LAS 与现有 PLY 走同一套"头部 + 等长点记录"分块流水线，差异只在二进制布局：
 * - 坐标以 int32 存盘，真实坐标 = int32 × 缩放因子 + 偏移量（double 精度）。
 * - 头部自带包围盒（真实坐标），无需扫描整个文件。
 */

/** LAS 文件信息（主进程解析 LAS 二进制头部后返回）。 */
export interface LasFileInfo {
    /** 文件绝对路径。 */
    path: string
    /** 文件总字节数。 */
    size: number
    /** 点记录总点数（LAS 1.4 优先读扩展 uint64 字段）。 */
    pointCount: number
    /** 点数据起始字节偏移（公共头部 + VLR 之后）。 */
    dataOffset: number
    /** 每个点记录的字节数（分块步长，含 extra bytes，必须按它对齐）。 */
    pointRecordLength: number
    /** LAS 版本号（如 1.2 → major=1, minor=2）。 */
    versionMajor: number
    versionMinor: number
    /** 点数据记录格式（0-10，本应用支持 0/1/2/3/6/7/8）。 */
    pointFormat: number
    /** 是否包含 RGB 颜色字段（格式 2/3/7/8）。 */
    hasColor: boolean
    /**
     * RGB 颜色存储单位判定值（采样前 1024 条点记录算出的 uint16 最大值）。
     * >= 256 → 颜色按"8 位值左移 8 位"存储（v = c×256，多数软件按规范）；
     * < 256 → 颜色直接把 8 位值塞进 uint16（v = c，部分国产软件）。
     * 渲染进程据此还原颜色，兼容两种单位。
     */
    rgbMax: number
    /** 坐标缩放因子（真实坐标 = int32 × scale + offset）。 */
    scaleX: number
    scaleY: number
    scaleZ: number
    /** 坐标偏移量。 */
    offsetX: number
    offsetY: number
    offsetZ: number
    /** 头部声明的包围盒（真实坐标，double 精度，用于计算全局基准点）。 */
    minX: number
    minY: number
    minZ: number
    maxX: number
    maxY: number
    maxZ: number
}

/** 分块读取 LAS 请求参数。 */
export interface LasChunkRequest {
    /** 文件绝对路径。 */
    path: string
    /** 每个点记录的字节数（get-file-info 返回的 pointRecordLength）。 */
    pointRecordLength: number
    /** 分块索引（从 0 开始）。 */
    chunkIndex: number
    /** 每块的点数。 */
    chunkSize: number
    /** 点记录总点数。 */
    pointCount: number
    /** 点数据起始字节偏移（get-file-info 返回的 dataOffset）。 */
    dataOffset: number
}

/** 分块读取 LAS 结果。 */
export interface LasChunkResult {
    /** 本次实际读到的点数。 */
    pointsRead: number
    /** 二进制点数据（跨 IPC 传输）。 */
    arrayBuffer: ArrayBuffer
}

/**
 * 各点数据格式的 RGB 颜色字段偏移（-1 表示该格式无颜色字段）。
 * 格式 0/1/6/9 无颜色；4/5/10 为波形格式（本应用不支持）。
 */
export const LAS_RGB_OFFSETS: Readonly<Record<number, number>> = {
    0: -1, 1: -1, 2: 20, 3: 28, 4: -1, 5: -1,
    6: -1, 7: 30, 8: 30, 9: -1, 10: -1,
}

/**
 * 各点数据格式的 Point Source ID 字段偏移（格式 0-5 在字节 18，
 * 格式 6-10 前面多了 int16 扫描角，位于字节 20），
 * 渲染进程将其映射为 treeid 属性。
 */
export const LAS_POINT_SOURCE_ID_OFFSETS: Readonly<Record<number, number>> = {
    0: 18, 1: 18, 2: 18, 3: 18, 4: 18, 5: 18,
    6: 20, 7: 20, 8: 20, 9: 20, 10: 20,
}
