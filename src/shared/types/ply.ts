/** PLY 文件信息（主进程解析 PLY 头部后返回）。 */
export interface PlyFileInfo {
    /** 文件绝对路径。 */
    path: string
    /** 文件总字节数。 */
    size: number
    /** 头部解析出的顶点总数。 */
    pointCount: number
    /** 二进制数据起始字节偏移（后续 read-ply-chunk 要复用，先一起返回）。 */
    dataOffset: number
}

/** 分块读取 PLY 请求参数。 */
export interface PlyChunkRequest {
    /** 文件绝对路径。 */
    path: string
    /** 每个点云数据的字节数（自定义格式：3*double + 3*uchar + uchar + ushort = 30）。 */
    plyUnitSize: number
    /** 分块索引（从 0 开始）。 */
    chunkIndex: number
    /** 每块的点数。 */
    chunkSize: number
    /** 头部解析出的顶点总数。 */
    pointCount: number
    /** 二进制数据起始字节偏移（get-file-info 返回的 dataOffset）。 */
    dataOffset: number
}

/** 分块读取 PLY 结果。 */
export interface PlyChunkResult {
    /** 本次实际读到的点数。 */
    pointsRead: number
    /** 二进制点数据（跨 IPC 传输）。 */
    arrayBuffer: ArrayBuffer
}

/** 扫描 PLY 包围盒请求参数（复用分块读取的文件定位字段）。 */
export interface PlyScanRequest {
    /** 文件绝对路径。 */
    path: string
    /** 每个点云数据的字节数。 */
    plyUnitSize: number
    /** 头部解析出的顶点总数。 */
    pointCount: number
    /** 二进制数据起始字节偏移。 */
    dataOffset: number
}

/** PLY 文件包围盒（double 精度，用于计算全局共享基准点）。 */
export interface PlyBBox {
    minX: number
    minY: number
    minZ: number
    maxX: number
    maxY: number
    maxZ: number
}
