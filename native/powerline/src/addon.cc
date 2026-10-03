/**
 * powerline 的 N-API 绑定壳（node-addon-api）。**两个导出**（同 registration / normal-estimate
 * 的多导出先例）：重型候选提取与轻型连线分开，理由见 powerline.h 顶部的「两阶段分工」。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/powerline.ts，**两处必须同步**）：
 *
 *   powerline.extractCandidates(request, callback)
 *     request = {
 *       minHeight: number,          // 离地高下限（m）
 *       radius: number,             // PCA 邻域半径（m）
 *       groundGrid: {               // 地面参考面（格心原点、行主序、无 NaN）
 *         values: Float32Array, cols: number, rows: number,
 *         cellSize: number, originX: number, originY: number,
 *       },
 *       threadCount?: number,       // 仅单测：0/缺省 = 硬件并发数，1 = 串行
 *       entities: [{ entityId, chunks: [{ positions: Float32Array, index?: Uint32Array|null }] }],
 *     }
 *     callback(err, results)
 *     results = [{
 *       entityId: number,
 *       chunks: [{ kept: Uint32Array }],        // 逐块池子的顶点缓冲下标（升序）
 *       features: {                              // 逐池点、块主序，长度 = Σ kept.length
 *         linearity: Float32Array, verticality: Float32Array,
 *         hag: Float32Array, neighborCount: Uint32Array,
 *       },
 *       stats: { offGroundCount: number, poolCount: number },
 *     }]
 *
 *   powerline.traceLines(request, callback)
 *     request = {
 *       connectRadius: number, residualTolerance: number, minLinePoints: number,
 *       minLineLength: number, gapRadius: number, gapAngleDeg: number, dirRadius: number,
 *       threadCount?: number,
 *       entities: [...同 extractCandidates...],   // index = 精筛后的候选
 *     }
 *     results = [{
 *       entityId: number,
 *       labels: Int32Array,                      // 逐候选（块主序）1..K；0 = 残点
 *       lines: [{ id, pointCount, length, sag, azimuthDeg, rms, gapCount }],
 *       stats: { candidateTotal: number, lineCount: number, noiseCount: number },
 *     }]
 *
 * 实现要点（同其余 11 个模块）：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内跑纯 C++ 算法（算法内部再开硬件线程并行）。
 * - 结果在 OnOK（主线程）组装成 TypedArray 经回调返回；**不用外部缓冲**
 *   （Electron 沙箱会抛 "External buffers are not allowed"，且异常会让 JS 回调永不触发）。
 * - 失败（池子超上限 / 参数非法）走 SetError → 错误回调，绝不交半成品。
 * - ⚠ `chunks[].index` 的语义与其余 12 个模块**不同**：这里 `new Uint32Array(0)`
 *   表示「该块零候选」，而 `undefined / null` 才表示「全量顶点」。理由（精筛会把整块
 *   刷空，退化即灾难）见 powerline.h 的 `ChunkSource::hasIndex`。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "powerline.h"

namespace {

using powerline::ChunkSource;
using powerline::EntitySource;
using powerline::ExtractEntityResult;
using powerline::ExtractParams;
using powerline::ExtractResult;
using powerline::GroundGrid;
using powerline::TraceEntityResult;
using powerline::TraceLineInfo;
using powerline::TraceParams;
using powerline::TraceResult;

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

/** 校验并取数字。 */
double RequireNumber(Napi::Env env, Napi::Value value, const char* what) {
  if (!value.IsNumber()) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是数字");
  }
  return value.As<Napi::Number>().DoubleValue();
}

/** 单个输入实体（含解析后的裸指针与 GC pin）。 */
struct EntityInput {
  std::int32_t entityId = 0;
  struct ChunkInput {
    Napi::Reference<Napi::Float32Array> positionsRef;
    const float* positionsData = nullptr;
    std::uint32_t vertexCount = 0;
    Napi::Reference<Napi::Uint32Array> indexRef;  // 空引用 = 无 index
    bool hasIndex = false;  // 「显式给空 index」≠「没给 index」，见 powerline.h
    const std::uint32_t* indexData = nullptr;
    std::uint32_t indexCount = 0;
  };
  std::vector<ChunkInput> chunks;
};

/** 解析 request.entities（两个导出共用）。 */
std::vector<EntityInput> ParseEntities(Napi::Env env, const Napi::Object& request) {
  const Napi::Value entitiesVal = request.Get("entities");
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
    input.entityId = static_cast<std::int32_t>(RequireNumber(env, ent.Get("entityId"), "entityId"));

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
        ci.hasIndex = true;
        // ⚠ 长度 0 的 TypedArray 其 Data() 可能给 nullptr——此时 hasIndex 仍为 true，
        // 算法侧按「零候选」处理（**不是**全量顶点）；所有读取都受 indexCount 界住。
        ci.indexData = idx.Data();
        ci.indexCount = idx.ElementLength();
      }
      input.chunks.push_back(std::move(ci));
    }
    out.push_back(std::move(input));
  }
  return out;
}

/** 把解析后的输入摊成算法层的 EntitySource 列表。 */
std::vector<EntitySource> ToSources(const std::vector<EntityInput>& inputs) {
  std::vector<EntitySource> sources;
  sources.reserve(inputs.size());
  for (const EntityInput& input : inputs) {
    EntitySource source;
    source.chunks.reserve(input.chunks.size());
    for (const EntityInput::ChunkInput& ci : input.chunks) {
      ChunkSource cs;
      cs.positions = ci.positionsData;
      cs.vertexCount = ci.vertexCount;
      cs.hasIndex = ci.hasIndex;
      cs.index = ci.indexData;
      cs.indexCount = ci.indexCount;
      source.chunks.push_back(cs);
    }
    sources.push_back(std::move(source));
  }
  return sources;
}

/**
 * 阶段 1 的 worker。
 * `groundGrid.values` 必须 pin 到 worker 生命周期结束（Execute 在别的线程里读它）。
 */
class ExtractWorker final : public Napi::AsyncWorker {
 public:
  ExtractWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    params_.minHeight = RequireNumber(env, request.Get("minHeight"), "minHeight");
    params_.radius = RequireNumber(env, request.Get("radius"), "radius");
    if (!(params_.radius > 0.0)) throw Napi::TypeError::New(env, "radius 必须 > 0");

    const Napi::Value gridVal = request.Get("groundGrid");
    if (!gridVal.IsObject()) throw Napi::TypeError::New(env, "groundGrid 必须是对象");
    const Napi::Object gridObj = gridVal.As<Napi::Object>();
    const Napi::Float32Array values = RequireFloat32Array(env, gridObj.Get("values"), "groundGrid.values");
    gridRef_ = Napi::Persistent(values);
    grid_.values = values.Data();
    grid_.cols = static_cast<int>(RequireNumber(env, gridObj.Get("cols"), "groundGrid.cols"));
    grid_.rows = static_cast<int>(RequireNumber(env, gridObj.Get("rows"), "groundGrid.rows"));
    grid_.cellSize = RequireNumber(env, gridObj.Get("cellSize"), "groundGrid.cellSize");
    grid_.originX = RequireNumber(env, gridObj.Get("originX"), "groundGrid.originX");
    grid_.originY = RequireNumber(env, gridObj.Get("originY"), "groundGrid.originY");
    if (grid_.cols <= 0 || grid_.rows <= 0) throw Napi::TypeError::New(env, "groundGrid 尺寸必须为正");
    if (!(grid_.cellSize > 0.0)) throw Napi::TypeError::New(env, "groundGrid.cellSize 必须 > 0");
    if (values.ElementLength() < static_cast<std::size_t>(grid_.cols) * grid_.rows) {
      throw Napi::TypeError::New(env, "groundGrid.values 长度小于 cols * rows");
    }

    const Napi::Value threadsVal = request.Get("threadCount");
    if (threadsVal.IsNumber()) threadCount_ = threadsVal.As<Napi::Number>().Uint32Value();

    entities_ = ParseEntities(env, request);
  }

  void Execute() override {
    const std::vector<EntitySource> sources = ToSources(entities_);
    std::string error;
    if (!powerline::extractCandidates(params_, grid_, sources, result_, error, threadCount_)) {
      SetError(error);  // 池子超上限等：走错误回调，不交半成品
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::EscapableHandleScope scope(env);
    const std::size_t n = entities_.size();
    Napi::Array results = Napi::Array::New(env, n);
    for (std::size_t i = 0; i < n; ++i) {
      const ExtractEntityResult& res = result_.entities[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("entityId", entities_[i].entityId);

      Napi::Array chunks = Napi::Array::New(env, res.chunks.size());
      for (std::size_t c = 0; c < res.chunks.size(); ++c) {
        const std::vector<std::uint32_t>& kept = res.chunks[c].kept;
        Napi::Uint32Array keptJs = Napi::Uint32Array::New(env, kept.size());
        if (!kept.empty()) std::memcpy(keptJs.Data(), kept.data(), kept.size() * sizeof(std::uint32_t));
        Napi::Object chunkObj = Napi::Object::New(env);
        chunkObj.Set("kept", keptJs);
        chunks.Set(static_cast<std::uint32_t>(c), chunkObj);
      }
      item.Set("chunks", chunks);

      Napi::Object features = Napi::Object::New(env);
      const auto setFloats = [&](const char* key, const std::vector<float>& src) {
        Napi::Float32Array arr = Napi::Float32Array::New(env, src.size());
        if (!src.empty()) std::memcpy(arr.Data(), src.data(), src.size() * sizeof(float));
        features.Set(key, arr);
      };
      setFloats("linearity", res.linearity);
      setFloats("verticality", res.verticality);
      setFloats("hag", res.hag);
      Napi::Uint32Array counts = Napi::Uint32Array::New(env, res.neighborCount.size());
      if (!res.neighborCount.empty()) {
        std::memcpy(counts.Data(), res.neighborCount.data(), res.neighborCount.size() * sizeof(std::uint32_t));
      }
      features.Set("neighborCount", counts);
      item.Set("features", features);

      Napi::Object stats = Napi::Object::New(env);
      stats.Set("offGroundCount", Napi::Number::New(env, static_cast<double>(res.offGroundCount)));
      stats.Set("poolCount", Napi::Number::New(env, static_cast<double>(res.poolCount)));
      item.Set("stats", stats);

      results.Set(static_cast<std::uint32_t>(i), item);
    }
    Callback().Call({env.Null(), scope.Escape(results)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  ExtractParams params_;
  GroundGrid grid_;
  Napi::Reference<Napi::Float32Array> gridRef_;  // pin：Execute 在 uv 线程池里读这块内存
  unsigned threadCount_ = 0;
  std::vector<EntityInput> entities_;
  ExtractResult result_;
};

/** 阶段 2 的 worker。 */
class TraceWorker final : public Napi::AsyncWorker {
 public:
  TraceWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    params_.connectRadius = RequireNumber(env, request.Get("connectRadius"), "connectRadius");
    params_.residualTolerance = RequireNumber(env, request.Get("residualTolerance"), "residualTolerance");
    params_.minLinePoints =
        static_cast<std::uint32_t>(RequireNumber(env, request.Get("minLinePoints"), "minLinePoints"));
    params_.minLineLength = RequireNumber(env, request.Get("minLineLength"), "minLineLength");
    params_.gapRadius = RequireNumber(env, request.Get("gapRadius"), "gapRadius");
    params_.gapAngleDeg = RequireNumber(env, request.Get("gapAngleDeg"), "gapAngleDeg");
    params_.dirRadius = RequireNumber(env, request.Get("dirRadius"), "dirRadius");
    if (!(params_.connectRadius > 0.0)) throw Napi::TypeError::New(env, "connectRadius 必须 > 0");
    if (!(params_.residualTolerance > 0.0)) throw Napi::TypeError::New(env, "residualTolerance 必须 > 0");
    if (params_.minLinePoints < 3) throw Napi::TypeError::New(env, "minLinePoints 必须 ≥ 3");

    const Napi::Value threadsVal = request.Get("threadCount");
    if (threadsVal.IsNumber()) threadCount_ = threadsVal.As<Napi::Number>().Uint32Value();

    entities_ = ParseEntities(env, request);
  }

  void Execute() override {
    const std::vector<EntitySource> sources = ToSources(entities_);
    powerline::traceLines(params_, sources, result_, threadCount_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::EscapableHandleScope scope(env);
    const std::size_t n = entities_.size();
    Napi::Array results = Napi::Array::New(env, n);
    for (std::size_t i = 0; i < n; ++i) {
      const TraceEntityResult& res = result_.entities[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("entityId", entities_[i].entityId);

      Napi::Int32Array labelsJs = Napi::Int32Array::New(env, res.labels.size());
      if (!res.labels.empty()) {
        std::memcpy(labelsJs.Data(), res.labels.data(), res.labels.size() * sizeof(std::int32_t));
      }
      item.Set("labels", labelsJs);

      Napi::Array lines = Napi::Array::New(env, res.lines.size());
      for (std::size_t k = 0; k < res.lines.size(); ++k) {
        const TraceLineInfo& line = res.lines[k];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id", line.id);
        obj.Set("pointCount", line.pointCount);
        obj.Set("length", line.length);
        obj.Set("sag", line.sag);
        obj.Set("azimuthDeg", line.azimuthDeg);
        obj.Set("rms", line.rms);
        obj.Set("gapCount", line.gapCount);
        lines.Set(static_cast<std::uint32_t>(k), obj);
      }
      item.Set("lines", lines);

      Napi::Object stats = Napi::Object::New(env);
      stats.Set("candidateTotal", Napi::Number::New(env, static_cast<double>(res.candidateTotal)));
      stats.Set("lineCount", static_cast<std::uint32_t>(res.lines.size()));
      stats.Set("noiseCount", Napi::Number::New(env, static_cast<double>(res.noiseCount)));
      item.Set("stats", stats);

      results.Set(static_cast<std::uint32_t>(i), item);
    }
    Callback().Call({env.Null(), scope.Escape(results)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  TraceParams params_;
  unsigned threadCount_ = 0;
  std::vector<EntityInput> entities_;
  TraceResult result_;
};

Napi::Value ExtractCandidates(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "extractCandidates(request: object, callback: function)");
  }
  auto* worker = new ExtractWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Value TraceLines(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "traceLines(request: object, callback: function)");
  }
  auto* worker = new TraceWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("extractCandidates", Napi::Function::New(env, ExtractCandidates));
  exports.Set("traceLines", Napi::Function::New(env, TraceLines));
  return exports;
}

}  // namespace

NODE_API_MODULE(powerline, Init)
