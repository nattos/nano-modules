#include "runtime/spv_to_hlsl.h"

#include <string>
#include <vector>

#include <spirv_hlsl.hpp>

namespace effect_runtime {
namespace {

// D3D11 gives a stage 14 constant-buffer slots, b0..b13 — far fewer than the
// 128 SRVs or (at feature level 11_1) 64 UAVs. A shader that asked for b14
// cannot be bound at all, so say so by name rather than letting D3DCompile
// fail with a line number in generated source nobody wrote.
constexpr uint32_t kMaxConstantBufferSlot = 13;

// spirv-cross sometimes rewrites a counted loop as `for (;;)` with the exit
// test moved into the body, while faithfully carrying over the SPIR-V Unroll
// loop-control hint as `[unroll]`. FXC then cannot determine a trip count and
// gives up — "error X3511: unable to unroll loop" — on a loop the effect
// author wrote as a plain `for (i = 0; i < 4; ++i)`.
//
// The attribute is only ever a hint, and on `for (;;)` it is a hint FXC can
// never honour, so dropping it can only turn a hard error into a shader that
// compiles. Doing it here rather than in the ~380 authored .hlsl files keeps
// an FXC quirk from becoming something effect authors have to know about.
void dropUnsatisfiableUnrollHints(std::string& hlsl) {
  static const std::string kAttr = "[unroll]";
  for (size_t at = hlsl.find(kAttr); at != std::string::npos;
       at = hlsl.find(kAttr, at)) {
    size_t next = hlsl.find_first_not_of(" \t\r\n", at + kAttr.size());
    if (next != std::string::npos && hlsl.compare(next, 8, "for (;;)") == 0) {
      hlsl.erase(at, next - at);   // the attribute and the gap after it
    } else {
      at += kAttr.size();
    }
  }
}

void pin(spirv_cross::CompilerHLSL& c, spv::ExecutionModel stage,
         const spirv_cross::Resource& res) {
  spirv_cross::HLSLResourceBinding b;
  b.stage = stage;
  b.desc_set = c.get_decoration(res.id, spv::DecorationDescriptorSet);
  b.binding = c.get_decoration(res.id, spv::DecorationBinding);
  // Every HLSL register space gets the SAME number. Our shaders' binding
  // numbers are unique across resource TYPES (DXC assigns one number per
  // `register(...)` regardless of letter), so only one of these four can ever
  // apply to a given resource — setting all four just saves classifying it.
  b.cbv.register_binding = b.binding;
  b.uav.register_binding = b.binding;
  b.srv.register_binding = b.binding;
  b.sampler.register_binding = b.binding;
  c.add_hlsl_resource_binding(b);
}

}  // namespace

std::string spvToHlsl(const uint8_t* spv, size_t byteCount, std::string* error) {
  auto fail = [&](const char* why) -> std::string {
    if (error) *error = why;
    return {};
  };
  if (!spv || byteCount < 4 || (byteCount % 4) != 0)
    return fail("not a SPIR-V blob (null, too short, or not word-aligned)");

  const uint32_t* words = reinterpret_cast<const uint32_t*>(spv);
  std::vector<uint32_t> ir(words, words + byteCount / 4);

  try {
    spirv_cross::CompilerHLSL compiler(std::move(ir));

    spirv_cross::CompilerHLSL::Options opts;
    // 5.0 is what D3D11 consumes. 5.1 exists in FXC but only D3D12 can bind
    // it (it is the one that introduced register spaces).
    opts.shader_model = 50;
    // A storage buffer the shader only reads would otherwise be declared as a
    // ByteAddressBuffer in t-space, while the host binds every storage buffer
    // through a UAV in u-space (d3d11_backend.cpp's computeSetBuffer). That
    // mismatch binds nothing and reads zeros, so force the UAV form and keep
    // one rule for all storage buffers.
    opts.force_storage_buffer_as_uav = true;
    compiler.set_hlsl_options(opts);

    // Same clip-space flip as the MSL path, for the same reason: SPIR-V's NDC
    // is Y-down and D3D's is Y-up, exactly as Metal's and WebGPU's are. See
    // the long comment in spv_to_msl.cpp — getting this backwards mirrors
    // every rasterized effect, and it has already regressed once.
    {
      spirv_cross::CompilerGLSL::Options common = compiler.get_common_options();
      common.vertex.flip_vert_y = true;
      compiler.set_common_options(common);
    }

    const spv::ExecutionModel stage = compiler.get_execution_model();
    spirv_cross::ShaderResources res = compiler.get_shader_resources();
    for (const auto* list : {
             &res.uniform_buffers, &res.storage_buffers, &res.storage_images,
             &res.separate_images, &res.separate_samplers, &res.sampled_images,
             &res.subpass_inputs, &res.atomic_counters }) {
      for (const auto& r : *list) pin(compiler, stage, r);
    }
    for (const auto& r : res.uniform_buffers) {
      uint32_t slot = compiler.get_decoration(r.id, spv::DecorationBinding);
      if (slot > kMaxConstantBufferSlot) {
        if (error)
          *error = "constant buffer '" + r.name + "' wants register(b" +
                   std::to_string(slot) + "); D3D11 stops at b" +
                   std::to_string(kMaxConstantBufferSlot);
        return {};
      }
    }

    std::string hlsl = compiler.compile();
    if (hlsl.empty()) return fail("spirv-cross produced no output");
    dropUnsatisfiableUnrollHints(hlsl);
    // Deliberately NO `// nano_threadgroup:` line. MSL can't express a
    // workgroup size so spv_to_msl.cpp smuggles it through in a comment; HLSL
    // writes [numthreads(X,Y,Z)] and the D3D11 backend reads it from the
    // compiled shader, so the hint would be dead weight here.
    return hlsl;
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

}  // namespace effect_runtime
