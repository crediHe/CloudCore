import { defineConfig } from '@playwright/test'

/**
 * Playwright 配置。
 *
 * ⚠ 这个文件是**必需的**，缺了它 e2e 会以一种很难懂的方式失败：
 *
 * 1. 没有 `testDir` 时，裸跑 `playwright test` 会把 `tests/unit/` 下的 Vitest spec
 *    也扫进收集范围——那些文件在 Playwright runner 里加载即崩（用的是 vitest 的
 *    `describe/it/expect` 导入与 `vi` mock）。
 * 2. `workers` 默认按 spec 文件数开，而每个 worker 各起一个 Electron 实例，主进程的
 *    `RobustnessManager` 有**单实例锁**：后到的实例打印「未能获取单实例锁，应用即将退出」
 *    并立刻退出，测试报 `Target page, context or browser has been closed`。
 *    实测表现为「1 passed / 11 failed」。**必须串行**。
 *
 * 另外 e2e 启动的是构建产物 `dist-electron/main.js`，所以 `package.json` 的
 * `test:e2e` 脚本里先跑 `build:test`；只改了主进程代码而没重新构建时，测的是旧产物。
 *
 * 单实例锁也约束**录制/截图脚本**：跑之前先确认没有别的实例在运行。
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // 单实例锁：Electron 实例不能并行，必须 1 个 worker
  workers: 1,
  fullyParallel: false,
  // 加载大点云文件（含 420 万点用例）的等待时间远超默认 30s
  timeout: 300_000,
  expect: { timeout: 30_000 },
  // 本地/CI 都用 list，不生成 HTML 报告（避免多出一个 gitignore 之外的目录）
  reporter: [['list']],
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
