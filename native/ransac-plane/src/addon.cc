/**
 * ransac_plane 的 N-API 绑定壳（node-addon-api）。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/ransacPlane.ts）：
 *
 *   ransacPlane.compute(request, callback)
 *     request = {
 *       distanceThreshold: number,       // 点到平面的绝对距离 ≤ 它判内点（与坐标同单位）
 *       maxIterations: number,           // 假设循环最大轮数（自适应早停会提前结束）
 *       optimizeCoefficients: boolean,   // 是否对最优内点集做最小二乘精修
 *       sampleSize?: number,             // 采样集点数上限；0/undefined = 自动
 *       entities: [{
 *         entityId: number,              // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,     // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,    // 候选顶点下标（带 index 的分割产物必传）
 *         }],
 *       }],
 *     }
 *     callback(err, results)
 *     results = [{
 *       entityId,
 *       inliers: Uint32Array[],          // inliers[c] = 第 c 块内点顶点下标（递增）
 *       plane: {                         // 未找到平面 = null
 *         nx, ny, nz, d,                 // 单位法向 + 平面方程 n·p + d = 0（显示坐标空间）
 *         inlierCount, sampleCount, iterationsUsed, rms, maxDeviation,
 *         quad: { cx,cy,cz, ux,uy,uz, vx,vy,vz, halfU, halfV },
 *       } | null
 *     }]
 *
 * **与其余 6 个算法模块的契约差异**：回包多一个 plane 字段（它们只有索引数组）。
 * RANSAC 的产物核心是**模型**而不只是归属，渲染侧要画平面、要报平面度，都要靠它。
 *
 * 实现要点：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内再开硬件线程并行跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - 结果在 OnOK（主线程）组装成 Uint32Array / 普通对象经回调返回；**一律 memcpy 进 V8 分配的
 *   内存**，不使用 napi_create_external_arraybuffer（Electron 渲染进程带 sandbox 会抛
 *   "External buffers are not allowed"，且异常被转成未捕获 JS 异常后回调永不触发）。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require，无需 electron-rebuild。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <vector>

#include "ransac_plane.h"

namespace {

using ransac_plane::ChunkSource;
using ransac_plane::EntityResult;
using ransac_plane::EntitySource;
using ransac_plane::RansacParams;

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
  };
  std::vector<ChunkInput> chunks;
};

/** 组装 plane 对象（调用方保证 result.found）。 */
Napi::Object BuildPlane(Napi::Env env, const ransac_plane::PlaneModel& plane) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("nx", plane.nx);
  obj.Set("ny", plane.ny);
  obj.Set("nz", plane.nz);
  obj.Set("d", plane.d);
  obj.Set("inlierCount", static_cast<double>(plane.inlierCount));
  obj.Set("sampleCount", static_cast<double>(plane.sampleCount));
  obj.Set("iterationsUsed", plane.iterationsUsed);
  obj.Set("rms", plane.rms);
  obj.Set("maxDeviation", plane.maxDeviation);

  Napi::Object quad = Napi::Object::New(env);
  quad.Set("cx", plane.quad.cx);
  quad.Set("cy", plane.quad.cy);
  quad.Set("cz", plane.quad.cz);
  quad.Set("ux", plane.quad.ux);
  quad.Set("uy", plane.quad.uy);
  quad.Set("uz", plane.quad.uz);
  quad.Set("vx", plane.quad.vx);
  quad.Set("vy", plane.quad.vy);
  quad.Set("vz", plane.quad.vz);
  quad.Set("halfU", plane.quad.halfU);
  quad.Set("halfV", plane.quad.halfV);
  obj.Set("quad", quad);
  return obj;
}

class RansacPlaneWorker final : public Napi::AsyncWorker {
 public:
  RansacPlaneWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    // ---- 解析输入（主线程）：distanceThreshold / maxIterations / optimizeCoefficients /
    //      sampleSize / entities ----
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
        source.chunks.push_back(cs);
      }
      results_.push_back(ransac_plane::fitEntity(source, params_));
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
      item.Set("plane", results_[i].found ? BuildPlane(env, results_[i].plane) : env.Null());
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
  // RansacPlaneWorker 在 Queue() 完成后自毁
  auto* worker =
      new RansacPlaneWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compute", Napi::Function::New(env, Compute));
  return exports;
}

}  // namespace

NODE_API_MODULE(ransac_plane, Init)
