# CloudCore

**Windows 桌面端点云（LAS / PLY）可视化与处理工具。**

机载与地面手持激光雷达扫回来的数据，是一份「什么都混在一起」的三维点云：地面、植被、建筑、电线、管道。CloudCore 把原始文件变成能交付的成果——地面点、逐木清单、电力线、拟合出的平面与圆柱、配准好的两片云。

渲染交给 three.js；计算下沉到 **13 个 C++ N-API 原生模块**（12 个算法 + 1 个 LOD 渲染基础设施）。它们在渲染进程内直接读写 three.js 的顶点缓冲，同地址空间、零拷贝——没有 IPC，也没有序列化。

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)
![Native modules: 13](https://img.shields.io/badge/C%2B%2B%20N--API-13%20modules-00599C.svg)

**中文** ｜ [English](./README.en.md)

---

**核心算法（C++ N-API 原生模块）**

- 地面分割 `csf-lidar`：CSF 布料模拟地面识别，机载语义（快）
- 精准地面分割 `csf-pro`：布料贴地语义，丘陵 / 山脉高精度，带进度与取消
- 单木识别 / 单木分割 `treeiso`：三段式图割，逐棵树拆成独立实体并挂进树项容器
- 欧式聚类分割 `euclidean-cluster`：静态 KD 树 + 并行并查集，按距离切开粘连的物体
- 电力线提取 `powerline`：离地筛 → 逐点 PCA → 方向门限连通 → 抛物线模型剥离 → 端点补全
- 半径滤波 `radius-filter` / 统计滤波 `statistical-filter` / 体素降采样 `voxel-filter`
- RANSAC 平面拟合 `ransac-plane`：找出占比最大的平面，3D 线框核对，可连续剥离
- RANSAC 圆柱拟合 `ransac-cylinder`：管道 / 杆件 / 树干，轴方向可自动估计或指定
- 配准 `registration`：点对粗配准（Horn 四元数，≥ 3 对同名点）/ ICP 精配准 / GICP 面到面精配准

---

**CSF 地面分割**

![CSF 地面分割](./gif/csf-ground-segmentation.gif)

**单木分割**

![单木分割](./gif/treeiso-individual-tree-segmentation.gif)

## 快速开始

环境：**Windows** + Node.js + pnpm（仓库在 `package.json` 的 `packageManager` 里锁定 `pnpm@11.9.0`，corepack 会自动取用该版本）。

```bash
pnpm install
pnpm dev              # 开发模式（HMR）
```

> 13 个原生模块的编译产物（`native/*/build/Release/*.node`）**已随仓库提交**，克隆后开箱即用，
> 不需要 C++ 编译环境。只有改动了 `native/` 下的 C++ 源码，才需要本地重编。

打包：

```bash
pnpm build:win        # vue-tsc + vite build + electron-builder（zip）
pnpm build:win:local  # 同上，产出 NSIS 安装包且不发布
pnpm build:test       # 只做类型检查 + Vite 构建（供 e2e 使用，不打包）
```

## 许可

部分算法参考了 CC 与 PCL 的公开语义。
