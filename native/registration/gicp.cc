#include "gicp.h"
#include <vector>
#include <cmath>
#include <algorithm>
#include <numeric>
#include <limits>

namespace registration {

// 计算点的协方差矩阵
Mat3d computeCovariance(const std::vector<Vec3d>& points, const Vec3d& center) {
    Mat3d cov = {};
    const size_t n = points.size();
    if (n < 3) return cov; // 需要至少3个点来计算协方差

    for (const auto& p : points) {
        const Vec3d diff = sub(p, center);
        cov.m[0][0] += diff.x * diff.x;
        cov.m[0][1] += diff.x * diff.y;
        cov.m[0][2] += diff.x * diff.z;
        cov.m[1][0] += diff.y * diff.x;
        cov.m[1][1] += diff.y * diff.y;
        cov.m[1][2] += diff.y * diff.z;
        cov.m[2][0] += diff.z * diff.x;
        cov.m[2][1] += diff.z * diff.y;
        cov.m[2][2] += diff.z * diff.z;
    }

    const double inv = 1.0 / static_cast<double>(n - 1);
    cov = scaledMatrix(cov, inv);
    return cov;
}

// 计算Mahalanobis距离
double mahalanobisDistance(const Vec3d& p, const Vec3d& q, const Mat3d& cov) {
    const Vec3d diff = sub(p, q);
    // 简化计算：使用对角协方差
    double sum = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double variance = cov.m[i][i];
        if (variance > 0.0) {
            const double component = diff[i];
            sum += (component * component) / variance;
        }
    }
    return std::sqrt(sum);
}

// 找到最近的点（考虑协方差）
void findNearestWithCovariance(const std::vector<Vec3d>& points, const Vec3d& query,
                            const std::vector<Mat3d>& covariances,
                            size_t& bestIndex, double& bestDistance) {
    bestIndex = 0;
    bestDistance = std::numeric_limits<double>::infinity();

    for (size_t i = 0; i < points.size(); ++i) {
        const double dist = mahalanobisDistance(query, points[i], covariances[i]);
        if (dist < bestDistance) {
            bestDistance = dist;
            bestIndex = i;
        }
    }
}

// GICP主函数
GicpResult gicp(const std::vector<ChunkSource>& dataChunks,
               const std::vector<ChunkSource>& modelChunks,
               const GicpParams& params) {
    GicpResult result = {};
    result.iterations = 0;

    // 1. 采样
    const int dataLimit = params.finalOverlapRatio != 1.0
        ? static_cast<int>(params.samplingLimit / params.finalOverlapRatio)
        : params.samplingLimit;

    std::vector<Vec3d> dataPts;
    std::vector<Vec3d> modelPts;

    // 简化的采样实现（实际项目中需要更复杂的采样策略）
    for (const auto& chunk : dataChunks) {
        const float* pos = chunk.positions;
        const size_t count = chunk.index ? chunk.indexCount : chunk.vertexCount;
        for (size_t i = 0; i < count && dataPts.size() < dataLimit; ++i) {
            const size_t vi = chunk.index ? chunk.index[i] : i;
            if (vi < chunk.vertexCount) {
                dataPts.emplace_back(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
            }
        }
    }

    for (const auto& chunk : modelChunks) {
        const float* pos = chunk.positions;
        const size_t count = chunk.index ? chunk.indexCount : chunk.vertexCount;
        for (size_t i = 0; i < count && modelPts.size() < params.samplingLimit; ++i) {
            const size_t vi = chunk.index ? chunk.index[i] : i;
            if (vi < chunk.vertexCount) {
                modelPts.emplace_back(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
            }
        }
    }

    if (dataPts.empty() || modelPts.empty()) {
        return result;
    }

    // 2. 计算初始协方差（简化版）
    const Vec3d dataCenter = gravityCenter(dataPts);
    const Vec3d modelCenter = gravityCenter(modelPts);

    std::vector<Mat3d> dataCovariances(dataPts.size());
    std::vector<Mat3d> modelCovariances(modelPts.size());

    // 简化的协方差计算（实际项目中需要考虑局部邻域）
    for (size_t i = 0; i < dataPts.size(); ++i) {
        dataCovariances[i] = computeCovariance({dataPts[i]}, dataCenter);
    }

    for (size_t i = 0; i < modelPts.size(); ++i) {
        modelCovariances[i] = computeCovariance({modelPts[i]}, modelCenter);
    }

    // 3. 迭代配准
    Transform transform;
    transform.R = identity3();
    transform.rValid = true;
    transform.T = sub(modelCenter, dataCenter);
    transform.s = 1.0;

    double lastRMS = -1.0;
    double currentRMS = 0.0;

    for (int iter = 0; iter < params.maxIterations; ++iter) {
        result.iterations = iter + 1;

        // 4. 找到对应点（考虑协方差）
        std::vector<size_t> correspondences(dataPts.size());
        std::vector<double> distances(dataPts.size());

        for (size_t i = 0; i < dataPts.size(); ++i) {
            size_t bestIndex;
            double bestDistance;
            findNearestWithCovariance(modelPts, dataPts[i], modelCovariances, bestIndex, bestDistance);
            correspondences[i] = bestIndex;
            distances[i] = bestDistance;
        }

        // 5. 计算变换（基于高斯分布）
        // 简化实现：使用传统ICP的变换计算，但考虑协方差权重
        std::vector<Vec3d> aligned(dataPts.size());
        std::vector<Vec3d> reference(modelPts.size());

        for (size_t i = 0; i < dataPts.size(); ++i) {
            aligned[i] = applyTransform(transform, dataPts[i]);
        }

        // 计算RMS
        double sum = 0.0;
        for (size_t i = 0; i < dataPts.size(); ++i) {
            const Vec3d d = sub(modelPts[correspondences[i]], aligned[i]);
            sum += dot(d, d);
        }
        currentRMS = std::sqrt(sum / static_cast<double>(dataPts.size()));

        // 检查收敛
        if (iter > 0 && std::abs(currentRMS - lastRMS) < params.minRMSDecrease) {
            break;
        }
        lastRMS = currentRMS;

        // 6. 更新变换（简化版）
        // 实际项目中需要实现基于高斯分布的变换计算
        // 这里使用简化版本，实际应该实现GICP的变换计算
        if (params.adjustScale) {
            // 缩放估计
            double scale = 1.0;
            // 简化实现
            transform.s = scale;
        }

        // 平移更新
        transform.T = sub(modelCenter, applyTransform(transform, dataCenter));
    }

    result.trans = transform;
    result.rms = currentRMS;

    // 计算协方差误差（简化）
    result.covarianceError = 0.0; // 实际项目中需要实现

    return result;
}

} // namespace registration