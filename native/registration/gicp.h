#pragma once
#include "registration.h"

namespace registration {
struct GicpParams {
    int maxIterations;
    double minRMSDecrease;
    int samplingLimit;
    double finalOverlapRatio;
    bool adjustScale;
    bool filterOutFarthestPoints;
    // GICP特有参数
    double covarianceRadius;
    bool useNormalCovariance;
};

struct GicpResult {
    Transform trans;
    double rms;
    int iterations;
    // GICP统计信息
    double covarianceError;
};

GicpResult gicp(const std::vector<ChunkSource>& dataChunks,
               const std::vector<ChunkSource>& modelChunks,
               const GicpParams& params);
}