// test_exec_order.cpp — the sidecar canvas's execution-order override.
//
// A sketch's `chain` is stable-partitioned: the linear effect list first, then
// the sidecar-canvas nodes (entries carrying a `canvas` placement). The UI
// topo-sorts both into ONE merged order and stores it as `execOrder`; the
// executor repairs that list and replays it (sketch_canvas::resolveExecOrder).
//
// What must hold:
//   1. Absent `execOrder` is bit-for-bit today's behavior.
//   2. An explicit order is honored — reordering the list == reordering `chain`.
//   3. CURSOR ISOLATION: a canvas stage never touches the linear image chain,
//      whatever position the merged order gives it. This is the whole risk of
//      the change; everything else is bookkeeping.
//   4. Texture wires route the image THROUGH a canvas node and back.
//   5. Causality follows EXECUTION position, not chain position.
//   6. An order-only edit rebuilds the plan exactly once.
//   7. resolveExecOrder matches its TS twin against the shared fixture.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <fstream>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_canvas.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;
using nlohmann::json;

static double mean_rgb(const std::vector<uint8_t>& px) {
  long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? static_cast<double>(sum) / n : 0.0;
}

namespace {

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  sketch_executor::WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;
  std::unique_ptr<sketch_executor::SketchExecutor> executor;
  static constexpr uint32_t W = 16, H = 16;
  int inTex = -1, outTex = -1;

  bool init() {
    backend = gpu::createMetalBackend();
    if (!backend || backend->getBackend() != 0) return false;
    if (!bundles.init()) return false;
    rt = std::make_unique<EffectRuntime>(backend.get());
    registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
    if (bundles.loadBundleFile(CORE_WASM_PATH, *registry, backend.get(), nullptr) <= 1)
      return false;
    executor = std::make_unique<sketch_executor::SketchExecutor>(
        rt.get(), registry.get(), backend.get());
    const int RGBA8 = 1;
    inTex = backend->createTexture(W, H, RGBA8);
    outTex = backend->createTexture(W, H, RGBA8);
    std::vector<uint8_t> white(W * H * 4, 255);
    backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());
    return true;
  }

  double frame(const json& sketch, bool dirty = true, double dt = 1.0 / 60.0) {
    int out = executor->execute(sketch, inTex, outTex, (int)W, (int)H, dt, dirty);
    backend->submit();
    return mean_rgb(backend->readbackTexture(out, W, H));
  }
};

// A solid-grey source followed by a brightness lift — the reference image.
json linearEntry(const char* key, double brightness) {
  return json{{"type", "module"},
              {"module_type", "color.tone.brightness_contrast"},
              {"instance_key", key},
              {"params", {{"brightness", brightness}, {"contrast", 0.0}}}};
}

json sourceEntry(const char* key, double grey) {
  return json{{"type", "module"},
              {"module_type", "source.solid_color"},
              {"instance_key", key},
              {"params", {{"color", json::array({grey, grey, grey})}}}};
}

/** Mark an entry as a sidecar-canvas node (the partition marker). */
json onCanvas(json entry, double x = 0.0, double y = 0.0) {
  entry["canvas"] = json{{"x", x}, {"y", y}};
  return entry;
}

/**
 * Assemble a sketch, lifting each entry's `params` into real instance STATE.
 * `ModuleEntry.params` is the deprecated mirror — the executor reads
 * `instances[key].state`, so a test that only sets params silently runs every
 * effect at its defaults (and then asserts nothing).
 */
json sketchOf(json chain, json wires = json::array()) {
  json instances = json::object();
  for (auto& e : chain) {
    const std::string key = e.value("instance_key", std::string());
    instances[key] = json{{"module_type", e.value("module_type", std::string())},
                          {"state", e.value("params", json::object())}};
  }
  json s{{"chain", chain}, {"instances", instances}};
  if (!wires.empty()) s["wires"] = wires;
  return s;
}

}  // namespace

TEST_CASE("exec order: absent execOrder is plain chain order", "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  json sketch = sketchOf(json::array({sourceEntry("src", 0.25),
                                     linearEntry("b0", 0.25)}));
  const double plain = h.frame(sketch);

  // An explicit order that IS chain order must be indistinguishable.
  sketch["execOrder"] = json::array({"src", "b0"});
  CHECK(h.frame(sketch) == plain);

  // So must a stale/partial one, which resolveExecOrder repairs to chain order.
  sketch["execOrder"] = json::array({"gone", "src"});
  CHECK(h.frame(sketch) == plain);
}

TEST_CASE("exec order: an explicit order reorders execution", "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  // brightness THEN source: the source overwrites the image, so the lift is lost.
  json srcLast = sketchOf(json::array({linearEntry("b0", 0.4),
                                      sourceEntry("src", 0.25)}));
  const double sourceWins = h.frame(srcLast);

  // Same chain, order reversed: source first, then the lift applies.
  json reordered = srcLast;
  reordered["execOrder"] = json::array({"src", "b0"});
  const double liftApplies = h.frame(reordered);

  // ...which must equal writing that order into the chain directly.
  json rewritten = sketchOf(json::array({sourceEntry("src", 0.25),
                                        linearEntry("b0", 0.4)}));
  CHECK(liftApplies == h.frame(rewritten));
  CHECK(liftApplies > sourceWins + 1.0);
}

TEST_CASE("exec order: a canvas stage never touches the linear image chain",
          "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  // The reference: grey source, no lift anywhere.
  json linearOnly = sketchOf(json::array({sourceEntry("src", 0.25)}));
  const double reference = h.frame(linearOnly);

  // Now add a bright, UNWIRED canvas node. It renders (its input is the sketch
  // input) but its output must go nowhere — the sketch output is unchanged.
  json withCanvas = sketchOf(json::array({sourceEntry("src", 0.25),
                                         onCanvas(linearEntry("cv", 0.9))}));
  CHECK(h.frame(withCanvas) == reference);

  // ...and that holds wherever the merged order puts it, including FIRST and
  // LAST. Ending on a canvas node must not let it claim the output texture.
  withCanvas["execOrder"] = json::array({"cv", "src"});
  CHECK(h.frame(withCanvas) == reference);
  withCanvas["execOrder"] = json::array({"src", "cv"});
  CHECK(h.frame(withCanvas) == reference);

  // A canvas node between two linear stages must not break the chain either.
  json sandwich = sketchOf(json::array({sourceEntry("src", 0.25),
                                       linearEntry("b0", 0.3),
                                       onCanvas(linearEntry("cv", 0.9))}));
  sandwich["execOrder"] = json::array({"src", "cv", "b0"});
  json noCanvas = sketchOf(json::array({sourceEntry("src", 0.25),
                                       linearEntry("b0", 0.3)}));
  CHECK(h.frame(sandwich) == h.frame(noCanvas));
}

TEST_CASE("exec order: an all-canvas sketch passes its input through",
          "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  // Nothing linear renders, so the sketch must return its INPUT (white),
  // not whatever the canvas node happened to draw.
  json allCanvas = sketchOf(json::array({onCanvas(sourceEntry("src", 0.25)),
                                        onCanvas(linearEntry("cv", 0.9))}));
  CHECK(h.frame(allCanvas) > 250.0);
}

TEST_CASE("exec order: texture wires route the image through a canvas node",
          "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  // Reference: source → lift, entirely linear.
  json linear = sketchOf(json::array({sourceEntry("src", 0.25),
                                     linearEntry("b0", 0.3)}));
  const double reference = h.frame(linear);

  // Same computation, but the lift lives on the canvas: the linear source's
  // output texture is wired into it, and its output back into a linear
  // passthrough. The merged order interleaves it between the two.
  json branched = sketchOf(
    json::array({sourceEntry("src", 0.25),
                 linearEntry("out", 0.0),          // passthrough sink
                 onCanvas(linearEntry("cv", 0.3))}),
    json::array({
      json{{"id", "t0"}, {"src", {{"instanceKey", "src"}, {"field", "tex_out"}}},
                         {"dest", {{"instanceKey", "cv"}, {"field", "tex_in"}}}},
      json{{"id", "t1"}, {"src", {{"instanceKey", "cv"}, {"field", "tex_out"}}},
                         {"dest", {{"instanceKey", "out"}, {"field", "tex_in"}}}},
    }));
  branched["execOrder"] = json::array({"src", "cv", "out"});

  INFO("reference=" << reference);
  CHECK(h.frame(branched) == reference);
}

TEST_CASE("exec order: causality follows execution position, not chain position",
          "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  // A canvas dashboard knob (a constant producer) wired into a linear
  // brightness. Position in the MERGED order — not in the chain — decides
  // whether the consumer reads it this frame or last frame.
  //
  // The two variants use DISTINCT instance keys because they share one executor:
  // effects keep their runtime state across frames, so a second variant reusing
  // the same keys would inherit the first's already-modulated value (the
  // dormant-wire contract — a skipped read tap leaves the dest where it was).
  auto sketch = [](const char* sfx, bool producerFirst) {
    const std::string src = std::string("src") + sfx;
    const std::string bc  = std::string("bc") + sfx;
    const std::string dsh = std::string("dash") + sfx;
    json s = sketchOf(
      json::array({sourceEntry(src.c_str(), 0.5),
                   linearEntry(bc.c_str(), -0.5),      // authored: fully dark
                   onCanvas(json{{"type", "module"},
                                 {"module_type", "util.dashboard"},
                                 {"instance_key", dsh},
                                 {"params", {{"knob_0", 0.8}}}})}),
      json::array({
        json{{"id", std::string("w") + sfx},
             {"src", {{"instanceKey", dsh}, {"field", "knob_0"}}},
             {"dest", {{"instanceKey", bc}, {"field", "brightness"}}},
             {"combine", "replace"}}}));
    s["execOrder"] = producerFirst ? json::array({dsh, src, bc})
                                   : json::array({src, bc, dsh});
    return s;
  };

  // Producer BEFORE its consumer: same-frame. The knob lands on frame 1, so the
  // image is already at its final value and doesn't move on frame 2.
  const json ahead = sketch("A", /*producerFirst=*/true);
  const double ahead1 = h.frame(ahead);
  const double ahead2 = h.frame(ahead, /*dirty=*/false);
  CHECK(ahead1 == ahead2);

  // Producer AFTER its consumer: the wire is delayed. Frame 1 reads an unseeded
  // rail, so the dest holds its authored (dark) value; frame 2 reads frame 1's
  // captured knob and lands exactly where the same-frame ordering already was.
  const json behind = sketch("B", /*producerFirst=*/false);
  const double behind1 = h.frame(behind);
  const double behind2 = h.frame(behind, /*dirty=*/false);
  INFO("ahead=" << ahead1 << " behind1=" << behind1 << " behind2=" << behind2);
  CHECK(behind1 < ahead1 - 1.0);
  CHECK(behind2 == ahead1);
}

TEST_CASE("exec order: an order-only edit rebuilds the plan exactly once",
          "[exec_order]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  json sketch = sketchOf(json::array({sourceEntry("src", 0.25),
                                     linearEntry("b0", 0.25),
                                     onCanvas(linearEntry("cv", 0.9))}));
  h.frame(sketch);
  const int afterFirst = h.executor->planBuildCountForTest();

  // A dirty frame with the same doc must not rebuild.
  h.frame(sketch);
  CHECK(h.executor->planBuildCountForTest() == afterFirst);

  // Changing ONLY the order is structural — exactly one rebuild.
  sketch["execOrder"] = json::array({"cv", "src", "b0"});
  h.frame(sketch);
  CHECK(h.executor->planBuildCountForTest() == afterFirst + 1);
  h.frame(sketch);
  CHECK(h.executor->planBuildCountForTest() == afterFirst + 1);
}

TEST_CASE("resolveExecOrder matches its TS twin (shared fixture)", "[exec_order]") {
  std::ifstream f(EXEC_ORDER_FIXTURE);
  REQUIRE(f.good());
  json fixture;
  f >> fixture;

  auto chainOf = [](const json& keys) {
    json chain = json::array();
    for (const auto& k : keys)
      chain.push_back(json{{"type", "module"}, {"instance_key", k}});
    return chain;
  };
  auto keysOf = [](const json& chain, const std::vector<size_t>& order) {
    json out = json::array();
    for (size_t i : order) out.push_back(chain[i].value("instance_key", std::string()));
    return out;
  };

  for (const auto& c : fixture.at("repairCases")) {
    INFO("case: " << c.value("name", std::string()));
    const json chain = chainOf(c.at("chain"));
    const auto order = sketch_canvas::resolveExecOrder(chain, c.at("stored"));
    CHECK(keysOf(chain, order) == c.at("expected"));
  }

  // The topo-sort itself is the UI's job, but the executor must REPLAY each
  // expected order back to exactly that sequence.
  for (const auto& c : fixture.at("cases")) {
    INFO("case: " << c.value("name", std::string()));
    json chain = json::array();
    for (const auto& e : c.at("chain")) {
      json entry{{"type", "module"}, {"instance_key", e.at("key")}};
      if (e.value("canvas", false)) entry["canvas"] = json{{"x", 0}, {"y", 0}};
      chain.push_back(entry);
    }
    const auto order = sketch_canvas::resolveExecOrder(chain, c.at("expectedOrder"));
    CHECK(keysOf(chain, order) == c.at("expectedOrder"));
    // And the canvas marker must round-trip through isCanvasEntry.
    for (size_t i = 0; i < chain.size(); ++i) {
      CHECK(sketch_canvas::isCanvasEntry(chain[i]) ==
            c.at("chain")[i].value("canvas", false));
    }
  }
}

