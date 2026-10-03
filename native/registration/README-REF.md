# registration：算法出处与语义说明

本模块（`src/registration.cc` / `.h` / `src/addon.cc`）覆盖三种配准：

- **点对粗配准**（`Tools ▸ Registration ▸ Align (point pairs picking)`）——
  `CCCoreLib::HornRegistrationTools::FindAbsoluteOrientation`（等价于 `RegistrationProcedure`）。
- **ICP 精配准**（`Tools ▸ Registration ▸ Fine registration (ICP)`）——
  `CCCoreLib::ICPRegistrationTools::Register`（Besl & McKay 1992）。
- **GICP 精配准**（`Tools ▸ Registration ▸ Fine registration (GICP)`）——
  **不是** CC 的移植（CC 没有 GICP）：移植的是 PCL `GeneralizedIterativeClosestPoint`
  （Segal/Haehnel/Thrun, RSS 2009），只复用了本模块自己的 ICP 主循环骨架，
  详见下面「GICP」一节。

一个模块三个导出（同 `normal-estimate` 的先例）：三者共用 Jacobi 特征分解、
`RegistrationProcedure`、`FilterTransformation`、`ComputeRMS` 与 KD 树，
拆成多个模块等于把这份代码抄几遍。

## 参考出处

本机 CCCoreLib 快照（用户手动下载，**改算法前直接读它，不要联网找**）
`C:\Users\17316\Documents\讯卓科技\CloudCompare-master\`：

| 上游文件                              | 位置                | 本模块对应                                                    |
| ------------------------------------- | ------------------- | ------------------------------------------------------------- |
| `CCCoreLib/src/RegistrationTools.cpp` | `FilterTransformation`(L28)  | `filterTransformation()`                                      |
| 同上                                  | `ICPRegistrationTools::Register`(L147) | `icp()`                                              |
| 同上                                  | `ComputeRMS`(L1005) | `computeRMS()`                                                |
| 同上                                  | `RegistrationProcedure`(L1036，含 3 点特例 L1062-1203) | `registrationProcedure()`（匿名命名空间内） |
| `CCCoreLib/include/Jacobi.h`          | `ComputeEigenValuesAndVectors`(L83) / `GetMaxEigenValueAndVector`(L325) | `jacobiEigenValuesAndVectors<N>()` / `getMaxEigenValueAndVector<N>()` |
| `CCCoreLib/include/SquareMatrix.h`    | `initFromQuaternion`(L549) / `operator*`(L205) / `apply`(L314) | `fromQuaternion()` / `matrixMul()` / `matrixApply()` |
| `CCCoreLib/include/RegistrationTools.h` | 枚举 `TRANSFORMATION_FILTERS` / `CONVERGENCE_TYPE` / `RESULT_TYPE` 与 `Parameters` 默认值(L159) | `SKIP_*` 常量 / `IcpResultCode` / `IcpParams` |
| `CCCoreLib/src/GeometricalAnalysisTools.cpp` | `ComputeGravityCenter`(L533) / `ComputeCrossCovarianceMatrix`(L629) | `gravityCenter()` / `crossCovariance()` |
| `CCCoreLib/src/NormalDistribution.cpp` | `computeParameters`(L85) | `distanceDistribution()`（μ+2.5σ 用的分布） |
| `CCCoreLib/src/CloudSamplingTools.cpp` | `subsampleCloudRandomly`(L182) | `collectSamples()`（蓄水池抽样，见差异表） |
| `qCC/ccPointPairRegistrationDlg.cpp`  | `onItemPicked`(L578) / `callRegistration`(L1324) / `align`(L1569) / `reset`(L1659) / `apply`(L1690) | 渲染侧 `alignStore` + `useAlignInteraction` |
| `qCC/ccRegistrationDlg.cpp`(L36-160)   | ICP 对话框的半持久化默认值 | `IcpToolBar.vue` 的初值 |
| `doc/点云处理GICP 点云配准/`（PCL 教程）  | 全文（只有文章、无 C++） | `gicp()`（**CC 没有 GICP**，按文章语义自研，见「GICP」一节） |

变换约定：**`P' = s·(R·P) + T`**（`PointProjectionTools::Transformation::apply`）。
`R` 是 3×3 **行主序**，对点**左乘**（不是转置版）。`Transform::rValid == false` 表示 R 未初始化，
此时 apply 按**单位矩阵**处理——对应上游 `SquareMatrix::isValid()` 为假时 `operator*` 直接返回原向量。

## 许可证说明

CloudCompare / CCCoreLib 以 **GPLv2** 分发。本目录代码是对上述函数体的**逐行移植**（同样的公式、
同样的判据、同样的分支顺序），按 GPLv2 的传染性，**本仓库若对外分发需要一并满足 GPLv2**——
这一点与仓库内借语义自研的模块（euclidean-cluster 等）不同，请勿当成"自研算法"看待。

## 与上游的差异清单

| 项                    | CloudCompare / CCCoreLib                                                                       | 本实现                                                                                                       | 理由                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **坐标精度**          | `PointCoordinateType` = **float**（每轮迭代在 float 缓冲上叠加 `currentTrans`）                 | 全程 **double**（采样时就转 double，迭代恒在 double 上算）                                                    | float 逐轮叠加会累积误差（20 轮、1 km 尺度的云上肉眼可见）；double 的代价（≤5 万点 × 24 B = 1.2 MB）可忽略。**语义不变，只有精度更高**    |
| **随机降采样**        | `std::random_device` 播种的 `std::shuffle`/`swap`（**同参数两次结果不同**）                      | 固定种子（`IcpParams::seed`，缺省 0 = 固定值）的 xorshift64\* 蓄水池抽样                                      | ① 上游那种"每次都不一样"让单测无法断言"确定性/分块不变性"；② 用户看到的结果必须能复现。分布相同（不放回均匀子集），只是**具体哪些点**不同   |
| **采样内存**          | 建全量下标数组（`std::vector<unsigned>`，n 个），再随机删到上限                                | 单遍蓄水池（Algorithm R），只存 ≤ `samplingLimit` 个 `Vec3d` + 一个计数器                                     | 1 亿点的云要 400 MB 只为了"随机挑 5 万个点"；蓄水池是 O(limit) 内存、单遍、同分布                                                          |
| **变换缓存**          | `currentTrans` 缓存在 `RegistrationTools::Parameters` 里（跨调用复用，`GetTransformation` 取出）| 每轮局部 `Transform`，一并返回给调用方                                                                        | 上游那套缓存是给对话框"上次解算结果"用的；我们的调用方是渲染侧 store，本来就要拿返回值                                                    |
| **停止判据**          | `convType` 二选一：`MAX_ERROR_CONVERGENCE` 只看 `minRMSDecrease`（**可以无限迭代**）或 `MAX_ITERATION_CONVERGENCE` 只看 `maxIterations` | 取**并集**：`deltaRMS < minRMSDecrease` **或** `iteration >= maxIterations` 任一满足即停                      | 本仓库的模态是"点一下必须出结果"，不能让面板卡住；两个默认值下（1e-5 / 20）上游本来也是先撞到其中一个。副作用：迭代次数可以精确对齐面板输入 |
| **点集表示**          | `DataCloud { cloud, rotatedCloud, CPSetRef/CPSetPlain, ... }`：`ReferenceCloud` 换装、`PointCloud` 单独持有、`Garbage` 回收 | 三张并行 `std::vector`（点 / 最近点 / 距离），`ReferenceCloud` 恒等索引那一层直接省掉                          | 上游那套是为了"不复制顶点、只搬下标"；我们的 data 集合每轮都会变形（过滤 + 旋转），向量表示更简单且**行为等价**（见「等价改写」一节）      |
| **法向量匹配**        | `NORMALS_MATCHING`（用两边法向量夹角的 1−\|cos\| 当额外距离项，需模型带法向量 + `modelWeights`） | **不做**                                                                                                     | 用户已确认首版不做（需要"两片云都有靠谱法向量"这个前置条件，而法向量来源是 `Edit ▸ Normals` 的可选步骤）                                   |
| **mesh 目标**         | `Register` 能吃 `GenericMesh`（对三角面片算距离）                                              | 只支持点云对点云                                                                                             | 本仓库没有 mesh 实体                                                                                                                     |
| **多线程距离计算**    | `maxThreadCount` 分段并行最近邻                                                                 | 单线程                                                                                                       | ≤5 万次最近邻查询在静态 KD 树上 10 ms 量级，起线程的开销盖过收益                                                                          |
| **qCC 层网格预选**    | `ccRegistrationTools::ComputeRegistrationError` 先用网格估重叠度、再据此建议 `finalOverlapRatio` | 不做（面板让用户直接填）                                                                                     | 那是"帮用户猜参数"的 UI 辅助，不是算法本体                                                                                                 |
| **权重通道**          | `dataWeights` / `modelWeights`（逐点权重，RMS 与协方差都加权）                                  | 不做（`wi ≡ 1`，加权式退化成普通式）                                                                          | 渲染侧没有权重通道；`buildIndexedGeometry` 的属性白名单里也没有这种数据                                                                   |
| **取消**              | `ICP_ERROR_CANCELED_BY_USER`（对话框有 Cancel 按钮，逐轮检查）                                  | 不实现（枚举值保留但永不返回）                                                                                | 单次调用是毫秒级，没有可取消的窗口（对比：`csf-pro` 是秒级才需要 cancel）                                                                  |
| **单个坏块的容错**    | 无（`assert` + 未定义行为）                                                                     | `index` 越界 / 点数不足 / `finalOverlapRatio` 越界 → 干净返回 `ICP_ERROR_INVALID_INPUT`                       | 契约防御（其余 11 个模块同一惯例）：渲染侧的 `setEntity...` 有一层长度校验，但 native 不该读越界内存                                       |

## 七处必须照抄的细节（写错任意一处都会**静默**给出错误的变换）

1. **采样上限不是同一个数**：`dataSamplingLimit = finalOverlapRatio != 1.0 ? samplingLimit / finalOverlapRatio : samplingLimit`；
   model 恒为 `samplingLimit`。重叠度过滤每轮会**永久收缩** data 集合，所以要在池子里多放点，
   保证收缩后仍有 `samplingLimit` 个点参与。
2. **模型 KD 树只建一次**（模型不动），data 每轮重算最近邻。建树是把 `euclidean-cluster` 的
   `KdTree` 复制过来的（最长轴中点分裂 / 叶 16 点 / 扁平节点表），查询换成最近邻：
   先探近侧，再按 `d² < best²` 回溯远侧。
3. **重叠度阈值取自排序后的第 `maxOverlapCount − 1` 个距离**（`overlapDistances` 排序后取下标），
   只保留 `距离 ≤ 阈值` 的点 ⇒ **等于阈值的可能多于 `maxOverlapCount` 个，全部保留**（不是"恰好 ratio 比例"）。
   本实现用 `nth_element` 取同一位置的**值**（上游是全排序，两者在"第 k 小"这个位置上完全一致）。
4. **剔除最远点在每轮的开头、且在 RMS 块之前**（上游 L421-532）。判据是 μ+2.5σ，
   μ/σ 由 `NormalDistribution` 从**距离数组**估出，σ 用的是 `|E[v²] − μ²|` 这条捷径（含 abs）。
   ⚠ 本实现与上游有一处**更合理的偏差**：上游这里新建的 `ReferenceCloud` **没有距离标量场**，
   而紧接着的重叠度过滤会去读它 —— 也就是「剔除最远点 + 最终重叠度 < 1」同时开启时，
   上游读的是**未初始化的内存**。我们把保留点各自的旧距离留着（等价于"只走重叠度通路"），
   行为确定且可复现。
5. **RMS 是 `sqrt(Σd² / n)`**，`n` = 当轮（过滤后）的 data 点数；`iteration == 0` 时若 `rms < ε`
   （`ZERO_TOLERANCE_D` = float epsilon，**不是** double epsilon）⇒ `ICP_NOTHING_TO_DO`。
6. **⚠ 迭代顺序陷阱 —— 照抄顺序，别自己重排**：RMS 块在 `computeTrans` **之前**，所以
   `transform` 里累积的是**上一轮**解出的 `currentTrans`。顺序是：
   `currentTrans.R·transform.R` → `transform.T = currentTrans.R·transform.T` → 按
   `newScale/transform.s` 缩放 T → `transform.T += currentTrans.T`。`iteration == 0` 那一轮
   **不累积**（此时 `transform` 还是"不动"）。`rms > lastStepRMS` 时立刻 break，于是返回的是
   **上一轮那个还没并进本轮增量**的最优变换 —— 这正是 `iteration == 1 ? ICP_NOTHING_TO_DO :
   ICP_APPLY_TRANSFO` 的来历。重排后结果会差一步，而且**看起来也能收敛**（RMS 照样下降），
   只有拿合成变换做断言才会露馅。
7. **退化输入不许崩**：`registrationProcedure` 在"参考点集的包围盒缩成一个点"时返回
   **true + R 无效 + T = Gx − Gp**（不只是平移，而是"能算的都算了"）。上游靠
   `SquareMatrix::isValid()` 为假时 `operator*` 返回原向量来兜；本实现对 `!rValid` 的 R
   按单位矩阵处理，语义一致。**JS 面的 `r` 在 `rValid == false` 时发单位矩阵**（不发零矩阵——
   零矩阵经 `Matrix4` 作用会把整片云压到原点）。

## 等价改写：为什么没有 `rotatedCloud` / CPSet 那套对象生命周期

上游把"当轮要算的点"包成几种对象来回换装（`data.cloud` 指向当前子集、
`data.rotatedCloud` 是旋转后的缓冲、`CPSetPlain` 装最近点、`ReferenceCloud` 的候选下标表示子集）。
本实现用三张并行数组（`dataPts` / `dataCp` / `dataDist`）表达同一件事，因为：

- `ReferenceCloud` 的"候选下标"层在**算法内部**是恒等映射（子集就是数组本身），省掉不影响语义；
- 上游"重建旋转云"与"原地旋转旧旋转云"两条分支，对**当前 data 集合**的效果完全相同 ——
  都是 `各点 = currentTrans.apply(旧位置)`：
  - 重建分支（L908-943 的第一条）：`new_rotated[i] = currentTrans.apply(data.cloud[i])`，
    而 `data.cloud[i]` 已经是上一轮旋转后的位置 ⇒ 累计变换作用一次；
  - 原地分支：`rotatedCloud[j] = currentTrans.apply(rotatedCloud[j])`，**包括被过滤掉的点**
    （它们不在 `data.cloud` 里，但仍在缓冲里）⇒ 对子集而言同样是一次作用。
  所以本实现直接一个循环，顺带消掉了上游"原地 apply 在 float 上反复叠加"的精度损失
  （我们恒按 double 现值算）。

**验证点**：单测里的「分块不变性」用例（同一片云按 1/3/7 块切开，结果逐位相等）就是为了钉住
"这套改写没有引入块边界依赖"（KD 树建在采样点上、采样只依赖候选总数与种子）。

## GICP（第三个导出）：出处与差异

**出处**：`doc/点云处理GICP 点云配准/`（迅卓科技的 PCL 教程，只有文章无 C++）+ Segal / Haehnel / Thrun,
*Generalized-ICP* (RSS 2009)。**CloudCompare 没有 GICP**，故这一节不是"移植差异"，而是"按文章语义自研、
复用本模块 ICP 骨架"的差异。

式子（与本文件其余部分同一套约定 `P' = R·P + T`，**刚体**、无缩放）：

```
① 逐点协方差  C = (1/(k-1))·Σ(pᵢ−p̄)(pᵢ−p̄)ᵀ，k = correspondenceRandomness（默认 20，PCL setCorrespondenceRandomness）
② 平面化      C = Σ ⱼ λ'ⱼ vⱼvⱼᵀ，λ' 按特征值升序替换为 (ε, 1, 1)，ε = 1e-3 ⇒ 法向权重 1000 倍（面到面）
③ 对应        dᵢ = 最近邻（**欧氏**，KD 树）
④ 目标        min Σ dᵢᵀ Ωᵢ dᵢ，Ωᵢ = (C_target + R·C_data·Rᵀ)⁻¹   ← 源点协方差随 R 一起转
⑤ 线性化      R ≈ I + [ω]×（在 data 当前帧的**重心**处展开）⇒ 6×6 对称系统 → Jacobi 伪逆 → R_inc、T_inc
⑥ 迭代/收敛   采样、剔除最远点、重叠度裁剪、RMS 判据全部照抄本模块的 ICP（同一份代码形状）
```

| 项                | PCL `GeneralizedIterativeClosestPoint`                                     | 本实现                                                                                     | 理由                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **参数面**        | `setMaximumIterations` / `setMaximumOptimizerIterations` / `setMaxCorrespondenceDistance` / `setTransformationEpsilon` / `setRotationEpsilon` / `setEuclideanFitnessEpsilon` | 面板与 `IcpParams` **逐字同款**（最大迭代 / RMS 变化阈值 / 采样上限 / 重叠度 / 剔除最远点 / 变换过滤器）+ 两个 GICP 专属项               | 模态是"在 ICP 旁边多一个入口"，参数长得一样才不用重新学；且采样/过滤/重叠度这些**本来就是配准的通路**，不是 GICP 的发明                  |
| **内部优化器**    | 每轮变换估计跑一个最多 `MaximumOptimizerIterations` 次的内部优化（含步长回退） | 每轮**只解一次** 6×6 系统（Gauss-Newton 一步），收敛靠外层循环                               | 本模块没有 LM/线搜索的实现，硬塞一个等于再移植一套；实测小位姿差下 3~5 轮外层就收敛（见单测的 `iterations`）                            |
| **最大对应距离**  | `setMaxCorrespondenceDistance` 按绝对距离剔除远距离匹配                      | 不引入（有 `finalOverlapRatio` 按**比例**裁剪 + `filterOutFarthestPoints` 按 μ+2.5σ 裁剪）   | 绝对阈值与点的量纲/单位绑定（米 vs 毫米），渲染侧给不出一个通用默认值；比例与 σ 两个通路已经覆盖"有非重叠部分"这个场景                  |
| **求解器**        | Eigen `LDLT` 解 6×6                                                         | Jacobi 特征分解做**伪逆**（复用本模块已有的模板实例化，N = 6）                               | 仓库不引入 Eigen；伪逆顺带给出 `rank < 6` 的干净判据（退化 ⇒ `GICP_ERROR_REGISTRATION_STEP`），LDLT 只会给出一个数值上胡说的解           |
| **RMS / 面板数字**| `getFitnessScore()` 是对应点的**点到点**平均（平方）距离                     | **同**：RMS 一律点到点（马氏只进目标函数），另加 `covarianceError`                            | 面板的"初始 RMS → 最终 RMS"要和 ICP 横向可比（同一片云、同一初值下谁更好一眼看出）；马氏距离带协方差量纲，无法与人眼熟悉的米制残差对照   |
| **协方差退化**    | `knn` 里会跳过自身（`nn_indices[0] == index`），点太少时行为未定义            | 取 `k+1` 个近邻并**丢掉所有 d² == 0 的**（自身 + 重复点），剩余 < 3 ⇒ 该点协方差取单位阵       | ① 不依赖"第一个近邻必是自身"这个假设（重复点会让它不成立）；② 单位阵让该对应退化成点到点，**不崩、不产生病态矩阵**，且与"协方差退化为单位阵时目标接近点到点 ICP"的文章说法一致 |
| **坐标精度**      | `PointXYZ` = float                                                          | 全程 double（同本模块的 ICP）                                                               | 同上                                                                                                                                   |

### 三处"别改回去"（都会**静默**劣化，不报错、不崩、只是结果变差）

1. **对应点必须用欧氏最近邻**，马氏只进目标函数。把马氏塞进最近邻搜索会让"谁配谁"随局部几何漂移
   （同一个点在两轮之间改配到别的邻域），而且 Ω 依赖 R ⇒ 每轮都得重建整棵树。文章与 PCL 都是欧氏对应。
2. **协方差必须与点同步旋转，且用 `filterTransformation` 之后的 `R_inc`**：`C ← R_inc·C·R_incᵀ`。
   用过滤前的 R 是这里最隐蔽的错——"仅绕 Z"档下点只绕 Z 转了、协方差却按完整旋转转了，
   平面朝向整体错位；而**不转协方差**同样会收敛（目标函数换了个意思而已），只是精度悄悄变差。
3. **Jacobi 的特征值不排序、特征向量是列**（`v[i][j]` 固定 `j`）。平面化要"最小特征值方向 = 法向"，
   不排就是随手把某个切平面方向当成法向（把 1000 倍权重加到错的方向上）——收敛照旧、精度全错。

另有一处**顺序**上的坑：**模型侧协方差存 KD 槽位序、data 侧存原序**。`KdTree::build` 用 `nth_element`
重排了内部数组，槽位号只在树内有效；对应点的协方差必须按**槽位**取（`cpCov[i] = treeCov[slot]`），
而 data 侧那棵树建在副本上、原数组没被动过，故按原序一一对应。两处顺序搞混 = 每个点配到别人的协方差。

还有一条**有意为之**的容错：`Ω = (C_target + C_data)⁻¹` 走 `inverse3` 的行列式闸门
（`|det| > 1e-12·(tr/3)³` 这种尺度无关判据），**病态的对应点这一轮直接跳过**（不参与 6×6 累加），
而不是拿数值噪声解一个假增量——关掉平面化用原始散布矩阵时这条路会被走到，故它是"对照档能用"的前提。
若某轮**所有**对应点都被跳过（A 全零 ⇒ 秩 < 6），报 `GICP_ERROR_REGISTRATION_STEP`，不静默返回不动变换。

### 实测（`tests/unit/renderer/utils/registration.spec.ts` 的 gicp 段落钉住的性质）

- 合成变换恢复：3000 点随机云、25°+平移的错位能从 `params: {}`（默认值）恢复到 3 位数字，
  且解出的 R 与单位阵的偏差 > 0.01（**直接钉死**"占位骨架 R 恒为单位矩阵"那类实现）。
- 协方差真的进了目标函数：平面化开 / 关两档的 `covarianceError` 相差 30 倍以上（ε = 1e-3 的法向权重
  被拆穿），改 `correspondenceRandomness` 也会改变解 ⇒ "协方差全为单位阵、GICP ≡ ICP"的死实现过不了。
- 确定性 / 分块不变性（1 / 3 / 7 块）逐位相等；参数面（`correspondenceRandomness < 3`、
  `samplingLimit < 3`、越界重叠度 ⇒ `GICP_ERROR_INVALID_INPUT`，空 data ⇒ `GICP_NOTHING_TO_DO`）；
  省略 `params` == 显式传 `defaultGicpParams()` 逐位相等（TS 默认值与 native 默认值不漂移）。
- 与 ICP 的对照（平面主导 + 小位姿差）：两者最终 RMS 到 7 位有效数字相同——完全重叠、无外点的合成云上
  两个目标函数的最优解是同一个点，这**不**说明 GICP 更准；GICP 的价值在非重叠/噪声/滑动方向上的鲁棒性，
  单测只断言"不差于 ICP（留 20% 余量）"，不编造优势。

## 与 JS 对照的边界

`tests/unit/renderer/utils/registration.spec.ts` 里有两类断言：

- **纯 JS 组**（不依赖 `.node` 产物）：`resolveRegistrationPair` 的选中形态解析、
  `matrixFromTransform` 的 4×4 布局、以及 `FilterTransformation` 的**逐位相等** JS 镜像
  （纯算术，无 `Math.log` 一类跨 libm 会差 1 ulp 的函数，故可以断言 `toBe` 而不是 `toBeCloseTo`）。
- **原生组**：合成变换恢复、退化、过滤器语义、ICP 收敛与"已经重合"、
  确定性（同参数两次逐位相等）、分块不变性、重叠度收缩；gicp 另有回包字段完备（面板崩的哨兵）、
  "真的会旋转"、协方差真的进目标函数、参数面与"省略 params == 默认值"。
  ICP / GICP 侧**不做**完整 JS 镜像（上游与实现都含 `std::abs`/`sqrt` 之外的浮点细节，
  且采样是随机的）——对照的是"已知真值的合成变换"，容差按点距量级反算，
  不写 `1e-9` 这类比数据精度还严的值。

⚠ 回包的变换方向是 **data → model**（`P' = R·P + T` 的直接含义，也是面板「待配准 ← 参考」的方向）。
测试里造数据是反着来的（`data = 真值(model)`），故断言前要先取逆（`invertTruth`）——
把 `res.r` 与真值直接比会以"解错了"的样子失败，实际只是方向约定（已踩过）。

## 内存与耗时

- 采样：data ≤ `samplingLimit / finalOverlapRatio`（默认 5 万；重叠度 10% 时 50 万）× 24 B
  = 1.2 MB ~ 12 MB；model ≤ 5 万 × 24 B = 1.2 MB。
- KD 树：模型采样点数的两份副本（`Vec3d` + `KdPoint`）+ 节点表（约 n/8 个节点 × 40 B）。
- 一轮 = 一次全量最近邻查询：5 万点 × 静态 KD 树 ≈ 10 ms 量级；20 轮 ≈ 0.2 s。
  比它更贵的是**渲染侧**的烘焙（逐点写 Float32），那是一次性的。
- **GICP 是它的一个量级之上**（这也是面板文案里"代价是慢一个量级"的由来）：
  两侧各一次 kNN 协方差 PCA（`2n` 次 `nearestK(k+1)`，k = 20 ⇒ 每点约 21 次距离计算 × 两份树），
  之后每轮除最近邻外还有 `n` 次 3×3 求逆 + 一次 6×6 Jacobi（≈ 50 次旋转变换的内部上限）。
  实测 3000 点、默认参数一次预览是**几十毫秒**（单测里 4 次预览共 0.1 s 量级）；
  5 万采样点在秒级。显存/内存额外开销：`n × 3 × 3 × 8 B = 72 B/点`（两侧协方差），
  5 万点 ≈ 3.6 MB，可忽略。
