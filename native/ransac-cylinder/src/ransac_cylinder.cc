#include "ransac_cylinder.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

#include "normal_compressor.h"

namespace ransac_cylinder {

namespace {

using std::sqrt;

/**
 * mulberry32 PRNG：32 位状态、纯 uint32 算术（乘法的回绕即取低 32 位）。
 * 与 ransac-plane 用同一个 PRNG，理由相同：与 JS `Math.imul` 版本逐位同构，
 * 渲染侧单测可以镜像同一序列。输出 nextDouble() = nextU32() / 2^32 ∈ [0,1)。
 */
struct Mulberry32 {
  std::uint32_t a;
  explicit Mulberry32(std::uint32_t seed) : a(seed) {}

  std::uint32_t nextU32() {
    a = a + 0x6D2B79F5u;
    std::uint32_t t = a;
    t = (t ^ (t >> 15)) * (1u | t);
    t = t + ((t ^ (t >> 7)) * (61u | t));
    return t ^ (t >> 14);
  }

  double nextDouble() { return static_cast<double>(nextU32()) / 4294967296.0; }
};

/** 圆柱：单位轴方向 a + 轴上一点 c + 半径 r（显示坐标空间）。 */
struct Cylinder {
  double ax = 0.0;
  double ay = 0.0;
  double az = 1.0;
  double cx = 0.0;
  double cy = 0.0;
  double cz = 0.0;
  double r = 0.0;
};

/**
 * 三点投影退化的拒绝阈值：投影后的 |e1p × e2p| ≤ kMinSine·|e1p||e2p| 即判退化
 * （等价于 sin∠(e1p, e2p) ≤ kMinSine）。
 *
 * 该量同时是圆心求解的相对误差放大倍数（2×2 的行列式 ∝ sin²∠），1e-4 对应圆心相对误差
 * ≤ 1e-8 量级，远超距离阈值判据所需的精度；更宽松（1e-9 之类）会让近共线三元组解出
 * 天文数字的半径，白跑一轮计数循环。
 */
constexpr double kMinSine = 1e-4;

/** 候选点数（index == nullptr = 全量顶点）。 */
inline std::uint32_t chunkCandidateCount(const ChunkSource& src) {
  return src.index ? src.indexCount : src.vertexCount;
}

/** 由候选全局序号取坐标（xyz 输出）；local = 块内候选序号，不是顶点下标。 */
inline void candidateXyz(const ChunkSource& src, std::uint32_t local, double* x, double* y,
                         double* z) {
  const std::uint32_t vertex = src.index ? src.index[local] : local;
  const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
  *x = static_cast<double>(p[0]);
  *y = static_cast<double>(p[1]);
  *z = static_cast<double>(p[2]);
}

/**
 * 由候选全局序号取**单位法线**（写进 n[0..2]）；local = 块内候选序号，不是顶点下标。
 *
 * 解码出的是未归一化的箱角之和（模长 ≈ 1/√3），**必须归一化**：下游判「是否合法线」用的是
 * `n² > 0.5`（单位向量的判据），不归一化会让每一条法线都被判成非法，轴估计直接失效。
 * 空码与退化箱（模长 0）写**零向量**——沿用「零向量 = 非法线」的约定，下游自动跳过。
 *
 * src.normalCodes 为 nullptr 时同样写零向量（调用方在自动模式已提前拒绝这种输入）。
 */
inline void candidateNormal(const ChunkSource& src, std::uint32_t local, double* n) {
  if (src.normalCodes == nullptr) {
    n[0] = n[1] = n[2] = 0.0;
    return;
  }
  const std::uint32_t vertex = src.index ? src.index[local] : local;
  decompressNormal(src.normalCodes[vertex], n);
  const double len = sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (!(len > 0.0)) {
    n[0] = n[1] = n[2] = 0.0;
    return;
  }
  n[0] /= len;
  n[1] /= len;
  n[2] /= len;
}

/**
 * 轴方向符号约定：绝对值最大的分量为正。
 *
 * 轴无向（a 与 −a 是同一条轴），但**输出必须确定**——否则自动估计出的方向会随机翻向，
 * 契约（轴向坐标 tMin/tMax、画出来的圆柱朝向）与单测都会跟着抖。
 *
 * 与 ransac-plane 的 orientPlane 不同，这里**没有**配套的取反量（平面要连 d 一起取反，
 * 圆柱的 c ⊥ a 是相对量、不随符号变）。代价是：取反后同一个圆柱的轴点表示可能不同，
 * 但「圆柱」这个几何对象本身不变，且取反规则是确定性的，故结果仍逐位可复现。
 */
inline void orientAxis(double* ax, double* ay, double* az) {
  const double vx = std::fabs(*ax);
  const double vy = std::fabs(*ay);
  const double vz = std::fabs(*az);
  double lead = *ax;
  if (vy > vx && vy >= vz) {
    lead = *ay;
  } else if (vz > vx && vz > vy) {
    lead = *az;
  }
  if (lead < 0.0) {
    *ax = -*ax;
    *ay = -*ay;
    *az = -*az;
  }
}

/**
 * 垂直于轴方向 a 的正交单位基 (e1, e2)，满足 e1 × e2 = a，且**确定性**（同一 a 必得同一组基）。
 *
 * 取与 a 最不平行的坐标轴 e（|a| 分量最小的那个），e1 = normalize(a × e)，e2 = a × e1。
 * 坐标轴的选择保证 a × e 不为零（a 不可能同时与三轴共线）；e1 ⊥ a 且 |e1| = 1 ⇒
 * |e2| = |a × e1| = 1，e2 ⊥ a，且 e1 × e2 = a（右手系）。
 */
inline void axisBasis(const Cylinder& cyl, double* e1, double* e2) {
  const double ax = std::fabs(cyl.ax);
  const double ay = std::fabs(cyl.ay);
  const double az = std::fabs(cyl.az);
  double ex = 0.0;
  double ey = 0.0;
  double ez = 0.0;
  if (ax <= ay && ax <= az) {
    ex = 1.0;
  } else if (ay <= az) {
    ey = 1.0;
  } else {
    ez = 1.0;
  }
  double c1x = cyl.ay * ez - cyl.az * ey;
  double c1y = cyl.az * ex - cyl.ax * ez;
  double c1z = cyl.ax * ey - cyl.ay * ex;
  const double len = sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  if (len > 0.0) {
    c1x /= len;
    c1y /= len;
    c1z /= len;
  }
  e1[0] = c1x;
  e1[1] = c1y;
  e1[2] = c1z;
  // e2 = a × e1（a、e1 均为单位且正交 ⇒ e2 自动单位）
  e2[0] = cyl.ay * c1z - cyl.az * c1y;
  e2[1] = cyl.az * c1x - cyl.ax * c1z;
  e2[2] = cyl.ax * c1y - cyl.ay * c1x;
}

/** 点到轴线的垂距：‖(p − c) × a‖（a 为单位向量 ⇒ 叉积模长即垂距）。求值顺序即契约。 */
inline double perpDistance(const Cylinder& cyl, double x, double y, double z) {
  const double vx = x - cyl.cx;
  const double vy = y - cyl.cy;
  const double vz = z - cyl.cz;
  const double wx = vy * cyl.az - vz * cyl.ay;
  const double wy = vz * cyl.ax - vx * cyl.az;
  const double wz = vx * cyl.ay - vy * cyl.ax;
  return sqrt(wx * wx + wy * wy + wz * wz);
}

/**
 * 3×3 对称矩阵的循环 Jacobi 特征分解（闭式、无外部依赖）。
 * 与 ransac-plane 的同名函数逐行相同（同一份复制粘贴模板）。a **会被破坏**；
 * v 的**每一列**是一个单位特征向量，与 w 的特征值一一对应（列序 = 输出序，未排序）。
 */
void jacobiEigen3(double a[3][3], double w[3], double v[3][3]) {
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      v[i][j] = (i == j) ? 1.0 : 0.0;
    }
  }
  for (int sweep = 0; sweep < 32; ++sweep) {
    const double off = std::fabs(a[0][1]) + std::fabs(a[0][2]) + std::fabs(a[1][2]);
    const double diag = std::fabs(a[0][0]) + std::fabs(a[1][1]) + std::fabs(a[2][2]);
    // 全零矩阵（候选点全重合）时 off 与 diag 同为 0，此处即退出，不引入除零
    if (off <= 1e-18 * (diag > 0.0 ? diag : 1.0)) break;
    for (int p = 0; p < 2; ++p) {
      for (int q = p + 1; q < 3; ++q) {
        if (a[p][q] == 0.0) continue;
        // 标准 Jacobi 旋转参数（Numerical Recipes 形式：t 取与 theta 同号的小根）
        const double theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
        const double sign = theta >= 0.0 ? 1.0 : -1.0;
        const double t = sign / (std::fabs(theta) + sqrt(theta * theta + 1.0));
        const double c = 1.0 / sqrt(t * t + 1.0);
        const double s = t * c;
        const double app = a[p][p];
        const double aqq = a[q][q];
        const double apq = a[p][q];
        a[p][p] = app - t * apq;
        a[q][q] = aqq + t * apq;
        a[p][q] = 0.0;
        a[q][p] = 0.0;
        const int r = 3 - p - q;  // 第三轴
        const double arp = a[r][p];
        const double arq = a[r][q];
        a[r][p] = c * arp - s * arq;
        a[p][r] = a[r][p];
        a[r][q] = s * arp + c * arq;
        a[q][r] = a[r][q];
        // 累积特征向量：V ← V J
        for (int k = 0; k < 3; ++k) {
          const double vkp = v[k][p];
          const double vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  w[0] = a[0][0];
  w[1] = a[1][1];
  w[2] = a[2][2];
}

// ===========================================================================
// 轴方向估计：法线由调用方给（实体上的 normalCode 属性），本模块只做「求共同垂直方向」
//
// 为什么必须是法线：圆柱的轴与**每一个**表面法线都垂直（法线的径向分量在轴上的投影为 0），
// 于是内点法线的二阶矩 Σnnᵀ 的最小特征向量就是轴方向。这个估计器是精确的，且对**各向同性**
// 污染免疫——污染给 Σnnᵀ 的三个特征值加同一个常数，不旋转最小特征向量。法线的正负号无所谓
// （叉积与 nnᵀ 都对符号不敏感），故本模块从不做朝向统一。
//
// 2026-09 之前这里还有一整段「采样集现算局部 PCA 法线」（网格 + kNN + 局部 PCA），已删除：
// 渲染侧有了 normal-estimate 模块（CC 对齐、可调半径、Auto），模块内那份是它的**重复且更弱的
// 版本**——只在 65536 点的采样集上按固定启发式半径算，用户既看不到也改不了。
//
// 被否决的方案（别改回去）：对「投影协方差」用各向异性目标 f(a) = (λ₁−λ₂)²/(λ₁+λ₂)²
// （λ 为 P·C·P 的两个非零特征值，P = I − aaᵀ）。它算得没错（与暴力 P·C·P 特征分解逐点一致，
// 误差 0.00%），但**全局最小值不在真轴上**：候选轴倾斜 θ 会把轴向方差泄漏进投影平面
// （泄漏量 ∝ sin²θ），在 sin²θ ≈ 0.006（θ ≈ 4.5°）处恰好抵消圆柱固有的径向特征值差，造出
// 一个伪零点。这不是实现 bug——**任何「投影协方差特征值之差」形式的目标函数都有这个病**，
// 因为真轴处的值是「径向差 − 0」，而偏离处的值是「径向差 − 泄漏量」，两者可以相等。
//
// ---------------------------------------------------------------------------
// 判据：候选轴按 **票数占比 × 一致法线各向异性比** 排序（2026-09 改，旧判据是票数 argmax）
//
// 旧判据坏在哪：投票取「|n·a| ≤ 容差 的法线条数」的最大值。一片平面（地面）的法线只有**一个**
// 方向，于是**任何与该法线垂直的方向**都免费拿到那一片的全部票——真轴（票少）永远输给它。
// 实测（真产物、60000 点、水平地面 + 半径 0.3 的圆柱）：管占 10% 时轴偏 90°、30% 时偏 72°，
// 且**不报错**，只是给出一个半径 14000 的假大圆柱（内点 54000/60000）。
//
// 修法：给每个候选再乘一个「一致集的各向异性比」λ_mid / λ_max（λ 为一致法线 Σnnᵀ 的特征值，
// 降序，λ_min 是对应轴方向的那个）：
//   - 平面上的法线只占一个方向 ⇒ 只有一个非零特征值 ⇒ 比值 ≈ 0 ⇒ 免费票被清零；
//   - 圆柱的径向法线在 ⊥ 轴平面内各向同性 ⇒ λ_max ≈ λ_mid ≫ λ_min ⇒ 比值 ≈ 1。
// 这与上面「被否决的方案」不是一回事：那个是**投影坐标**的协方差且要做最优化（有伪零点），
// 这个是**法线二阶矩**的特征值比且只用来给候选**打分**（不做优化，故无伪零点问题）。
//
// 实测（同一批 7 个场景，探针脚本 %TEMP%\cyl-fix-probe.mjs）：
//   场景                  现状(票数 argmax)      票数 × 各向异性比
//   地面+倾斜管 30%       86.3°（比值 0.013）    0.7°（0.98）
//   地面+倾斜管 10%       69.2°（0.004）         1.2°（0.94）
//   地面+竖直管 30%       90.0°（0.016）         0.7°（0.98）
//   地面+水平管 30%/10%   0.7° ✓                 0.6° ✓
//   纯地面（无圆柱）      假大圆柱               得分 0 → 判「未找到」
//   纯倾斜管             0.4° ✓                 0.9° ✓
// ===========================================================================

/** 轴投票的垂直容差：|n·a| ≤ 该值算一致。0.05 ≈ 2.9°，比量化码误差（≈0.3–0.5°）宽一个量级。 */
constexpr double kAxisVoteTol = 0.05;
/** 精修两轮的容差（先宽后窄）：第一轮收大方向，第二轮在小集合上收紧。 */
constexpr double kAxisRefineTol1 = 0.08;
constexpr double kAxisRefineTol2 = 0.035;
/** 成对法线的叉积方向在夹角过小时不可靠（叉积模长 = sin∠），故要求 sin∠ > 该值。 */
constexpr double kMinPairSine = 0.14;  // 8°
/** 投票轮数上限（这是「一致集始终很小」时的兜底，也是整个投票阶段的时间上界）。 */
constexpr std::uint32_t kMaxVoteIterations = 512;
/**
 * 投票轮数**下限**：早停判据在它之前一律不生效。
 *
 * 为什么必须有：早停的自适应公式 N = log(1−p)/log(1−w²) 用的 w 是**当前最优候选**的内点比例，
 * 而地面主导的场景里最优候选从一开始就是「平面方向」（免费票 ⇒ w ≈ 0.9）⇒ 上式算出 N ≈ 2.4，
 * 第 3 轮就 break，512 轮的预算全被烧掉。可真正正确的候选（管壁 × 管壁的叉积，概率 ≈ p²）
 * 要到 ~1/p² 轮才抽得到 —— 于是「票数 argmax」时代的坏结果被一个**看起来没问题的早停**锁死了。
 *
 * 取值 256：p = 10% 时期望抽到 256 × 0.01 ≈ 2.6 对管壁法线（约 92% 概率至少一对），
 * p = 5% 时 ≈ 0.64 对（约 47%，与「≲5% 是既定局限」的记载一致）。代价是地面主导场景下
 * 投票固定跑 256 轮 × 有效法线数（≤ 采样集 65536）≈ 25 ms，相对下方假设循环的 0.1–0.2 s 可接受。
 */
constexpr std::uint32_t kMinVoteIterations = 256;
/**
 * 认轴所需的最少一致法线数（绝对下限；比例上的把关交给下面的得分闸门）。
 *
 * 刻意**不设**「占有效法线的 x%」这类比例闸：圆柱在一朵大云里占 1% 是常态（电杆 / 管道），
 * 比例闸会把这种正当输入一票否决。把关改由 kMinAxisScore 承担——它看的是**各向异性**
 * （平面拿不到分），对「占比低但确实是圆柱」的输入友好得多。
 */
constexpr std::uint32_t kMinAxisVotes = 16;
/**
 * 得分闸门：`票数占比 × 一致法线各向异性比` < 它即判「采样集里没有圆柱面」，返回未找到。
 *
 * 标定依据（探针实测，同上表）：**垃圾候选最高 0.0088**（平面方向：票多但各向异性比 ≈ 0.01），
 * **合法候选最低 0.023**（窄圆弧、无竞争），取 0.02 留约 2.6× 余量。
 *
 * ⚠ 它拦不住「各向同性法线」（植被、纯噪声）：那类法线落在 ±容差带内的期望比例恰好等于容差
 * 本身（5%），而带内的 Σnnᵀ 本身就是各向同性的 ⇒ 比值 ≈ 1 ⇒ 得分 ≈ 0.05，高于闸门。这不是
 * 漏洞而是「没有圆柱面时轴无方向可言」：怎么选都无所谓，下游 RANSAC 自己会判未找到，行为与
 * 加闸门之前一致。闸门要拦的是**有结构但结构不是圆柱**的误导（平面），那才是会静默出坏结果的情形。
 */
constexpr double kMinAxisScore = 0.02;

/**
 * Σnnᵀ 的三个特征值 → 各向异性比 λ_mid / λ_max（λ 按降序，剔除最小者），并回传最小特征值
 * （= 共同垂直方向）所在的下标。
 *
 * 单独抽出来是因为**打分与求方向共用同一套判据**：一致集的比值必须与最终轴用的是同一个定义，
 * 两处各写一遍迟早分叉。λ_max ≈ 0（一致集退化）时返回 0。
 */
inline double isotropyRatioFromEigen(const double w[3], int* minIndex) {
  int mi = 0;
  if (w[1] < w[mi]) mi = 1;
  if (w[2] < w[mi]) mi = 2;
  double big = 0.0;
  double mid = 0.0;
  for (int k = 0; k < 3; ++k) {
    if (k == mi) continue;
    if (w[k] > big) {
      mid = big;
      big = w[k];
    } else if (w[k] > mid) {
      mid = w[k];
    }
  }
  *minIndex = mi;
  return big > 0.0 ? mid / big : 0.0;
}

/**
 * 由一组法线求它们的共同垂直方向 + 一致集的**各向异性比**。
 *
 * 方向 = Σnnᵀ 的最小特征向量。这是整个轴估计的收口处，三处调用它（投票精修 / 内点重估 /
 * 候选打分）。它对各向同性污染免疫：污染给三个特征值加同一个常数，最小特征向量的**方向**
 * 不变（只是对比度被压扁）。
 *
 * 各向异性比 = λ_mid / λ_max（λ 按降序，除最小特征值外的两个），∈ [0, 1]：一致集里所有法线
 * 都指向同一个方向时只有一个非零特征值 ⇒ 比值 0；法线在 ⊥ 轴平面内铺开成各向同性 ⇒ 比值 1。
 * 这正是「平面 vs 圆柱面」的判别量，也是 2026-09 修掉「地面主导就选错轴」的关键（见文件
 * 上半部分的长注释）。
 *
 * @param normals 扁平 3·count
 * @param idx     纳入的法线下标
 * @param out     最小特征向量（共同垂直方向）
 * @param ratio   各向异性比；λ_max ≈ 0（一致集退化）时为 0
 * @returns 纳入数 < 4 时返回 false（特征分解无意义）
 */
bool axisAndIsotropyFromNormalSet(const std::vector<double>& normals,
                                  const std::vector<std::uint32_t>& idx, double* out, double* ratio) {
  if (idx.size() < 4) return false;
  double m[3][3] = {};
  for (const std::uint32_t i : idx) {
    const double* n = &normals[static_cast<std::size_t>(i) * 3];
    m[0][0] += n[0] * n[0];
    m[0][1] += n[0] * n[1];
    m[0][2] += n[0] * n[2];
    m[1][1] += n[1] * n[1];
    m[1][2] += n[1] * n[2];
    m[2][2] += n[2] * n[2];
  }
  m[1][0] = m[0][1];
  m[2][0] = m[0][2];
  m[2][1] = m[1][2];
  double w[3];
  double v[3][3];
  jacobiEigen3(m, w, v);
  int mi = 0;
  *ratio = isotropyRatioFromEigen(w, &mi);

  out[0] = v[0][mi];
  out[1] = v[1][mi];
  out[2] = v[2][mi];
  return true;
}

/** 只取方向的薄包装（内点重估只关心方向，不关心各向异性比）。 */
bool axisFromNormalSet(const std::vector<double>& normals, const std::vector<std::uint32_t>& idx,
                       double* out) {
  double ratio = 0.0;
  return axisAndIsotropyFromNormalSet(normals, idx, out, &ratio);
}

/**
 * 由采样集法线估轴方向（自动模式的入口）。投票 + 两轮精修。
 *
 * 投票的样本是**两条法线的叉积**（同时 ⊥ 两条法线），故早停公式用 w²（PCL 的
 * `SACMODEL_CYLINDER` 也是两点 + 两法线的最小样本，同一个道理）。夹角过小的法线对
 * 叉积方向不可靠（模长 = sin∠ 趋 0），按 kMinPairSine 弃用——这一条是必须的，否则
 * 两个近乎平行的噪声法线会投出随机方向。
 *
 * 候选按 `票数占比 × 一致法线各向异性比` 排序，**不是**按票数（旧判据在「地面主导」场景里
 * 系统性选错轴，实测见文件上半部分的长注释）。两条跟踪线各司其职：
 *   - `bestScore` / `best`：真正的胜出者，最终轴从它出发精修；
 *   - `maxVotes`：**票数**最多的候选，只用于自适应早停的 w（PCL 的 w 是「最优模型的内点比例」，
 *     在投票阶段对应的就是票数占比——若改用 bestScore 会让 w 失去「抽中比例」的含义）。
 *
 * @param normals  扁平 3·count（采样点法线，由实体 normalCode 解码归一化而来）
 * @param out      胜出候选的方向（未精修，仅供精修起步）
 * @param outScore 胜出候选的得分 ∈ [0,1]，回传给调用方进模型（诊断用）
 * @returns 是否得到可信的轴方向（得分低于 kMinAxisScore ⇒ 采样集里没有圆柱面，
 *          调用方据此收敛为未找到）
 */
bool estimateAxisFromNormals(const std::vector<double>& normals, std::uint32_t count, double* out,
                             double* outScore) {
  // 有效法线：NULL 码 / 解码退化的点存零向量，此处一次筛掉
  std::vector<std::uint32_t> valid;
  valid.reserve(count);
  for (std::uint32_t i = 0; i < count; ++i) {
    const double* n = &normals[static_cast<std::size_t>(i) * 3];
    if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > 0.5) valid.push_back(i);  // 单位向量 ⇒ 模长≈1
  }
  if (valid.size() < kMinAxisVotes) return false;
  const double validCount = static_cast<double>(valid.size());

  // ---- 投票：成对法线叉积 ----
  double best[3] = {0.0, 0.0, 1.0};
  double bestScore = 0.0;
  std::uint64_t maxVotes = 0;
  Mulberry32 rng(kRandomSeed ^ 0x51ED2701u);  // 与采样、假设循环不同的子序列
  const double confidence = 0.99;             // 与 fitEntity 的早停同源（此处固定：投票轮数很少）
  const double logOneMinusConf = std::log(1.0 - confidence);
  for (std::uint32_t iter = 0; iter < kMaxVoteIterations; ++iter) {
    const std::uint32_t ia = static_cast<std::uint32_t>(rng.nextDouble() * valid.size());
    std::uint32_t ib = static_cast<std::uint32_t>(rng.nextDouble() * valid.size());
    if (ib == ia) ib = (ib + 1) % static_cast<std::uint32_t>(valid.size());  // 取两条不同的法线
    const double* na = &normals[static_cast<std::size_t>(valid[ia]) * 3];
    const double* nb = &normals[static_cast<std::size_t>(valid[ib]) * 3];
    const double cx = na[1] * nb[2] - na[2] * nb[1];
    const double cy = na[2] * nb[0] - na[0] * nb[2];
    const double cz = na[0] * nb[1] - na[1] * nb[0];
    const double len = sqrt(cx * cx + cy * cy + cz * cz);
    if (!(len > kMinPairSine)) continue;  // 两法线近乎平行：叉积方向无意义
    const double a[3] = {cx / len, cy / len, cz / len};

    // 一趟遍历同时得到票数与一致集的 Σnnᵀ（各向异性比不必再扫第二趟）
    std::uint64_t votes = 0;
    double m[3][3] = {};
    for (const std::uint32_t i : valid) {
      const double* n = &normals[static_cast<std::size_t>(i) * 3];
      if (std::fabs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) > kAxisVoteTol) continue;
      ++votes;
      m[0][0] += n[0] * n[0];
      m[0][1] += n[0] * n[1];
      m[0][2] += n[0] * n[2];
      m[1][1] += n[1] * n[1];
      m[1][2] += n[1] * n[2];
      m[2][2] += n[2] * n[2];
    }
    if (votes > maxVotes) maxVotes = votes;

    // 得分 = 票数占比 × 各向异性比。特征分解只在**可能胜出**时才算：比值 ≤ 1 ⇒
    // score ≤ votes/validCount，故票数不够多的候选直接跳过（Jacobi 比一趟点积贵得多）。
    if (votes >= kMinAxisVotes && static_cast<double>(votes) > bestScore * validCount) {
      m[1][0] = m[0][1];
      m[2][0] = m[0][2];
      m[2][1] = m[1][2];
      double w[3];
      double v[3][3];
      jacobiEigen3(m, w, v);
      int mi = 0;
      const double ratio = isotropyRatioFromEigen(w, &mi);
      const double score = (static_cast<double>(votes) / validCount) * ratio;
      if (score > bestScore) {
        bestScore = score;
        best[0] = a[0];
        best[1] = a[1];
        best[2] = a[2];
      }
    }

    // 自适应早停：样本 = 2 ⇒ w²。轮数下限 kMinVoteIterations 是**必须**的（理由见其注释：
    // 地面主导时 w ≈ 0.9 ⇒ 上式算出只要 3 轮，真轴根本没机会被抽到）。
    if (maxVotes >= kMinAxisVotes && iter + 1 >= kMinVoteIterations) {
      const double w = static_cast<double>(maxVotes) / validCount;
      const double w2 = w * w;
      if (w2 >= 1.0) break;
      const double logNoWin = std::log(1.0 - w2);
      if (logNoWin < 0.0 && static_cast<double>(iter + 1) >= logOneMinusConf / logNoWin) break;
    }
  }

  // 得分闸门：一致集少得可怜，或者一致集虽然大但只有一个方向（平面）⇒ 没有圆柱面
  if (bestScore < kMinAxisScore) return false;
  *outScore = bestScore;

  // ---- 精修：一致法线的 Σnnᵀ 最小特征向量，容差递缩跑两轮 ----
  // 第一轮把边缘法线也收进来定大方向，第二轮在小而干净的集合上收紧；
  // 最小二乘面会平均掉各法线的噪声，故最终方向比任何单次投票都准。
  double axis[3] = {best[0], best[1], best[2]};
  const double tols[2] = {kAxisRefineTol1, kAxisRefineTol2};
  for (const double tol : tols) {
    std::vector<std::uint32_t> consistent;
    consistent.reserve(valid.size());
    for (const std::uint32_t i : valid) {
      const double* n = &normals[static_cast<std::size_t>(i) * 3];
      if (std::fabs(n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2]) <= tol) consistent.push_back(i);
    }
    double refined[3];
    if (!axisFromNormalSet(normals, consistent, refined)) return false;
    axis[0] = refined[0];
    axis[1] = refined[1];
    axis[2] = refined[2];
  }
  out[0] = axis[0];
  out[1] = axis[1];
  out[2] = axis[2];
  return true;
}

/**
 * 由**内点采样点**的法线重估轴方向（精修阶段用；显式给定了轴方向的场合不调用）。
 *
 * 与初估的区别只有一处：一致集不是投票选出来的，而是「该点相对当前模型的垂距落在阈值内」。
 * 内点已经聚在圆柱面上，故这一步是干净的最小二乘，能把初值的小偏差收敛掉。
 * @returns 是否可信（内点样本太少 ⇒ false，调用方保留原方向）
 */
bool refineAxisFromInliers(const double* sx, const double* sy, const double* sz,
                           const std::vector<double>& normals, std::uint32_t count,
                           const Cylinder& model, double threshold, double* out) {
  std::vector<std::uint32_t> inliers;
  inliers.reserve(count);
  for (std::uint32_t i = 0; i < count; ++i) {
    const double* n = &normals[static_cast<std::size_t>(i) * 3];
    if (!(n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > 0.5)) continue;  // 非法线
    if (std::fabs(perpDistance(model, sx[i], sy[i], sz[i]) - model.r) > threshold) continue;
    inliers.push_back(i);
  }
  return axisFromNormalSet(normals, inliers, out);
}



/** 三阶矩的 10 个独立分量在扁平数组里的下标（i ≤ j ≤ k 唯一确定）。 */
enum Moment3Index {
  kXXX = 0,
  kXXY = 1,
  kXXZ = 2,
  kXYY = 3,
  kXYZ = 4,
  kXZZ = 5,
  kYYY = 6,
  kYYZ = 7,
  kYZZ = 8,
  kZZZ = 9,
};

/** 已排序三元组 (a ≤ b ≤ c) → 10 个独立分量里的扁平下标（其余组合不合法，填 −1 占位）。 */
inline int moment3Index(int a, int b, int c) {
  static const int kTable[3][3][3] = {
      {{kXXX, kXXY, kXXZ}, {-1, kXYY, kXYZ}, {-1, -1, kXZZ}},
      {{-1, -1, -1}, {-1, kYYY, kYYZ}, {-1, -1, kYZZ}},
      {{-1, -1, -1}, {-1, -1, -1}, {-1, -1, kZZZ}},
  };
  return kTable[a][b][c];
}

/** 二阶层矩的 6 个独立分量按 (i, j) 取值（下标布局：xx, yy, zz, xy, xz, yz）。 */
inline double moment2At(const double m2[6], int i, int j) {
  if (i == j) return m2[i];
  const int a = i < j ? i : j;
  const int b = i < j ? j : i;
  if (a == 0 && b == 1) return m2[3];  // xy
  if (a == 0 && b == 2) return m2[4];  // xz
  return m2[5];                        // yz
}

/** 把 10 个独立分量展开成对称的 27 元张量（仅供收缩用，调用次数是 O(1)）。 */
void expandMoment3(const double m3[10], double t[3][3][3]) {
  const double flat[10] = {m3[kXXX], m3[kXXY], m3[kXXZ], m3[kXYY], m3[kXYZ],
                           m3[kXZZ], m3[kYYY], m3[kYYZ], m3[kYZZ], m3[kZZZ]};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      for (int k = 0; k < 3; ++k) {
        // 三重积对下标全对称 ⇒ 排序成 i' ≤ j' ≤ k' 后查表即可
        int a = i;
        int b = j;
        int c = k;
        if (a > b) std::swap(a, b);
        if (b > c) std::swap(b, c);
        if (a > b) std::swap(a, b);
        t[i][j][k] = flat[moment3Index(a, b, c)];
      }
    }
  }
}

/** 三阶矩张量在三个方向上的收缩：Σ (u_i·e)(u_i·f)(u_i·g)。 */
double contractMoment3(const double t[3][3][3], const double e[3], const double f[3], const double g[3]) {
  double s = 0.0;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      for (int k = 0; k < 3; ++k) s += e[i] * f[j] * g[k] * t[i][j][k];
    }
  }
  return s;
}

/** 单块的扫描产出（内点下标 + 以轴点为原点的一/二/三阶矩累加量，供串行归并）。 */
struct ChunkScan {
  /** 内点顶点下标（递增：候选遍历序 → 顶点下标，index 自身递增由契约保证）。 */
  std::vector<std::uint32_t> inliers;
  /** Σu（u = 点 − 轴点，3 个分量）。 */
  double su[3] = {};
  /** Σuuᵀ 的 6 个独立分量：xx, yy, zz, xy, xz, yz。 */
  double m2[6] = {};
  /** Σuuu 的 10 个独立分量（见 Moment3Index）。 */
  double m3[10] = {};
  double sqSum = 0.0;   // Σ 残差²
  double maxAbs = 0.0;  // max |残差|
  /** 内点在轴向上的坐标范围（相对轴点）。 */
  double tMin = std::numeric_limits<double>::infinity();
  double tMax = -std::numeric_limits<double>::infinity();
};

/** 一次全量扫描的归并结果。 */
struct ScanResult {
  std::vector<std::vector<std::uint32_t>> inlierByChunk;
  std::uint64_t count = 0;
  /** 矩的参考点（= 扫描模型的轴点）；精修阶段原样带到 Kåsa 求解里。 */
  double rx = 0.0;
  double ry = 0.0;
  double rz = 0.0;
  double su[3] = {};
  double m2[6] = {};
  double m3[10] = {};
  double sqSum = 0.0;
  double maxAbs = 0.0;
  double tMin = 0.0;
  double tMax = 0.0;
  bool spanned = false;  // 是否有内点（无内点时轴向范围无意义）
};

/**
 * 全量扫描：用给定圆柱判定**全部**候选点，逐块产出内点下标，并顺带累积
 * 一/二/三阶矩、RMS/最大偏差、轴向范围。
 *
 * 三阶矩是「精修不必再扫一遍」的关键：轴方向一旦改变，按旧基累加的 (x³, x²y, …) 就作废，
 * 而**张量形式**的 Σuuu 与基无关，任意新基都能闭式收缩得到新基下的求和量（见头文件）。
 *
 * 并行：按块区间均分（块大小由加载器按固定块长切分，量级相近，故按块数均分即近似均衡）。
 * 确定性：每块的输出由该块独立产出（块内递增序与线程数无关）；全局浮点归约在**串行**
 * 遍历逐块累加量时完成，归约顺序 = 块序，与线程数无关。
 */
ScanResult classifyAll(const EntitySource& entity, const Cylinder& cyl, double threshold,
                       unsigned threadCount) {
  const std::size_t chunkCount = entity.chunks.size();
  ScanResult out;
  out.inlierByChunk.resize(chunkCount);

  // 参考点 = 圆柱的轴点：内点到它的距离量级是半径 ⇒ 二、三阶矩的条件数好
  out.rx = cyl.cx;
  out.ry = cyl.cy;
  out.rz = cyl.cz;

  std::vector<ChunkScan> perChunk(chunkCount);
  const auto scanChunk = [&](std::size_t c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t n = chunkCandidateCount(src);
    ChunkScan& acc = perChunk[c];
    // 预留上限刻意保守（圆柱可能只占候选的很小一部分）
    acc.inliers.reserve(std::min<std::size_t>(n / 4, 1u << 16));
    for (std::uint32_t i = 0; i < n; ++i) {
      double x;
      double y;
      double z;
      candidateXyz(src, i, &x, &y, &z);
      const double perp = perpDistance(cyl, x, y, z);
      const double dev = perp - cyl.r;
      const double absDev = std::fabs(dev);
      if (absDev > threshold) continue;
      acc.inliers.push_back(src.index ? src.index[i] : i);

      // u = 点 − 轴点 = (x−cx, y−cy, z−cz)，与 perpDistance 里的中间量同源
      const double ux = x - cyl.cx;
      const double uy = y - cyl.cy;
      const double uz = z - cyl.cz;
      acc.su[0] += ux;
      acc.su[1] += uy;
      acc.su[2] += uz;
      acc.m2[0] += ux * ux;
      acc.m2[1] += uy * uy;
      acc.m2[2] += uz * uz;
      acc.m2[3] += ux * uy;
      acc.m2[4] += ux * uz;
      acc.m2[5] += uy * uz;
      acc.m3[kXXX] += ux * ux * ux;
      acc.m3[kXXY] += ux * ux * uy;
      acc.m3[kXXZ] += ux * ux * uz;
      acc.m3[kXYY] += ux * uy * uy;
      acc.m3[kXYZ] += ux * uy * uz;
      acc.m3[kXZZ] += ux * uz * uz;
      acc.m3[kYYY] += uy * uy * uy;
      acc.m3[kYYZ] += uy * uy * uz;
      acc.m3[kYZZ] += uy * uz * uz;
      acc.m3[kZZZ] += uz * uz * uz;
      acc.sqSum += dev * dev;
      if (absDev > acc.maxAbs) acc.maxAbs = absDev;
      const double t = ux * cyl.ax + uy * cyl.ay + uz * cyl.az;
      if (t < acc.tMin) acc.tMin = t;
      if (t > acc.tMax) acc.tMax = t;
    }
  };

  unsigned threads = threadCount;
  if (threads == 0) threads = std::thread::hardware_concurrency();
  if (threads == 0) threads = 1;
  if (out.inlierByChunk.size() < 2) threads = 1;
  threads = std::min<unsigned>(threads, static_cast<unsigned>(chunkCount > 0 ? chunkCount : 1u));
  threads = std::min<unsigned>(threads, 64u);

  if (threads <= 1) {
    for (std::size_t c = 0; c < chunkCount; ++c) scanChunk(c);
  } else {
    std::vector<std::thread> pool;
    pool.reserve(threads);
    const std::size_t step = (chunkCount + threads - 1) / threads;
    for (unsigned t = 0; t < threads; ++t) {
      const std::size_t begin = t * step;
      const std::size_t end = std::min(begin + step, chunkCount);
      if (begin >= end) break;
      pool.emplace_back([&, begin, end] {
        for (std::size_t c = begin; c < end; ++c) scanChunk(c);
      });
    }
    for (auto& th : pool) th.join();
  }

  // 串行归并（顺序 = 块序 ⇒ 与线程数无关）
  double tMin = std::numeric_limits<double>::infinity();
  double tMax = -std::numeric_limits<double>::infinity();
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkScan& part = perChunk[c];
    out.inlierByChunk[c] = std::move(part.inliers);
    out.count += out.inlierByChunk[c].size();
    for (int k = 0; k < 3; ++k) out.su[k] += part.su[k];
    for (int k = 0; k < 6; ++k) out.m2[k] += part.m2[k];
    for (int k = 0; k < 10; ++k) out.m3[k] += part.m3[k];
    out.sqSum += part.sqSum;
    if (part.maxAbs > out.maxAbs) out.maxAbs = part.maxAbs;
    if (!part.inliers.empty()) {
      out.spanned = true;
      if (part.tMin < tMin) tMin = part.tMin;
      if (part.tMax > tMax) tMax = part.tMax;
    }
  }
  out.tMin = tMin;
  out.tMax = tMax;
  return out;
}

/** 由扫描累加量组装圆柱模型（含轴向中心的还原）。 */
CylinderModel buildModel(const Cylinder& cyl, const ScanResult& scan, std::uint64_t sampleCount,
                         std::uint32_t iterationsUsed, bool axisEstimated, double axisScore) {
  CylinderModel model;
  model.ax = cyl.ax;
  model.ay = cyl.ay;
  model.az = cyl.az;
  model.radius = cyl.r;
  model.inlierCount = scan.count;
  model.sampleCount = sampleCount;
  model.iterationsUsed = iterationsUsed;
  model.rms = scan.count > 0 ? sqrt(scan.sqSum / static_cast<double>(scan.count)) : 0.0;
  model.maxDeviation = scan.count > 0 ? scan.maxAbs : 0.0;
  model.axisEstimated = axisEstimated;
  model.axisScore = axisEstimated ? axisScore : 0.0;

  if (scan.spanned) {
    // 轴向范围是相对**轴点** c 的；几何中心 = c + 轴向中点·a
    const double mid = (scan.tMin + scan.tMax) / 2.0;
    model.cx = cyl.cx + mid * cyl.ax;
    model.cy = cyl.cy + mid * cyl.ay;
    model.cz = cyl.cz + mid * cyl.az;
    model.halfHeight = (scan.tMax - scan.tMin) / 2.0;
  } else {
    model.cx = cyl.cx;
    model.cy = cyl.cy;
    model.cz = cyl.cz;
    model.halfHeight = 0.0;
  }
  return model;
}

/** 3×3 线性方程组求解（列主元高斯消元）。奇异时返回 false。 */
bool solve3(double a[3][3], double b[3], double* x) {
  for (int col = 0; col < 3; ++col) {
    int pivot = col;
    double bestAbs = std::fabs(a[col][col]);
    for (int row = col + 1; row < 3; ++row) {
      const double v = std::fabs(a[row][col]);
      if (v > bestAbs) {
        bestAbs = v;
        pivot = row;
      }
    }
    if (!(bestAbs > 0.0)) return false;
    if (pivot != col) {
      for (int k = 0; k < 3; ++k) std::swap(a[col][k], a[pivot][k]);
      std::swap(b[col], b[pivot]);
    }
    for (int row = col + 1; row < 3; ++row) {
      const double factor = a[row][col] / a[col][col];
      if (factor == 0.0) continue;
      for (int k = col; k < 3; ++k) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  for (int row = 2; row >= 0; --row) {
    double s = b[row];
    for (int k = row + 1; k < 3; ++k) s -= a[row][k] * x[k];
    if (a[row][row] == 0.0) return false;
    x[row] = s / a[row][row];
  }
  return true;
}

/**
 * 给定轴方向后的 Kåsa 代数圆拟合（对齐 PCL setOptimizeCoefficients 的「对内点集重解」
 * 语义，但用闭式代数解而非 LM 迭代）。
 *
 * 投影到 ⊥ a 的平面、以 (e1, e2) 为基：圆方程为 x² + y² = 2c₁x + 2c₂y − k
 * （k = c₁² + c₂² − r²），对 (c₁, c₂, k) 是**线性**的，故正规方程是 3×3 线性求解。
 * 求和量全部由扫描累加的一/二/三阶矩闭式收缩得到（见 classifyAll 的说明），
 * 因此轴方向改变**不需要**重扫全量数据。
 *
 * 已知偏差（写进 README-REF.md）：代数拟合对**部分弧**（只扫到半个圆周）有轻微半径偏差，
 * 明显优于「取质心当圆心」（半圆时质心偏离达 0.36r），但不是无偏估计。
 */
bool kasaCircle(const ScanResult& scan, const double e1[3], const double e2[3], double* c1,
                double* c2, double* radius) {
  if (scan.count < 3) return false;
  const double n = static_cast<double>(scan.count);

  // 以轴点为原点的投影坐标 x = u·e1、y = u·e2（e1, e2 ⊥ a ⇒ 无需真的做投影）
  double sxx = 0.0;
  double syy = 0.0;
  double sxy = 0.0;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      const double m2 = moment2At(scan.m2, i, j);
      sxx += e1[i] * m2 * e1[j];
      syy += e2[i] * m2 * e2[j];
      sxy += e1[i] * m2 * e2[j];
    }
  }
  const double sx = e1[0] * scan.su[0] + e1[1] * scan.su[1] + e1[2] * scan.su[2];
  const double sy = e2[0] * scan.su[0] + e2[1] * scan.su[1] + e2[2] * scan.su[2];

  double t3[3][3][3];
  expandMoment3(scan.m3, t3);
  const double sz = sxx + syy;
  const double sxz = contractMoment3(t3, e1, e1, e1) + contractMoment3(t3, e1, e2, e2);
  const double syz = contractMoment3(t3, e1, e1, e2) + contractMoment3(t3, e2, e2, e2);

  // 正规方程（行 = (2x, 2y, −1)，右端 = x² + y²）
  double m[3][3];
  m[0][0] = 4.0 * sxx;
  m[0][1] = 4.0 * sxy;
  m[0][2] = -2.0 * sx;
  m[1][0] = 4.0 * sxy;
  m[1][1] = 4.0 * syy;
  m[1][2] = -2.0 * sy;
  m[2][0] = -2.0 * sx;
  m[2][1] = -2.0 * sy;
  m[2][2] = n;
  double rhs[3] = {2.0 * sxz, 2.0 * syz, -sz};
  double sol[3] = {0.0, 0.0, 0.0};
  if (!solve3(m, rhs, sol)) return false;

  // 半径必须**减** k（2026-09 修）：圆方程 x² + y² = 2c₁x + 2c₂y − k 配方后是
  // (x−c₁)² + (y−c₂)² = c₁² + c₂² − k ⇒ r² = c₁² + c₂² − k。这里曾写成 `+ sol[2]`，
  // 于是 r² 变成 2(c₁²+c₂²) − r²：**参考点离真圆心小于 0.707r 时恒为负 ⇒ 直接 return false**。
  // 而参考点就是上一版模型轴点、正常情形下几乎就在轴上，于是「系数优化」静默退化成空操作
  // （不报错、不崩、结果只是没变好），只有"圆心离轴点极远"的病态模型才碰巧能通过。
  const double r2 = sol[0] * sol[0] + sol[1] * sol[1] - sol[2];
  if (!(r2 > 0.0)) return false;
  *c1 = sol[0];
  *c2 = sol[1];
  *radius = sqrt(r2);
  return true;
}

/**
 * 精修：给定轴方向，用内点集的矩重解圆参数（圆心偏移 + 半径）。
 *
 * 轴方向由调用方给（fitEntity 先用内点法线重估，见 refineAxisFromInliers）；
 * 显式给定了轴方向的场合方向不动——文章把 Axis 当约束，不是初值。
 * 这里对矩做的是 Kåsa 代数圆拟合（对参数线性 ⇒ 闭式解 3×3 正规方程），
 * 全部求和量由扫描累加的一/二/三阶矩闭式收缩得到，不再过一遍点。
 *
 * @returns 是否得到可用的精修模型；false = 退化（内点太少 / 圆的 3×3 奇异 / 半径越界），
 *          调用方保留 RANSAC 那一版
 */
bool refineCircle(const ScanResult& scan, const RansacParams& params, const Cylinder& dir,
                  Cylinder* out) {
  if (scan.count < 3) return false;

  double e1[3];
  double e2[3];
  axisBasis(dir, e1, e2);
  double c1 = 0.0;
  double c2 = 0.0;
  double r = 0.0;
  if (!kasaCircle(scan, e1, e2, &c1, &c2, &r)) return false;
  // 半径约束是**假设的准入条件**，精修同样受它约束：解出的半径越界说明这一步走歪了
  if (params.minRadius > 0.0 && r < params.minRadius) return false;
  if (params.maxRadius > 0.0 && r > params.maxRadius) return false;

  // 圆心在 3D 里的还原：轴点 + c₁e₁ + c₂e₂（e₁, e₂ ⊥ a ⇒ 结果仍在轴上）
  out->ax = dir.ax;
  out->ay = dir.ay;
  out->az = dir.az;
  out->cx = scan.rx + c1 * e1[0] + c2 * e2[0];
  out->cy = scan.ry + c1 * e1[1] + c2 * e2[1];
  out->cz = scan.rz + c1 * e1[2] + c2 * e2[2];
  out->r = r;
  return true;
}

}  // namespace

EntityResult fitEntity(const EntitySource& entity, const RansacParams& params,
                       unsigned threadCount) {
  EntityResult result;
  const std::size_t chunkCount = entity.chunks.size();
  result.inlierByChunk.resize(chunkCount);

  const double threshold = params.distanceThreshold > 0.0 ? params.distanceThreshold : 0.0;

  // ---- 候选前缀和：全局候选序号 → (块, 块内候选序号) ----
  std::vector<std::uint64_t> prefix(chunkCount + 1, 0);
  for (std::size_t c = 0; c < chunkCount; ++c) {
    prefix[c + 1] = prefix[c] + chunkCandidateCount(entity.chunks[c]);
  }
  const std::uint64_t totalCandidates = prefix[chunkCount];

  std::uint64_t sampleSize = params.sampleSize > 0 ? params.sampleSize : kAutoSampleSize;
  if (sampleSize > totalCandidates) sampleSize = totalCandidates;

  // 候选不足三点定圆 / 不迭代 / 采样集不足三点：直接判未找到（渲染侧按空结果提示）
  if (totalCandidates < 3 || sampleSize < 3 || params.maxIterations == 0) {
    return result;
  }

  // ---- ② 自动模式的前置条件：**每个块**都得有法线（法线由调用方随实体传入）----
  // 显式轴模式完全不读法线，整个省掉（也就不用校验）。
  const bool autoAxis = !params.hasAxis;
  const std::uint32_t sampleCount = static_cast<std::uint32_t>(sampleSize);
  std::vector<double> normals;  // 采样点法线，扁平 3·sampleCount（仅自动模式填充）
  if (autoAxis) {
    for (const ChunkSource& src : entity.chunks) {
      // addon 侧已经把「自动模式 + 缺 normals」提前拦成 TypeError，这里是纵深防御
      if (src.normalCodes == nullptr) return result;
    }
    normals.assign(static_cast<std::size_t>(sampleCount) * 3, 0.0);
  }

  // ---- ① 采样集：随机取点（**不放回**） ----
  // 为什么不放回（2026-09 重写了理由：旧理由「重复点压坏局部协方差」随模块内的局部法线估计
  // 一起消失了，但**行为刻意保持不变**——改成有放回会让所有既有断言的结果变化）：
  //   ① 重复的采样点让「3 点定圆」退化成「两点 + 一个重复点」，投影后的行列式为 0，
  //      被 kMinSine 的退化判据丢弃 —— 白烧一轮迭代预算；
  //   ② 采样集应当代表**不同的表面位置**。重复会让少数位置被过度代表，而 RANSAC 的早停用
  //      w = 最优内点数 / 采样集点数估计总体内点比例（PCL 语义），重复点会把 w 抬高 ⇒ 过早停。
  // N 只比采样上限略大时最明显：70000 点有放回抽 65536 个，约 35% 的槽位是重复（期望重数
  // S²/2N ≈ 3e4）。故一律不放回：候选数 ≤ 采样上限时按序取满（此时唯一子集就是全部候选，
  // 无需随机），否则用拒绝采样 + 命中集合。
  std::vector<double> sx(sampleCount);
  std::vector<double> sy(sampleCount);
  std::vector<double> sz(sampleCount);
  {
    Mulberry32 rng(kRandomSeed);
    if (totalCandidates <= static_cast<std::uint64_t>(sampleSize)) {
      for (std::uint32_t i = 0; i < sampleCount; ++i) {
        const std::size_t c =
            static_cast<std::size_t>(std::upper_bound(prefix.begin(), prefix.end(), i) - prefix.begin() - 1);
        const std::uint32_t local = static_cast<std::uint32_t>(i - prefix[c]);
        candidateXyz(entity.chunks[c], local, &sx[i], &sy[i], &sz[i]);
        if (autoAxis) candidateNormal(entity.chunks[c], local, &normals[static_cast<std::size_t>(i) * 3]);
      }
    } else {
      // 拒绝采样：抽中已抽过的序号就重抽。探测次数的期望 = N·(H_N − H_{N−S})：
      // N ≫ S（真实云）时 ≈ S；N 只比 S 略大时（最坏 N = S+1）≈ N·ln N ≈ 8e5——都是一次调用内的
      // 微小开销，换来采样集里绝无重复点。抽取顺序即样本序，故结果对同一输入仍完全可复现。
      std::unordered_set<std::uint64_t> seen;
      seen.reserve(static_cast<std::size_t>(sampleCount) * 2);
      std::uint32_t i = 0;
      while (i < sampleCount) {
        std::uint64_t g = static_cast<std::uint64_t>(rng.nextDouble() * static_cast<double>(totalCandidates));
        if (g >= totalCandidates) g = totalCandidates - 1;  // nextDouble() < 1 保证不越界，此为兜底
        if (!seen.insert(g).second) continue;               // 已抽过：丢弃重抽（不放回）
        const std::size_t c =
            static_cast<std::size_t>(std::upper_bound(prefix.begin(), prefix.end(), g) - prefix.begin() - 1);
        const std::uint32_t local = static_cast<std::uint32_t>(g - prefix[c]);
        candidateXyz(entity.chunks[c], local, &sx[i], &sy[i], &sz[i]);
        if (autoAxis) candidateNormal(entity.chunks[c], local, &normals[static_cast<std::size_t>(i) * 3]);
        ++i;
      }
    }
  }

  // ---- ③ 轴方向：显式给定则归一化 + 统一符号；否则由**传入的法线**估计 ----
  // 法线随实体一起来（渲染侧从 `normalCode` 属性零拷贝取出），模块不再自己估——
  // 旧实现在采样集上现算局部 PCA 法线，是 normal-estimate 模块的重复且更弱的版本。
  Cylinder axisRef;  // 只用到 ax/ay/az
  double axisScore = 0.0;
  if (!autoAxis) {
    const double len = sqrt(params.axisX * params.axisX + params.axisY * params.axisY +
                            params.axisZ * params.axisZ);
    if (!(len > 0.0)) return result;  // 零向量：无法定义轴，判未找到
    axisRef.ax = params.axisX / len;
    axisRef.ay = params.axisY / len;
    axisRef.az = params.axisZ / len;
    orientAxis(&axisRef.ax, &axisRef.ay, &axisRef.az);
  } else {
    double a[3];
    // 投票 + 两轮精修（见文件上半部分「轴方向估计」一节）
    if (!estimateAxisFromNormals(normals, sampleCount, a, &axisScore)) {
      return result;  // 采样集里没有圆柱面（一致法线太少或各向异性比过低）
    }
    axisRef.ax = a[0];
    axisRef.ay = a[1];
    axisRef.az = a[2];
    orientAxis(&axisRef.ax, &axisRef.ay, &axisRef.az);
  }
  const double ax = axisRef.ax;
  const double ay = axisRef.ay;
  const double az = axisRef.az;

  // ---- ③ 假设循环：单线程顺序执行（最优跟踪有状态，并行会改变迭代顺序 ⇒ 破坏确定性）----
  //      最小样本 = 3 点（给定轴方向后 3 点恰好定圆），故早停公式用 w³。
  Cylinder best;
  std::uint64_t bestCount = 0;
  std::uint32_t iterationsUsed = 0;
  // confidence ≥ 1 时 log(0) = −∞ 会让早停判据失效（required 变 ∞ 反而无害，但 −∞/NaN 不是）：
  // 钳到 1 − 1e-12，语义仍是「几乎必然抽到一次全内点样本」
  const double confidence = params.confidence < 1.0 ? params.confidence : 1.0 - 1e-12;
  const double logOneMinusConf = std::log(1.0 - confidence);
  Mulberry32 pick(kRandomSeed ^ 0x9E3779B9u);  // 与采样用不同子序列，避免三点落在关联位置上

  for (std::uint32_t iter = 0; iter < params.maxIterations; ++iter) {
    iterationsUsed = iter + 1;
    const auto pickIndex = [&]() {
      std::uint32_t v = static_cast<std::uint32_t>(pick.nextDouble() * sampleCount);
      return v < sampleCount ? v : sampleCount - 1;
    };
    const std::uint32_t i0 = pickIndex();
    std::uint32_t i1 = pickIndex();
    while (i1 == i0) i1 = pickIndex();
    std::uint32_t i2 = pickIndex();
    while (i2 == i0 || i2 == i1) i2 = pickIndex();

    // 三点相对 p0 的偏移，先扣掉轴向分量（投影到 ⊥ a 的平面）
    const double e1x0 = sx[i1] - sx[i0];
    const double e1y0 = sy[i1] - sy[i0];
    const double e1z0 = sz[i1] - sz[i0];
    const double e2x0 = sx[i2] - sx[i0];
    const double e2y0 = sy[i2] - sy[i0];
    const double e2z0 = sz[i2] - sz[i0];
    const double e1a = e1x0 * ax + e1y0 * ay + e1z0 * az;
    const double e2a = e2x0 * ax + e2y0 * ay + e2z0 * az;
    const double e1x = e1x0 - e1a * ax;
    const double e1y = e1y0 - e1a * ay;
    const double e1z = e1z0 - e1a * az;
    const double e2x = e2x0 - e2a * ax;
    const double e2y = e2y0 - e2a * ay;
    const double e2z = e2z0 - e2a * az;

    // 投影后的三点定圆：2×2 线性求解（圆心相对 p0 的偏移 u = α·e1p + β·e2p）
    const double aa = e1x * e1x + e1y * e1y + e1z * e1z;
    const double bb = e1x * e2x + e1y * e2y + e1z * e2z;
    const double cc = e2x * e2x + e2y * e2y + e2z * e2z;
    if (!(aa > 0.0) || !(cc > 0.0)) continue;
    const double det = aa * cc - bb * bb;
    // det = |e1p × e2p|²；退化判据 sin∠ ≤ kMinSine 即 det ≤ kMinSine²·aa·cc
    if (!(det > kMinSine * kMinSine * aa * cc)) continue;
    const double alpha = cc * (aa - bb) / (2.0 * det);
    const double beta = aa * (cc - bb) / (2.0 * det);
    const double ux = alpha * e1x + beta * e2x;
    const double uy = alpha * e1y + beta * e2y;
    const double uz = alpha * e1z + beta * e2z;
    const double r = sqrt(ux * ux + uy * uy + uz * uz);
    if (!(r > 0.0) || !std::isfinite(r)) continue;
    // 半径约束（文章的 RadiusLimits）：越界即整轮丢弃
    if (params.minRadius > 0.0 && r < params.minRadius) continue;
    if (params.maxRadius > 0.0 && r > params.maxRadius) continue;

    Cylinder cand;
    cand.ax = ax;
    cand.ay = ay;
    cand.az = az;
    // u ⊥ a ⇒ 轴向分量无关，c = p0 + u 直接是轴上一点
    cand.cx = sx[i0] + ux;
    cand.cy = sy[i0] + uy;
    cand.cz = sz[i0] + uz;
    cand.r = r;

    // 采样集内点计数（提前退出：剩余点**全算上**也无法严格超过当前最优 → 该假设必败）。
    // 判据必须是 count + 剩余数 <= bestCount；写成 <= bestCount + 1 会丢掉能追平的假设，
    // 且此判据下胜出假设的计数必为精确值（它每步都满足 count + 剩余 > bestCount）。
    std::uint64_t count = 0;
    for (std::uint32_t k = 0; k < sampleCount; ++k) {
      if (count + static_cast<std::uint64_t>(sampleCount - k) <= bestCount) break;
      const double perp = perpDistance(cand, sx[k], sy[k], sz[k]);
      if (std::fabs(perp - r) <= threshold) ++count;
    }
    if (count > bestCount) {
      bestCount = count;
      best = cand;
    }

    // ---- 自适应早停：标准 RANSAC 终止条件 N = log(1-p) / log(1-w³) ----
    // w = 当前最优内点比例（采样集上的估计，是总体比例的无偏估计）
    if (bestCount >= 3) {
      const double w = static_cast<double>(bestCount) / static_cast<double>(sampleCount);
      const double w3 = w * w * w;
      if (w3 >= 1.0) break;  // 采样集全为内点：已不可能更好
      const double logNoWin = std::log(1.0 - w3);
      if (logNoWin < 0.0) {
        const double required = logOneMinusConf / logNoWin;
        if (static_cast<double>(iterationsUsed) >= required) break;
      }
    }
  }

  if (bestCount < 3) {
    // 未找到圆柱：常见于候选集里根本没有圆柱面、阈值太小、半径约束把假设全滤掉了
    return result;
  }

  // ---- ④ 全量 pass1：RANSAC 圆柱判内点 + 累积矩 ----
  const ScanResult scan0 = classifyAll(entity, best, threshold, threadCount);

  CylinderModel model = buildModel(best, scan0, sampleCount, iterationsUsed, autoAxis, axisScore);
  ScanResult chosen = scan0;

  // ---- ⑤ 精修 + 全量 pass2；两版完整算出后取内点更多的一版 ----
  // 最小二乘不是共识最大化，精修后内点数理论上可能变少；两版都算齐（内点 + RMS + 轴向范围）
  // 才能无条件取优。多一趟 O(N) 扫描换「结果永不因精修变差」，值。
  if (params.optimizeCoefficients) {
    Cylinder dir = best;
    if (autoAxis) {
      // 用**内点采样点**的法线重估轴方向（初估是投票出来的，这一步是干净的最小二乘）；
      // 失败（内点样本太少）就保留初值——文章把精修当可选增益，不是必得项
      double a[3];
      if (refineAxisFromInliers(sx.data(), sy.data(), sz.data(), normals, sampleCount, best, threshold,
                                a)) {
        dir.ax = a[0];
        dir.ay = a[1];
        dir.az = a[2];
        orientAxis(&dir.ax, &dir.ay, &dir.az);  // 与初估同一符号约定
      }
    }
    Cylinder refined;
    if (refineCircle(scan0, params, dir, &refined)) {
      const ScanResult scan1 = classifyAll(entity, refined, threshold, threadCount);
      if (scan1.count > scan0.count) {
        model = buildModel(refined, scan1, sampleCount, iterationsUsed, autoAxis, axisScore);
        chosen = scan1;
      }
    }
  }

  result.found = true;
  result.cylinder = model;
  result.inlierByChunk = std::move(chosen.inlierByChunk);
  return result;
}

}  // namespace ransac_cylinder
