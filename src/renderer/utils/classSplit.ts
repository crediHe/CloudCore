/**
 * 按分类值拆分点云块的纯函数工具（DB Tree 右键 Split by classification 用）。
 *
 * 语义与 segmentSelection 的"可见点集"一致（见该文件模块注释第 4 条）：
 * 无 index 的原始块 = 整条顶点缓冲；带 index 的分割/滤波产物 = 其条目指向的
 * 顶点下标。classification 与顶点缓冲按顶点 id 对齐，因此用分类字节给
 * 可见顶点分桶，产物直接可作为 buildIndexedGeometry 的独立索引（零拷贝）。
 *
 * 分类字节按 0-255 全值处理、不做低 5 位掩码——LAS 1.4 格式 6-10 的
 * 用户自定义类 64-255 需保真（见 pointcloudStore.parseLasChunk）。
 */

/**
 * 把一块几何体的可见顶点按分类值分成互斥的组。
 * @param classification 逐点分类字节（全量缓冲，按顶点 id 对齐；0-255 原值）
 * @param index 可见顶点的 id 列表；null = 无索引原始块（可见 = 全量顶点）。
 *   部分 drawRange 区间需调用方先切片成独立数组再传入（与
 *   pointcloudStore.getFilterSourceChunks 同一防御逻辑）。
 * @returns 分类值（升序，Map 插入序可预期）→ 该类的顶点 id 数组；
 *   无可见点时返回空 Map（不产出空桶）。
 */
export function partitionVisibleByClass(
  classification: Uint8Array,
  index: Uint32Array | null
): Map<number, Uint32Array> {
  const parts = new Map<number, Uint32Array>()
  const visibleCount = index ? index.length : classification.length
  if (visibleCount === 0) return parts

  // 第一遍：统计各类可见点数
  const counts = new Map<number, number>()
  for (let i = 0; i < visibleCount; i++) {
    const c = index ? classification[index[i]] : classification[i]
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }

  // 第二遍：按类号升序落位（先建桶再填充，索引数组精确尺寸零扩容）
  const clsList = [...counts.keys()].sort((a, b) => a - b)
  const filled = new Map<number, number>()
  for (const c of clsList) {
    parts.set(c, new Uint32Array(counts.get(c) ?? 0))
    filled.set(c, 0)
  }
  for (let i = 0; i < visibleCount; i++) {
    const vi = index ? index[i] : i
    const c = classification[vi]
    const k = filled.get(c)!
    parts.get(c)![k] = vi
    filled.set(c, k + 1)
  }
  return parts
}
