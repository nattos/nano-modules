// test_effect_render.cpp — end-to-end GPU render of a WASM effect (barrel-
// loads-WASM). Loads brightness_contrast from core.wasm, registers it through
// the WASM ModuleRegistry (module_init compiles its SPV→MSL shader + PSO on a
// real Metal backend), wires tex_in/tex_out, drives doRender via the WASM
// EffectInstance driver, and verifies the output pixels brighten.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using wasm::WasmHost;
using wasm::WasmEffectDesc;
using effect_runtime::EffectRuntime;
using effect_runtime::EffectInstance;

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

static double mean_rgb(const std::vector<uint8_t>& px) {
  long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? static_cast<double>(sum) / n : 0.0;
}

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

TEST_CASE("WASM GPU effect renders via Metal (brightness_contrast)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  auto bytecode = load_file(CORE_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // The backend must be set before module_init runs (it compiles the shader).
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "video.brightness_contrast") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  // Register ONLY this effect — registering the whole bundle would run every
  // effect's module_init, some of which use host imports not yet wired.
  REQUIRE(registry.registerWasmEffect("video.brightness_contrast",
                                      "Brightness/Contrast", &host, id, *w));

  EffectInstance* inst = rt.instanceFor("video.brightness_contrast", "k0");
  REQUIRE(inst != nullptr);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0);
  REQUIRE(outTex >= 0);

  // Fill the input with mid-gray (64,64,64,255).
  std::vector<uint8_t> inPixels(W * H * 4, 64);
  for (size_t i = 3; i < inPixels.size(); i += 4) inPixels[i] = 255;
  backend->writeTexture(inTex, W, H, inPixels.data(),
                        static_cast<uint32_t>(inPixels.size()));

  inst->setTextureField("tex_in", inTex);
  inst->setTextureField("tex_out", outTex);

  const double inMean = mean_rgb(inPixels);

  // brightness 0.75 (> neutral 0.5) should lift the output above the input.
  inst->setParamFloat("brightness", 0.75f);
  inst->setParamFloat("contrast", 0.5f);
  inst->doRender(W, H);  // effect calls gpu.submit() internally (commit+wait)
  auto bright = backend->readbackTexture(outTex, W, H);
  REQUIRE(bright.size() == W * H * 4);
  INFO("in mean " << inMean << "  bright mean " << mean_rgb(bright));
  CHECK(mean_rgb(bright) > inMean + 30.0);

  // Neutral (0.5/0.5) is identity: output ~= input.
  inst->setParamFloat("brightness", 0.5f);
  inst->setParamFloat("contrast", 0.5f);
  inst->doRender(W, H);
  auto ident = backend->readbackTexture(outTex, W, H);
  INFO("ident mean " << mean_rgb(ident));
  CHECK(std::abs(mean_rgb(ident) - inMean) < 8.0);

  host.shutdown();
}

// The slot-based GPU input ABI: video.blend reads its two inputs via
// gpu::Device::inputTexture(0/1) and writes via renderTarget() — NOT
// textureForField. This locks the executor↔host plumbing that feeds those
// (EffectInstance::setInputTextureSlots → WasmContext::input_texture_handles,
// and GPUBackend::setSurface → getSurfaceTexture). Without it the effect bails
// to black; texture wires into multi-input effects depend on it.
TEST_CASE("WASM slot-based input ABI blends two textures (video.blend)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  auto bytecode = load_file(CORE_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "video.blend") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(registry.registerWasmEffect("video.blend", "Blend", &host, id, *w));

  EffectInstance* inst = rt.instanceFor("video.blend", "k0");
  REQUIRE(inst != nullptr);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int texA = backend->createTexture(W, H, RGBA8);   // dark
  int texB = backend->createTexture(W, H, RGBA8);   // bright
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(texA >= 0); REQUIRE(texB >= 0); REQUIRE(outTex >= 0);

  std::vector<uint8_t> aPix(W * H * 4, 40);
  std::vector<uint8_t> bPix(W * H * 4, 200);
  for (size_t i = 3; i < aPix.size(); i += 4) { aPix[i] = 255; bPix[i] = 255; }
  backend->writeTexture(texA, W, H, aPix.data(), (uint32_t)aPix.size());
  backend->writeTexture(texB, W, H, bPix.data(), (uint32_t)bPix.size());

  // Slot 0 = A, slot 1 = B (mirrors the executor's per-stage publish).
  inst->setInputTextureSlots({texA, texB});
  backend->setSurface(outTex, W, H);  // renderTarget() resolves here

  // opacity = 1 → output = B (bright).
  inst->setParamFloat("opacity", 1.0f);
  inst->doRender(W, H);
  auto allB = backend->readbackTexture(outTex, W, H);
  INFO("opacity=1 mean " << mean_rgb(allB) << " (expect ~200)");
  CHECK(mean_rgb(allB) > 180.0);

  // opacity = 0 → output = A (dark). Proves slot 0 is wired independently.
  inst->setParamFloat("opacity", 0.0f);
  inst->doRender(W, H);
  auto allA = backend->readbackTexture(outTex, W, H);
  INFO("opacity=0 mean " << mean_rgb(allA) << " (expect ~40)");
  CHECK(mean_rgb(allA) < 60.0);

  // opacity = 0.5 → midpoint of the two slots.
  inst->setParamFloat("opacity", 0.5f);
  inst->doRender(W, H);
  auto mid = backend->readbackTexture(outTex, W, H);
  INFO("opacity=0.5 mean " << mean_rgb(mid) << " (expect ~120)");
  CHECK(std::abs(mean_rgb(mid) - 120.0) < 25.0);

  host.shutdown();
}

TEST_CASE("full core.wasm bundle registers every effect under Metal", "[effect_render]") {
  // The barrel cutover gate: loading the bundle and registering ALL of its
  // effects runs each one's module_init (schema publish + shader/PSO compile).
  // None may trip on an unimplemented host import.
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  auto bytecode = load_file(CORE_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const size_t declared = host.registered_effects(id).size();
  INFO("bundle declares " << declared << " effect(s)");
  REQUIRE(declared > 1);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  int n = registry.registerWasmBundle(host, id);
  INFO("registered " << n);
  CHECK(n == static_cast<int>(declared));

  // Every registered effect published a non-empty schema → its module_init ran
  // through state::init without trapping. (The render case above proves the
  // shader/PSO path for a representative effect.)
  auto schemas = registry.schemas();
  int withSchema = 0;
  for (const auto& kv : schemas) {
    if (kv.second.is_object() && !kv.second.empty()) ++withSchema;
  }
  INFO("effects with non-empty schema: " << withSchema << "/" << n);
  CHECK(withSchema == n);

  host.shutdown();
}
