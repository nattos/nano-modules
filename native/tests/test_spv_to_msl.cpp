// test_spv_to_msl.cpp — runtime SPIR-V → MSL translation (barrel-loads-WASM).
// Loaded WASM effects ship SPIR-V; the host translates to MSL at load time.
// Validates against brightness_contrast's compute shader SPV.

#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <vector>

#include "runtime/spv_to_msl.h"

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

#ifndef BRIGHTNESS_SPV_PATH
#error "BRIGHTNESS_SPV_PATH must be defined"
#endif

TEST_CASE("spvToMsl translates a compute shader to MSL", "[spv_to_msl]") {
  auto spv = load_file(BRIGHTNESS_SPV_PATH);
  REQUIRE(!spv.empty());
  REQUIRE(spv.size() % 4 == 0);

  std::string msl = effect_runtime::spvToMsl(spv.data(), spv.size());
  INFO(msl.substr(0, 300));
  REQUIRE(!msl.empty());

  // Matches the build-time spirv-cross output: entry renamed main->main0,
  // decoration bindings preserved ([[texture(0)]], [[buffer(2)]]).
  CHECK(msl.find("kernel void main0") != std::string::npos);
  CHECK(msl.find("[[texture(0)]]") != std::string::npos);
  CHECK(msl.find("#include <metal_stdlib>") != std::string::npos);
}

TEST_CASE("spvToMsl rejects invalid input", "[spv_to_msl]") {
  CHECK(effect_runtime::spvToMsl(nullptr, 0).empty());
  const uint8_t junk[5] = {1, 2, 3, 4, 5};
  CHECK(effect_runtime::spvToMsl(junk, 5).empty());   // not a multiple of 4
  const uint8_t notspv[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  CHECK(effect_runtime::spvToMsl(notspv, 8).empty());  // bad magic
}
