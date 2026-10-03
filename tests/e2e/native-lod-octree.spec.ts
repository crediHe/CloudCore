import { test, expect, _electron as electron } from '@playwright/test'

/**
 * LOD 八叉树 native 链路 e2e 冒烟。
 *
 * 覆盖单测（纯 Node 环境）无法验证的集成点：真实构建产物里渲染进程经 preload IPC
 * 拿到 `lod_octree.node` 绝对路径后动态 require，并完成一次真实的 N-API 建树往返。
 * 单测验的是**算法不变量**（tests/unit/renderer/utils/lodOctree.spec.ts），这里验的是
 * **这条链本身通不通**：路径登记（nativeModulePlugin）→ asarUnpack 布局 →
 * 多块入参（其余 6 个模块都没有的 shapes）→ 零拷贝输出（外部 ArrayBuffer）可读。
 *
 * 数据结构：两块各 1000 点的确定性晶格（跨块同体积 = 真实 LAS 分块形态），
 * 断言整棵树的结构自洽——节点区间划分、叶子覆盖、打包 id 解码回源顶点。
 */

/** 单块顶点数（两块）。 */
const CHUNK_POINTS = 1000

test('渲染进程可加载 lod_octree.node 并完成一次真实建树', async () => {
  const electronApp = await electron.launch({ args: ['dist-electron/main.js'], cwd: process.cwd() })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const pageErrors: string[] = []
    window.on('pageerror', (error) => pageErrors.push(String(error)))

    // 1) IPC 路径通道 + 渲染主世界动态 require
    const chain = await window.evaluate(async () => {
      const w = globalThis as {
        electronAPI?: { native?: { getModulePath(name: string): Promise<{ exists: boolean; path: string }> } }
      }
      const info = await w.electronAPI!.native!.getModulePath('lod_octree')
      const mod = new Function('p', 'return require(p)')(info.path) as { compute: unknown; cancel: unknown }
      return {
        exists: info.exists,
        path: info.path,
        hasCompute: typeof mod.compute === 'function',
        hasCancel: typeof mod.cancel === 'function',
      }
    })
    expect(chain.exists).toBe(true)
    expect(chain.hasCompute).toBe(true)
    expect(chain.hasCancel).toBe(true)
    expect(chain.path.endsWith('lod_octree.node')).toBe(true)

    // 2) 真实 N-API 建树往返 + 结构自洽（在页面主世界里跑，验证零拷贝输出可读）
    const result = await window.evaluate(
      (chunkPoints) =>
        new Promise<{ nodeCount: number; pointCount: number; leafPoints: number; unique: number; maxLeaf: number }>(
          (resolve, reject) => {
            const w = globalThis as {
              electronAPI?: { native?: { getModulePath(name: string): Promise<{ path: string }> } }
            }
            interface EntityResult {
              nodeCount: number
              pointCount: number
              vertexShift: number
              nodeChildBase: Uint32Array
              nodeChildMask: Uint8Array
              nodePointStart: Uint32Array
              nodePointCount: Uint32Array
              pointIds: Uint32Array
            }
            w.electronAPI!.native!.getModulePath('lod_octree')
              .then((info) => {
                const mod = new Function('p', 'return require(p)')(info.path) as {
                  compute(
                    request: unknown,
                    onProgress: (p: { overall: number }) => void,
                    callback: (err: Error | null, results?: EntityResult[]) => void
                  ): void
                }
                const lattice = (chunk: number) => {
                  const positions = new Float32Array(chunkPoints * 3)
                  for (let i = 0; i < chunkPoints; i++) {
                    positions[i * 3] = (i % 10) + chunk * 10
                    positions[i * 3 + 1] = Math.floor(i / 10) % 10
                    positions[i * 3 + 2] = Math.floor(i / 100)
                  }
                  return positions
                }
                mod.compute(
                  {
                    maxPointsPerCell: 64,
                    entities: [{ entityId: 7, chunks: [{ positions: lattice(0) }, { positions: lattice(1), index: null }] }],
                  },
                  () => {},
                  (err, results) => {
                    if (err) {
                      reject(err)
                      return
                    }
                    const r = results!.find((e) => e.entityId === 7)!
                    const total = chunkPoints * 2
                    // 根区间 = 全部点；子节点区间首尾相接地划分父区间
                    if (r.nodePointStart[0] !== 0 || r.nodePointCount[0] !== total) {
                      reject(new Error(`根区间异常：${r.nodePointStart[0]}/${r.nodePointCount[0]}`))
                      return
                    }
                    const seen = new Set<number>()
                    let leafPoints = 0
                    let maxLeaf = 0
                    for (let n = 0; n < r.nodeCount; n++) {
                      const mask = r.nodeChildMask[n]
                      const kids: number[] = []
                      let rank = 0
                      for (let k = 0; k < 8; k++) {
                        if (mask & (1 << k)) kids.push(r.nodeChildBase[n] + rank++)
                      }
                      if (kids.length > 0) {
                        let cursor = r.nodePointStart[n]
                        for (const k of kids) {
                          if (r.nodePointStart[k] !== cursor) {
                            reject(new Error(`节点 ${n} 的子区间不连续`))
                            return
                          }
                          cursor += r.nodePointCount[k]
                        }
                        if (cursor !== r.nodePointStart[n] + r.nodePointCount[n]) {
                          reject(new Error(`节点 ${n} 的子区间未恰好划分父区间`))
                          return
                        }
                        continue
                      }
                      maxLeaf = Math.max(maxLeaf, r.nodePointCount[n])
                      for (let i = 0; i < r.nodePointCount[n]; i++) {
                        const id = r.pointIds[r.nodePointStart[n] + i]
                        if (seen.has(id)) {
                          reject(new Error(`点 ${id} 在叶子中重复`))
                          return
                        }
                        seen.add(id)
                        leafPoints++
                      }
                    }
                    resolve({ nodeCount: r.nodeCount, pointCount: r.pointCount, leafPoints, unique: seen.size, maxLeaf })
                  }
                )
              })
              .catch(reject)
          }
        ),
      CHUNK_POINTS
    )

    expect(result.pointCount).toBe(CHUNK_POINTS * 2)
    expect(result.nodeCount).toBeGreaterThan(1)
    expect(result.leafPoints).toBe(CHUNK_POINTS * 2) // 叶子覆盖每个点恰一次
    expect(result.unique).toBe(CHUNK_POINTS * 2)
    expect(result.maxLeaf).toBeLessThanOrEqual(64) // 晶格规整，不会触顶

    expect(pageErrors).toEqual([])
  } finally {
    await electronApp.close()
  }
})
