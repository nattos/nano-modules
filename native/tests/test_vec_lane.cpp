// test_vec_lane.cpp — modulating ONE component of a vector field.
//
// A vector field is one field with a width; a wire (or an automation curve) may
// drive all of it or a single LANE. These assert on rendered pixels because the
// pixel is the only thing that proves the components reached the EFFECT in the
// right slots — telemetry only proves what the executor computed. The per-lane
// modulation bands are checked alongside, since their key format
// (`field#lane`) is what the editor looks a component's band up by.
//
// The case that matters most is the one this feature exists for: before it, a
// float wire into a float2/3 field called setParamFloat, the effect's patchVec
// read no components, and the field snapped to the origin. That is the
// "broadcast, not black" section.
//
// util.dashboard supplies constant floats; source.solid_color is the visible
// consumer (an rgbField, so a real float3 with a declared [0,1] per component).

#include <catch2/catch_test_macros.hpp>

#include <string>
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

struct RGB { double r, g, b; };

RGB meanRGB(const std::vector<uint8_t>& px) {
  double r = 0, g = 0, b = 0;
  size_t n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; ++n; }
  return n ? RGB{r / n, g / n, b / n} : RGB{-1, -1, -1};
}

// Dashboard knobs into solid_color's rgb `color`, whose authored value is a
// dark grey — so a lane that IS driven separates visibly from the two that
// aren't, and "everything went black" can't be mistaken for success.
std::string sketchWith(const std::string& wires, const std::string& fieldOptions = "") {
  return std::string(R"JSON({
  "chain": [
    { "type":"module","module_type":"util.dashboard","instance_key":"d@0" },
    { "type":"module","module_type":"source.solid_color","instance_key":"fill")JSON")
    + (fieldOptions.empty() ? "" : ", \"fieldOptions\": " + fieldOptions) + R"JSON( }
  ],
  "instances": {
    "d@0":  { "module_type":"util.dashboard","state":{ "knob_0":0.75, "knob_1":0.25 } },
    "fill": { "module_type":"source.solid_color","state":{ "color":[0.1,0.1,0.1] } }
  },
  "wires": )JSON" + wires + "\n}";
}

}  // namespace

TEST_CASE("a wire drives one lane of a vector field", "[vec_lane]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(kCoreWasm, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> black(W * H * 4, 0);
  backend->writeTexture(inTex, W, H, black.data(), (uint32_t)black.size());

  // Fresh executor per run: modulation telemetry and delay state are per-frame
  // / per-instance, and a shared one would carry a previous section's fold in.
  struct Run { RGB rgb; json md; };
  auto run = [&](const std::string& js, const json& automation = json::array()) -> Run {
    sketch_executor::SketchExecutor ex(&rt, &registry, backend.get());
    if (!automation.empty()) ex.setAutomation(automation);
    auto sketch = json::parse(js);
    int32_t out = ex.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    return Run{meanRGB(backend->readbackTexture(out, W, H)), ex.lastModulationData()};
  };

  SECTION("dest.lane moves only that component") {
    const Run r = run(sketchWith(R"JSON([
      { "id":"w","combine":"replace",
        "src":{"instanceKey":"d@0","field":"knob_0"},
        "dest":{"instanceKey":"fill","field":"color","lane":2} }
    ])JSON"));
    INFO("mean rgb = " << r.rgb.r << "," << r.rgb.g << "," << r.rgb.b);
    // Blue := 0.75 (~191); red and green keep the authored 0.1 (~26).
    CHECK(r.rgb.b > 150.0);
    CHECK(r.rgb.r < 60.0);
    CHECK(r.rgb.g < 60.0);
    // The band lands under the LANE key, and only that lane has one.
    REQUIRE(r.md.contains("fill"));
    CHECK(r.md["fill"].contains("color#2"));
    CHECK_FALSE(r.md["fill"].contains("color#0"));
    CHECK_FALSE(r.md["fill"].contains("color#1"));
    // ...and never under the bare field name, which is a schema key.
    CHECK_FALSE(r.md["fill"].contains("color"));
  }

  SECTION("a scalar into a vector broadcasts — the field does NOT snap to black") {
    // THE regression this feature exists for: this used to call setParamFloat
    // on a float3, the effect read no components, and the fill went to (0,0,0).
    const Run r = run(sketchWith(R"JSON([
      { "id":"w","combine":"replace",
        "src":{"instanceKey":"d@0","field":"knob_0"},
        "dest":{"instanceKey":"fill","field":"color"} }
    ])JSON"));
    INFO("mean rgb = " << r.rgb.r << "," << r.rgb.g << "," << r.rgb.b);
    CHECK(r.rgb.r > 150.0);
    CHECK(r.rgb.g > 150.0);
    CHECK(r.rgb.b > 150.0);
    // Every driven lane gets its own band.
    REQUIRE(r.md.contains("fill"));
    CHECK(r.md["fill"].contains("color#0"));
    CHECK(r.md["fill"].contains("color#1"));
    CHECK(r.md["fill"].contains("color#2"));
  }

  SECTION("convert:truncate drives lane 0 alone") {
    const Run r = run(sketchWith(R"JSON([
      { "id":"w","combine":"replace","convert":"truncate",
        "src":{"instanceKey":"d@0","field":"knob_0"},
        "dest":{"instanceKey":"fill","field":"color"} }
    ])JSON"));
    INFO("mean rgb = " << r.rgb.r << "," << r.rgb.g << "," << r.rgb.b);
    CHECK(r.rgb.r > 150.0);
    CHECK(r.rgb.g < 60.0);
    CHECK(r.rgb.b < 60.0);
  }

  SECTION("two wires own two lanes of one field independently") {
    // The accumulator + single flush: a per-tap setParamArray would let the
    // second wire's whole-array write wipe the first wire's lane.
    const Run r = run(sketchWith(R"JSON([
      { "id":"w0","combine":"replace",
        "src":{"instanceKey":"d@0","field":"knob_0"},
        "dest":{"instanceKey":"fill","field":"color","lane":0} },
      { "id":"w2","combine":"replace",
        "src":{"instanceKey":"d@0","field":"knob_1"},
        "dest":{"instanceKey":"fill","field":"color","lane":2} }
    ])JSON"));
    INFO("mean rgb = " << r.rgb.r << "," << r.rgb.g << "," << r.rgb.b);
    CHECK(r.rgb.r > 150.0);          // knob_0 = 0.75
    CHECK(r.rgb.g < 60.0);           // untouched, authored 0.1
    CHECK(r.rgb.b > 40.0);           // knob_1 = 0.25 (~64)
    CHECK(r.rgb.b < 110.0);
    CHECK(r.md["fill"].contains("color#0"));
    CHECK(r.md["fill"].contains("color#2"));
    CHECK_FALSE(r.md["fill"].contains("color#1"));
  }

  SECTION("smoothing on a vector field does not zero it") {
    // applySmoothing only knows how to setParamFloat; the field card offers
    // smoothing on any field, so an unguarded pass reproduced the black-fill
    // bug by a second route.
    const Run r = run(sketchWith(R"JSON([
      { "id":"w","combine":"replace",
        "src":{"instanceKey":"d@0","field":"knob_0"},
        "dest":{"instanceKey":"fill","field":"color","lane":2} }
    ])JSON", R"JSON({ "color": { "smoothing": { "enabled": true, "duration": 0.5 } } })JSON"));
    INFO("mean rgb = " << r.rgb.r << "," << r.rgb.g << "," << r.rgb.b);
    CHECK(r.rgb.b > 150.0);
    CHECK(r.rgb.r < 60.0);
  }
}

TEST_CASE("automation drives one lane of a vector field", "[vec_lane]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(kCoreWasm, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> black(W * H * 4, 0);
  backend->writeTexture(inTex, W, H, black.data(), (uint32_t)black.size());

  auto run = [&](const json& automation) -> RGB {
    sketch_executor::SketchExecutor ex(&rt, &registry, backend.get());
    ex.setAutomation(automation);
    auto sketch = json::parse(sketchWith("[]"));
    int32_t out = ex.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    return meanRGB(backend->readbackTexture(out, W, H));
  };

  SECTION("a lane-addressed curve moves only its component") {
    const RGB got = run(json::array({
      json{{"instance", "fill"}, {"field", "color"}, {"lane", 1}, {"value", 0.8},
           {"combine", "replace"}, {"magnitude", "unsigned"}}}));
    INFO("mean rgb = " << got.r << "," << got.g << "," << got.b);
    CHECK(got.g > 150.0);
    CHECK(got.r < 60.0);
    CHECK(got.b < 60.0);
  }

  SECTION("two lanes carry independent curves") {
    const RGB got = run(json::array({
      json{{"instance", "fill"}, {"field", "color"}, {"lane", 0}, {"value", 0.8},
           {"combine", "replace"}, {"magnitude", "unsigned"}},
      json{{"instance", "fill"}, {"field", "color"}, {"lane", 2}, {"value", 0.3},
           {"combine", "replace"}, {"magnitude", "unsigned"}}}));
    INFO("mean rgb = " << got.r << "," << got.g << "," << got.b);
    CHECK(got.r > 150.0);
    CHECK(got.g < 60.0);            // untouched
    CHECK(got.b > 50.0);
    CHECK(got.b < 125.0);
  }

  SECTION("a curve with no lane drives the whole field") {
    const RGB got = run(json::array({
      json{{"instance", "fill"}, {"field", "color"}, {"value", 0.8},
           {"combine", "replace"}, {"magnitude", "unsigned"}}}));
    INFO("mean rgb = " << got.r << "," << got.g << "," << got.b);
    CHECK(got.r > 150.0);
    CHECK(got.g > 150.0);
    CHECK(got.b > 150.0);
  }
}

TEST_CASE("a vector source reaching a scalar field takes component 0", "[vec_lane]") {
  // The "never refuse" rule in the direction the vector path doesn't cover: the
  // float branch must accept a vec rail rather than drop the wire silently.
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(kCoreWasm, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  sketch_executor::SketchExecutor ex(&rt, &registry, backend.get());
  auto sketch = json::parse(R"JSON({
    "chain": [
      { "type":"module","module_type":"mod.source.color","instance_key":"col" },
      { "type":"module","module_type":"util.sketch_output","instance_key":"so@0" }
    ],
    "instances": {
      "col":  { "module_type":"mod.source.color","state":{ "color":[0.2,0.4,0.8] } },
      "so@0": { "module_type":"util.sketch_output","state":{} }
    },
    "wires": [
      { "id":"w","combine":"replace",
        "src":{"instanceKey":"col","field":"color"},
        "dest":{"instanceKey":"so@0","field":"out_0"} }
    ]
  })JSON");
  ex.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  const auto& md = ex.lastModulationData();
  REQUIRE(md.contains("so@0"));
  REQUIRE(md["so@0"].contains("out_0"));
  // Component 0 of (0.2, 0.4, 0.8) — not the green, not a sum, not dropped.
  CHECK(md["so@0"]["out_0"].value("value", -1.0) > 0.15);
  CHECK(md["so@0"]["out_0"].value("value", -1.0) < 0.25);
}
