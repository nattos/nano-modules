// test_mod_switch.cpp — mod.shaper.switch under the NATIVE host.
//
// The web twin (web/test/mod-switch.test.ts) covers the same card through the
// engine harness. Both hosts load the same core.wasm and the same
// executor.wasm, so this is not about the switch's own logic diverging — it is
// the house standard that a native-capable effect suite runs on both backends,
// and it exercises the native rail plumbing (vec capture through
// effrt_published_array, texture aliasing out of a node that never renders)
// rather than the browser's.
//
// Colour is the case asserted here because it is the one that reads back
// unambiguously from a pixel: two swatches that differ in which channel
// dominates, so a stuck selector or a dropped rail can't pass.

#include <catch2/catch_test_macros.hpp>

#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

#include "wasm_paths.h"

using effect_runtime::EffectRuntime;
using nlohmann::json;

namespace {

// Two colour swatches into a 2-case switch, the switch into a solid fill.
// `select` is authored: nothing above the switch is a modulation producer
// (mod.source.color is a plain data module), so auto-connect never fires and
// the authored selector stands. Wiring an LFO in here instead would silently
// overwrite it — the trap that ate the first version of the web twin.
json switchSketch(double select, int count = 2) {
  json chain = json::array({
    json{{"module_type", "mod.source.color"}, {"instance_key", "c1"},
         {"params", {{"color", {0.9, 0.1, 0.1}}}}},
    json{{"module_type", "mod.source.color"}, {"instance_key", "c2"},
         {"params", {{"color", {0.1, 0.1, 0.9}}}}},
    json{{"module_type", "mod.shaper.switch"}, {"instance_key", "sw"},
         {"params", {{"select", select}, {"input_count", count}}}},
    json{{"module_type", "source.solid_color"}, {"instance_key", "fill"},
         {"params", {{"color", {0.0, 0.0, 0.0}}}}},
  });
  json wires = json::array({
    json{{"id", "w1"}, {"src", {{"instanceKey", "c1"}, {"field", "color"}}},
         {"dest", {{"instanceKey", "sw"}, {"field", "case_1"}}}, {"combine", "replace"}},
    json{{"id", "w2"}, {"src", {{"instanceKey", "c2"}, {"field", "color"}}},
         {"dest", {{"instanceKey", "sw"}, {"field", "case_2"}}}, {"combine", "replace"}},
    json{{"id", "w3"}, {"src", {{"instanceKey", "sw"}, {"field", "output"}}},
         {"dest", {{"instanceKey", "fill"}, {"field", "color"}}}, {"combine", "replace"}},
  });
  return json{{"chain", chain}, {"wires", wires}};
}

struct RGB { double r, g, b; };

RGB meanRGB(const std::vector<uint8_t>& px) {
  double r = 0, g = 0, b = 0;
  size_t n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; ++n; }
  return n ? RGB{r / n, g / n, b / n} : RGB{-1, -1, -1};
}

}  // namespace

TEST_CASE("mod.shaper.switch selects between polymorphic cases", "[mod_switch]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(kCoreWasm, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> black(W * H * 4, 0);
  backend->writeTexture(inTex, W, H, black.data(), (uint32_t)black.size());

  auto runMean = [&](const json& sketch) {
    json s = sketch;
    int32_t out = executor.execute(s, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    return meanRGB(backend->readbackTexture(out, W, H));
  };

  SECTION("select picks case 1") {
    const RGB c = runMean(switchSketch(0.25));
    INFO("mean rgb = " << c.r << "," << c.g << "," << c.b);
    CHECK(c.r > c.b);          // red-dominant swatch
  }

  SECTION("select picks case 2") {
    const RGB c = runMean(switchSketch(0.75));
    INFO("mean rgb = " << c.r << "," << c.g << "," << c.b);
    CHECK(c.b > c.r);          // blue-dominant swatch
  }

  SECTION("select spans the full range — 1.0 lands on the last case, not past it") {
    // floor(select * count) is `count` exactly at select == 1.0; without the
    // clamp this reads a case that doesn't exist.
    const RGB c = runMean(switchSketch(1.0));
    INFO("mean rgb = " << c.r << "," << c.g << "," << c.b);
    CHECK(c.b > c.r);
  }
}
