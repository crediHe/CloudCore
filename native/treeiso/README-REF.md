# treeiso：算法出处与许可证说明

本模块的 C++ 算法（`src/treeiso.cc` / `src/cutpursuit.cc` / `src/kdtree.h`
等）是 **TreeIso 单木分割算法的自研实现**：三阶段图切分流水线
（Init 3D 图割超分割 → Intermediate 2D 图割间隙闭合 → Final 树冠—树干
迭代合并）的行为、参数与数值细节对齐 CloudCompare 的 qTreeIso 插件，供
逐点对照验证。

## 参考出处

- 论文：Xi Z, Hopkinson C. *3D Graph-Based Individual-Tree Isolation
  (TreeIso) from Terrestrial Laser Scanning Point Clouds*. Remote Sensing,
  2022, 14(23):6116.（开放获取：https://doi.org/10.3390/rs14236116）
- 图割基础：Landrieu L, Obozinski G. *Cut Pursuit: Fast Algorithms to Learn
  Piecewise Constant Functions on General Weighted Graphs*. SIAM Journal on
  Imaging Sciences, 2017, 10(4):1724–1766.
- CloudCompare qTreeIso 插件源码（本实现的语义基准，本地对照）：
  https://github.com/CloudCompare/CloudCompare/tree/master/plugins/core/Standard/qTreeIso
  - 作者：Zhouxin Xi / Chris Hopkinson（Artemis Lab，University of
    Lethbridge）；许可证 **GPL-2+**。
- 论文同源公开代码（MATLAB/Python）：https://github.com/truebelief/artemis_treeiso

## 许可证说明

本目录代码按算法语义与公开论文描述**自研重写**，未复制 CC/CC 插件源码
文本（仅对照其可观测行为与参数惯例）。重写过程中依据行为差异做了若干
防御性修正，均以中文注释标注在对应源码位置（如：参考实现 `median_col`
就地重排入参、0 面积包围盒交叠比产生 NaN、`score_highest` 实为降序数组
首元素、逐组 kNN 在第 1 列越界等）。即便如此，本项目若以任何形式分发
native/treeiso，仍建议保留本 README 的出处标注与论文引用要求（qTreeIso
头文件要求引用论文与 cut-pursuit 论文）。

> 本项目主体为 MIT；本目录自研代码默认同样以 MIT 许可分发，但使用方需
> 知悉其算法源自 GPL-2+ 参考实现的思想，如对许可边界敏感，请先咨询法务。
