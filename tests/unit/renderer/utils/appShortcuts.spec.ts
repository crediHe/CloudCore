// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  APP_SHORTCUTS,
  findShortcut,
  hintOf,
  matchShortcutEvent,
  type KeyStrokeEvent,
} from '../../../../src/renderer/utils/appShortcuts'
import { VIEW_DIRECTIONS } from '../../../../src/renderer/utils/viewDirections'

/**
 * 快捷键表是**纯数据 + 纯匹配**（不碰 DOM / three / store），故这里直接喂普通对象当按键
 * 事件，不需要 jsdom 与任何 mock。锁住的是三件事：修饰键的严格相等语义、表内的按键不
 * 重复、六个视角与 Ctrl+1..6 的对应关系（表变了提示就变了，这条会先红）。
 */
function key(k: string, mods: Partial<Omit<KeyStrokeEvent, 'key'>> = {}): KeyStrokeEvent {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }
}

describe('appShortcuts 表', () => {
  it('每个动作都有非空提示，且 hintOf 与表一致', () => {
    for (const spec of APP_SHORTCUTS) {
      expect(spec.hint, `${spec.id} 缺提示文案`).not.toBe('')
      expect(hintOf(spec.id)).toBe(spec.hint)
    }
    expect(APP_SHORTCUTS.length).toBeGreaterThan(0)
  })

  it('id 不重复', () => {
    const ids = APP_SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('按键组合不重复（匹配是先到先得，重复项会让后面的永远轮不到）', () => {
    const strokes = APP_SHORTCUTS.map((s) =>
      [s.stroke.key, !!s.stroke.ctrl, !!s.stroke.shift, !!s.stroke.alt].join('|')
    )
    expect(new Set(strokes).size).toBe(strokes.length)
  })

  it('六个视角 → Ctrl+1..6，且视角名都在 VIEW_DIRECTIONS 里', () => {
    const expected = [
      ['viewFront', '1'],
      ['viewBack', '2'],
      ['viewLeft', '3'],
      ['viewRight', '4'],
      ['viewTop', '5'],
      ['viewBottom', '6'],
    ] as const
    for (const [id, digit] of expected) {
      expect(findShortcut(key(digit, { ctrlKey: true }))).toBe(id)
      expect(hintOf(id)).toBe(`Ctrl+${digit}`)
    }
    expect(Object.keys(VIEW_DIRECTIONS)).toHaveLength(expected.length)
  })
})

describe('findShortcut 匹配', () => {
  it('命中带 Ctrl 的四项', () => {
    expect(findShortcut(key('o', { ctrlKey: true }))).toBe('open')
    expect(findShortcut(key('s', { ctrlKey: true }))).toBe('saveAs')
    expect(findShortcut(key('m', { ctrlKey: true }))).toBe('merge')
  })

  it('大小写不敏感（大写字母与 CapsLock 下的 key 都要能命中）', () => {
    expect(findShortcut(key('O', { ctrlKey: true }))).toBe('open')
    expect(findShortcut(key('S', { ctrlKey: true }))).toBe('saveAs')
  })

  it('命中三个单键', () => {
    expect(findShortcut(key('Escape'))).toBe('exitModal')
    expect(findShortcut(key('Delete'))).toBe('deleteSelection')
    expect(findShortcut(key('Home'))).toBe('fitAll')
    expect(findShortcut(key('f'))).toBe('fitSelected')
  })

  it('修饰键严格相等：多按一个修饰键就不算命中（Ctrl+S 不该被 Ctrl+Shift+S 触发）', () => {
    expect(findShortcut(key('s', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(findShortcut(key('o', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(findShortcut(key('s', { ctrlKey: true, metaKey: true }))).toBeNull()
    // 反向：少按修饰键同样不命中——套在 Ctrl 项上的单键必须老老实实按组合键
    expect(findShortcut(key('s'))).toBeNull()
    expect(findShortcut(key('1'))).toBeNull()
    // 单键项也不能被加修饰键命中
    expect(findShortcut(key('f', { ctrlKey: true }))).toBeNull()
    expect(findShortcut(key('Escape', { shiftKey: true }))).toBeNull()
    expect(findShortcut(key('Delete', { ctrlKey: true }))).toBeNull()
  })

  it('Backspace 不是删除（Windows 上它是"返回上一级"的肌肉记忆，误删代价大）', () => {
    expect(findShortcut(key('Backspace'))).toBeNull()
  })

  it('未登记的键一律返回 null（含箭头键 / 回车 / 字母键）', () => {
    for (const k of ['a', 'z', 'Enter', 'ArrowUp', 'ArrowDown', ' ', 'F1', 'Tab']) {
      expect(findShortcut(key(k)), `${k} 不该命中`).toBeNull()
    }
  })
})

describe('matchShortcutEvent', () => {
  it('缺失的修饰键按"未按下"处理（短横线语义）', () => {
    expect(matchShortcutEvent(key('f'), { key: 'f' })).toBe(true)
    expect(matchShortcutEvent(key('f', { shiftKey: true }), { key: 'f' })).toBe(false)
    expect(matchShortcutEvent(key('s'), { key: 's', ctrl: true })).toBe(false)
    expect(matchShortcutEvent(key('s', { ctrlKey: true }), { key: 's', ctrl: true })).toBe(true)
  })

  it('metaKey（Windows 键）一律不参与命中', () => {
    expect(matchShortcutEvent(key('f', { metaKey: true }), { key: 'f' })).toBe(false)
  })
})
