# csf-lidar：算法出处与许可证说明

本模块的 C++ 算法（`src/csf.cc` / `src/csf.h`）是 **LiDAR CSF（Cloth
Simulation Filtering）地面分割算法的自研重写**，语义与数值细节对齐
CloudCompare 的 qCSF 插件，供逐点对照验证。

> 适用场景说明：本版为 CloudCompare 机载语义的忠实移植——布料以
> pin + 结构约束实现，在起伏剧烈的地形（丘陵/山脉/土方）上会被边缘
> 撑起形成架桥，坡面易整体判为非地面；此类数据请改用地形贴身语义的
> `native/csf-pro`。

## 参考出处

- 论文：Zhang W, Qi J, Wan P, et al. *An Easy-to-Use Airborne LiDAR Data
  Filtering Method Based on Cloth Simulation*. Remote Sensing, 2016, 8(6):501.
  （开放获取：https://www.mdpi.com/2072-4292/8/6/501）
- CloudCompare qCSF 插件源码（本实现的语义基准）：
  https://github.com/CloudCompare/CloudCompare/tree/master/plugins/core/Standard/qCSF
  - 作者：RAMM 实验室（北京师范大学），Wuming Zhang / Jianbo Qi / Peng Wan
    / Hongtao Wang；许可证 **GPL-2+**。
- 独立 CSF 库（同作者，MATLAB/Python 绑定的上游）：
  https://github.com/jianboqi/CSF
- 项目内保存的文章（原理与参数讲解）：`doc/CSF地面识别算法/`。

## 许可证说明

本目录代码按算法语义与公开论文描述**自研重写**，未复制 CC/CSF 的源码文本；
其中位移系数表等数值序列为算法参数（数学事实），且完整重现在原论文及其
公开实现中。即便如此，本项目若以任何形式分发 native/csf-lidar，仍建议保留本
README 的出处标注与上述引用要求（qCSF 头文件要求引用论文）。

> 本项目主体为 MIT；本目录自研代码默认同样以 MIT 许可分发，但使用方需
> 知悉其算法源自 GPL-2+ 参考实现的思想，如对许可边界敏感，请先咨询法务。
