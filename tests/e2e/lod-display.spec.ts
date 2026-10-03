import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOD_FRAME_BUDGET } from '../../src/renderer/three/lodRenderer'

/**
 * LOD 显示层 e2e（阶段 1 验收）。
 *
 * 覆盖单测（纯 three 对象、手工构造的几何体）无法验证的集成面：真实构建产物里
 * 走完整加载链路（dialog → preload IPC → LasManager 分块读 → parseLasChunk →
 * registerCloudRecord 阈值分流）之后，**每帧绘制点数是否真的被钉在预算内**，
 * 以及拾取桥在真机上是否把槽位号反查回了正确的源顶点。
 *
 * 判据（对齐方案里的验收项）：
 *  ① `renderer.info.render.points <= 512288` 且**不随总点数变化**——用 120 万点与
 *     420 万点两个文件分别加载，两者绘制点数必须都恰好等于预算；
 *  ② 语义层（per-chunk `Points`）整片隐藏但仍持有全量点——证明"整云不进显存"；
 *  ③ 双击拾取：日志里的 P# 与日志里的 X 坐标必须指向**同一个源顶点**
 *     （判据 `round((X + basePoint.x) / SCALE) === P#`，见下方坐标设计）。
 *
 * 坐标设计（把拾取桥变成可判定的）：
 *   - `X_int = 全局序号 % 500000`，而 500000 正是 `loadLargeLas` 的分块大小，
 *     于是 **X_int 恒等于块内顶点下标**，且 X 严格递增、块内无重复；
 *   - 偏移取 0，故 `localX = (X_int - basePoint.x) / SCALE`（basePoint = 头部包围盒中心）；
 *   - 所以 `round((localX + baseX) / SCALE)` 必须**恰好**等于日志里的 P#。
 *     若拾取桥把 staging 槽位号当成顶点了（阶段 1 引入的那一跳漏做/做错），
 *     槽位是等距抽样出的下标（0,1,2,3,5,7,…），与 X 对不上，断言立刻失败。
 *   - Y/Z 用散列铺满同一跨度，纯粹为了让点云是个"立方体"而非一条直线。
 *   - 精度预算：X 跨度 1000 单位、显示坐标绝对值 ≤ 500，float32 相对误差 ~6e-5，
 *     日志又只保留 4 位小数（±5e-5），合计折合 ±0.06 个顶点下标——离 0.5 还很远，
 *     故 `round` 一定能还原出精确的那个下标（断言里另加了 0.1 的余量检查）。
 */

const CHUNK_SIZE = 500_000 // 与 loadLargeLas 默认 chunkSize 一致（决定 X_int ↔ 顶点下标的恒等）
const HEADER_SIZE = 227 // LAS 1.2 公共头部长度
const DATA_OFFSET = 375 // 头部之后即是点记录
const RECORD_LENGTH = 20 // 点格式 0
/**
 * 比例因子。刻意取小值：显示坐标跨度必须留在引擎相机的 far=10000 之内
 * （engine.ts:146 的硬编码远平面，fitView 不调 near/far）。
 * 0.002 × 500000 = 1000 单位跨度 → fitView 机位距离 ~4200，留足余量。
 */
const SCALE = 0.002

interface LasFile {
  path: string
  pointCount: number
  /** 文件真实包围盒（同时写进了 LAS 头部，故也是 basePoint 的来源），原始坐标单位。 */
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

/** basePoint（LAS 头部包围盒中心）在某一轴上的分量。 */
function baseAxis(min: number, max: number): number {
  return (min + max) / 2
}

let workDir: string
let small: LasFile
let large: LasFile

/** 32 位整数散列；用 Math.imul 避免 i × 常数超出 double 精度。 */
function hash32(i: number, seed: number): number {
  let h = Math.imul(i + seed, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** 造一个合法的 LAS 1.2 / 点格式 0 文件（20 B/记录），坐标布局见文件头注释。 */
function writeLas(dir: string, name: string, pointCount: number): LasFile {
  const filePath = join(dir, name)
  const buf = Buffer.alloc(DATA_OFFSET + pointCount * RECORD_LENGTH)
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (let i = 0; i < pointCount; i++) {
    const o = DATA_OFFSET + i * RECORD_LENGTH
    const y = hash32(i, 1) % CHUNK_SIZE
    const z = hash32(i, 2) % CHUNK_SIZE
    buf.writeInt32LE(i % CHUNK_SIZE, o)
    buf.writeInt32LE(y, o + 4)
    buf.writeInt32LE(z, o + 8)
    buf.writeUInt8(i % 32, o + 15) // 分类（格式 0-5 的低 5 位）
    buf.writeUInt16LE(1, o + 18) // point source id
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  buf.write('LASF', 0, 'ascii')
  buf.writeUInt8(1, 24) // versionMajor
  buf.writeUInt8(2, 25) // versionMinor
  buf.writeUInt16LE(HEADER_SIZE, 94)
  buf.writeUInt32LE(DATA_OFFSET, 96)
  buf.writeUInt8(0, 104) // pointFormat
  buf.writeUInt16LE(RECORD_LENGTH, 105)
  buf.writeUInt32LE(pointCount, 107) // 遗留点计数
  buf.writeDoubleLE(SCALE, 131) // scaleX/Y/Z
  buf.writeDoubleLE(SCALE, 139)
  buf.writeDoubleLE(SCALE, 147)
  buf.writeDoubleLE(0, 155) // offsetX/Y/Z
  buf.writeDoubleLE(0, 163)
  buf.writeDoubleLE(0, 171)
  // 头部包围盒写**原始坐标**（int × scale），与 loadLargeLas 取 basePoint 的口径一致
  const maxX = (CHUNK_SIZE - 1) * SCALE
  buf.writeDoubleLE(maxX, 179) // maxX
  buf.writeDoubleLE(0, 187) // minX
  buf.writeDoubleLE(maxY * SCALE, 195)
  buf.writeDoubleLE(minY * SCALE, 203)
  buf.writeDoubleLE(maxZ * SCALE, 211)
  buf.writeDoubleLE(minZ * SCALE, 219)

  writeFileSync(filePath, buf)
  return {
    path: filePath,
    pointCount,
    minY: minY * SCALE,
    maxY: maxY * SCALE,
    minZ: minZ * SCALE,
    maxZ: maxZ * SCALE,
  }
}

test.beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lod-display-'))
  small = writeLas(workDir, 'lod-small.las', 1_200_000) // 3 块（500K/500K/200K）
  large = writeLas(workDir, 'lod-large.las', 4_200_000) // 9 块（8×500K + 200K）
})

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 用 Stub 掉的文件对话框加载指定 LAS：走的是与用户点"打开"完全相同的入口。 */
async function openCloud(page: Page, file: LasFile): Promise<void> {
  await page.evaluate((filePath) => {
    const api = (globalThis as unknown as { electronAPI: { dialog: { openFile: unknown } } }).electronAPI
    api.dialog.openFile = async () => [filePath]
  }, file.path)
  await page.locator('button[title="打开点云文件"]').click()
  // 加载完成信号：useOpenPointCloud 在全部文件读完后写的那条日志
  await page.locator('.console__message', { hasText: '已加载，共享基准点' }).first().waitFor({ timeout: 180_000 })
  // 那条日志写在 task.done() **之前**，而全局进度条是整窗 modal 遮罩（卸载还要等收尾停留），
  // 不等它消失的话后续鼠标事件全落在遮罩上（GlobalProgress.vue 的 v-if="task"）
  await page.locator('.progress-root').waitFor({ state: 'detached', timeout: 30_000 })
}

/** 读引擎的渲染统计（ThreeView.vue 挂的 window.__viewer）。 */
async function renderPoints(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewer = (globalThis as unknown as { __viewer?: { getRenderStats: () => { points: number } } }).__viewer
    if (!viewer) throw new Error('window.__viewer 不存在：ThreeView 未挂载引擎')
    return viewer.getRenderStats().points
  })
}

interface PointsSnapshot {
  /** 本帧实际绘制的顶点数；按 three 的算法在 index / position 与 drawRange 间取小。 */
  draw: number
  /** 几何体持有的顶点总数（语义层的"整云"）。 */
  total: number
  visible: boolean
  /** 是否 LOD 显示层（staging 挂 lodSlot 反查器）。 */
  staging: boolean
}

/** 遍历场景取所有 THREE.Points 的结构快照。 */
async function inspectPoints(page: Page): Promise<PointsSnapshot[]> {
  return page.evaluate(() => {
    interface Geo {
      drawRange: { start: number; count: number }
      index: { count: number } | null
      attributes: { position?: { count: number } }
    }
    const viewer = (globalThis as unknown as { __viewer?: { scene: { traverse(cb: (o: unknown) => void): void } } })
      .__viewer
    if (!viewer) throw new Error('window.__viewer 不存在')
    const out: PointsSnapshot[] = []
    viewer.scene.traverse((o) => {
      const points = o as {
        isPoints?: boolean
        visible: boolean
        geometry: Geo
        userData?: { lodSlot?: unknown }
      }
      if (!points.isPoints) return
      const g = points.geometry
      // three 的默认 drawRange.count 是 Infinity（"全量"），有效值要在绘制期才与
      // 顶点数取小；这里照抄 WebGLRenderer.renderBufferDirect 的算法
      const total = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
      out.push({
        draw: Math.max(0, Math.min(g.drawRange.count, total - g.drawRange.start)),
        total,
        visible: points.visible,
        staging: typeof points.userData?.lodSlot === 'function',
      })
    })
    return out
  })
}

/** 每帧绘制点数必须恰好等于预算：容量 = min(可见总点数, 预算)，超预算即封顶。 */
function expectCapped(stats: PointsSnapshot[], totalPoints: number): void {
  const staging = stats.filter((s) => s.staging)
  const semantic = stats.filter((s) => !s.staging)

  expect(staging).toHaveLength(1)
  expect(staging[0].draw).toBe(LOD_FRAME_BUDGET)
  expect(staging[0].visible).toBe(true)

  // 语义层整云仍在（CPU 内存 + 共享 attribute），但一片都不画
  expect(semantic.reduce((sum, s) => sum + s.total, 0)).toBe(totalPoints)
  expect(semantic.every((s) => !s.visible)).toBe(true)
}

test('加载超阈值点云：每帧绘制点数封顶在预算内，整云退出渲染', async () => {
  const app: ElectronApplication = await electron.launch({ args: ['dist-electron/main.js'], cwd: process.cwd() })
  const page = await app.firstWindow()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.waitForSelector('canvas', { timeout: 20_000 })
    await openCloud(page, small)

    await expect.poll(() => renderPoints(page), { timeout: 30_000 }).toBe(LOD_FRAME_BUDGET)
    expectCapped(await inspectPoints(page), small.pointCount)

    // 再等一段：静止期不得有任何额外的绘制把它顶出预算（加密是阶段 3 的事）
    await page.waitForTimeout(500)
    expect(await renderPoints(page)).toBe(LOD_FRAME_BUDGET)

    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})

test('绘制点数与总点数解耦：420 万点与 120 万点画一样多', async () => {
  const app: ElectronApplication = await electron.launch({ args: ['dist-electron/main.js'], cwd: process.cwd() })
  const page = await app.firstWindow()

  try {
    await page.waitForSelector('canvas', { timeout: 20_000 })
    await openCloud(page, large)

    await expect.poll(() => renderPoints(page), { timeout: 60_000 }).toBe(LOD_FRAME_BUDGET)
    const stats = await inspectPoints(page)
    expectCapped(stats, large.pointCount)

    // 同一个预算值（LOD_FRAME_BUDGET），总点数却是上一个用例的 3.5 倍
    expect(stats.filter((s) => s.staging)[0].draw).toBe(LOD_FRAME_BUDGET)
    expect(large.pointCount / small.pointCount).toBeGreaterThan(3)
  } finally {
    await app.close()
  }
})

test('双击拾取：LOD 显示层命中的槽位被反查回对应源顶点', async () => {
  const app: ElectronApplication = await electron.launch({ args: ['dist-electron/main.js'], cwd: process.cwd() })
  const page = await app.firstWindow()

  try {
    await page.waitForSelector('canvas', { timeout: 20_000 })
    await openCloud(page, small)
    await expect.poll(() => renderPoints(page), { timeout: 30_000 }).toBe(LOD_FRAME_BUDGET)

    const box = await page.locator('canvas').boundingBox()
    if (!box) throw new Error('canvas 没有布局盒：3D 视图不可见')
    // 首块点云已 fitView，画布正中的射线必定穿过点云
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)

    const line = page.locator('.console__message', { hasText: '旋转中心已设为' }).first()
    await line.waitFor({ timeout: 30_000 })
    const text = (await line.textContent()) ?? ''

    const m = /旋转中心已设为 P#(\d+) X: (-?[\d.]+)\s+Y: (-?[\d.]+)\s+Z: (-?[\d.]+)/.exec(text)
    expect(m, `未能从日志解析出 P# 与坐标：${text}`).not.toBeNull()
    const hit = { vertexIndex: Number(m![1]), x: Number(m![2]), y: Number(m![3]), z: Number(m![4]) }

    // 判据的核心：X 坐标还原出的源顶点下标必须**恰好**是日志里的 P#
    // （理由与精度预算见文件头"坐标设计"）。槽位号被误当成顶点下标时
    // （等距抽样的 0,1,2,3,5,7,…）这一步立刻不等。
    const baseX = (CHUNK_SIZE - 1) * SCALE / 2
    const recovered = (hit.x + baseX) / SCALE
    expect(hit.vertexIndex).toBeGreaterThanOrEqual(0)
    expect(hit.vertexIndex).toBeLessThan(CHUNK_SIZE)
    expect(Math.abs(recovered - hit.vertexIndex)).toBeLessThan(0.1)
    expect(Math.round(recovered)).toBe(hit.vertexIndex)

    // Y/Z 必须落回文件坐标范围内：P# 反查错了块/错了下标时坐标会是垃圾值
    const tol = 0.01
    expect(hit.y + baseAxis(small.minY, small.maxY)).toBeGreaterThanOrEqual(small.minY - tol)
    expect(hit.y + baseAxis(small.minY, small.maxY)).toBeLessThanOrEqual(small.maxY + tol)
    expect(hit.z + baseAxis(small.minZ, small.maxZ)).toBeGreaterThanOrEqual(small.minZ - tol)
    expect(hit.z + baseAxis(small.minZ, small.maxZ)).toBeLessThanOrEqual(small.maxZ + tol)
  } finally {
    await app.close()
  }
})
