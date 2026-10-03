#include "csf.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <queue>
#include <stdexcept>
#include <string>

/**
 * 实现对照 CloudCompare qCSF（plugins/core/Standard/qCSF，作者 RAMM 实验室，
 * 北京师范大学，GPL-2+；论文 Zhang W et al., Remote Sensing 2016, 8(6):501）。
 * 本文件是按算法语义与数值细节自研的重写（非复制其源码），注释中的函数名
 * 对应 CC 实现里的等价步骤，便于逐点核对。许可证说明见 README-REF.md。
 *
 * 全部模拟在"倒置高度"空间进行：输入向上轴坐标 h 取负得模拟高度
 * simY = -h（CC 里 tmp.y = -P->z 同义）；布料网格铺在水平面（余下两轴）。
 */

namespace csf {

namespace {

/** CC 粒子模拟常量（Particle.cpp / CSF.cpp Parameters）。 */
constexpr double DAMPING = 0.01;          // 速度阻尼
constexpr double GRAVITY = 0.2;           // 重力加速度（乘 dt^2 后一次加足）
constexpr double CLOTH_Y_HEIGHT = 0.05;   // 布料初始高度：倒置最高点上方 0.05
constexpr int CLOTH_BUFFER = 2;           // 布料网格相对 AABB 的外扩格数
constexpr double SMOOTH_THRESHOLD = 0.3;  // 陡坡后处理：地形高差阈值（CC 硬编码）
constexpr double HEIGHT_THRESHOLD = 9999.0;  // CC 硬编码 9999：实际恒不限制
constexpr double EARLY_STOP_DIFF = 0.005;    // 每轮最大位移小于它即收敛早停
/** 布料粒子数上限：防 clothResolution 过小导致内存/耗时失控（抛异常提示）。 */
constexpr std::uint64_t kMaxClothParticles = 16777216ull;  // 2^24

/**
 * 约束满足位移系数表（CC Particle.cpp，SingleMove1/DoubleMove1 原样数值）。
 * 单侧（另一粒子已 pin）按几何级数 1-0.7^n 逼近"多轮松弛到刚硬"的结果；
 * 双侧各按另一张表。索引 = rigidness，>14 封顶取末值（CC 语义）。
 */
constexpr double SingleMove1[15] = {0,      0.3,     0.51,    0.657,   0.7599,
                                    0.83193, 0.88235, 0.91765, 0.94235, 0.95965,
                                    0.97175, 0.98023, 0.98616, 0.99031, 0.99322};
constexpr double DoubleMove1[15] = {0,      0.3,   0.42,  0.468,  0.4872,
                                    0.4949, 0.498, 0.4992, 0.4997, 0.4999,
                                    0.4999, 0.5,   0.5,   0.5,    0.5};

/** 由高度轴推导水平面两轴：a/b 为余下两轴按小到大排列（CC 里 a 对应 x、b 对应 z 序）。 */
struct PlaneAxes {
  int a;
  int b;
};
PlaneAxes planeAxesOf(int up) {
  if (up == 0) return {1, 2};
  if (up == 1) return {0, 2};
  return {0, 1};
}

/** 候选点全局编码：高 32 位 = 块下标，低 32 位 = 该块内候选序号（与半径滤波同款）。 */
constexpr unsigned CHUNK_SHIFT = 32;
inline std::uint64_t encodeCandidate(std::uint32_t chunk, std::uint32_t local) {
  return (static_cast<std::uint64_t>(chunk) << CHUNK_SHIFT) | local;
}

/**
 * 布料状态（整张平铺数组，v1 忠实移植未做 SoA；注释对应 CC Cloth/Particle）。
 * 粒子索引 = row * W + col（row = b 轴格号、col = a 轴格号）。
 */
struct Cloth {
  int W = 0;                 // a 轴粒子数（num_particles_width）
  int H = 0;                 // b 轴粒子数（num_particles_height）
  double res = 1.0;          // 格距（step_x = step_y = cloth_resolution）
  double originA = 0.0;      // a 轴最小粒子坐标（origin_pos.x）
  double originB = 0.0;      // b 轴最小粒子坐标（origin_pos.z）
  double startSimY = 0.0;    // 粒子初始模拟高度（origin_pos.y，布料水平放置）

  // 粒子状态
  std::vector<double> posY;        // Particle::pos.y（当前模拟高度）
  std::vector<double> oldY;        // Particle::old_pos_y（Verlet 上一帧高度）
  std::vector<std::uint8_t> movable;  // Particle::movable（是否可动/pin）
  std::vector<double> heightvals;  // 高度场：每格地面（倒置空间）高度
  std::vector<double> nearestH;    // 光栅化：格内最近点高度（Particle::nearestPointHeight）
  std::vector<double> nearestD;    // 光栅化：格内最近点平面距离（Particle::nearestPointDist）
  std::vector<std::uint8_t> rasterVis;  // 光栅空格补齐 BFS 的 visited（与 CC isVisited 隔离）
  std::vector<std::uint8_t> compVis;    // movableFilter 连通块 BFS 的 visited
  std::vector<int> compPos;             // 粒子在所属连通块内的局部序号（Particle::c_pos）

  // 邻接表（CC 是每粒子 std::vector<Particle*>；此处平铺为 CSR，条目顺序
  // 与 CC 的 addConstraint 调用顺序一致，保证约束单遍修正的逐点行为相同）
  std::vector<std::uint32_t> adjBegin;  // 前缀（size = Np + 1）
  std::vector<std::uint32_t> adjList;   // 邻居粒子索引（扁平）

  std::size_t size() const { return static_cast<std::size_t>(W) * H; }

  /** 粒子的 a/b 网格坐标。 */
  inline void gridXy(std::size_t i, int& col, int& row) const {
    col = static_cast<int>(i % W);
    row = static_cast<int>(i / W);
  }
  inline std::size_t indexOf(int col, int row) const {
    return static_cast<std::size_t>(row) * W + col;
  }
};

/** 把 CC 的两轮约束构建（距离 1/√2 与 2/√4，含两条对角线）原样转录为 CSR。 */
void buildAdjacency(Cloth& cloth) {
  const int W = cloth.W;
  const int H = cloth.H;
  const std::size_t Np = cloth.size();
  cloth.adjBegin.assign(Np + 1, 0);
  cloth.adjList.clear();

  // 第一遍只计数度数（addConstraint 的调用序列与 CC 逐条一致）
  std::vector<std::uint32_t> deg(Np, 0);
  const auto countEdge = [&](std::size_t i, std::size_t j) {
    ++deg[i];
    ++deg[j];
  };
  for (int x = 0; x < W; ++x) {
    for (int y = 0; y < H; ++y) {
      const std::size_t i = static_cast<std::size_t>(y) * W + x;
      if (x < W - 1) countEdge(i, i + 1);
      if (y < H - 1) countEdge(i, i + W);
      if (x < W - 1 && y < H - 1) {
        countEdge(i, i + W + 1);
        countEdge(i + 1, i + W);
      }
      if (x < W - 2) countEdge(i, i + 2);
      if (y < H - 2) countEdge(i, i + 2 * W);
      if (x < W - 2 && y < H - 2) {
        countEdge(i, i + 2 * W + 2);
        countEdge(i + 2, i + 2 * W);
      }
    }
  }
  for (std::size_t i = 0; i < Np; ++i) cloth.adjBegin[i + 1] = cloth.adjBegin[i] + deg[i];
  cloth.adjList.assign(cloth.adjBegin[Np], 0);
  std::vector<std::uint32_t> cursor = cloth.adjBegin;  // 每粒子当前写入位（不含尾哨兵）
  const auto addEdge = [&](std::size_t i, std::size_t j) {
    cloth.adjList[cursor[i]++] = static_cast<std::uint32_t>(j);
    cloth.adjList[cursor[j]++] = static_cast<std::uint32_t>(i);
  };
  for (int x = 0; x < W; ++x) {
    for (int y = 0; y < H; ++y) {
      const std::size_t i = static_cast<std::size_t>(y) * W + x;
      if (x < W - 1) addEdge(i, i + 1);
      if (y < H - 1) addEdge(i, i + W);
      if (x < W - 1 && y < H - 1) {
        addEdge(i, i + W + 1);
        addEdge(i + 1, i + W);
      }
      if (x < W - 2) addEdge(i, i + 2);
      if (y < H - 2) addEdge(i, i + 2 * W);
      if (x < W - 2 && y < H - 2) {
        addEdge(i, i + 2 * W + 2);
        addEdge(i + 2, i + 2 * W);
      }
    }
  }
}

/**
 * 对布料的某一步时间推进（CC Particle::timeStep）：Verlet 积分；
 * 每粒子相互独立，串行结果与 CC 的 omp 并行等价。
 */
void particleTimeStep(Cloth& cloth, double acceleration) {
  const std::size_t Np = cloth.size();
  for (std::size_t i = 0; i < Np; ++i) {
    if (cloth.movable[i]) {
      const double deltaY = cloth.posY[i] - cloth.oldY[i];
      cloth.oldY[i] = cloth.posY[i];
      cloth.posY[i] += deltaY * (1.0 - DAMPING) + acceleration;
    }
  }
}

/**
 * 约束单遍满足（CC Particle::satisfyConstraintSelf 的串行全网格版）：
 * 沿 CC 的 addConstraint 顺序对每粒子遍历其邻居做高度修正，位移系数查表。
 */
void satisfyConstraints(Cloth& cloth, int rigidness) {
  const int r = rigidness > 14 ? 14 : (rigidness < 0 ? 0 : rigidness);
  const double singleF = rigidness > 14 ? 1.0 : SingleMove1[r];
  const double doubleF = rigidness > 14 ? 0.5 : DoubleMove1[r];
  const std::size_t Np = cloth.size();
  for (std::size_t p1 = 0; p1 < Np; ++p1) {
    const std::uint32_t begin = cloth.adjBegin[p1];
    const std::uint32_t end = cloth.adjBegin[p1 + 1];
    const bool p1Movable = cloth.movable[p1] != 0;
    if (!p1Movable) {
      // CC：p1 已 pin、p2 可动 → p2 向 p1 靠拢：p2.y -= (p2.y - p1.y) * f
      for (std::uint32_t e = begin; e < end; ++e) {
        const std::size_t p2 = cloth.adjList[e];
        if (cloth.movable[p2]) {
          const double correction = cloth.posY[p2] - cloth.posY[p1];
          cloth.posY[p2] -= correction * singleF;
        }
      }
      continue;
    }
    for (std::uint32_t e = begin; e < end; ++e) {
      const std::size_t p2 = cloth.adjList[e];
      const double correction = cloth.posY[p2] - cloth.posY[p1];
      if (cloth.movable[p2]) {
        const double half = correction * doubleF;
        cloth.posY[p1] += half;
        cloth.posY[p2] -= half;
      } else {
        cloth.posY[p1] += correction * singleF;
      }
    }
  }
}

/** 碰撞检测（CC Cloth::terrainCollision）：低于所在格高度场即夹紧并 pin。 */
void terrainCollision(Cloth& cloth) {
  const std::size_t Np = cloth.size();
  for (std::size_t i = 0; i < Np; ++i) {
    if (cloth.posY[i] < cloth.heightvals[i]) {
      cloth.posY[i] = cloth.heightvals[i];
      cloth.movable[i] = 0;
    }
  }
}

/** 本轮最大位移（CC Cloth::timeStep 返回的 maxDiff，仅统计可动粒子）。 */
double maxDiffOf(const Cloth& cloth) {
  double maxDiff = 0.0;
  const std::size_t Np = cloth.size();
  for (std::size_t i = 0; i < Np; ++i) {
    if (cloth.movable[i]) {
      const double diff = std::abs(cloth.oldY[i] - cloth.posY[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  return maxDiff;
}

/**
 * 空格高度补齐（CC Rasterization::FindHeightValByScanline + 兜底 BFS）：
 * 先沿 a 轴右/左、再沿 b 轴下/上找第一个有记录的格子，找不到则沿邻接表 BFS。
 */
double findHeightByScanline(Cloth& cloth, std::size_t i) {
  int col = 0;
  int row = 0;
  cloth.gridXy(i, col, row);
  const int W = cloth.W;
  const int H = cloth.H;
  constexpr double NONE = std::numeric_limits<double>::lowest();

  for (int c = col + 1; c < W; ++c) {
    const double h = cloth.nearestH[cloth.indexOf(c, row)];
    if (h > NONE) return h;
  }
  for (int c = col - 1; c >= 0; --c) {
    const double h = cloth.nearestH[cloth.indexOf(c, row)];
    if (h > NONE) return h;
  }
  for (int r = row - 1; r >= 0; --r) {
    const double h = cloth.nearestH[cloth.indexOf(col, r)];
    if (h > NONE) return h;
  }
  for (int r = row + 1; r < H; ++r) {
    const double h = cloth.nearestH[cloth.indexOf(col, r)];
    if (h > NONE) return h;
  }

  // BFS 兜底：沿邻接表扩散找最近有值格（grid 连通，理论必能找到）
  std::queue<std::size_t> que;
  for (std::uint32_t e = cloth.adjBegin[i]; e < cloth.adjBegin[i + 1]; ++e) {
    que.push(cloth.adjList[e]);
  }
  cloth.rasterVis[i] = 1;
  std::vector<std::size_t> backlist;
  while (!que.empty()) {
    const std::size_t p = que.front();
    que.pop();
    backlist.push_back(p);
    if (cloth.nearestH[p] > NONE) {
      for (const std::size_t q : backlist) cloth.rasterVis[q] = 0;
      while (!que.empty()) {
        cloth.rasterVis[que.front()] = 0;
        que.pop();
      }
      return cloth.nearestH[p];
    }
    for (std::uint32_t e = cloth.adjBegin[p]; e < cloth.adjBegin[p + 1]; ++e) {
      const std::size_t q = cloth.adjList[e];
      if (!cloth.rasterVis[q]) {
        cloth.rasterVis[q] = 1;
        que.push(q);
      }
    }
  }
  return NONE;  // 全网格无记录（候选非空时不会发生）
}

/**
 * 高度场光栅化（CC Rasterization::RasterTerrain）：对每个候选点做
 * 四舍五入归属最近粒子格，格内保留"平面距离最近点"的模拟高度；
 * 无点落到的空格经扫描线/BFS 从邻近格补齐。
 */
template <typename CoordFn>
void rasterTerrain(Cloth& cloth, std::uint64_t totalCandidates, const CoordFn& coordOf) {
  // 每点归属粒子格（col/row），格内留最近点
  for (std::uint64_t g = 0; g < totalCandidates; ++g) {
    double pa, pb, h;
    coordOf(g, pa, pb, h);
    const int col = static_cast<int>((pa - cloth.originA) / cloth.res + 0.5);
    const int row = static_cast<int>((pb - cloth.originB) / cloth.res + 0.5);
    if (col < 0 || row < 0 || col >= cloth.W || row >= cloth.H) continue;  // 防御越界
    const std::size_t i = cloth.indexOf(col, row);
    const double dx = (cloth.originA + col * cloth.res) - pa;
    const double dz = (cloth.originB + row * cloth.res) - pb;
    const double dist = dx * dx + dz * dz;
    if (dist < cloth.nearestD[i]) {
      cloth.nearestD[i] = dist;
      cloth.nearestH[i] = h;
    }
  }
  // 空格补齐
  const std::size_t Np = cloth.size();
  for (std::size_t i = 0; i < Np; ++i) {
    cloth.heightvals[i] = cloth.nearestH[i] > std::numeric_limits<double>::lowest()
                              ? cloth.nearestH[i]
                              : findHeightByScanline(cloth, i);
  }
}

/**
 * 陡坡后处理（CC Cloth::movableFilter / findUnmovablePoint /
 * handle_slop_connected 的原样移植）：可动粒子按 4 邻域 BFS 求连通块，
 * 块内粒子数 > 100 才处理；把与已 pin 邻居接壤、且两侧地形高差 < 0.3 的
 * 悬空粒子拉到高度场并 pin，再沿块内邻接关系 BFS 扩散。
 */
void movableFilter(Cloth& cloth) {
  const int W = cloth.W;
  const int H = cloth.H;
  const std::size_t Np = cloth.size();
  cloth.compVis.assign(Np, 0);
  cloth.compPos.assign(Np, -1);

  for (int x0 = 0; x0 < W; ++x0) {
    for (int y0 = 0; y0 < H; ++y0) {
      const std::size_t start = cloth.indexOf(x0, y0);
      if (!cloth.movable[start] || cloth.compVis[start]) continue;

      // BFS 收集连通块（顺序与 CC 相同：先左后右再下再上）
      std::vector<std::size_t> connected;  // 块内粒子（CC 的 connected，存 XY，此处存索引）
      std::vector<std::vector<int>> neibors;  // 每粒子的可动 4 邻域在 connected 内的局部序号
      std::queue<std::size_t> que;
      connected.push_back(start);
      cloth.compVis[start] = 1;
      cloth.compPos[start] = 0;
      que.push(start);
      while (!que.empty()) {
        const std::size_t cur = que.front();
        que.pop();
        int col = 0;
        int row = 0;
        cloth.gridXy(cur, col, row);
        std::vector<int> neighbor;
        const auto tryNeighbor = [&](std::size_t nb) {
          if (!cloth.movable[nb]) return;
          if (!cloth.compVis[nb]) {
            cloth.compVis[nb] = 1;
            cloth.compPos[nb] = static_cast<int>(connected.size());
            connected.push_back(nb);
            que.push(nb);
            neighbor.push_back(cloth.compPos[nb]);
          } else {
            neighbor.push_back(cloth.compPos[nb]);
          }
        };
        if (col > 0) tryNeighbor(cur - 1);
        if (col < W - 1) tryNeighbor(cur + 1);
        if (row > 0) tryNeighbor(cur - W);
        if (row < H - 1) tryNeighbor(cur + W);
        neibors.push_back(std::move(neighbor));
      }

      if (connected.size() <= 100) continue;  // CC：小块不做陡坡处理

      // 找与已 pin 邻居接壤的块边粒子并 pin（条件见 CC findUnmovablePoint）
      std::vector<int> edgePoints;
      for (std::size_t ci = 0; ci < connected.size(); ++ci) {
        const std::size_t i = connected[ci];
        int col = 0;
        int row = 0;
        cloth.gridXy(i, col, row);
        const auto tryPinToUnmovable = [&](std::size_t nb, int ncol, int nrow) {
          if (cloth.movable[nb]) return;
          const std::size_t iref = cloth.indexOf(ncol, nrow);
          if (std::abs(cloth.heightvals[i] - cloth.heightvals[iref]) < SMOOTH_THRESHOLD &&
              cloth.posY[i] - cloth.heightvals[i] < HEIGHT_THRESHOLD) {
            cloth.posY[i] = cloth.heightvals[i];
            cloth.movable[i] = 0;
            edgePoints.push_back(static_cast<int>(ci));
          }
        };
        if (col > 0) {
          tryPinToUnmovable(i - 1, col - 1, row);
          if (!cloth.movable[i]) continue;
        }
        if (col < W - 1) {
          tryPinToUnmovable(i + 1, col + 1, row);
          if (!cloth.movable[i]) continue;
        }
        if (row > 0) {
          tryPinToUnmovable(i - W, col, row - 1);
          if (!cloth.movable[i]) continue;
        }
        if (row < H - 1) {
          tryPinToUnmovable(i + W, col, row + 1);
        }
      }

      // 沿块内邻接关系扩散 pin（CC handle_slop_connected）
      std::vector<std::uint8_t> visited(connected.size(), 0);
      std::queue<int> spread;
      for (const int ep : edgePoints) {
        spread.push(ep);
        visited[static_cast<std::size_t>(ep)] = 1;
      }
      while (!spread.empty()) {
        const int ci = spread.front();
        spread.pop();
        const std::size_t ic = connected[static_cast<std::size_t>(ci)];
        for (const int nj : neibors[static_cast<std::size_t>(ci)]) {
          const std::size_t in = connected[static_cast<std::size_t>(nj)];
          if (std::abs(cloth.heightvals[ic] - cloth.heightvals[in]) < SMOOTH_THRESHOLD &&
              std::abs(cloth.posY[in] - cloth.heightvals[in]) < HEIGHT_THRESHOLD) {
            cloth.posY[in] = cloth.heightvals[in];
            cloth.movable[in] = 0;
            if (!visited[static_cast<std::size_t>(nj)]) {
              visited[static_cast<std::size_t>(nj)] = 1;
              spread.push(nj);
            }
          }
        }
      }
    }
  }
}

}  // namespace

EntityResult classifyEntity(const EntitySource& entity, const ClassifyParams& params) {
  EntityResult result;
  const std::size_t chunkCount = entity.chunks.size();
  result.groundByChunk.resize(chunkCount);
  if (chunkCount == 0) return result;

  // ---- 0) 候选计数与全局起点前缀（同半径滤波） ----
  std::vector<std::uint64_t> chunkStart(chunkCount + 1, 0);
  std::uint64_t totalCandidates = 0;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    chunkStart[c] = totalCandidates;
    totalCandidates += entity.chunks[c].index ? entity.chunks[c].indexCount
                                              : entity.chunks[c].vertexCount;
  }
  chunkStart[chunkCount] = totalCandidates;
  if (totalCandidates == 0) return result;  // 无候选：全部为空（非地面）

  if (!(params.clothResolution > 0.0)) {
    return result;  // 分辨率非法：地面为空（全部判非地面），语义与半径滤波的非法参数一致
  }
  const double res = params.clothResolution;
  const int up = params.heightAxis <= 2 ? params.heightAxis : 2;
  const PlaneAxes axes = planeAxesOf(up);
  const double timeStep2 = params.timeStep * params.timeStep;
  const double acceleration = -GRAVITY * timeStep2;

  // 候选点坐标读取器：返回水平面两轴与模拟高度（倒置）
  const auto coordOf = [&](std::uint64_t g, double& pa, double& pb, double& simY) {
    // 定位 (chunk, local)（候选按块连续，与半径滤波同一套步进）
    std::size_t chunk = 0;
    std::uint64_t local = g - chunkStart[0];
    while (chunk + 1 < chunkCount && chunkStart[chunk + 1] <= g) {
      ++chunk;
      local = g - chunkStart[chunk];
    }
    const ChunkSource& src = entity.chunks[chunk];
    const std::uint32_t vertex = src.index ? src.index[local] : static_cast<std::uint32_t>(local);
    const float* p = src.positions + static_cast<std::size_t>(vertex) * 3;
    pa = p[axes.a];
    pb = p[axes.b];
    simY = -static_cast<double>(p[up]);
  };

  // ---- 1) 实体候选水平面范围（布料网格覆盖全局） ----
  double minA = std::numeric_limits<double>::infinity();
  double maxA = -std::numeric_limits<double>::infinity();
  double minB = std::numeric_limits<double>::infinity();
  double maxB = -std::numeric_limits<double>::infinity();
  double minH = std::numeric_limits<double>::infinity();  // 向上轴坐标的最小值
  {
    double pa, pb, simY;
    for (std::uint64_t g = 0; g < totalCandidates; ++g) {
      coordOf(g, pa, pb, simY);
      minA = std::min(minA, pa);
      maxA = std::max(maxA, pa);
      minB = std::min(minB, pb);
      maxB = std::max(maxB, pb);
      minH = std::min(minH, -simY);
    }
  }
  // 布好网格（CC：AABB 外扩 clothBuffer 格，粒子数 = floor(跨度/res) + 2*buffer）
  Cloth cloth;
  cloth.W = static_cast<int>(std::floor((maxA - minA) / res)) + 2 * CLOTH_BUFFER;
  cloth.H = static_cast<int>(std::floor((maxB - minB) / res)) + 2 * CLOTH_BUFFER;
  const std::uint64_t Np = static_cast<std::uint64_t>(cloth.W) * cloth.H;
  if (Np > kMaxClothParticles) {
    throw std::runtime_error(
        "CSF：布料网格粒子数 " + std::to_string(Np) + " 超过上限 " +
        std::to_string(kMaxClothParticles) +
        "（clothResolution 过小或地幅过大，请调大布料分辨率或先裁剪区域）");
  }
  cloth.res = res;
  cloth.originA = minA - CLOTH_BUFFER * res;
  cloth.originB = minB - CLOTH_BUFFER * res;
  cloth.startSimY = -minH + CLOTH_Y_HEIGHT;  // CC：origin.y = bbMax.y + clothYHeight

  // ---- 2) 粒子状态初始化（水平放置、全部可动） ----
  cloth.posY.assign(Np, cloth.startSimY);
  cloth.oldY.assign(Np, cloth.startSimY);
  cloth.movable.assign(Np, 1);
  cloth.heightvals.assign(Np, 0.0);
  cloth.nearestH.assign(Np, std::numeric_limits<double>::lowest());
  cloth.nearestD.assign(Np, std::numeric_limits<double>::max());
  cloth.rasterVis.assign(Np, 0);

  // ---- 3) 邻接表 + 高度场光栅化 ----
  buildAdjacency(cloth);
  rasterTerrain(cloth, totalCandidates, coordOf);

  // ---- 4) 布料模拟迭代（CC 主循环，含 0.005 收敛早停的原样条件） ----
  const int iterations = params.iterations > 0 ? params.iterations : 0;
  for (int iter = 0; iter < iterations; ++iter) {
    particleTimeStep(cloth, acceleration);
    satisfyConstraints(cloth, params.rigidness);
    const double maxDiff = maxDiffOf(cloth);
    terrainCollision(cloth);
    if (maxDiff != 0.0 && maxDiff < EARLY_STOP_DIFF) break;
  }

  // ---- 5) 陡坡后处理（可选，CC 对话框 post-processing） ----
  if (params.smoothSlope) {
    movableFilter(cloth);
  }

  // ---- 6) 分类（CC Cloud2CloudDist::Compute：四角粒子高度双线性插值） ----
  const double threshold = params.classThreshold;
  std::vector<std::uint8_t> isGround(totalCandidates, 0);
  {
    const int W = cloth.W;
    for (std::uint64_t g = 0; g < totalCandidates; ++g) {
      double pa, pb, simY;
      coordOf(g, pa, pb, simY);
      const double deltaA = pa - cloth.originA;
      const double deltaB = pb - cloth.originB;
      const int col0 = static_cast<int>(deltaA / res);  // CC 用截断（范围内即 floor）
      const int row0 = static_cast<int>(deltaB / res);
      if (col0 < 0 || row0 < 0 || col0 + 1 >= W || row0 + 1 >= cloth.H) {
        // 越界防御：正常输入不会发生（布料覆盖 AABB 外扩 2 格）
        isGround[g] = 0;
        continue;
      }
      const double subA = (deltaA - col0 * res) / res;
      const double subB = (deltaB - row0 * res) / res;
      const double y00 = cloth.posY[static_cast<std::size_t>(row0) * W + col0];
      const double y01 = cloth.posY[static_cast<std::size_t>(row0 + 1) * W + col0];  // (col0,row0+1)
      const double y11 = cloth.posY[static_cast<std::size_t>(row0 + 1) * W + col0 + 1];
      const double y10 = cloth.posY[static_cast<std::size_t>(row0) * W + col0 + 1];
      // CC 表达式：f(0,0)(1-x)(1-y)+f(0,1)(1-x)y+f(1,1)xy+f(1,0)x(1-y)
      const double fxy = y00 * (1.0 - subA) * (1.0 - subB) + y01 * (1.0 - subA) * subB +
                         y11 * subA * subB + y10 * subA * (1.0 - subB);
      if (std::abs(fxy - simY) < threshold) isGround[g] = 1;
    }
  }

  // ---- 7) 按块回填地面顶点下标（候选序自增 → 每块递增，与半径滤波输出同构） ----
  std::uint64_t total = 0;
  for (std::size_t c = 0; c < chunkCount; ++c) {
    const ChunkSource& src = entity.chunks[c];
    const std::uint64_t n = chunkStart[c + 1] - chunkStart[c];
    auto& ground = result.groundByChunk[c];
    for (std::uint64_t k = 0; k < n; ++k) {
      if (isGround[chunkStart[c] + k]) {
        const std::uint32_t vertex =
            src.index ? src.index[k] : static_cast<std::uint32_t>(k);
        ground.push_back(vertex);
      }
    }
    total += ground.size();
  }
  result.groundTotal = total;
  return result;
}

}  // namespace csf
