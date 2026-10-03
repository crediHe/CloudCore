/**
 * normal_estimate 的 N-API 绑定壳（node-addon-api）。两个导出：
 *
 * ── 1) 法向量估计 ────────────────────────────────────────────────────────────
 *   normalEstimate.computeNormals(request, callback)
 *     request = {
 *       radius: number,            // 邻域球半径（与坐标同单位，显示坐标）
 *       model: 0 | 1,              // 0 = LS（最小二乘平面），1 = QUADRIC（二次曲面）
 *       orientation: number,       // 镜像 ccNormalVectors::Orientation；255 = UNDEFINED（不过定向）
 *       entities: [{
 *         entityId: number,        // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,   // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,  // 候选顶点下标（带 index 的分割产物必传）
 *         }],
 *       }],
 *     }
 *     callback(err, results)
 *     results = [{ entityId, codes: Uint16Array[], computed, nullCount, capped }]
 *
 *   **契约偏离**（另两处在 lod-octree 的「整实体一次吃下」与 ransac-plane 的 `plane` 字段）：
 *   `codes[c][k]` 是第 c 块**第 k 个候选点**的量化码（长度 = 该块候选数），即「每候选一个值」
 *   的并行数组——不是其余 6 个模块的「顶点缓冲空间子集」。候选语义与入参一一对应，
 *   渲染侧用 utils/normalEstimate.ts#scatterNormalCodes 摊成顶点缓冲空间。
 *
 * ── 2) 自动半径（对话框 Auto 按钮单独调，不必与估计同批）─────────────────────
 *   normalEstimate.guessRadius(request, callback)
 *     request = {
 *       entityId: number,
 *       chunks: [...同上],         // 单实体（与 CC 一致：Auto 只在选中一片点云时可用）
 *       seed?: number,             // 可选：PRNG 种子（默认 kRandomSeed；固定种子 = 可复现）
 *       aimedPopulationPerCell?: number,  // 目标邻域点数（默认 16）
 *       aimedPopulationRange?: number,    // 命中半宽（默认 4）
 *       minCellPopulation?: number,       // 「人口充足」下限（默认 6）
 *       minAboveMinRatio?: number,        // 密度均匀判据（默认 0.97）
 *     }
 *     callback(err, result)
 *     result = { radius, attempts, sampledCount, meanPopulation, stdDevPopulation, aboveMinRatio }
 *
 * 实现要点：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内再开硬件线程并行跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - 结果码在 OnOK（主线程）**拷贝**进 V8 分配的内存后经回调返回。**不要**用
 *   napi_create_external_arraybuffer：Electron 渲染进程的 V8 带 sandbox，会抛
 *   "External buffers are not allowed"，且异常被 node-addon-api 转成未捕获 JS 异常，
 *   JS 回调永久不触发（见 OnOK 的兜底与 native/lod-octree 的同类注释）。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require，无需 electron-rebuild。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "normal_estimate.h"

namespace {

using normal_estimate::ChunkSource;
using normal_estimate::EntitySource;
using normal_estimate::LocalModel;
using normal_estimate::NormalParams;
using normal_estimate::RadiusParams;
using normal_estimate::RadiusResult;

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

/** 解析 chunks 数组（两个导出的 request 形状一致）。 */
std::vector<EntityInput::ChunkInput> ParseChunks(Napi::Env env, const Napi::Value& chunksVal) {
  if (!chunksVal.IsArray()) throw Napi::TypeError::New(env, "chunks 必须是数组");
  const Napi::Array chunks = chunksVal.As<Napi::Array>();
  const std::uint32_t chunkCount = chunks.Length();
  std::vector<EntityInput::ChunkInput> out;
  out.reserve(chunkCount);
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
    out.push_back(std::move(ci));
  }
  return out;
}

/** 解析 entities 数组（仅 computeNormals 用）。 */
std::vector<EntityInput> ParseEntities(Napi::Env env, const Napi::Value& entitiesVal) {
  if (!entitiesVal.IsArray()) throw Napi::TypeError::New(env, "entities 必须是数组");
  const Napi::Array entities = entitiesVal.As<Napi::Array>();
  const std::uint32_t entityCount = entities.Length();
  std::vector<EntityInput> out;
  out.reserve(entityCount);
  for (std::uint32_t e = 0; e < entityCount; ++e) {
    const Napi::Value entVal = entities.Get(e);
    if (!entVal.IsObject()) throw Napi::TypeError::New(env, "entities 元素必须是对象");
    const Napi::Object ent = entVal.As<Napi::Object>();

    EntityInput input;
    const Napi::Value idVal = ent.Get("entityId");
    if (!idVal.IsNumber()) throw Napi::TypeError::New(env, "entityId 必须是数字");
    input.entityId = idVal.As<Napi::Number>().Int32Value();
    input.chunks = ParseChunks(env, ent.Get("chunks"));
    out.push_back(std::move(input));
  }
  return out;
}

/**
 * 由解析好的块输入构造算法层的零拷贝源。
 * 只收 chunks 而不是 EntityInput：Napi::Reference 是 move-only，整个 EntityInput
 * **不能拷贝**，按值/引用透传会踩到已删除的拷贝赋值（MSVC 报 C2280）。
 */
EntitySource ToEntitySource(const std::vector<EntityInput::ChunkInput>& chunks) {
  EntitySource source;
  source.chunks.reserve(chunks.size());
  for (const EntityInput::ChunkInput& ci : chunks) {
    ChunkSource cs;
    cs.positions = ci.positionsData;
    cs.vertexCount = ci.vertexCount;
    cs.index = ci.indexData;
    cs.indexCount = ci.indexCount > 0 ? ci.indexCount : 0;
    source.chunks.push_back(cs);
  }
  return source;
}

/** 取可选数字（缺省 / 非数字时用 fallback）。 */
double OptionalNumber(const Napi::Object& obj, const char* key, double fallback) {
  const Napi::Value v = obj.Get(key);
  if (v.IsUndefined() || v.IsNull() || !v.IsNumber()) return fallback;
  return v.As<Napi::Number>().DoubleValue();
}

// ---------------------------------------------------------------------------
// 导出 1：法向量估计
// ---------------------------------------------------------------------------

class ComputeWorker final : public Napi::AsyncWorker {
 public:
  ComputeWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    const Napi::Value radiusVal = request.Get("radius");
    if (!radiusVal.IsNumber()) throw Napi::TypeError::New(env, "radius 必须是数字");
    params_.radius = radiusVal.As<Napi::Number>().DoubleValue();

    const Napi::Value modelVal = request.Get("model");
    if (!modelVal.IsNumber()) throw Napi::TypeError::New(env, "model 必须是数字（0 = LS，1 = QUADRIC）");
    const std::int32_t model = modelVal.As<Napi::Number>().Int32Value();
    if (model != 0 && model != 1) throw Napi::TypeError::New(env, "model 只支持 0（LS）或 1（QUADRIC）");
    params_.model = (model == 1) ? LocalModel::QUADRIC : LocalModel::LS;

    const Napi::Value orientVal = request.Get("orientation");
    if (!orientVal.IsNumber()) throw Napi::TypeError::New(env, "orientation 必须是数字");
    params_.orientation = orientVal.As<Napi::Number>().Uint32Value();

    entities_ = ParseEntities(env, request.Get("entities"));
  }

  void Execute() override {
    results_.reserve(entities_.size());
    for (const EntityInput& input : entities_) {
      results_.push_back(normal_estimate::estimateEntity(ToEntitySource(input.chunks), params_));
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    // OnOK 里抛出的 Napi::Error 会被 node-addon-api 的 WrapCallback 转成"未捕获的 JS 异常"
    // 抛出，而**不是**走 JS 回调——调用方永远等不到回调（静默挂死）。这里自己兜住转成错误回调。
    Napi::Array results = Napi::Array::New(env, entities_.size());
    try {
      FillResults(env, results);
    } catch (const Napi::Error& e) {
      Callback().Call({Napi::Error::New(env, e.Message()).Value(), env.Null()});
      return;
    }
    Callback().Call({env.Null(), results});
  }

  void OnError(const Napi::Error& e) override {
    // 算法层异常（内存不足等）走 JS 错误回调，不崩进程
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  /** 组装结果（失败时抛 Napi::Error，由 OnOK 兜住）。 */
  void FillResults(Napi::Env env, Napi::Array results) {
    for (std::size_t i = 0; i < results_.size(); ++i) {
      const normal_estimate::EntityResult& r = results_[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("entityId", entities_[i].entityId);

      const std::size_t chunkCount = r.codesByChunk.size();
      Napi::Array codesArr = Napi::Array::New(env, chunkCount);
      for (std::size_t c = 0; c < chunkCount; ++c) {
        const std::vector<std::uint16_t>& codes = r.codesByChunk[c];
        // 必须 memcpy 进 V8 分配的内存（不要外部 ArrayBuffer，见文件头）
        Napi::Uint16Array codesJs = Napi::Uint16Array::New(env, codes.size());
        if (!codes.empty()) {
          std::memcpy(codesJs.Data(), codes.data(), codes.size() * sizeof(std::uint16_t));
        }
        codesArr.Set(static_cast<std::uint32_t>(c), codesJs);
      }
      item.Set("codes", codesArr);
      item.Set("computed", static_cast<double>(r.computed));
      item.Set("nullCount", static_cast<double>(r.nullCount));
      item.Set("capped", static_cast<double>(r.capped));
      results.Set(static_cast<std::uint32_t>(i), item);
    }
  }

  NormalParams params_;
  std::vector<EntityInput> entities_;
  std::vector<normal_estimate::EntityResult> results_;
};

Napi::Value ComputeNormals(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "computeNormals(request: object, callback: function)");
  }
  // ComputeWorker 在 Queue() 完成后自毁
  auto* worker = new ComputeWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// 导出 2：自动半径
// ---------------------------------------------------------------------------

class GuessRadiusWorker final : public Napi::AsyncWorker {
 public:
  GuessRadiusWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    const Napi::Value idVal = request.Get("entityId");
    if (!idVal.IsNumber()) throw Napi::TypeError::New(env, "entityId 必须是数字");
    entityId_ = idVal.As<Napi::Number>().Int32Value();
    chunks_ = ParseChunks(env, request.Get("chunks"));

    params_.seed =
        static_cast<std::uint32_t>(OptionalNumber(request, "seed", normal_estimate::kRandomSeed));
    params_.aimedPopulationPerCell = static_cast<std::uint32_t>(
        OptionalNumber(request, "aimedPopulationPerCell", params_.aimedPopulationPerCell));
    params_.aimedPopulationRange = static_cast<std::uint32_t>(
        OptionalNumber(request, "aimedPopulationRange", params_.aimedPopulationRange));
    params_.minCellPopulation = static_cast<std::uint32_t>(
        OptionalNumber(request, "minCellPopulation", params_.minCellPopulation));
    params_.minAboveMinRatio = OptionalNumber(request, "minAboveMinRatio", params_.minAboveMinRatio);
  }

  void Execute() override { result_ = normal_estimate::guessRadius(ToEntitySource(chunks_), params_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    try {
      Napi::Object item = Napi::Object::New(env);
      item.Set("entityId", entityId_);
      item.Set("radius", result_.radius);
      item.Set("attempts", result_.attempts);
      item.Set("sampledCount", result_.sampledCount);
      item.Set("meanPopulation", result_.meanPopulation);
      item.Set("stdDevPopulation", result_.stdDevPopulation);
      item.Set("aboveMinRatio", result_.aboveMinRatio);
      Callback().Call({env.Null(), item});
    } catch (const Napi::Error& e) {
      Callback().Call({Napi::Error::New(env, e.Message()).Value(), env.Null()});
    }
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  std::int32_t entityId_ = 0;
  std::vector<EntityInput::ChunkInput> chunks_;
  RadiusParams params_;
  RadiusResult result_;
};

Napi::Value GuessRadius(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "guessRadius(request: object, callback: function)");
  }
  auto* worker =
      new GuessRadiusWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("computeNormals", Napi::Function::New(env, ComputeNormals));
  exports.Set("guessRadius", Napi::Function::New(env, GuessRadius));
  return exports;
}

}  // namespace

NODE_API_MODULE(normal_estimate, Init)
