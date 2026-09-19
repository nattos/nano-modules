#pragma once
// spv_to_hlsl.h — runtime SPIR-V → HLSL translation, for the D3D11 backend.
//
// The twin of spv_to_msl.h. Effects author each shader stage once as HLSL; DXC
// compiles it to SPIR-V at bundle-build time and that SPIR-V is what ships. So
// on Windows we translate *back* to HLSL and hand it to D3DCompile — a round
// trip, but the only one available: D3D11 will not accept DXIL, and DXBC
// cannot be produced off Windows, so this cannot move to build time.
//
// The round trip has to be an IDENTITY on register numbers. `register(t1)` in
// the authored shader became SPIR-V binding 1, and the host binds textures and
// buffers by that same number (d3d11_backend.cpp passes `slot` straight to
// CSSetShaderResources / CSSetUnorderedAccessViews). If spirv-cross were left
// to auto-assign registers, every shader with more than one resource of a kind
// would mis-bind silently — black output, no error. spvToHlsl pins each
// resource back to its SPIR-V binding to prevent that.

#include <cstddef>
#include <cstdint>
#include <string>

namespace effect_runtime {

// Translate a SPIR-V blob (`byteCount` bytes, a multiple of 4) to HLSL source
// targeting shader model 5.0. Returns an empty string on invalid input or a
// translation error; `error`, when non-null, receives a human-readable reason.
std::string spvToHlsl(const uint8_t* spv, size_t byteCount,
                      std::string* error = nullptr);

}  // namespace effect_runtime
