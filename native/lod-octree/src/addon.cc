/**
 * lod_octree 的 N-API 绑定壳（node-addon-api）。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/lodOctree.ts，**两处必须同步**）：
 *
 *   lod_octree.compute(request, onProgress, callback)
 *     request = {
 *       maxPointsPerCell?: number,  // 细分阈值，默认 256
 *       maxLevel?: number,          // 深度上限，默认 12（硬上限 24）
 *       entities: [{
 *         entityId: number,         // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,   // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,  // 候选顶点下标（带 index 的分割产物必传）
 *         }],
 *       }],
 *     }
 *     onProgress(p)                 // 主线程节流前按层调用（AsyncProgressWorker）
 *     p = { overall: number 0..1,   // 整体进度 = (实体序 + 实体内层级进度) / 实体数
 *           entity: number,         // 当前实体序（1 起）
 *           entityTotal: number,
 *           level: number }         // 刚完成的层号（0 起）
 *     callback(err, results)
 *     results = [{
 *       entityId: number,
 *       nodeCount: number,            // 0 = 该实体没有可建树的点（渲染侧跳过 LOD）
 *       pointCount: number,           // 树内点数（可能小于候选总数：非有限坐标已剔除）
 *       chunkBits: number,            // id = (chunk << vertexShift) | vertexIndex
 *       vertexShift: number,
 *       bounds: Float32Array,         // 6 个：minX,minY,minZ,maxX,maxY,maxZ
 *       nodeChildBase: Uint32Array,   // 以下节点表等长（= nodeCount），层序排列、子节点连续
 *       nodeChildMask: Uint8Array,    // bit k = 第 k 个卦限有子节点；0 = 叶子
 *       nodePointStart: Uint32Array,  // pointIds 中的起始下标
 *       nodePointCount: Uint32Array,  // 本节点（子树）的点数
 *       nodeCenter: Float32Array,     // 3×nodeCount，节点立方体几何中心
 *       nodeSize: Float32Array,       // 节点立方体边长
 *       nodeLevel: Uint8Array,
 *       pointIds: Uint32Array,        // 打包 id（顶点缓冲空间），块主序 + 子树连续
 *     }]
 *
 * 实现要点：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   Execute 在 uv 线程池内跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - **结果拷一份进 V8 内存**（见 CopyVector）：渲染进程的 V8 拒绝外部 ArrayBuffer，
 *   零拷贝交接在 Electron 里行不通。1 亿点的 pointIds 是 400 MB，这一次 memcpy
 *   发生在建树末尾的 OnOK 上（主线程，数十毫秒），可接受。
 * - 进度：AsyncProgressWorker 按层 Send；OnProgress（主线程）转发 JS onProgress。
 * - OnOK 内部异常一律转成错误回调：node-addon-api 会把它变成"未捕获 JS 异常"，
 *   调用方会永久收不到回调（这个坑踩过一次，见 CopyVector 注释）。
 * - 取消：模块级"当前活跃 worker"注册表（mutex），导出 cancel() 置位 atomic 标志，
 *   算法逐层与每 2^20 点检查后抛"已取消"走错误回调——旧任务被新 compute 顶替时也先请退。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require。
 */
#include <napi.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "lod_octree.h"

namespace {

using lod_octree::BuildParams;
using lod_octree::ChunkSource;
using lod_octree::EntityResult;
using lod_octree::EntitySource;

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

/** 取可选的正整数参数（undefined / null 用默认值）。 */
std::uint32_t OptionalUint32(Napi::Env env, Napi::Object request, const char* key, std::uint32_t fallback) {
  const Napi::Value value = request.Get(key);
  if (value.IsUndefined() || value.IsNull()) return fallback;
  if (!value.IsNumber()) throw Napi::TypeError::New(env, std::string(key) + " 必须是数字");
  const double raw = value.As<Napi::Number>().DoubleValue();
  if (!(raw > 0)) return fallback;
  return raw > 4294967295.0 ? fallback : static_cast<std::uint32_t>(raw);
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

/** 进度载荷：每完成一层 Send 一次（uv_async 合并丢中间值可接受，最终值必达）。 */
struct ProgressPayload {
  double overall = 0;            // 整体进度 0..1
  std::int32_t entity = 0;       // 当前实体序（1 起）
  std::int32_t entityTotal = 0;
  std::uint32_t level = 0;       // 刚完成的层号
};

/**
 * 把 vector 的内容拷进 **V8 自己分配**的 TypedArray（与其他 6 个模块的返回方式一致）。
 *
 * 曾经写成"零拷贝交接"（`Napi::ArrayBuffer::New(env, data, len, finalizer, hint)` 交出
 * vector 的存储），在 Node 里一切正常，但在 **Electron 渲染进程**里必挂：
 * `napi_create_external_arraybuffer` 底下是 `v8::ArrayBuffer::New(isolate, external_data, …)`，
 * 而渲染进程的 V8 带 sandbox，直接抛 "External buffers are not allowed"。
 * 更隐蔽的是失败形态——异常从 OnOK 抛进 node-addon-api 的 WrapCallback 后变成
 * **未捕获的 JS 异常**，JS 回调既不成功也不报错，调用方永久挂起（见 OnOK 的兜底）。
 *
 * 代价：pointIds（4 B/点）在 OnOK（主线程）多一次 memcpy + 瞬时双份内存，
 * 1 亿点 ≈ 400 MB / 数十毫秒，且只发生在建树这一非热路径上——换稳定值得。
 */
template <typename T>
Napi::TypedArrayOf<T> CopyVector(Napi::Env env, std::vector<T>&& values) {
  const std::size_t length = values.size();
  Napi::TypedArrayOf<T> out = Napi::TypedArrayOf<T>::New(env, length);
  if (length > 0) {
    std::memcpy(out.Data(), values.data(), length * sizeof(T));
  }
  return out;  // values 在此析构，C++ 侧存储随即归还
}

// ---- 活跃 worker 注册表（compute/cancel/析构三方互斥，单实例场景够用） ----
std::mutex g_mutex;
class LodOctreeWorker;
LodOctreeWorker* g_active = nullptr;  // 仅 g_mutex 保护

class LodOctreeWorker final : public Napi::AsyncProgressWorker<ProgressPayload> {
 public:
  LodOctreeWorker(Napi::Env env, Napi::Object request, Napi::Function onProgress,
                  Napi::Function callback)
      : Napi::AsyncProgressWorker<ProgressPayload>(callback), progressFn_(Napi::Persistent(onProgress)) {
    params_.maxPointsPerCell = OptionalUint32(env, request, "maxPointsPerCell", 256);
    params_.maxLevel = OptionalUint32(env, request, "maxLevel", 12);

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

  ~LodOctreeWorker() override {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_active == this) g_active = nullptr;
  }

  /** 请求取消（compute/cancel 在 JS 主线程调用，Execute 线程逐层查询）。 */
  void RequestCancel() { cancelled_.store(true, std::memory_order_relaxed); }

  void Execute(const ExecutionProgress& progress) override {
    results_.reserve(entities_.size());
    const std::uint32_t entityTotal = static_cast<std::uint32_t>(entities_.size());
    for (std::uint32_t e = 0; e < entityTotal; ++e) {
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
      // 实体内进度按层回报；overall = 实体粒度均分 × 实体内占比（树提前收敛则最后一跳到位）
      const auto onLevel = [&](double localProgress, std::uint32_t level) {
        ProgressPayload payload;
        payload.overall = (static_cast<double>(e) + localProgress) / static_cast<double>(entityTotal);
        payload.entity = static_cast<std::int32_t>(e + 1);
        payload.entityTotal = static_cast<std::int32_t>(entityTotal);
        payload.level = level;
        progress.Send(&payload, sizeof(payload));
      };
      results_.push_back(
          lod_octree::buildEntity(source, input.entityId, params_, cancelled_, onLevel));
    }
  }

  void OnProgress(const ProgressPayload* data, size_t /*size*/) override {
    // 主线程：每收到一次 Send 转发 JS（uv_async 合并丢中间值，渲染侧无需精确）
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (progressFn_.IsEmpty() || data == nullptr) return;
    Napi::Object payload = Napi::Object::New(env);
    payload.Set("overall", data->overall);
    payload.Set("entity", data->entity);
    payload.Set("entityTotal", data->entityTotal);
    payload.Set("level", data->level);
    progressFn_.Call({payload});
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    // OnOK 里抛出的 Napi::Error 会被 node-addon-api 的 WrapCallback 转成"未捕获的 JS
    // 异常"抛出，而**不是**走 JS 回调——调用方永远等不到回调（静默挂死）。这里自己兜住
    // 并转成错误回调：渲染侧至少能看到原因（Electron 渲染进程拒绝外部 ArrayBuffer 就是
    // 踩过的一次，见 CopyVector 的注释）。
    const std::size_t n = results_.size();
    Napi::Array results = Napi::Array::New(env, n);
    try {
      FillResults(env, results);
    } catch (const Napi::Error& e) {
      Callback().Call({Napi::Error::New(env, e.Message()).Value(), env.Null()});
      return;
    }
    Callback().Call({env.Null(), results});
  }

  /** 组装结果对象数组（失败时抛 Napi::Error，由 OnOK 兜住转成错误回调）。 */
  void FillResults(Napi::Env env, Napi::Array results) {
    for (std::size_t i = 0; i < results_.size(); ++i) {
      EntityResult& r = results_[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("entityId", r.entityId);
      item.Set("nodeCount", r.nodeCount);
      item.Set("pointCount", r.pointCount);
      item.Set("chunkBits", r.chunkBits);
      item.Set("vertexShift", r.vertexShift);
      Napi::Float32Array bounds = Napi::Float32Array::New(env, 6);
      std::memcpy(bounds.Data(), r.bounds, sizeof(r.bounds));
      item.Set("bounds", bounds);
      // 各数组拷进 V8 分配的内存后即释放 C++ 侧存储（见 CopyVector）
      item.Set("nodeChildBase", CopyVector(env, std::move(r.nodeChildBase)));
      item.Set("nodeChildMask", CopyVector(env, std::move(r.nodeChildMask)));
      item.Set("nodePointStart", CopyVector(env, std::move(r.nodePointStart)));
      item.Set("nodePointCount", CopyVector(env, std::move(r.nodePointCount)));
      item.Set("nodeCenter", CopyVector(env, std::move(r.nodeCenter)));
      item.Set("nodeSize", CopyVector(env, std::move(r.nodeSize)));
      item.Set("nodeLevel", CopyVector(env, std::move(r.nodeLevel)));
      item.Set("pointIds", CopyVector(env, std::move(r.pointIds)));
      results.Set(static_cast<std::uint32_t>(i), item);
    }
  }

  void OnError(const Napi::Error& e) override {
    // 算法层异常（取消 / 打包位宽不足 / 内存不足）走 JS 错误回调，不崩进程
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  BuildParams params_;
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
  auto* worker = new LodOctreeWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>(),
                                     info[2].As<Napi::Function>());
  {
    // 顶替可能仍在跑的旧任务（单模态场景：新 compute 到来说明旧结果已被弃用）
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_active != nullptr) g_active->RequestCancel();
    g_active = worker;
  }
  // LodOctreeWorker 在 Queue() 完成后自毁
  worker->Queue();
  return env.Undefined();
}

/** 取消当前活跃建树（幂等；无活跃任务时 no-op）。 */
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

NODE_API_MODULE(lod_octree, Init)
