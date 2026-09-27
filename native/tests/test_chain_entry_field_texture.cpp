// test_chain_entry_field_texture.cpp — SketchExecutor::chainEntryFieldTexture,
// the lookup behind an effect card's thumbnail for a NON-primary texture
// output (the barrel's `cef:` preview requests).
//
// The chain-entry hook only reports a stage's primary output, so a second
// texture output previewed the primary's pixels. debug.secondary_output
// (testonly) makes that visible: its primary is solid red, `side_out` solid
// blue.

#include <catch2/catch_test_macros.hpp>

#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;
using sketch_executor::ModuleRegistry;
using sketch_executor::SketchExecutor;
using sketch_executor::WasmEffectBundles;

#include "wasm_paths.h"

namespace {

struct Rgb { double r = 0, g = 0, b = 0; };

Rgb mean(const std::vector<uint8_t>& px) {
  Rgb m;
  size_t n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4, ++n) {
    m.r += px[i]; m.g += px[i + 1]; m.b += px[i + 2];
  }
  if (n) { m.r /= n; m.g /= n; m.b /= n; }
  return m;
}

}  // namespace

TEST_CASE("chainEntryFieldTexture resolves a secondary texture output",
          "[trace][chain_entry_field]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device");
  WasmEffectBundles bundles;
  if (!bundles.init()) SKIP("No wasm runtime");
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  if (bundles.loadBundleFile(kTestonlyWasm, registry, backend.get(), nullptr) <= 1)
    SKIP("testonly.wasm not built");

  const uint32_t W = 32, H = 32;
  const int RGBA8 = 1;
  const int inTex = backend->createTexture(W, H, RGBA8);
  const int outTex = backend->createTexture(W, H, RGBA8);

  SketchExecutor ex(&rt, &registry, backend.get());
  int32_t hookOut = -1;
  ex.setChainEntryHook([&](int col, int chain, int32_t, int32_t out, int, int) {
    if (col == 0 && chain == 0) hookOut = out;
  });

  const nlohmann::json sk = {
    {"chain", {{{"type", "module"}, {"module_type", "debug.secondary_output"},
                {"instance_key", "so@0"}}}},
    {"instances", {{"so@0", {{"module_type", "debug.secondary_output"},
                             {"state", nlohmann::json::object()}}}}},
    {"wires", nlohmann::json::array()},
  };
  ex.execute(sk, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);

  const int32_t side = ex.chainEntryFieldTexture(0, 0, "side_out");
  REQUIRE(side > 0);
  REQUIRE(hookOut > 0);
  CHECK(side != hookOut);
  backend->submit();

  // The primary (what the chain-entry hook reports) is red...
  const Rgb primary = mean(backend->readbackTexture(hookOut, W, H));
  CHECK(primary.r > 200);
  CHECK(primary.b < 40);
  // ...and the field lookup finds the blue secondary, not the primary.
  const Rgb secondary = mean(backend->readbackTexture(side, W, H));
  CHECK(secondary.b > 200);
  CHECK(secondary.r < 40);

  SECTION("misses resolve -1") {
    CHECK(ex.chainEntryFieldTexture(0, 0, "no_such_field") == -1);
    CHECK(ex.chainEntryFieldTexture(0, 1, "side_out") == -1);
    CHECK(ex.chainEntryFieldTexture(1, 0, "side_out") == -1);
    CHECK(ex.chainEntryFieldTexture(0, 0, "") == -1);
  }
}
