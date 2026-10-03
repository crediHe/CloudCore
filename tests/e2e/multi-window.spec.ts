import { test, expect, _electron as electron } from '@playwright/test'

test('可通过 IPC 打开设置子窗口', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // 通过 preload 暴露的 API 打开设置窗口
    await mainWindow.evaluate(() => window.electronAPI.windowManager.open('settings'))

    // 等待第二个窗口出现
    await expect.poll(async () => electronApp.windows().length).toBe(2)

    const settingsWindow = electronApp.windows()[1]
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('#app')).toBeVisible()

    // 主窗口保持正常
    await expect(mainWindow.locator('#app')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
