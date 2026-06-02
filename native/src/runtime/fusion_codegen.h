// fusion_codegen.h — turn N per-pixel effect fragments into a single
// Metal compute kernel.
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
// Slot layout in the emitted kernel:
//   texture(0) — tex_in   (read)
//   texture(1) — tex_out  (access::write, RGBA8)
//   buffer(2)  — effect[0] uniforms
//   buffer(3)  — effect[1] uniforms
//   ...

#pragma once

#include <string>
#include <vector>

namespace fusion_codegen {

/// Generate a fused compute-kernel MSL source from per-effect "pixel"
/// MSL fragments. Returns the kernel source on success or an empty
/// string if any fragment couldn't be parsed (in which case the
/// caller should fall back to the standalone-per-effect path).
std::string generateFusedMSL(const std::vector<std::string>& pixelMSLs);

}  // namespace fusion_codegen
