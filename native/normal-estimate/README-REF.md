# normal-estimate：算法出处与语义说明

本模块的 C++ 算法（`src/normal_estimate.cc` / `src/normal_compressor.cc`）是
**CloudCompare 法向量子系统语义的移植实现**，对齐三处上游：

| 上游 | 文件 | 本模块对应 |
| --- | --- | --- |
| `ccNormalVectors::ComputeCloudNormals` | `libs/qCC_db/src/ccNormalVectors.cpp:254` | `estimateEntity()` 的逐点邻域 + 局部模型拟合 |
| `ccOctree::GuessBestRadius` / `GuessNaiveRadius` | `libs/qCC_db/src/ccOctree.cpp:745-946` | `guessRadius()` |
| `ccNormalCompressor` | `libs/qCC_db/src/ccNormalCompressor.cpp:26-221` | `normal_compressor.cc` 的逐行移植 |

`Neighbourhood::getQuadric` / `getLSPlane`（CCCoreLib）**未逐行移植**——CCCoreLib 是
CloudCompare 仓库的 git 子模块（`libs/qCC_db/extern/CCCoreLib`），本机未检出，拿不到源码。
故 LS / Quadric 按**标准数学语义**独立写出（见下「局部模型」一节），不复制未见的实现文本。

## 参考出处

- CloudCompare 源码（本机快照 `D:\dev\点云\CloudCompare-master`，v2.14.beta 时代 master）：
  - `libs/qCC_db/src/ccNormalVectors.{h,cpp}` —— `Orientation` 枚举、`ComputeCloudNormals`、
    `UpdateNormalOrientations`、LS / Quadric 拟合入口与「邻域点数不足时半径放大」循环。
  - `libs/qCC_db/src/ccOctree.cpp` —— `GuessNaiveRadius`（朴素半径）、`GuessBestRadius`（自动半径采样）。
  - `libs/qCC_db/src/ccNormalCompressor.{h,cpp}` —— 定点量化编解码。
  - `libs/qCC_db/src/ccGLSLHelper.cpp:235-266` —— 漫反射光照（**未移植**，见下「我们不做视相关着色」）。
- CloudCompare 许可证：GPL / LGPL 混合（qCC_db 为 GPL v2+，CCCoreLib 为 LGPL v2+）。
  本目录代码按**算法语义**重写、未复制源码文本；位级编解码（`ccNormalCompressor.cc`）因必须逐位对齐
  而属**逐行移植**，若将来本仓库的许可策略与 GPL 冲突，这一份是唯一需要重新评估的文件。

## 契约（与其余 7 个模块的差异）

1. **两个导出**：`computeNormals` 与 `guessRadius`。其余模块只有一个 `compute`。
   Auto 半径是独立交互（对话框按钮），不必与估计同批调用。
2. **`codes` 是「每候选一个值」的并行数组**：`codes[c][k]` 对应第 c 块第 k 个**候选点**，
   长度 = `index ? indexCount : vertexCount`。其余算法模块回传的是「顶点缓冲空间」的子集
   （顶点下标数组）。候选语义与入参严格一一对应，渲染侧用
   `src/renderer/utils/normalEstimate.ts#scatterNormalCodes` 摊成顶点缓冲空间。
   （`lod-octree` 的「整实体一次吃下」是本仓库第一处契约偏离，本模块是第三处。）
3. **结果含统计量**：`computed` / `nullCount` / `capped`，供渲染侧写可诊断日志。

## 与上游（CloudCompare）的差异清单

| 项 | CloudCompare | 本实现 | 理由 |
| --- | --- | --- | --- |
| 量化位宽 | `QUANTIZE_LEVEL = 9`（4 字节码，`unsigned int`，LUT 2097153 项 ≈ 24 MB） | `QUANTIZE_LEVEL = 6`（2 字节码，`uint16`，LUT 32769 项 ≈ 393 KB） | 按用户决策。这是 CC **旧版**格式（`dataVersion < 41` 时代）。内存 2 B/点 vs 4 B/点，量化角误差约 0.8° 量级（远小于点间距带来的拟合误差） |
| 编解码算术 | `PointCoordinateType` = **float** | 全程 **double** | 同一法向量算出的码**可能与 CC 不同**（只在量化边界附近有分歧）；但解码方向误差远小于量化步长本身。仓库其余 native 模块也用 double，保持一致 |
| 邻居搜索 | 八叉树 + `findBestLevelForAGivenNeighbourhoodSizeExtraction` 定层 | 均匀哈希网格（格边长 = 基准半径，按 `ceil(r/格边长)` 扩格数扫） | 仓库既有惯例（`radius-filter` / `statistical-filter` 同套网格）。**球查询是精确的**（逐点 `d² ≤ r²`），网格只是取邻居的手段，与八叉树的查询结果一致；差异只在性能特征 |
| 半径放大重扫 | 每次放大后**重新球查询** | 同左（`collectSphere` 每次清空并全量重扫） | 必须如此。曾考虑「只扫新增外壳」的增量优化，**那是错的**：半径变大后，已扫格内的点其距离可能落进新半径，只扫外壳会漏点 |
| 自动半径随机源 | `std::random_device` 播种（**每次结果不同、不可复现**） | 固定种子 mulberry32（`kRandomSeed = 20260911u`，与 `ransac-plane` 同款） | **刻意的**：同一片云每次得到同一个半径，可测试、可复现。这不是 bug |
| 采样取点 | `uniform_int_distribution` | `nextU32() % n` | 与 `ransac-plane` 的 JS 镜像保持同构（`Math.imul` 可逐位复现），便于单测对照。模偏差在 n ≪ 2³² 时可忽略 |
| 定向基准点 | 实体**全量点**的重心 | 实体**候选点**的重心 | 与仓库其余模块的候选语义一致（框选后只对可见点集定向）。框选场景下两者不同，属**已知偏差** |
| `PLUS_ORIGIN` / `MINUS_ORIGIN` | 世界坐标原点（= 原始坐标） | **显示坐标**原点（= 原始坐标 − `basePoint`） | 入参 positions 是显示坐标（与 `ransac-plane` 的 `plane` 同一口径）。法向量本身**平移不变**，只有这两个以原点为参考的定向方式受影响 |
| 局部模型 | LS / Quadric / **TRI**（邻域 Delaunay 三角化） | LS / Quadric | 按用户决策。TRI 需要 2.5D Delaunay，本仓库无此基础设施 |
| 定向方式 | 优选方向 13 项 + MST + knn + 传感器 | 优选方向 11 项中的 9 项（`PREVIOUS` / `*_SENSOR_ORIGIN` 不支持） | 按用户决策。`PREVIOUS` 依赖「上一轮法向量」、`*_SENSOR_ORIGIN` 依赖「关联传感器」，二者在我们的数据模型里都不存在；传进来按 `UNDEFINED` 处理 |
| 进度与取消 | 有（`ccNormalComputationDlg` 进度条 + 取消按钮） | **无** | 按用户决策（同 `radius-filter`）。耗时由 `consoleStore` 日志给出 |
| 着色 | 视相关漫反射光照（背面发黑，绘制期） + 独立的 `Convert to > Colors`（烘进 RGB、不可撤销） | **静态烘焙的 `ColorMode = 'normal'`**（视无关、非破坏性） | 见下节 |

### `near-ceiling` 数量：`capped`

半径放大以 `2^(1/4)` 递增、上限 16 倍（与 CC 一致）。对半径明显偏小的大云，
每个点最多要做 `16³(×2)+1` 次格子哈希查找——这是与 CC 同构的性能悬崖。
`capped` 统计「放大到 16 倍仍不足」的点数（`nullCount` 的子集），渲染侧据此在日志里提示
「半径对该云偏小」。这不是 bug，是算法的固有行为。

## 我们不做视相关的「黑背面」（重要口径差异）

CC 的「背面发黑」**不改任何 RGB**，是**绘制期**的普通漫反射光照副产物：

- 太阳光 `GL_LIGHT0` 方向恰好与视线轴重合；
- 默认环境光与自发光都是**黑色**、材质环境/漫反射色是白色；
- 片元着色 `gl_FragColor = vColor * (sceneColor + Iamb + Idiff + Ispec)`，
  眼空间法向量 z ≤ 0 时三个项全为 0 ⇒ `gl_FragColor = 0`（纯黑）。

即：触发条件是**「法向量 · 光源方向 < 0」**（只是默认光源方向与视线重合才看起来像背面），
且它是**乘性**的——正面的点也被压暗，不是恒等。

本模块**不实现**该效果。渲染侧走的是 `ColorMode = 'normal'` 的**静态烘焙**：
`RGB = (N+1)/2`（即 CC 的 `Convert to > Colors` 语义，视无关）。收益：

1. 固定图例判读朝向比「黑不黑」更准，且不随相机变化；
2. 天然嵌进仓库既有着色体系（`ColorMode` → 颜色 attribute → LOD 暂存层直接拷字节），
   `lodRenderer.ts` 一行不用改；
3. **非破坏性**——CC 的 `Convert to Colors` 会覆盖 `m_rgbaColors` 且不可撤销，
   我们做成 `ColorMode` 的一个取值，可随时切回原色。

## 局部模型

- **LS**（`LOCAL_MODEL_LS`）：邻域协方差矩阵 → 对称 3×3 Jacobi 特征分解 → **最小特征值**对应的
  特征向量。标准主成分平面拟合。
- **QUADRIC**（`LOCAL_MODEL_QUADRIC`）：由 LS 平面建局部坐标系 → 拟合高度函数
  `z = h0 + h1·u + h2·v + h3·u² + h4·uv + h5·v²`（6 个未知数，法方程 6×6）→
  法向量 = 曲面在查询点处的**梯度** `(h1 + 2h3·u + h4·v, h2 + 2h5·v + h4·u, −1)`，
  旋回全局后归一化。
  - 局部坐标按**面内最大跨度** `scale` 归一化后再解方程（梯度对 scale 不变），
    否则 `u²` 项与常数项量级悬殊、法方程条件数极差。
  - 6×6 用带**部分主元**的高斯消元（GEPP），相对主元阈值 `1e-12 × maxAbs` 判病态。
    病态 ⇒ 该点写 `NULL_NORM_CODE`（**不退化成 LS**：曲面拟合失败说明邻域几何不支持该模型，
    静默降级会让用户以为 Quadric 生效了）。
- 两者都**不含符号约定**（法向量 ± 任意），符号只由定向环节决定——与 CC 一致。
- 最少点数（**含查询点自身**）：LS ≥ 3、Quadric ≥ 6。常量硬编码，无 UI 参数——同 CC
  （`ccNormalVectors.cpp:40-45`）。

## 确定性设计（改代码时别破坏）

1. **逐候选点独立**：邻居搜索只看几何，不看处理顺序；结果与线程划分**严格无关**。
   并行分区让每个线程写**不相交**的 `(chunk, local)` 索引，无归约、无竞态。
2. 自动半径用**固定种子** mulberry32，采样点在候选全集上均匀取。
3. 全部中间量（协方差、特征分解、法方程、统计量）用 **double**；只有最终入 V8 的
   `Uint16Array` 是整数。

于是「同输入同参数 → 逐位相同的输出」。这不是洁癖：单测的确定性断言、以及「分块不变性」
（同一批点按不同块边界切分 → 逐点码相同）都依赖它。

## 与仓库其余原生模块的关系

- 输入契约（`positions` + 可选 `index`、`Napi::Reference` 零拷贝 pin、`AsyncWorker` +
  内部硬件线程）与其余算法模块**同模板**，可直接参考 `native/radius-filter/src/addon.cc`。
- 网格原语（`CellKey` / `CellKeyHash` / `encodeCandidate` / `candidateXyz`）从
  `native/radius-filter/src/radius_filter.cc:12-64` **复制一份**——模块间无共享库，这是仓库惯例。
- 结果一律 `memcpy` 进 V8 分配的内存。**不要**用 `napi_create_external_arraybuffer`：
  Electron 渲染进程的 V8 带 sandbox 会抛 `External buffers are not allowed`，
  且异常被 node-addon-api 转成未捕获 JS 异常，JS 回调**永久不触发**（见 `native/lod-octree` 的同类注释）。
