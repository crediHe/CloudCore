// csf-pro 算法本体：老代码液体贴合语义的逐式移植（见 csf_pro.h 头注）。
//
// 数值布局：全程 double 运算；float 输入（three.js position 缓冲）在访问处
// 升 double（无损），与 JS 逐式镜像（tests/unit/.../csfProReference.ts）在
// 相同输入上逐位一致。运算顺序逐条对应老代码（doc/CSF地面识别算法/code/）：
//   build → 初始化布料 → {重力 → 碰撞抬升 → 内部约束 → 收敛判定} ×N → 分类。
// 其中收敛判据与 4b 碰撞的行并行取自**工具版 csf_native.cc**（老应用实际跑的
// 版本，worker_threads 调 csfStep 的模块）而非参考版 csf_algorithm.cc：
// - 收敛量"每轮碰撞后的整轮位移"（含悬空粒子的重力步长），容差
//   eff_eps = max(convergenceEps, 布料分辨率×0.15)，连续 3 轮即停（见 4d）。
// - 4b 按行分给硬件线程并行（各格点读写互不相交，结果与串行逐位一致）。
#include "csf_pro.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <thread>

namespace csfpro {
namespace {

constexpr double kGravityFactor = 0.65;         // 老代码：每轮重力 = timeStep×0.65
constexpr double kSearchRadiusFactor = 1.5;     // 支撑采样半径 = 布料分辨率 ×1.5
constexpr std::uint64_t kMaxClothParticles = std::uint64_t{1} << 24;  // 布料粒子数上限
constexpr std::uint64_t kMaxGridCells = std::uint64_t{1} << 27;       // 支撑网格格数上限

// ---------- 支撑均匀网格（CSR 布局）：定半径 XY 邻域查询 ----------
// 与老代码 Grid2D 语义一致（cell = 搜索半径 = res×1.5，collect 只覆盖被扫到的格、
// 圆形距离裁剪由调用方做）；存储改为"前缀和 + 连续桶"替代 vector<vector>——
// 布格数随区域平方增长、可上千万，逐格 vector 头（~24B）吃不消。
struct Grid2D {
  double cell = 0;
  double min_x = 0, min_y = 0;
  std::int64_t nx = 0, ny = 0;
  const float* xs = nullptr;  // 候选 x 坐标（全局候选序）
  const float* ys = nullptr;
  std::vector<std::uint64_t> cellStart;  // 长 nx*ny+1：格 id 的桶前缀和（candidate 段 [start, start+count)）
  std::vector<std::uint32_t> bucket;     // 长候选总数：每格内连续存放候选全局索引

  /** 格 id（x,y 与候选点一致的 double 除法后截断，镜像 JS 的 Math.floor 语义）。 */
  inline std::uint64_t cellId(double x, double y) const {
    const std::int64_t ix = (std::int64_t)std::clamp((x - min_x) / cell, 0.0, (double)(nx - 1));
    const std::int64_t iy = (std::int64_t)std::clamp((y - min_y) / cell, 0.0, (double)(ny - 1));
    return (std::uint64_t)(iy * nx + ix);
  }

  void build(const float* xv, const float* yv, std::size_t n, double cell_size,
             double mnx, double mny, double mxx, double mxy) {
    cell = cell_size;
    min_x = mnx;
    min_y = mny;
    xs = xv;
    ys = yv;
    nx = std::max<std::int64_t>(1, (std::int64_t)((mxx - mnx) / cell) + 2);
    ny = std::max<std::int64_t>(1, (std::int64_t)((mxy - mny) / cell) + 2);
    const std::uint64_t ncells = (std::uint64_t)nx * (std::uint64_t)ny;
    if (ncells > kMaxGridCells) {
      throw ClothTooLargeError(
          "支撑网格格数超上限（布料分辨率过小）：请调大布料分辨率或裁剪分割区域");
    }
    // 两遍扫描填 CSR：第一遍计数（写入 +1 槽），前缀和得每格起始；第二遍落桶。
    cellStart.assign(ncells + 1, 0);
    for (std::size_t i = 0; i < n; ++i) {
      ++cellStart[cellId((double)xs[i], (double)ys[i]) + 1];
    }
    for (std::uint64_t g = 0; g < ncells; ++g) {
      cellStart[g + 1] += cellStart[g];
    }
    bucket.assign(n, 0);
    std::vector<std::uint64_t> cursor(cellStart);  // 填充游标（前缀和副本，用完即弃）
    for (std::size_t i = 0; i < n; ++i) {
      const std::uint64_t id = cellId((double)xs[i], (double)ys[i]);
      bucket[cursor[id]++] = (std::uint32_t)i;
    }
  }

  /** 收集 (x,y) 半径 r 覆盖格内全部候选索引（圆形距离裁剪由调用方做）。 */
  void collect(double x, double y, double r, std::vector<std::uint32_t>& out) const {
    const std::int64_t ix0 = std::max<std::int64_t>(0, (std::int64_t)((x - r - min_x) / cell));
    const std::int64_t ix1 = std::min<std::int64_t>(nx - 1, (std::int64_t)((x + r - min_x) / cell));
    const std::int64_t iy0 = std::max<std::int64_t>(0, (std::int64_t)((y - r - min_y) / cell));
    const std::int64_t iy1 = std::min<std::int64_t>(ny - 1, (std::int64_t)((y + r - min_y) / cell));
    for (std::int64_t iy = iy0; iy <= iy1; ++iy) {
      for (std::int64_t ix = ix0; ix <= ix1; ++ix) {
        const std::uint64_t g = (std::uint64_t)(iy * nx + ix);
        const std::uint64_t begin = cellStart[g], end = cellStart[g + 1];
        for (std::uint64_t p = begin; p < end; ++p) out.push_back(bucket[p]);
      }
    }
  }
};

// ---------- 布料状态（行优先 (ny, nx)，同老代码 Cloth） ----------
struct Cloth {
  std::vector<double> z;
  double min_x = 0, min_y = 0, res = 0;
  std::int64_t nx = 0, ny = 0;
};

}  // namespace

EntityResult classifyEntity(const EntitySource& entity, const ClassifyParams& p,
                            const std::atomic<bool>& cancel,
                            const std::function<void(int iteration)>& onIteration) {
  EntityResult result;
  // 块数即结果块数（与输入 chunks 对齐；空实体返回全空）
  result.groundByChunk.assign(entity.chunks.size(), {});

  // ---- 1. 合并全部候选点：包围盒（double）+ 倒置高度 ----
  // 候选 = 带 index 的块取其 index 条目、否则取全部顶点；按块序排成全局候选序列，
  // 每块记录 [firstCandidate, count) 供分类切块输出。
  std::uint64_t total = 0;
  for (const ChunkSource& c : entity.chunks) {
    total += c.index ? c.indexCount : c.vertexCount;
  }
  if (total == 0) return result;
  if (total > (std::uint64_t)std::numeric_limits<std::uint32_t>::max()) {
    throw ClothTooLargeError("候选点数超上限：请裁剪区域后重试");
  }
  const double inf = std::numeric_limits<double>::infinity();
  double mnx = inf, mxx = -inf, mny = inf, mxy = -inf, mxz = -inf;
  // 预扫一遍包围盒（需要 mnx/mny 才能算格 id；分两遍与"构建数组"合并可省一次，
  // 但为镜像运算顺序、避免语义漂移，保持与老代码一致的两次访问）。
  for (const ChunkSource& c : entity.chunks) {
    const std::uint32_t count = c.index ? c.indexCount : c.vertexCount;
    for (std::uint32_t j = 0; j < count; ++j) {
      const std::uint32_t v = c.index ? c.index[j] : j;
      const double x = (double)c.positions[v * 3];
      const double y = (double)c.positions[v * 3 + 1];
      const double z = (double)c.positions[v * 3 + 2];
      mnx = std::min(mnx, x);
      mxx = std::max(mxx, x);
      mny = std::min(mny, y);
      mxy = std::max(mxy, y);
      mxz = std::max(mxz, z);  // 只取最大值：布料初始高度用
    }
  }
  std::vector<float> xs(total), ys(total), invz(total);
  std::vector<std::uint32_t> chunkFirst(entity.chunks.size()), chunkCount(entity.chunks.size());
  std::uint64_t k = 0;
  for (std::size_t c = 0; c < entity.chunks.size(); ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t count = src.index ? src.indexCount : src.vertexCount;
    chunkFirst[c] = (std::uint32_t)k;
    chunkCount[c] = count;
    for (std::uint32_t j = 0; j < count; ++j) {
      const std::uint32_t v = src.index ? src.index[j] : j;
      xs[k] = src.positions[v * 3];
      ys[k] = src.positions[v * 3 + 1];
      invz[k] = -src.positions[v * 3 + 2];  // 倒置：z -> -z（老代码 inv_z）
      ++k;
    }
  }

  // ---- 2. 支撑均匀网格（碰撞抬升的邻域查询用） ----
  const double search_r = p.clothResolution * kSearchRadiusFactor;
  Grid2D grid;
  grid.build(xs.data(), ys.data(), (std::size_t)total, search_r, mnx, mny, mxx, mxy);

  // ---- 3. 初始化布料网格（老代码 Cloth） ----
  const double r = p.clothResolution;
  Cloth cloth;
  cloth.min_x = mnx;
  cloth.min_y = mny;
  cloth.res = r;
  cloth.nx = (std::int64_t)((mxx - mnx) / r) + 2;  // +2 保证覆盖边界
  cloth.ny = (std::int64_t)((mxy - mny) / r) + 2;
  const std::uint64_t clothParticles = (std::uint64_t)cloth.nx * (std::uint64_t)cloth.ny;
  if (clothParticles > kMaxClothParticles) {
    throw ClothTooLargeError(
        "布料网格粒子数超上限（布料分辨率过小）：请调大布料分辨率或裁剪分割区域");
  }
  const double top = -mxz + r * 2;  // 倒置后的最高点之上（老代码 cloth 初始高度）
  cloth.z.assign(clothParticles, top);

  // ---- 4. 布料模拟迭代（逐式对应老代码步骤 4a-4d） ----
  std::vector<double> z_new(cloth.z.size());
  std::vector<double> prev_z = cloth.z;  // 收敛采样快照：上一轮"碰撞后"的布料高度
  const double gravity = p.timeStep * kGravityFactor;
  const double rigid = (p.rigidness / 3.0) * 0.5;  // 与 Python 版一致
  const double r2 = search_r * search_r;
  const std::int64_t nx = cloth.nx, ny = cloth.ny;
  // 收敛容差（老工具 csf_native.cc）：max(默认 eps, 分辨率×0.15)——贴地后由
  // 地形噪声/梯度驱动的微调放宽到 ~9cm（@0.6m），避免永不收敛跑满迭代上限
  const double eff_eps = std::max(p.convergenceEps, r * 0.15);
  int settled = 0;

  // 4b 行并行的工作缓冲（每线程独立候选桶，线程数 = 硬件线程数，见各轮循环）
  const unsigned hc = std::thread::hardware_concurrency();
  const unsigned nthreads = std::min(hc ? hc : 1u, (unsigned)std::max<std::int64_t>(1, ny));
  std::vector<std::vector<std::uint32_t>> bufs(nthreads);
  for (auto& b : bufs) b.reserve(512);

  for (int it = 0; it < p.iterations; ++it) {
    // 4a. 重力：所有粒子下落
    for (double& z : cloth.z) z -= gravity;

    // 4b. 碰撞约束：粒子不得低于圆形邻域内点云的"最高倒置点"（= 最低真实点）。
    //     只抬升、从不 pin（粒子高出地形时重力照常下落）——液体贴地语义核心。
    //     按行分给硬件线程并行（同老工具 csf_native.cc：各格点只写自己下标、
    //     读写互不相交，结果与串行逐位一致）。
    std::vector<std::thread> pool;
    pool.reserve(nthreads);
    auto collision_rows = [&](unsigned t) {
      auto& buf = bufs[t];
      for (std::int64_t iy = (std::int64_t)t; iy < ny; iy += (std::int64_t)nthreads) {
        for (std::int64_t ix = 0; ix < nx; ++ix) {
          const std::uint64_t idx = (std::uint64_t)(iy * nx + ix);
          const double cx = mnx + ix * r, cy = mny + iy * r;
          buf.clear();
          grid.collect(cx, cy, search_r, buf);
          double mz = cloth.z[idx];
          for (std::uint32_t pi : buf) {
            const double dx = (double)xs[pi] - cx;
            const double dy = (double)ys[pi] - cy;
            if (dx * dx + dy * dy <= r2 && (double)invz[pi] > mz) mz = (double)invz[pi];
          }
          if (mz > cloth.z[idx]) cloth.z[idx] = mz;
        }
      }
    };
    for (unsigned t = 0; t < nthreads; ++t) pool.emplace_back(collision_rows, t);
    for (auto& th : pool) th.join();

    // 收敛采样（对齐老工具）：量"碰撞后"布料高度的整轮位移——贴地的粒子每轮
    // 回到同一支撑高度（位移≈0，哪怕内部约束仍在小幅拉扯）；悬空粒子每轮位移
    // = 重力步长 0.42 >> eff_eps，绝不会提前悬停。
    double max_lift_dz = 0;
    for (std::size_t i = 0; i < cloth.z.size(); ++i) {
      const double dz = std::fabs(cloth.z[i] - prev_z[i]);
      if (dz > max_lift_dz) max_lift_dz = dz;
    }
    prev_z = cloth.z;  // 快照滚动到本轮"碰撞后"状态

    // 4c. 内部约束：四邻域平均 × rigid，边界粒子保持抬升后的高度（不动）
    for (std::int64_t iy = 1; iy < ny - 1; ++iy) {
      for (std::int64_t ix = 1; ix < nx - 1; ++ix) {
        const std::uint64_t idx = (std::uint64_t)(iy * nx + ix);
        const double avg = (cloth.z[idx - (std::uint64_t)nx] + cloth.z[idx + (std::uint64_t)nx] +
                            cloth.z[idx - 1] + cloth.z[idx + 1]) * 0.25;
        const double diff = (avg - cloth.z[idx]) * rigid;
        z_new[idx] = cloth.z[idx] + diff;
      }
    }
    for (std::int64_t ix = 0; ix < nx; ++ix) {
      z_new[(std::uint64_t)ix] = cloth.z[(std::uint64_t)ix];
      z_new[(std::uint64_t)(ny - 1) * nx + (std::uint64_t)ix] =
          cloth.z[(std::uint64_t)(ny - 1) * nx + (std::uint64_t)ix];
    }
    for (std::int64_t iy = 0; iy < ny; ++iy) {
      z_new[(std::uint64_t)iy * nx] = cloth.z[(std::uint64_t)iy * nx];
      z_new[(std::uint64_t)iy * nx + (std::uint64_t)nx - 1] =
          cloth.z[(std::uint64_t)iy * nx + (std::uint64_t)nx - 1];
    }
    cloth.z.swap(z_new);

    // 4d. 收敛（对齐老工具 csf_native.cc 实际语义，非参考版"零抬升+1mm"判据）：
    //     连续 3 轮整轮位移 < eff_eps 即停。数据空洞处的粒子永不触地 → 每轮位移
    //     恒为重力步长，自然跑满迭代上限兜底（老工具同行为）。
    if (max_lift_dz < eff_eps) {
      if (++settled >= 3) {
        if (onIteration) onIteration(it + 1);
        break;
      }
    } else {
      settled = 0;
    }
    if (cancel.load(std::memory_order_relaxed)) {
      throw std::runtime_error("已取消：分割任务被中止");
    }
    if (onIteration) onIteration(it + 1);
  }

  // ---- 5. 分类：双线性插值布料高度，|倒置点高 − 布面高| <= 阈值判地面 ----
  for (std::size_t c = 0; c < entity.chunks.size(); ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint32_t count = chunkCount[c];
    std::vector<std::uint32_t>& ground = result.groundByChunk[c];
    ground.reserve(count / 2);
    std::uint64_t k = chunkFirst[c];
    for (std::uint32_t j = 0; j < count; ++j, ++k) {
      const double fx = ((double)xs[k] - mnx) / r;
      const double fy = ((double)ys[k] - mny) / r;
      const std::int64_t ix0 = (std::int64_t)std::clamp(fx, 0.0, (double)(nx - 2));
      const std::int64_t iy0 = (std::int64_t)std::clamp(fy, 0.0, (double)(ny - 2));
      const double tx = fx - ix0, ty = fy - iy0;
      const double z00 = cloth.z[(std::uint64_t)(iy0 * nx + ix0)];
      const double z10 = cloth.z[(std::uint64_t)(iy0 * nx + ix0 + 1)];
      const double z01 = cloth.z[(std::uint64_t)((iy0 + 1) * nx + ix0)];
      const double z11 = cloth.z[(std::uint64_t)((iy0 + 1) * nx + ix0 + 1)];
      const double zc = (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
      if (std::fabs((double)invz[k] - zc) <= p.classThreshold) {
        ground.push_back(src.index ? src.index[j] : j);
        ++result.groundTotal;
      }
    }
  }
  return result;
}

}  // namespace csfpro
