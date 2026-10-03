/**
 * registration 的 N-API 绑定壳（node-addon-api）。
 *
 * 对外契约（渲染侧 TS 镜像见 src/renderer/utils/registration.ts，**两处必须同步**）：
 *
 *   registration.findAbsoluteOrientation(request, callback)      —— 点对粗配准
 *     request = {
 *       aligned:   Float64Array,   // 3N，待对齐点（显示坐标）
 *       reference: Float64Array,   // 3N，参考点（同名点，与 aligned 一一对应）
 *       adjustScale: boolean,      // 是否估计缩放（缺省 false ⇒ s 恒 1）
 *       filters: number,           // TRANSFORMATION_FILTERS 位掩码；缺省 0 = 不过滤
 *     }
 *     callback(err, result)
 *     result = {
 *       ok: boolean,               // false = 退化（点数不等 / < 3 / 三点共线 / 面内旋转不确定）
 *       r: Float64Array,           // 9，行主序 R（**行主序**，与 three 的 Matrix4.set 入参同序）
 *       t: Float64Array,           // 3
 *       s: number,
 *       rValid: boolean,           // false = 解算走了"只平移"的退化路径（r 此时是单位矩阵）
 *       rms: number,               // 过滤后的最终变换下的 RMS；ok = false 时 -1
 *       distances: Float64Array,   // N，逐对距离
 *       deltas: Float64Array,      // 3N，逐对 (X,Y,Z) 偏差 = 参考点 − 变换后的待对齐点
 *     }
 *
 *   registration.icp(request, callback)                          —— ICP 精配准
 *     request = {
 *       data:  { chunks: [{ positions: Float32Array, index?: Uint32Array|null }] },  // 待配准（会动）
 *       model: { chunks: [{ positions: Float32Array, index?: Uint32Array|null }] },  // 参考（不动）
 *       params: {                                                                     // 全部可选，缺省同 CC
 *         maxIterations, minRMSDecrease, samplingLimit, finalOverlapRatio,
 *         adjustScale, minScale, maxScale, filterOutFarthestPoints,
 *         transformationFilters, seed,
 *       },
 *     }
 *     callback(err, result)
 *     result = { result, rms, initialRms, pointCount, iterations, r, t, s, rValid }
 *     // result = ICPRegistrationTools::RESULT_TYPE 数值（0 不必做 / 1 应施加变换 / ≥100 出错）
 *
 *   registration.gicp(request, callback)                         —— GICP 精配准
 *     request = {
 *       data:  { chunks: [...] },   // 待配准（会动）
 *       model: { chunks: [...] },   // 参考（不动）
 *       params: {                                                                     // 全部可选，缺省同 ICP
 *         maxIterations, minRMSDecrease, samplingLimit, finalOverlapRatio,
 *         filterOutFarthestPoints, transformationFilters, seed,
 *         correspondenceRandomness,  // 协方差 PCA 的近邻个数（PCL setCorrespondenceRandomness，默认 20）
 *         useNormalCovariance,       // 是否做平面化正则化（特征值 → diag(ε,1,1)）；默认 true
 *       },
 *     }
 *     callback(err, result)
 *     result = { result, rms, initialRms, pointCount, iterations, covarianceError, r, t, s, rValid }
 *     // result = registration::GicpResultCode 数值（与 icp 同位）；
 *     // rms / initialRms 是**点到点** RMS（与 ICP 的同一量，可横向比较），马氏权重只进解算；
 *     // covarianceError = 最终变换下逐点马氏距离的 RMS（无量纲，只作参考）
 *
 * 实现要点（同其余 11 个模块）：
 * - 输入 TypedArray 在构造阶段（主线程）解析出裸指针并用 Napi::Reference pin 防 GC；
 *   AsyncWorker::Execute 在 uv 线程池内跑纯 C++ 算法，全程零拷贝读原始缓冲。
 * - 结果在 OnOK（主线程）组装成 TypedArray 经回调返回；**不用外部缓冲**
 *   （Electron 沙箱会抛 "External buffers are not allowed"，且异常会让 JS 回调永不触发）。
 * - 编译为 N-API（ABI 稳定）：同一产物可被 Node 与 Electron 直接 require，无需 electron-rebuild。
 * - 三个导出（同 normal-estimate 的先例）：三者共用 Jacobi / RegistrationProcedure / KD 树 / 过滤器，
 *   合成一个模块比拆三个省两次编译与两份重复代码。
 */
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "registration.h"

namespace {

using registration::ChunkSource;
using registration::IcpOutput;
using registration::IcpParams;
using registration::Mat3d;
using registration::OrientationParams;
using registration::OrientationResult;
using registration::Transform;
using registration::Vec3d;

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

/** 校验并取 Float64Array（点对坐标只有几十个点，用 double 传比 float 省一次精度让步）。 */
Napi::Float64Array RequireFloat64Array(Napi::Env env, Napi::Value value, const char* what) {
  if (!value.IsTypedArray()) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是 TypedArray");
  }
  if (value.As<Napi::TypedArray>().TypedArrayType() != napi_float64_array) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是 Float64Array");
  }
  return value.As<Napi::Float64Array>();
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

/** 取可选数字（缺失或非数字时用 fallback）。 */
double OptionalNumber(const Napi::Object& obj, const char* key, double fallback) {
  const Napi::Value value = obj.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
}

/** 取可选布尔（缺失或非布尔时用 fallback）。 */
bool OptionalBoolean(const Napi::Object& obj, const char* key, bool fallback) {
  const Napi::Value value = obj.Get(key);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

/** 取可选的无符号整数，负值/NaN 归 0。 */
std::uint32_t OptionalUint32(const Napi::Object& obj, const char* key, std::uint32_t fallback) {
  const Napi::Value value = obj.Get(key);
  if (!value.IsNumber()) return fallback;
  const double number = value.As<Napi::Number>().DoubleValue();
  if (!(number > 0.0)) return 0;  // 同时挡掉 NaN
  return static_cast<std::uint32_t>(number);
}

/** 一个点云（多块）的输入：解析后的裸指针 + GC pin。 */
struct CloudInput {
  struct ChunkInput {
    Napi::Reference<Napi::Float32Array> positionsRef;
    const float* positionsData = nullptr;
    std::uint32_t vertexCount = 0;  // 坐标点数（elementLength / 3）
    Napi::Reference<Napi::Uint32Array> indexRef;  // 空引用 = 无 index
    const std::uint32_t* indexData = nullptr;
    std::uint32_t indexCount = 0;
  };
  std::vector<ChunkInput> chunks;

  /** 摊成算法层的候选源表（Execute 里调）。 */
  std::vector<ChunkSource> toSources() const {
    std::vector<ChunkSource> sources;
    sources.reserve(chunks.size());
    for (const ChunkInput& ci : chunks) {
      ChunkSource cs;
      cs.positions = ci.positionsData;
      cs.vertexCount = ci.vertexCount;
      cs.index = ci.indexData;
      cs.indexCount = ci.indexCount;
      sources.push_back(cs);
    }
    return sources;
  }
};

/** 解析 `{ chunks: [...] }` 形态的点云入参。 */
CloudInput ParseCloud(Napi::Env env, Napi::Value value, const char* what) {
  CloudInput cloud;
  if (!value.IsObject()) {
    throw Napi::TypeError::New(env, std::string(what) + " 必须是对象");
  }
  const Napi::Value chunksVal = value.As<Napi::Object>().Get("chunks");
  if (!chunksVal.IsArray()) {
    throw Napi::TypeError::New(env, std::string(what) + ".chunks 必须是数组");
  }
  const Napi::Array chunks = chunksVal.As<Napi::Array>();
  const std::uint32_t chunkCount = chunks.Length();
  cloud.chunks.reserve(chunkCount);
  for (std::uint32_t c = 0; c < chunkCount; ++c) {
    const Napi::Value chunkVal = chunks.Get(c);
    if (!chunkVal.IsObject()) {
      throw Napi::TypeError::New(env, std::string(what) + ".chunks 元素必须是对象");
    }
    const Napi::Object chunk = chunkVal.As<Napi::Object>();

    CloudInput::ChunkInput ci;
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
    cloud.chunks.push_back(std::move(ci));
  }
  return cloud;
}

/** 把变换写进回包（R 无效时发单位矩阵 + rValid = false，**不发零矩阵**）。 */
void WriteTransform(Napi::Env env, Napi::Object target, const Transform& trans) {
  Napi::Float64Array r = Napi::Float64Array::New(env, 9);
  double* out = r.Data();
  if (trans.rValid) {
    for (int i = 0; i < 3; ++i) {
      for (int j = 0; j < 3; ++j) out[i * 3 + j] = trans.R.m[i][j];
    }
  } else {
    for (int i = 0; i < 9; ++i) out[i] = (i % 4 == 0) ? 1.0 : 0.0;
  }
  target.Set("r", r);

  Napi::Float64Array t = Napi::Float64Array::New(env, 3);
  t.Data()[0] = trans.T.x;
  t.Data()[1] = trans.T.y;
  t.Data()[2] = trans.T.z;
  target.Set("t", t);

  target.Set("s", trans.s);
  target.Set("rValid", trans.rValid);
}

// ---------------------------------------------------------------------------
// 导出 1：findAbsoluteOrientation（点对粗配准）
// ---------------------------------------------------------------------------

class OrientationWorker final : public Napi::AsyncWorker {
 public:
  OrientationWorker(Napi::Env env, Napi::Object request, Napi::Function callback)
      : Napi::AsyncWorker(callback) {
    const Napi::Float64Array aligned = RequireFloat64Array(env, request.Get("aligned"), "aligned");
    if (aligned.ElementLength() % 3 != 0) {
      throw Napi::TypeError::New(env, "aligned 长度必须是 3 的倍数");
    }
    const Napi::Float64Array reference = RequireFloat64Array(env, request.Get("reference"), "reference");
    if (reference.ElementLength() % 3 != 0) {
      throw Napi::TypeError::New(env, "reference 长度必须是 3 的倍数");
    }
    if (aligned.ElementLength() != reference.ElementLength()) {
      throw Napi::TypeError::New(env, "aligned 与 reference 长度必须相等（同名点一一对应）");
    }

    alignedRef_ = Napi::Persistent(aligned);
    alignedData_ = aligned.Data();
    referenceRef_ = Napi::Persistent(reference);
    referenceData_ = reference.Data();
    pointCount_ = aligned.ElementLength() / 3;

    params_.adjustScale = OptionalBoolean(request, "adjustScale", false);
    const double filters = OptionalNumber(request, "filters", 0.0);
    params_.filters = static_cast<int>(filters);
  }

  void Execute() override {
    // uv 线程池内：摊成 Vec3d 后跑纯 C++ 算法（几十个点，微秒级）
    std::vector<Vec3d> aligned;
    std::vector<Vec3d> reference;
    aligned.reserve(pointCount_);
    reference.reserve(pointCount_);
    for (std::uint32_t i = 0; i < pointCount_; ++i) {
      aligned.push_back(Vec3d{alignedData_[i * 3], alignedData_[i * 3 + 1], alignedData_[i * 3 + 2]});
      reference.push_back(Vec3d{referenceData_[i * 3], referenceData_[i * 3 + 1], referenceData_[i * 3 + 2]});
    }
    result_ = registration::findAbsoluteOrientation(aligned, reference, params_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::EscapableHandleScope scope(env);
    Napi::Object out = Napi::Object::New(env);
    out.Set("ok", result_.ok);
    WriteTransform(env, out, result_.trans);
    out.Set("rms", result_.rms);

    Napi::Float64Array distances = Napi::Float64Array::New(env, result_.distances.size());
    if (!result_.distances.empty()) {
      std::memcpy(distances.Data(), result_.distances.data(), result_.distances.size() * sizeof(double));
    }
    out.Set("distances", distances);

    Napi::Float64Array deltas = Napi::Float64Array::New(env, result_.deltas.size());
    if (!result_.deltas.empty()) {
      std::memcpy(deltas.Data(), result_.deltas.data(), result_.deltas.size() * sizeof(double));
    }
    out.Set("deltas", deltas);

    Callback().Call({env.Null(), scope.Escape(out)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  Napi::Reference<Napi::Float64Array> alignedRef_;
  const double* alignedData_ = nullptr;
  Napi::Reference<Napi::Float64Array> referenceRef_;
  const double* referenceData_ = nullptr;
  std::uint32_t pointCount_ = 0;
  OrientationParams params_;
  OrientationResult result_;
};

Napi::Value FindAbsoluteOrientation(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "findAbsoluteOrientation(request: object, callback: function)");
  }
  // OrientationWorker 在 Queue() 完成后自毁
  auto* worker = new OrientationWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// 导出 2：icp（精细配准）
// ---------------------------------------------------------------------------

class IcpWorker final : public Napi::AsyncWorker {
 public:
  IcpWorker(Napi::Env env, Napi::Object request, Napi::Function callback) : Napi::AsyncWorker(callback) {
    data_ = ParseCloud(env, request.Get("data"), "data");
    model_ = ParseCloud(env, request.Get("model"), "model");

    // 参数全部可选，缺省 = CC 的默认值（include/RegistrationTools.h 的 Parameters 构造函数）
    const Napi::Value paramsVal = request.Get("params");
    const Napi::Object params = paramsVal.IsObject() ? paramsVal.As<Napi::Object>() : Napi::Object::New(env);
    params_.maxIterations = OptionalUint32(params, "maxIterations", params_.maxIterations);
    params_.minRMSDecrease = OptionalNumber(params, "minRMSDecrease", params_.minRMSDecrease);
    params_.samplingLimit = OptionalUint32(params, "samplingLimit", params_.samplingLimit);
    params_.finalOverlapRatio = OptionalNumber(params, "finalOverlapRatio", params_.finalOverlapRatio);
    params_.adjustScale = OptionalBoolean(params, "adjustScale", params_.adjustScale);
    params_.minScale = OptionalNumber(params, "minScale", params_.minScale);
    params_.maxScale = OptionalNumber(params, "maxScale", params_.maxScale);
    params_.filterOutFarthestPoints =
        OptionalBoolean(params, "filterOutFarthestPoints", params_.filterOutFarthestPoints);
    const double filters = OptionalNumber(params, "transformationFilters", params_.transformationFilters);
    params_.transformationFilters = static_cast<int>(filters);
    params_.seed = OptionalUint32(params, "seed", params_.seed);
  }

  void Execute() override {
    // uv 线程池内：采样 → KD 树 → 迭代（毫秒级，单线程）
    result_ = registration::icp(data_.toSources(), model_.toSources(), params_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::EscapableHandleScope scope(env);
    Napi::Object out = Napi::Object::New(env);
    out.Set("result", result_.result);
    out.Set("rms", result_.rms);
    out.Set("initialRms", result_.initialRms);
    out.Set("pointCount", result_.pointCount);
    out.Set("iterations", result_.iterations);
    WriteTransform(env, out, result_.trans);
    Callback().Call({env.Null(), scope.Escape(out)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  CloudInput data_;
  CloudInput model_;
  IcpParams params_;
  IcpOutput result_;
};

// ---------------------------------------------------------------------------
// 导出 3：gicp（GICP精配准）
// ---------------------------------------------------------------------------

class GicpWorker final : public Napi::AsyncWorker {
 public:
  GicpWorker(Napi::Env env, Napi::Object request, Napi::Function callback) : Napi::AsyncWorker(callback) {
    data_ = ParseCloud(env, request.Get("data"), "data");
    model_ = ParseCloud(env, request.Get("model"), "model");

    // 参数全部可选，缺省 = 与 ICP 同源的默认值（注册侧 TS 镜像的 defaultGicpParams 必须一致）
    const Napi::Value paramsVal = request.Get("params");
    const Napi::Object params = paramsVal.IsObject() ? paramsVal.As<Napi::Object>() : Napi::Object::New(env);
    params_.maxIterations = OptionalUint32(params, "maxIterations", params_.maxIterations);
    params_.minRMSDecrease = OptionalNumber(params, "minRMSDecrease", params_.minRMSDecrease);
    params_.samplingLimit = OptionalUint32(params, "samplingLimit", params_.samplingLimit);
    params_.finalOverlapRatio = OptionalNumber(params, "finalOverlapRatio", params_.finalOverlapRatio);
    params_.filterOutFarthestPoints = OptionalBoolean(params, "filterOutFarthestPoints", params_.filterOutFarthestPoints);
    const double filters = OptionalNumber(params, "transformationFilters", params_.transformationFilters);
    params_.transformationFilters = static_cast<int>(filters);
    params_.seed = OptionalUint32(params, "seed", params_.seed);
    params_.correspondenceRandomness =
        OptionalUint32(params, "correspondenceRandomness", params_.correspondenceRandomness);
    params_.useNormalCovariance = OptionalBoolean(params, "useNormalCovariance", params_.useNormalCovariance);
  }

  void Execute() override {
    // uv 线程池内：采样 → 两侧协方差 PCA → 逐轮（最近邻 + 6x6 线性系统）——秒级，单线程
    result_ = registration::gicp(data_.toSources(), model_.toSources(), params_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::EscapableHandleScope scope(env);
    Napi::Object out = Napi::Object::New(env);
    out.Set("result", result_.result);
    out.Set("rms", result_.rms);
    out.Set("initialRms", result_.initialRms);
    out.Set("pointCount", result_.pointCount);
    out.Set("iterations", result_.iterations);
    out.Set("covarianceError", result_.covarianceError);
    WriteTransform(env, out, result_.trans);
    Callback().Call({env.Null(), scope.Escape(out)});
  }

  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Callback().Call({e.Value(), env.Null()});
  }

 private:
  CloudInput data_;
  CloudInput model_;
  registration::GicpParams params_;
  registration::GicpOutput result_;
};

Napi::Value ComputeGicp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "gicp(request: object, callback: function)");
  }
  // GicpWorker 在 Queue() 完成后自毁
  auto* worker = new GicpWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Value ComputeIcp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "icp(request: object, callback: function)");
  }
  // IcpWorker 在 Queue() 完成后自毁
  auto* worker = new IcpWorker(env, info[0].As<Napi::Object>(), info[1].As<Napi::Function>());
  worker->Queue();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("findAbsoluteOrientation", Napi::Function::New(env, FindAbsoluteOrientation));
  exports.Set("icp", Napi::Function::New(env, ComputeIcp));
  exports.Set("gicp", Napi::Function::New(env, ComputeGicp));
  return exports;
}

}  // namespace

NODE_API_MODULE(registration, Init)
