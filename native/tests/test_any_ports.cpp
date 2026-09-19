// test_any_ports.cpp — polymorphic (`any`) ports END TO END through the executor.
//
// test_wire_types.cpp pins the resolution RULE against the shared fixture; this
// pins that the rule is actually wired into rail lowering, and that the rail it
// picks really carries the data. Those are different failures: the resolver can
// be perfectly correct while nothing calls it.
//
// debug.any_probe reports which channel a value arrived on — `saw_float` is the
// number patched into `in_a`, `saw_texture` goes to 1 when a texture handle was
// bound there instead. A float rail and a texture rail deliver through entirely
// different mechanisms, so those two outputs distinguish them unambiguously.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

#include "wasm_paths.h"

using effect_runtime::EffectRuntime;
using Catch::Approx;
using nlohmann::json;

namespace {

// A float producer (mod.shaper.add with an authored input publishes a steady
// value) into the probe's first `any` input.
const char* kFloatWire = R"JSON({
  "chain": [
    { "module_type": "source.solid_color", "instance_key": "src",
      "params": { "color": [1.0,1.0,1.0] } },
    { "module_type": "mod.shaper.add", "instance_key": "add",
      "params": { "input_1": 0.5, "input_2": 0.0, "input_count": 2 } },
    { "module_type": "debug.any_probe", "instance_key": "probe", "params": {} },
    { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
      "params": { "brightness": 0.0, "contrast": 0.0 } }
  ],
  "wires": [
    { "id": "w", "src": { "instanceKey": "add", "field": "output" },
      "dest": { "instanceKey": "probe", "field": "in_a" }, "combine": "replace" },
    { "id": "r_sf", "src": { "instanceKey": "probe", "field": "saw_float" },
      "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" },
    { "id": "r_st", "src": { "instanceKey": "probe", "field": "saw_texture" },
      "dest": { "instanceKey": "bc", "field": "contrast" }, "combine": "replace" }
  ]
})JSON";

// The SAME probe field, fed a texture instead. Nothing about the probe changes.
const char* kTextureWire = R"JSON({
  "chain": [
    { "module_type": "source.solid_color", "instance_key": "src",
      "params": { "color": [1.0,1.0,1.0] } },
    { "module_type": "debug.any_probe", "instance_key": "probe", "params": {} },
    { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
      "params": { "brightness": 0.0, "contrast": 0.0 } }
  ],
  "wires": [
    { "id": "w", "src": { "instanceKey": "src", "field": "tex_out" },
      "dest": { "instanceKey": "probe", "field": "in_a" }, "combine": "replace" },
    { "id": "r_sf", "src": { "instanceKey": "probe", "field": "saw_float" },
      "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" },
    { "id": "r_st", "src": { "instanceKey": "probe", "field": "saw_texture" },
      "dest": { "instanceKey": "bc", "field": "contrast" }, "combine": "replace" }
  ]
})JSON";

// Both classes at once, wired to DIFFERENT inputs: in_a is declared first, so it
// decides. Wire order in the array deliberately puts the texture first, so a
// resolver that took "first wire seen" instead of "lowest-numbered input" would
// answer texture here.
const char* kTieBreak = R"JSON({
  "chain": [
    { "module_type": "source.solid_color", "instance_key": "src",
      "params": { "color": [1.0,1.0,1.0] } },
    { "module_type": "mod.shaper.add", "instance_key": "add",
      "params": { "input_1": 0.5, "input_2": 0.0, "input_count": 2 } },
    { "module_type": "debug.any_probe", "instance_key": "probe", "params": {} },
    { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
      "params": { "brightness": 0.0, "contrast": 0.0 } }
  ],
  "wires": [
    { "id": "wt", "src": { "instanceKey": "src", "field": "tex_out" },
      "dest": { "instanceKey": "probe", "field": "in_b" }, "combine": "replace" },
    { "id": "wf", "src": { "instanceKey": "add", "field": "output" },
      "dest": { "instanceKey": "probe", "field": "in_a" }, "combine": "replace" },
    { "id": "r_sf", "src": { "instanceKey": "probe", "field": "saw_float" },
      "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" },
    { "id": "r_st", "src": { "instanceKey": "probe", "field": "saw_texture" },
      "dest": { "instanceKey": "bc", "field": "contrast" }, "combine": "replace" }
  ]
})JSON";

// A float rail's current value, by wire id. The probe's telemetry outputs are
// wired onward precisely so they land here: a rail carries the producer's
// published value (first writer seeds it, and these wires declare no mod), so
// this reads the effect's own answer without needing an instance handle.
double rail(sketch_executor::SketchExecutor& ex, const char* wireId) {
  const json& st = ex.lastRailState();
  if (!st.is_object() || !st.contains("columns/0")) return -999.0;
  const json& col = st.at("columns/0");
  if (!col.is_object() || !col.contains(wireId)) return -999.0;
  return col.at(wireId).value("value", -999.0);
}

}  // namespace

TEST_CASE("an `any` port resolves to the rail its producer actually carries",
          "[any_ports]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(kCoreWasm, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(kTestonlyWasm, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  auto run = [&](const char* js) {
    auto sketch = json::parse(js);
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
  };

  SECTION("a float producer makes it a float rail") {
    run(kFloatWire);
    INFO("railState = " << executor.lastRailState().dump());
    CHECK(rail(executor, "r_st") == Approx(0.0).margin(1e-4));
    // The value arrived as a state patch, verbatim: `any` implies raw, so no
    // magnitude fold mapped it anywhere.
    CHECK(rail(executor, "r_sf") == Approx(0.5).margin(1e-4));
  }

  SECTION("a texture producer makes it a texture rail") {
    run(kTextureWire);
    INFO("railState = " << executor.lastRailState().dump());
    CHECK(rail(executor, "r_st") == Approx(1.0).margin(1e-4));
    // Nothing came through the scalar channel — proving the two are genuinely
    // different rails and not one path coincidentally satisfying both.
    CHECK(rail(executor, "r_sf") == Approx(0.0).margin(1e-4));
  }

  SECTION("mixed classes: the lowest-numbered wired input decides") {
    run(kTieBreak);
    INFO("railState = " << executor.lastRailState().dump());
    // in_a (float) is declared before in_b (texture), so the node is float —
    // even though the texture wire comes first in the wires array.
    CHECK(rail(executor, "r_sf") == Approx(0.5).margin(1e-4));
  }
}
