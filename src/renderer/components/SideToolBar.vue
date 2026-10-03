<script setup lang="ts">
import { useAlgorithmModals } from '../composables/useAlgorithmModals'

/**
 * 右侧竖向工具栏（与左侧 ViewToolBar 对称的竖排 icon 按钮）：点云算法/后处理入口
 * ——统计滤波、半径滤波、体素滤波、LiDAR 地面分割（CSF）、精准地面分割（csf-pro）、
 * 单木分割（TreeIso）、欧式聚类分割（Euclidean Cluster）、RANSAC 平面拟合、
 * RANSAC 圆柱拟合、点对对齐（Align）、精细配准（ICP）。入口表（含排列顺序与全部文案）
 * 与互斥 toggle 见 composables/useAlgorithmModals —— 顶部 Tools 菜单同源，不再各自维护
 * "进入前先退出其他模态"的清单。点开后参数横条（StatisticalFilterToolBar / FilterToolBar /
 * VoxelToolBar / CsfToolBar / CsfProToolBar / TreeIsoToolBar / EuclideanClusterToolBar /
 * RansacPlaneToolBar / RansacCylinderToolBar / AlignToolBar / IcpToolBar）浮于 3D 视图
 * 右上角；禁用判据**逐项**取 `disabledOf(key)`，不是全表共用一个（两个配准入口要求
 * 恰好选中 2 个点云，比"有选中即可"严格）。
 */
const { disabledOf, isActive, titleOf, toggle } = useAlgorithmModals()
</script>

<template>
  <!-- 右竖工具栏：滤波 / 地面分割算法入口；点开后 3D 视图右上角浮出对应参数横条 -->
  <aside class="side-toolbar" aria-label="右侧工具栏">
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('statisticalFilter') }"
      :disabled="disabledOf('statisticalFilter')"
      :title="titleOf('statisticalFilter')"
      @click="toggle('statisticalFilter')"
    >
      <!-- 统计滤波图标：高斯钟形分布曲线（距离分布主体）+ 右尾两个被剔除的孤立空心点 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M4 19C4.4 11 7.6 5.5 12 5.5S19.6 11 20 19"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
        <path d="M4 19h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="21.6" cy="14" r="1" stroke="currentColor" stroke-width="1.2" />
        <circle cx="22.7" cy="9.5" r="0.7" stroke="currentColor" stroke-width="1.1" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('radiusFilter') }"
      :disabled="disabledOf('radiusFilter')"
      :title="titleOf('radiusFilter')"
      @click="toggle('radiusFilter')"
    >
      <!-- 滤波图标：漏斗（半径内邻居数不足的点被筛掉） -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path d="M3 5h18l-8 10v5l-4 2v-7L3 5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('voxelFilter') }"
      :disabled="disabledOf('voxelFilter')"
      :title="titleOf('voxelFilter')"
      @click="toggle('voxelFilter')"
    >
      <!-- 体素滤波图标：2×2 体素栅格，每格中心一点 = 每格只保留 1 个代表点 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <rect x="5" y="5" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" />
        <rect x="13" y="5" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" />
        <rect x="5" y="13" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" />
        <rect x="13" y="13" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" />
        <circle cx="16" cy="8" r="1.1" fill="currentColor" />
        <circle cx="8" cy="16" r="1.1" fill="currentColor" />
        <circle cx="16" cy="16" r="1.1" fill="currentColor" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('csf') }"
      :disabled="disabledOf('csf')"
      :title="titleOf('csf')"
      @click="toggle('csf')"
    >
      <!-- 地面分割图标：布料（柔弧线）覆在起伏地表（山形线）上方，上下分层 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M4 17.5c1.6-1 3.2-1 4.8 0s3.2 1 4.8 0 3.2-1 4.8 0"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
        <path
          d="M5.5 13.2c1.1-.8 2.4-.8 3.5 0s2.4.8 3.5 0 2.4-.8 3.5 0"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-dasharray="1.5 2.2"
        />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('csfPro') }"
      :disabled="disabledOf('csfPro')"
      :title="titleOf('csfPro')"
      @click="toggle('csfPro')"
    >
      <!-- 精准分割图标：布料（虚线）紧贴起伏地表（实线山形），两层贴近 = 垂坠贴身语义 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M4 18.6c1.6-.9 3.2-.9 4.8 0s3.2.9 4.8 0 3.2-.9 4.8 0"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
        <path
          d="M5.6 16.6c1-.6 2.1-.6 3.1 0s2.1.6 3.1 0 2.1-.6 3.1 0"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-dasharray="1.5 2.2"
        />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('treeIso') }"
      :disabled="disabledOf('treeIso')"
      :title="titleOf('treeIso')"
      @click="toggle('treeIso')"
    >
      <!-- 单木分割图标：两株分离的树（重叠树冠点云 → 劈分成单株的语义；虚线 = 切分处） -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <!-- 左株：双层冠 + 干 -->
        <path
          d="M7.5 3.5 5 7h1.7L4.5 11h6l-2.2-4H10L7.5 3.5z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M7.5 11v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <!-- 右株：较小的待分离单株（虚线轮廓 = 分割产物） -->
        <path
          d="M14.5 9.5 12.6 12h1.2l-1.3 2.6h4.4l-1.3-2.6h1.2l-1.3-2.5z"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
          stroke-dasharray="2 1.6"
        />
        <path
          d="M13.8 14.6V18.5"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-dasharray="2 1.6"
        />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('euclideanCluster') }"
      :disabled="disabledOf('euclideanCluster')"
      :title="titleOf('euclideanCluster')"
      @click="toggle('euclideanCluster')"
    >
      <!-- 欧式聚类图标：三团点各被虚线边界圈住 = 一份点云按距离阈值切成互不相连的独立物体 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <circle cx="6.6" cy="7.8" r="3.9" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.8" />
        <circle cx="16.8" cy="7.4" r="3.4" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.8" />
        <circle cx="12" cy="17.2" r="3.4" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.8" />
        <circle cx="5.4" cy="8.4" r="1" fill="currentColor" />
        <circle cx="7.6" cy="6.7" r="1" fill="currentColor" />
        <circle cx="8.2" cy="9.6" r="1" fill="currentColor" />
        <circle cx="15.8" cy="6.8" r="1" fill="currentColor" />
        <circle cx="17.9" cy="8.6" r="1" fill="currentColor" />
        <circle cx="10.9" cy="16.4" r="1" fill="currentColor" />
        <circle cx="13.3" cy="18.2" r="1" fill="currentColor" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('powerLine') }"
      :disabled="disabledOf('powerLine')"
      :title="titleOf('powerLine')"
      @click="toggle('powerLine')"
    >
      <!-- 电力线图标：一基杆塔 + 两根下垂导线（塔身 = 竖线 + 横担，导线 = 两条抛物线弧） -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path d="M12 5.5V21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M7 8.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M8.4 8.5 11.4 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        <path d="M15.6 8.5 12.6 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        <path d="M2 11.6c3.4 0 6.6 3 10 3s6.6-3 10-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path
          d="M2 16.4c3.4 0 6.6 2.4 10 2.4s6.6-2.4 10-2.4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('ransacPlane') }"
      :disabled="disabledOf('ransacPlane')"
      :title="titleOf('ransacPlane')"
      @click="toggle('ransacPlane')"
    >
      <!-- 平面拟合图标：透视中的倾斜平面 + 平面上的点 + 一枚离群点（RANSAC 的抗外点语义） -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <path
          d="M3.2 14.6 9.4 8.4l11.4 1.4-6.2 6.2z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <circle cx="8.4" cy="12.6" r="1" fill="currentColor" />
        <circle cx="12.6" cy="11.6" r="1" fill="currentColor" />
        <circle cx="16.4" cy="12.4" r="1" fill="currentColor" />
        <circle cx="19.6" cy="5.4" r="1.1" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('ransacCylinder') }"
      :disabled="disabledOf('ransacCylinder')"
      :title="titleOf('ransacCylinder')"
      @click="toggle('ransacCylinder')"
    >
      <!-- 圆柱拟合图标：上下椭圆 + 两条母线的圆柱 + 柱面上的点 + 一枚离群点（RANSAC 的抗外点语义） -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <ellipse cx="11.6" cy="6.4" rx="5.6" ry="2.3" stroke="currentColor" stroke-width="1.5" />
        <path d="M6 6.4v11.2M17.2 6.4v11.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M6 17.6a5.6 2.3 0 0 0 11.2 0" stroke="currentColor" stroke-width="1.5" />
        <circle cx="9.6" cy="11.4" r="1" fill="currentColor" />
        <circle cx="14" cy="13.8" r="1" fill="currentColor" />
        <circle cx="20.6" cy="4.6" r="1.1" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('align') }"
      :disabled="disabledOf('align')"
      :title="titleOf('align')"
      @click="toggle('align')"
    >
      <!-- 点对对齐图标：两组点云（左下 / 右上）之间三条虚线 = 三对以上同名点的对应关系 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <circle cx="4.2" cy="15.2" r="1.15" fill="currentColor" />
        <circle cx="4.2" cy="19.4" r="1.15" fill="currentColor" />
        <circle cx="8.4" cy="17.2" r="1.15" fill="currentColor" />
        <circle cx="19.8" cy="4.6" r="1.15" fill="currentColor" />
        <circle cx="19.8" cy="8.8" r="1.15" fill="currentColor" />
        <circle cx="15.6" cy="6.8" r="1.15" fill="currentColor" />
        <path
          d="M5.3 14.5 18.8 5.5M5.3 18.7 18.8 9.7M9.4 16.4 14.7 8"
          stroke="currentColor"
          stroke-width="1.15"
          stroke-dasharray="1.8 1.5"
        />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('icp') }"
      :disabled="disabledOf('icp')"
      :title="titleOf('icp')"
      @click="toggle('icp')"
    >
      <!-- 精细配准图标：两片错位的点云 + 中间的双向箭头 = 迭代最近点把两片收敛到一起 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <circle cx="5" cy="17.4" r="1.15" fill="currentColor" />
        <circle cx="8.8" cy="19.6" r="1.15" fill="currentColor" />
        <circle cx="5.2" cy="21" r="1.15" fill="currentColor" />
        <circle cx="15.2" cy="3.4" r="1.15" fill="currentColor" />
        <circle cx="19" cy="5.6" r="1.15" fill="currentColor" />
        <circle cx="15.4" cy="7" r="1.15" fill="currentColor" />
        <path d="M9.5 14.5 14.5 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M9.5 14.5l.4-2.7M9.5 14.5l2.7-.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M14.5 9.5l-.4 2.7M14.5 9.5l-2.7.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>
    <button
      class="side-toolbar__btn"
      :class="{ 'side-toolbar__btn--active': isActive('gicp') }"
      :disabled="disabledOf('gicp')"
      :title="titleOf('gicp')"
      @click="toggle('gicp')"
    >
      <!-- GICP 配准图标：两片错位的点云 + 两条不同的连接线表示法向量协方差信息 -->
      <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
        <!-- 左侧点云 -->
        <circle cx="5" cy="17.4" r="1.15" fill="currentColor" />
        <circle cx="8.8" cy="19.6" r="1.15" fill="currentColor" />
        <circle cx="5.2" cy="21" r="1.15" fill="currentColor" />
        <!-- 右侧点云 -->
        <circle cx="15.2" cy="3.4" r="1.15" fill="currentColor" />
        <circle cx="19" cy="5.6" r="1.15" fill="currentColor" />
        <circle cx="15.4" cy="7" r="1.15" fill="currentColor" />
        <!-- 连接线 - 表示点对应关系 -->
        <path d="M9.5 14.5 14.5 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <!-- 双层箭头表示法向量信息 -->
        <path
          d="M9.5 14.5l.4-2.7M9.5 14.5l2.7-.4"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-dasharray="1.5 1"
        />
        <path
          d="M14.5 9.5l-.4 2.7M14.5 9.5l-2.7.4"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-dasharray="1.5 1"
        />
        <!-- 额外的弧线表示法向量的协方差信息 -->
        <path d="M11 10a2 2 0 0 1 2 2" stroke="currentColor" stroke-width="1.2" stroke-dasharray="1 1.5" />
      </svg>
    </button>
  </aside>
</template>

<style scoped>
.side-toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 44px;
  flex-shrink: 0;
  padding: 8px 4px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(30px);
  border-left: 1px solid rgba(0, 0, 0, 0.05);
}
.side-toolbar__btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--md-on-surface);
  background: transparent;
}
.side-toolbar__btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--md-primary);
}
.side-toolbar__btn--active,
.side-toolbar__btn--active:hover {
  background: rgba(96, 0, 167, 0.1);
  color: var(--md-primary);
}
.side-toolbar__btn:disabled {
  color: var(--md-on-surface-variant);
  opacity: 0.38;
  cursor: default;
}
.side-toolbar__btn:disabled:hover {
  background: transparent;
  color: var(--md-on-surface-variant);
}
</style>
