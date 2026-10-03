/**
 * csf_lidar（LiDAR CSF 地面分割）的 N-API 绑定壳（node-addon-api）。
 * 语义取向：CloudCompare qCSF 移植（机载/平坦地形）；地形贴身的高精度版
 * 见 native/csf-pro。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/csf.ts）：
 *
 *   csf.compute(request, callback)
 *     request = {
 *       clothResolution: number,   // 布料网格间距（与坐标同单位）
 *       rigidness: number,         // 布料刚性 1..3（CC 三档）
 *       iterations: number,        // 最大迭代次数（默认 500）
 *       timeStep: number,          // 模拟时间步（默认 0.65）
 *       classThreshold: number,    // 分类阈值（默认 0.5）
 *       smoothSlope: boolean,      // 是否启用陡坡后处理（默认 false）
 *       heightAxis: number,        // 输入坐标竖直向上轴 0/1/2（默认 2 = z-up）
 *       entities: [{
 *         entityId: number,        // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,   // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,  // 候选顶点下标（带 index 的分割产物必传）
 *         }],
 *       }],
 *     }
 *     callback(err, results)
 *     results = [{ entityId, ground: Uint32Array[] }]  // ground[c] = 第 c 块地面顶点下标（递增）
 *
 * 语义：布料覆盖实体全部候选点的水平范围（与块切分无关）；分类只覆盖
 * 候选点。非地面 = 候选全集补集，渲染侧用 splitKeptRemoved 同款归并推导。
 *
 * 实现要点（与 radius_filter 壳一致）：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - 结果 ground 在 OnOK（主线程）组装成 Uint32Array 经回调返回。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "csf.h"

namespace {

using csf::ChunkSource;
using csf::ClassifyParams;
using csf::EntityResult;
using csf::EntitySource;

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

class CsfWorker final : public Napi::AsyncWorker {
 public:
  CsfWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    // ---- 解析参数（主线程）----
    const auto numField = [&](const char* key) {
      const Napi::Value v = request.Get(key);
      if (!v.IsNumber()) throw Napi::TypeError::New(env, std::string(key) + " 必须是数字");
      return v.As<Napi::Number>().DoubleValue();
    };
    params_.clothResolution = numField("clothResolution");
    params_.rigidness = static_cast<int>(numField("rigidness"));
    params_.iterations = static_cast<int>(numField("iterations"));
    params_.timeStep = numField("timeStep");
    params_.classThreshold = numField("classThreshold");

    const Napi::Value slopeVal = request.Get("smoothSlope");
    if (!slopeVal.IsBoolean()) throw Napi::TypeError::New(env, "smoothSlope 必须是 boolean");
    params_.smoothSlope = slopeVal.As<Napi::Boolean>().Value();

    const Napi::Value axisVal = request.Get("heightAxis");
    if (!axisVal.IsNumber()) throw Napi::TypeError::New(env, "heightAxis 必须是数字");
    params_.heightAxis = static_cast<std::uint8_t>(axisVal.As<Napi::Number>().Uint32Value());

    // ---- 解析实体（主线程，与 radius_filter 壳同一套）----
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
    // uv 线程池内：逐实体跑纯 C++ 算法（v1 忠实串行移植）
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
      results_.push_back(csf::classifyEntity(source, params_));
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

      const std::vector<std::vector<std::uint32_t>>& groundByChunk = results_[i].groundByChunk;
      const std::size_t chunkCount = groundByChunk.size();
      Napi::Array groundArr = Napi::Array::New(env, chunkCount);
      for (std::size_t c = 0; c < chunkCount; ++c) {
        const std::vector<std::uint32_t>& ground = groundByChunk[c];
        Napi::Uint32Array groundJs = Napi::Uint32Array::New(env, ground.size());
        if (!ground.empty()) {
          std::memcpy(groundJs.Data(), ground.data(), ground.size() * sizeof(std::uint32_t));
        }
        groundArr.Set(static_cast<std::uint32_t>(c), groundJs);
      }
      item.Set("ground", groundArr);
      results.Set(static_cast<std::uint32_t>(i), item);
    }
    Callback().Call({env.Null(), scope.Escape(results)});
  }

  void OnError(const Napi::Error& e) override {
    // 算法层异常（如布料粒子数超上限）走 JS 错误回调，不崩进程
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  ClassifyParams params_;
  std::vector<EntityInput> entities_;
  std::vector<EntityResult> results_;
};

Napi::Value Compute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "compute(request: object, callback: function)");
  }
  // CsfWorker 在 Queue() 完成后自毁
  auto* worker = new CsfWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compute", Napi::Function::New(env, Compute));
  return exports;
}

}  // namespace

NODE_API_MODULE(csf_lidar, Init)
