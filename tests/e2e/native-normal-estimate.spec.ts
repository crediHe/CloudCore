import { test, expect, _electron as electron } from '@playwright/test'

/**
 * 法向量 native 链路 e2e 冒烟（`normal_estimate.node`）。
 *
 * 覆盖单测（纯 Node 环境）无法验证的集成点：构建产物中渲染进程（真实 BrowserWindow，
 * nodeIntegration + contextIsolation:false + sandbox:false 的"全开"组合，主世界可直接
 * require）经 preload IPC 拿到 `.node` 绝对路径后动态 require，再完成一次真实的
 * N-API 往返——**两个导出都要走**（`computeNormals` 与 `guessRadius`）。
 *
 * 顺带钉住两条本模块特有的契约：
 * 1. `codes` 是「**每候选一个值**」的并行数组，不是其余模块的顶点缓冲空间子集
 *    （chunk 1 带 index 子集 ⇒ 它的码数组比顶点数短）。
 * 2. 定向是**在码上**做的（翻 3 个符号位），故位 12 即 z 的符号位：+Z / −Z 两次调用的
 *    全部码应当**恰好互为反转**（`a ^ INVERT_XOR === b`），无需在页面里解码就能断言。
 *
 * 数据（不落盘）：两片互不相干的小块，每片 4 个共面顶点（法向量恒为 ±Z），
 * 半径 5 覆盖各自全部候选（LS 需 ≥3 点，含自身）。chunk 1 给了 3 个候选的 index 子集。
 */
test('渲染进程可加载 normal_estimate.node 并完成估计与自动半径往返', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const pageErrors: string[] = []
    window.on('pageerror', (error) => pageErrors.push(String(error)))

    // 1) IPC 路径通道 + 渲染主世界动态 require，并检查**两个导出**都在
    const chain = await window.evaluate(async () => {
      const w = globalThis as {
        electronAPI?: { native?: { getModulePath(name: string): Promise<{ exists: boolean; path: string }> } }
      }
      const info = await w.electronAPI!.native!.getModulePath('normal_estimate')
      const mod = new Function('p', 'return require(p)')(info.path) as Record<string, unknown>
      return {
        exists: info.exists,
        path: info.path,
        hasCompute: typeof mod.computeNormals === 'function',
        hasGuess: typeof mod.guessRadius === 'function',
      }
    })
    expect(chain.exists).toBe(true)
    expect(chain.hasCompute).toBe(true)
    expect(chain.hasGuess).toBe(true)
    expect(chain.path.endsWith('normal_estimate.node')).toBe(true)

    // 2) 真实 N-API 往返：+Z 与 −Z 各算一次
    const run = await window.evaluate(
      () =>
        new Promise<{
          plus: { codes: number[][] | null; computed: number; nullCount: number }
          minus: number[][] | null
          guess: { radius: number; attempts: number; sampledCount: number }
          guessAgain: number
          syncThrow: string
        }>((resolve, reject) => {
          const w = globalThis as {
            electronAPI?: { native?: { getModulePath(name: string): Promise<{ path: string }> } }
          }
          interface EstimateResult {
            entityId: number
            codes: Uint16Array[]
            computed: number
            nullCount: number
          }
          interface EstimateAddon {
            computeNormals(
              request: {
                radius: number
                model: number
                orientation: number
                entities: { entityId: number; chunks: { positions: Float32Array; index: Uint32Array | null }[] }[]
              },
              callback: (err: Error | null, results?: EstimateResult[]) => void
            ): void
            guessRadius(
              request: { entityId: number; chunks: { positions: Float32Array; index: Uint32Array | null }[] },
              callback: (err: Error | null, result?: { radius: number; attempts: number; sampledCount: number }) => void
            ): void
          }
          w.electronAPI!.native!.getModulePath('normal_estimate')
            .then((info) => {
              const mod = new Function('p', 'return require(p)')(info.path) as EstimateAddon
              // 片 0：4 顶点 / z = 0 平面，无 index（候选 = 全量顶点）
              const positions0 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
              // 片 1：4 顶点（远离片 0，半径 5 互不干扰），index 只取前 3 个 ⇒ 码数组长度应为 3
              const positions1 = new Float32Array([1000, 0, 0, 1001, 0, 0, 1000, 1, 0, 1001, 1, 0])
              const chunks = [
                { positions: positions0, index: null },
                { positions: positions1, index: new Uint32Array([0, 1, 2]) },
              ]
              const estimate = (orientation: number) =>
                new Promise<EstimateResult>((res, rej) => {
                  try {
                    mod.computeNormals(
                      { radius: 5, model: 0, orientation, entities: [{ entityId: 3, chunks }] },
                      (err, results) => (err ? rej(err) : res(results![0]))
                    )
                  } catch (e) {
                    rej(e as Error)
                  }
                })
              let syncThrow = ''
              try {
                // 参数类型错的同步抛（绑定层校验，不走回调）
                mod.computeNormals({ radius: 'x' } as never, () => undefined)
              } catch (e) {
                syncThrow = String(e)
              }
              // orientation：4 = plus-z、5 = minus-z（**线协议值**，见
              // utils/normalEstimate.ts 的 NORMAL_ORIENTATION_CODES——0/1 是 ±x）
              Promise.all([estimate(4), estimate(5)])
                .then(([plus, minus]) => {
                  mod.guessRadius({ entityId: 3, chunks: [{ positions: positions0, index: null }] }, (err, g) => {
                    if (err) {
                      reject(err)
                      return
                    }
                    mod.guessRadius(
                      { entityId: 3, chunks: [{ positions: positions0, index: null }] },
                      (err2, g2) => {
                        if (err2) {
                          reject(err2)
                          return
                        }
                        resolve({
                          plus: {
                            codes: plus.codes.map((c) => Array.from(c)),
                            computed: plus.computed,
                            nullCount: plus.nullCount,
                          },
                          minus: minus.codes.map((c) => Array.from(c)),
                          guess: g!,
                          guessAgain: g2!.radius,
                          syncThrow,
                        })
                      }
                    )
                  })
                })
                .catch(reject)
            })
            .catch(reject)
        })
    )

    const INVERT_XOR = 7 << 12
    const NULL_NORM_CODE = 32768

    // 每候选一个值：片 0 四个候选、片 1 三个（带 index 子集）——不是顶点数
    expect(run.plus.codes).toHaveLength(2)
    const [c0, c1] = run.plus.codes!
    expect(c0).toHaveLength(4)
    expect(c1).toHaveLength(3)

    // 共面点 ⇒ 全部有码、全部成功
    expect(run.plus.computed).toBe(7)
    expect(run.plus.nullCount).toBe(0)
    const all = [...c0, ...c1]
    expect(all.every((c) => c !== NULL_NORM_CODE)).toBe(true)

    // 定向写在码上：+Z 全部 z ≥ 0（位 12 清），−Z 版本与其**逐位互为反转**
    expect(all.every((c) => (c & (1 << 12)) === 0)).toBe(true)
    const minus = run.minus!.flat()
    expect(minus).toHaveLength(7)
    minus.forEach((code, i) => expect(code).toBe(all[i] ^ INVERT_XOR))

    // guessRadius：4 点 < 100 ⇒ 走朴素半径 = 最大包围盒边长 / 1 = 1（不采样、无随机）
    expect(run.guess.radius).toBe(1)
    expect(run.guess.attempts).toBe(0)
    expect(run.guess.sampledCount).toBe(0)
    expect(run.guessAgain).toBe(1)

    // 入参非法时绑定层**同步**抛 TypeError（不是静默挂死）
    expect(run.syncThrow).toContain('radius')

    // 沙箱教训的回归哨兵：External buffers / 未捕获异常都会出现在 pageerror 里
    expect(pageErrors).toEqual([])
  } finally {
    await electronApp.close()
  }
})
