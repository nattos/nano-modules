// test_vec_rail.cpp — vector (colour) values crossing a wire.
//
// Before this, NO vec value could cross a wire at all: rail lowering routed
// float / texture / object|array and dropped everything else with a bare
// `continue`, so a float3 wire silently did nothing. The editor even drew the
// port and labelled the chip "vec3".
//
// A vec rail carries the producer's published component array WHOLE — no
// per-component magnitude fold, no modulation band, because a colour has no
// [min,max] modulation contract to map into. These assert on rendered pixels
// rather than telemetry for exactly that reason: there is no band to read, and
// the pixel is the only thing that proves the components arrived in order.
//
// mod.source.color is the producer (the first vec-rail source in the tree —
// every other vec/rgb field is an input) and source.solid_color the consumer.

#include <catch2/catch_test_macros.hpp>

#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;
using nlohmann::json;

namespace {

// The swatch drives the fill. Distinct per channel so a components-out-of-order
// bug (or a broadcast-the-first-component bug) can't pass: an RGB swap would
// still be "coloured", just wrong.
const char* kColorWire = R"JSON({
  "chain": [
    { "module_type": "mod.source.color", "instance_key": "col",
      "params": { "color": [0.2, 0.4, 0.8] } },
    { "module_type": "source.solid_color", "instance_key": "fill",
      "params": { "color": [0.0, 0.0, 0.0] } }
  ],
  "wires": [
    { "id": "w", "src": { "instanceKey": "col", "field": "color" },
      "dest": { "instanceKey": "fill", "field": "color" }, "combine": "replace" }
  ]
})JSON";

// Same chain, no wire — the consumer keeps its own authored (black) colour.
// Without this the test can't tell "the wire worked" from "solid_color happened
// to be that colour anyway".
const char* kNoWire = R"JSON({
  "chain": [
    { "module_type": "mod.source.color", "instance_key": "col",
      "params": { "color": [0.2, 0.4, 0.8] } },
    { "module_type": "source.solid_color", "instance_key": "fill",
      "params": { "color": [0.0, 0.0, 0.0] } }
  ],
  "wires": []
})JSON";

struct RGB { double r, g, b; };

RGB meanRGB(const std::vector<uint8_t>& px) {
  double r = 0, g = 0, b = 0;
  size_t n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; ++n; }
  return n ? RGB{r / n, g / n, b / n} : RGB{-1, -1, -1};
}

}  // namespace

TEST_CASE("a colour crosses a wire as a vec rail", "[vec_rail]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> black(W * H * 4, 0);
  backend->writeTexture(inTex, W, H, black.data(), (uint32_t)black.size());

  auto runMean = [&](const char* js) {
    auto sketch = json::parse(js);
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    return meanRGB(backend->readbackTexture(out, W, H));
  };

  SECTION("the wired swatch reaches the consumer, component-for-component") {
    const RGB got = runMean(kColorWire);
    INFO("mean rgb = " << got.r << "," << got.g << "," << got.b);
    // 0.2/0.4/0.8 → ~51/102/204. Generous margins (the pipeline may apply
    // transfer curves); what matters is that the three channels are DISTINCT
    // and ordered, which is what pins component order.
    CHECK(got.r > 20.0);   CHECK(got.r < 90.0);
    CHECK(got.g > 70.0);   CHECK(got.g < 140.0);
    CHECK(got.b > 160.0);  CHECK(got.b < 245.0);
    CHECK(got.r < got.g);
    CHECK(got.g < got.b);
  }

  SECTION("without the wire the consumer keeps its own colour") {
    const RGB got = runMean(kNoWire);
    INFO("mean rgb = " << got.r << "," << got.g << "," << got.b);
    CHECK(got.r < 12.0);
    CHECK(got.g < 12.0);
    CHECK(got.b < 12.0);
  }
}
