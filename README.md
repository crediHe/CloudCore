# CloudCore

**Windows 桌面端点云（LAS / PLY）可视化与处理工具。**

机载 / 地面激光雷达扫回来的是「什么都混在一起」的三维点云：地面、植被、建筑、电线。CloudCore 把它变成能用的成果——地面点、单木清单、电力线、拟合模型、配准结果。渲染用 three.js，13 个计算密集型算法编译为 C++ N-API 原生模块，在渲染进程内与 three.js 顶点缓冲**同世界、零拷贝**计算。

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)
![Native modules: 13](https://img.shields.io/badge/C%2B%2B%20N--API-13%20modules-00599C.svg)

**中文** ｜ [English](./README.en.md)

<!--
  📷 主界面动图待录制（作者手动录制后替换）。
  建议内容：打开 LAS → 旋转视角 → 切 Elevation / Scalar field 着色，8~10 秒。
  录好后：把文件放到 docs/images/overview.gif，删掉本注释块并启用下面一行。

![CloudCore 主界面](docs/images/overview.gif)
-->

---

## 它能做什么

| 你要做的事               | CloudCore 的做法                                                  |
| ------------------------ | ----------------------------------------------------------------- |
| 打开几千万点的 LAS / PLY | 分块流式读取，不卡界面；大点云自动进入 LOD 流式渲染               |
| 去噪、抽稀               | 半径滤波 / 统计滤波 / 体素降采样                                  |
| 分出地面                 | CSF 地面识别（机载语义）/ CSF Pro（丘陵山区高精度，带进度与取消） |
| 数树、量树高胸径         | 单木分割 → 逐树拆出实体 → 树高 / 冠幅 / 胸径计算 + 3D 标记        |
| 分离粘连的物体           | 欧式聚类分割，逐簇着色预览                                        |
| 提取电力线               | 离地筛 → 逐点 PCA → 抛物线模型剥离 → 端点补全                     |
| 找平面 / 找圆柱          | RANSAC 平面 / 圆柱拟合，3D 里画线框核对                           |
| 对齐两片点云             | 点对粗配准（Horn）/ ICP / GICP，实时预估可达 RMS                  |
| 手动圈出一块地物         | 多边形 / 框选分割，拆成独立实体                                   |
| 量距离、量角度           | 单点信息 / 两点距离 / 三点角度                                    |
| 检查高程与分类           | 高程着色 + 分布直方图；分类着色（0–21 行业配色）                  |
| 交付成果                 | 另存为 PLY / LAS 1.2，Tree ID 随文件走                            |

## 快速开始

环境要求：**Windows** + Node.js + pnpm。

```bash
pnpm install
pnpm dev              # 开发模式（HMR）
```

> 13 个 C++ 原生模块的编译产物（`.node`）随仓库分发，克隆后**开箱即用**，不需要 C++ 编译环境。
> 只有改动了 `native/` 下的 C++ 源码，才需要本地重编（见「构建原生模块」）。

打包：

```bash
pnpm build:win        # vue-tsc + vite build + electron-builder（zip）
pnpm build:win:local  # 同上，nsis 安装包且不发布
```

## 功能细节

### 打开与浏览

- **LAS 1.2 / PLY 二进制**分块流式读取：先解析文件头，点按需进内存，大文件不必等整份加载完。
- **场景树**（项目 / 容器 / 实体三级）：拖拽整理、双击重命名、逐项显隐、`Ctrl` 加选、`Shift` 区间连选。
- **大点云 LOD 流式渲染**：显示量只取决于屏幕，与总点数无关（阈值自动判定，可逐实体覆盖）。
- 六向标准视角（`Ctrl+1..6`）、`Home` 缩放到全部、`F` 缩放到选中、透视 / 正交切换。
- 双击点云上任意一点，把它设为旋转中心。

### 处理算法（13 个 C++ N-API 原生模块）

工具菜单按四组排列，与右侧工具栏同一份状态：

| 分组         | 模块                 | 算法                                                                             | 对齐的上游                                                       |
| ------------ | -------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Filter       | `radius-filter`      | 半径滤波（邻居数不足则剔除离群点）                                               | PCL `RadiusOutlierRemoval`                                       |
| Filter       | `voxel-filter`       | 体素降采样（返回最接近体素质心的**原始点索引**，坐标永不重建）                   | PCL `VoxelGrid`                                                  |
| Filter       | `statistical-filter` | 统计滤波（kNN 均值距离超出 μ+λσ 者剔除）                                         | PCL `StatisticalOutlierRemoval`                                  |
| Segment      | `csf-lidar`          | 地面识别 · 机载语义（布料模拟，快）                                              | CloudCompare **qCSF**                                            |
| Segment      | `csf-pro`            | 地面识别 · 布料贴地语义（丘陵 / 山脉高精度，慢，支持进度与取消）                 | CSF 原始语义                                                     |
| Segment      | `treeiso`            | 单木分割（三段式图割）                                                           | **qTreeIso**（Xi & Hopkinson 2022）                              |
| Segment      | `euclidean-cluster`  | 欧式聚类分割（静态 KD 树 + 并行并查集）                                          | PCL `EuclideanClusterExtraction`                                 |
| Segment      | `powerline`          | 电力线（导线）提取：离地筛 → 逐点 PCA → 方向门限连通 → 抛物线模型剥离 → 端点补全 | **无上游对应物**（CloudCompare / PCL 都没有电力线提取）          |
| Fit          | `ransac-plane`       | RANSAC 平面拟合（两段式 + Jacobi 最小二乘精修）                                  | PCL `SACSegmentation`                                            |
| Fit          | `ransac-cylinder`    | RANSAC 圆柱拟合（自研轴方向估计：法向量量化码投票 × 各向异性比）                 | PCL `SACSegmentationFromNormals`                                 |
| Registration | `registration`       | 配准（Horn 四元数粗配准 + ICP + **GICP**）                                       | CCCoreLib `RegistrationTools` + qCC 对话框；GICP 按 PCL 语义自研 |
| —            | `normal-estimate`    | 法向量估计（最小二乘平面 / Quadric）+ 自动半径（Edit ▸ Normals）                 | CloudCompare `ccNormalVectors` / `GuessBestRadius`               |
| —            | `lod-octree`         | 为流式渲染建实体级 LOD 八叉树（非算法模态，渲染基础设施）                        | CloudCompare `ccPointCloudLOD`                                   |

> 与上游的**逐条差异**、以及每个参数为什么这么定，记录在各模块目录下的 `README-REF.md`（共 8 份）。

### 分割与编辑

- **多边形 / 框选分割**：在 3D 视图里圈出一块地物，直接拆成独立实体。
- **合并**（`Ctrl+M`）、删除（`Delete`，作用于选中集）。
- **按分类拆分**、**设置分类值**：场景树右键菜单，作用于 LAS 的分类属性。
- **分割产物自动编号**（属性面板的 Tree ID），逐株 / 逐簇着色；编号随「另存为」写进文件的 Point Source ID，在 CloudCompare 里能直接按它分色。

### 树木分析

- **单木分割**：逐树着色预览，调「最小点数」等参数时画面实时更新，确认后一次拆出一棵一棵。
- **Compute tree info**（Trees 菜单）：树高 / 冠幅 / 胸径——胸径用 1.3 m 切片 + 稳健圆拟合，拟合不可靠时明确报告「不给数」，不编造数字。
- **3D 标记**：树心点 / 冠层圈 / 胸径圈三档显示。
- Mark as tree（class 4 / 5），对选中集批量生效。

### 测量与检查

- **测量工具**：单点信息 / 两点距离 / 三点角度，3D 里拾取、浮动标签出数。
- **高程着色 + 分布直方图**：属性面板里直接看高程分布（只在切到 Elevation 时才计算，不花冤枉钱）。
- **分类着色**（Scalar field）：0–21 的行业配色表，表外分类确定性生成色兜底。

### 导出（File ▸ Save as…）

- **PLY 二进制**：坐标以 double 写出，大地坐标无损（1e6 量级的坐标落进 float32 会丢掉全部小数位）。
- **LAS 1.2 未压缩**、手写编解码，不依赖 LASzip。
- 只写内存里有的数据（坐标 / 颜色 / 分类 / Tree ID）；一次导出一个实体。

## 技术亮点

- **零拷贝的原生算法通道**：C++ 模块直接吃 three.js 的 `Float32Array` 顶点缓冲——同一块内存、同一个地址空间。常规的「点数据走 IPC → C++ 算 → 结果再走 IPC 回来」光序列化就吃掉全部收益；这里是**指针传递**。为此窗口安全配置有意全开（`nodeIntegration: true` + 关 `contextIsolation`）——**这是性能决策，代价是应用不加载任何不可信远程内容**。
- **13 个模块共用一套契约**：入参、错误语义、返回值口径（一律「顶点缓冲空间的下标」而非候选数组下标）全局统一，渲染侧只有一份薄薄的调用约定，13 个算法面板的代码形状完全同构。
- **LOD 流式渲染**：整云常驻内存，显存里只有当帧要画的那批点；拖拽自动降质、静止逐档加密，思路对齐 CloudCompare 的 `ccPointCloudLOD`，目标是 1 亿点与 100 万点的渲染开销相同。
- **手写 LAS / PLY 读写**：读（分块流式）与写（逐批编码 + 头部回填包围盒）严格对称，零外部依赖。
- **算法有出处、差异有记录**：每个模块对齐哪个上游（CloudCompare / PCL / qTreeIso / CSF）、哪里刻意不同、为什么，逐条记在各模块的 `README-REF.md` 里（共 8 份）。

## 架构

```
src/
├── main/           主进程：插件 + 核心管理器
│   ├── core/       WindowManager / PluginRegistry / StoreManager / LasManager /
│   │               PlyManager / PointCloudSaveManager / RobustnessManager …
│   └── plugins/    每个插件只做装配，实现在 core/*Manager.ts
├── preload/        预加载：向页面主世界直挂 window.electronAPI / electronEvents
├── renderer/       Vue 3 渲染进程
│   ├── stores/     手写状态管理（无 Pinia / 无 vue-router / 无事件总线）
│   ├── three/      引擎、LOD 显示层 / 遍历 / 调度 / 建树、各类 3D 覆盖物
│   ├── composables/ 交互（分割、测量、旋转中心、算法模态互斥表）
│   ├── components/ 场景树、属性面板、工具栏、对话框
│   └── utils/      纯函数层：颜色空间、选择数学、各原生模块的**契约镜像**
└── shared/         主进程与渲染进程共享的类型与工具

native/             13 个 C++ N-API 模块（node-gyp 构建，产物经 asarUnpack 释放）
tests/
├── unit/           Vitest：算法契约 + 与 JS 暴力参考对照
└── e2e/            Playwright：启动真实构建产物，驱动真实 UI
```

三条值得一提的架构决策：

1. **大数组与 three 对象绝不进响应式系统**（`Uint32Array`、`BufferGeometry` 放在模块级 Map 里）——Vue 的深层代理会把渲染拖垮。
2. **算法产物与源实体共享同一份顶点缓冲**，可见子集由 `geometry.index` 圈定；预览 = 改索引或改颜色（瞬时、零拷贝），确认 = 求补集、拆实体。
3. **主进程是插件化的**：`PluginRegistry` 只管生命周期，每个插件只做装配，实现在对应 `*Manager` 单例里；销毁按注册顺序倒序，且日志、崩溃防护两个插件必须最先注册。

## 构建原生模块（改 C++ 时才需要）

需要 **Visual Studio（「使用 C++ 的桌面开发」工作负载）+ 系统 Python**（node-gyp 依赖）：

```bash
pnpm build:native     # 13 个模块全量重编，无增量
```

> node-gyp 靠 `vswhere.exe` 定位 VS 实例。若普通终端报「找不到 Visual Studio」，先把
> `C:\Program Files (x86)\Microsoft Visual Studio\Installer` 加进 `PATH`。

## 测试

```bash
pnpm test:unit        # Vitest 单元测试
pnpm lint             # ESLint（刻意宽松：只查真错误，不查格式）
```

- **单元测试是这套算法的第二份说明书**：每个原生模块的契约测试拿「JS 暴力参考实现」做逐位对照，`registration` 等模块还钉住确定性、分块不变性与线程无关性。没有 C++ 编译链的机器上，依赖原生产物的测试组**自动整组跳过**。
- **e2e**（Playwright）启动真实构建产物、走与用户点击完全相同的入口。Electron 主进程有单实例锁，e2e 必须串行（`playwright.config.ts` 已固定 `workers: 1`），改主进程代码后需先 `pnpm build:test`。

## 已知限制

- **仅 Windows**。部分实现（窗口控制、托盘、打包配置）与平台强绑定。
- **本仓库不含示例点云数据**。请自行准备 `.las` / `.ply` 文件；测试使用的都是运行时生成的合成数据。
- **合并实体不保留法向量**：各来源法向量可能互相矛盾，合并后需要重算一次。这是有意为之，不是缺陷。
- **窗口安全配置已让位性能**（见「技术亮点」），因此**本应用不得加载不可信远程内容**。
- LAS 只支持 1.2 未压缩（不含 LAZ），分类值上限 31（LAS 1.2 的分类只有低 5 位；PLY 的分类是完整 u8、无损）。

## 许可

[GPL-3.0](./LICENSE) © 2026 何星驰

本项目**仅供学习与交流**，不用于商业用途。其中 `csf-lidar` / `csf-pro` / `treeiso` / `euclidean-cluster` /
`ransac-plane` / `ransac-cylinder` / `normal-estimate` / `registration` 等模块在算法语义上对齐 CloudCompare
（GPL）、CSF、qTreeIso、PCL（BSD-3-Clause）等上游实现，差异逐条记录在各自的 `README-REF.md` 中。整体以
GPL-3.0 发布正是为了与这些上游保持许可兼容。
