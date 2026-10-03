/**
 * TreeIso 单木分割的 N-API 绑定壳（node-addon-api）。
 * 算法主体见 treeiso.cc（对照 CloudCompare qTreeIso 插件行为自行实现，
 * 参考论文 Xi & Hopkinson 2022；许可与差异说明见 README-REF.md）。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/treeIso.ts，两处同步维护）：
 *
 *   treeiso.compute(request, callback)
 *     request = {
 *       params: {
 *         decimateRes1: number,          // Init：体素抽稀分辨率（m）
 *         minNN1: number,                // Init：kNN 查询数（含自身）
 *         regStrength1: number,          // Init：图割边权乘子 λ1
 *         decimateRes2: number,          // Intermediate：簇内抽稀分辨率（m）
 *         minNN2: number,                // Intermediate：质心/观测 kNN 查询数
 *         maxGap: number,                // Intermediate：簇间连边最大空隙（平方距离 m²）
 *         regStrength2: number,          // Intermediate：边权乘子 λ2
 *         minNN3: number,                // Final：组级 kNN 查询数
 *         relHeightLengthRatio: number,  // Final：相对高度阈值
 *         verticalWeight: number,        // Final：垂直重叠打分权重
 *       },
 *       entities: [{
 *         entityId: number,        // 透传回结果，用于渲染侧核对
 *         chunks: [{
 *           positions: Float32Array,   // 块内全量顶点坐标（3 float/点，显示坐标）
 *           index?: Uint32Array|null,  // 候选顶点下标（无 index 块 = 全量顶点）
 *         }],
 *       }],
 *     }
 *     callback(err, results)
 *     results = [{ entityId, labels: Int32Array }]
 *
 * 语义：
 * - labels 与候选全集的「块主序」一一对应（候选 = 各块按序拼接：块带 index 时
 *   取 index 条目、否则取全量顶点；渲染侧自行按块候选数切回逐块标签）。
 * - labels 值为 1..K（K = 最终树木组件数；与 CloudCompare final_segs 值域
 *   一致，便于同云逐点对照）；输入假设已去除地面（CSF 之后）。
 * - 「点数过少归拢残点（-1）」是渲染侧按 minPoints 的纯函数策略，本层
 *   输出的都是真实组件。
 * - 算法需要跨块全局一致（抽稀/图割以全部候选为单位），与 csf 逐块局部
 *   语义不同：输入块在 Execute 内拼接为连续坐标缓冲后统一计算。
 *
 * 实现要点（与 csf_lidar 壳一致）：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference
 *   pin 防 GC；AsyncWorker::Execute 在 uv 线程池内跑 concat + 纯 C++ 算法，
 *   不阻塞 UI 线程。
 * - 结果 labels 在 OnOK（主线程）组装成 Int32Array 经回调返回。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "treeiso.h"

namespace {

using treeiso::TreeIsoCloud;
using treeiso::TreeIsoParams;

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

/** 单个输入实体（含解析后的裸指针与 GC pin；数据在 Execute 内才被读取）。 */
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

/** 逐实体解析数字参数（校验存在且为 number）。 */
TreeIsoParams ParseParams(Napi::Env env, Napi::Object paramsObj) {
  const auto numField = [&](const char* key) {
    const Napi::Value v = paramsObj.Get(key);
    if (!v.IsNumber()) throw Napi::TypeError::New(env, std::string(key) + " 必须是数字");
    return v.As<Napi::Number>().DoubleValue();
  };
  const auto uintField = [&](const char* key) {
    const Napi::Value v = paramsObj.Get(key);
    if (!v.IsNumber()) throw Napi::TypeError::New(env, std::string(key) + " 必须是数字");
    return v.As<Napi::Number>().Uint32Value();
  };
  TreeIsoParams p;
  p.decimateRes1 = static_cast<float>(numField("decimateRes1"));
  p.minNN1 = uintField("minNN1");
  p.regStrength1 = static_cast<float>(numField("regStrength1"));
  p.decimateRes2 = static_cast<float>(numField("decimateRes2"));
  p.minNN2 = uintField("minNN2");
  p.maxGap = static_cast<float>(numField("maxGap"));
  p.regStrength2 = static_cast<float>(numField("regStrength2"));
  p.minNN3 = uintField("minNN3");
  p.relHeightLengthRatio = static_cast<float>(numField("relHeightLengthRatio"));
  p.verticalWeight = static_cast<float>(numField("verticalWeight"));
  return p;
}

class TreeIsoWorker final : public Napi::AsyncWorker {
 public:
  TreeIsoWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    // ---- 解析参数（主线程）----
    const Napi::Value paramsVal = request.Get("params");
    if (!paramsVal.IsObject()) throw Napi::TypeError::New(env, "params 必须是对象");
    params_ = ParseParams(env, paramsVal.As<Napi::Object>());

    // ---- 解析实体（主线程；只 pin 引用，不拷贝）----
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
    // uv 线程池内：逐实体拼接候选坐标 → 统一三阶段分割
    results_.reserve(entities_.size());
    for (const EntityInput& input : entities_) {
      // 候选总数 = Σ 块（带 index 取条目数，否则全量顶点数）
      std::size_t candTotal = 0;
      for (const EntityInput::ChunkInput& ci : input.chunks) {
        candTotal += ci.indexCount > 0 ? ci.indexCount : ci.vertexCount;
      }
      bool badIndex = false;
      if (candTotal > 0) {
        // 先预检 index 越界（非法 → 整实体作废：空 labels，渲染侧以空感知）
        for (const EntityInput::ChunkInput& ci : input.chunks) {
          if (ci.indexCount > 0) {
            for (std::uint32_t k = 0; k < ci.indexCount; ++k) {
              if (ci.indexData[k] >= ci.vertexCount) {
                badIndex = true;
                break;
              }
            }
            if (badIndex) break;
          }
        }
      }
      std::vector<std::int32_t> labels;
      if (candTotal > 0 && !badIndex) {
        // 连续候选坐标（候选主序 = 块序拼接；算法需跨块一致，见头注释）
        std::vector<float> cand;
        cand.reserve(candTotal * 3);
        for (const EntityInput::ChunkInput& ci : input.chunks) {
          if (ci.indexCount > 0) {
            for (std::uint32_t k = 0; k < ci.indexCount; ++k) {
              const std::uint32_t v = ci.indexData[k];
              const float* p3 = ci.positionsData + static_cast<std::size_t>(v) * 3;
              cand.push_back(p3[0]);
              cand.push_back(p3[1]);
              cand.push_back(p3[2]);
            }
          } else {
            cand.insert(cand.end(), ci.positionsData,
                        ci.positionsData + static_cast<std::size_t>(ci.vertexCount) * 3);
          }
        }
        TreeIsoCloud cloud;
        cloud.positions = std::move(cand);
        labels = treeiso::treeIsoSegment(cloud, params_);
      }
      results_.push_back(std::move(labels));
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

      const std::vector<std::int32_t>& labels = results_[i];
      Napi::Int32Array labelsJs = Napi::Int32Array::New(env, labels.size());
      if (!labels.empty()) {
        std::memcpy(labelsJs.Data(), labels.data(), labels.size() * sizeof(std::int32_t));
      }
      item.Set("labels", labelsJs);
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
  TreeIsoParams params_;
  std::vector<EntityInput> entities_;
  std::vector<std::vector<std::int32_t>> results_;
};

Napi::Value Compute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "compute(request: object, callback: function)");
  }
  // TreeIsoWorker 在 Queue() 完成后自毁
  auto* worker = new TreeIsoWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compute", Napi::Function::New(env, Compute));
  return exports;
}

}  // namespace

NODE_API_MODULE(treeiso, Init)
