#pragma once
/**
 * TreeIso 单木分割算法主体（native/treeiso，纯 C++，无第三方依赖）。
 *
 * 实现 Xi & Hopkinson (2022) 的三阶段图切分单木分割：
 *   Init（3D 图割超分割）→ Intermediate（2D 图割间隙闭合）→ Final（特征合并）
 * 语义对齐 CloudCompare qTreeIso 插件（GPL-2+，本地参考对照）的行为与参数——
 * 代码为对照参考源码行为自行实现（差异与许可说明见 README-REF.md）。
 *
 * 候选点语义：输入可为全量顶点（index 为空）或可见性索引（index 非空时只处理
 * 其条目，与渲染侧 geometryVisibleIndex 一致）；输出标签与候选一一对应。
 */
#include <cstdint>
#include <vector>

namespace treeiso {

/** 三阶段参数（默认值对齐 qTreeIso 对话框，单位与插件一致）。 */
struct TreeIsoParams {
  // —— Init（初始 3D 超分割）——
  float decimateRes1 = 0.05f;   // 体素抽稀分辨率（m）
  std::uint32_t minNN1 = 5;     // 每点 kNN 查询数（含自身；建图取前 minNN1−1 条）
  float regStrength1 = 1.0f;    // 图割边权乘子 λ1（边权 exp(−d²)·λ1）

  // —— Intermediate（自底向上间隙闭合）——
  float decimateRes2 = 0.1f;    // 各 init 簇内体素抽稀分辨率（m）
  std::uint32_t minNN2 = 10;    // 质心/抽稀点 kNN 查询数（含自身）
  float maxGap = 2.0f;          // 簇间可连边最大空隙（平方距离 m²）
  float regStrength2 = 10.0f;   // 边权乘子 λ2（边权 10/((d+0.001)/0.01)·λ2）

  // —— Final（树冠—树干合并）——
  std::uint32_t minNN3 = 10;    // 组级 kNN 查询数（插件无独立 UI，运行时取 minNN2）
  float relHeightLengthRatio = 0.5f;  // 相对高度判「树冠块」阈值
  float verticalWeight = 0.5f;  // 合并打分中垂直重叠的权重
};

/** 单实体输入。positions 为 xyz 连续坐标（显示坐标已平移亦可：差分距离不受影响）。 */
struct TreeIsoCloud {
  std::vector<float> positions;      // 全量顶点坐标，尺寸 n×3
  std::vector<std::uint32_t> index;  // 可选：候选=这些顶点下标；空 = 全量顶点
};

/**
 * 执行三阶段 TreeIso 分割（v1 单实体）。
 * @return 逐候选标签，1..K（K=最终树木数；与插件 final_segs 标量场值域一致，
 *   便于与 CloudCompare 同云逐点对照）；候选 = index 非空时其条目（按序）、
 *   否则全量顶点（按序）。「点数过少的残点归拢」是渲染侧策略（分桶纯函数按
 *   minPoints 处理），本层输出均为真实组件。
 * 返回空 vector 表示无候选或输入非法。
 */
std::vector<std::int32_t> treeIsoSegment(const TreeIsoCloud& in, const TreeIsoParams& p);

}  // namespace treeiso
