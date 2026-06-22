// test_executor_wasm.cpp — the end-to-end proof: drive the unified executor.wasm
// (via WasmExecutorDriver — the SAME driver the barrel + benchmark use) against
// the native EffectRuntime + Metal backend, and assert it renders pixel-identical
// to the in-process native SketchExecutor. Also covers the driver itself.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
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
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "k0" } ],
    "instances": { "k0": { "module_type": "color.tone.brightness_contrast",
                           "state": { "brightness": 0.5, "contrast": 0.0 } } },
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

TEST_CASE("util.dashboard pure-output knob publishes its authored value", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  // White input → dashboard (knob_0 = 0.5, no input wire) → brightness_contrast.
  // The knob's AUTHORED value drives brightness via the output wire: 0.5 folds to
  // neutral, contrast -0.5 → gray. If the authored knob value doesn't reach the
  // wire, brightness stays its stored 1.0 → white.
  const std::string sketch = R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash@0" },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "bc@0" }
    ],
    "instances": {
      "dash@0": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } },
      "bc@0": { "module_type": "color.tone.brightness_contrast",
                "state": { "brightness": 1.0, "contrast": -0.5 } }
    },
    "wires": [
      { "id": "wout", "src": { "instanceKey": "dash@0", "field": "knob_0" },
        "dest": { "instanceKey": "bc@0", "field": "brightness" } }
    ]
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 255);  // white
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(&rt, &registry, backend.get());
  auto j = nlohmann::json::parse(sketch);
  int32_t h = ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto out = backend->readbackTexture(h, W, H);
  REQUIRE(out.size() == W * H * 4);

  const double m = mean_rgb(out);
  INFO("output mean " << m << " (gray~128 = knob drove brightness; white~255 = wire dropped)");
  CHECK(m < 200.0);            // not white — the knob value reached brightness
  CHECK(std::abs(m - 128.0) < 24.0);  // gray
}

TEST_CASE("util.sketch_output captures a producer's scalar on an output trace", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  // White input → dashboard (knob_0 = 0.5, the PRODUCER) → util.sketch_output.
  // The wire writes the knob value INTO the sketch-output trace out_0. The image
  // is untouched (both effects are identity), and the written value surfaces as
  // modulation telemetry on so@0/out_0 (it never reaches pluginState — see the
  // web getValue→modulationData branch).
  const std::string sketch = R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash@0" },
      { "type": "module", "module_type": "util.sketch_output", "instance_key": "so@0" }
    ],
    "instances": {
      "dash@0": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } },
      "so@0": { "module_type": "util.sketch_output", "state": {} }
    },
    "wires": [
      { "id": "win", "src": { "instanceKey": "dash@0", "field": "knob_0" },
        "dest": { "instanceKey": "so@0", "field": "out_0" } }
    ]
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 255);  // white
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(&rt, &registry, backend.get());
  auto j = nlohmann::json::parse(sketch);
  int32_t h = ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto out = backend->readbackTexture(h, W, H);
  REQUIRE(out.size() == W * H * 4);

  // Image passes through untouched — sketch_output is identity.
  const double m = mean_rgb(out);
  INFO("output mean " << m << " (should be ~255 white — identity passthrough)");
  CHECK(m > 240.0);

  // The wire-written value reached out_0 and was recorded as modulation telemetry.
  const auto& md = ex.lastModulationData();
  REQUIRE(md.contains("so@0"));
  REQUIRE(md["so@0"].contains("out_0"));
  const double v = md["so@0"]["out_0"].value("value", -1.0);
  INFO("out_0 modulation value " << v << " (knob_0 = 0.5 folded into [0,1])");
  CHECK(std::abs(v - 0.5) < 0.1);
}
