#pragma once
// spv_to_msl.h — runtime SPIR-V → Metal Shading Language translation.
//
// The statically-linked native build pre-bakes MSL at configure time
// (gen_barrel_effects.py shells out to the spirv-cross CLI). Effects loaded as
// WASM ship their shaders as SPIR-V and register them via state.register_shader_spv,
// so the host must translate to MSL at load time. This mirrors the build-time
// invocation (`spirv-cross --msl --msl-version 20000 --msl-decoration-binding`)
// so a loaded WASM effect's shader is byte-identical to its statically-baked
// counterpart and behaves the same on Metal (incl. the main→main0 entry rename
// that gpu_impls::mapEntryName compensates for).

#include <cstddef>
#include <cstdint>
#include <string>

namespace effect_runtime {

// Translate a SPIR-V blob (`byteCount` bytes, a multiple of 4) to MSL source.
// Returns an empty string on invalid input or a translation error.
std::string spvToMsl(const uint8_t* spv, size_t byteCount);

}  // namespace effect_runtime
