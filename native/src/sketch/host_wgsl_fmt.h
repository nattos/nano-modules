#pragma once
/*
 * host_wgsl_fmt.h — the storage-texture format the executor's own shaders
 * (host_blend.h, host_sidechannel_blit.h, host_output_blit.h) declare.
 *
 * Those shaders are authored once as HLSL (src/sketch/shaders/) and translated
 * per backend at PSO-build time. WGSL is the only one of the three target
 * languages that BAKES a storage format into the declaration — MSL and HLSL
 * take it from the view at bind time — so WebGPU needs one shader module per
 * concrete output format (a 16F sketch writes rgba16float intermediates) while
 * Metal and D3D11 need exactly one for all of them.
 *
 * This is the last thing the executor still asks gpu_get_backend() about, and
 * the reason it is phrased as a named question rather than an inline `== 1`:
 * every site that used to read `gpu_get_backend() == 1 ? WGSL : MSL` handed MSL
 * to D3D11 the day that backend existed. A backend this predicate doesn't
 * recognize gets the single-module answer, which is right for every language
 * that isn't WGSL.
 */

#include <cstdint>

namespace sketch_executor {

// TextureFormat wire code (wasm_modules/include/gpu.h) → WGSL storage format.
inline const char* wgslStorageFormatName(int32_t code) {
  switch (code) {
    case 3:  return "rgba16float";
    case 4:  return "r32float";
    case 5:  return "rgba32float";
    default: return "rgba8unorm";
  }
}

// Does `backend` (gpu::Backend, from gpu_get_backend()) compile a shader
// language that bakes the storage-texture format? 1 = WebGPU/WGSL.
inline bool backendBakesStorageFormat(int32_t backend) { return backend == 1; }

}  // namespace sketch_executor
