import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  applyEntityTransformToPoint,
  buildOrientationPoints,
  buildTransformationFilters,
  composePreviewPose,
  defaultGicpParams,
  defaultIcpParams,
  describeIcpResult,
  resolveRegistrationPair,
  rotationFilterMask,
  toEntityTransform,
  GICP_APPLY_TRANSFO,
  GICP_ERROR_INVALID_INPUT,
  GICP_NOTHING_TO_DO,
  ICP_APPLY_TRANSFO,
  ICP_ERROR_INVALID_INPUT,
  ICP_NOTHING_TO_DO,
  MIN_PAIRS_COUNT,
  SKIP_NONE,
  SKIP_ROTATION,
  SKIP_RXY,
  SKIP_RXZ,
  SKIP_RYZ,
  SKIP_TX,
  SKIP_TY,
  SKIP_TZ,
} from '../../../../src/renderer/utils/registration'
import type {
  GicpParams,
  GicpRequest,
  GicpResult,
  IcpParams,
  IcpRequest,
  IcpResult,
  OrientationRequest,
  OrientationResult,
  PreviewPose,
  RegistrationAddon,
  RegistrationPair,
} from '../../../../src/renderer/utils/registration'
import type { RadiusFilterChunkSource } from '../../../../src/renderer/utils/radiusFilter'
import type { SceneEntity, SceneProject, SceneSelection } from '../../../../src/renderer/stores/sceneStore'

// 纯函数组在 node 环境即可；原生组直连编译产物（N-API 对 Node 与 Electron 通用），
// 产物缺失（CI 无编译链）时整组 skip（同 euclideanCluster.spec / normalEstimate.spec 惯例）。
//
// 对照基准分两类，**刻意不同**：
// - 纯算术通路（变换布局、点对方向、过滤器里的平移置零）断言**逐位相等**；
// - 过滤器里的旋转通路含 asin/atan2/cos/sin，MSVC 的 UCRT 与 V8 的 fdlibm 可能差 1 ulp
//  （同 ransacPlane.spec 放弃镜像 Math.log 的理由），故那部分用 toBeCloseTo(…, 12)——
//   公式写错会差到肉眼可见，1 ulp 级差异不该让测试红。

const NATIVE_PATH = fileURLToPath(
  new URL('../../../../native/registration/build/Release/registration.node', import.meta.url)
)
const nativeAvailable = existsSync(NATIVE_PATH)

// ---------------------------------------------------------------------------
// 测试用数学工具（纯 JS，独立于被测代码）
// ---------------------------------------------------------------------------

/**
 * 行主序 3x3 旋转（Rodrigues）。
 *
 * ⚠ **轴必须归一化**：Rodrigues 公式只在 |axis| = 1 时给出正交矩阵。喂非单位轴进去，
 * 得到的"真值"矩阵本身就不是旋转（差约 |axis|−1 量级），于是 R 恢复的断言会以
 * 1e-4 级的假误差失败，而 native 其实准到 1e-12 —— 查错会白查半天（已经踩过）。
 */
function rotationMatrix(ax: number, ay: number, az: number, angle: number): number[] {
  const len = Math.hypot(ax, ay, az)
  const x = ax / len
  const y = ay / len
  const z = az / len
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ]
}

interface Truth {
  /** 行主序 9。 */
  r: number[]
  t: [number, number, number]
  s: number
}

/** P' = s·(R·P) + T（与 native 同一约定）。 */
function applyTruth(truth: Truth, x: number, y: number, z: number): [number, number, number] {
  return [
    truth.s * (truth.r[0] * x + truth.r[1] * y + truth.r[2] * z) + truth.t[0],
    truth.s * (truth.r[3] * x + truth.r[4] * y + truth.r[5] * z) + truth.t[1],
    truth.s * (truth.r[6] * x + truth.r[7] * y + truth.r[8] * z) + truth.t[2],
  ]
}

/** 确定性 PRNG（线性同余；造点用，跨运行可复现）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 随机点集（3N，double；取值范围由 span 定）。 */
function randomPoints(n: number, seed: number, span = 1): Float64Array {
  const rng = makeRng(seed)
  const out = new Float64Array(n * 3)
  for (let i = 0; i < out.length; i++) out[i] = rng() * span
  return out
}

/** 把点集按已知变换搬到新位置（float64 精确算术，故真值可当基准）。 */
function transformPoints(pts: Float64Array, truth: Truth): Float64Array {
  const out = new Float64Array(pts.length)
  for (let i = 0; i < pts.length; i += 3) {
    const [x, y, z] = applyTruth(truth, pts[i], pts[i + 1], pts[i + 2])
    out[i] = x
    out[i + 1] = y
    out[i + 2] = z
  }
  return out
}

/** 调换点序（构造"两侧点数相等但对应关系被破坏"的对照，或造分块副本）。 */
function asChunk(pts: Float64Array, from: number, to: number): RadiusFilterChunkSource {
  const slice = pts.slice(from * 3, to * 3)
  return { positions: Float32Array.from(slice), index: null }
}

/** 把一段点集切成 chunkCount 块（保持全局点序，用来钉"分块不变性"）。 */
function chunked(pts: Float64Array, chunkCount: number): RadiusFilterChunkSource[] {
  const total = pts.length / 3
  const chunks: RadiusFilterChunkSource[] = []
  let start = 0
  for (let c = 0; c < chunkCount; c++) {
    const end = c === chunkCount - 1 ? total : Math.floor((total * (c + 1)) / chunkCount)
    chunks.push(asChunk(pts, start, end))
    start = end
  }
  return chunks
}

/**
 * `RegistrationTools::FilterTransformation` 的 JS 镜像（**禁止 import 进生产代码**）。
 *
 * 本文件内唯一的用途：与 native 的过滤结果对照，钉住"旋转过滤后的平移修正项"照抄对了。
 * 只镜像本测试用到的分支（旋转过滤 + 平移过滤），s 与 rValid 不参与。
 */
function filterTransformationMirror(
  trans: { r: number[]; t: [number, number, number]; s: number },
  filters: number,
  gp: [number, number, number],
  gx: [number, number, number]
): { r: number[]; t: [number, number, number]; s: number } {
  const out = { r: [...trans.r], t: [...trans.t] as [number, number, number], s: trans.s }
  const rotationFilter = filters & SKIP_ROTATION
  if (rotationFilter !== 0) {
    const R = trans.r
    out.r = [1, 0, 0, 0, 1, 0, 0, 0, 1] // 单位矩阵，再填回保留的那个分量
    if (rotationFilter === SKIP_RYZ) {
      // 只保留绕 X
      if (R[2] < 1) {
        const phi = -Math.asin(R[2])
        const cosPhi = Math.cos(phi)
        const theta = Math.atan2(R[5] / cosPhi, R[8] / cosPhi)
        const cosTheta = Math.cos(theta)
        const sinTheta = Math.sin(theta)
        out.r[4] = cosTheta
        out.r[8] = cosTheta
        out.r[7] = sinTheta
        out.r[5] = -sinTheta
      }
    } else if (rotationFilter === SKIP_RXZ) {
      // 只保留绕 Y
      if (R[7] < 1) {
        const theta = Math.asin(R[7])
        const cosTheta = Math.cos(theta)
        const phi = Math.atan2(-R[6] / cosTheta, R[8] / cosTheta)
        const cosPhi = Math.cos(phi)
        const sinPhi = Math.sin(phi)
        out.r[0] = cosPhi
        out.r[8] = cosPhi
        out.r[2] = sinPhi
        out.r[6] = -sinPhi
      }
    } else if (rotationFilter === SKIP_RXY) {
      // 只保留绕 Z
      if (R[6] < 1) {
        const thetaRad = -Math.asin(R[6])
        const cosTheta = Math.cos(thetaRad)
        const phiRad = Math.atan2(R[3] / cosTheta, R[0] / cosTheta)
        const cosPhi = Math.cos(phiRad)
        const sinPhi = Math.sin(phiRad)
        out.r[0] = cosPhi
        out.r[4] = cosPhi
        out.r[3] = sinPhi
        out.r[1] = -sinPhi
      }
    }
    // 平移修正（上游 L110-112）：`outTrans.T += (refGC − outTrans.apply(toBeAlignedGC))`。
    // 展开后 inTrans.T 会**抵消**，等价于 `T = refGC − s·(R_过滤后 · toBeAlignedGC)`
    // —— 注意不是 `T + (refGC − toBeAlignedGC)`（漏掉 R 的作用会整体偏掉，已用探针确认）。
    const agc = applyTruth({ r: out.r, t: trans.t, s: trans.s }, gp[0], gp[1], gp[2])
    out.t = [out.t[0] + (gx[0] - agc[0]), out.t[1] + (gx[1] - agc[1]), out.t[2] + (gx[2] - agc[2])]
  }
  if (filters & SKIP_TX) out.t[0] = 0
  if (filters & SKIP_TY) out.t[1] = 0
  if (filters & SKIP_TZ) out.t[2] = 0
  return out
}

/** 重力心（与 native 同一算法：按序累加、最后除一次 ⇒ 逐位相等）。 */
function gravityCenter(pts: Float64Array): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  const n = pts.length / 3
  for (let i = 0; i < n; i++) {
    x += pts[i * 3]
    y += pts[i * 3 + 1]
    z += pts[i * 3 + 2]
  }
  return [x / n, y / n, z / n]
}

// ---------------------------------------------------------------------------
// 纯 JS 组：位掩码 / 选中解析 / 点对方向 / 变换布局
// ---------------------------------------------------------------------------

describe('rotationFilterMask（档位 ↔ 位掩码，语义容易记反）', () => {
  it('「仅绕 X」= SKIP_RYZ（跳过 Y/Z 的旋转），三个档位互换成立', () => {
    expect(rotationFilterMask('none')).toBe(SKIP_NONE)
    expect(rotationFilterMask('x')).toBe(SKIP_RYZ)
    expect(rotationFilterMask('y')).toBe(SKIP_RXZ)
    expect(rotationFilterMask('z')).toBe(SKIP_RXY)
    expect(rotationFilterMask('fixed')).toBe(SKIP_ROTATION)
    // 位掩码本身：1 = 跳过 XY ⇒ 只剩 Z
    expect(SKIP_RXY).toBe(1)
    expect(SKIP_RYZ).toBe(2)
    expect(SKIP_RXZ).toBe(4)
    expect(SKIP_ROTATION).toBe(SKIP_RXY | SKIP_RYZ | SKIP_RXZ)
  })

  it('平移开关与旋转档位按位或，互不干扰', () => {
    expect(buildTransformationFilters('none', false, false, false)).toBe(0)
    expect(buildTransformationFilters('z', true, false, true)).toBe(SKIP_RXY | SKIP_TX | SKIP_TZ)
    expect(buildTransformationFilters('fixed', true, true, true)).toBe(SKIP_ROTATION | SKIP_TX | SKIP_TY | SKIP_TZ)
  })
})

/** 造一个实体假身（bbox 与 globalShift 就位 = 已加载完成）。 */
function entity(id: number, name: string, loaded = true): SceneEntity {
  return {
    id,
    name,
    path: `E:/pts/${name}`,
    type: 'pointcloud',
    visible: true,
    pointCount: 1000,
    hasColor: false,
    hasNormals: false,
    bbox: loaded ? { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 } : null,
    globalShift: loaded ? { x: 0, y: 0, z: 0 } : null,
    globalScale: 1,
    colorMode: 'rgb',
    pointSize: 2,
    showNameIn3D: false,
    lodEnabled: 'auto',
    displayTarget: '3D View 1',
    treeObject: null,
  }
}

/** 造一个项目假身。 */
function project(id: number, entities: SceneEntity[], treeGroups: SceneProject['treeGroups'] = []): SceneProject {
  return {
    id,
    name: `项目${id}`,
    path: `E:/pts/p${id}.las`,
    type: 'project',
    expanded: true,
    visible: true,
    showNameIn3D: false,
    entities,
    treeGroups,
  }
}

describe('resolveRegistrationPair（严格 2 选）', () => {
  const e1 = entity(1, 'a.las')
  const e2 = entity(2, 'b.las')
  const projects = [project(10, [e1, e2, entity(3, 'c.las')])]

  it('恰好两个实体：ok，顺序 = 选择顺序（面板据此定默认角色）', () => {
    const sel: SceneSelection[] = [
      { type: 'entity', id: 2 },
      { type: 'entity', id: 1 },
    ]
    const r = resolveRegistrationPair(sel, projects)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([r.first, r.second]).toEqual([2, 1]) // 先选 b、后选 a
    expect([r.firstName, r.secondName]).toEqual(['b.las', 'a.las'])
  })

  it('1 个 / 3 个 / 空选中一律拒绝，且说明里带当前个数', () => {
    const one = resolveRegistrationPair([{ type: 'entity', id: 1 }], projects)
    expect(one.ok).toBe(false)
    if (!one.ok) expect(one.reason).toContain('当前 1 个')
    const three = resolveRegistrationPair(
      [
        { type: 'entity', id: 1 },
        { type: 'entity', id: 2 },
        { type: 'entity', id: 3 },
      ],
      projects
    )
    expect(three.ok).toBe(false)
    if (!three.ok) expect(three.reason).toContain('当前 3 个')
    const none = resolveRegistrationPair([], projects)
    expect(none.ok).toBe(false)
  })

  it('项目展开成其全部子实体（3 个子实体 ⇒ 拒绝；1 实体 + 1 实体项目 ⇒ 通过）', () => {
    const three = resolveRegistrationPair([{ type: 'project', id: 10 }], projects)
    expect(three.ok).toBe(false)
    if (!three.ok) expect(three.reason).toContain('当前 3 个')
    // 展开是"并集"：选中的实体 + 项目里的实体一起数，故这里的项目必须只含 1 个
    const p2 = project(11, [entity(4, 'd.las')])
    const ok = resolveRegistrationPair(
      [
        { type: 'entity', id: 1 },
        { type: 'project', id: 11 },
      ],
      [...projects, p2]
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) expect([ok.first, ok.second]).toEqual([1, 4])
    // 1 + 2 = 3 ⇒ 超了（"严格 2 选"按展开后的实体数算，不是按选中项数）
    const p3 = project(12, [entity(5, 'e.las'), entity(6, 'f.las')])
    const over = resolveRegistrationPair(
      [
        { type: 'entity', id: 1 },
        { type: 'project', id: 12 },
      ],
      [...projects, p3]
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toContain('当前 3 个')
  })

  it('容器展开成其 entityIds；同一个实体被两项选中时去重（1 个 ⇒ 拒绝）', () => {
    // 真实数据里容器的 entityIds 指向**同项目 entities 列表里**的实体，故两个都要在列
    const grp = project(
      12,
      [e1, e2],
      [
        {
          id: 90,
          name: 'g',
          type: 'treegroup',
          expanded: true,
          visible: true,
          showNameIn3D: false,
          entityIds: [1, 2],
        },
      ]
    )
    const ok = resolveRegistrationPair([{ type: 'treegroup', id: 90 }], [grp])
    expect(ok.ok).toBe(true)
    if (ok.ok) expect([ok.first, ok.second]).toEqual([1, 2])
    // 去重：实体 1 与"只含实体 1 的容器"叠加 ⇒ 展开成 {1} ⇒ 只有 1 个
    const only1 = project(
      13,
      [e1],
      [{ id: 91, name: 'g1', type: 'treegroup', expanded: true, visible: true, showNameIn3D: false, entityIds: [1] }]
    )
    const dup = resolveRegistrationPair(
      [
        { type: 'entity', id: 1 },
        { type: 'treegroup', id: 91 },
      ],
      [only1]
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toContain('当前 1 个')
  })

  it('未加载完成的点云（无 bbox）被挡下，理由单独一句话', () => {
    const loading = project(13, [entity(6, 'f.las', false), e1])
    const r = resolveRegistrationPair([{ type: 'project', id: 13 }], [loading])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('尚未加载完成')
  })
})

describe('buildOrientationPoints（角色 → 两组坐标）', () => {
  const pairs: RegistrationPair[] = [
    {
      first: { entityId: 1, chunkIndex: 0, vertexIndex: 3, x: 1, y: 2, z: 3 },
      second: { entityId: 2, chunkIndex: 0, vertexIndex: 7, x: 4, y: 5, z: 6 },
    },
  ]

  it('role 0：第 1 个实体待对齐（first → aligned）', () => {
    const { aligned, reference } = buildOrientationPoints(pairs, 0)
    expect(Array.from(aligned)).toEqual([1, 2, 3])
    expect(Array.from(reference)).toEqual([4, 5, 6])
  })

  it('role 1：对调方向（两组互换），点本身不动', () => {
    const { aligned, reference } = buildOrientationPoints(pairs, 1)
    expect(Array.from(aligned)).toEqual([4, 5, 6])
    expect(Array.from(reference)).toEqual([1, 2, 3])
  })
})

describe('toEntityTransform / applyEntityTransformToPoint（native 三件套 → 作用在点上）', () => {
  it('Matrix4.set 是行主序入参，作用在点上 == s·(R·P) + T', () => {
    const truth: Truth = { r: rotationMatrix(0.3, 0.5, 0.81, 0.7), t: [10, -4, 2.5], s: 2 }
    const trans = toEntityTransform(new Float64Array(truth.r), new Float64Array(truth.t), truth.s)
    // R 进旋转位、T 进平移位（s 不在矩阵里，由 EntityTransform.scale 单独带着）
    const m = trans.matrix
    expect(
      (m as THREE.Matrix4).equals(
        new THREE.Matrix4().set(
          ...truth.r.slice(0, 3),
          truth.t[0],
          ...truth.r.slice(3, 6),
          truth.t[1],
          ...truth.r.slice(6, 9),
          truth.t[2],
          0,
          0,
          0,
          1
        )
      )
    ).toBe(true)

    const [ex, ey, ez] = applyTruth(truth, 1.5, -2, 0.25)
    const got = applyEntityTransformToPoint(trans, 1.5, -2, 0.25)
    expect(got.x).toBeCloseTo(ex, 12)
    expect(got.y).toBeCloseTo(ey, 12)
    expect(got.z).toBeCloseTo(ez, 12)
  })

  it('⚠ 缩放必须在平移**之前**生效（反过来会把 T 也缩放，s ≠ 1 时立刻露馅）', () => {
    const truth: Truth = { r: rotationMatrix(0.3, 0.5, 0.81, 0.7), t: [10, -4, 2.5], s: 2 }
    const trans = toEntityTransform(new Float64Array(truth.r), new Float64Array(truth.t), truth.s)
    const wrong = new THREE.Vector3(1.5, -2, 0.25).applyMatrix4(trans.matrix).multiplyScalar(trans.scale)
    // 错序 = s·R·P + s·T，比正确值多出 (s−1)·T = 一个 T 那么大
    const [ex, ey, ez] = applyTruth(truth, 1.5, -2, 0.25)
    expect(wrong.x - ex).toBeCloseTo((truth.s - 1) * truth.t[0], 9)
    expect(wrong.y - ey).toBeCloseTo((truth.s - 1) * truth.t[1], 9)
    expect(wrong.z - ez).toBeCloseTo((truth.s - 1) * truth.t[2], 9)
  })

  it('单位变换 == 恒等（s = 1 时不引入任何偏移）', () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const trans = toEntityTransform(new Float64Array(identity), new Float64Array([0, 0, 0]), 1)
    expect(trans.matrix.equals(new THREE.Matrix4())).toBe(true)
    const got = applyEntityTransformToPoint(trans, 7, -3, 2)
    expect([got.x, got.y, got.z]).toEqual([7, -3, 2])
  })
})

describe('composePreviewPose（预览：把显示坐标系的变换合成进 Group 的基准位姿）', () => {
  /** 位姿 → 4×4（three 的合成序 `T·R·S`，正是 Group 的局部矩阵）。 */
  function poseMatrix(pose: PreviewPose): THREE.Matrix4 {
    return new THREE.Matrix4().compose(pose.position, pose.quaternion, pose.scale)
  }

  /** 实体变换 → 4×4：`M = T·R·S`（s 不在 matrix 里，故这里单独补一个缩放）。 */
  function transformMatrix(trans: ReturnType<typeof toEntityTransform>): THREE.Matrix4 {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(trans.matrix.elements[12], trans.matrix.elements[13], trans.matrix.elements[14]),
      new THREE.Quaternion().setFromRotationMatrix(trans.matrix),
      new THREE.Vector3(trans.scale, trans.scale, trans.scale)
    )
  }

  /** 加载态基准位姿：`q0 = Rx(−π/2)`、`p0 = 0`、`s0 = 1`（见 pointcloudStore 的 pointsGroup）。 */
  function loadBaseline(): PreviewPose {
    return {
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
    }
  }

  it('基准 = 加载态时逐项等于约定公式：q = qx(−π/2)⊗qm、p = Rx(−π/2)·T、scale = s', () => {
    const truth: Truth = { r: rotationMatrix(0.2, -0.9, 0.39, 0.42), t: [12.5, -3.25, 88], s: 2.5 }
    const trans = toEntityTransform(new Float64Array(truth.r), new Float64Array(truth.t), truth.s)
    const base = loadBaseline()
    const pose = composePreviewPose(base, trans)

    // 左乘 = 先 qm 后基准（three 的乘法是"右操作数先作用"）
    const qExpect = base.quaternion.clone().multiply(new THREE.Quaternion().setFromRotationMatrix(trans.matrix))
    expect(pose.quaternion.angleTo(qExpect)).toBeCloseTo(0, 12)

    // 绕 X 轴 −90°：(x, y, z) → (x, z, −y)
    expect(pose.position.x).toBeCloseTo(truth.t[0], 12)
    expect(pose.position.y).toBeCloseTo(truth.t[2], 12)
    expect(pose.position.z).toBeCloseTo(-truth.t[1], 12)

    expect(pose.scale.x).toBeCloseTo(truth.s, 12)
    expect(pose.scale.y).toBeCloseTo(truth.s, 12)
    expect(pose.scale.z).toBeCloseTo(truth.s, 12)
  })

  /**
   * 核心不变量，也是这一组测试里唯一真正"钉住语义"的那条：
   * **`B′·P == B·(M·P)`** —— 预览位姿作用在显示坐标点上，必须与"先用变换 M 搬点、
   * 再按基准位姿摆到世界系"完全一致。左边是 composePreviewPose 的产出，右边是
   * Matrix4.compose / applyMatrix4 独立复算的（不是把公式抄一遍）。
   */
  it('B′·P == B·(M·P)（含 p0 ≠ 0、s0 ≠ 1 的基准 —— 漏掉 R(q0) 或 s0 立刻露馅）', () => {
    const truth: Truth = { r: rotationMatrix(0.2, -0.9, 0.39, 0.42), t: [4, -1.5, 0.75], s: 1.7 }
    const trans = toEntityTransform(new Float64Array(truth.r), new Float64Array(truth.t), truth.s)
    // 基准刻意取"非加载态"：带平移与缩放
    const base: PreviewPose = {
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 1.1)),
      position: new THREE.Vector3(3, -2, 5),
      scale: new THREE.Vector3(0.5, 0.5, 0.5),
    }
    const bPrime = poseMatrix(composePreviewPose(base, trans))
    const b = poseMatrix(base)
    const m = transformMatrix(trans)

    for (const p of [
      [1, 2, 3],
      [-4, 0.5, 7],
      [0, 0, 0],
    ]) {
      const lhs = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(bPrime) // B′·P
      const rhs = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m).applyMatrix4(b) // B·(M·P)
      expect(lhs.x).toBeCloseTo(rhs.x, 10)
      expect(lhs.y).toBeCloseTo(rhs.y, 10)
      expect(lhs.z).toBeCloseTo(rhs.z, 10)
    }
  })

  it('⚠ 基准缩放要参与位置项（漏掉 s0 会差 (s0−1)·R(q0)·T）', () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const trans = toEntityTransform(new Float64Array(identity), new Float64Array([10, 0, 0]), 1)
    const base: PreviewPose = {
      quaternion: new THREE.Quaternion(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(3, 3, 3),
    }
    const pose = composePreviewPose(base, trans)
    expect(pose.position.x).toBeCloseTo(30, 12) // = s0·T
    // 错法（只写 p0 + T）与正确值差 (s0−1)·T，肉眼可见
    expect(pose.position.x - 10).toBeCloseTo((3 - 1) * 10, 12)
  })

  it('单位变换 == 位姿原样（不会引入漂移，连续预览也不累积）', () => {
    const trans = toEntityTransform(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), new Float64Array([0, 0, 0]), 1)
    const base = loadBaseline()
    const pose = composePreviewPose(base, trans)
    expect(pose.quaternion.angleTo(base.quaternion)).toBeCloseTo(0, 12)
    expect([pose.position.x, pose.position.y, pose.position.z]).toEqual([0, 0, 0])
    expect([pose.scale.x, pose.scale.y, pose.scale.z]).toEqual([1, 1, 1])
  })
})

describe('describeIcpResult（结果码 → 人话）', () => {
  it('已知码有专门文案，未知码回落到泛化文案并带码值', () => {
    expect(describeIcpResult(ICP_NOTHING_TO_DO)).toContain('已经重合')
    expect(describeIcpResult(ICP_APPLY_TRANSFO)).toBe('收敛')
    expect(describeIcpResult(101)).toContain('退化')
    expect(describeIcpResult(105)).toContain('入参非法')
    expect(describeIcpResult(999)).toContain('999')
  })

  it('默认参数照抄 CC（20 轮 / 1e-5 / 5 万 / 100% 重叠 / 缩放不限）', () => {
    const p = defaultIcpParams()
    expect(p.maxIterations).toBe(20)
    expect(p.minRMSDecrease).toBe(1.0e-5)
    expect(p.samplingLimit).toBe(50000)
    expect(p.finalOverlapRatio).toBe(1.0)
    expect(p.adjustScale).toBe(false)
    expect(Number.isNaN(p.minScale)).toBe(true)
    expect(Number.isNaN(p.maxScale)).toBe(true)
    expect(p.filterOutFarthestPoints).toBe(false)
    expect(p.transformationFilters).toBe(SKIP_NONE)
    expect(MIN_PAIRS_COUNT).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 原生组：点对粗配准
// ---------------------------------------------------------------------------

describe.skipIf(!nativeAvailable)('registration.node（native 产物存在时）', () => {
  const require = createRequire(import.meta.url)
  // 与 euclideanCluster.spec 惯例一致：直连 addon（不走 nativeLoader 的 window IPC）。
  // 故本文件**刻意不调用** utils/registration.ts 的 findAbsoluteOrientation / computeIcp 包装
  // ——它们经 native:get-module-path IPC 取路径，node 环境没有 window.electronAPI；那条路径由
  // e2e 的 native-*.spec.ts（"IPC → 渲染主世界 require → 真实 N-API 往返"）覆盖。
  const addon = require(NATIVE_PATH) as RegistrationAddon

  /** promise 化两个导出（同步抛错一并收敛）。 */
  function orient(request: OrientationRequest): Promise<OrientationResult> {
    return new Promise((resolve, reject) => {
      try {
        addon.findAbsoluteOrientation(request, (err, result) => {
          if (err) reject(err)
          else if (!result) reject(new Error('未返回结果'))
          else resolve(result)
        })
      } catch (e) {
        reject(e)
      }
    })
  }
  function runIcp(request: IcpRequest): Promise<IcpResult> {
    return new Promise((resolve, reject) => {
      try {
        addon.icp(request, (err, result) => {
          if (err) reject(err)
          else if (!result) reject(new Error('未返回结果'))
          else resolve(result)
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  /** 逐元素接近断言（失败时点名第几个元素）。 */
  function expectCloseArray(
    actual: Float64Array | number[],
    expected: number[] | Float64Array,
    digits: number,
    label: string
  ) {
    expect(actual.length, `${label}: 长度`).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      if (Math.abs(actual[i] - expected[i]) > 0.5 * Math.pow(10, -digits)) {
        throw new Error(`${label}: 第 ${i} 个元素 ${actual[i]} ≠ 期望 ${expected[i]}（容差 1e-${digits}）`)
      }
    }
  }

  /** 正交性 + 行列式（旋转矩阵的两条硬性不变量）。 */
  function expectProperRotation(r: Float64Array | number[], label: string) {
    const m = Array.from(r)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let dot = 0
        for (let k = 0; k < 3; k++) dot += m[i * 3 + k] * m[j * 3 + k]
        expect(Math.abs(dot - (i === j ? 1 : 0)), `${label}: R·Rᵀ[${i}][${j}]`).toBeLessThan(1e-9)
      }
    }
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    expect(Math.abs(det - 1), `${label}: det(R)`).toBeLessThan(1e-9)
  }

  describe('findAbsoluteOrientation：合成变换的恢复', () => {
    const pts = randomPoints(40, 20250916, 120) // 120 m 量级（真实点云的显示坐标尺度）

    it('一般路径（> 3 点）：R/T 恢复，RMS ≈ 0，s 恒 1', async () => {
      const truth: Truth = { r: rotationMatrix(0.2, -0.9, 0.39, 0.42), t: [12.5, -3.25, 88], s: 1 }
      const target = transformPoints(pts, truth)
      const res = await orient({ aligned: pts, reference: target })
      expect(res.ok).toBe(true)
      expect(res.rValid).toBe(true)
      expect(res.s).toBe(1) // adjustScale 关 ⇒ 恒 1（原样透传，不是"约等于 1"）
      expectCloseArray(res.r, truth.r, 9, 'R')
      expectCloseArray(res.t, truth.t, 6, 'T')
      expectProperRotation(res.r, 'R')
      // 残差按点距尺度：120 m 跨度下 1e-6 的角误差才对应 1e-4 m
      expect(res.rms).toBeLessThan(1e-4)
      expect(res.distances.length).toBe(40)
      expect(res.deltas.length).toBe(120)
    })

    it('adjustScale 打开时恢复出缩放（s = 2.5）', async () => {
      const truth: Truth = { r: rotationMatrix(0.7, 0.2, 0.68, 1.1), t: [5, 6, 7], s: 2.5 }
      const target = transformPoints(pts, truth)
      const res = await orient({ aligned: pts, reference: target, adjustScale: true })
      expect(res.ok).toBe(true)
      expect(res.s).toBeCloseTo(2.5, 9)
      expectCloseArray(res.r, truth.r, 8, 'R')
      expect(res.rms).toBeLessThan(1e-3)
    })

    it('3 点（Horn 特例含面内旋转细化）也能精确恢复', async () => {
      const truth: Truth = { r: rotationMatrix(-0.4, 0.6, 0.69, 0.9), t: [-8, 22, 3], s: 1 }
      const three = randomPoints(3, 7, 50)
      const res = await orient({ aligned: three, reference: transformPoints(three, truth) })
      expect(res.ok).toBe(true)
      expectCloseArray(res.r, truth.r, 9, 'R(3点)')
      expectCloseArray(res.t, truth.t, 6, 'T(3点)')
      expect(res.rms).toBeLessThan(1e-6)
    })

    it('3 点路径的退化：任一侧共线 ⇒ ok = false（不崩、不返回垃圾变换）', async () => {
      const line = new Float64Array([0, 0, 0, 1, 2, 3, 2, 4, 6]) // P 共线
      const tri = randomPoints(3, 8, 10)
      const a = await orient({ aligned: line, reference: tri })
      expect(a.ok).toBe(false)
      expect(a.rms).toBe(-1)
      const b = await orient({ aligned: tri, reference: line })
      expect(b.ok).toBe(false)
    })

    it('点数 < 3 ⇒ ok = false；两侧点数不等 ⇒ 绑定层同步抛错（走 reject）', async () => {
      const two = randomPoints(2, 9, 10)
      expect(
        (
          await orient({
            aligned: two,
            reference: transformPoints(two, { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 }),
          })
        ).ok
      ).toBe(false)
      await expect(orient({ aligned: randomPoints(3, 10, 10), reference: randomPoints(4, 11, 10) })).rejects.toThrow(
        /长度必须相等/
      )
    })

    it('参考点集缩成一个点（退化）⇒ ok = true 但 rValid = false，R 发单位矩阵、T = Gx − Gp', async () => {
      const p = randomPoints(6, 12, 30)
      const gx = 42
      const collapsed = new Float64Array(6 * 3).fill(gx)
      const res = await orient({ aligned: p, reference: collapsed })
      expect(res.ok).toBe(true)
      expect(res.rValid).toBe(false)
      // ⚠ 必须是单位矩阵而不是零矩阵（零矩阵会把整片云压到原点）
      expect(Array.from(res.r)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
      const gp = gravityCenter(p)
      expectCloseArray(res.t, [gx - gp[0], gx - gp[1], gx - gp[2]], 12, 'T(退化)')
    })

    it('过滤器：平移档位是纯算术 ⇒ 与 JS 镜像逐位相等', async () => {
      const truth: Truth = { r: rotationMatrix(0.2, 0.9, 0.39, 0.42), t: [12.5, -3.25, 88], s: 1 }
      const target = transformPoints(pts, truth)
      const filters = SKIP_TX | SKIP_TZ
      const res = await orient({ aligned: pts, reference: target, filters })
      const raw = await orient({ aligned: pts, reference: target })
      const mirror = filterTransformationMirror(
        { r: Array.from(raw.r), t: [raw.t[0], raw.t[1], raw.t[2]], s: raw.s },
        filters,
        gravityCenter(pts),
        gravityCenter(target)
      )
      expect(Array.from(res.r)).toEqual(Array.from(raw.r)) // 旋转不过滤 ⇒ 原样
      expect(res.t[0]).toBe(0) // Tx 置零
      expect(res.t[2]).toBe(0) // Tz 置零
      expect(res.t[1]).toBe(mirror.t[1]) // Ty 保留（逐位）
      expect(res.t[1]).toBe(raw.t[1])
    })

    it('过滤器：旋转档位与 JS 镜像一致（含重力心平移修正项）', async () => {
      const truth: Truth = { r: rotationMatrix(0.25, -0.5, 0.83, 0.8), t: [30, -12, 4], s: 1 }
      const target = transformPoints(pts, truth)
      const raw = await orient({ aligned: pts, reference: target })
      const gp = gravityCenter(pts)
      const gx = gravityCenter(target)

      for (const [mode, mask] of [
        ['仅绕X', SKIP_RYZ],
        ['仅绕Y', SKIP_RXZ],
        ['仅绕Z', SKIP_RXY],
        ['不旋转', SKIP_ROTATION],
      ] as [string, number][]) {
        const res = await orient({ aligned: pts, reference: target, filters: mask })
        const mirror = filterTransformationMirror(
          { r: Array.from(raw.r), t: [raw.t[0], raw.t[1], raw.t[2]], s: raw.s },
          mask,
          gp,
          gx
        )
        expectCloseArray(res.r, mirror.r, 12, `${mode}: R`)
        expectCloseArray(res.t, mirror.t, 12, `${mode}: T`)
      }
    })

    it('过滤器不会算错"可达 RMS"：过滤后 RMS ≥ 不过滤（约束只会让拟合更差）', async () => {
      const truth: Truth = { r: rotationMatrix(0.25, -0.5, 0.83, 0.8), t: [30, -12, 4], s: 1 }
      const target = transformPoints(pts, truth)
      const free = await orient({ aligned: pts, reference: target })
      const fixed = await orient({ aligned: pts, reference: target, filters: SKIP_ROTATION })
      expect(free.rms).toBeLessThan(1e-6)
      expect(fixed.rms).toBeGreaterThan(free.rms)
      // 不旋转 ⇒ 结果必然是纯平移：与 JS 镜像同款
      expect(Array.from(fixed.r)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    })
  })

  describe('icp：合成点云的收敛', () => {
    /** 造一对点云：model 为基准，data = model 绕轴旋转+平移（可加抖动）。 */
    function makePair(options: { count: number; seed: number; angle: number; t: number[]; jitter?: number }) {
      const rng = makeRng(options.seed + 1)
      const base = randomPoints(options.count, options.seed, 40)
      const truth: Truth = {
        r: rotationMatrix(0.1, 0.2, 0.97, options.angle),
        t: [options.t[0], options.t[1], options.t[2]],
        s: 1,
      }
      const moved = transformPoints(base, truth)
      if (options.jitter) {
        for (let i = 0; i < moved.length; i++) moved[i] += (rng() - 0.5) * options.jitter
      }
      // native 吃 Float32 缓冲（与生产一致）；真值也按同一精度校准
      return { model: Float32Array.from(base), data: Float32Array.from(moved), truth }
    }

    const sources = (positions: Float32Array): RadiusFilterChunkSource[] => [{ positions, index: null }]

    /** data 变换后到 model 的距离 RMS（用 native 回包在 JS 侧核对收敛质量）。 */
    function rmsToModel(data: Float32Array, model: Float32Array, res: IcpResult): number {
      const m = res.r
      const t = res.t
      let sum = 0
      for (let i = 0; i < data.length; i += 3) {
        const x = res.s * (m[0] * data[i] + m[1] * data[i + 1] + m[2] * data[i + 2]) + t[0]
        const y = res.s * (m[3] * data[i] + m[4] * data[i + 1] + m[5] * data[i + 2]) + t[1]
        const z = res.s * (m[6] * data[i] + m[7] * data[i + 1] + m[8] * data[i + 2]) + t[2]
        const dx = x - model[i]
        const dy = y - model[i + 1]
        const dz = z - model[i + 2]
        sum += dx * dx + dy * dy + dz * dz
      }
      return Math.sqrt(sum / (data.length / 3))
    }

    it('小角度错位：收敛（APPLY_TRANSFO）、最终 RMS < 初始 RMS、把 data 拉到 model 上', async () => {
      const { model, data } = makePair({ count: 3000, seed: 100, angle: 0.02, t: [1.5, -0.5, 0.3] })
      const res = await runIcp({ data: { chunks: sources(data) }, model: { chunks: sources(model) }, params: {} })
      expect(res.result).toBe(ICP_APPLY_TRANSFO)
      expect(res.rValid).toBe(true)
      expect(res.initialRms).toBeGreaterThan(0)
      expect(res.rms).toBeLessThan(res.initialRms)
      expect(res.pointCount).toBeGreaterThan(0)
      expect(res.iterations).toBeGreaterThanOrEqual(1)
      // 对齐后：残余 RMS 应落到"与初始量级相比小两个数量级"的水平
      expect(rmsToModel(data, model, res)).toBeLessThan(res.initialRms * 0.1)
      expect(res.s).toBe(1)
      expectProperRotation(res.r, 'ICP R')
    })

    it('已经重合的两片云 ⇒ ICP_NOTHING_TO_DO，且不给变换', async () => {
      const base = randomPoints(500, 200, 20)
      const f32 = Float32Array.from(base)
      const res = await runIcp({
        data: { chunks: sources(f32) },
        model: { chunks: sources(Float32Array.from(base)) },
        params: {},
      })
      expect(res.result).toBe(ICP_NOTHING_TO_DO)
      expect(res.iterations).toBe(0)
      expect(res.rms).toBeLessThan(1e-7)
      // 第 0 轮就退出也必须填 initialRms（面板的"初始 RMS → 最终 RMS"两栏不能有一个是 -1）
      expect(res.initialRms).toBe(0)
    })

    it('initialRms 恒为**第 0 轮**的 RMS（不是最后一轮的上一轮）', async () => {
      // 这一条是 initialRms 曾经写错（`out.initialRms = lastStepRMS` ⇒ 倒数第二轮的 RMS）的回归防线：
      // 跑满 k 轮时，坏实现报的是第 k−1 轮的 RMS，好实现报的是第 0 轮的 RMS。
      // 取 maxIterations = 1 的那次，其 rms 恰好就是第 1 轮的 RMS ⇒ 可用来区分两者。
      const { model, data } = makePair({ count: 4000, seed: 300, angle: 0.05, t: [2, 0.4, -1] })
      const run = (maxIterations: number) =>
        runIcp({ data: { chunks: sources(data) }, model: { chunks: sources(model) }, params: { maxIterations } })
      const one = await run(1)
      const three = await run(3)
      expect(one.iterations).toBe(1)
      expect(three.iterations).toBe(3)
      expect(one.initialRms).toBeGreaterThan(one.rms) // 首轮 RMS 严格大于首轮末的 RMS
      expect(three.initialRms).toBe(one.initialRms) // 两次调用前 3 轮完全同轨迹
      expect(three.initialRms).not.toBe(one.rms) // ← 坏实现会相等（它报的正是第 1 轮）
      expect(three.rms).toBeLessThan(three.initialRms)
    })

    it('确定性：同参数两次逐位相等（含采样，故必须固定 seed）', async () => {
      const { model, data } = makePair({ count: 4000, seed: 300, angle: 0.05, t: [2, 0.4, -1] })
      const request: IcpRequest = {
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        // 采样上限压到 800：逼出"随机降采样"通路（4000 点 > 800）
        params: { samplingLimit: 800, seed: 12345 },
      }
      const a = await runIcp(request)
      const b = await runIcp(request)
      expect(a.result).toBe(b.result)
      expect(a.rms).toBe(b.rms)
      expect(Array.from(a.r)).toEqual(Array.from(b.r))
      expect(Array.from(a.t)).toEqual(Array.from(b.t))
      expect(a.iterations).toBe(b.iterations)
      // 采样确实发生了：参与点数 ≤ 上限
      expect(a.pointCount).toBeLessThanOrEqual(800)
    })

    it('分块不变性：同一片云切 1 / 3 / 7 块结果逐位相等（采样按候选序、不依赖块边界）', async () => {
      const { model, data } = makePair({ count: 2100, seed: 400, angle: 0.03, t: [0.8, 1.2, 0.2] })
      const params: IcpParams = { samplingLimit: 500, seed: 777 }
      const one = await runIcp({
        data: { chunks: chunked(Float64Array.from(data), 1) },
        model: { chunks: chunked(Float64Array.from(model), 1) },
        params,
      })
      const three = await runIcp({
        data: { chunks: chunked(Float64Array.from(data), 3) },
        model: { chunks: chunked(Float64Array.from(model), 3) },
        params,
      })
      const seven = await runIcp({
        data: { chunks: chunked(Float64Array.from(data), 7) },
        model: { chunks: chunked(Float64Array.from(model), 7) },
        params,
      })
      expect(Array.from(three.r)).toEqual(Array.from(one.r))
      expect(Array.from(three.t)).toEqual(Array.from(one.t))
      expect(three.rms).toBe(one.rms)
      expect(Array.from(seven.r)).toEqual(Array.from(one.r))
      expect(Array.from(seven.t)).toEqual(Array.from(one.t))
      expect(seven.rms).toBe(one.rms)
    })

    it('重叠度 60%：参与点数按比例收缩（钉住"重叠度通路真的在过滤"）', async () => {
      const { model, data } = makePair({ count: 4000, seed: 500, angle: 0.02, t: [1, 0.2, 0.1] })
      const full = await runIcp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: { seed: 9 },
      })
      const partial = await runIcp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: { finalOverlapRatio: 0.6, seed: 9 },
      })
      expect(full.result).toBe(ICP_APPLY_TRANSFO)
      expect(partial.result).toBe(ICP_APPLY_TRANSFO)
      expect(partial.pointCount).toBeLessThan(full.pointCount)
      expect(partial.pointCount).toBeLessThanOrEqual(4000 * 0.6 + 1)
      // 两片云本来就完全重叠 ⇒ 砍掉 40% 的点不影响最终位姿（只影响参与数量）
      expectCloseArray(partial.r, Array.from(full.r), 4, 'R(60% 重叠)')
    })

    it('剔除最远点开关不影响完全重叠的两片云（分布里没有离群点）', async () => {
      const { model, data } = makePair({ count: 2000, seed: 600, angle: 0.02, t: [0.5, 0, 0] })
      const res = await runIcp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: { filterOutFarthestPoints: true, seed: 3 },
      })
      expect(res.result).toBe(ICP_APPLY_TRANSFO)
      expect(res.pointCount).toBeGreaterThan(2000 * 0.9) // μ+2.5σ 几乎不裁点
    })

    it('入参越界：重叠度 0 / 1.5、采样上限 2 一律 ICP_ERROR_INVALID_INPUT（不崩）', async () => {
      const base = Float32Array.from(randomPoints(50, 700, 10))
      const chunks = sources(base)
      for (const params of [
        { finalOverlapRatio: 0 },
        { finalOverlapRatio: 1.5 },
        { samplingLimit: 2 },
      ] as IcpParams[]) {
        const res = await runIcp({ data: { chunks }, model: { chunks }, params })
        expect(res.result).toBe(ICP_ERROR_INVALID_INPUT)
      }
      // 空数据云 ⇒ NOTHING_TO_DO（上游 L176 的语义）；空模型云 ⇒ INVALID_INPUT
      const empty: RadiusFilterChunkSource[] = [{ positions: new Float32Array(0), index: null }]
      expect((await runIcp({ data: { chunks: empty }, model: { chunks }, params: {} })).result).toBe(ICP_NOTHING_TO_DO)
      expect((await runIcp({ data: { chunks }, model: { chunks: empty }, params: {} })).result).toBe(
        ICP_ERROR_INVALID_INPUT
      )
    })

    it('index 越界的候选块 ⇒ INVALID_INPUT（契约防御，不读越界内存）', async () => {
      const positions = Float32Array.from(randomPoints(10, 800, 10))
      const bad: RadiusFilterChunkSource = { positions, index: new Uint32Array([0, 1, 99]) }
      const res = await runIcp({ data: { chunks: [bad] }, model: { chunks: sources(positions) }, params: {} })
      expect(res.result).toBe(ICP_ERROR_INVALID_INPUT)
      // 入参类型非法则绑定层同步抛错
      await expect(
        runIcp({
          data: { chunks: [{ positions, index: new Uint16Array([0, 1]) }] },
          model: { chunks: sources(positions) },
          params: {},
        })
      ).rejects.toThrow(/index 必须是 Uint32Array 或 null/)
    })
  })

  describe('gicp：协方差加权的收敛与参数面', () => {
    /** promise 化 gicp 导出（同步抛错一并收敛）。 */
    function runGicp(request: GicpRequest): Promise<GicpResult> {
      return new Promise((resolve, reject) => {
        try {
          addon.gicp(request, (err, result) => {
            if (err) reject(err)
            else if (!result) reject(new Error('未返回结果'))
            else resolve(result)
          })
        } catch (e) {
          reject(e)
        }
      })
    }

    /** 造一对点云：model 为基准，data = model 绕轴旋转+平移（可加抖动），同 ICP 组。 */
    function makePair(options: { count: number; seed: number; angle: number; t: number[]; jitter?: number }) {
      const rng = makeRng(options.seed + 1)
      const base = randomPoints(options.count, options.seed, 40)
      const truth: Truth = {
        r: rotationMatrix(0.1, 0.2, 0.97, options.angle),
        t: [options.t[0], options.t[1], options.t[2]],
        s: 1,
      }
      const moved = transformPoints(base, truth)
      if (options.jitter) {
        for (let i = 0; i < moved.length; i++) moved[i] += (rng() - 0.5) * options.jitter
      }
      return { model: Float32Array.from(base), data: Float32Array.from(moved), truth }
    }

    const sources = (positions: Float32Array): RadiusFilterChunkSource[] => [{ positions, index: null }]

    /**
     * 真值的**逆**：回包解的是「把 data 搬到 model 上」的变换（`P' = R·P + T` 的直接含义，
     * 也是面板「待配准 ← 参考」的方向），而测试里造数据是反着来的
     * （`data = 真值(model)`）⇒ 期望的 R = 真值ᵀ、T = −真值ᵀ·真值T。
     */
    function invertTruth(truth: Truth): { r: number[]; t: number[] } {
      const m = truth.r
      const r = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
      return {
        r,
        t: [
          -(r[0] * truth.t[0] + r[1] * truth.t[1] + r[2] * truth.t[2]),
          -(r[3] * truth.t[0] + r[4] * truth.t[1] + r[5] * truth.t[2]),
          -(r[6] * truth.t[0] + r[7] * truth.t[1] + r[8] * truth.t[2]),
        ],
      }
    }

    /** data 变换后到 model 的距离 RMS（与回包的 rms 独立核算，防止"只信 native 自报"）。 */
    function rmsToModel(data: Float32Array, model: Float32Array, res: GicpResult): number {
      const m = res.r
      const t = res.t
      let sum = 0
      for (let i = 0; i < data.length; i += 3) {
        const x = res.s * (m[0] * data[i] + m[1] * data[i + 1] + m[2] * data[i + 2]) + t[0]
        const y = res.s * (m[3] * data[i] + m[4] * data[i + 1] + m[5] * data[i + 2]) + t[1]
        const z = res.s * (m[6] * data[i] + m[7] * data[i + 1] + m[8] * data[i + 2]) + t[2]
        const dx = x - model[i]
        const dy = y - model[i + 1]
        const dz = z - model[i + 2]
        sum += dx * dx + dy * dy + dz * dz
      }
      return Math.sqrt(sum / (data.length / 3))
    }

    it('回包字段完备：面板读的每一项都在（addon 漏字段 → 面板崩的回归哨兵）', async () => {
      const { model, data } = makePair({ count: 800, seed: 110, angle: 0.02, t: [1, -0.4, 0.2] })
      const res = await runGicp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: { seed: 1 },
      })
      // ⚠ 每一行都是面板/契约镜像真的会读的字段：漏一个就是 undefined.toExponential 崩工具栏
      expect(typeof res.result).toBe('number')
      expect(typeof res.rms).toBe('number')
      expect(typeof res.initialRms).toBe('number')
      expect(typeof res.pointCount).toBe('number')
      expect(typeof res.iterations).toBe('number')
      expect(typeof res.covarianceError).toBe('number')
      expect(res.r).toBeInstanceOf(Float64Array)
      expect(res.r.length).toBe(9)
      expect(res.t).toBeInstanceOf(Float64Array)
      expect(res.t.length).toBe(3)
      expect(typeof res.s).toBe('number')
      expect(typeof res.rValid).toBe('boolean')
      // GICP 是刚体：s 恒 1（原样透传，不是"约等于 1"）
      expect(res.s).toBe(1)
      expect(Number.isFinite(res.rms)).toBe(true)
      expect(Number.isFinite(res.covarianceError)).toBe(true)
    })

    it('小角度错位：收敛（APPLY_TRANSFO）、最终 RMS < 初始 RMS、把 data 拉到 model 上', async () => {
      const { model, data } = makePair({ count: 3000, seed: 120, angle: 0.02, t: [1.5, -0.5, 0.3] })
      const res = await runGicp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: {},
      })
      expect(res.result).toBe(GICP_APPLY_TRANSFO)
      expect(res.rValid).toBe(true)
      expect(res.initialRms).toBeGreaterThan(0)
      expect(res.rms).toBeLessThan(res.initialRms)
      expect(res.pointCount).toBeGreaterThan(0)
      expect(res.iterations).toBeGreaterThanOrEqual(1)
      // 独立核算：用回包变换把 data 拉过去，残余应比初始小一个量级
      expect(rmsToModel(data, model, res)).toBeLessThan(res.initialRms * 0.1)
      expect(res.covarianceError).toBeGreaterThan(0) // 逐点马氏残差（无量纲）
      expectProperRotation(res.r, 'GICP R')
    })

    it('真的会旋转：R/T 一并恢复，且 R **不是单位阵**（占位骨架 R 恒为单位矩阵的回归防线）', async () => {
      // 占位骨架时代最严重的缺陷是 R 恒为单位矩阵、永远只对质心 ⇒ 再小的位移也只解出平移。
      // 故这里先钉"转了没有"（与单位阵的偏差必须肉眼可见），再钉"转对没有"（≈ 真值）。
      // ⚠ 真值带明显的旋转 + 平移；角度取 0.25 rad（14°）——比"小角度"用例大一个量级，
      // 单位阵实现绝无可能蒙混过关，同时仍在 ICP 族能收敛的范围内。
      const truth: Truth = { r: rotationMatrix(0.3, -0.6, 0.74, 0.25), t: [2, -1, 0.5], s: 1 }
      const base = randomPoints(3000, 130, 40)
      const data = Float32Array.from(transformPoints(base, truth)) // ⚠ 先转再降精度，与真值同源
      const model = Float32Array.from(base)
      const res = await runGicp({ data: { chunks: sources(data) }, model: { chunks: sources(model) }, params: {} })
      expect(res.result).toBe(GICP_APPLY_TRANSFO)
      expect(res.rValid).toBe(true)
      const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
      let maxDev = 0
      for (let i = 0; i < 9; i++) maxDev = Math.max(maxDev, Math.abs(res.r[i] - identity[i]))
      expect(maxDev, '解出的 R 与单位阵的偏差').toBeGreaterThan(0.01)
      const expected = invertTruth(truth) // 回包方向是 data → model，与造数据的方向互为逆
      expectCloseArray(res.r, expected.r, 3, 'R')
      expectCloseArray(res.t, expected.t, 2, 'T')
      expectProperRotation(res.r, 'GICP R（大角度）')
      expect(res.rms).toBeLessThan(res.initialRms)
      expect(rmsToModel(data, model, res)).toBeLessThan(res.initialRms * 0.1)
      expect(res.covarianceError).toBeGreaterThan(0)

      // 旋转过滤器真的接线了：SKIP_ROTATION（不旋转）⇒ R 必须是**单位阵**（不是"接近"）
      const fixed = await runGicp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: { transformationFilters: SKIP_ROTATION },
      })
      expect(Array.from(fixed.r)).toEqual(identity)
      expect(fixed.rms).toBeGreaterThan(res.rms) // 约束只会让拟合更差
    })

    it('确定性（同参数两次逐位相等，含采样故必须固定 seed）与分块不变性（1 / 3 / 7 块）', async () => {
      const { model, data } = makePair({ count: 1200, seed: 140, angle: 0.03, t: [0.8, 1.2, 0.2] })
      // 采样上限压到 500：逼出"随机降采样"通路（1200 点 > 500）
      const request: GicpRequest = {
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: { samplingLimit: 500, seed: 4242 },
      }
      const a = await runGicp(request)
      const b = await runGicp(request)
      expect(a.result).toBe(b.result)
      expect(a.rms).toBe(b.rms)
      expect(a.initialRms).toBe(b.initialRms)
      expect(Array.from(a.r)).toEqual(Array.from(b.r))
      expect(Array.from(a.t)).toEqual(Array.from(b.t))
      expect(a.iterations).toBe(b.iterations)
      expect(a.pointCount).toBeLessThanOrEqual(500) // 采样确实发生了

      // 分块不变性：协方差 PCA 吃近邻、6x6 累加对块序无关 ⇒ 与 ICP 同样该逐位相等
      const params: GicpParams = { samplingLimit: 400, seed: 888 }
      const run = (pieces: number) =>
        runGicp({
          data: { chunks: chunked(Float64Array.from(data), pieces) },
          model: { chunks: chunked(Float64Array.from(model), pieces) },
          params,
        })
      const one = await run(1)
      const three = await run(3)
      const seven = await run(7)
      expect(Array.from(three.r)).toEqual(Array.from(one.r))
      expect(Array.from(three.t)).toEqual(Array.from(one.t))
      expect(three.rms).toBe(one.rms)
      expect(Array.from(seven.r)).toEqual(Array.from(one.r))
      expect(Array.from(seven.t)).toEqual(Array.from(one.t))
      expect(seven.rms).toBe(one.rms)
    })

    it('参数面：邻域点数 < 3 / 采样上限 < 3 / 越界重叠度 ⇒ INVALID_INPUT；空云 ⇒ NOTHING_TO_DO', async () => {
      const base = Float32Array.from(randomPoints(300, 150, 10))
      const chunks = sources(base)
      for (const params of [
        { correspondenceRandomness: 2 },
        { correspondenceRandomness: 0 },
        { samplingLimit: 2 },
        { finalOverlapRatio: 0 },
        { finalOverlapRatio: 1.5 },
      ] as GicpParams[]) {
        const res = await runGicp({ data: { chunks }, model: { chunks }, params })
        expect(res.result, `params=${JSON.stringify(params)}`).toBe(GICP_ERROR_INVALID_INPUT)
      }
      // 空数据云 ⇒ NOTHING_TO_DO（与 ICP 同语义）；空模型云 ⇒ INVALID_INPUT
      const empty: RadiusFilterChunkSource[] = [{ positions: new Float32Array(0), index: null }]
      expect((await runGicp({ data: { chunks: empty }, model: { chunks }, params: {} })).result).toBe(
        GICP_NOTHING_TO_DO
      )
      expect((await runGicp({ data: { chunks }, model: { chunks: empty }, params: {} })).result).toBe(
        GICP_ERROR_INVALID_INPUT
      )
    })

    it('省略 params == 显式 defaultGicpParams()：逐位相等（TS 默认值与 native 默认值不漂移）', async () => {
      const { model, data } = makePair({ count: 900, seed: 160, angle: 0.02, t: [0.6, 0.2, -0.3] })
      const omitted = await runGicp({ data: { chunks: sources(data) }, model: { chunks: sources(model) }, params: {} })
      const explicit = await runGicp({
        data: { chunks: sources(data) },
        model: { chunks: sources(model) },
        params: defaultGicpParams(),
      })
      expect(Array.from(explicit.r)).toEqual(Array.from(omitted.r))
      expect(Array.from(explicit.t)).toEqual(Array.from(omitted.t))
      expect(explicit.rms).toBe(omitted.rms)
      expect(explicit.pointCount).toBe(omitted.pointCount)
      expect(explicit.iterations).toBe(omitted.iterations)
      // 默认 = 平面化开 + 20 近邻（PCL setCorrespondenceRandomness 默认值）
      expect(defaultGicpParams().correspondenceRandomness).toBe(20)
      expect(defaultGicpParams().useNormalCovariance).toBe(true)
    })

    it('平面主导的点云（面到面权重的主场）：GICP 与 ICP 都能收敛，GICP 不差于 ICP', async () => {
      // 平面 + 少量厚度噪声：经典 GICP 的主场。断言只取"不比 ICP 差"这一条可稳定复现的性质，
      // 且留 20% 余量——两者都是迭代最近点族，具体数值随实现细节浮动，不写比实现还紧的断言。
      const rng = makeRng(171)
      const base: number[] = []
      for (let i = 0; i < 4000; i++) {
        base.push(rng() * 40, rng() * 40, (rng() - 0.5) * 0.05)
      }
      const truth: Truth = { r: rotationMatrix(0.2, 0.3, 0.93, 0.01), t: [0.4, -0.3, 0.08], s: 1 }
      const model = Float32Array.from(base)
      const data = Float32Array.from(transformPoints(base, truth))
      const req = { data: { chunks: sources(data) }, model: { chunks: sources(model) } }
      const gicp = await runGicp({ ...req, params: { seed: 5 } })
      const icp = await runIcp({ ...req, params: { seed: 5 } })
      expect(gicp.result).toBe(GICP_APPLY_TRANSFO)
      expect(icp.result).toBe(ICP_APPLY_TRANSFO)
      // eslint-disable-next-line no-console
      console.log(`[gicp vs icp] planar: gicp.rms=${gicp.rms} icp.rms=${icp.rms}`)
      expect(gicp.rms).toBeLessThanOrEqual(icp.rms * 1.2)
    })

    it('协方差真的进了目标函数：平面化开关与邻域点数都改变解算（退化实现会全部相同）', async () => {
      // 这一条挡的是"协方差估计静默退化成单位阵"——那种实现下 GICP ≡ ICP：
      // 邻域点数怎么改、平面化开关怎么拨，回包都逐位相同、covarianceError 恒等于点到点 RMS。
      const { model, data } = makePair({ count: 3000, seed: 190, angle: 0.05, t: [1.2, -0.4, 0.3], jitter: 0.02 })
      const req = { data: { chunks: sources(data) }, model: { chunks: sources(model) } }
      const run = (params: GicpParams) => runGicp({ ...req, params: { seed: 7, ...params } })
      const raw = await run({ useNormalCovariance: false })
      const planar = await run({ useNormalCovariance: true })
      const k5 = await run({ correspondenceRandomness: 5 })
      const k50 = await run({ correspondenceRandomness: 50 })
      for (const r of [raw, planar, k5, k50]) expect(r.result).toBe(GICP_APPLY_TRANSFO)
      // 平面化 = 法向权重 1/ε = 1000 倍：残差里的法向分量被放大 ⇒ 马氏残差比原始散布矩阵大一个量级
      expect(planar.covarianceError).toBeGreaterThan(raw.covarianceError * 10)
      // 反过来说，原始散布矩阵（近各向同性）下的马氏残差 ≈ 点到点 RMS 的量级
      expect(raw.covarianceError).toBeLessThan(raw.rms)
      // 邻域点数真的进了 PCA ⇒ 结果不同（不是逐位相同的死参数）
      expect(Array.from(k5.t)).not.toEqual(Array.from(k50.t))
    })
  })
})
