#include "runtime/spv_to_msl.h"

#include <vector>

#include <spirv_msl.hpp>

namespace effect_runtime {

std::string spvToMsl(const uint8_t* spv, size_t byteCount) {
  if (!spv || byteCount < 4 || (byteCount % 4) != 0) return {};

  const uint32_t* words = reinterpret_cast<const uint32_t*>(spv);
  std::vector<uint32_t> ir(words, words + byteCount / 4);

  try {
    spirv_cross::CompilerMSL compiler(std::move(ir));
    spirv_cross::CompilerMSL::Options opts;
    // Match the build-time conversion (gen_barrel_effects.py):
    //   spirv-cross --msl --msl-version 20000 --msl-decoration-binding
    opts.set_msl_version(2, 0, 0);
    opts.enable_decoration_binding = true;
    compiler.set_msl_options(opts);
    std::string msl = compiler.compile();

    // MSL doesn't encode the compute workgroup size (HLSL [numthreads] /
    // WGSL @workgroup_size) — in Metal the threadgroup size is supplied at
    // dispatch time. Emit it as a parseable comment so the Metal backend can
    // dispatch with the matching threadsPerThreadgroup instead of assuming
    // 8×8×1 (which silently truncates 4×4×4 / 64×1×1 / 1×1×1 kernels).
    if (compiler.get_execution_model() == spv::ExecutionModelGLCompute) {
      uint32_t wx = compiler.get_execution_mode_argument(spv::ExecutionModeLocalSize, 0);
      uint32_t wy = compiler.get_execution_mode_argument(spv::ExecutionModeLocalSize, 1);
      uint32_t wz = compiler.get_execution_mode_argument(spv::ExecutionModeLocalSize, 2);
      if (wx == 0) wx = 1;
      if (wy == 0) wy = 1;
      if (wz == 0) wz = 1;
      msl = "// nano_threadgroup: " + std::to_string(wx) + " " +
            std::to_string(wy) + " " + std::to_string(wz) + "\n" + msl;
    }
    return msl;
  } catch (const std::exception&) {
    return {};
  }
}

}  // namespace effect_runtime
