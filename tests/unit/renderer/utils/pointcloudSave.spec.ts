import { describe, it, expect } from 'vitest'
import {
  buildSaveBatch,
  defaultSaveName,
  maxClassificationOf,
  visibleCountOf,
  type SaveChunkSource,
} from '../../../../src/renderer/utils/pointcloudSave'
import { linearToSrgbU8, linearU8ToSrgbU8, srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'

// 纯函数（不碰 three / DOM），node 环境即可。
// 这里断言的都是"会静默出错"的地方：可见子集（index）、两种颜色形态、分类越界扫描。

/** 造一块几何体的保存源（默认：3 个顶点、无 index、无颜色）。 */
function makeSource(over: Partial<SaveChunkSource> = {}): SaveChunkSource {
  return {
    positions: new Float32Array([0, 0, 0, 1, 2, 3, 4, 5, 6]),
    index: null,
    colors: null,
    classification: null,
    treeIds: null,
    ...over,
  }
}

describe('visibleCountOf', () => {
  it('无 index = 顶点数；有 index = index 条目数（分割产物的真实点数）', () => {
    expect(visibleCountOf(null, 3)).toBe(3)
    expect(visibleCountOf(new Uint32Array([0, 2]), 3)).toBe(2)
    expect(visibleCountOf(new Uint32Array(0), 3)).toBe(0)
  })
})

describe('maxClassificationOf', () => {
  it('取最大值；null（无分类属性）为 0', () => {
    expect(maxClassificationOf(null)).toBe(0)
    expect(maxClassificationOf(new Uint8Array([]))).toBe(0)
    expect(maxClassificationOf(new Uint8Array([0, 31, 7]))).toBe(31)
    expect(maxClassificationOf(new Uint8Array([200, 5]))).toBe(200)
  })

  it('32 以上的分类能被扫出来（LAS 可用性闸门的判据）', () => {
    expect(maxClassificationOf(new Uint8Array([1, 2, 32]))).toBeGreaterThan(31)
    expect(maxClassificationOf(new Uint8Array([1, 2, 31]))).toBeLessThanOrEqual(31)
  })
})

describe('buildSaveBatch', () => {
  it('整块无 index：坐标 / 分类 / 树 ID 走零拷贝快路径（同一 TypedArray 实例）', () => {
    const classification = new Uint8Array([1, 2, 3])
    const treeIds = new Uint16Array([7, 8, 9])
    const src = makeSource({ classification, treeIds })

    const batch = buildSaveBatch(src, 0, 3)
    expect(batch.pointCount).toBe(3)
    expect(batch.positions).toBe(src.positions)
    expect(batch.classification).toBe(classification)
    expect(batch.treeIds).toBe(treeIds)
    expect(batch.colors).toBeNull()
  })

  it('部分区间：坐标被摊成新数组，取值与源逐位相等', () => {
    const src = makeSource()
    const batch = buildSaveBatch(src, 1, 2)

    expect(batch.positions).not.toBe(src.positions)
    expect(Array.from(batch.positions)).toEqual([1, 2, 3, 4, 5, 6])
    expect(batch.classification).toBeNull()
  })

  it('带 index：**取的是 index 指向的顶点**（分割 / 滤波产物与源共享顶点缓冲）', () => {
    // 源里 3 个顶点，可见子集只含第 0、2 个（顶点 1 属于"被剔掉"的那半）
    const src = makeSource({
      index: new Uint32Array([0, 2]),
      classification: new Uint8Array([10, 20, 30]),
      treeIds: new Uint16Array([100, 200, 300]),
    })

    const batch = buildSaveBatch(src, 0, 2)
    expect(batch.pointCount).toBe(2)
    expect(Array.from(batch.positions)).toEqual([0, 0, 0, 4, 5, 6])
    expect(Array.from(batch.classification!)).toEqual([10, 30])
    expect(Array.from(batch.treeIds!)).toEqual([100, 300])
  })

  it('带 index 且取中间段：区间按**可见序**切片', () => {
    const src = makeSource({
      positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]),
      index: new Uint32Array([3, 1, 0]), // 可见序：3 → 1 → 0
    })
    const batch = buildSaveBatch(src, 1, 2)
    expect(Array.from(batch.positions)).toEqual([1, 1, 1, 0, 0, 0])
  })

  it('颜色形态一：Float32 线性 0-1 → sRGB 字节', () => {
    const src = makeSource({ colors: new Float32Array([0, srgbU8ToLinear(128), 1]) })
    const batch = buildSaveBatch(src, 0, 1)

    expect(batch.colors).not.toBeNull()
    // 线性值 = srgbU8ToLinear(128)（加载路径写进内存的那个值）→ 编回 128
    expect(Array.from(batch.colors!)).toEqual([0, 128, 255])
  })

  it('颜色形态二：Uint8 线性字节（分割产物纯色 / 预览色）→ sRGB 字节（查表）', () => {
    const bytes = new Uint8Array([0, 128, 255])
    const src = makeSource({ colors: bytes })
    const batch = buildSaveBatch(src, 0, 1)

    expect(Array.from(batch.colors!)).toEqual([linearU8ToSrgbU8(0), linearU8ToSrgbU8(128), linearU8ToSrgbU8(255)])
    // LUT 与逐点算等价（表只是省掉每次 Math.pow）
    expect(batch.colors![1]).toBe(linearToSrgbU8(128 / 255))
    // 线性字节 128 ≈ 0.502 线性 → sRGB 188（**不转码**直接落盘会写出 128 这种"偏暗"的字节）
    expect(batch.colors![1]).toBe(188)
    expect(batch.colors![0]).toBe(0)
    expect(batch.colors![2]).toBe(255)
  })

  it('两种颜色形态在"同一个 sRGB 色"上对齐：加载路径往返后字节不变', () => {
    // 加载来的 Float32 线性值 = srgbU8ToLinear(byte)，导出应还原同一个 byte
    const src = makeSource({ colors: new Float32Array([srgbU8ToLinear(77), srgbU8ToLinear(200), srgbU8ToLinear(255)]) })
    expect(Array.from(buildSaveBatch(src, 0, 1).colors!)).toEqual([77, 200, 255])
  })

  it('颜色逐点按 index 取（不会把整块的颜色写出去）', () => {
    const src = makeSource({
      index: new Uint32Array([2]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    })
    expect(Array.from(buildSaveBatch(src, 0, 1).colors!)).toEqual([0, 0, 255])
  })

  it('颜色数组总是新分配（不走零拷贝：必须转码，不能改源数据）', () => {
    const colors = new Float32Array([0.5, 0.5, 0.5])
    const src = makeSource({ colors })
    buildSaveBatch(src, 0, 3)
    expect(Array.from(colors)).toEqual([0.5, 0.5, 0.5]) // 源未被改写
  })

  it('区间越界抛错（调用方按可见点数分批，正常路径不会触发）', () => {
    const src = makeSource({ index: new Uint32Array([0, 2]) })
    expect(() => buildSaveBatch(src, 0, 3)).toThrow(/越界/)
    expect(() => buildSaveBatch(src, 2, 1)).toThrow(/越界/)
    expect(() => buildSaveBatch(src, -1, 1)).toThrow(/越界/)
  })

  it('count = 0 是合法空批（返回 0 点、空数组）', () => {
    const batch = buildSaveBatch(makeSource(), 3, 0)
    expect(batch.pointCount).toBe(0)
    expect(batch.positions.length).toBe(0)
  })
})

// 每点 treeid 的**覆盖**通道（SaveChunkSource.treeIdOverride）：导出实体是一棵"物体"
// （`labelNo` 非空）时，逐点 treeid 一律写该编号——"哪棵树"随文件走，而不是随顶点缓冲里
// 那份从输入文件读来的旧属性走（分割 / 合并后旧属性已经不描述现状了）。
describe('buildSaveBatch（treeIdOverride：按物体编号覆盖每点 treeid）', () => {
  it('覆盖整批：忽略源属性，逐点都是该编号；长度 = 批点数（不是源的顶点数）', () => {
    const src = makeSource({
      index: new Uint32Array([0, 2]),
      treeIds: new Uint16Array([100, 200, 300]), // 输入文件里的旧 treeid，必须被无视
    })
    const batch = buildSaveBatch({ ...src, treeIdOverride: 7 }, 0, 2)
    expect(batch.pointCount).toBe(2)
    expect(Array.from(batch.treeIds!)).toEqual([7, 7])
  })

  it('源没有 treeid 属性时照样写出编号（覆盖不依赖属性在不在）', () => {
    const batch = buildSaveBatch({ ...makeSource(), treeIdOverride: 3 }, 0, 3)
    expect(Array.from(batch.treeIds!)).toEqual([3, 3, 3])
    expect(batch.treeIds!.length).toBe(3)
  })

  it('整块无 index 也不再零拷贝（覆盖必然要新数组，源那份不许被改写）', () => {
    const treeIds = new Uint16Array([1, 2, 3])
    const src = makeSource({ treeIds })
    const batch = buildSaveBatch({ ...src, treeIdOverride: 9 }, 0, 3)
    expect(batch.treeIds).not.toBe(treeIds)
    expect(Array.from(treeIds)).toEqual([1, 2, 3]) // 源未被改写（分割产物共享缓冲）
  })

  it('u16 全域可用：0 与 65535 都原样写出（编号从 1 起，0 只是格式上的空位）', () => {
    for (const no of [0, 1, 65535]) {
      expect(Array.from(buildSaveBatch({ ...makeSource(), treeIdOverride: no }, 0, 3).treeIds!)).toEqual([no, no, no])
    }
  })

  it('精确到批：只填 count 个（分批写盘时每批各自成篇，不会多写一个）', () => {
    const batch = buildSaveBatch({ ...makeSource(), treeIdOverride: 4 }, 1, 1)
    expect(batch.treeIds!.length).toBe(1)
    expect(Array.from(batch.treeIds!)).toEqual([4])
  })

  it('空批：长度为 0 的空数组，不越界', () => {
    const batch = buildSaveBatch({ ...makeSource(), treeIdOverride: 4 }, 3, 0)
    expect(batch.treeIds!.length).toBe(0)
  })

  it('回归哨兵：省略 / null = 不覆盖（零拷贝快路径与逐点搬运的旧行为一字不改）', () => {
    const treeIds = new Uint16Array([1, 2, 3])
    // 无 index：仍是同一个实例（零拷贝）
    expect(buildSaveBatch(makeSource({ treeIds }), 0, 3).treeIds).toBe(treeIds)
    expect(buildSaveBatch({ ...makeSource({ treeIds }), treeIdOverride: null }, 0, 3).treeIds).toBe(treeIds)
    // 带 index：逐点搬运（不是常量填充）
    const picked = buildSaveBatch(
      { ...makeSource({ treeIds, index: new Uint32Array([0, 2]) }), treeIdOverride: null },
      0,
      2
    )
    expect(Array.from(picked.treeIds!)).toEqual([1, 3])
  })
})

describe('defaultSaveName', () => {
  it('去掉源扩展名换新扩展名', () => {
    expect(defaultSaveName('cloud.las', 'ply')).toBe('cloud.ply')
    expect(defaultSaveName('cloud.PLY', 'las')).toBe('cloud.las')
    expect(defaultSaveName('3H1-RGB-2025.11.17.las', 'las')).toBe('3H1-RGB-2025.11.17.las')
    // 产物名带多个点（如 xxx.offGround.plane）时只截掉末尾的已知扩展名
    expect(defaultSaveName('xxx.offGround.plane.ply', 'las')).toBe('xxx.offGround.plane.las')
  })

  it('替换 Windows 非法字符', () => {
    expect(defaultSaveName('a/b\\c:d*e?f"g<h>i|j', 'ply')).toBe('a_b_c_d_e_f_g_h_i_j.ply')
  })

  it('空名 / 全是非法字符时兜底 cloud', () => {
    expect(defaultSaveName('', 'ply')).toBe('cloud.ply')
    expect(defaultSaveName('  ', 'las')).toBe('cloud.las')
    expect(defaultSaveName('///', 'ply')).toBe('cloud.ply')
  })
})
