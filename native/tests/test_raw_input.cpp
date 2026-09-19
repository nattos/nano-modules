// test_raw_input.cpp — the `raw` input contract.
//
// A schema field marked `raw` (host.h's Schema::raw()) declares that its
// [min,max] is a UI affordance, not a modulation-range contract: the executor's
// wire lowering skips the magnitude fold for it (destIsRaw in
// sketch_executor.cpp) so the wire's shaped value arrives unmapped.
//
// debug.raw_probe exists precisely to make that observable: two float inputs
// identical in type, range ([-1,1]) and polarity, one raw and one not. A source
// at 0.5 folds to 0.0 on the plain input (unsigned → the midpoint of [-1,1])
// and stays 0.5 on the raw one. The pair is asserted in ONE run so no
// difference in setup can explain the gap.
//
// Both drive paths are covered, because the lowering has TWO magnitude sites:
// module-to-module wires and external (midi:) rails.

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

namespace {

// Both probe inputs driven from the SAME external control, so the only
// difference between the two read taps is the dest field's `raw` flag.
nlohmann::json externalWireSketch() {
  return nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src",
        "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "debug.raw_probe", "instance_key": "probe", "params": {} }
    ],
    "wires": [
      { "id": "w_plain", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "probe", "field": "plain" }, "combine": "replace" },
      { "id": "w_raw", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "probe", "field": "rawv" }, "combine": "replace" }
    ]
  })JSON");
}

// The module-to-module path. The source is `mod.shaper.add` with one authored
// input rather than an oscillator: it republishes a steady 0.5 every tick, so
// the assertion lands on the fold instead of on where in its cycle an LFO
// happened to be.
//
// It also has to be an UNSIGNED [0,1] output. mod.source.lfo declares its
// output signed [-1,1] — identical to the probe's declared range — which makes
// applyMagnitude the identity map and leaves the two inputs indistinguishable.
// A source range that differs from the dest range is the whole point of the
// fixture; picking one that doesn't is how this case reads as passing while
// testing nothing.
nlohmann::json moduleWireSketch() {
  return nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src",
        "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "mod.shaper.add", "instance_key": "add",
        "params": { "input_1": 0.5, "input_2": 0.0, "input_count": 2 } },
      { "module_type": "debug.raw_probe", "instance_key": "probe", "params": {} }
    ],
    "wires": [
      { "id": "w_plain", "src": { "instanceKey": "add", "field": "output" },
        "dest": { "instanceKey": "probe", "field": "plain" }, "combine": "replace" },
      { "id": "w_raw", "src": { "instanceKey": "add", "field": "output" },
        "dest": { "instanceKey": "probe", "field": "rawv" }, "combine": "replace" }
    ]
  })JSON");
}

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  sketch_executor::WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;
  std::unique_ptr<sketch_executor::SketchExecutor> executor;
  int inTex = 0, outTex = 0;
  static constexpr uint32_t W = 16, H = 16;
};

}  // namespace

TEST_CASE("a `raw` dest skips the magnitude fold; its plain twin does not",
          "[raw_input]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  // raw_probe lives in testonly; core supplies solid_color + the LFO.
  REQUIRE(bundles.loadBundleFile(kCoreWasm, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(kTestonlyWasm, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  SECTION("external (midi:) rail") {
    auto sketch = externalWireSketch();
    executor.setExternalScalars(nlohmann::json::parse(
        R"({"midi:dev-1": {"b0/e05/turn": 0.5}})"));
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();

    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("probe"));
    REQUIRE(md["probe"].contains("plain"));
    REQUIRE(md["probe"].contains("rawv"));

    // Plain: unsigned 0.5 folded into the declared [-1,1] → the midpoint.
    CHECK(md["probe"]["plain"]["value"].get<double>() == Approx(0.0).margin(1e-4));
    // Raw: the same 0.5, unmapped.
    CHECK(md["probe"]["rawv"]["value"].get<double>() == Approx(0.5).margin(1e-4));

    // The band is the sweep of the SAME fold over the source range, so it moves
    // with the value: [-1,1] for the folded input, [0,1] for the raw one. This
    // is what the editor draws, and getting it from the shared fold (rather than
    // a second code path) is why it can't drift from the live value.
    CHECK(md["probe"]["plain"]["min"].get<double>() == Approx(-1.0).margin(1e-4));
    CHECK(md["probe"]["plain"]["max"].get<double>() == Approx(1.0).margin(1e-4));
    CHECK(md["probe"]["rawv"]["min"].get<double>() == Approx(0.0).margin(1e-4));
    CHECK(md["probe"]["rawv"]["max"].get<double>() == Approx(1.0).margin(1e-4));
  }

  SECTION("module-to-module wire") {
    auto sketch = moduleWireSketch();
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();

    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("probe"));
    REQUIRE(md["probe"].contains("plain"));
    REQUIRE(md["probe"].contains("rawv"));

    const double plain = md["probe"]["plain"]["value"].get<double>();
    const double rawv  = md["probe"]["rawv"]["value"].get<double>();
    INFO("plain=" << plain << " rawv=" << rawv);
    // Raw receives the published 0.5 verbatim; plain gets it mapped from the
    // source's unsigned [0,1] into the dest's [-1,1] — the midpoint. Stated as
    // the RELATION as well as the absolutes, so the case still says something
    // if the fixture's authored value moves.
    CHECK(rawv == Approx(0.5).margin(1e-4));
    CHECK(plain == Approx(0.0).margin(1e-4));
    CHECK(plain == Approx(rawv * 2.0 - 1.0).margin(1e-3));
    CHECK(plain != Approx(rawv).margin(1e-3));   // the fold is not a no-op here
    // Bands diverge too — the folded input sweeps the full dest range, the raw
    // one only the source's.
    CHECK(md["probe"]["rawv"]["max"].get<double>() == Approx(1.0).margin(1e-4));
    CHECK(md["probe"]["rawv"]["min"].get<double>() == Approx(0.0).margin(1e-4));
    CHECK(md["probe"]["plain"]["min"].get<double>() == Approx(-1.0).margin(1e-4));
  }
}
