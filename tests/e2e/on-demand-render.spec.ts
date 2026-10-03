import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * 按需渲染冒烟（阶段 0 的验收项之一）。
 *
 * 引擎静止时不得空转重绘——1 亿点场景下每帧重绘就是几百毫秒的 GPU 白烧。
 * 判据用 `renderer.info.render.frame`（累计渲染帧数）：空闲一段时间后应当停止增长，
 * 而任何相机/数据变更后必须恢复增长。
 *
 * 这里刻意不加载点云：机制本身与数据无关，空场景同样能验证"静默"与"唤醒"两个方向
 * （真要有回归，最典型的表现就是永远重绘或永远不重绘，两者都会被本用例抓住）。
 */

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  app = await electron.launch({ args: ['dist-electron/main.js'], cwd: process.cwd() })
  page = await app.firstWindow()
  await page.waitForSelector('canvas', { timeout: 20000 })
})

test.afterEach(async () => {
  await app?.close()
})

/** 读累计渲染帧数（引擎实例由 ThreeView.vue 挂在 window.__viewer）。 */
async function renderFrame(): Promise<number> {
  return page.evaluate(() => {
    const viewer = (window as unknown as { __viewer?: { getRenderStats: () => { frame: number } } }).__viewer
    if (!viewer) throw new Error('window.__viewer 不存在：ThreeView 未挂载引擎')
    return viewer.getRenderStats().frame
  })
}

test('静止时停止重绘，相机变化后恢复重绘', async () => {
  const first = await renderFrame()
  expect(first).toBeGreaterThan(0) // 首帧必须画出来

  // 静置 600ms（约 36 个 rAF 周期）：不应有任何新的渲染
  await page.waitForTimeout(600)
  const idle = await renderFrame()
  expect(idle).toBe(first)

  // 触发一次相机变更（切标准视角），必须唤醒重绘
  await page.evaluate(() => {
    const viewer = (window as unknown as { __viewer?: { setView: (v: string) => void } }).__viewer
    viewer?.setView('front')
  })
  await page.waitForTimeout(300)
  const afterCamera = await renderFrame()
  expect(afterCamera).toBeGreaterThan(idle)

  // 再次静置：又该停下
  await page.waitForTimeout(600)
  expect(await renderFrame()).toBe(afterCamera)
})

test('requestRender 唤醒重绘，随后再次静默', async () => {
  await page.waitForTimeout(300)
  const before = await renderFrame()

  // 这是 pointcloudStore / 测量 / 框选各写入点依赖的那个 API：
  // three 对象没有变更通知，直写 three 之后必须靠它把重绘排上
  await page.evaluate(() => {
    const viewer = (window as unknown as { __viewer?: { requestRender: () => void } }).__viewer
    viewer?.requestRender()
  })
  await page.waitForTimeout(200)
  const after = await renderFrame()
  expect(after).toBeGreaterThan(before)

  await page.waitForTimeout(600)
  expect(await renderFrame()).toBe(after)
})
