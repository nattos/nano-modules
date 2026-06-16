// test_executor_wasm.cpp — the end-to-end proof: drive the unified executor.wasm
// (via WasmExecutorDriver — the SAME driver the barrel + benchmark use) against
// the native EffectRuntime + Metal backend, and assert it renders pixel-identical
// to the in-process native SketchExecutor. Also covers the driver itself.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"
#include "sketch/wasm_executor_driver.h"

using effect_runtime::EffectRuntime;
using sketch_executor::ModuleRegistry;
using sketch_executor::SketchExecutor;
using sketch_executor::WasmEffectBundles;
using sketch_executor::WasmExecutorDriver;

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif
#ifndef EXECUTOR_WASM_PATH
#error "EXECUTOR_WASM_PATH must be defined"
#endif

static double mean_rgb(const std::vector<uint8_t>& px) {
  long s = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { s += px[i] + px[i+1] + px[i+2]; n += 3; }
  return n ? (double)s / n : 0.0;
}

// Directory holding executor.wasm (the driver appends executor.aot / .wasm).
static std::string executorWasmDir() {
  std::string p = EXECUTOR_WASM_PATH;
  auto slash = p.find_last_of('/');
  return slash == std::string::npos ? std::string(".") : p.substr(0, slash);
}

TEST_CASE("executor.wasm renders pixel-identical to the native executor", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  // Native runtime + effects (shared by both executors via the effrt binding).
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  // Load + prime executor.wasm through the shared driver (registers the effrt
  // host functions, creates the executor, pushes every schema).
  WasmExecutorDriver driver;
  REQUIRE(driver.init(executorWasmDir(), &rt, backend.get(), registry.schemas()));

  // A brightness/contrast chain (brightens) — exercises params + a real render.
  const std::string sketch = R"JSON({
    "chain": [ { "module_type": "video.brightness_contrast", "instance_key": "k0" } ],
    "instances": { "k0": { "module_type": "video.brightness_contrast",
                           "state": { "brightness": 0.8, "contrast": 0.5 } } },
    "wires": []
  })JSON";

  const uint32_t W = 32, H = 32, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 96);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);

  // --- Reference: the native in-process executor on the same sketch. ---
  std::vector<uint8_t> nativeOut;
  {
    SketchExecutor nativeEx(&rt, &registry, backend.get());
    auto j = nlohmann::json::parse(sketch);
    int32_t h = nativeEx.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    nativeOut = backend->readbackTexture(h, W, H);
  }
  REQUIRE(nativeOut.size() == W * H * 4);
  CHECK(mean_rgb(nativeOut) > inMean + 20.0);  // it brightened

  // --- executor.wasm on the same sketch, via the driver. ---
  int32_t wasmHandle = driver.execute(&rt, sketch, inTex, outTex,
                                      (int)W, (int)H, 1.0 / 60.0, /*dirty=*/true);
  backend->submit();
  auto wasmOut = backend->readbackTexture(wasmHandle, W, H);
  REQUIRE(wasmOut.size() == W * H * 4);

  INFO("native mean " << mean_rgb(nativeOut) << "  wasm mean " << mean_rgb(wasmOut)
       << (driver.usingAot() ? "  (AOT)" : "  (interp)"));
  // Byte-identical: same executor source, same effects, same backend.
  size_t diffs = 0;
  for (size_t i = 0; i < wasmOut.size(); ++i) if (wasmOut[i] != nativeOut[i]) ++diffs;
  CHECK(diffs == 0);
}
