import { describe, it, expect, vi } from 'vitest'
import {
  computeGicp,
  defaultGicpParams,
  describeGicpResult,
  resolveRegistrationPair,
} from '../../../../src/renderer/utils/registration'

/**
 * GICP 纯 JS 侧单元测试（**不加载原生模块**）：参数默认值、结果码文案、配对解析，
 * 以及 `computeGicp` 的 Promise 包装（用 mock 的 nativeLoader 顶掉真实 addon）。
 *
 * ⚠ `vi.mock` 必须在**模块顶层**：Vitest 把顶层 `vi.mock` 提升到 import 之前，而
 * `computeGicp` 是顶层静态 import、模块加载时就把 nativeLoader 绑定了——写在 `beforeAll`
 * 里不会被提升，那条"用 mock 模块"的用例会静默走真实加载器（本文件历史上有过这个坑）。
 * native 侧的算法断言（真的会转、确定性、参数面）在 registration.spec.ts 的 gicp 段落。
 */

vi.mock('../../../../src/renderer/utils/nativeLoader', () => ({
  loadNativeModule: vi.fn((name: string) => {
    if (name !== 'registration') throw new Error(`Unknown module: ${name}`)
    return {
      gicp: vi.fn((_request: unknown, callback: (err: Error | null, result?: unknown) => void) => {
        // 回包字段与 GicpResult 一一对应（native 侧缺字段会让面板读 undefined 崩掉）
        callback(null, {
          result: 1, // GICP_APPLY_TRANSFO
          rms: 0.01,
          initialRms: 0.1,
          pointCount: 1000,
          iterations: 5,
          r: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
          t: new Float64Array([1, 2, 3]),
          s: 1,
          rValid: true,
          covarianceError: 0.001,
        })
      }),
    }
  }),
}))

describe('GICP 功能测试', () => {
  it('defaultGicpParams 返回合理的默认值（前七项与 ICP 逐字一致，无缩放项）', () => {
    const params = defaultGicpParams()
    expect(params).toEqual({
      maxIterations: 20,
      minRMSDecrease: 1.0e-5,
      samplingLimit: 50000,
      finalOverlapRatio: 1.0,
      filterOutFarthestPoints: false,
      transformationFilters: 0,
      // GICP 特有：协方差邻域 = k 近邻（PCL setCorrespondenceRandomness 默认 20）+ 平面化正则化
      correspondenceRandomness: 20,
      useNormalCovariance: true,
    })
    // GICP 是刚体算法：不存在 adjustScale / minScale / maxScale（曾是照抄 ICP 的死参数）
    expect('adjustScale' in params).toBe(false)
    expect('minScale' in params).toBe(false)
    expect('maxScale' in params).toBe(false)
    expect('covarianceRadius' in params).toBe(false)
  })

  it('describeGicpResult 将结果码转成人话', () => {
    expect(describeGicpResult(1)).toBe('收敛')
    expect(describeGicpResult(100)).toBe('未知错误（结果码 100）')
    expect(describeGicpResult(101)).toBe('解算退化（到位姿解不出旋转，如参考点集缩成一个点）')
    expect(describeGicpResult(104)).toBe('被用户取消')
    expect(describeGicpResult(-999)).toBe('未知错误（结果码 -999）')
  })

  it('resolveRegistrationPair 的配置判据：恰好 2 个点云才放行', () => {
    // 创建场景数据
    const projects = [
      {
        id: 1,
        name: 'test',
        path: '',
        type: 'project',
        expanded: true,
        visible: true,
        showNameIn3D: false,
        entities: [
          {
            id: 10,
            name: 'cloud1.las',
            path: '',
            type: 'pointcloud',
            visible: true,
            pointCount: 100,
            hasColor: false,
            hasNormals: false,
            bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            globalShift: { x: 0, y: 0, z: 0 },
          },
          {
            id: 11,
            name: 'cloud2.las',
            path: '',
            type: 'pointcloud',
            visible: true,
            pointCount: 100,
            hasColor: false,
            hasNormals: false,
            bbox: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            globalShift: { x: 0, y: 0, z: 0 },
          },
        ],
        treeGroups: [],
      },
    ]

    // 1 个：禁用
    const oneCloud = [{ type: 'entity', id: 10 }]
    let resolved = resolveRegistrationPair(oneCloud, projects)
    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toContain('恰好 2 个')

    // 2 个：启用
    const twoClouds = [
      { type: 'entity', id: 10 },
      { type: 'entity', id: 11 },
    ]
    resolved = resolveRegistrationPair(twoClouds, projects)
    expect(resolved.ok).toBe(true)
    expect(resolved.first).toBe(10)
    expect(resolved.second).toBe(11)

    // 3 个：禁用
    const threeClouds = [
      { type: 'entity', id: 10 },
      { type: 'entity', id: 11 },
      { type: 'entity', id: 12 },
    ]
    resolved = resolveRegistrationPair(threeClouds, projects)
    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toContain('恰好 2 个')
  })

  it('computeGicp 走 mock 的 native 模块并原样回传结果', async () => {
    const request = {
      model: { chunks: [{ positions: new Float32Array(300), vertexCount: 100 }] },
      data: { chunks: [{ positions: new Float32Array(300), vertexCount: 100 }] },
      params: defaultGicpParams(),
    }

    const result = await computeGicp(request)

    expect(result.result).toBe(1)
    expect(result.rms).toBe(0.01)
    expect(result.initialRms).toBe(0.1)
    expect(result.iterations).toBe(5)
    expect(result.pointCount).toBe(1000)
    expect(result.covarianceError).toBe(0.001)
    expect(result.r).toHaveLength(9)
    expect(result.t).toHaveLength(3)
    expect(result.s).toBe(1)
    expect(result.rValid).toBe(true)
  })
})
