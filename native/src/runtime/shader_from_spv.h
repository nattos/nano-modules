#pragma once
/*
 * shader_from_spv.h — SPIR-V → a shader module on whatever backend is live.
 *
 * Everything that ships shaders in this tree ships SPIR-V: effects bake it from
 * their HLSL at bundle-build time, and since the executor's own inline shaders
 * were unified (the HLSL under src/sketch/shaders) so does the executor. No GPU
 * API here accepts SPIR-V directly, so the translation happens at PSO-build —
 * SPIRV-Cross to MSL for Metal, back to HLSL for D3D11 (which takes neither
 * SPIR-V nor DXIL, and whose DXBC can only be produced on Windows), and naga to
 * WGSL on the web, which is the one path that doesn't come through here.
 *
 * Header-only because both host paths need it and they live in different CMake
 * targets: gpu_impls.cpp (effect_runtime, the native static path) and
 * host_functions.cpp (wasm_host, the WAMR import table).
 */

#include <cstdio>
#include <string>

#include "gpu/gpu_backend.h"
#include "runtime/spv_to_hlsl.h"
#include "runtime/spv_to_msl.h"

namespace effect_runtime {

// Returns a backend shader-module handle, or -1. `debugName` only names the
// shader in the failure log — a -1 reaches the caller as "compile failed" and
// ends as a black frame with nothing else said.
inline int createShaderModuleFromSpv(gpu::GPUBackend* backend,
                                     const unsigned char* spv, size_t byteCount,
                                     const char* debugName) {
  if (!backend || !spv || byteCount == 0) return -1;
  const char* name = debugName ? debugName : "<unnamed>";
  std::string src;
  if (backend->getBackend() == 2 /*D3D11*/) {
    std::string err;
    src = spvToHlsl(spv, byteCount, &err);
    if (src.empty()) {
      std::fprintf(stderr, "[shader] SPV->HLSL failed for '%s': %s\n",
                   name, err.c_str());
      return -1;
    }
  } else {
    src = spvToMsl(spv, byteCount);
    if (src.empty()) {
      std::fprintf(stderr, "[shader] SPV->MSL failed for '%s'\n", name);
      return -1;
    }
  }
  return backend->createShaderModule(src);
}

}  // namespace effect_runtime
