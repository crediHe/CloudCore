/**
 * euclidean_cluster 的 N-API 绑定壳（node-addon-api）。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/euclideanCluster.ts，**两处必须同步**）：
 *
 *   euclideanCluster.compute(request, callback)
 *     request = {
 *       tolerance: number,         // 聚类距离阈值（与坐标同单位；含等号）
 *       threadCount?: number,      // 可选：0/缺省 = 硬件并发数，1 = 串行（单测钉"线程无关"用）
 *       entities: [{
 *         entityId: number,        // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,   // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,  // 候选顶点下标（带 index 的分割产物必传）
 *         }],
 *       }],
 *     }
 *     callback(err, results)
 *     results = [{
 *       entityId: number,
 *       labels: Int32Array,        // 逐候选（块主序）标签 1..K
 *       clusterSizes: Uint32Array, // clusterSizes[k-1] = 第 k 簇点数
 *     }]
 *
 * 与其余模块的差异：回包不是「顶点缓冲空间的下标数组」，而是**逐候选的标签** +
 * 一份轻量簇大小表（理由：聚类是"每个点归属哪个簇"，不是"挑出一个子集"；
 * 渲染侧要按簇切实体，标签 + 大小表比 K 个下标数组更省一次分配与一次拷贝）。
 * **native 不做 min/max 簇大小过滤**——过滤在渲染侧，改参数不必重算（见 README-REF.md）。
 *
 * 实现要点（同其余 10 个模块）：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内跑纯 C++ 算法（算法内部再开硬件线程并行查询），
 *   全程零拷贝读原始缓冲。
 * - 结果在 OnOK（主线程）组装成 Int32Array / Uint32Array 经回调返回；**不用外部缓冲**
 *   （Electron 沙箱会抛 "External buffers are not allowed"，且异常会让 JS 回调永不触发）。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require，无需 electron-rebuild。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <vector>

#include "euclidean_cluster.h"

namespace {

using euclidean_cluster::ChunkSource;
using euclidean_cluster::ClusterParams;
using euclidean_cluster::EntityResult;
using euclidean_cluster::EntitySource;

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

class ClusterWorker final : public Napi::AsyncWorker {
 public:
  ClusterWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    // ---- 解析输入（主线程）：tolerance / entities ----
    const Napi::Value tolVal = request.Get("tolerance");
    if (!tolVal.IsNumber()) throw Napi::TypeError::New(env, "tolerance 必须是数字");
    params_.tolerance = tolVal.As<Napi::Number>().DoubleValue();

    // threadCount：可选（缺省 0 = 硬件并发数）。生产渲染侧不传——它的存在只为
    // 单测能钉住"结果与线程数无关"（同输入 serial 与多线程逐位相等），顺带留个调优旋钮。
    const Napi::Value threadsVal = request.Get("threadCount");
    if (threadsVal.IsNumber()) {
      threadCount_ = threadsVal.As<Napi::Number>().Uint32Value();
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
    // uv 线程池内：逐实体聚类（算法内部再按硬件线程并行做半径查询）
    results_.reserve(entities_.size());
    for (const EntityInput& input : entities_) {
      EntitySource source;
      source.chunks.reserve(input.chunks.size());
      for (const EntityInput::ChunkInput& ci : input.chunks) {
        ChunkSource cs;
        cs.positions = ci.positionsData;
        cs.vertexCount = ci.vertexCount;
        cs.index = ci.indexData;
        cs.indexCount = ci.indexCount;
        source.chunks.push_back(cs);
      }
      results_.push_back(euclidean_cluster::clusterEntity(source, params_, threadCount_));
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

      const EntityResult& res = results_[i];
      Napi::Int32Array labelsJs = Napi::Int32Array::New(env, res.labels.size());
      if (!res.labels.empty()) {
        std::memcpy(labelsJs.Data(), res.labels.data(), res.labels.size() * sizeof(std::int32_t));
      }
      item.Set("labels", labelsJs);

      Napi::Uint32Array sizesJs = Napi::Uint32Array::New(env, res.clusterSizes.size());
      if (!res.clusterSizes.empty()) {
        std::memcpy(sizesJs.Data(), res.clusterSizes.data(), res.clusterSizes.size() * sizeof(std::uint32_t));
      }
      item.Set("clusterSizes", sizesJs);

      results.Set(static_cast<std::uint32_t>(i), item);
    }
    Callback().Call({env.Null(), scope.Escape(results)});
  }

  void OnError(const Napi::Error& e) override {
    // 算法层异常走 JS 错误回调，不崩进程
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  ClusterParams params_;
  /** 0 = 硬件并发数；1 = 强制串行（单测用，见构造函数的 threadCount 注释）。 */
  unsigned threadCount_ = 0;
  std::vector<EntityInput> entities_;
  std::vector<EntityResult> results_;
};

Napi::Value Compute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "compute(request: object, callback: function)");
  }
  // ClusterWorker 在 Queue() 完成后自毁
  auto* worker = new ClusterWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compute", Napi::Function::New(env, Compute));
  return exports;
}

}  // namespace

NODE_API_MODULE(euclidean_cluster, Init)
