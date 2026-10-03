/**
 * 「物体身份」的纯函数：由**编号**派生名字（不碰 store / three / DOM，可直接单测）。
 *
 * 背景：单木分割 / 欧式聚类的产物是"物体"，各有编号（`SceneEntity.labelNo`，见
 * sceneStore）。名字必须跟着编号走——名字里写的是身份，不是"第几个建出来的"：
 * - 算法产物按编号命名（`Tree 7`），改最小点数滤掉某棵时不会与别的树撞名（旧实现按
 *   保留序下标命名，与颜色对不上）；
 * - 合并产物是**新物体**：拿新编号 + 新色，名字里带上它由哪几号合成，于是"两棵树合成
 *   一棵"之后不会出现"容器里有两个 `Tree 3`"（沿用主导方旧名的旧毛病）。
 */

/**
 * 物体命名族：`Tree 3` / `Cluster 12` / `Tree 3.segmented` 都算 Tree 族。
 *
 * 只认这两个词 + 词边界：族名是**产品语义**（单木 / 聚类），不是任意前缀——普通点云
 * 的名字是文件名，套用"族名 + 编号"反而把文件名丢了（见 mergeProductName 第 2 条）。
 */
const FAMILY_PATTERN = /^(Tree|Cluster)\b/

/**
 * 合并产物的名字（`Tree 6 (3+5)` 形状）。
 *
 * 三条规则按序生效：
 * 1. 主导方名字带族名前缀 ⇒ `<族名> <新编号>`——合并产出的是一个新的同族物体；
 * 2. 不带族名 ⇒ 沿用主导方名字（普通点云合并，文件名比编号有用得多）；
 * 3. 有来源编号时追加 `(<来源编号>+…)`：一眼看出它由哪几号合成（完整记录在日志里）。
 *
 * @param leadName  主导方（entityIds[0]）的名字
 * @param sourceNos 各来源的编号（按来源顺序；无编号的来源不参与，空 = 不追加括号）
 * @param newNo     产物的新编号
 */
export function mergeProductName(leadName: string, sourceNos: number[], newNo: number): string {
  const family = FAMILY_PATTERN.exec(leadName)?.[1]
  const base = family ? `${family} ${newNo}` : leadName
  return sourceNos.length > 0 ? `${base} (${sourceNos.join('+')})` : base
}
