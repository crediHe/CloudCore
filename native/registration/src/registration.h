#pragma once
/**
 * 配准（Registration）纯 C++ 算法本体：点对粗配准 + ICP 精配准。
 *
 * 语义对齐 CloudCompare 的两级配准：
 * - `Tools ▸ Registration ▸ Align (point pairs picking)` —— 手动拾取 ≥3 对同名点，
 *   闭式解出刚体变换（qCC 走 `HornRegistrationTools::FindAbsoluteOrientation`）。
 * - `Tools ▸ Registration ▸ Fine registration (ICP)` —— 以粗配准结果为起点迭代最近点
 *   （`ICPRegistrationTools::Register`，Besl 1992）。
 *
 * 逐行移植自本机 CCCoreLib 快照（`C:\Users\17316\Documents\讯卓科技\CloudCompare-master\CCCoreLib`）：
 * - `src/RegistrationTools.cpp`：`FilterTransformation`(L28) / `ICPRegistrationTools::Register`(L147) /
 *   `ComputeRMS`(L1005) / `RegistrationProcedure`(L1036，含 Horn 3 点特例)
 * - `include/Jacobi.h`：循环 Jacobi 特征分解（`ComputeEigenValuesAndVectors` /
 *   `GetMaxEigenValueAndVector`）；`SquareMatrix::initFromQuaternion` 的旋转矩阵公式
 * - `include/RegistrationTools.h`：枚举值与 `Parameters` 默认值（逐字照抄）
 * 源码位置以 `上游 RegistrationTools.cpp:L####` 形式注在对应代码旁，**改算法前先对照上游**。
 * 与上游的差异清单（内部全 double、采样确定性、停止判据取并集等）见 README-REF.md。
 *
 * 变换约定：**P' = s·(R·P) + T**（同 `PointProjectionTools::Transformation::apply`）。
 * 注意 R 是 3x3 **行主序**（`m[行][列]`），且**不是**旋转的转置版：对点做左乘 `R·P`。
 * `Transform::rValid == false` 表示 R 未初始化，此时 `apply` 按单位矩阵处理（同上游
 * `SquareMatrix::isValid()` 为假时 `operator*` 直接返回原向量）。
 *
 * 本模块**不做**的事（差异见 README-REF.md）：法向量匹配（`NORMALS_MATCHING`，本应用
 * 首版不做）、mesh 目标（只支持点云对点云）、点云权重（`modelWeights`/`dataWeights`，
 * 渲染侧没有权重通道）、多线程距离计算（50k 点规模单线程毫秒级）。
 */
#include <cstdint>
#include <limits>
#include <vector>

namespace registration {

/** 三维点/向量（内部一律 double；上游的 PointCoordinateType 是 float，见 README-REF）。 */
struct Vec3d {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/** 3x3 矩阵，行主序 `m[行][列]`（与上游 `SquareMatrixTpl` 的 `m_values[r][c]` 一一对应）。 */
struct Mat3d {
  double m[3][3] = {};
};

/** 相似变换：P' = s·(R·P) + T。 */
struct Transform {
  Mat3d R;
  Vec3d T;
  double s = 1.0;
  /** R 是否已初始化（对应上游 `SquareMatrix::isValid()`）；为假时 apply 把 R 当单位矩阵。 */
  bool rValid = false;
};

// ---------------------------------------------------------------------------
// 点对粗配准（Horn / Besl 四元数解）
// ---------------------------------------------------------------------------

/** `findAbsoluteOrientation` 的入参。 */
struct OrientationParams {
  /** 是否同时估计缩放 s（对应上游 `fixedScale = false`）；为假时结果 s 恒 1。 */
  bool adjustScale = false;
  /** `TRANSFORMATION_FILTERS` 位掩码（见下方常量）；0 = 不过滤。 */
  int filters = 0;
};

/** `findAbsoluteOrientation` 的回包。 */
struct OrientationResult {
  /** false = 解算退化（点数 < 3 / 两侧点数不等 / 三点共线 / 面内旋转不确定）；此时变换无意义。 */
  bool ok = false;
  Transform trans;
  /** 过滤后的最终变换下的 RMS；`ok == false` 时恒 -1。 */
  double rms = -1.0;
  /** 逐对距离（长度 = 点数），与 `deltas` 同为最终变换下的值。 */
  std::vector<double> distances;
  /** 逐对 (X,Y,Z) 偏差（长度 = 3 × 点数） = 参考点 − 变换后的待对齐点。 */
  std::vector<double> deltas;
};

/**
 * 求把 `aligned` 映到 `reference` 的相似变换（同名点一一对应）。
 *
 * @param aligned   待对齐点（P）
 * @param reference 参考点（X），必须与 aligned 等长
 * @param params    参数
 * @return 结果（含 `ok`）。两侧点数不等或 < 3 时 `ok == false`。
 */
OrientationResult findAbsoluteOrientation(const std::vector<Vec3d>& aligned, const std::vector<Vec3d>& reference,
                                         const OrientationParams& params);

// ---------------------------------------------------------------------------
// 变换过滤器（上游 `TRANSFORMATION_FILTERS`）
// ---------------------------------------------------------------------------

/** 不限制（默认）。 */
constexpr int SKIP_NONE = 0;
/** 只保留绕 Z 轴的旋转（丢弃绕 X / Y 的分量）。 */
constexpr int SKIP_RXY = 1;
/** 只保留绕 X 轴的旋转。 */
constexpr int SKIP_RYZ = 2;
/** 只保留绕 Y 轴的旋转。 */
constexpr int SKIP_RXZ = 4;
/** 完全不旋转（= SKIP_RXY | SKIP_RYZ | SKIP_RXZ）。 */
constexpr int SKIP_ROTATION = 7;
/** 平移 X 分量置 0。 */
constexpr int SKIP_TX = 8;
/** 平移 Y 分量置 0。 */
constexpr int SKIP_TY = 16;
/** 平移 Z 分量置 0。 */
constexpr int SKIP_TZ = 32;
/** 完全不平移（= SKIP_TX | SKIP_TY | SKIP_TZ）。 */
constexpr int SKIP_TRANSLATION = 56;

/**
 * 按位掩码约束变换（上游 `RegistrationTools::FilterTransformation`，RegistrationTools.cpp:L28）。
 *
 * 旋转过滤是"只保留绕某轴的旋转分量"，且**必须**配合随后的平移修正：把被砍掉的旋转
 * 造成的位置偏移，用两侧重力心之差补回来（否则解出来的云会整体偏掉）。
 */
void filterTransformation(const Transform& inTrans, int filters, const Vec3d& toBeAlignedGravityCenter,
                         const Vec3d& referenceGravityCenter, Transform& outTrans);

/**
 * 两片同长点云在给定变换下的 RMS（上游 `RegistrationTools::ComputeRMS`，RegistrationTools.cpp:L1005）。
 *
 * @return `sqrt(Σ‖Rᵢ − (s·R·Lᵢ + T)‖² / n)`；点数不等或 < 3 时返回 -1。
 */
double computeRMS(const std::vector<Vec3d>& left, const std::vector<Vec3d>& right, const Transform& trans);

// ---------------------------------------------------------------------------
// ICP
// ---------------------------------------------------------------------------

/** 单块候选源（与其余原生模块同构：positions + 可选 index 候选子集）。 */
struct ChunkSource {
  const float* positions = nullptr;
  std::uint32_t vertexCount = 0;
  /** 候选子集（顶点下标，顶点缓冲空间）；为 null 表示全量顶点。 */
  const std::uint32_t* index = nullptr;
  std::uint32_t indexCount = 0;
};

/** ICP 结果码（与上游 `ICPRegistrationTools::RESULT_TYPE` **数值一致**，RegistrationTools.h:L134）。 */
enum IcpResultCode {
  ICP_NOTHING_TO_DO = 0,
  ICP_APPLY_TRANSFO = 1,
  /** 以下均 ≥ 100，即"出错"。 */
  ICP_ERROR = 100,
  ICP_ERROR_REGISTRATION_STEP = 101,
  ICP_ERROR_DIST_COMPUTATION = 102,
  ICP_ERROR_NOT_ENOUGH_MEMORY = 103,
  ICP_ERROR_CANCELED_BY_USER = 104,
  ICP_ERROR_INVALID_INPUT = 105,
};

/** ICP 参数（默认值逐字照抄上游 `Parameters` 构造函数，RegistrationTools.h:L159 与
 *  qCC `ccRegistrationDlg.cpp` 的半持久化默认值）。 */
struct IcpParams {
  /** 最大迭代轮数（本实现与 minRMSDecrease **取并集**：任一满足即停，见 README-REF）。 */
  unsigned maxIterations = 20;
  /** 相邻两轮的 RMS 下降小于它就收敛。 */
  double minRMSDecrease = 1.0e-5;
  /** 每片云参与计算的点数上限（超出则随机降采样）。 */
  unsigned samplingLimit = 50000;
  /** 预期的重叠度（0 < ratio ≤ 1）；< 1 时每轮只保留距离最小的 ratio 比例的点。 */
  double finalOverlapRatio = 1.0;
  /** 是否释放缩放（Zinsser 估计）。 */
  bool adjustScale = false;
  /** 缩放下界；NaN = 不限（同上游 `Parameters` 构造函数的 quiet_NaN）。 */
  double minScale = std::numeric_limits<double>::quiet_NaN();
  /** 缩放上界；NaN = 不限。 */
  double maxScale = std::numeric_limits<double>::quiet_NaN();
  /** 是否每轮先按 μ+2.5σ 剔除距离过大的点。 */
  bool filterOutFarthestPoints = false;
  /** 每轮对增量变换施加的过滤器（`TRANSFORMATION_FILTERS` 位掩码）。 */
  int transformationFilters = SKIP_NONE;
  /** 随机降采样种子（**仅单测用**：同一输入 + 同一种子结果逐位相等；缺省 = 固定默认种子）。 */
  std::uint32_t seed = 0;
};

/** ICP 输出。 */
struct IcpOutput {
  /** `IcpResultCode`。 */
  int result = ICP_ERROR;
  /** 最终 RMS（失败时 -1）。 */
  double rms = -1.0;
  /** 首轮的 RMS（面板"初始 RMS → 最终 RMS"用）。 */
  double initialRms = -1.0;
  /** 参与最终 RMS 的点数。 */
  unsigned pointCount = 0;
  /** 结束时的迭代轮号（0 起算）。 */
  unsigned iterations = 0;
  /** 总变换（`rValid == false` 表示"不动"）。 */
  Transform trans;
};

/**
 * 迭代最近点精配准（上游 `ICPRegistrationTools::Register`，RegistrationTools.cpp:L147）。
 *
 * @param data  **待配准**（会动）的点云候选源，各块按 index 枚举候选
 * @param model **参考**（不动）的点云候选源
 * @param params 参数
 * @return 结果；`result` 为 `IcpResultCode`。
 *
 * 数据量为毫秒级：model ≤ samplingLimit 建静态 KD 树（一次），data 每轮 ≤
 * samplingLimit/finalOverlapRatio 次最近邻查询。
 */
IcpOutput icp(const std::vector<ChunkSource>& data, const std::vector<ChunkSource>& model, const IcpParams& params);

// ---------------------------------------------------------------------------
// GICP (Generalized Iterative Closest Point)
// ---------------------------------------------------------------------------

/** GICP 结果码（与 ICP 保持一致）。 */
enum GicpResultCode {
  GICP_NOTHING_TO_DO = 0,
  GICP_APPLY_TRANSFO = 1,
  /** 以下均 ≥ 100，即"出错"。 */
  GICP_ERROR = 100,
  GICP_ERROR_REGISTRATION_STEP = 101,
  GICP_ERROR_DIST_COMPUTATION = 102,
  GICP_ERROR_NOT_ENOUGH_MEMORY = 103,
  GICP_ERROR_CANCELED_BY_USER = 104,
  GICP_ERROR_INVALID_INPUT = 105,
};

/**
 * GICP 参数：与 ICP 同源的迭代/采样/过滤参数 + 两个 GICP 特有参数。
 *
 * **刻意没有** `adjustScale` / `minScale` / `maxScale`：PCL / libpointmatcher 的 GICP 都是**刚体**
 * （6 自由度），缩放不在它的模型里（GICP 的协方差本身就把局部尺度吃掉了）。留一个"估计缩放"的旋钮
 * 既说不清它在优化什么，也会与协方差的尺度语义打架。
 */
struct GicpParams {
  /** 最大迭代轮数（本实现与 minRMSDecrease **取并集**：任一满足即停）。 */
  unsigned maxIterations = 20;
  /** 相邻两轮的 RMS 下降小于它就收敛。 */
  double minRMSDecrease = 1.0e-5;
  /** 每片云参与计算的点数上限（超出则随机降采样）。 */
  unsigned samplingLimit = 50000;
  /** 预期的重叠度（0 < ratio ≤ 1）；< 1 时每轮只保留距离最小的 ratio 比例的点。 */
  double finalOverlapRatio = 1.0;
  /** 是否每轮先按 μ+2.5σ 剔除距离过大的点。 */
  bool filterOutFarthestPoints = false;
  /** 每轮对增量变换施加的过滤器（`TRANSFORMATION_FILTERS` 位掩码）。 */
  int transformationFilters = SKIP_NONE;
  /** 随机降采样种子（仅单测用）。 */
  std::uint32_t seed = 0;
  /**
   * GICP 特有：估计每个点局部协方差时的近邻个数（对齐 PCL `setCorrespondenceRandomness`，默认 20）。
   *
   * 用**个数**而不是半径，是因为它与点云密度无关：同一份默认值在室内扫描与机载 LiDAR 上都成立
   * （半径得按每份数据的密度手工调）。< 3 时无法构成协方差，直接报 `GICP_ERROR_INVALID_INPUT`。
   */
  unsigned correspondenceRandomness = 20;
  /**
   * GICP 特有：是否做**平面化正则化** —— 把局部协方差特征分解后，特征值替换为 `(ε, 1, 1)`
   * （`kCovarianceEpsilon = 1e-3`）：沿法向 ε、沿切平面 1。这是经典 GICP / "面到面"的形态，
   * 沿法向的误差被重罚、切平面内的微小滑动被宽容。
   *
   * 关掉则用原始散布矩阵（对照用）：此时协方差可能奇异/病态，病态的那些对应点会被跳过
   * （见 README-REF 的已知限制），目标退化得更接近"带权重的点到点"。
   */
  bool useNormalCovariance = true;
};

/** GICP 输出（字段与 `IcpOutput` 逐字对应，另加一个 GICP 统计量）。 */
struct GicpOutput {
  /** `GicpResultCode`。 */
  int result = GICP_ERROR;
  /** 最终 RMS（失败时 -1）。**点到点**，故与 `IcpOutput::rms` 同量、可直接横向比较。 */
  double rms = -1.0;
  /** 首轮的 RMS（面板"初始 RMS → 最终 RMS"用）。 */
  double initialRms = -1.0;
  /** 参与最终 RMS 的点数。 */
  unsigned pointCount = 0;
  /** 结束时的迭代轮号（0 起算）。 */
  unsigned iterations = 0;
  /** 总变换（`rValid == false` 表示"不动"）。 */
  Transform trans;
  /**
   * GICP 统计量：最终保留点集上**逐点马氏距离的 RMS** = `sqrt(Σ dᵢᵀΩᵢdᵢ / n)`，无量纲。
   *
   * 它就是 GICP 目标函数在解处的开方值，故"马氏残差"只作参考、**不要**与 RMS 比大小
   * （两者量纲不同：RMS 是米，这个是标准差倍数）。
   */
  double covarianceError = 0.0;
};

/**
 * 广义迭代最近点精配准（Generalized-ICP，Segal/Haehnel/Thrun RSS 2009）。
 *
 * 与 `icp()` 的差别只在"怎么用对应点"这一处，其余（采样 / 重叠度裁剪 / 剔除最远点 /
 * 过滤器 / RMS 与停止判据 / 结果码）逐段镜像 ICP：
 * 1. 两侧各按 `correspondenceRandomness` 个近邻做 PCA，得逐点局部协方差 `C`；
 *    `useNormalCovariance` 为真时把特征值替换成 `(ε, 1, 1)`（平面化）；
 * 2. **对应点仍用欧氏最近邻**（不是马氏最近邻 —— 马氏只进目标函数）；
 * 3. 每轮解 `min Σ dᵢᵀ(Cᵢᵗᵃʳᵍᵉᵗ + R·Cᵢˢᵒᵘʳᶜᵉ·Rᵀ)⁻¹dᵢ`：对 `R ≈ I + [ω]×` 线性化后在**数据重心系**
 *    组装 6x6 对称系统 `A x = b`（x = ω, t̃），Jacobi 特征分解做伪逆求解（秩亏 ⇒ REGISTRATION_STEP）。
 *
 * @param data  **待配准**（会动）的点云候选源，各块按 index 枚举候选
 * @param model **参考**（不动）的点云候选源
 * @param params 参数
 * @return 结果；`result` 为 `GicpResultCode`。
 *
 * 对比 ICP 慢一个量级（两侧协方差 PCA 是本模块最贵的部分，约 `2n` 次 kNN 查询），
 * 收益在平面主导 / 特征方向明确的场景下更稳（切平面内的滑动被协方差压住）。
 */
GicpOutput gicp(const std::vector<ChunkSource>& data, const std::vector<ChunkSource>& model, const GicpParams& params);

}  // namespace registration
