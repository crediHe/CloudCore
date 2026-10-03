/**
 * ransac_cylinder 的 N-API 绑定壳（node-addon-api）。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/ransacCylinder.ts）：
 *
 *   ransacCylinder.compute(request, callback)
 *     request = {
 *       distanceThreshold: number,       // 点到圆柱面的绝对距离 ≤ 它判内点（与坐标同单位）
 *       maxIterations: number,           // 假设循环最大轮数（自适应早停会提前结束）
 *       optimizeCoefficients: boolean,   // 是否对最优内点集做精修（轴方向重估 + Kåsa 圆拟合）
 *       sampleSize?: number,             // 采样集点数上限；0/undefined = 自动
 *       minRadius?: number,              // 半径下限；≤ 0 = 不限制（对齐 PCL setRadiusLimits）
 *       maxRadius?: number,              // 半径上限；≤ 0 = 不限制
 *       axis?: { x, y, z } | null,       // 轴方向约束；null/undefined = 由 normals 自动估计
 *       entities: [{
 *         entityId: number,              // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,     // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,    // 候选顶点下标（带 index 的分割产物必传）
 *           normals?: Uint16Array|null,  // 法向量量化码（**顶点缓冲空间**，长度 = 顶点数）。
 *                                        // axis 为 null 时**每块必传**，否则抛 TypeError；
 *                                        // 给了 axis 时忽略（显式轴模式零开销）。码制见
 *                                        // normal_compressor.h（与实体上的 `normalCode` 属性同布局）
 *         }],
 *       }],
 *     }
 *     callback(err, results)
 *     results = [{
 *       entityId,
 *       inliers: Uint32Array[],          // inliers[c] = 第 c 块内点顶点下标（递增）
 *       cylinder: {                      // 未找到圆柱 = null
 *         cx, cy, cz,                    // 几何中心（内点轴向范围中点，在轴上）
 *         ax, ay, az,                    // 单位轴方向（符号约定见 ransac_cylinder.cc 的 orientAxis）
 *         radius, halfHeight,            // 半径 + 内点轴向跨距之半
 *         basis: { ux,uy,uz, vx,vy,vz }, // 垂直于轴的右手指正交基（e1 × e2 = a），供渲染侧 O(1) 画圆柱
 *         inlierCount, sampleCount, iterationsUsed, rms, maxDeviation,
 *         axisEstimated,                 // 轴方向是否来自自动估计
 *         axisScore,                     // 轴候选得分 = 票数占比 × 各向异性比 ∈ [0,1]（显式轴恒 0）
 *       } | null
 *     }]
 *
 * **与其余 6 个算法模块的契约差异**：回包多一个 cylinder 字段（与 ransac-plane 的 plane 同理）。
 * RANSAC 的产物核心是**模型**而不只是归属，渲染侧要画圆柱、要报圆柱度，都要靠它。
 * 请求侧另多 `axis` / `minRadius` / `maxRadius` / `normals` 四项（对齐 PCL `SACSegmentationFromNormals`
 * 的 `setAxis` / `setRadiusLimits` / 法线输入）。
 *
 * **normals 是 2026-09 新增的输入通道**：在此之前轴方向由模块内部现算局部 PCA 法线得到，
 * 而那套在「大片平面 + 少量圆柱」的场景里会系统性选错轴（实测轴偏 72–90°）。现在法线来自
 * 渲染侧实体上的 `normalCode` 属性（normal-estimate 模块的产物，用户可见可调），
 * 轴方向改由「一致法线二阶矩的最小特征向量」给出，并按 `票数占比 × 各向异性比` 排候选
 * （详见 ransac_cylinder.cc 上半部分的长注释）。
 *
 * 实现要点（与另外 8 个模块逐行同构）：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内再开硬件线程并行跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - 结果在 OnOK（主线程）组装成 Uint32Array / 普通对象经回调返回；**一律 memcpy 进 V8 分配的
 *   内存**，不使用 napi_create_external_arraybuffer（Electron 渲染进程带 sandbox 会抛
 *   "External buffers are not allowed"，且异常被转成未捕获 JS 异常后回调永不触发）。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require，无需 electron-rebuild。
 */
#include <napi.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "ransac_cylinder.h"

namespace {

using ransac_cylinder::ChunkSource;
using ransac_cylinder::EntityResult;
using ransac_cylinder::EntitySource;
using ransac_cylinder::RansacParams;

/** 校验并取 Float32Array（错误类型抛 TypeError）。 */
Napi::Float32Array RequireFloat32Array(Napi::Env env, Napi::Value value, const char* what) {
  if (!value.IsTypedArray()) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是 TypedArray");
  }
  if (value.As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是 Float32Array");
  }
  return value.As<Napi::Float32Array>();
}

/** 校验并取可选的 Uint32Array（undefined / null 返回空 Handle）。 */
Napi::Uint32Array RequireOptionalUint32Array(Napi::Env env, Napi::Value value, const char* what) {
  if (value.IsUndefined() || value.IsNull()) {
    return Napi::Uint32Array();
  }
  if (!value.IsTypedArray() || value.As<Napi::TypedArray>().TypedArrayType() != napi_uint32_array) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是 Uint32Array 或 null");
  }
  return value.As<Napi::Uint32Array>();
}

/** 校验并取可选的 Uint16Array（undefined / null 返回空 Handle）。法向量码通道用。 */
Napi::Uint16Array RequireOptionalUint16Array(Napi::Env env, Napi::Value value, const char* what) {
  if (value.IsUndefined() || value.IsNull()) {
    return Napi::Uint16Array();
  }
  if (!value.IsTypedArray() || value.As<Napi::TypedArray>().TypedArrayType() != napi_uint16_array) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是 Uint16Array 或 null");
  }
  return value.As<Napi::Uint16Array>();
}

/** 单个输入实体（含解析后的裸指针与 GC pin）。 */
struct EntityInput {
  std::int32_t entityId = 0;
  struct ChunkInput {
    Napi::Reference<Napi::Float32Array> positionsRef;
    const float* positionsData = nullptr;
    std::uint32_t vertexCount = 0;  // 坐标点数（elementLength / 3）
    Napi::Reference<Napi::Uint32Array> indexRef;  // 空引用 = 无 index
    const std::uint32_t* indexData = nullptr;
    std::uint32_t indexCount = 0;
    Napi::Reference<Napi::Uint16Array> normalsRef;  // 空引用 = 该块无法线
    const std::uint16_t* normalsData = nullptr;
  };
  std::vector<ChunkInput> chunks;
};

/**
 * 垂直于轴的方向基（e1, e2），e1 × e2 = a。
 *
 * 与 ransac_cylinder.cc 里的 axisBasis 是**同一套规则**（取与 a 最不平行的坐标轴做叉积），
 * 之所以在回包里显式给出而不是让渲染侧自己算：平面模块同样把正交基画布（quad）随模型回传，
 * 「画片用的基怎么定」只应有一处实现，渲染侧拿到就能 makeBasis，不必再抄一遍规则。
 */
void BuildAxisBasis(const ransac_cylinder::CylinderModel& cyl, double* e1, double* e2) {
  const double ax = std::fabs(cyl.ax);
  const double ay = std::fabs(cyl.ay);
  const double az = std::fabs(cyl.az);
  double ex = 0.0;
  double ey = 0.0;
  double ez = 0.0;
  if (ax <= ay && ax <= az) {
    ex = 1.0;
  } else if (ay <= az) {
    ey = 1.0;
  } else {
    ez = 1.0;
  }
  double c1x = cyl.ay * ez - cyl.az * ey;
  double c1y = cyl.az * ex - cyl.ax * ez;
  double c1z = cyl.ax * ey - cyl.ay * ex;
  const double len = std::sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  if (len > 0.0) {
    c1x /= len;
    c1y /= len;
    c1z /= len;
  }
  e1[0] = c1x;
  e1[1] = c1y;
  e1[2] = c1z;
  e2[0] = cyl.ay * c1z - cyl.az * c1y;
  e2[1] = cyl.az * c1x - cyl.ax * c1z;
  e2[2] = cyl.ax * c1y - cyl.ay * c1x;
}

/** 组装 cylinder 对象（调用方保证 result.found）。 */
Napi::Object BuildCylinder(Napi::Env env, const ransac_cylinder::CylinderModel& cyl) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("cx", cyl.cx);
  obj.Set("cy", cyl.cy);
  obj.Set("cz", cyl.cz);
  obj.Set("ax", cyl.ax);
  obj.Set("ay", cyl.ay);
  obj.Set("az", cyl.az);
  obj.Set("radius", cyl.radius);
  obj.Set("halfHeight", cyl.halfHeight);
  obj.Set("inlierCount", static_cast<double>(cyl.inlierCount));
  obj.Set("sampleCount", static_cast<double>(cyl.sampleCount));
  obj.Set("iterationsUsed", cyl.iterationsUsed);
  obj.Set("rms", cyl.rms);
  obj.Set("maxDeviation", cyl.maxDeviation);
  obj.Set("axisEstimated", cyl.axisEstimated);
  obj.Set("axisScore", cyl.axisScore);

  double e1[3];
  double e2[3];
  BuildAxisBasis(cyl, e1, e2);
  Napi::Object basis = Napi::Object::New(env);
  basis.Set("ux", e1[0]);
  basis.Set("uy", e1[1]);
  basis.Set("uz", e1[2]);
  basis.Set("vx", e2[0]);
  basis.Set("vy", e2[1]);
  basis.Set("vz", e2[2]);
  obj.Set("basis", basis);
  return obj;
}

class RansacCylinderWorker final : public Napi::AsyncWorker {
 public:
  RansacCylinderWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    // ---- 解析输入（主线程）：distanceThreshold / maxIterations / optimizeCoefficients /
    //      sampleSize / minRadius / maxRadius / axis / entities ----
    const Napi::Value thresholdVal = request.Get("distanceThreshold");
    if (!thresholdVal.IsNumber()) throw Napi::TypeError::New(env, "distanceThreshold 必须是数字");
    params_.distanceThreshold = thresholdVal.As<Napi::Number>().DoubleValue();

    const Napi::Value iterVal = request.Get("maxIterations");
    if (!iterVal.IsNumber()) throw Napi::TypeError::New(env, "maxIterations 必须是数字");
    params_.maxIterations = iterVal.As<Napi::Number>().Uint32Value();

    const Napi::Value optimizeVal = request.Get("optimizeCoefficients");
    if (!optimizeVal.IsBoolean()) throw Napi::TypeError::New(env, "optimizeCoefficients 必须是布尔值");
    params_.optimizeCoefficients = optimizeVal.As<Napi::Boolean>().Value();

    const Napi::Value sampleVal = request.Get("sampleSize");
    if (sampleVal.IsNumber()) {
      params_.sampleSize = sampleVal.As<Napi::Number>().Uint32Value();
    } else if (!sampleVal.IsUndefined() && !sampleVal.IsNull()) {
      throw Napi::TypeError::New(env, "sampleSize 必须是数字、null 或 undefined");
    }

    // 半径约束：≤ 0 = 该侧不限制（与 C++ 侧的语义一致，负值不报错而是按不限处理）
    const Napi::Value minRadiusVal = request.Get("minRadius");
    if (minRadiusVal.IsNumber()) {
      params_.minRadius = minRadiusVal.As<Napi::Number>().DoubleValue();
    } else if (!minRadiusVal.IsUndefined() && !minRadiusVal.IsNull()) {
      throw Napi::TypeError::New(env, "minRadius 必须是数字、null 或 undefined");
    }
    const Napi::Value maxRadiusVal = request.Get("maxRadius");
    if (maxRadiusVal.IsNumber()) {
      params_.maxRadius = maxRadiusVal.As<Napi::Number>().DoubleValue();
    } else if (!maxRadiusVal.IsUndefined() && !maxRadiusVal.IsNull()) {
      throw Napi::TypeError::New(env, "maxRadius 必须是数字、null 或 undefined");
    }

    // 轴方向约束：null/undefined = 自动估计；给了向量就归一化交给 C++ 侧统一符号
    const Napi::Value axisVal = request.Get("axis");
    if (axisVal.IsObject()) {
      const Napi::Object axis = axisVal.As<Napi::Object>();
      const Napi::Value xVal = axis.Get("x");
      const Napi::Value yVal = axis.Get("y");
      const Napi::Value zVal = axis.Get("z");
      if (!xVal.IsNumber() || !yVal.IsNumber() || !zVal.IsNumber()) {
        throw Napi::TypeError::New(env, "axis 的 x/y/z 必须是数字");
      }
      params_.hasAxis = true;
      params_.axisX = xVal.As<Napi::Number>().DoubleValue();
      params_.axisY = yVal.As<Napi::Number>().DoubleValue();
      params_.axisZ = zVal.As<Napi::Number>().DoubleValue();
    } else if (!axisVal.IsUndefined() && !axisVal.IsNull()) {
      throw Napi::TypeError::New(env, "axis 必须是 {x, y, z}、null 或 undefined");
    }

    const Napi::Value entitiesVal = request.Get("entities");
    if (!entitiesVal.IsArray()) throw Napi::TypeError::New(env, "entities 必须是数组");
    const Napi::Array entities = entitiesVal.As<Napi::Array>();
    const std::uint32_t entityCount = entities.Length();
    entities_.reserve(entityCount);
    for (std::uint32_t e = 0; e < entityCount; ++e) {
      const Napi::Value entVal = entities.Get(e);
      if (!entVal.IsObject()) throw Napi::TypeError::New(env, "entities 元素必须是对象");
      const Napi::Object ent = entVal.As<Napi::Object>();

      EntityInput input;
      const Napi::Value idVal = ent.Get("entityId");
      if (!idVal.IsNumber()) throw Napi::TypeError::New(env, "entityId 必须是数字");
      input.entityId = idVal.As<Napi::Number>().Int32Value();

      const Napi::Value chunksVal = ent.Get("chunks");
      if (!chunksVal.IsArray()) throw Napi::TypeError::New(env, "chunks 必须是数组");
      const Napi::Array chunks = chunksVal.As<Napi::Array>();
      const std::uint32_t chunkCount = chunks.Length();
      input.chunks.reserve(chunkCount);
      for (std::uint32_t c = 0; c < chunkCount; ++c) {
        const Napi::Value chunkVal = chunks.Get(c);
        if (!chunkVal.IsObject()) throw Napi::TypeError::New(env, "chunks 元素必须是对象");
        const Napi::Object chunk = chunkVal.As<Napi::Object>();

        EntityInput::ChunkInput ci;
        const Napi::Float32Array pos = RequireFloat32Array(env, chunk.Get("positions"), "positions");
        if (pos.ElementLength() % 3 != 0) {
          throw Napi::TypeError::New(env, "positions 长度必须是 3 的倍数");
        }
        ci.positionsRef = Napi::Persistent(pos);
        ci.positionsData = pos.Data();
        ci.vertexCount = pos.ElementLength() / 3;

        const Napi::Uint32Array idx = RequireOptionalUint32Array(env, chunk.Get("index"), "index");
        if (!idx.IsEmpty()) {
          ci.indexRef = Napi::Persistent(idx);
          ci.indexData = idx.Data();
          ci.indexCount = idx.ElementLength();
        }

        // 法向量码：顶点缓冲空间（长度 = 顶点数，与实体 `normalCode` 属性同布局），
        // 故这里的长度校验是**精确相等**而不是「候选数」——带 index 的块也要按全量顶点给。
        const Napi::Uint16Array nrm = RequireOptionalUint16Array(env, chunk.Get("normals"), "normals");
        if (nrm.IsEmpty()) {
          if (!params_.hasAxis) {
            // 干净失败：自动估计没有法线可用，别让它走到 C++ 里静默返回「未找到」
            throw Napi::TypeError::New(
                env, "自动模式（axis 为 null）要求每个 chunk 提供 normals（Uint16Array）");
          }
        } else {
          if (nrm.ElementLength() != ci.vertexCount) {
            throw Napi::TypeError::New(env, "normals 长度必须等于该块的顶点数（顶点缓冲空间）");
          }
          ci.normalsRef = Napi::Persistent(nrm);
          ci.normalsData = nrm.Data();
        }
        input.chunks.push_back(std::move(ci));
      }
      entities_.push_back(std::move(input));
    }
  }

  void Execute() override {
    // uv 线程池内：逐实体（每实体内部再开硬件线程并行做两次全量扫描）
    results_.reserve(entities_.size());
    for (const EntityInput& input : entities_) {
      EntitySource source;
      source.chunks.reserve(input.chunks.size());
      for (const EntityInput::ChunkInput& ci : input.chunks) {
        ChunkSource cs;
        cs.positions = ci.positionsData;
        cs.vertexCount = ci.vertexCount;
        cs.index = ci.indexData;
        cs.indexCount = ci.indexCount > 0 ? ci.indexCount : 0;
        cs.normalCodes = ci.normalsData;
        source.chunks.push_back(cs);
      }
      results_.push_back(ransac_cylinder::fitEntity(source, params_));
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::EscapableHandleScope scope(env);
    const std::size_t n = entities_.size();
    Napi::Array results = Napi::Array::New(env, n);
    for (std::size_t i = 0; i < n; ++i) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("entityId", entities_[i].entityId);

      const std::vector<std::vector<std::uint32_t>>& inliersByChunk = results_[i].inlierByChunk;
      const std::size_t chunkCount = inliersByChunk.size();
      Napi::Array inliersArr = Napi::Array::New(env, chunkCount);
      for (std::size_t c = 0; c < chunkCount; ++c) {
        const std::vector<std::uint32_t>& inliers = inliersByChunk[c];
        Napi::Uint32Array inliersJs = Napi::Uint32Array::New(env, inliers.size());
        if (!inliers.empty()) {
          std::memcpy(inliersJs.Data(), inliers.data(), inliers.size() * sizeof(std::uint32_t));
        }
        inliersArr.Set(static_cast<std::uint32_t>(c), inliersJs);
      }
      item.Set("inliers", inliersArr);
      item.Set("cylinder", results_[i].found ? BuildCylinder(env, results_[i].cylinder) : env.Null());
      results.Set(static_cast<std::uint32_t>(i), item);
    }
    Callback().Call({env.Null(), scope.Escape(results)});
  }

 private:
  RansacParams params_;
  std::vector<EntityInput> entities_;
  std::vector<EntityResult> results_;
};

Napi::Value Compute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "compute(request: object, callback: function)");
  }
  // RansacCylinderWorker 在 Queue() 完成后自毁
  auto* worker =
      new RansacCylinderWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compute", Napi::Function::New(env, Compute));
  return exports;
}

}  // namespace

NODE_API_MODULE(ransac_cylinder, Init)
