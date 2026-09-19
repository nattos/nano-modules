// test_mod_slice.cpp — mod.shaper.slice under the NATIVE host.
//
// The web twin (web/test/mod-slice.test.ts) drives the same card through the
// engine harness; both hosts load the same core.wasm, so this is not about the
// slice math diverging between backends — it is the house standard that a
// native-capable effect suite runs on both, and it pins the rules that are easy
// to break silently: which lane claims a boundary, what Hold does after a lane's
// window, and that lanes above the count stay dark.
//
// The outputs are read through `util.dashboard` knobs rather than pixels. A
// knob is a relay field ([0,1], unsigned) so the fold from an unsigned [0,1]
// output is the identity — the number that lands in lastModulationData IS the
// lane's published value, with no mapping to reason about. Eight knobs also
// happens to be exactly the lane ceiling.
//
// Nothing above the slice is a modulation producer, so the shaper auto-connect
// never fires and the authored `input` stands. Wiring an LFO in here instead
// would silently overwrite it — the trap that ate the first version of the
// switch's web twin.

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
using nlohmann::json;
using Catch::Approx;

namespace {

// A slice with `count` lanes evenly spread over 0..1, every lane's output wired
// to the matching dashboard knob. `extra` overlays params onto the slice card
// (a hand-drawn curve, a moved window edge, a different `beyond`).
json sliceSketch(double input, int count, json extra = json::object()) {
  json params = json{{"input", input}, {"input_count", count}};
  for (int i = 0; i < count; ++i) {
    params["start_" + std::to_string(i + 1)] = double(i) / count;
    params["end_"   + std::to_string(i + 1)] = double(i + 1) / count;
  }
  for (auto it = extra.begin(); it != extra.end(); ++it) params[it.key()] = it.value();

  json chain = json::array({
    json{{"module_type", "source.solid_color"}, {"instance_key", "src"},
         {"params", {{"color", {0.0, 0.0, 0.0}}}}},
    json{{"module_type", "mod.shaper.slice"}, {"instance_key", "sl"}, {"params", params}},
    json{{"module_type", "util.dashboard"}, {"instance_key", "dash"}, {"params", json::object()}},
  });

  json wires = json::array();
  // Always wire all EIGHT lanes, not just the active ones: a lane above the
  // count must be observably dark, and it can only be observed if it's wired.
  for (int i = 0; i < 8; ++i) {
    wires.push_back(json{
      {"id", "w" + std::to_string(i)},
      {"src", {{"instanceKey", "sl"}, {"field", "out_" + std::to_string(i + 1)}}},
      {"dest", {{"instanceKey", "dash"}, {"field", "knob_" + std::to_string(i)}}},
      {"combine", "replace"}});
  }
  return json{{"chain", chain}, {"wires", wires}};
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

TEST_CASE("mod.shaper.slice cuts one signal into windowed outputs", "[mod_slice]") {
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

  // Run one frame and return the four (or eight) knob values the lanes drove.
  auto runLanes = [&](const json& sketch, int n) {
    json s = sketch;
    executor.execute(s, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("dash"));
    std::vector<double> out;
    for (int i = 0; i < n; ++i) {
      const std::string k = "knob_" + std::to_string(i);
      REQUIRE(md["dash"].contains(k));
      out.push_back(md["dash"][k]["value"].get<double>());
    }
    return out;
  };

  SECTION("Gate — a sweep lights each lane in turn, one at a time") {
    // Four quarters, identity curves: inside a window the lane reads the
    // normalized position within it, outside it reads 0.
    for (int lane = 0; lane < 4; ++lane) {
      const double x = (lane + 0.5) / 4.0;              // the middle of lane's window
      const auto v = runLanes(sliceSketch(x, 4), 4);
      INFO("input=" << x << " expecting lane " << lane << " at 0.5");
      for (int i = 0; i < 4; ++i) {
        CHECK(v[i] == Approx(i == lane ? 0.5 : 0.0).margin(1e-4));
      }
    }
  }

  SECTION("Gate — the windows are half-open, so a boundary belongs to one lane") {
    // x == 0.25 is lane 2's start and lane 1's end. [s,e) hands it to lane 2.
    const auto v = runLanes(sliceSketch(0.25, 4), 4);
    CHECK(v[0] == Approx(0.0).margin(1e-4));
    CHECK(v[1] == Approx(0.0).margin(1e-4));    // t == 0 at its own start
    CHECK(v[2] == Approx(0.0).margin(1e-4));
    CHECK(v[3] == Approx(0.0).margin(1e-4));
  }

  SECTION("Gate — a sweep reaching exactly 1.0 still lands on the last lane") {
    // The top edge is the one place a half-open window would drop the signal.
    const auto v = runLanes(sliceSketch(1.0, 4), 4);
    CHECK(v[3] == Approx(1.0).margin(1e-4));
    CHECK(v[0] == Approx(0.0).margin(1e-4));
  }

  SECTION("Hold — lanes the sweep has passed stay at where they ended") {
    const auto v = runLanes(sliceSketch(0.625, 4, json{{"beyond", 1}}), 4);
    CHECK(v[0] == Approx(1.0).margin(1e-4));    // passed — held at the curve's end
    CHECK(v[1] == Approx(1.0).margin(1e-4));    // passed
    CHECK(v[2] == Approx(0.5).margin(1e-4));    // live, halfway across its window
    CHECK(v[3] == Approx(0.0).margin(1e-4));    // not reached
  }

  SECTION("a drawn curve reshapes only its own lane") {
    // Lane 2 gets a curve that peaks at its midpoint: (0,0) (0.5,1) (1,0).
    // At the midpoint an identity lane would read 0.5; this one reads 1.
    const auto v = runLanes(
        sliceSketch(0.375, 4, json{{"curve_2", "[0,0,0,0.5,1,0,1,0,0]"}}), 4);
    CHECK(v[1] == Approx(1.0).margin(1e-4));
    // Its neighbours are untouched — the curve is per lane, not per card.
    const auto w = runLanes(sliceSketch(0.625, 4,
                                        json{{"curve_2", "[0,0,0,0.5,1,0,1,0,0]"}}), 4);
    CHECK(w[2] == Approx(0.5).margin(1e-4));
  }

  SECTION("a zero-width window is a step, not a divide by zero") {
    // start == end. Under Hold the lane reads 0 below the edge and the curve's
    // end above it; nothing produces a NaN.
    json degenerate = json{{"beyond", 1}, {"start_2", 0.5}, {"end_2", 0.5}};
    const auto below = runLanes(sliceSketch(0.4, 4, degenerate), 4);
    CHECK(below[1] == Approx(0.0).margin(1e-4));
    const auto above = runLanes(sliceSketch(0.6, 4, degenerate), 4);
    CHECK(above[1] == Approx(1.0).margin(1e-4));
  }

  SECTION("lanes above the count stay dark") {
    // Lane 3 is given a window covering the whole range, so it WOULD read 0.5
    // if it ran. With the count at 4 it does; with the count at 2 it publishes
    // a flat 0. Both halves are asserted together, in that order — a published
    // value persists, so this also pins that lowering the count does not leave
    // the lane's last value driving whatever is still wired to it.
    const json wideLane3 = json{{"start_3", 0.0}, {"end_3", 1.0}};

    const auto live = runLanes(sliceSketch(0.5, 4, wideLane3), 3);
    CHECK(live[2] == Approx(0.5).margin(1e-4));   // halfway across [0,1)

    json s2 = sliceSketch(0.5, 2, wideLane3);
    executor.execute(s2, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("dash"));
    REQUIRE(md["dash"].contains("knob_2"));
    CHECK(md["dash"]["knob_2"]["value"].get<double>() == Approx(0.0).margin(1e-4));
  }
}
