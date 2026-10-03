import path from 'node:path'
import { existsSync } from 'node:fs'
import type { NativeModulePathInfo } from '../../shared/types/electron-api'
import type { AppPlugin } from '../core/PluginRegistry'

/** 模块级保存 ipcMain 引用，供 destroy 阶段清理 IPC 处理器。 */
let _ipcMain: Electron.IpcMain | undefined

/**
 * 各 native 模块产物相对包根的路径（asar 内布局与源码目录一致）。
 * 新增 native 模块时在此登记；模块名即渲染进程 getModulePath 的参数。
 */
const MODULE_RELATIVE_PATHS: Record<string, string> = {
  radius_filter: path.join('native', 'radius-filter', 'build', 'Release', 'radius_filter.node'),
  voxel_filter: path.join('native', 'voxel-filter', 'build', 'Release', 'voxel_filter.node'),
  // LiDAR CSF（qCSF 机载语义，快）；精准版（老算法液体贴合语义，丘陵/山脉高精度，慢）
  csf_lidar: path.join('native', 'csf-lidar', 'build', 'Release', 'csf_lidar.node'),
  csf_pro: path.join('native', 'csf-pro', 'build', 'Release', 'csf_pro.node'),
  statistical_filter: path.join('native', 'statistical-filter', 'build', 'Release', 'statistical_filter.node'),
  treeiso: path.join('native', 'treeiso', 'build', 'Release', 'treeiso.node'),
  // LOD 八叉树（渲染侧流式绘制用，非算法模态）
  lod_octree: path.join('native', 'lod-octree', 'build', 'Release', 'lod_octree.node'),
  // RANSAC 平面拟合（回包比其余算法模块多一个 plane 模型字段，见 utils/ransacPlane.ts）
  ransac_plane: path.join('native', 'ransac-plane', 'build', 'Release', 'ransac_plane.node'),
  // 法向量估计 + 自动半径（两个导出；codes 是「每候选一个值」的并行数组，见 utils/normalEstimate.ts）
  normal_estimate: path.join('native', 'normal-estimate', 'build', 'Release', 'normal_estimate.node'),
  // RANSAC 圆柱拟合（回包多一个 cylinder 模型字段；轴方向不依赖法线，见 utils/ransacCylinder.ts）
  ransac_cylinder: path.join('native', 'ransac-cylinder', 'build', 'Release', 'ransac_cylinder.node'),
  // 欧式聚类分割（回包是「逐候选标签 + 簇大小表」而不是下标子集；min/max 过滤在渲染侧，
  // 见 utils/euclideanCluster.ts）
  euclidean_cluster: path.join('native', 'euclidean-cluster', 'build', 'Release', 'euclidean_cluster.node'),
  // 配准：点对粗配准 + ICP 精配准（两个导出 findAbsoluteOrientation / icp，
  // 见 utils/registration.ts）
  registration: path.join('native', 'registration', 'build', 'Release', 'registration.node'),
  // 电力线提取：候选提取 + 连线（两个导出 extractCandidates / traceLines，
  // 见 utils/powerline.ts）
  powerline: path.join('native', 'powerline', 'build', 'Release', 'powerline.node'),
}

/**
 * Native 模块路径插件。
 *
 * 渲染进程已开启 nodeIntegration，会直接 require 编译好的 .node 产物
 *（C++ 半径滤波等算法贴数据零拷贝计算）。但产物绝对路径依环境而异：
 * - dev：项目根下 native/radius-filter/build/Release/radius_filter.node
 * - 打包后：electron-builder 的 asarUnpack 把 .node 释放到
 *   resources/app.asar.unpacked/（目录结构与 asar 内镜像），路径在此拼出。
 * 因此由主进程统一解析后经 IPC 下发（'native:get-module-path'）。
 */
export const nativeModulePlugin: AppPlugin = {
  name: 'native-module',
  initialize({ app, ipcMain }) {
    _ipcMain = ipcMain

    ipcMain.handle('native:get-module-path', (_event, name: unknown): NativeModulePathInfo => {
      if (typeof name !== 'string') {
        return { path: '', exists: false }
      }
      const relative = MODULE_RELATIVE_PATHS[name]
      if (!relative) {
        return { path: '', exists: false }
      }
      // dev：app.getAppPath() = 项目根；打包后：asarUnpack 释放目录镜像 asar 布局。
      //
      // 但 `electron dist-electron/main.js` 这种**直接指定入口脚本**的启动方式下，
      // app.getAppPath() 会解析成脚本所在目录（dist-electron/），拼出来的路径下
      // 压根没有 native/ ——e2e 测试正是这么启动应用的。因此 dev 下按序探测候选基目录，
      // 取第一个命中者；全不命中则回落到首选基目录，让调用方拿到一致的 exists:false。
      const bases = app.isPackaged
        ? [path.join(process.resourcesPath, 'app.asar.unpacked')]
        : [app.getAppPath(), process.cwd()]
      try {
        for (const base of bases) {
          const candidate = path.join(base, relative)
          if (existsSync(candidate)) return { path: candidate, exists: true }
        }
        return { path: path.join(bases[0], relative), exists: false }
      } catch {
        // existsSync 仅在权限异常等极端情况下抛错，一律按不存在处理
        return { path: path.join(bases[0], relative), exists: false }
      }
    })
  },
  destroy() {
    if (!_ipcMain) return
    _ipcMain.removeHandler('native:get-module-path')
    _ipcMain = undefined
  },
}
