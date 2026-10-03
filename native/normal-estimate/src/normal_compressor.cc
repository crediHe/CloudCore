#include "normal_compressor.h"

namespace normal_estimate {

std::uint16_t compressNormal(const double n[3]) {
  // ---- 1) 三个符号位：x<0 → |=4，y<0 → |=2，z<0 → |=1 ----
  unsigned res = 0;
  double x;
  double y;
  double z;
  if (n[0] >= 0) {
    x = n[0];
  } else {
    res |= 4;
    x = -n[0];
  }
  if (n[1] >= 0) {
    y = n[1];
  } else {
    res |= 2;
    y = -n[1];
  }
  if (n[2] >= 0) {
    z = n[2];
  } else {
    res |= 1;
    z = -n[2];
  }

  // ---- 2) 按 L1 和归一化（CC 原样：不用 L2）----
  double psnorm = x + y + z;
  if (psnorm == 0) {
    return NULL_NORM_CODE;
  }
  x /= psnorm;
  y /= psnorm;
  z /= psnorm;

  // ---- 3) 半箱 + 扇区细分，每轮 2 位 ----
  // box[0..2] = 下界，box[3..5] = 上界，初值单位立方体 [0,1]^3。
  double box[6] = {0, 0, 0, 1, 1, 1};
  bool flip = false;
  for (unsigned char level = QUANTIZE_LEVEL; level != 0;) {
    // 下一层
    res <<= 2;
    --level;

    const double halfBox[3] = {
        (box[0] + box[3]) / 2,
        (box[1] + box[4]) / 2,
        (box[2] + box[5]) / 2,
    };

    // 扇区判定：flip 时用「小于」、否则用「大于」——Z 优先，其次 Y，最后 X，
    // 三个都不满足则 3（"留在本箱"）。顺序与比较方向必须与 CC 完全一致。
    unsigned sector = 3;
    if (flip) {
      if (z < halfBox[2])
        sector = 2;
      else if (y < halfBox[1])
        sector = 1;
      else if (x < halfBox[0])
        sector = 0;
    } else {
      if (z > halfBox[2])
        sector = 2;
      else if (y > halfBox[1])
        sector = 1;
      else if (x > halfBox[0])
        sector = 0;
    }
    res |= sector;

    if (level != 0) {  // 最后一层不再更新箱（没有下一轮要编码）
      if (flip) {
        if (sector != 3) psnorm = box[sector];
        box[0] = halfBox[0];
        box[1] = halfBox[1];
        box[2] = halfBox[2];
        if (sector != 3) {
          box[3 + sector] = box[sector];
          box[sector] = psnorm;
        } else {
          flip = false;
        }
      } else {
        if (sector != 3) psnorm = box[3 + sector];
        box[3] = halfBox[0];
        box[4] = halfBox[1];
        box[5] = halfBox[2];
        if (sector != 3) {
          box[sector] = box[3 + sector];
          box[3 + sector] = psnorm;
        } else {
          flip = true;
        }
      }
    }
  }

  return static_cast<std::uint16_t>(res);
}

void decompressNormal(std::uint16_t code, double n[3], unsigned char level) {
  // ---- 空码：零向量 ----
  if (code == NULL_NORM_CODE) {
    n[0] = n[1] = n[2] = 0;
    return;
  }

  const unsigned index = code;

  // ---- 逆推箱：与 Compress 的 box 记账镜像 ----
  double box[6] = {0, 0, 0, 1, 1, 1};
  bool flip = false;

  unsigned char l_shift = static_cast<unsigned char>(level * 2);
  for (unsigned char k = 0; k < level; ++k) {
    l_shift = static_cast<unsigned char>(l_shift - 2);
    const unsigned sector = (index >> l_shift) & 3;
    if (flip) {
      const double tmp = box[sector];
      box[0] = (box[0] + box[3]) / 2;
      box[1] = (box[1] + box[4]) / 2;
      box[2] = (box[2] + box[5]) / 2;
      if (sector != 3) {
        box[3 + sector] = box[sector];
        box[sector] = tmp;
      } else {
        flip = false;
      }
    } else {
      const double tmp = (sector != 3 ? box[3 + sector] : 0);

      box[3] = (box[0] + box[3]) / 2;
      box[4] = (box[1] + box[4]) / 2;
      box[5] = (box[2] + box[5]) / 2;

      if (sector != 3) {
        box[sector] = box[3 + sector];
        box[3 + sector] = tmp;
      } else {
        flip = true;
      }
    }
  }

  // ---- 符号位：把箱端点按扇区加上正负号（输出未归一化）----
  const unsigned sector = index >> (level + level);

  n[0] = ((sector & 4) != 0 ? -(box[3] + box[0]) : box[3] + box[0]);
  n[1] = ((sector & 2) != 0 ? -(box[4] + box[1]) : box[4] + box[1]);
  n[2] = ((sector & 1) != 0 ? -(box[5] + box[2]) : box[5] + box[2]);
}

}  // namespace normal_estimate
