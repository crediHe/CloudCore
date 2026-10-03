import { describe, it, expect } from 'vitest'
import { partitionVisibleByClass } from '../../../../src/renderer/utils/classSplit'

describe('classSplit（按分类值拆可见点）', () => {
  it('无 index 原始块：按全量顶点分类分桶，类号升序', () => {
    // 顶点 id:  0  1  2  3  4  5
    const cls = new Uint8Array([0, 2, 2, 6, 0, 33])
    const parts = partitionVisibleByClass(cls, null)
    expect([...parts.keys()]).toEqual([0, 2, 6, 33]) // 升序（Map 插入序可预期）
    expect([...parts.get(0)!]).toEqual([0, 4])
    expect([...parts.get(2)!]).toEqual([1, 2])
    expect([...parts.get(6)!]).toEqual([3])
    expect([...parts.get(33)!]).toEqual([5])
  })

  it('带 index 的分割产物：只按条目可见点分桶，桶内存原始顶点 id', () => {
    const cls = new Uint8Array([0, 2, 2, 6, 0, 33])
    const visible = new Uint32Array([1, 3, 5]) // 只看顶点 1/3/5
    const parts = partitionVisibleByClass(cls, visible)
    expect([...parts.keys()]).toEqual([2, 6, 33])
    expect([...parts.get(2)!]).toEqual([1]) // 顶点 id 原值
    expect([...parts.get(6)!]).toEqual([3])
    expect([...parts.get(33)!]).toEqual([5])
  })

  it('分类字节 0-255 全值保真（不掩码回 0-31）', () => {
    const cls = new Uint8Array([200, 64, 127])
    const parts = partitionVisibleByClass(cls, null)
    expect([...parts.keys()]).toEqual([64, 127, 200])
    expect([...parts.get(200)!]).toEqual([0])
    expect([...parts.get(127)!]).toEqual([2])
  })

  it('全部同类时只产出一个桶；互斥不重不漏', () => {
    const cls = new Uint8Array([2, 2, 2])
    const parts = partitionVisibleByClass(cls, null)
    expect([...parts.keys()]).toEqual([2])
    expect(parts.get(2)!.length).toBe(3)
  })

  it('空输入 / 空 index 返回空 Map（不产出空桶）', () => {
    expect(partitionVisibleByClass(new Uint8Array(0), null).size).toBe(0)
    expect(partitionVisibleByClass(new Uint8Array([1, 2]), new Uint32Array(0)).size).toBe(0)
  })

  it('确定性：同输入两次调用结果逐桶相等', () => {
    const cls = new Uint8Array([0, 5, 2, 5, 64, 0])
    const visible = new Uint32Array([0, 1, 2, 3, 4, 5])
    const a = partitionVisibleByClass(cls, visible)
    const b = partitionVisibleByClass(cls, visible)
    expect([...a]).toEqual([...b])
  })
})
