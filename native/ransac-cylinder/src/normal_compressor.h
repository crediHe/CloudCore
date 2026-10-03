#pragma once
/**
 * 法向量定点编解码：逐行移植 CloudCompare 的 ccNormalCompressor
 * （libs/qCC_db/src/ccNormalCompressor.cpp:26-221）。
 *
 * **本文件是 native/normal-estimate/src/normal_compressor.h 的逐字拷贝**（只改了 namespace），
 * 按仓库「模块自包含、拷贝模板」的惯例带过来，不引入共享 native 目录。本模块**只用
 * decompressNormal**（把实体上的 `normalCode` 还原成法线参与轴方向估计），compress 一并保留
 * 是为了两份拷贝能整文件 diff——分头裁剪会让它们悄悄分叉。
 *
 * ⚠ **量化常量是三处同步**：本文件、native/normal-estimate/src/normal_compressor.h、
 * 以及渲染侧 src/renderer/utils/normalEstimate.ts 的 `NORMAL_QUANTIZE_LEVEL`。改一处必须改三处，
 * 否则解码出的方向会与写入侧错位（不报错、只是轴方向悄悄变歪）。
 *
 * 码结构（15 位有效，最高位恒 0）：bit14..12 = 三个符号位（x / y / z 各 1 位），
 * bit11..0 = 6 轮 × 2 位的「半箱扇区」细分码（压缩与解压共用同一套 flip 记账）。
 * NULL 码 32768（> 最大有效码）表示「无法计算」：零向量、邻域点数不足等。
 */
#include <cstdint>

namespace ransac_cylinder {

/** 量化层数（每层 2 位）。CC master 为 9，本仓库照用户决策用 6。 */
constexpr unsigned char QUANTIZE_LEVEL = 6;

/** 最大有效码 = 3 + 2*6 = 15 位全 1。Uint16Array 装得下。 */
constexpr std::uint16_t MAX_VALID_NORM_CODE = (1u << (QUANTIZE_LEVEL * 2 + 3)) - 1;  // 32767

/** 空码：紧接最大有效码之后（与 CC 的 NULL_NORM_CODE 定义同构）。 */
constexpr std::uint16_t NULL_NORM_CODE = static_cast<std::uint16_t>(MAX_VALID_NORM_CODE + 1);  // 32768

/** 反转掩码：只翻 3 个符号位（CC 的 `7 << 2 * QUANTIZE_LEVEL`，此处 = 7 << 12 = 28672）。 */
constexpr std::uint16_t INVERT_XOR = static_cast<std::uint16_t>(7u << (2 * QUANTIZE_LEVEL));

static_assert(QUANTIZE_LEVEL != 0, "QUANTIZE_LEVEL 必须非 0（CC 原文 assert 的等价约束）");
static_assert(INVERT_XOR == 28672u, "反转掩码推导有误");

/**
 * 把（未要求归一化的）法向量压成量化码。
 * 全 0 向量（或 L1 和为 0）返回 NULL_NORM_CODE。
 */
std::uint16_t compressNormal(const double n[3]);

/**
 * 解码：逆过程。输出是**未归一化**的向量（箱角之和，模长 ≈ 1/√3 量级），
 * 归一化交给调用方（渲染侧 LUT 建表时统一归一化，与 CC ccNormalVectors::Init 一致）。
 */
void decompressNormal(std::uint16_t code, double n[3], unsigned char level = QUANTIZE_LEVEL);

/** 反转（等价于对解码向量取反后重新压缩）：只翻 3 个符号位。NULL 码原样返回。 */
inline std::uint16_t invertNormalCode(std::uint16_t code) {
  return code == NULL_NORM_CODE ? code : static_cast<std::uint16_t>(code ^ INVERT_XOR);
}

}  // namespace ransac_cylinder
