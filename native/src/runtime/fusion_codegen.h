// fusion_codegen.h — turn N per-pixel effect fragments into a single
// compute kernel, in the language the live backend speaks.
//
// Every fusion-eligible effect (PerPixelMapper) registers a "pixel"
// shader via state::registerShaderSPV / registerShaderMSL whose MSL
// looks like:
//
//   struct type_ConstantBuffer_FuseUniforms { ... };
//   static inline __attribute__((always_inline))
//   float4 fuse_transform(thread const uint2& gid, thread const float4& c,
//                         constant type_ConstantBuffer_FuseUniforms& u_fuse)
//   { ... }
//   kernel void main0(...) { ... }   // <-- spirv-cross adds this; we strip it
//
// `generateFusedMSL` takes an ordered list of those MSL strings (one
// per effect in the fused group), renames the struct/function per
// index so they don't collide, and emits a single compute kernel that
// reads the input texture once, runs each fuse_transform in sequence,
// and writes the output texture once.
//
// `generateFusedHLSL` does the same for D3D11, from spirv-cross's HLSL of the
// same SPIR-V. That output is a different shape — the fuse uniforms come back
// as a `cbuffer` whose members are GLOBALS rather than a struct passed by
// reference, and there is no `always_inline))` marker — so it finds the user's
// functions by scanning top-level structure instead. See the .cpp.
//
// Slot layout in the emitted kernel (both languages; the executor binds these):
//   texture(0) — tex_in   (read)
//   texture(1) — tex_out  (write)
//   buffer(2)  — effect[0] uniforms
//   buffer(3)  — effect[1] uniforms
//   ...
// D3D11 stops at b13, which is why the fused group size is capped lower there
// (sketch_executor.cpp's kMaxFusionStages).

#pragma once

#include <string>
#include <vector>

namespace fusion_codegen {

/// Generate a fused compute-kernel MSL source from per-effect "pixel"
/// MSL fragments. Returns the kernel source on success or an empty
/// string if any fragment couldn't be parsed (in which case the
/// caller should fall back to the standalone-per-effect path).
std::string generateFusedMSL(const std::vector<std::string>& pixelMSLs);

/// The D3D11 twin: same contract, HLSL in and HLSL out. The entry point is
/// `fused_main` in both.
std::string generateFusedHLSL(const std::vector<std::string>& pixelHLSLs);

}  // namespace fusion_codegen
