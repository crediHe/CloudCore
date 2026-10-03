import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { candidateCountOfChunk } from '../../../../src/renderer/utils/radiusFilter'
import {
  bucketCandidateLabels,
  buildEntityUnion,
  buildTreeColors,
  countLabels,
  keptLabelSet,
  sliceEntityLabels,
  summarizeTreeLabels,
  TREEISO_DEFAULTS,
} from '../../../../src/renderer/utils/treeIso'
import type {
  TreeIsoAddon,
  TreeIsoChunkSource,
  TreeIsoEntityResult,
  TreeIsoRequest,
} from '../../../../src/renderer/utils/treeIso'
import { LABEL_NOISE_SRGB, labelColor } from '../../../../src/renderer/utils/labelColors'
import { srgbU8ToLinear } from '../../../../src/renderer/utils/srgb'

// bucketCandidateLabels 是纯函数（node 环境即可，无需 jsdom）。
// C++ 契约冒烟测试直接 require 编译产物（N-API 对 Node 与 Electron 通用）；
// 产物缺失（CI 无编译链）时整组 skip，不挂测试（同 radiusFilter.spec 惯例）。

/** 本仓库根目录下 native 产物绝对路径（spec 位于 tests/unit/renderer/utils/，上溯 4 层）。 */
const NATIVE_PATH = fileURLToPath(new URL('../../../../native/treeiso/build/Release/treeiso.node', import.meta.url))
const nativeAvailable = existsSync(NATIVE_PATH)

/** 单块无 index 块源（候选 = 全量顶点；positions 只需长度占位，分桶不读内容）。 */
function rawChunk(vertexCount: number): TreeIsoChunkSource {
  return { positions: new Float32Array(vertexCount * 3), index: null }
}

/** 带 index 块源（候选 = index 条目，指向顶点下标）。 */
function indexedChunk(vertexCount: number, index: number[]): TreeIsoChunkSource {
  return { positions: new Float32Array(vertexCount * 3), index: new Uint32Array(index) }
}

describe('bucketCandidateLabels（标签 → 树桶/残点归拢）', () => {
  it('无 index 块：候选序即顶点下标，按 label 分桶且 label 升序', () => {
    const chunks = [rawChunk(5), rawChunk(4)]
    // 候选序 = 块主序：chunk0 顶点 0..4 → label 1；chunk1 顶点 0..3 → label 2
    const labels = new Int32Array([1, 1, 1, 1, 1, 2, 2, 2, 2])
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 1)
    expect(noiseChunkIndices).toBeNull()
    expect(treeBuckets.map((b) => b.label)).toEqual([1, 2])
    expect(treeBuckets.map((b) => b.pointCount)).toEqual([5, 4])
    // chunkIndices 与输入块逐块对齐（null = 该块无此树）
    expect(treeBuckets[0].chunkIndices).toEqual([new Uint32Array([0, 1, 2, 3, 4]), null])
    expect(treeBuckets[1].chunkIndices).toEqual([null, new Uint32Array([0, 1, 2, 3])])
  })

  it('带 index 块：候选映射回顶点下标（v = index[k]）', () => {
    const chunks = [indexedChunk(10, [1, 3, 5, 7])]
    // 候选 4 个 → 顶点 1,3,5,7（label 全 1）
    const labels = new Int32Array([1, 1, 1, 1])
    const { treeBuckets } = bucketCandidateLabels(chunks, labels, 1)
    expect(treeBuckets).toHaveLength(1)
    expect(treeBuckets[0].chunkIndices[0]).toEqual(new Uint32Array([1, 3, 5, 7]))
  })

  it('多块混合：候选序 = 块主序推进，分桶跨块累加', () => {
    // chunk0 无 index 6 候选（顶点 0..5）；chunk1 带 index（4 候选 → 顶点 10,12,14,16）
    const chunks = [rawChunk(6), indexedChunk(20, [10, 12, 14, 16])]
    // 树 3 与树 5 的点散布在两块
    const labels = new Int32Array([
      3,
      3,
      3,
      5,
      5,
      5, // chunk0 候选 6 个（顶点 0..5）
      3,
      5,
      3,
      5, // chunk1 候选 4 个（顶点 10,12,14,16）
    ])
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 1)
    expect(noiseChunkIndices).toBeNull()
    expect(treeBuckets.map((b) => b.label)).toEqual([3, 5]) // label 升序，跳过未出现的 1/2/4
    const tree3 = treeBuckets[0]
    expect(tree3.pointCount).toBe(5)
    expect(tree3.chunkIndices[0]).toEqual(new Uint32Array([0, 1, 2]))
    expect(tree3.chunkIndices[1]).toEqual(new Uint32Array([10, 14]))
    expect(treeBuckets[1].pointCount).toBe(5)
    expect(treeBuckets[1].chunkIndices[0]).toEqual(new Uint32Array([3, 4, 5]))
    expect(treeBuckets[1].chunkIndices[1]).toEqual(new Uint32Array([12, 16]))
  })

  it('minPoints：不足阈值的组件整体归拢残点，不逐点拆分', () => {
    const chunks = [rawChunk(10)]
    // 树 1：4 点（不足）；树 2：6 点（顶点 4..9）
    const labels = new Int32Array([1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 5)
    expect(treeBuckets.map((b) => b.label)).toEqual([2])
    expect(treeBuckets[0].chunkIndices[0]).toEqual(new Uint32Array([4, 5, 6, 7, 8, 9]))
    expect(noiseChunkIndices).not.toBeNull()
    expect(noiseChunkIndices![0]).toEqual(new Uint32Array([0, 1, 2, 3]))
  })

  it('全组件点数不足 / 全 label 0：无有效树，全部入残点（原实体不动的前提条件）', () => {
    const chunks = [rawChunk(4)]
    const labels = new Int32Array([0, 0, 0, 0])
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 5)
    expect(treeBuckets).toEqual([])
    expect(noiseChunkIndices![0]).toEqual(new Uint32Array([0, 1, 2, 3]))
  })

  it('label 空洞（只出现 2、5）与 minPoints 归拢混合：桶升序、空块给 null 占位', () => {
    const chunks = [indexedChunk(30, [2, 8, 15]), rawChunk(3)]
    // chunk0 候选 3 个（顶点 2,8,15）：label 5,2,5；chunk1 候选 3（顶点 0..2）：label 2,2,5
    const labels = new Int32Array([5, 2, 5, 2, 2, 5])
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 2)
    expect(treeBuckets.map((b) => b.label)).toEqual([2, 5])
    expect(treeBuckets[0].pointCount).toBe(3) // label 2：chunk0 顶点 8 + chunk1 顶点 0,1
    expect(treeBuckets[0].chunkIndices[0]).toEqual(new Uint32Array([8]))
    expect(treeBuckets[0].chunkIndices[1]).toEqual(new Uint32Array([0, 1]))
    // label 5 出现在两块但总数 3 ≥ 2 也算有效树
    expect(treeBuckets[1].pointCount).toBe(3)
    expect(treeBuckets[1].chunkIndices[0]).toEqual(new Uint32Array([2, 15]))
    expect(treeBuckets[1].chunkIndices[1]).toEqual(new Uint32Array([2]))
    expect(noiseChunkIndices).toBeNull()
  })

  it('空块（无候选）占位：跳过不报错，输出与输入块逐块对齐', () => {
    // chunk0 无点（候选 0）、chunk1 4 候选、chunk2 带 index 无候选（index 空数组）
    const chunks = [rawChunk(0), rawChunk(4), indexedChunk(10, [])]
    const labels = new Int32Array([2, 2, 2, 2])
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 1)
    expect(treeBuckets[0].pointCount).toBe(4)
    expect(treeBuckets[0].chunkIndices[0]).toBeNull() // 空块占位
    expect(treeBuckets[0].chunkIndices[1]).toEqual(new Uint32Array([0, 1, 2, 3]))
    expect(treeBuckets[0].chunkIndices[2]).toBeNull()
    expect(noiseChunkIndices).toBeNull()
  })

  it('标签数与候选数不符（契约异常）抛错', () => {
    const chunks = [rawChunk(5)]
    expect(() => bucketCandidateLabels(chunks, new Int32Array([1, 1, 1]), 1)).toThrow(/契约异常/)
    expect(() => bucketCandidateLabels(chunks, new Int32Array(7), 1)).toThrow(/契约异常/)
  })

  it('边界：minPoints = 1 时所有出现过的 label 都是树', () => {
    const chunks = [rawChunk(3)]
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, new Int32Array([1, 2, 3]), 1)
    expect(treeBuckets.map((b) => b.label)).toEqual([1, 2, 3])
    expect(noiseChunkIndices).toBeNull()
  })

  it('守恒：树桶点数 + 残点点数 = 候选总数（任何输入都成立）', () => {
    const chunks = [rawChunk(6), indexedChunk(20, [0, 4, 9, 12, 18]), rawChunk(2)]
    const labels = new Int32Array([
      1,
      1,
      2,
      3,
      3,
      0, // chunk0：6 候选（含 label 0 防御）
      2,
      3,
      1,
      1,
      2, // chunk1：5 候选
      2,
      2, // chunk2：2 候选
    ])
    const expected = chunks.reduce((s, c) => s + candidateCountOfChunk(c), 0)
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels(chunks, labels, 1)
    const treeTotal = treeBuckets.reduce((s, b) => s + b.pointCount, 0)
    const noiseTotal = noiseChunkIndices?.reduce((s, idx) => s + (idx ? idx.length : 0), 0) ?? 0
    expect(treeTotal + noiseTotal).toBe(expected)
    // 归拢掉的 label 0 点确实进了残点
    expect(noiseChunkIndices![0]).toEqual(new Uint32Array([5]))
  })
})

describe('countLabels（逐标签候选数；块主序）', () => {
  it('跨块累加；label ≤ 0 不计（未分类不是组件号）', () => {
    const chunks = [rawChunk(4), indexedChunk(10, [1, 5])]
    // chunk0 候选 4（顶点 0..3）：label 2,2,0,2；chunk1 候选 2（顶点 1,5）：label 2,5
    const labels = new Int32Array([2, 2, 0, 2, 2, 5])
    const counts = countLabels(chunks, labels)
    expect([...counts.entries()]).toEqual([
      [2, 4],
      [5, 1],
    ])
    expect(counts.has(0)).toBe(false)
  })

  it('与 bucketCandidateLabels 同判据：标签数与候选数不符抛错', () => {
    expect(() => countLabels([rawChunk(3)], new Int32Array(2))).toThrow(/契约异常/)
  })
})

describe('keptLabelSet（候选数 ≥ minPoints，含端点）', () => {
  it('恰等于阈值 ⇒ 保留（与分桶判据一致，差一即两侧不一致）', () => {
    const counts = new Map([
      [1, 5],
      [2, 4],
      [3, 9],
    ])
    expect([...keptLabelSet(counts, 5)].sort((a, b) => a - b)).toEqual([1, 3])
    expect([...keptLabelSet(counts, 10)]).toEqual([])
  })
})

describe('buildTreeColors（预览逐顶点线性色）', () => {
  // ⚠ srgbU8ToLinear 入参是 u8 字节（内部已除 255），别再除一次（会得到全 0）
  const lin = (v: number) => Math.round(srgbU8ToLinear(v) * 255)

  it('入选标签按 labelColor 上色；未入选（碎片）与非候选顶点为灰，长度 = 顶点数 × 3', () => {
    const chunks = [indexedChunk(5, [1, 3]), rawChunk(2)]
    // 候选序 = 块主序：block0 候选 2（顶点 1,3）→ label 7；block1 候选 2（顶点 0,1）→ label 3
    const labels = new Int32Array([7, 7, 3, 3])
    const [b0, b1] = buildTreeColors(chunks, labels, new Set([7]))
    const c7 = labelColor(7)
    const g = lin(LABEL_NOISE_SRGB)
    expect(b0!.length).toBe(5 * 3)
    // 候选顶点 1、3 上色（v = index[k]）
    expect(Array.from(b0!.subarray(3, 6))).toEqual([lin(c7.r), lin(c7.g), lin(c7.b)])
    expect(Array.from(b0!.subarray(9, 12))).toEqual([lin(c7.r), lin(c7.g), lin(c7.b)])
    // 顶点 0、2、4 非候选 ⇒ 灰
    expect(Array.from(b0!.subarray(0, 3))).toEqual([g, g, g])
    expect(Array.from(b0!.subarray(6, 9))).toEqual([g, g, g])
    expect(Array.from(b0!.subarray(12, 15))).toEqual([g, g, g])
    // 碎片组件（label 3 不在 kept）整块保持灰
    expect(Array.from(b1!)).toEqual([g, g, g, g, g, g])
  })

  it('零顶点块给 null 占位（该块无几何，装不上颜色）', () => {
    const [b0, b1] = buildTreeColors([rawChunk(0), rawChunk(2)], new Int32Array([1, 1]), new Set([1]))
    expect(b0).toBeNull()
    expect(b1!.length).toBe(6)
  })

  it('kept 为空（阈值过高）：整片灰，且不读坏色表', () => {
    const g = lin(LABEL_NOISE_SRGB)
    const [bytes] = buildTreeColors([rawChunk(2)], new Int32Array([1, 1]), new Set())
    expect(Array.from(bytes!)).toEqual([g, g, g, g, g, g])
  })

  // labelBase = 标签 → **物体编号**的位移（树项容器原地重建时容器里还留着带编号的手工项）：
  // 预览色按 base 位移，产物色按同一个编号取色（`labelColor(base + 标签 − 1)`）——
  // 两侧同源才可能"预览看到的色 == 拆出来的实体色"。这条断言钉的就是那个等价。
  it('labelBase：标签 1 取的是 labelColor(base) 的色（预览色与产物编号同源）', () => {
    const chunks = [rawChunk(2)]
    const labels = new Int32Array([1, 1])
    // 不传 base = 1（与既有行为逐字节一致）
    expect(Array.from(buildTreeColors(chunks, labels, new Set([1]))[0]!)).toEqual(
      Array.from(buildTreeColors(chunks, labels, new Set([1]), 1)[0]!)
    )
    // base = 4：标签 1 用 4 号的色（而不是 1 号的），标签 2 用 5 号的色
    const [b0] = buildTreeColors(chunks, labels, new Set([1]), 4)
    const c4 = labelColor(4)
    expect(Array.from(b0!.subarray(0, 3))).toEqual([lin(c4.r), lin(c4.g), lin(c4.b)])
    const c1 = labelColor(1)
    expect(Array.from(b0!.subarray(0, 3))).not.toEqual([lin(c1.r), lin(c1.g), lin(c1.b)])
  })
})

describe('summarizeTreeLabels（O(K) 统计）', () => {
  it('树数/树点/最大树/组件数；残点 = 候选总数 − 树点（含未达标组件）', () => {
    const counts = new Map([
      [1, 10],
      [2, 4],
      [3, 7],
    ])
    expect(summarizeTreeLabels(counts, 5, 30)).toEqual({
      componentCount: 3,
      treeCount: 2,
      treePoints: 17,
      noisePoints: 13,
      largestTreePoints: 10,
    })
  })

  it('全部不足阈值：0 棵树、残点 = 候选总数', () => {
    const s = summarizeTreeLabels(new Map([[1, 1]]), 100, 1)
    expect(s.treeCount).toBe(0)
    expect(s.noisePoints).toBe(1)
    expect(s.largestTreePoints).toBe(0)
  })

  it('空计数表（无组件）：全 0，且残点不为负', () => {
    expect(summarizeTreeLabels(new Map(), 5, 0)).toEqual({
      componentCount: 0,
      treeCount: 0,
      treePoints: 0,
      noisePoints: 0,
      largestTreePoints: 0,
    })
  })
})

describe('buildEntityUnion / sliceEntityLabels（容器重建：并起来与切回去）', () => {
  /** 两个实体 × 两块：e1 的块 1 无 index（契约上不进并集，记 0 个候选）。 */
  function fixture() {
    const e0 = [indexedChunk(10, [1, 2]), indexedChunk(10, [7])]
    const e1 = [indexedChunk(10, [3]), rawChunk(2)]
    return { e0, e1, union: buildEntityUnion([e0, e1])! }
  }

  it('块主序 concat：index 逐实体拼接、positions 共享首实体实例、countsByChunk 记各实体贡献', () => {
    const { e0, union } = fixture()
    expect(union.countsByChunk).toEqual([
      [2, 1],
      [1, 0],
    ])
    expect(union.chunks).toHaveLength(2)
    expect(union.chunks[0].positions).toBe(e0[0].positions) // 零拷贝：组内实体共享源缓冲
    expect(Array.from(union.chunks[0].index!)).toEqual([1, 2, 3])
    expect(Array.from(union.chunks[1].index!)).toEqual([7])
    // Σ countsByChunk == 并集候选总数（native 契约的 labels 长度）
    const sum = union.countsByChunk.reduce((s, counts) => s + counts.reduce((a, b) => a + b, 0), 0)
    expect(sum).toBe(candidateCountOfChunk(union.chunks[0]) + candidateCountOfChunk(union.chunks[1]))
  })

  it('切片与拼接互逆：逐实体切回（块序，与该实体自己的 chunks 对齐）', () => {
    const { union } = fixture()
    const labels = new Int32Array([10, 20, 30, 40]) // 并集块主序
    expect(Array.from(sliceEntityLabels(labels, union.countsByChunk, 0))).toEqual([10, 20, 40])
    expect(Array.from(sliceEntityLabels(labels, union.countsByChunk, 1))).toEqual([30])
    // 守恒：Σ 收缩片长度 == labels 长度（无一段被漏掉、也没有一段被算两次）
    let total = 0
    for (let e = 0; e < 2; e++) total += sliceEntityLabels(labels, union.countsByChunk, e).length
    expect(total).toBe(labels.length)
  })

  it('空输入 / 块数不一致（契约防御）⇒ null，调用方按目标失效处理', () => {
    expect(buildEntityUnion([])).toBeNull()
    expect(buildEntityUnion([[rawChunk(1)], [rawChunk(1), rawChunk(1)]])).toBeNull()
  })
})

describe.skipIf(!nativeAvailable)('treeiso.node 契约冒烟（native 产物存在时）', () => {
  const require = createRequire(import.meta.url)
  // 与 radiusFilter.spec 惯例一致：直连 addon（不走 nativeLoader 的 window IPC，
  // 后者只存在于 Electron 渲染环境）
  const addon = require(NATIVE_PATH) as TreeIsoAddon

  /** promise 化 addon.compute（compute 同步抛错一并收敛）。 */
  function computeNative(request: TreeIsoRequest): Promise<TreeIsoEntityResult[]> {
    return new Promise((resolve, reject) => {
      try {
        addon.compute(request, (err, results) => {
          if (err) reject(err)
          else resolve(results ?? [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  it('compute 异步回调：labels 与候选逐一点对应、值域 [0, K]', async () => {
    // 人造随机点云（模拟已去地面的树冠散布；契约冒烟不校验分割质量）
    const n = 4000
    const positions = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = Math.random() * 40 - 20
      positions[i * 3 + 1] = Math.random() * 40 - 20
      positions[i * 3 + 2] = Math.random() * 20 // Z 上扁分布更像树冠层
    }
    const entityId = 1
    const results = await computeNative({
      params: { ...TREEISO_DEFAULTS },
      entities: [{ entityId, chunks: [{ positions, index: null }] }],
    })
    const result = results.find((r) => r.entityId === entityId)
    expect(result).toBeDefined()
    expect(result!.labels).toHaveLength(n)
    for (const label of result!.labels) {
      expect(label).toBeGreaterThanOrEqual(0)
    }
    // 分桶守恒（minPoints 任意都成立）
    const { treeBuckets, noiseChunkIndices } = bucketCandidateLabels([{ positions, index: null }], result!.labels, 50)
    const treeTotal = treeBuckets.reduce((s, b) => s + b.pointCount, 0)
    const noiseTotal = noiseChunkIndices?.reduce((s, idx) => s + (idx ? idx.length : 0), 0) ?? 0
    expect(treeTotal + noiseTotal).toBe(n)
  })
})
