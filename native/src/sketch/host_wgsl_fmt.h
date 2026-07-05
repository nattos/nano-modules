#pragma once
/*
 * host_wgsl_fmt.h — per-format templating for the executor's inline WGSL
 * kernels (host_blend.h, host_sidechannel_blit.h, host_output_blit.h).
 *
 * The executor's twin shader sources declare their storage outputs as
 * `rgba8unorm` — historically the only stage format. With per-sketch bit
 * depth the output texture can be rgba16float, and WGSL storage textures
 * bake the format into the declaration, so WebGPU needs one PSO per
 * concrete output format. MSL never bakes storage formats, so the Metal
 * side keeps a single PSO regardless.
 */

#include <string>

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

// Rewrite every `rgba8unorm` in an inline WGSL source to the storage format
// for `code`. Code 1 (or unknown) returns the source unchanged.
inline std::string wgslWithStorageFormat(const char* src, int32_t code) {
  std::string s(src);
  const char* to = wgslStorageFormatName(code);
  if (std::string(to) == "rgba8unorm") return s;
  const std::string from = "rgba8unorm";
  size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += std::string(to).size();
  }
  return s;
}

}  // namespace sketch_executor
