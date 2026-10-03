import { test, expect, _electron as electron } from '@playwright/test'

test('菜单栏 File 下拉包含 Open 与 Quit 菜单项', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // 展开 File 菜单
    await window.getByText('File').click()

    // 验证下拉菜单项可见
    await expect(window.getByRole('button', { name: 'Open' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Quit' })).toBeVisible()

    // 页面仍正常
    await expect(window.locator('#app')).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('菜单栏 Edit 下拉包含 Merge 与 Normals 三项，未选中点云时全部置灰', async () => {
  const electronApp = await electron.launch({
    args: ['dist-electron/main.js'],
    cwd: process.cwd(),
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // 展开 Edit 菜单
    await window.getByText('Edit', { exact: true }).click()

    // 分组标题与四个菜单项都在
    await expect(window.getByText('Normals', { exact: true })).toBeVisible()
    const merge = window.getByRole('button', { name: 'Merge' })
    const compute = window.getByRole('button', { name: 'Compute…' })
    const invert = window.getByRole('button', { name: 'Invert' })
    const del = window.getByRole('button', { name: 'Delete normals' })
    for (const item of [merge, compute, invert, del]) {
      await expect(item).toBeVisible()
    }

    // 启动时无选中项（也无已加载点云）⇒ 四项全部禁用：
    // 合并要 ≥2 片、Compute 要 ≥1 片已加载、Invert/Delete 要 ≥1 片有法向量
    for (const item of [merge, compute, invert, del]) {
      await expect(item).toBeDisabled()
    }
  } finally {
    await electronApp.close()
  }
})
