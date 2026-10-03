import { describe, it, expect } from 'vitest'
import { mergeProductName } from '../../../../src/renderer/utils/objectIdentity'

// 「物体身份」的命名纯函数（node 环境即可）。名字里写的是**身份**：算法产物按编号命名
// （`Tree 7`），合并产物是**新物体**（新编号 + 新色 + 记住自己由哪几号合成）。
// 消费方只有一处：pointcloudStore.mergeEntities（`<族名> <新编号> (<来源编号>+…)`）。
describe('mergeProductName（合并产物的名字）', () => {
  it('族名主导方：换成新编号（合并产出的是一个新的同族物体）', () => {
    expect(mergeProductName('Tree 3', [3, 5], 8)).toBe('Tree 8 (3+5)')
    expect(mergeProductName('Cluster 12', [12, 7], 13)).toBe('Cluster 13 (12+7)')
  })

  it('带后缀的族名产物同样认族（`Tree 3.segmented` / `Cluster 4.noise` 都是 Tree/Cluster 族）', () => {
    expect(mergeProductName('Tree 3.segmented', [3, 5], 9)).toBe('Tree 9 (3+5)')
    expect(mergeProductName('Cluster 4.noise', [4], 6)).toBe('Cluster 6 (4)')
  })

  it('非族名（普通点云 = 文件名）沿用主导方名字：文件名比编号有用得多', () => {
    expect(mergeProductName('855.las', [3, 5], 8)).toBe('855.las (3+5)')
    expect(mergeProductName('plot-A.ply', [], 8)).toBe('plot-A.ply')
    // 词边界：`Treehouse.las` 不含独立的 Tree 词，别把文件名吃掉
    expect(mergeProductName('Treehouse.las', [1], 4)).toBe('Treehouse.las (1)')
  })

  it('无来源编号（合并的都是"数据块"，没有编号）：不追加括号', () => {
    expect(mergeProductName('Tree 3', [], 8)).toBe('Tree 8')
    expect(mergeProductName('855.las', [], 1)).toBe('855.las')
  })

  it('多个来源按给定顺序列出（完整来源记录在日志里，名字里只给编号）', () => {
    expect(mergeProductName('Tree 1', [1, 4, 9], 10)).toBe('Tree 10 (1+4+9)')
  })
})
