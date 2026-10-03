/**
 * csf_pro（精准地面分割 CSF，液体贴合语义）的 N-API 绑定壳（node-addon-api）。
 * 语义取向：老算法逐式移植（布料垂坠贴身，丘陵/山脉高精度，收敛慢）；
 * 机载/平坦地形的快速版见 native/csf-lidar。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/csfPro.ts）：
 *
 *   csf_pro.compute(request, onProgress, callback)
 *     request = {
 *       clothResolution: number,   // 布料网格间距（与坐标同单位）
 *       rigidness: number,         // 布料刚性 1..3
 *       iterations: number,        // 最大迭代次数（默认 500）
 *       timeStep: number,          // 时间步（默认 0.65；重力每轮 = timeStep×0.65）
 *       classThreshold: number,    // 分类阈值（默认 0.4）
 *       convergenceEps: number,    // 收敛阈值下限（默认 1e-3；实际容差 = max(该值, 布料分辨率×0.15)）
 *       entities: [{
 *         entityId: number,        // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,   // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,  // 候选顶点下标（带 index 的分割产物必传）
 *         }],
 *       }],
 *     }
 *     onProgress(p)                 // 主线程节流前每轮调用（AsyncProgressWorker）
 *     p = { overall: number 0..1,  // 整体进度 = (实体序 + 迭代/最大迭代) / 实体数
 *           iteration: number,     // 当前实体已完成迭代数（1 起）
 *           entity: number,        // 当前实体序（1 起）
 *           entityTotal: number }  // 实体总数
 *     callback(err, results)
 *     results = [{ entityId, ground: Uint32Array[] }]  // ground[c] = 第 c 块地面顶点下标
 *
 * 语义：布料覆盖实体全部候选点的水平范围（与块切分无关）；分类只覆盖候选点。
 * 非地面 = 候选全集补集，渲染侧用 splitKeptRemoved 同款归并推导。
 *
 * 实现要点：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   Execute 在 uv 线程池内跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - 进度：AsyncProgressWorker 每轮迭代 Send；OnProgress（主线程）转发 JS onProgress。
 * - 取消：模块级"当前活跃 worker"注册表（mutex），导出 cancel() 置位 atomic 标志，
 *   算法每轮检查后抛"已取消"走错误回调——旧任务被新 compute 顶替时也先请退。
 * - 结果 ground 在 OnOK（主线程）组装成 Uint32Array 经回调返回。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require。
 */
#include <napi.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "csf_pro.h"

namespace {

using csfpro::ChunkSource;
using csfpro::ClassifyParams;
using csfpro::EntityResult;
using csfpro::EntitySource;

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

/** 进度载荷：每轮迭代 Send 一次（uv_async 合并丢中间值可接受，最终值必达）。 */
struct ProgressPayload {
  double overall = 0;        // 整体进度 0..1
  std::int32_t iteration = 0;   // 当前实体已完成迭代（1 起）
  std::int32_t entity = 0;      // 当前实体序（1 起）
  std::int32_t entityTotal = 0;
};

// ---- 活跃 worker 注册表（compute/cancel/析构三方互斥，单实例场景够用） ----
std::mutex g_mutex;
class CsfProWorker;
CsfProWorker* g_active = nullptr;  // 仅 g_mutex 保护

class CsfProWorker final : public Napi::AsyncProgressWorker<ProgressPayload> {
 public:
  CsfProWorker(Napi::Env env, Napi::Object request, Napi::Function onProgress,
               Napi::Function callback)
      : Napi::AsyncProgressWorker<ProgressPayload>(callback), progressFn_(Napi::Persistent(onProgress)) {
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
    params_.convergenceEps = numField("convergenceEps");

    // ---- 解析实体（主线程，与 csf-lidar 壳同一套）----
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

  ~CsfProWorker() override {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_active == this) g_active = nullptr;
  }

  /** 请求取消（compute/cancel 在 JS 主线程调用，Execute 线程每轮查询）。 */
  void RequestCancel() { cancelled_.store(true, std::memory_order_relaxed); }

  void Execute(const ExecutionProgress& progress) override {
    if (cancelled_.load(std::memory_order_relaxed)) {
      throw std::runtime_error("已取消：分割任务被中止");
    }
    results_.reserve(entities_.size());
    const int entityTotal = (int)entities_.size();
    for (int e = 0; e < entityTotal; ++e) {
      const EntityInput& input = entities_[e];
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
      // 每轮迭代回报进度；overall = 实体粒度均分 × 当前实体迭代占比（收敛常提前停）
      const auto onIteration = [&](int iteration) {
        ProgressPayload p;
        p.overall = ((double)e + (double)iteration / (double)params_.iterations) / (double)entityTotal;
        p.iteration = iteration;
        p.entity = e + 1;
        p.entityTotal = entityTotal;
        progress.Send(&p, sizeof(p));
      };
      results_.push_back(csfpro::classifyEntity(source, params_, cancelled_, onIteration));
    }
  }

  void OnProgress(const ProgressPayload* data, size_t /*size*/) override {
    // 主线程：每收到一次 Send 转发 JS（uv_async 合并丢中间值，渲染侧无需精确）
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (progressFn_.IsEmpty() || data == nullptr) return;
    Napi::Object p = Napi::Object::New(env);
    p.Set("overall", data->overall);
    p.Set("iteration", data->iteration);
    p.Set("entity", data->entity);
    p.Set("entityTotal", data->entityTotal);
    progressFn_.Call({p});
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
    // 算法层异常（取消 / 布料粒子超上限）走 JS 错误回调，不崩进程
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  ClassifyParams params_;
  std::vector<EntityInput> entities_;
  std::vector<EntityResult> results_;
  Napi::FunctionReference progressFn_;
  std::atomic<bool> cancelled_{false};
};

Napi::Value Compute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsFunction() || !info[2].IsFunction()) {
    throw Napi::TypeError::New(env, "compute(request: object, onProgress: function, callback: function)");
  }
  auto* worker = new CsfProWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>(),
                                  info[2].As<Napi::Function>());
  {
    // 顶替可能仍在跑的旧任务（单模态场景：新 compute 到来说明旧结果已被弃用）
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_active != nullptr) g_active->RequestCancel();
    g_active = worker;
  }
  // CsfProWorker 在 Queue() 完成后自毁
  worker->Queue();
  return env.Undefined();
}

/** 取消当前活跃分割（幂等；无活跃任务时 no-op）。 */
Napi::Value Cancel(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_active != nullptr) g_active->RequestCancel();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compute", Napi::Function::New(env, Compute));
  exports.Set("cancel", Napi::Function::New(env, Cancel));
  return exports;
}

}  // namespace

NODE_API_MODULE(csf_pro, Init)
