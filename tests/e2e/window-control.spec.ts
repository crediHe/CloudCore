import { test, expect, _electron as electron } from '@playwright/test'

test('自定义标题栏按钮可控制窗口最大化与最小化', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // 两个页面（主工作区与设置页）由 App.vue 用 v-show 同时渲染，故同一 DOM 里有**两套**
    // `.ctrl` 按钮（设置页那份在 DOM 中靠前、但被 display:none 隐藏）。`:visible` 选出
    // 主窗口的那一套。
    // 初始按钮是「最大化」还是「还原」取决于**上次运行持久化的窗口状态**
    // （WindowStateManager 会记住最大化状态），故两者取其一，不假设初态。
    const toggle = window.locator('.ctrl[title="最大化"]:visible, .ctrl[title="还原"]:visible')
    await expect(toggle).toBeVisible()
    const before = await toggle.getAttribute('title')
    await toggle.click()
    // 点击后按钮标题应在「最大化 / 还原」之间切换——这同时证明了点击生效
    const after = before === '最大化' ? '还原' : '最大化'
    await expect(window.locator(`.ctrl[title="${after}"]:visible`)).toBeVisible()

    // 点击最小化按钮（Windows 下窗口随即最小化，故只断言点击前的可见性）
    const minimize = window.locator('.ctrl[title="最小化"]:visible')
    await expect(minimize).toBeVisible()
    await minimize.click()
  } finally {
    await electronApp.close()
  }
})
