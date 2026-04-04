#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <vector>
#include <cmath>

#include "bridge/param_cache.h"
#include "wasm/wasm_host.h"
#include "gpu/gpu_backend.h"

#ifndef GPU_TEST_WASM_PATH
#error "GPU_TEST_WASM_PATH must be defined"
#endif

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(size);
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

TEST_CASE("Metal GPU pipeline: compute + render produces correct pixels", "[gpu_metal]") {
  // Create Metal backend
  auto gpu = gpu::createMetalBackend();
  REQUIRE(gpu != nullptr);
  REQUIRE(gpu->getBackend() == 0); // Metal

  // Create offscreen render target (64×64 RGBA8)
  int rt = gpu->createTexture(64, 64, 1); // format 1 = RGBA8
  REQUIRE(rt > 0);
  gpu->setSurface(rt, 64, 64);

  // Load WASM module
  auto bytecode = load_file(GPU_TEST_WASM_PATH);
  REQUIRE(!bytecode.empty());

  bridge::ParamCache cache;
  wasm::WasmHost host(cache);
  REQUIRE(host.init());

  int32_t mod = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(mod >= 0);

  // Wire GPU backend
  host.set_gpu_backend(mod, gpu.get());

  // Set frame state
  wasm::FrameState fs;
  fs.viewport_w = 64;
  fs.viewport_h = 64;
  host.set_frame_state(mod, &fs);

  // Run init
  REQUIRE(host.call_function(mod, "init") == 0);

  // Run render
  REQUIRE(host.call_function_i32_i32(mod, "render", 64, 64) == 0);

  // Read back pixels
  auto pixels = gpu->readbackTexture(rt, 64, 64);
  REQUIRE(pixels.size() == 64 * 64 * 4);

  // Check center pixel — expected: R=0, G=128, B=255, A=255
  // (the compute shader sets uniform color R=0.0, G=0.5, B=1.0, A=1.0)
  int cx = 32, cy = 32;
  int off = (cy * 64 + cx) * 4;
  uint8_t r = pixels[off], g = pixels[off + 1], b = pixels[off + 2], a = pixels[off + 3];

  INFO("Center pixel: R=" << (int)r << " G=" << (int)g << " B=" << (int)b << " A=" << (int)a);
  REQUIRE(std::abs((int)r - 0) <= 5);
  REQUIRE(std::abs((int)g - 128) <= 10);
  REQUIRE(std::abs((int)b - 255) <= 5);
  REQUIRE(std::abs((int)a - 255) <= 5);

  // Check a corner pixel too (should be the same solid color)
  off = 0; // top-left
  r = pixels[off]; g = pixels[off + 1]; b = pixels[off + 2]; a = pixels[off + 3];
  INFO("Corner pixel: R=" << (int)r << " G=" << (int)g << " B=" << (int)b << " A=" << (int)a);
  REQUIRE(std::abs((int)r - 0) <= 5);
  REQUIRE(std::abs((int)g - 128) <= 10);
  REQUIRE(std::abs((int)b - 255) <= 5);

  host.shutdown();
}

TEST_CASE("Metal GPU: shader compilation from MSL", "[gpu_metal]") {
  auto gpu = gpu::createMetalBackend();
  REQUIRE(gpu != nullptr);

  // Compile a minimal MSL shader
  int handle = gpu->createShaderModule(R"(
    #include <metal_stdlib>
    using namespace metal;
    kernel void test_kernel(device float* buf [[buffer(0)]],
                            uint id [[thread_position_in_grid]]) {
      buf[id] = 42.0;
    }
  )");
  REQUIRE(handle > 0);

  // Create compute PSO from it
  int pso = gpu->createComputePSO(handle, "test_kernel");
  REQUIRE(pso > 0);

  gpu->release(pso);
  gpu->release(handle);
}
