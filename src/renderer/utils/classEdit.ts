/**
 * 分类值重写（DB Tree 右键 Set classification… 用）的纯函数工具。
 *
 * 写时复制语义：分割 / 按分类拆分产物与兄弟实体共享同一批底层顶点缓冲
 * （零拷贝的代价），设值绝不能原地改数组。本函数返回**新数组**，调用方
 * 换装新 BufferAttribute 后兄弟实体仍引用旧数组、不受影响
 * （见 pointcloudStore.setEntityClassification）。
 *
 * 可见点集语义与 classSplit.partitionVisibleByClass 一致（见该文件模块注释）：
 * 无 index 的原始块 = 整条顶点缓冲；带 index 的分割产物 = 其条目指向的
 * 顶点下标。部分 drawRange 区间需调用方先切片成独立数组再传入
 * （与 pointcloudStore.getFilterSourceChunks 同一防御逻辑）。
 */

/**
 * 复制一份分类数组，并把可见顶点（index 条目 / 无 index 的全量顶点）的
 * 分类值改写为目标值。
 * @param classification 逐点分类字节（0-255 原值，Uint8 可承载 255）
 * @param index 可见顶点的 id 列表；null = 全量顶点（与 partitionVisibleByClass 同约定）
 * @param value 目标分类值（0-255；Uint8Array 写入时自动截断，调用方负责校验整数）
 * @returns 写入后的新数组（原数组不被改动）
 */
export function rewriteVisibleClass(classification: Uint8Array, index: Uint32Array | null, value: number): Uint8Array {
  const next = classification.slice() // 全量复制：旧数组留给共享它的兄弟实体
  const n = index ? index.length : next.length
  for (let i = 0; i < n; i++) {
    next[index ? index[i] : i] = value
  }
  return next
}
