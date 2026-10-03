import { test, expect, _electron as electron } from '@playwright/test'

/**
 * 半径滤波 native 链路 e2e 冒烟。
 *
 * 覆盖单测（纯 Node 环境）无法验证的集成点：构建产物中渲染进程（真实 BrowserWindow，
 * nodeIntegration + contextIsolation:false + sandbox:false 的"全开"组合，主世界可直接
 * require）经 preload IPC 拿到 .node 绝对路径后动态 require，并完成一次真实的
 * N-API compute 往返。
 *
 * 数据结构（不落盘、不加载真实 las——大文件分析烧不起）：
 * 块内 6 个顶点，index 候选 = {1,3,4}。v1/v3 相距 √0.5 ≤ r，v4 孤立；
 * r=1.0、minNeighbors=1 时候选 1/3 保留、4 剔除；非候选顶点 0/2/5 永不出现在结果
 * （顶点缓冲空间语义）。
 */
test('渲染进程可加载 radius_filter.node 并完成滤波计算', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const pageErrors: string[] = []
    window.on('pageerror', (error) => pageErrors.push(String(error)))

    // 1) IPC 路径通道 + 渲染主世界动态 require（无 CSP、无沙箱下的 new Function 求值）
    const chain = await window.evaluate(async () => {
      const w = globalThis as {
        electronAPI?: { native?: { getModulePath(name: string): Promise<{ exists: boolean; path: string }> } }
      }
      const info = await w.electronAPI!.native!.getModulePath('radius_filter')
      const mod = new Function('p', 'return require(p)')(info.path) as { compute: unknown }
      return { exists: info.exists, path: info.path, hasCompute: typeof mod.compute === 'function' }
    })
    expect(chain.exists).toBe(true)
    expect(chain.hasCompute).toBe(true)
    expect(chain.path.endsWith('radius_filter.node')).toBe(true)

    // 2) 真实 N-API compute 往返：候选顶点 {1,3,4} 在 r=1.0、min=1 下保留 {1,3}
    const result = await window.evaluate(
      () =>
        new Promise<{ kept: number[]; keptByChunkLength: number }>((resolve, reject) => {
          const w = globalThis as {
            electronAPI?: { native?: { getModulePath(name: string): Promise<{ path: string }> } }
          }
          w.electronAPI!.native!.getModulePath('radius_filter')
            .then((info) => {
              const mod = new Function('p', 'return require(p)')(info.path) as {
                compute(
                  request: {
                    radius: number
                    minNeighbors: number
                    entities: {
                      entityId: number
                      chunks: { positions: Float32Array; index: Uint32Array | null }[]
                    }[]
                  },
                  callback: (err: Error | null, results?: { entityId: number; kept: Uint32Array[] }[]) => void
                ): void
              }
              const positions = new Float32Array([
                0,
                0,
                0, // 顶点 0：非候选
                0.5,
                0,
                0, // 顶点 1：候选（保留）
                0,
                0.5,
                0, // 顶点 2：非候选
                0,
                0,
                0.5, // 顶点 3：候选（保留，距 v1 √0.5）
                100,
                100,
                100, // 顶点 4：候选（孤立 → 剔除）
                200,
                0,
                0, // 顶点 5：非候选
              ])
              const index = new Uint32Array([1, 3, 4])
              mod.compute(
                {
                  radius: 1.0,
                  minNeighbors: 1,
                  entities: [{ entityId: 7, chunks: [{ positions, index }] }],
                },
                (err, results) => {
                  if (err) {
                    reject(err)
                  } else {
                    const entity = results!.find((r) => r.entityId === 7)
                    const kept = entity!.kept[0]
                    resolve({ kept: Array.from(kept), keptByChunkLength: entity!.kept.length })
                  }
                }
              )
            })
            .catch(reject)
        })
    )
    expect(result.keptByChunkLength).toBe(1)
    expect(result.kept).toEqual([1, 3])

    expect(pageErrors).toEqual([])
  } finally {
    await electronApp.close()
  }
})
