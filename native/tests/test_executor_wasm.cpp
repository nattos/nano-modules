// test_executor_wasm.cpp — the B3 end-to-end proof: drive the unified
// executor.wasm through WAMR against the native EffectRuntime + Metal backend,
// and assert it renders pixel-identical to the in-process native executor.
//
// Flow: load core.wasm effects into a ModuleRegistry/EffectRuntime; register the
// "effrt" host functions + bind the runtime; load executor.wasm, point its GPU
// at the same backend; create the executor, push every schema, run one frame via
// executor_execute (sketch JSON marshalled into linear memory). Compare to a
// native SketchExecutor running the same sketch.

#include <catch2/catch_test_macros.hpp>

#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "bridge/param_cache.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/executor_host.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"
#include "wasm/wasm_host.h"

using effect_runtime::EffectRuntime;
using sketch_executor::ModuleRegistry;
using sketch_executor::SketchExecutor;
using sketch_executor::WasmEffectBundles;

namespace sketch_executor { void effrtSetRuntime(effect_runtime::EffectRuntime*); }

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif
#ifndef EXECUTOR_WASM_PATH
#error "EXECUTOR_WASM_PATH must be defined"
#endif

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg(); f.seekg(0);
  std::vector<uint8_t> buf((size_t)size);
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}
static double mean_rgb(const std::vector<uint8_t>& px) {
  long s = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { s += px[i] + px[i+1] + px[i+2]; n += 3; }
  return n ? (double)s / n : 0.0;
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

  REQUIRE(sketch_executor::registerEffrtHostFunctions());
  sketch_executor::effrtSetRuntime(&rt);

  // --- Load executor.wasm; point its GPU imports at the same backend. ---
  auto execBytes = load_file(EXECUTOR_WASM_PATH);
  REQUIRE(!execBytes.empty());
  bridge::ParamCache cache;
  wasm::WasmHost host(cache);
  REQUIRE(host.init());
  int32_t mod = host.load_module(execBytes.data(), (uint32_t)execBytes.size());
  INFO("load: " << host.last_error());
  REQUIRE(mod >= 0);
  host.set_gpu_backend(mod, backend.get());

  // Helper: copy bytes into the module's linear memory, return the app offset.
  auto pushBytes = [&](const void* data, size_t len) -> uint32_t {
    void* native = nullptr;
    uint32_t off = host.app_malloc(mod, (uint32_t)len, &native);
    if (off && native && len) std::memcpy(native, data, len);
    return off;
  };

  // executor_create() -> SketchExecutor* (wasm offset).
  uint32_t argv[16] = {0};
  REQUIRE(host.call_export_v(mod, "executor_create", 0, argv));
  uint32_t ex = argv[0];
  REQUIRE(ex != 0);

  // Push every effect's schema into the wasm executor.
  for (const auto& kv : registry.schemas()) {
    const std::string& mt = kv.first;
    std::string schema = kv.second.dump();
    uint32_t mtOff = pushBytes(mt.data(), mt.size());
    uint32_t scOff = pushBytes(schema.data(), schema.size());
    uint32_t a[5] = {ex, mtOff, (uint32_t)mt.size(), scOff, (uint32_t)schema.size()};
    REQUIRE(host.call_export_v(mod, "executor_register_schema", 5, a));
    host.app_free(mod, mtOff);
    host.app_free(mod, scOff);
  }

  // A brightness/contrast chain (brightens) — exercises params + a real render.
  const char* sketch = R"JSON({
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

  // --- executor.wasm on the same sketch. Re-bind the runtime (the wasm path
  // doesn't call effrtSetRuntime itself). ---
  sketch_executor::effrtSetRuntime(&rt);
  uint32_t skOff = pushBytes(sketch, std::strlen(sketch));
  uint32_t a[10] = {0};
  a[0] = ex; a[1] = skOff; a[2] = (uint32_t)std::strlen(sketch);
  a[3] = (uint32_t)inTex; a[4] = (uint32_t)outTex; a[5] = W; a[6] = H;
  double dt = 1.0 / 60.0;
  std::memcpy(&a[7], &dt, sizeof(double));  // f64 dt occupies a[7..8]
  a[9] = 1;  // dirty
  REQUIRE(host.call_export_v(mod, "executor_execute", 10, a));
  int32_t wasmHandle = (int32_t)a[0];
  backend->submit();
  auto wasmOut = backend->readbackTexture(wasmHandle, W, H);
  REQUIRE(wasmOut.size() == W * H * 4);

  INFO("native mean " << mean_rgb(nativeOut) << "  wasm mean " << mean_rgb(wasmOut));
  // Byte-identical: same executor source, same effects, same backend.
  size_t diffs = 0;
  for (size_t i = 0; i < wasmOut.size(); ++i) if (wasmOut[i] != nativeOut[i]) ++diffs;
  CHECK(diffs == 0);

  uint32_t d[1] = {ex};
  host.call_export_v(mod, "executor_destroy", 1, d);
  host.shutdown();
}
