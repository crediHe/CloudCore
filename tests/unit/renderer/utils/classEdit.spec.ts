import { describe, it, expect } from 'vitest'
import { rewriteVisibleClass } from '../../../../src/renderer/utils/classEdit'

describe('classEdit（整片重设分类，写时复制）', () => {
  it('无 index 原始块：全量顶点写入新值，返回新数组、原数组不动', () => {
    const cls = new Uint8Array([0, 2, 2, 6, 33])
    const next = rewriteVisibleClass(cls, null, 2)
    expect([...next]).toEqual([2, 2, 2, 2, 2])
    // 写时复制：原数组不被改动
    expect([...cls]).toEqual([0, 2, 2, 6, 33])
    expect(next).not.toBe(cls)
  })

  it('带 index 的分割产物：只改写条目指向的顶点，其余顶点保持原值', () => {
    const cls = new Uint8Array([0, 2, 2, 6, 0, 33])
    const visible = new Uint32Array([1, 3, 5]) // 只看顶点 1/3/5
    const next = rewriteVisibleClass(cls, visible, 2)
    expect([...next]).toEqual([0, 2, 2, 2, 0, 2])
    expect([...cls]).toEqual([0, 2, 2, 6, 0, 33])
  })

  it('目标值 0-255 全字节保真（含高位用户自定义类）', () => {
    const cls = new Uint8Array([0, 64, 200])
    const next = rewriteVisibleClass(cls, null, 200)
    expect([...next]).toEqual([200, 200, 200])
    const high = rewriteVisibleClass(cls, new Uint32Array([1]), 255)
    expect([...high]).toEqual([0, 255, 200])
  })

  it('空 index（可见点为空）仍返回全量复制且内容不变', () => {
    const cls = new Uint8Array([1, 2, 3])
    const next = rewriteVisibleClass(cls, new Uint32Array(0), 2)
    expect([...next]).toEqual([1, 2, 3])
    expect(next).not.toBe(cls)
    expect([...cls]).toEqual([1, 2, 3])
  })

  it('空分类数组：复制为空数组，不抛错', () => {
    const next = rewriteVisibleClass(new Uint8Array(0), null, 2)
    expect(next).toHaveLength(0)
  })
})
