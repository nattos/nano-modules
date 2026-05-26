#pragma once
// DXV3 DXT1 LZ decompression.
//
// Implements the algorithm described in FFmpeg's libavcodec/dxv.c
// (dxv_decompress_dxt1 + CHECKPOINT macro). The compressed stream consumes
// 2-bit ops out of a refilled 32-bit "value" register, dispatching to either
// literal copies or back-references measured in 4-byte elements (each DXT1
// block is 2 elements).
//
// Returns 0 on success, negative on error.

#include <cstdint>

namespace dxv {

int decompress_dxt1(const uint8_t* in_ptr, uint32_t in_size,
                    uint8_t* out_ptr, uint32_t out_size);

} // namespace dxv
