/**
 * 配准算法实现：点对粗配准（Horn / Besl 四元数解）+ ICP（Besl 迭代最近点）。
 *
 * 逐行移植自本机 CCCoreLib 快照（`C:\Users\17316\Documents\讯卓科技\CloudCompare-master\CCCoreLib`），
 * 代码旁以 `上游 RegistrationTools.cpp:L####` 标注对应行；**改算法前先对照上游**。
 *
 * 与上游的差异（完整清单见 README-REF.md）：
 * - 全程 double（上游 PointCoordinateType 是 float）：语义不变、精度更高。
 * - 随机降采样用固定种子的确定性 PRNG（上游 std::random_device ⇒ 同参数两次结果不同）。
 * - 上游那套 `DataCloud { cloud, rotatedCloud, CPSetRef/CPSetPlain }` 的对象生命周期
 *   （ReferenceCloud 换装、PointCloud 单独持有、Garbage 回收）在这里等价改写为三张并行
 *   `std::vector`（点 / 最近点 / 距离）：参考云恒为恒等索引，且"重建旋转云"与"原地旋转"
 *   两个分支在向量表示下是同一个操作（见 icp 内 F 段注释）。
 * - ICP 停止判据取 `minRMSDecrease` 与 `maxIterations` 的**并集**（上游按 convType 二选一，
 *   且 MAX_ERROR + minRMSDecrease=0 时不设上界）。
 */
#include "registration.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <utility>

namespace registration {

namespace {

// ===========================================================================
// 0. 常量与小工具
// ===========================================================================

/** `ZERO_TOLERANCE_D`（上游 CCConst.h:L33：float epsilon 的 double 化，刻意不用 double epsilon）。 */
constexpr double kZeroTolerance = 1.1920928955078125e-07;

inline bool lessThanEpsilon(double x) { return std::abs(x) < kZeroTolerance; }

inline Vec3d vec(double x, double y, double z) { return Vec3d{x, y, z}; }
inline Vec3d add(const Vec3d& a, const Vec3d& b) { return vec(a.x + b.x, a.y + b.y, a.z + b.z); }
inline Vec3d sub(const Vec3d& a, const Vec3d& b) { return vec(a.x - b.x, a.y - b.y, a.z - b.z); }
inline Vec3d mul(const Vec3d& a, double k) { return vec(a.x * k, a.y * k, a.z * k); }
inline double dot(const Vec3d& a, const Vec3d& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

inline Vec3d cross(const Vec3d& a, const Vec3d& b) {
  return vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

inline double norm(const Vec3d& a) { return std::sqrt(dot(a, a)); }

inline Mat3d identity3() {
  Mat3d r;
  r.m[0][0] = 1.0;
  r.m[1][1] = 1.0;
  r.m[2][2] = 1.0;
  return r;
}

/** 逐元素和（上游 SquareMatrix 的 operator+ / operator- 是逐元素运算）。 */
inline Mat3d matrixAdd(const Mat3d& a, const Mat3d& b) {
  Mat3d r;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) r.m[i][j] = a.m[i][j] + b.m[i][j];
  return r;
}

inline Mat3d matrixSub(const Mat3d& a, const Mat3d& b) {
  Mat3d r;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) r.m[i][j] = a.m[i][j] - b.m[i][j];
  return r;
}

/** 矩阵乘（上游 SquareMatrixTpl::operator*，SquareMatrix.h:L205：标准行主序乘）。 */
inline Mat3d matrixMul(const Mat3d& a, const Mat3d& b) {
  Mat3d c;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      double sum = 0.0;
      for (int k = 0; k < 3; ++k) sum += a.m[i][k] * b.m[k][j];
      c.m[i][j] = sum;
    }
  }
  return c;
}

inline Mat3d transposed(const Mat3d& a) {
  Mat3d r;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) r.m[i][j] = a.m[j][i];
  return r;
}

inline double traceOf(const Mat3d& a) { return a.m[0][0] + a.m[1][1] + a.m[2][2]; }

inline Mat3d scaledMatrix(const Mat3d& a, double k) {
  Mat3d r;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) r.m[i][j] = a.m[i][j] * k;
  return r;
}

/** 矩阵乘向量（上游 SquareMatrixTpl::apply，SquareMatrix.h:L314）。 */
inline Vec3d matrixApply(const Mat3d& a, const Vec3d& v) {
  return vec(a.m[0][0] * v.x + a.m[0][1] * v.y + a.m[0][2] * v.z,
             a.m[1][0] * v.x + a.m[1][1] * v.y + a.m[1][2] * v.z,
             a.m[2][0] * v.x + a.m[2][1] * v.y + a.m[2][2] * v.z);
}

/**
 * 单位四元数 → 旋转矩阵（上游 SquareMatrix::initFromQuaternion，SquareMatrix.h:L549）。
 * 四元数顺序是 (w, x, y, z)；公式与上游逐字一致（标准行主序主动旋转矩阵）。
 * ⚠ 上游要求四元数已归一化（本函数不归一化）。
 */
inline Mat3d fromQuaternion(const double q[4]) {
  const double q00 = q[0] * q[0];
  const double q11 = q[1] * q[1];
  const double q22 = q[2] * q[2];
  const double q33 = q[3] * q[3];
  const double q03 = q[0] * q[3];
  const double q13 = q[1] * q[3];
  const double q23 = q[2] * q[3];
  const double q02 = q[0] * q[2];
  const double q12 = q[1] * q[2];
  const double q01 = q[0] * q[1];

  Mat3d r;
  r.m[0][0] = q00 + q11 - q22 - q33;
  r.m[1][1] = q00 - q11 + q22 - q33;
  r.m[2][2] = q00 - q11 - q22 + q33;
  r.m[0][1] = 2.0 * (q12 - q03);
  r.m[1][0] = 2.0 * (q12 + q03);
  r.m[0][2] = 2.0 * (q13 + q02);
  r.m[2][0] = 2.0 * (q13 - q02);
  r.m[1][2] = 2.0 * (q23 - q01);
  r.m[2][1] = 2.0 * (q23 + q01);
  return r;
}

/**
 * 变换作用于点：P' = s·(R·P) + T（上游 PointProjectionTools::Transformation::apply）。
 * R 无效时按**单位矩阵**处理——上游 `SquareMatrix::isValid()` 为假时 `operator*` 直接
 * 返回原向量（SquareMatrix.h:L258），故"只平移"的那条退化路径（见 registrationProcedure
 * 的退化分支）在两边语义一致。
 */
inline Vec3d applyTransform(const Transform& t, const Vec3d& p) {
  const Vec3d rp = t.rValid ? matrixApply(t.R, p) : p;
  return add(mul(rp, t.s), t.T);
}

// ===========================================================================
// 1. Jacobi 特征分解（上游 include/Jacobi.h）
// ===========================================================================

/**
 * 循环 Jacobi 特征分解（上游 Jacobi.h:L83，数值食谱 11.1）。
 *
 * 三个实例化点都在本文件内：N = 3（GICP 的协方差平面化正则化）、N = 4（ICP 的 QSigma）、
 * N = 6（GICP 的线性化方程 A x = b 的伪逆）。未移植上游的 `absoluteValues` 分支
 * （唯一调用点传 false，见上游 RegistrationTools.cpp:L1280）。
 *
 * ⚠ **特征值不排序**（要升序得自己排）且**特征向量是列**（`v[i][j]` 取固定的 j）——GICP 的两处
 * 用法都依赖这条约定，改这里之前先看 `planarizeCovariance` / `solve6x6`。
 *
 * @param a 对称方阵（**原地被对角化**，同上游警告）
 * @param v 输出特征向量（列 = 特征向量，与特征值数组同序）
 * @param d 输出特征值
 * @return 成功；迭代次数（50）用尽返回 false
 */
template <int N>
bool jacobiEigenValuesAndVectors(double a[N][N], double v[N][N], double d[N]) {
  for (int i = 0; i < N; ++i)
    for (int j = 0; j < N; ++j) v[i][j] = (i == j) ? 1.0 : 0.0;

  double b[N];
  double z[N];
  for (int ip = 0; ip < N; ++ip) {
    b[ip] = d[ip] = a[ip][ip];
    z[ip] = 0.0;  // 累积 tapq 项（食谱 11.1.14）
  }

  constexpr unsigned kMaxIterationCount = 50;  // 上游 Jacobi.h:L87 的默认形参
  for (unsigned iter = 1; iter <= kMaxIterationCount; ++iter) {
    // 非对角元素绝对值之和
    double sm = 0.0;
    for (int ip = 0; ip < N - 1; ++ip)
      for (int iq = ip + 1; iq < N; ++iq) sm += std::abs(a[ip][iq]);
    if (sm == 0.0) {
      return true;  // 正常返回（二次收敛到机器下溢）
    }

    double tresh = 0.0;
    if (iter < 4) {
      tresh = sm / static_cast<double>(5 * N * N);  // 前三轮用阈值
    }

    for (int ip = 0; ip < N - 1; ++ip) {
      for (int iq = ip + 1; iq < N; ++iq) {
        const double pq = std::abs(a[ip][iq]) * 100;
        // 四轮之后，非对角元素足够小就跳过旋转（浮点比较，照抄上游 Jacobi.h:L171）
        if (iter > 4 && static_cast<float>(std::abs(d[ip]) + pq) == static_cast<float>(std::abs(d[ip])) &&
            static_cast<float>(std::abs(d[iq]) + pq) == static_cast<float>(std::abs(d[iq]))) {
          a[ip][iq] = 0.0;
        } else if (std::abs(a[ip][iq]) > tresh) {
          double h = d[iq] - d[ip];
          double t = 0.0;
          if (static_cast<float>(std::abs(h) + pq) == static_cast<float>(std::abs(h))) {
            t = a[ip][iq] / h;
          } else {
            const double theta = h / (2 * a[ip][iq]);  // 食谱 11.1.10
            t = 1 / (std::abs(theta) + std::sqrt(1 + theta * theta));
            if (theta < 0) t = -t;
          }

          const double c = 1 / std::sqrt(t * t + 1);
          const double s = t * c;
          const double tau = s / (1 + c);
          h = t * a[ip][iq];
          z[ip] -= h;
          z[iq] += h;
          d[ip] -= h;
          d[iq] += h;
          a[ip][iq] = 0.0;

          // ROTATE 宏（上游 Jacobi.h:L68）：a[i][j] 与 a[k][l] 的联合旋转；h 在四段之间共享
          auto rotate = [&h, s, tau](double& aij, double& akl) {
            const double g = aij;
            h = akl;
            aij = g - s * (h + g * tau);
            akl = h + s * (g - h * tau);
          };
          for (int j = 0; j + 1 <= ip; ++j) rotate(a[j][ip], a[j][iq]);      // 0 ≤ j < ip
          for (int j = ip + 1; j + 1 <= iq; ++j) rotate(a[ip][j], a[j][iq]);  // ip < j < iq
          for (int j = iq + 1; j < N; ++j) rotate(a[ip][j], a[iq][j]);        // iq < j < N
          for (int j = 0; j < N; ++j) rotate(v[j][ip], v[j][iq]);
        }
      }
    }

    // 更新 b、d、z
    for (int ip = 0; ip < N; ++ip) {
      b[ip] += z[ip];
      d[ip] = b[ip];
      z[ip] = 0.0;
    }
  }

  return false;  // 迭代次数用尽
}

/**
 * 最大特征值及其特征向量（上游 Jacobi::GetMaxEigenValueAndVector，Jacobi.h:L325）。
 * 特征向量取矩阵的**第 maxIndex 列**（上游 GetEigenVector 取 `m_values[i][index]`）。
 */
template <int N>
void getMaxEigenValueAndVector(const double v[N][N], const double d[N], double& maxEigenValue,
                               double maxEigenVector[N]) {
  int maxIndex = 0;
  for (int i = 1; i < N; ++i) {
    if (d[i] > d[maxIndex]) maxIndex = i;
  }
  maxEigenValue = d[maxIndex];
  for (int i = 0; i < N; ++i) maxEigenVector[i] = v[i][maxIndex];
}

// ===========================================================================
// 2. 点集统计（重力中心 / 互协方差 / 距离分布）
// ===========================================================================

/** 重力中心（上游 GeometricalAnalysisTools::ComputeGravityCenter，GeometricalAnalysisTools.cpp:L533）。 */
Vec3d gravityCenter(const std::vector<Vec3d>& pts) {
  Vec3d sum;
  for (const Vec3d& p : pts) sum = add(sum, p);
  if (!pts.empty()) sum = mul(sum, 1.0 / static_cast<double>(pts.size()));
  return sum;
}

/**
 * 互协方差矩阵（上游 GeometricalAnalysisTools::ComputeCrossCovarianceMatrix，
 * GeometricalAnalysisTools.cpp:L629）：`m[r][c] = (1/n)·Σ (Pᵢ−Gp)[r]·(Qᵢ−Gq)[c]`。
 * 注意 P 在前、Q 在后（调用处 P = data / Q = model），**不是**对称的。
 */
Mat3d crossCovariance(const std::vector<Vec3d>& P, const std::vector<Vec3d>& Q, const Vec3d& Gp, const Vec3d& Gq) {
  Mat3d cov;
  const std::size_t n = P.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Vec3d pt = sub(P[i], Gp);
    const Vec3d qt = sub(Q[i], Gq);
    cov.m[0][0] += pt.x * qt.x;
    cov.m[0][1] += pt.x * qt.y;
    cov.m[0][2] += pt.x * qt.z;
    cov.m[1][0] += pt.y * qt.x;
    cov.m[1][1] += pt.y * qt.y;
    cov.m[1][2] += pt.y * qt.z;
    cov.m[2][0] += pt.z * qt.x;
    cov.m[2][1] += pt.z * qt.y;
    cov.m[2][2] += pt.z * qt.z;
  }
  // 上游最后 scale(1/count)；它只影响 QSigma 的整体倍数、不影响特征向量，但仍照抄
  if (n != 0) {
    const double inv = 1.0 / static_cast<double>(n);
    cov = scaledMatrix(cov, inv);
  }
  return cov;
}

/**
 * 距离分布的 μ 与 σ²（上游 NormalDistribution::computeParameters，NormalDistribution.cpp:L85）。
 * σ² 走 `|E[v²] − μ²|` 的捷径（含 abs），与上游逐字一致。
 *
 * @return 是否有有效值（上游 counter == 0 时返回 false 前已 setValid(false)）
 */
bool distanceDistribution(const std::vector<double>& values, double& mu, double& sigma2) {
  if (values.empty()) return false;
  double mean = 0.0;
  double squareMean = 0.0;
  for (double v : values) {
    mean += v;
    squareMean += v * v;
  }
  const double n = static_cast<double>(values.size());
  mean /= n;
  sigma2 = std::abs(squareMean / n - mean * mean);
  mu = mean;
  return true;
}

// ===========================================================================
// 3. 过滤器与 RMS（上游 RegistrationTools.cpp:L28 / L1005）
// ===========================================================================

}  // namespace

void filterTransformation(const Transform& inTrans, int filters, const Vec3d& toBeAlignedGravityCenter,
                          const Vec3d& referenceGravityCenter, Transform& outTrans) {
  // 上游 RegistrationTools.cpp:L34
  outTrans = inTrans;

  // ---- 旋转过滤（上游 L36-113）----
  const int rotationFilter = filters & SKIP_ROTATION;
  if (inTrans.rValid && rotationFilter != 0) {
    const Mat3d R = inTrans.R;  // 拷贝：上游提醒 inTrans 与 outTrans 可能是同一个对象
    outTrans.R = identity3();
    if (rotationFilter == SKIP_RYZ) {
      // 只保留绕 X 轴的旋转；上游用一套特定的欧拉角约定（L45-57）
      if (R.m[0][2] < 1.0) {
        const double phi = -std::asin(R.m[0][2]);
        const double cos_phi = std::cos(phi);
        const double theta = std::atan2(R.m[1][2] / cos_phi, R.m[2][2] / cos_phi);
        const double cos_theta = std::cos(theta);
        const double sin_theta = std::sin(theta);

        outTrans.R.m[1][1] = cos_theta;
        outTrans.R.m[2][2] = cos_theta;
        outTrans.R.m[2][1] = sin_theta;
        outTrans.R.m[1][2] = -sin_theta;
      }
      // else：上游注释"这种情况（R(0,2) == 1）太特殊，直接忽略"——照抄
    } else if (rotationFilter == SKIP_RXZ) {
      // 只保留绕 Y 轴的旋转（上游 L66-77）
      if (R.m[2][1] < 1.0) {
        const double theta = std::asin(R.m[2][1]);
        const double cos_theta = std::cos(theta);
        const double phi = std::atan2(-R.m[2][0] / cos_theta, R.m[2][2] / cos_theta);
        const double cos_phi = std::cos(phi);
        const double sin_phi = std::sin(phi);

        outTrans.R.m[0][0] = cos_phi;
        outTrans.R.m[2][2] = cos_phi;
        outTrans.R.m[0][2] = sin_phi;
        outTrans.R.m[2][0] = -sin_phi;
      }
    } else if (rotationFilter == SKIP_RXY) {
      // 只保留绕 Z 轴的旋转（上游 L87-98）
      if (R.m[2][0] < 1.0) {
        const double theta_rad = -std::asin(R.m[2][0]);
        const double cos_theta = std::cos(theta_rad);
        const double phi_rad = std::atan2(R.m[1][0] / cos_theta, R.m[0][0] / cos_theta);
        const double cos_phi = std::cos(phi_rad);
        const double sin_phi = std::sin(phi_rad);

        outTrans.R.m[0][0] = cos_phi;
        outTrans.R.m[1][1] = cos_phi;
        outTrans.R.m[1][0] = sin_phi;
        outTrans.R.m[0][1] = -sin_phi;
      }
    }
    // else（SKIP_ROTATION）：丢掉全部旋转分量 = 保持上面写入的单位矩阵

    // ⚠ 平移修正（上游 L110-112）：把被砍掉的旋转造成的位置偏移补回来。
    // **必须**用 outTrans（过滤后的 R，但 s/T 还是 inTrans 的）去作用在"待对齐云的重力心"上，
    // 再与参考云重力心作差。漏掉这一步对齐出来的云会整体偏掉。
    const Vec3d alignedGravityCenter = applyTransform(outTrans, toBeAlignedGravityCenter);
    outTrans.T = add(outTrans.T, sub(referenceGravityCenter, alignedGravityCenter));
  }

  // ---- 平移过滤（上游 L115-124）----
  if (filters & SKIP_TRANSLATION) {
    if (filters & SKIP_TX) outTrans.T.x = 0;
    if (filters & SKIP_TY) outTrans.T.y = 0;
    if (filters & SKIP_TZ) outTrans.T.z = 0;
  }
}

double computeRMS(const std::vector<Vec3d>& left, const std::vector<Vec3d>& right, const Transform& trans) {
  // 上游 RegistrationTools.cpp:L1005
  if (left.size() != right.size() || left.size() < 3) {
    return -1.0;
  }
  double sum = 0.0;
  for (std::size_t i = 0; i < left.size(); ++i) {
    const Vec3d d = sub(right[i], applyTransform(trans, left[i]));
    sum += dot(d, d);
  }
  return std::sqrt(sum / static_cast<double>(left.size()));
}

// ===========================================================================
// 4. 解算一轮（上游 RegistrationTools::RegistrationProcedure，RegistrationTools.cpp:L1036）
// ===========================================================================

namespace {

/**
 * 闭式解出把 P 映到 X 的相似变换（P 与 X 必须等长、一一对应）。
 *
 * @param outGp 可选：P 的重力心（过滤器要用）
 * @param outGx 可选：X 的重力心
 * @return 成功；点数不等 / < 3 / 退化（三点共线、面内旋转不确定）返回 false
 */
bool registrationProcedure(const std::vector<Vec3d>& P, const std::vector<Vec3d>& X, Transform& trans,
                           bool adjustScale, Vec3d* outGp, Vec3d* outGx) {
  // 输出变换初始化（上游 L1046-1048）：R 无效、T = 0、s = 1
  trans.R = Mat3d();
  trans.rValid = false;
  trans.T = Vec3d();
  trans.s = 1.0;

  const std::size_t count = P.size();
  if (count != X.size() || count < 3) {
    return false;
  }

  // 重力心（上游 L1054-1055；无权重通道，故恒为无权中心）
  const Vec3d Gp = gravityCenter(P);
  const Vec3d Gx = gravityCenter(X);
  if (outGp) *outGp = Gp;
  if (outGx) *outGx = Gx;

  // aPrioriScale 恒 1（上游 ICP 传 PC_ONE、Horn 走默认值），故代码里不设该变量，
  // 所有 `* (aPrioriScale * trans.s)` 都写成 `* trans.s`。
  if (count == 3) {
    // ---- 3 点特例（上游 L1062-1203，Horn 论文 5.A 节）----
    const Vec3d Ap = P[0];
    const Vec3d Bp = P[1];
    const Vec3d Cp = P[2];
    Vec3d Np = cross(sub(Bp, Ap), sub(Cp, Ap));
    {
      const double n = norm(Np);
      if (lessThanEpsilon(n)) return false;  // 待对齐三点共线
      Np = mul(Np, 1.0 / n);
    }
    const Vec3d Ax = X[0];
    const Vec3d Bx = X[1];
    const Vec3d Cx = X[2];
    Vec3d Nx = cross(sub(Bx, Ax), sub(Cx, Ax));
    {
      const double n = norm(Nx);
      if (lessThanEpsilon(n)) return false;  // 参考三点共线
      Nx = mul(Nx, 1.0 / n);
    }

    // 旋转 = 把 Nx 转到 Np（绕 Gx）
    const Vec3d a = cross(Np, Nx);
    if (lessThanEpsilon(norm(a))) {
      // 两个法线平行：单位矩阵，反向则取 -I（上游 L1100-1105）
      trans.R = identity3();
      if (dot(Np, Nx) < 0) {
        trans.R = scaledMatrix(trans.R, -1.0);
      }
    } else {
      const double cos_t = dot(Np, Nx);
      const double s = std::sqrt((1 + cos_t) * 2);
      double q[4] = {s / 2, a.x / s, a.y / s, a.z / s};
      // 别忘了归一化四元数（上游 L1114-1120）
      double qnorm = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
      qnorm = std::sqrt(qnorm);
      q[0] /= qnorm;
      q[1] /= qnorm;
      q[2] /= qnorm;
      q[3] /= qnorm;
      trans.R = fromQuaternion(q);
    }
    trans.rValid = true;

    if (adjustScale) {
      // 3 点路径的缩放 = 周长比（上游 L1124-1134）
      double sumNormP = norm(sub(Bp, Ap)) + norm(sub(Cp, Bp)) + norm(sub(Ap, Cp));
      if (lessThanEpsilon(sumNormP)) return false;
      const double sumNormX = norm(sub(Bx, Ax)) + norm(sub(Cx, Bx)) + norm(sub(Ax, Cx));
      trans.s = sumNormX / sumNormP;
    }

    // 第一版平移（上游 L1137）
    trans.T = sub(Gx, mul(matrixApply(trans.R, Gp), trans.s));

    // ---- 面内旋转细化（上游 L1139-1202）----
    {
      const Vec3d App = applyTransform(trans, Ap);
      const Vec3d Bpp = applyTransform(trans, Bp);
      const Vec3d Cpp = applyTransform(trans, Cp);

      // C = Σ rx·rp，Ssum = Σ rx×rp，S = Ssum·Nx（注意 C 首项是赋值、不是累加）
      Vec3d Ssum;
      const Vec3d rx0 = sub(Ax, Gx);
      const Vec3d rp0 = sub(App, Gx);
      double C = dot(rx0, rp0);
      Ssum = cross(rx0, rp0);

      const Vec3d rx1 = sub(Bx, Gx);
      const Vec3d rp1 = sub(Bpp, Gx);
      C += dot(rx1, rp1);
      Ssum = add(Ssum, cross(rx1, rp1));

      const Vec3d rx2 = sub(Cx, Gx);
      const Vec3d rp2 = sub(Cpp, Gx);
      C += dot(rx2, rp2);
      Ssum = add(Ssum, cross(rx2, rp2));

      const double S = dot(Ssum, Nx);
      const double Q = std::sqrt(S * S + C * C);
      if (lessThanEpsilon(Q)) return false;  // 面内旋转不确定

      const double sin_t = S / Q;
      const double cos_t = C / Q;
      const double inv_cos_t = 1 - cos_t;

      const double l1 = Nx.x;
      const double l2 = Nx.y;
      const double l3 = Nx.z;
      const double l1_inv_cos_t = l1 * inv_cos_t;
      const double l3_inv_cos_t = l3 * inv_cos_t;

      // 上游这里写的是"列"注释但按行主序填 m_values（照抄，勿改）
      Mat3d R;
      R.m[0][0] = cos_t + l1 * l1_inv_cos_t;
      R.m[0][1] = l2 * l1_inv_cos_t + l3 * sin_t;
      R.m[0][2] = l3 * l1_inv_cos_t - l2 * sin_t;

      R.m[1][0] = l2 * l1_inv_cos_t - l3 * sin_t;
      R.m[1][1] = cos_t + l2 * l2 * inv_cos_t;
      R.m[1][2] = l2 * l3_inv_cos_t + l1 * sin_t;

      R.m[2][0] = l3 * l1_inv_cos_t + l2 * sin_t;
      R.m[2][1] = l2 * l3_inv_cos_t - l1 * sin_t;
      R.m[2][2] = cos_t + l3 * l3_inv_cos_t;

      trans.R = matrixMul(R, trans.R);
      trans.T = sub(Gx, mul(matrixApply(trans.R, Gp), trans.s));  // 顺带更新 T
    }
  } else {
    // ---- 一般路径（上游 L1204-1326）----
    // 退化：参考点集的包围盒缩成一个点（两片云离得极远时会出现）→ 只给平移
    {
      Vec3d bbMin = X[0];
      Vec3d bbMax = X[0];
      for (const Vec3d& p : X) {
        bbMin = vec(std::min(bbMin.x, p.x), std::min(bbMin.y, p.y), std::min(bbMin.z, p.z));
        bbMax = vec(std::max(bbMax.x, p.x), std::max(bbMax.y, p.y), std::max(bbMax.z, p.z));
      }
      const Vec3d diag = sub(bbMax, bbMin);
      if (lessThanEpsilon(std::abs(diag.x) + std::abs(diag.y) + std::abs(diag.z))) {
        trans.T = sub(Gx, Gp);  // R 保持无效（= 单位矩阵）
        return true;
      }
    }

    // 互协方差（上游 L1220-1222，Besl 论文式 #24；无权版本）
    const Mat3d sigmaPx = crossCovariance(P, X, Gp, Gx);

    // 4x4 QSigma（上游 L1242-1275，Besl 论文式 #25）
    const Mat3d sigmaPxT = transposed(sigmaPx);
    const Mat3d aij = matrixSub(sigmaPx, sigmaPxT);
    const double tr = traceOf(sigmaPx);

    Mat3d traceI3;
    traceI3.m[0][0] = tr;
    traceI3.m[1][1] = tr;
    traceI3.m[2][2] = tr;
    const Mat3d bottomMat = matrixSub(matrixAdd(sigmaPx, sigmaPxT), traceI3);

    double qSigma[4][4] = {};
    qSigma[0][0] = tr;

    qSigma[0][1] = qSigma[1][0] = aij.m[1][2];
    qSigma[0][2] = qSigma[2][0] = aij.m[2][0];
    qSigma[0][3] = qSigma[3][0] = aij.m[0][1];

    qSigma[1][1] = bottomMat.m[0][0];
    qSigma[1][2] = bottomMat.m[0][1];
    qSigma[1][3] = bottomMat.m[0][2];

    qSigma[2][1] = bottomMat.m[1][0];
    qSigma[2][2] = bottomMat.m[1][1];
    qSigma[2][3] = bottomMat.m[1][2];

    qSigma[3][1] = bottomMat.m[2][0];
    qSigma[3][2] = bottomMat.m[2][1];
    qSigma[3][3] = bottomMat.m[2][2];

    // 特征分解（上游 L1277-1284）
    double eigVectors[4][4] = {};
    double eigValues[4] = {};
    if (!jacobiEigenValuesAndVectors<4>(qSigma, eigVectors, eigValues)) {
      return false;
    }

    // Besl：最佳旋转 = 最大特征值对应的特征向量（上游 L1286-1292）
    double qR[4] = {};
    double maxEigValue = 0.0;
    getMaxEigenValueAndVector<4>(eigVectors, eigValues, maxEigValue, qR);
    trans.R = fromQuaternion(qR);
    trans.rValid = true;

    if (adjustScale) {
      // Zinsser 缩放估计（上游 L1296-1322）
      double accNum = 0.0;
      double accDenom = 0.0;
      for (std::size_t i = 0; i < count; ++i) {
        const Vec3d aTilde = matrixApply(trans.R, sub(P[i], Gp));  // R·(a − Gp)
        const Vec3d bTilde = sub(X[i], Gx);                       // b − Gx
        accNum += dot(bTilde, aTilde);
        accDenom += dot(aTilde, aTilde);
      }
      // accDenom 不可能为 0：前面已经确认参考集不是单点（上游 assert 同）
      trans.s = std::abs(accNum / accDenom);
    }

    // 平移（上游 L1325，Besl 式 #26 + jschmidt 的缩放修正）
    trans.T = sub(Gx, mul(matrixApply(trans.R, Gp), trans.s));
  }

  return true;
}

}  // namespace

// ===========================================================================
// 5. 点对粗配准对外入口（对应 qCC ccPointPairRegistrationDlg::callRegistration）
// ===========================================================================

OrientationResult findAbsoluteOrientation(const std::vector<Vec3d>& aligned, const std::vector<Vec3d>& reference,
                                         const OrientationParams& params) {
  OrientationResult out;
  const std::size_t n = aligned.size();
  out.distances.assign(n, 0.0);
  out.deltas.assign(n * 3, 0.0);

  if (n != reference.size()) {
    return out;  // ok = false：两侧点数不等（面板上不该出现，防御）
  }

  // 1) 解算（上游 ccPointPairRegistrationDlg.cpp:L1390 调 FindAbsoluteOrientation
  //    = RegistrationProcedure(..., !fixedScale)）
  Vec3d Gp;
  Vec3d Gx;
  if (!registrationProcedure(aligned, reference, out.trans, params.adjustScale, &Gp, &Gx)) {
    return out;  // ok = false：退化
  }

  // 2) 变换过滤器（上游 ccPointPairRegistrationDlg.cpp:L1398 起）
  if (params.filters != SKIP_NONE) {
    filterTransformation(out.trans, params.filters, Gp, Gx, out.trans);
  }

  // 3) RMS 与逐对偏差（上游用 HornRegistrationTools::ComputeRMS + 表格逐对差值）
  out.ok = true;
  out.rms = computeRMS(aligned, reference, out.trans);
  for (std::size_t i = 0; i < n; ++i) {
    const Vec3d d = sub(reference[i], applyTransform(out.trans, aligned[i]));
    out.distances[i] = norm(d);
    out.deltas[i * 3 + 0] = d.x;
    out.deltas[i * 3 + 1] = d.y;
    out.deltas[i * 3 + 2] = d.z;
  }
  return out;
}

// ===========================================================================
// 6. KD 树（最近邻）与确定性随机降采样
// ===========================================================================

namespace {

/** 建树用的工作点（**坐标副本**：要随机访问且建树时 nth_element 会重排）。 */
struct KdPoint {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

inline double axisOf(const KdPoint& p, int axis) { return axis == 0 ? p.x : (axis == 1 ? p.y : p.z); }

/** KD 树节点；axis < 0 = 叶（点落在 points 的 [begin, end) 槽位区间）。 */
struct KdNode {
  std::uint32_t begin = 0;
  std::uint32_t end = 0;
  std::int32_t axis = -1;
  double split = 0.0;
  std::uint32_t left = 0;
  std::uint32_t right = 0;
};

/** 叶容量（与 euclidean-cluster 同一折中：树深 / 节点数 / 叶扫描量）。 */
constexpr std::uint32_t kLeafSize = 16;

/**
 * 静态 KD 树（最长轴中点分裂 / 叶 16 点 / 扁平节点表）——结构照抄
 * `native/euclidean-cluster/src/euclidean_cluster.cc` 的 KdTree，把半径查询换成**最近邻**。
 *
 * 建树一次性（模型云不动），每轮 ICP 的最近邻查询 ≈ 每点 50 次节点访问。
 */
class KdTree {
 public:
  /** 建树；会重排 pts（槽位号只在树内有效，本模块不需要回填原下标）。 */
  void build(std::vector<KdPoint>& pts) {
    nodes_.clear();
    const std::uint32_t n = static_cast<std::uint32_t>(pts.size());
    if (n == 0) return;
    nodes_.reserve(n / 4 + 4);
    buildRange(pts, 0, n);
  }

  /**
   * 最近邻查询。
   *
   * @param slot  [out] 最近点的槽位（`pts[slot]`）
   * @param dist2 [out] 最近距离的**平方**
   */
  void nearest(const std::vector<KdPoint>& pts, const Vec3d& q, std::uint32_t& slot, double& dist2) const {
    slot = 0;
    dist2 = std::numeric_limits<double>::infinity();
    searchNode(pts, 0, q, slot, dist2);
  }

  /**
   * k 近邻查询（GICP 的局部协方差用）。
   *
   * 定长"最差优先"池：池未满时 `worst2 = ∞`（不剪枝，必然找齐 k 个）；满 k 个后以池内最大距离平方
   * 当剪枝半径，回溯规则与 `searchNode` 同一套。距离是**平方**，且**顺序不保证**（调用方只拿它做
   * 均值 / 散布矩阵，与顺序无关）。
   *
   * @param outSlots [out] 槽位（点云不足 k 个时更少）
   * @param outDist2 [out] 与 outSlots 同长的距离**平方**
   */
  void nearestK(const std::vector<KdPoint>& pts, const Vec3d& q, std::uint32_t k,
                std::vector<std::uint32_t>& outSlots, std::vector<double>& outDist2) const {
    outSlots.clear();
    outDist2.clear();
    if (k == 0 || nodes_.empty()) return;
    outSlots.reserve(k);
    outDist2.reserve(k);
    double worst2 = std::numeric_limits<double>::infinity();
    searchNodeK(pts, 0, q, k, outSlots, outDist2, worst2);
  }

 private:
  std::uint32_t buildRange(std::vector<KdPoint>& pts, std::uint32_t begin, std::uint32_t end) {
    const std::uint32_t idx = static_cast<std::uint32_t>(nodes_.size());
    nodes_.emplace_back();
    nodes_[idx].begin = begin;
    nodes_[idx].end = end;
    if (end - begin <= kLeafSize) return idx;  // axis 保持 -1 = 叶

    double lo[3];
    double hi[3];
    lo[0] = hi[0] = pts[begin].x;
    lo[1] = hi[1] = pts[begin].y;
    lo[2] = hi[2] = pts[begin].z;
    for (std::uint32_t s = begin + 1; s < end; ++s) {
      const KdPoint& p = pts[s];
      if (p.x < lo[0]) lo[0] = p.x; else if (p.x > hi[0]) hi[0] = p.x;
      if (p.y < lo[1]) lo[1] = p.y; else if (p.y > hi[1]) hi[1] = p.y;
      if (p.z < lo[2]) lo[2] = p.z; else if (p.z > hi[2]) hi[2] = p.z;
    }
    int axis = 0;
    double best = -1.0;
    for (int a = 0; a < 3; ++a) {
      const double span = hi[a] - lo[a];
      if (span > best) {
        best = span;
        axis = a;
      }
    }
    // 全部点重合：中点分裂无意义，就地作叶（否则无限递归）
    if (best <= 0.0) return idx;

    const std::uint32_t mid = begin + (end - begin) / 2;
    std::nth_element(pts.begin() + begin, pts.begin() + mid, pts.begin() + end,
                     [axis](const KdPoint& a, const KdPoint& b) { return axisOf(a, axis) < axisOf(b, axis); });
    nodes_[idx].axis = axis;
    nodes_[idx].split = axisOf(pts[mid], axis);
    const std::uint32_t left = buildRange(pts, begin, mid);
    const std::uint32_t right = buildRange(pts, mid, end);
    nodes_[idx].left = left;
    nodes_[idx].right = right;
    return idx;
  }

  /** 先探近侧，再按 `d² < best²` 决定要不要回溯远侧（最近邻的标准剪枝）。 */
  void searchNode(const std::vector<KdPoint>& pts, std::uint32_t ni, const Vec3d& q, std::uint32_t& slot,
                  double& best2) const {
    const KdNode& n = nodes_[ni];
    if (n.axis < 0) {
      for (std::uint32_t s = n.begin; s < n.end; ++s) {
        const double dx = pts[s].x - q.x;
        const double dy = pts[s].y - q.y;
        const double dz = pts[s].z - q.z;
        const double d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best2) {
          best2 = d2;
          slot = s;
        }
      }
      return;
    }
    const double d = (n.axis == 0 ? q.x : (n.axis == 1 ? q.y : q.z)) - n.split;
    const std::uint32_t nearSide = d <= 0.0 ? n.left : n.right;
    const std::uint32_t farSide = d <= 0.0 ? n.right : n.left;
    searchNode(pts, nearSide, q, slot, best2);
    if (d * d < best2) searchNode(pts, farSide, q, slot, best2);
  }

  /** 往池里塞一个 (slot, d²)：未满直接塞（刚好塞满时刷新 worst2），满了则仅在更近时替换池内最差者。 */
  static void insertK(std::uint32_t slot, double d2, std::uint32_t k, std::vector<std::uint32_t>& slots,
                      std::vector<double>& dist2, double& worst2) {
    if (slots.size() < k) {
      slots.push_back(slot);
      dist2.push_back(d2);
      if (slots.size() == k) {
        worst2 = dist2[0];
        for (double v : dist2) worst2 = std::max(worst2, v);
      }
      return;
    }
    if (!(d2 < worst2)) return;  // 严格更近才替换（同 searchNode 的 d² < best² 语义）
    std::size_t worstIndex = 0;
    for (std::size_t i = 1; i < dist2.size(); ++i) {
      if (dist2[i] > dist2[worstIndex]) worstIndex = i;
    }
    slots[worstIndex] = slot;
    dist2[worstIndex] = d2;
    worst2 = dist2[0];
    for (double v : dist2) worst2 = std::max(worst2, v);
  }

  /** 与 `searchNode` 同构，只把判据从"当前最近距离"换成"池内最差距离"。 */
  void searchNodeK(const std::vector<KdPoint>& pts, std::uint32_t ni, const Vec3d& q, std::uint32_t k,
                   std::vector<std::uint32_t>& slots, std::vector<double>& dist2, double& worst2) const {
    const KdNode& n = nodes_[ni];
    if (n.axis < 0) {
      for (std::uint32_t s = n.begin; s < n.end; ++s) {
        const double dx = pts[s].x - q.x;
        const double dy = pts[s].y - q.y;
        const double dz = pts[s].z - q.z;
        insertK(s, dx * dx + dy * dy + dz * dz, k, slots, dist2, worst2);
      }
      return;
    }
    const double d = (n.axis == 0 ? q.x : (n.axis == 1 ? q.y : q.z)) - n.split;
    const std::uint32_t nearSide = d <= 0.0 ? n.left : n.right;
    const std::uint32_t farSide = d <= 0.0 ? n.right : n.left;
    searchNodeK(pts, nearSide, q, k, slots, dist2, worst2);
    if (d * d < worst2) searchNodeK(pts, farSide, q, k, slots, dist2, worst2);
  }

  std::vector<KdNode> nodes_;
};

/** 确定性 PRNG（xorshift64*）：**同一输入 + 同一种子逐位可复现**。 */
struct Rng {
  std::uint64_t state;

  explicit Rng(std::uint32_t seed)
      : state(seed != 0 ? 0x9E3779B97F4A7C15ULL * seed : 0x2545F4914F6CDD1DULL) {}

  std::uint64_t next() {
    state ^= state >> 12;
    state ^= state << 25;
    state ^= state >> 27;
    return state * 0x2545F4914F6CDD1DULL;
  }

  /** [0, bound) 上的整数（bound > 0；取高位以避开低位周期）。 */
  std::uint32_t bounded(std::uint32_t bound) { return static_cast<std::uint32_t>((next() >> 32) % bound); }
};

/** 单块候选数（带 index 时是 indexCount，否则是全量顶点数）。 */
inline std::uint32_t chunkCandidateCount(const ChunkSource& c) { return c.index ? c.indexCount : c.vertexCount; }

/**
 * 枚举各块候选、**不放回均匀抽至多 limit 个点**（蓄水池抽样 Algorithm R），写进 out。
 *
 * 上游走 `CloudSamplingTools::subsampleCloudRandomly`（CloudSamplingTools.cpp:L182）：建
 * 全量下标数组再随机删到 limit 个 —— 分布相同（均匀 limit 子集、无放回），但要 n 个
 * uint32 的内存（1 亿点 = 400 MB）。这里换成 O(limit) 内存的蓄水池。
 *
 * @return false = 契约违规（index 越界）
 */
bool collectSamples(const std::vector<ChunkSource>& chunks, std::uint32_t limit, Rng& rng,
                    std::vector<Vec3d>& out) {
  out.clear();
  if (limit == 0) return true;
  out.reserve(limit);
  std::uint32_t seen = 0;  // 已枚举的候选数
  for (const ChunkSource& c : chunks) {
    const std::uint32_t count = chunkCandidateCount(c);
    for (std::uint32_t k = 0; k < count; ++k) {
      const std::uint32_t vi = c.index ? c.index[k] : k;
      if (vi >= c.vertexCount) return false;  // 契约防御：不读越界内存
      const float* p = c.positions + static_cast<std::size_t>(vi) * 3;
      const Vec3d pt = vec(p[0], p[1], p[2]);
      if (out.size() < limit) {
        out.push_back(pt);
      } else {
        // 第 seen 个候选以 limit/(seen+1) 的概率替换池中随机一个
        const std::uint32_t r = rng.bounded(seen + 1);
        if (r < limit) out[r] = pt;
      }
      ++seen;
    }
  }
  return true;
}

/** 原地过滤三张并行数组（保留 dist ≤ 阈值者，顺序不变）。 */
void filterByDistanceInPlace(std::vector<Vec3d>& pts, std::vector<Vec3d>& cps, std::vector<double>& dist,
                            double maxDistance) {
  std::size_t w = 0;
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (dist[i] <= maxDistance) {
      pts[w] = pts[i];
      cps[w] = cps[i];
      dist[w] = dist[i];
      ++w;
    }
  }
  pts.resize(w);
  cps.resize(w);
  dist.resize(w);
}

/** 筛出子集写进另一组数组（重叠度过滤是"临时替换、之后还原"，不能动原数组）。 */
void selectByDistance(const std::vector<Vec3d>& pts, const std::vector<Vec3d>& cps, const std::vector<double>& dist,
                      double maxDistance, std::vector<Vec3d>& outPts, std::vector<Vec3d>& outCps,
                      std::vector<double>& outDist) {
  outPts.clear();
  outCps.clear();
  outDist.clear();
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (dist[i] <= maxDistance) {
      outPts.push_back(pts[i]);
      outCps.push_back(cps[i]);
      outDist.push_back(dist[i]);
    }
  }
}

}  // namespace

// ===========================================================================
// 7. ICP 主循环（上游 ICPRegistrationTools::Register，RegistrationTools.cpp:L147）
// ===========================================================================

IcpOutput icp(const std::vector<ChunkSource>& dataChunks, const std::vector<ChunkSource>& modelChunks,
              const IcpParams& params) {
  IcpOutput out;

  // ---- 参数校验（上游靠 assert / 隐式行为；这里显式挡掉会算出垃圾值的输入）----
  if (!(params.finalOverlapRatio > 0.0 && params.finalOverlapRatio <= 1.0)) {
    out.result = ICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (params.samplingLimit < 3) {
    out.result = ICP_ERROR_INVALID_INPUT;
    return out;
  }

  // ---- 采样（上游 L170-322）----
  // data 的上限随重叠度放大：过滤会永久收缩 data 集合，要保证收缩后仍有 samplingLimit 个点
  const std::uint32_t dataLimit = params.finalOverlapRatio != 1.0
                                      ? static_cast<std::uint32_t>(params.samplingLimit / params.finalOverlapRatio)
                                      : params.samplingLimit;
  Rng rng(params.seed);

  std::vector<Vec3d> dataPts;
  if (!collectSamples(dataChunks, dataLimit, rng, dataPts)) {
    out.result = ICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (dataPts.empty()) {
    out.result = ICP_NOTHING_TO_DO;  // 上游 L176：数据云为空
    return out;
  }

  std::vector<Vec3d> modelPts;
  if (!collectSamples(modelChunks, params.samplingLimit, rng, modelPts)) {
    out.result = ICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (modelPts.empty()) {
    out.result = ICP_ERROR_INVALID_INPUT;  // 上游 L275：模型云为空
    return out;
  }

  // 模型 KD 树（模型不动，建一次）
  std::vector<KdPoint> modelTreePts;
  modelTreePts.reserve(modelPts.size());
  for (const Vec3d& p : modelPts) {
    modelTreePts.push_back(KdPoint{p.x, p.y, p.z});
  }
  KdTree tree;
  tree.build(modelTreePts);

  // ---- 部分重叠（上游 L324-341）----
  unsigned maxOverlapCount = 0;
  if (params.finalOverlapRatio < 1.0) {
    maxOverlapCount = static_cast<unsigned>(params.finalOverlapRatio * static_cast<double>(dataPts.size()));
    if (maxOverlapCount == 0) maxOverlapCount = 1;  // 上游此处 assert != 0
  }

  // 最近点集（CPSet）+ 距离；等价于上游 L363-397 的首次 computeCloud2CloudDistances
  std::vector<Vec3d> dataCp(dataPts.size());
  std::vector<double> dataDist(dataPts.size());
  auto refreshNearest = [&tree, &modelTreePts](const std::vector<Vec3d>& pts, std::vector<Vec3d>& cps,
                                               std::vector<double>& dist) {
    for (std::size_t i = 0; i < pts.size(); ++i) {
      std::uint32_t slot = 0;
      double d2 = 0.0;
      tree.nearest(modelTreePts, pts[i], slot, d2);
      cps[i] = vec(modelTreePts[slot].x, modelTreePts[slot].y, modelTreePts[slot].z);
      dist[i] = std::sqrt(d2);
    }
  };
  refreshNearest(dataPts, dataCp, dataDist);

  // ---- 主循环（上游 L408-979）----
  Transform transform;     // 总变换（rValid == false = "不动"）
  Transform currentTrans;  // 每轮增量
  double lastStepRMS = -1.0;
  double initialRMS = -1.0;  // 第 0 轮算出的 RMS（面板"初始 RMS → 最终 RMS"用；**不是** lastStepRMS）
  double finalRMS = -1.0;
  unsigned finalPointCount = 0;
  int result = ICP_ERROR;
  unsigned iteration = 0;

  for (iteration = 0;; ++iteration) {
    // ===== A. 剔除最远点（上游 L421-532；在 RMS 块之前）=====
    if (params.filterOutFarthestPoints) {
      double mu = 0.0;
      double sigma2 = 0.0;
      if (distanceDistribution(dataDist, mu, sigma2)) {
        const double maxDistance = mu + 2.5 * std::sqrt(sigma2);
        // 上游这里换装新的 ReferenceCloud；我们原地过滤（差异：保留各自的旧距离，
        // 上游那张新云没有距离标量场 —— 两者同时开启时上游读的是未初始化值，见 README-REF）
        filterByDistanceInPlace(dataPts, dataCp, dataDist, maxDistance);
      }
    }

    // ===== B. 部分重叠过滤（上游 L534-636；**临时**替换，解完一轮后还原）=====
    std::vector<Vec3d> truePts;
    std::vector<Vec3d> trueCp;
    std::vector<double> trueDist;
    bool overlapFiltered = false;
    if (maxOverlapCount != 0 && dataPts.size() > maxOverlapCount) {
      std::vector<double> sorted(dataDist);
      std::nth_element(sorted.begin(), sorted.begin() + (maxOverlapCount - 1), sorted.end());
      const double maxOverlapDist = sorted[maxOverlapCount - 1];
      selectByDistance(dataPts, dataCp, dataDist, maxOverlapDist, truePts, trueCp, trueDist);
      dataPts.swap(truePts);
      dataCp.swap(trueCp);
      dataDist.swap(trueDist);
      overlapFiltered = true;
    }

    // ===== C. RMS 块（上游 L723-866）=====
    {
      // 无权重通道 ⇒ wi ≡ 1，wiSum = n（上游的加权 RMS 退化成普通 RMS）
      double meanSquareValue = 0.0;
      for (double d : dataDist) meanSquareValue += d * d;
      const double wiSum = static_cast<double>(dataDist.size());
      const double rms = std::sqrt(wiSum != 0.0 ? meanSquareValue / wiSum : 0.0);

      if (iteration == 0) {
        finalRMS = rms;
        initialRMS = rms;
        finalPointCount = static_cast<unsigned>(dataDist.size());
        if (lessThanEpsilon(rms)) {
          result = ICP_NOTHING_TO_DO;  // 两片云已经重合
          break;
        }
      } else {
        if (rms > lastStepRMS) {
          // 误差反弹 ⇒ 保留上一轮的变换（此时 `transform` 恰好还没把本轮增量并进去）
          result = (iteration == 1) ? ICP_NOTHING_TO_DO : ICP_APPLY_TRANSFO;
          break;
        }
        const double deltaRMS = lastStepRMS - rms;

        // 把**上一轮**解出的 currentTrans 并入总变换（上游 L802-828）
        if (currentTrans.rValid) {
          if (transform.rValid) {
            transform.R = matrixMul(currentTrans.R, transform.R);
          } else {
            transform.R = currentTrans.R;
          }
          transform.rValid = true;
          transform.T = matrixApply(currentTrans.R, transform.T);
        }

        if (params.adjustScale) {
          double newScale = transform.s * currentTrans.s;
          if (std::isfinite(params.minScale)) newScale = std::max(newScale, params.minScale);
          if (std::isfinite(params.maxScale)) newScale = std::min(newScale, params.maxScale);
          transform.T = mul(transform.T, newScale / transform.s);
          transform.s = newScale;
        }

        transform.T = add(transform.T, currentTrans.T);

        finalRMS = rms;
        finalPointCount = static_cast<unsigned>(dataDist.size());

        // 停止判据：上游按 convType 二选一，本实现取**并集**（任一满足即停，见 README-REF）
        if (deltaRMS < params.minRMSDecrease || iteration >= params.maxIterations) {
          result = ICP_APPLY_TRANSFO;
          break;
        }
      }

      lastStepRMS = rms;
    }

    // ===== D. 解算这一轮的增量变换（上游 L868-882）=====
    currentTrans = Transform();
    Vec3d dataGravityCenter;
    Vec3d modelGravityCenter;
    if (!registrationProcedure(dataPts, dataCp, currentTrans, params.adjustScale, &dataGravityCenter,
                               &modelGravityCenter)) {
      result = ICP_ERROR_REGISTRATION_STEP;
      break;
    }

    // 还原重叠度过滤（上游 L884-895：真身换回来）
    if (overlapFiltered) {
      dataPts.swap(truePts);
      dataCp.swap(trueCp);
      dataDist.swap(trueDist);
    }

    // ===== E. 过滤器（上游 L897-906）=====
    if (params.transformationFilters != SKIP_NONE) {
      filterTransformation(currentTrans, params.transformationFilters, dataGravityCenter, modelGravityCenter,
                          currentTrans);
    }

    // ===== F. 移动数据点（上游 L908-943）=====
    // 上游分两条分支：重建新的 rotatedCloud（点序变了时）或原地 apply 到旧 rotatedCloud。
    // 两者对"当前 data 集合"的效果都是 `各点 = currentTrans.apply(旧位置)`，故这里直接一个循环
    // ——顺带消掉了上游"原地 apply 会累积 float 误差"的问题（我们恒按原值算，且是 double）。
    for (Vec3d& p : dataPts) {
      p = applyTransform(currentTrans, p);
    }

    // ===== G. 重算最近邻与距离（上游 L945-978）=====
    refreshNearest(dataPts, dataCp, dataDist);
  }

  out.result = result;
  out.rms = finalRMS;
  out.initialRms = initialRMS;
  out.pointCount = finalPointCount;
  out.iterations = iteration;
  out.trans = transform;
  return out;
}

// ===========================================================================
// 8. GICP 主循环（Generalized-ICP，Segal/Haehnel/Thrun RSS 2009）
//
// 与 ICP 的差别**只有"怎么用对应点"**：对应点仍取欧氏最近邻（不是马氏 —— 马氏只进目标函数），
// 但每轮的增量由协方差加权的马氏距离最小化解出。其余（参数校验 / 采样 / 重叠度裁剪 / 剔除最远点 /
// 过滤器 / RMS 与停止判据 / 结果码）逐段镜像 `icp()`，连变量名都对齐，便于两处对照阅读。
// 与 PCL / 上游的差异清单见 README-REF.md。
// ===========================================================================
// 注：本段与上面的 ICP 同在文件开头那个 `namespace registration` 里（不再重开），
// 只是另起一个匿名命名空间放 GICP 自己的辅助。
// ===========================================================================

namespace {

/**
 * GICP 的一轮状态：数据点（当前帧）+ 其协方差 + 对应点 + 对应点协方差 + **点到点**距离。
 *
 * 五条数组恒等长且同序，裁剪 / 过滤必须一起搬 —— ICP 那套 `filterByDistanceInPlace` /
 * `selectByDistance` 只管三条数组，故这里另起一对（**不动** ICP 在用的那两个函数）。
 */
struct GicpState {
  std::vector<Vec3d> pts;
  std::vector<Mat3d> ptsCov;
  std::vector<Vec3d> cps;
  std::vector<Mat3d> cpCov;
  std::vector<double> dist;
};

/** Vec3d → KdPoint 坐标副本（KD 树建在副本上：建树会 nth_element 重排数组）。 */
std::vector<KdPoint> toKdPoints(const std::vector<Vec3d>& pts) {
  std::vector<KdPoint> out;
  out.reserve(pts.size());
  for (const Vec3d& p : pts) out.push_back(KdPoint{p.x, p.y, p.z});
  return out;
}

/** 原地过滤五条并行数组（保留 `dist ≤ maxDistance` 的对应，顺序不变）。 */
void trimGicpState(GicpState& s, double maxDistance) {
  std::size_t w = 0;
  for (std::size_t i = 0; i < s.pts.size(); ++i) {
    if (s.dist[i] > maxDistance) continue;
    s.pts[w] = s.pts[i];
    s.ptsCov[w] = s.ptsCov[i];
    s.cps[w] = s.cps[i];
    s.cpCov[w] = s.cpCov[i];
    s.dist[w] = s.dist[i];
    ++w;
  }
  s.pts.resize(w);
  s.ptsCov.resize(w);
  s.cps.resize(w);
  s.cpCov.resize(w);
  s.dist.resize(w);
}

/** 筛出子集写进 out（重叠度过滤是"临时替换、之后还原"，故不原地做）。 */
void selectGicpState(const GicpState& s, double maxDistance, GicpState& out) {
  out.pts.clear();
  out.ptsCov.clear();
  out.cps.clear();
  out.cpCov.clear();
  out.dist.clear();
  for (std::size_t i = 0; i < s.pts.size(); ++i) {
    if (s.dist[i] > maxDistance) continue;
    out.pts.push_back(s.pts[i]);
    out.ptsCov.push_back(s.ptsCov[i]);
    out.cps.push_back(s.cps[i]);
    out.cpCov.push_back(s.cpCov[i]);
    out.dist.push_back(s.dist[i]);
  }
}

/**
 * 刷新最近邻（**欧氏**最近邻，KD 树）—— 顺带把目标侧协方差按**槽位**取出来
 * （模型侧协方差就是按重排后的数组算的，见 `estimateCovariances` 的调用处）。
 *
 * 距离一律是点到点，RMS 与停止判据因此与 ICP 可比（马氏只进解算与 `covarianceError`）。
 */
void refreshGicpNearest(GicpState& s, const KdTree& tree, const std::vector<KdPoint>& treePts,
                        const std::vector<Mat3d>& treeCov) {
  for (std::size_t i = 0; i < s.pts.size(); ++i) {
    std::uint32_t slot = 0;
    double d2 = 0.0;
    tree.nearest(treePts, s.pts[i], slot, d2);
    s.cps[i] = vec(treePts[slot].x, treePts[slot].y, treePts[slot].z);
    s.cpCov[i] = treeCov[slot];
    s.dist[i] = std::sqrt(d2);
  }
}

/** 平面化正则化替换用的特征值：沿法向 ε、沿切平面 1（PCL `GICP` 的 `diag(ε,1,1)` 约定）。 */
constexpr double kCovarianceEpsilon = 1.0e-3;

/** 构成散布矩阵所需的最少邻居数（少于 3 个点谈不上"平面"）。 */
constexpr std::uint32_t kMinCovarianceNeighbors = 3;

/** 散布矩阵（无偏，1/(n−1)）。 */
Mat3d scatterMatrix(const std::vector<Vec3d>& pts, const Vec3d& mean) {
  Mat3d cov;
  for (const Vec3d& p : pts) {
    const Vec3d d = sub(p, mean);
    cov.m[0][0] += d.x * d.x;
    cov.m[0][1] += d.x * d.y;
    cov.m[0][2] += d.x * d.z;
    cov.m[1][1] += d.y * d.y;
    cov.m[1][2] += d.y * d.z;
    cov.m[2][2] += d.z * d.z;
  }
  cov.m[1][0] = cov.m[0][1];
  cov.m[2][0] = cov.m[0][2];
  cov.m[2][1] = cov.m[1][2];
  return scaledMatrix(cov, 1.0 / static_cast<double>(pts.size() - 1));
}

/**
 * 平面化：特征值**升序排序**后替换为 `(ε, 1, 1)`，再重组 `Σ λ'ⱼ·vⱼvⱼᵀ`（经典 GICP 的面到面权重）。
 *
 * ⚠ 两处约定别记反（`jacobiEigenValuesAndVectors` 的注释里有）：**特征值不排序**（升序得自己排，
 * 否则"最小特征值 = 法向"会取错轴），且**特征向量是列**（`v[i][j]` 的第 j 列才是第 j 个特征向量）。
 */
Mat3d planarizeCovariance(const Mat3d& cov) {
  double a[3][3] = {{cov.m[0][0], cov.m[0][1], cov.m[0][2]},
                    {cov.m[1][0], cov.m[1][1], cov.m[1][2]},
                    {cov.m[2][0], cov.m[2][1], cov.m[2][2]}};
  double v[3][3] = {};
  double d[3] = {};
  if (!jacobiEigenValuesAndVectors<3>(a, v, d)) return cov;  // 分解失败：按原样用（仍是合法协方差）
  // 3 元排序网络：i0 ≤ i1 ≤ i2（特征值升序的下标）
  int i0 = 0;
  int i1 = 1;
  int i2 = 2;
  if (d[i0] > d[i1]) {
    const int t = i0;
    i0 = i1;
    i1 = t;
  }
  if (d[i1] > d[i2]) {
    const int t = i1;
    i1 = i2;
    i2 = t;
  }
  if (d[i0] > d[i1]) {
    const int t = i0;
    i0 = i1;
    i1 = t;
  }
  const int order[3] = {i0, i1, i2};
  const double lambda[3] = {kCovarianceEpsilon, 1.0, 1.0};
  Mat3d out;
  for (int j = 0; j < 3; ++j) {
    const int src = order[j];
    for (int r = 0; r < 3; ++r) {
      for (int c = 0; c < 3; ++c) out.m[r][c] += lambda[j] * v[r][src] * v[c][src];
    }
  }
  return out;
}

/** 3x3 行列式的**相对**下限（见 `inverse3`）。 */
constexpr double kRelativeDeterminantEpsilon = 1.0e-12;

/**
 * 3x3 求逆（伴随矩阵 / 行列式）。
 *
 * 奇异判据用**相对**量：`|det|` 与"同迹的各向同性矩阵"的行列式 `(tr/3)³` 比 —— 绝对阈值会把
 * 小尺度点云的合法协方差（元素 ~1e-4，det ~1e-12）整片判死。判死即跳过该对应点（见 README-REF）。
 */
bool inverse3(const Mat3d& m, Mat3d& out) {
  const double c00 = m.m[1][1] * m.m[2][2] - m.m[1][2] * m.m[2][1];
  const double c01 = m.m[1][2] * m.m[2][0] - m.m[1][0] * m.m[2][2];
  const double c02 = m.m[1][0] * m.m[2][1] - m.m[1][1] * m.m[2][0];
  const double det = m.m[0][0] * c00 + m.m[0][1] * c01 + m.m[0][2] * c02;
  const double traceThird = (m.m[0][0] + m.m[1][1] + m.m[2][2]) / 3.0;
  if (!(traceThird > 0.0)) return false;
  if (!(std::abs(det) > kRelativeDeterminantEpsilon * traceThird * traceThird * traceThird)) return false;
  const double inv = 1.0 / det;
  out.m[0][0] = c00 * inv;
  out.m[0][1] = (m.m[0][2] * m.m[2][1] - m.m[0][1] * m.m[2][2]) * inv;
  out.m[0][2] = (m.m[0][1] * m.m[1][2] - m.m[0][2] * m.m[1][1]) * inv;
  out.m[1][0] = c01 * inv;
  out.m[1][1] = (m.m[0][0] * m.m[2][2] - m.m[0][2] * m.m[2][0]) * inv;
  out.m[1][2] = (m.m[0][2] * m.m[1][0] - m.m[0][0] * m.m[1][2]) * inv;
  out.m[2][0] = c02 * inv;
  out.m[2][1] = (m.m[0][1] * m.m[2][0] - m.m[0][0] * m.m[2][1]) * inv;
  out.m[2][2] = (m.m[0][0] * m.m[1][1] - m.m[0][1] * m.m[1][0]) * inv;
  return true;
}

/**
 * 逐点局部协方差（GICP 的输入）：每个查询点在 `tree` 里取近邻做 PCA。
 *
 * - 取 `k + 1` 个近邻并**丢掉 d² == 0 的那些**（含查询点自身；顺带把重合点一并排除）——
 *   剩下不足 `kMinCovarianceNeighbors` 个时该点**保持单位阵**，它的对应因此退化成等权的点到点。
 * - `regularize` 为真走 `planarizeCovariance`（经典 GICP）；为假用原始散布矩阵（对照用，可能病态）。
 *
 * @param queryPts 逐点查询（**输出顺序 = 本数组顺序**）
 * @param treePts  必须与 `tree` 建树时用的那份数组一致（`build()` 会重排它）
 */
void estimateCovariances(const std::vector<KdPoint>& queryPts, const std::vector<KdPoint>& treePts,
                         const KdTree& tree, std::uint32_t k, bool regularize, std::vector<Mat3d>& out) {
  out.assign(queryPts.size(), identity3());
  std::vector<std::uint32_t> slots;
  std::vector<double> dist2;
  std::vector<Vec3d> neighbors;
  for (std::size_t i = 0; i < queryPts.size(); ++i) {
    const Vec3d q = vec(queryPts[i].x, queryPts[i].y, queryPts[i].z);
    tree.nearestK(treePts, q, k + 1, slots, dist2);
    neighbors.clear();
    for (std::size_t s = 0; s < slots.size(); ++s) {
      if (!(dist2[s] > 0.0)) continue;  // 自身 / 重合点：不参与散布
      const KdPoint& p = treePts[slots[s]];
      neighbors.push_back(vec(p.x, p.y, p.z));
    }
    if (neighbors.size() < kMinCovarianceNeighbors) continue;  // 邻居太少：保持单位阵
    const Mat3d cov = scatterMatrix(neighbors, gravityCenter(neighbors));
    out[i] = regularize ? planarizeCovariance(cov) : cov;
  }
}

/** 6x6 解算里视为秩亏的特征值下限（相对 λmax）。 */
constexpr double kSolveEigenTolerance = 1.0e-10;

/** ω 的模小于它时直接取单位阵（避免轴角的 0/0 与无意义的旋转）。 */
constexpr double kMinAxisAngle = 1.0e-12;

/**
 * 解 6x6 对称系统 `A x = b`（GICP 的正规方程）。
 *
 * ① 对称化（组装时的舍入会让上下三角差 1 ulp）；
 * ② **对称对角预缩放** `(D A D) y = D b`（`D = diag(1/√Aᵢᵢ)`）：旋转块 ~|a|² 与平移块 ~1 的量级差
 *    会把 Jacobi 的收敛判据整个带偏，缩放后两块同量级；解完 `x = D y` 还原；
 * ③ `jacobiEigenValuesAndVectors<6>` 特征分解做**伪逆**（特征值 < `1e-10·λmax` 的方向丢弃），
 *    `rank < 6` 即返回 false —— 秩亏意味着这个位姿差下解不出可信的 6 自由度。
 */
bool solve6x6(double a[6][6], const double b[6], double x[6]) {
  double rhs[6] = {};
  for (int i = 0; i < 6; ++i) rhs[i] = b[i];

  for (int r = 0; r < 6; ++r) {
    for (int c = r + 1; c < 6; ++c) {
      const double half = 0.5 * (a[r][c] + a[c][r]);
      a[r][c] = half;
      a[c][r] = half;
    }
  }

  double dScale[6] = {};
  for (int i = 0; i < 6; ++i) {
    if (!(a[i][i] > 0.0)) return false;
    dScale[i] = 1.0 / std::sqrt(a[i][i]);
  }
  for (int r = 0; r < 6; ++r) {
    for (int c = 0; c < 6; ++c) a[r][c] *= dScale[r] * dScale[c];
    rhs[r] *= dScale[r];
  }

  double v[6][6] = {};
  double lambda[6] = {};
  if (!jacobiEigenValuesAndVectors<6>(a, v, lambda)) return false;
  double maxAbs = 0.0;
  for (int i = 0; i < 6; ++i) maxAbs = std::max(maxAbs, std::abs(lambda[i]));
  if (!(maxAbs > 0.0)) return false;

  const double tolerance = kSolveEigenTolerance * maxAbs;
  double y[6] = {};
  int rank = 0;
  for (int j = 0; j < 6; ++j) {
    if (std::abs(lambda[j]) <= tolerance) continue;  // 秩亏方向：丢弃（**特征向量是列**）
    ++rank;
    double proj = 0.0;
    for (int i = 0; i < 6; ++i) proj += v[i][j] * rhs[i];
    const double coeff = proj / lambda[j];
    for (int i = 0; i < 6; ++i) y[i] += coeff * v[i][j];
  }
  if (rank < 6) return false;

  for (int i = 0; i < 6; ++i) x[i] = y[i] * dScale[i];  // x = D y（缩放还原）
  return true;
}

/**
 * 解一轮增量变换（GICP 的目标函数，Segal 2009 式 (10)-(13)）。
 *
 * 在**数据重心系**里线性化（`R ≈ I + [ω]×`，`aᵢ` 取相对重心的位置），
 * 最小化 `Σ (dᵢ + Axᵢ·ω − t̃)ᵀ Ωᵢ (dᵢ + Axᵢ·ω − t̃)`，正规方程 `A x = b`（`x = (ω, t̃)`）：
 * ```
 * A(0:3,0:3) = Σ AxᵀΩAx    A(0:3,3:6) = −Σ AxᵀΩ      b(0:3) = −Σ AxᵀΩd
 * A(3:6,0:3) = −Σ ΩAx      A(3:6,3:6) =  Σ Ω        b(3:6) =  Σ Ωd
 * ```
 * `Ax = skew(aᵢ − g)`（`Ax·v = (aᵢ−g) × v`）、`dᵢ = 对应点 − aᵢ`、`Ωᵢ = (C_target + C_data)⁻¹`
 * ——数据侧协方差必须是**当前帧**的（调用方在每轮移动点之后同步旋转它）。
 *
 * 解完折回本模块的变换约定：`R_inc = exp([ω]×)`、`T_inc = g + t̃ − R_inc·g`
 * ——即 `P' = R_inc·(P − g) + g + t̃`，重心系的原点正是 `g`。
 *
 * @param g      [out] 数据重心（同时当 `filterTransformation` 的 `toBeAlignedGravityCenter`）
 * @param modelG [out] 对应点重心（同上的 `referenceGravityCenter`）
 * @return false = 有效对应不足 / 系统秩亏（⇒ `GICP_ERROR_REGISTRATION_STEP`）
 */
bool gicpSolveStep(const GicpState& s, Transform& out, Vec3d& g, Vec3d& modelG) {
  if (s.pts.size() < kMinCovarianceNeighbors) return false;
  g = gravityCenter(s.pts);
  modelG = gravityCenter(s.cps);

  double a[6][6] = {};
  double b[6] = {};
  std::size_t used = 0;
  for (std::size_t i = 0; i < s.pts.size(); ++i) {
    Mat3d omega;
    if (!inverse3(matrixAdd(s.cpCov[i], s.ptsCov[i]), omega)) continue;  // 病态：该对应点不参与
    const Vec3d ai = sub(s.pts[i], g);
    const Vec3d dd = sub(s.cps[i], s.pts[i]);
    // Ax = [ai]×（Ax·v = ai × v）
    Mat3d ax;
    ax.m[0][1] = -ai.z;
    ax.m[0][2] = ai.y;
    ax.m[1][0] = ai.z;
    ax.m[1][2] = -ai.x;
    ax.m[2][0] = -ai.y;
    ax.m[2][1] = ai.x;
    const Mat3d omegaAx = matrixMul(omega, ax);     // Ω·Ax
    const Mat3d axTOmega = transposed(omegaAx);     // (Ω·Ax)ᵀ = Axᵀ·Ω（Ω 对称）
    const Mat3d block11 = matrixMul(axTOmega, ax);  // AxᵀΩAx
    const Vec3d axTOmegaD = matrixApply(axTOmega, dd);
    const Vec3d omegaD = matrixApply(omega, dd);
    for (int r = 0; r < 3; ++r) {
      for (int c = 0; c < 3; ++c) {
        a[r][c] += block11.m[r][c];
        a[r][c + 3] -= axTOmega.m[r][c];
        a[r + 3][c] -= omegaAx.m[r][c];
        a[r + 3][c + 3] += omega.m[r][c];
      }
    }
    b[0] -= axTOmegaD.x;
    b[1] -= axTOmegaD.y;
    b[2] -= axTOmegaD.z;
    b[3] += omegaD.x;
    b[4] += omegaD.y;
    b[5] += omegaD.z;
    ++used;
  }
  if (used < kMinCovarianceNeighbors) return false;

  double x[6] = {};
  if (!solve6x6(a, b, x)) return false;

  // ω → 旋转矩阵（轴角 → 四元数 → fromQuaternion；ω ≈ 0 时就是单位阵）
  const Vec3d omega = vec(x[0], x[1], x[2]);
  const Vec3d tTilde = vec(x[3], x[4], x[5]);
  const double theta = norm(omega);
  Mat3d rInc = identity3();
  if (theta > kMinAxisAngle) {
    const double half = 0.5 * theta;
    const double scale = std::sin(half) / theta;
    const double q[4] = {std::cos(half), omega.x * scale, omega.y * scale, omega.z * scale};
    rInc = fromQuaternion(q);
  }

  const Vec3d rg = matrixApply(rInc, g);
  out = Transform();
  out.R = rInc;
  out.T = sub(add(g, tTilde), rg);  // T_inc = g + t̃ − R_inc·g
  out.s = 1.0;
  out.rValid = true;
  return true;
}

}  // namespace

GicpOutput gicp(const std::vector<ChunkSource>& dataChunks, const std::vector<ChunkSource>& modelChunks,
                const GicpParams& params) {
  GicpOutput out;

  // ---- 参数校验（与 ICP 同：显式挡掉会算出垃圾值的输入）----
  if (!(params.finalOverlapRatio > 0.0 && params.finalOverlapRatio <= 1.0)) {
    out.result = GICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (params.samplingLimit < 3) {
    out.result = GICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (params.correspondenceRandomness < kMinCovarianceNeighbors) {
    out.result = GICP_ERROR_INVALID_INPUT;  // 邻居不足 3 个构不成散布矩阵
    return out;
  }

  // ---- 采样（同 ICP）----
  const std::uint32_t dataLimit = params.finalOverlapRatio != 1.0
                                      ? static_cast<std::uint32_t>(params.samplingLimit / params.finalOverlapRatio)
                                      : params.samplingLimit;
  Rng rng(params.seed);

  std::vector<Vec3d> dataPts;
  if (!collectSamples(dataChunks, dataLimit, rng, dataPts)) {
    out.result = GICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (dataPts.empty()) {
    out.result = GICP_NOTHING_TO_DO;
    return out;
  }
  std::vector<Vec3d> modelPts;
  if (!collectSamples(modelChunks, params.samplingLimit, rng, modelPts)) {
    out.result = GICP_ERROR_INVALID_INPUT;
    return out;
  }
  if (modelPts.empty()) {
    out.result = GICP_ERROR_INVALID_INPUT;
    return out;
  }

  unsigned maxOverlapCount = 0;
  if (params.finalOverlapRatio < 1.0) {
    maxOverlapCount = static_cast<unsigned>(params.finalOverlapRatio * static_cast<double>(dataPts.size()));
    if (maxOverlapCount == 0) maxOverlapCount = 1;
  }

  // ---- 模型侧：KD 树（建一次）+ **槽位序**协方差 ----
  // `KdTree::build` 会 nth_element 重排数组，槽位号只在树内有效；对应点的协方差是按槽位取的，
  // 故模型协方差必须与重排后的那份数组同序（查询数组就直接用重排后的数组本身）。
  std::vector<KdPoint> modelTreePts = toKdPoints(modelPts);
  KdTree tree;
  tree.build(modelTreePts);
  std::vector<Mat3d> modelCov;
  estimateCovariances(modelTreePts, modelTreePts, tree, params.correspondenceRandomness,
                      params.useNormalCovariance, modelCov);

  // ---- 数据侧：**另建一棵树**（建在副本上，故 `dataPts` 的循环序不受影响），协方差存**原序** ----
  std::vector<Mat3d> dataCov;
  {
    std::vector<KdPoint> dataQueryPts = toKdPoints(dataPts);
    std::vector<KdPoint> dataTreePts = dataQueryPts;  // 建树会重排它，故查询用另一份副本
    KdTree dataTree;
    dataTree.build(dataTreePts);
    estimateCovariances(dataQueryPts, dataTreePts, dataTree, params.correspondenceRandomness,
                        params.useNormalCovariance, dataCov);
  }  // 数据侧的树与坐标副本到此用完（逐轮只需模型侧那棵）

  // 一轮状态（首次最近邻 + 距离，等价于 ICP 的首次 computeCloud2CloudDistances）
  GicpState state;
  state.pts = std::move(dataPts);
  state.ptsCov = std::move(dataCov);
  state.cps.resize(state.pts.size());
  state.cpCov.resize(state.pts.size());
  state.dist.resize(state.pts.size());
  refreshGicpNearest(state, tree, modelTreePts, modelCov);

  // ---- 主循环（逐段镜像 icp()）----
  Transform transform;     // 总变换（rValid == false = "不动"）
  Transform currentTrans;  // 每轮增量
  double lastStepRMS = -1.0;
  double initialRMS = -1.0;  // 第 0 轮算出的 RMS（面板"初始 RMS → 最终 RMS"用；**不是** lastStepRMS）
  double finalRMS = -1.0;
  double finalCovarianceError = 0.0;
  unsigned finalPointCount = 0;
  int result = GICP_ERROR;
  unsigned iteration = 0;

  for (iteration = 0;; ++iteration) {
    // ===== A. 剔除最远点（同 ICP；在 RMS 块之前）=====
    if (params.filterOutFarthestPoints) {
      double mu = 0.0;
      double sigma2 = 0.0;
      if (distanceDistribution(state.dist, mu, sigma2)) {
        trimGicpState(state, mu + 2.5 * std::sqrt(sigma2));
      }
    }

    // ===== B. 部分重叠过滤（**临时**替换，解完一轮后还原）=====
    GicpState trimmed;
    bool overlapFiltered = false;
    if (maxOverlapCount != 0 && state.pts.size() > maxOverlapCount) {
      std::vector<double> sorted(state.dist);
      std::nth_element(sorted.begin(), sorted.begin() + (maxOverlapCount - 1), sorted.end());
      selectGicpState(state, sorted[maxOverlapCount - 1], trimmed);
      state.pts.swap(trimmed.pts);
      state.ptsCov.swap(trimmed.ptsCov);
      state.cps.swap(trimmed.cps);
      state.cpCov.swap(trimmed.cpCov);
      state.dist.swap(trimmed.dist);
      overlapFiltered = true;
    }

    // ===== C. RMS 块（同 ICP；外加马氏残差，两者同一次遍历）=====
    {
      double meanSquareValue = 0.0;
      for (double d : state.dist) meanSquareValue += d * d;
      const double wiSum = static_cast<double>(state.dist.size());
      const double rms = std::sqrt(wiSum != 0.0 ? meanSquareValue / wiSum : 0.0);

      // covarianceError = 最终保留点集上逐点马氏距离的 RMS（GICP 目标函数的开方值）。
      // 顺手在这里算：O(N) 的 3x3 求逆 + 二次型，比收尾再单独暴力重扫一遍便宜得多，且与 RMS 恒同步。
      // 分母是**真正参与**的点数（与解算同一把闸门：Ω 求不出来的点本就不在 GICP 的目标里）。
      double mahalanobisSum = 0.0;
      std::size_t mahalanobisCount = 0;
      for (std::size_t i = 0; i < state.pts.size(); ++i) {
        Mat3d omega;
        if (!inverse3(matrixAdd(state.cpCov[i], state.ptsCov[i]), omega)) continue;
        const Vec3d d = sub(state.cps[i], state.pts[i]);
        mahalanobisSum += dot(d, matrixApply(omega, d));
        ++mahalanobisCount;
      }
      const double covarianceError =
          std::sqrt(mahalanobisCount != 0 ? mahalanobisSum / static_cast<double>(mahalanobisCount) : 0.0);

      if (iteration == 0) {
        finalRMS = rms;
        initialRMS = rms;
        finalPointCount = static_cast<unsigned>(state.dist.size());
        finalCovarianceError = covarianceError;
        if (lessThanEpsilon(rms)) {
          result = GICP_NOTHING_TO_DO;  // 两片云已经重合
          break;
        }
      } else {
        if (rms > lastStepRMS) {
          // 误差反弹 ⇒ 保留上一轮的变换（此时 `transform` 恰好还没把本轮增量并进去）
          result = (iteration == 1) ? GICP_NOTHING_TO_DO : GICP_APPLY_TRANSFO;
          break;
        }
        const double deltaRMS = lastStepRMS - rms;

        // 把**上一轮**解出的 currentTrans 并入总变换（同 ICP；GICP 无缩放，故没有 adjustScale 段）
        if (currentTrans.rValid) {
          if (transform.rValid) {
            transform.R = matrixMul(currentTrans.R, transform.R);
          } else {
            transform.R = currentTrans.R;
          }
          transform.rValid = true;
          transform.T = matrixApply(currentTrans.R, transform.T);
        }
        transform.T = add(transform.T, currentTrans.T);

        finalRMS = rms;
        finalPointCount = static_cast<unsigned>(state.dist.size());
        finalCovarianceError = covarianceError;

        // 停止判据：与 ICP 同（`minRMSDecrease` 与 `maxIterations` 取并集）
        if (deltaRMS < params.minRMSDecrease || iteration >= params.maxIterations) {
          result = GICP_APPLY_TRANSFO;
          break;
        }
      }

      lastStepRMS = rms;
    }

    // ===== D. 解算这一轮的增量变换（GICP：6x6 马氏最小化）=====
    currentTrans = Transform();
    Vec3d dataGravityCenter;
    Vec3d modelGravityCenter;
    if (!gicpSolveStep(state, currentTrans, dataGravityCenter, modelGravityCenter)) {
      result = GICP_ERROR_REGISTRATION_STEP;
      break;
    }

    // 还原重叠度过滤（同 ICP：真身换回来）
    if (overlapFiltered) {
      state.pts.swap(trimmed.pts);
      state.ptsCov.swap(trimmed.ptsCov);
      state.cps.swap(trimmed.cps);
      state.cpCov.swap(trimmed.cpCov);
      state.dist.swap(trimmed.dist);
    }

    // ===== E. 过滤器（同 ICP）=====
    if (params.transformationFilters != SKIP_NONE) {
      filterTransformation(currentTrans, params.transformationFilters, dataGravityCenter, modelGravityCenter,
                           currentTrans);
    }

    // ===== F. 移动数据点 + **同步旋转其协方差**（同 ICP 的移动那一步）=====
    // 协方差必须跟点走：数据点是被**过滤后**的 R_inc 旋转的，故 `C ← R_inc·C·R_incᵀ` 也要用同一个
    // R_inc。两边不同步是这里最容易错的一处（下一轮解算读的就是这份协方差）。
    const Mat3d rInc = currentTrans.R;
    const Mat3d rIncT = transposed(rInc);
    for (std::size_t i = 0; i < state.pts.size(); ++i) {
      state.pts[i] = applyTransform(currentTrans, state.pts[i]);
      state.ptsCov[i] = matrixMul(matrixMul(rInc, state.ptsCov[i]), rIncT);
    }

    // ===== G. 重算最近邻与距离（同 ICP）=====
    refreshGicpNearest(state, tree, modelTreePts, modelCov);
  }

  out.result = result;
  out.rms = finalRMS;
  out.initialRms = initialRMS;
  out.pointCount = finalPointCount;
  out.iterations = iteration;
  out.trans = transform;
  out.covarianceError = finalCovarianceError;
  return out;
}

}  // namespace registration

