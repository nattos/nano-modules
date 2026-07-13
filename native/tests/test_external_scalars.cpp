// test_external_scalars.cpp — MIDI device wires through the executor.
//
// A wire whose src.instanceKey is "midi:<uuid>" has no chain entry: the wire
// translation synthesizes an `external`-tagged float rail seeded per frame
// from setExternalScalars (the host's MIDI value table) plus the normal read
// tap on the dest. Asserts the full contract: dormant when unseeded (dest
// keeps its authored value, no modulation band), folded through the standard
// tap pipeline when seeded (magnitude fold into the dest's declared range,
// TapMod remap, modulation-band telemetry), and per-frame value updates
// WITHOUT dirtying the sketch (the cached plan carries the external rail).

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;

static double mean_rgb(const std::vector<uint8_t>& px) {
  long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? static_cast<double>(sum) / n : 0.0;
}

// white -> brightness_contrast with a midi: wire on brightness. brightness's
// declared range is signed [-1,1]; device endpoints are unsigned 0..1, so an
// `auto`-magnitude replace maps device 0.5 -> brightness 0 (neutral grey with
// contrast -0.5, same expectation as the lfo forward-wire repro).
static nlohmann::json deviceWireSketch(const char* wireExtra = "") {
  std::string js = std::string(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
    ],
    "wires": [
      { "id": "w0", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace")JSON")
      + wireExtra + R"JSON( }
    ]
  })JSON";
  return nlohmann::json::parse(js);
}

TEST_CASE("external scalar (midi:) wires fold through the tap pipeline",
          "[external_scalars]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  SECTION("no value pushed → dormant: authored value holds, no band recorded") {
    auto sketch = deviceWireSketch();
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    // Read tap skipped → recordModBand never fires for bc.brightness.
    CHECK((!md.contains("bc") || !md["bc"].contains("brightness")));
  }

  SECTION("seeded value replaces into the dest's declared signed range") {
    auto sketch = deviceWireSketch();
    executor.setExternalScalars(nlohmann::json::parse(
        R"({"midi:dev-1": {"b0/e05/turn": 0.5}})"));
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    auto px = backend->readbackTexture(out, W, H);
    double m = mean_rgb(px);
    INFO("output mean " << m << " (expect ~128 grey: device 0.5 → brightness 0)");
    CHECK(std::abs(m - 128.0) < 20.0);

    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    REQUIRE(md["bc"].contains("brightness"));
    const auto& b = md["bc"]["brightness"];
    CHECK(b["value"].get<double>() == Catch::Approx(0.0).margin(0.01));
    CHECK(b["min"].get<double>()   == Catch::Approx(-1.0).margin(0.01));
    CHECK(b["max"].get<double>()   == Catch::Approx(1.0).margin(0.01));
  }

  SECTION("per-frame value updates ride a CLEAN (cached-plan) execute") {
    auto sketch = deviceWireSketch();
    executor.setExternalScalars(nlohmann::json::parse(
        R"({"midi:dev-1": {"b0/e05/turn": 0.5}})"));
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();

    // New value, dirty=false — the external rail lives in the cached plan.
    executor.setExternalScalars(nlohmann::json::parse(
        R"({"midi:dev-1": {"b0/e05/turn": 1.0}})"));
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, false);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    CHECK(md["bc"]["brightness"]["value"].get<double>() ==
          Catch::Approx(1.0).margin(0.01));   // unsigned 1.0 → dest max

    // Cleared table → dormant again on the next clean frame.
    executor.setExternalScalars(nlohmann::json::object());
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, false);
    backend->submit();
    const auto& md2 = executor.lastModulationData();
    CHECK((!md2.contains("bc") || !md2["bc"].contains("brightness")));
  }

  SECTION("TapMod remap applies in modulation space before the magnitude fold") {
    // Remap squeezes the device's 0..1 into [0.25, 0.75] IN MODULATION SPACE;
    // the unsigned magnitude fold then maps that across brightness's declared
    // [-1,1]: device 0 → 0.25 → -0.5, band [0.25,0.75] → [-0.5,0.5].
    auto sketch = deviceWireSketch(
        R"(, "mod": { "remap": { "inMin": 0.0, "inMax": 1.0, "outMin": 0.25, "outMax": 0.75 } })");
    executor.setExternalScalars(nlohmann::json::parse(
        R"({"midi:dev-1": {"b0/e05/turn": 0.0}})"));
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    const auto& b = md["bc"]["brightness"];
    CHECK(b["value"].get<double>() == Catch::Approx(-0.5).margin(0.01));
    CHECK(b["min"].get<double>()   == Catch::Approx(-0.5).margin(0.01));
    CHECK(b["max"].get<double>()   == Catch::Approx(0.5).margin(0.01));
  }
}

// Regression: persisted state must reach an effect that was DORMANT on the
// dirty frame. The `__enable__` gate returns before maybeApplyState, and state
// application used to be skipped outright on non-dirty frames — so an effect
// whose enable is wire-driven (here: a midi: button, in the field a sidechannel
// scalar) and OFF during the only dirty frame ran its schema DEFAULTS forever
// once the wire woke it. Observed in the wild as "the effect turns on but does
// the wrong thing until any editor patch lands while it happens to be enabled".
TEST_CASE("wire-driven __enable__ wake applies the persisted state",
          "[external_scalars]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  // white source -> bc with authored brightness -0.8 (strongly dark, far from
  // the schema default 0 = identity), persistently disabled, enable driven by
  // a midi: button wire.
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc" }
    ],
    "instances": {
      "bc": { "module_type": "color.tone.brightness_contrast",
              "state": { "__enable__": false, "brightness": -0.8, "contrast": 0.0 } }
    },
    "wires": [
      { "id": "w0", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/press" },
        "dest": { "instanceKey": "bc", "field": "__enable__" }, "combine": "add" }
    ]
  })JSON");

  auto frame = [&](double press, bool dirty) {
    executor.setExternalScalars(nlohmann::json{
        {"midi:dev-1", {{"b0/e05/press", press}}}});
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H,
                                   1.0 / 60.0, dirty);
    backend->submit();
    return mean_rgb(backend->readbackTexture(out, W, H));
  };

  // The ONLY dirty frame: button up -> bc dormant -> pure passthrough (white).
  const double offMean = frame(0.0, /*dirty=*/true);
  CHECK(offMean > 240.0);

  // Button down on a CLEAN frame wakes bc: the authored brightness must apply
  // on this first evaluated frame, not stay at the identity default.
  const double onMean = frame(1.0, /*dirty=*/false);
  INFO("enabled-on-clean-frame mean " << onMean << " (identity default would stay ~255)");
  CHECK(onMean < offMean - 100.0);

  // Steady state holds, and releasing the button restores the passthrough.
  CHECK(frame(1.0, /*dirty=*/false) == Catch::Approx(onMean).margin(4.0));
  CHECK(frame(0.0, /*dirty=*/false) > 240.0);
}

// "Map MIDI to a dashboard knob": a midi: wire modulates dash.knob_0 (a RELAY
// field — both read- and write-tapped), and the knob's outgoing wire must
// forward the MODULATED value, not the knob's authored state (0.25 here, which
// would fold to brightness -0.5 and pin the mean near grey regardless of the
// device). Exercises applyReadTaps → captureWriteTaps' relay publish for an
// external source.
TEST_CASE("midi: wire into a dashboard knob relays through the knob's own wire",
          "[external_scalars]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  // white -> dashboard (identity image) -> bc. Device turn (unsigned 0..1)
  // replaces knob_0; knob_0's wire folds into brightness's signed [-1,1]:
  // device 0 -> brightness -1 (black), device 1 -> brightness +1 (white).
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "util.dashboard", "instance_key": "dash" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc" }
    ],
    "instances": {
      "dash": { "module_type": "util.dashboard", "state": { "knob_0": 0.25 } },
      "bc":   { "module_type": "color.tone.brightness_contrast",
                "state": { "brightness": 0.0, "contrast": 0.0 } }
    },
    "wires": [
      { "id": "w0", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "dash", "field": "knob_0" }, "combine": "replace" },
      { "id": "w1", "src": { "instanceKey": "dash", "field": "knob_0" },
        "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" }
    ]
  })JSON");

  auto frame = [&](double turn, bool dirty) {
    executor.setExternalScalars(nlohmann::json{
        {"midi:dev-1", {{"b0/e05/turn", turn}}}});
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H,
                                   1.0 / 60.0, dirty);
    backend->submit();
    return mean_rgb(backend->readbackTexture(out, W, H));
  };

  const double low = frame(0.0, /*dirty=*/true);
  INFO("device 0.0 mean " << low << " (authored-state relay would sit ~grey)");
  CHECK(low < 40.0);                    // brightness -1: black

  const double high = frame(1.0, /*dirty=*/false);
  INFO("device 1.0 mean " << high);
  CHECK(high > 240.0);                  // brightness +1: white

  // The folded knob value shows up in telemetry for BOTH hops.
  const auto& md = executor.lastModulationData();
  REQUIRE(md.contains("dash"));
  CHECK(md["dash"]["knob_0"]["value"].get<double>() == Catch::Approx(1.0).margin(0.01));
  REQUIRE(md.contains("bc"));
  CHECK(md["bc"]["brightness"]["value"].get<double>() == Catch::Approx(1.0).margin(0.01));
}
