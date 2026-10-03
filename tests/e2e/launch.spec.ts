import { test, expect, _electron as electron } from '@playwright/test'

test('应用启动并显示主窗口', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // 验证页面标题或内容包含预期文本
    const title = await window.title()
    expect(title.length).toBeGreaterThan(0)

    // 验证渲染进程已挂载 #app
    const app = await window.locator('#app').first()
    await expect(app).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
