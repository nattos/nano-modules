// test_comp_render.cpp — end-to-end GPU render of the COMPOSITION EXECUTOR
// (comp::CompExecutor): load a real composition document, drive
// update()/render() on a real Metal backend with core.wasm effects, and assert:
//
//   1. PIXEL PARITY — the comp path renders byte-identical to driving the
//      Phase-B-built sketch through a plain SketchExecutor (same executor, so
//      byte-equal sketch in ⇒ identical pixels out).
//   2. A param cheap-op re-renders WITHOUT a plan rebuild; a clip-boundary
//      crossing flags structureChanged and DOES rebuild.
//   3. An automation lane drives a param (readback differs across beats).
//   4. A live LFO→param wire folds through effrt_published_scalar (the
//      numeric producer-output mirror running in-process).

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <chrono>
#include <cmath>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/comp/comp_eval.h"
#include "sketch/comp/comp_executor.h"
#include "sketch/effrt.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;
using json = nlohmann::json;

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

namespace {

constexpr uint32_t W = 16, H = 16;
constexpr int RGBA8 = 1;

double meanRgb(const std::vector<uint8_t>& px) {
  long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? static_cast<double>(sum) / n : 0.0;
}

/** One shared Metal + core.wasm harness per test case. */
struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  sketch_executor::WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;

  bool init() {
    backend = gpu::createMetalBackend();
    if (!backend || backend->getBackend() != 0) return false;
    if (!bundles.init()) return false;
    rt = std::make_unique<EffectRuntime>(backend.get());
    registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
    return bundles.loadBundleFile(CORE_WASM_PATH, *registry, backend.get(), nullptr) > 1;
  }

  /** Seed a CompExecutor's catalog (+ its internal executor) from the loaded
   *  registry — the native analogue of comp_register_schema per module. */
  void seed(comp::CompExecutor& c) {
    for (const auto& [mt, fields] : registry->schemas()) {
      c.registerSchema(mt, fields);
      const auto* reg = registry->find(mt);
      json caps = json::array();
      if (reg) for (const auto& t : reg->capabilities) caps.push_back(t);
      c.registerCapabilities(mt, caps);
    }
  }

  /** Seed the standalone comp::Catalog used for the reference build. */
  void seed(comp::Catalog& cat) {
    for (const auto& [mt, fields] : registry->schemas()) {
      cat.registerSchema(mt, fields);
      const auto* reg = registry->find(mt);
      json caps = json::array();
      if (reg) for (const auto& t : reg->capabilities) caps.push_back(t);
      cat.registerCapabilities(mt, caps);
    }
  }

  int32_t makeTex() { return backend->createTexture(W, H, RGBA8); }

  std::vector<uint8_t> read(int32_t tex) {
    backend->submit();
    return backend->readbackTexture(tex, W, H);
  }
};

json mkDevice(const std::string& id, const std::string& type, json state = json::object()) {
  return {{"id", id}, {"moduleType", type}, {"name", type}, {"capabilities", json::array()},
          {"state", std::move(state)}};
}

json mkClip(const std::string& id, double startBeat, double lengthBeat, json devices,
            json over = json::object()) {
  json c = {{"id", id},        {"name", id},
            {"startBeat", startBeat}, {"lengthBeat", lengthBeat},
            {"kind", "effect"},       {"sketch", {{"devices", std::move(devices)}}},
            {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}, {"direction", "forward"}}},
            {"automation", json::array()}, {"exports", json::array()},
            {"warps", json::array()}};
  c.update(over);
  return c;
}

json mkTrack(const std::string& id, json clips, json over = json::object()) {
  json t = {{"id", id},       {"name", id},   {"kind", "track"},
            {"parentId", nullptr}, {"sketch", {{"devices", json::array()}}},
            {"automation", json::array()}, {"clips", std::move(clips)}};
  t.update(over);
  return t;
}

json mkComposition(json tracks) {
  tracks.push_back({{"id", "main-bus"}, {"name", "Main Bus"}, {"kind", "group"},
                    {"parentId", nullptr}, {"sketch", {{"devices", json::array()}}},
                    {"automation", json::array()}, {"clips", json::array()}});
  return {{"meta", {{"resolution", {{"width", 1920}, {"height", 1080}}},
                    {"baseBPM", 120},
                    {"timeSignature", {4, 4}}}},
          {"tracks", std::move(tracks)},
          {"rails", json::array()},
          {"playMode", {{"defaultMode", "time"}}}};
}

}  // namespace

TEST_CASE("comp executor renders pixel-identical to a plain executor on its built sketch",
          "[comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  // Two source tracks: white solid over the black bg, then a half-level solid.
  const json doc = mkComposition(json::array({
      mkTrack("t1", json::array({mkClip(
                        "c1", 0, 8,
                        json::array({mkDevice("d1", "source.solid_color",
                                              {{"color", {1.0, 1.0, 1.0}}})}))})),
      mkTrack("t2",
              json::array({mkClip("c2", 0, 8,
                                  json::array({mkDevice("d2", "source.solid_color",
                                                        {{"color", {1.0, 0.0, 0.0}}})}))}),
              {{"level", 0.5}}),
  }));

  // ── Comp path ──
  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  cx.seekBeat(1.0);
  const uint32_t flags = cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) != 0);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK((flags & comp::kCompHoldingPrecise) == 0);
  // Instance-key contract surfaces through the readbacks.
  CHECK(cx.requiredJson().find("clip_c1_d1") != std::string::npos);
  CHECK(cx.chainKeysJson().find("clip_c2_blend") != std::string::npos);

  int32_t inTexA = hx.makeTex(), outTexA = hx.makeTex();
  const int32_t outA = cx.render(inTexA, outTexA, W, H, 1.0 / 60.0);
  const auto pxA = hx.read(outA);

  // ── Reference: the SAME Phase-B build through a plain SketchExecutor ──
  comp::Catalog cat;
  hx.seed(cat);
  const comp::CompositionM model = comp::parseComposition(doc);
  const comp::WarpClock clock(
      comp::WarpCurve(comp::derivedWarpSegments(model), comp::compositionLengthBeats(model)),
      model.baseBPM);
  const auto build = comp::buildCompositeRenderAtBeat(model, cat, clock, 1.0);
  REQUIRE(build.hasContent);

  sketch_executor::SketchExecutor ref(hx.rt.get(), hx.registry.get(), hx.backend.get());
  ref.setKeyNamespace("ref/");  // isolate from the comp executor's instances
  int32_t inTexB = hx.makeTex(), outTexB = hx.makeTex();
  const int32_t outB = ref.execute(build.sketch, inTexB, outTexB, W, H, 1.0 / 60.0, true);
  const auto pxB = hx.read(outB);

  REQUIRE(pxA.size() == pxB.size());
  size_t diff = 0;
  for (size_t i = 0; i < pxA.size(); i++) {
    if (pxA[i] != pxB[i]) diff++;
  }
  INFO("comp mean " << meanRgb(pxA) << " ref mean " << meanRgb(pxB) << " diffBytes " << diff);
  CHECK(diff == 0);
  // And it actually rendered something (white + half red over black ≠ black).
  CHECK(meanRgb(pxA) > 40.0);
}

TEST_CASE("param cheap-op re-renders without a plan rebuild; boundary crossing rebuilds",
          "[comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  const json doc = mkComposition(json::array({
      mkTrack("t1", json::array({mkClip(
                        "c1", 0, 8,
                        json::array({mkDevice("d1", "source.solid_color",
                                              {{"color", {0.2, 0.2, 0.2}}})}))})),
      mkTrack("t2",
              json::array({mkClip("c2", 0, 4,
                                  json::array({mkDevice("d2", "source.solid_color",
                                                        {{"color", {1.0, 1.0, 1.0}}})}))})),
  }));

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  cx.seekBeat(1.0);
  cx.update(0.0);
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
  cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  const auto pxBefore = hx.read(outTex);
  const int plans0 = cx.sketchExecutor()->planBuildCountForTest();

  // Steady frame: no dirty, no rebuild.
  CHECK((cx.update(0.0) & comp::kCompStructureChanged) == 0);
  cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  CHECK(cx.sketchExecutor()->planBuildCountForTest() == plans0);

  // Param cheap-op: pixels change, plan count stays flat, topology unchanged.
  // (Patch the TOP visible layer — c2 draws over c1 at this beat.)
  cx.setDeviceParam("c2", "d2", "color", json::array({0.4, 0.4, 0.4}));
  const uint32_t flags = cx.update(0.0);
  CHECK((flags & comp::kCompStructureChanged) == 0);
  const int32_t out = cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  const auto pxAfter = hx.read(out);
  CHECK(cx.sketchExecutor()->planBuildCountForTest() == plans0);
  CHECK(std::abs(meanRgb(pxAfter) - meanRgb(pxBefore)) > 5.0);

  // Cross the c2 clip boundary (it ends at beat 4): topology changes.
  cx.seekBeat(5.0);
  const uint32_t flags2 = cx.update(0.0);
  CHECK((flags2 & comp::kCompStructureChanged) != 0);
  cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  CHECK(cx.sketchExecutor()->planBuildCountForTest() == plans0 + 1);
}

TEST_CASE("automation lane drives a param across beats", "[comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  // White source; the clip's own brightness_contrast is automated 0→1 over the
  // clip span (unsigned replace into brightness's [-1,1]): dark early, bright late.
  const json doc = mkComposition(json::array({mkTrack(
      "t1",
      json::array({mkClip(
          "c1", 0, 8,
          json::array({mkDevice("d1", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}}),
                       mkDevice("bc", "color.tone.brightness_contrast",
                                {{"brightness", 0.0}, {"contrast", 0.0}})}),
          {{"automation",
            json::array({{{"id", "l1"},
                          {"targetDeviceId", "bc"},
                          {"targetField", "brightness"},
                          {"label", "b"},
                          {"points", json::array({{{"x", 0}, {"y", 0.0}},
                                                  {{"x", 1}, {"y", 1.0}}})}}})}})}))}));

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();

  cx.seekBeat(0.5);
  cx.update(0.0);
  const int32_t outEarly = cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  const double early = meanRgb(hx.read(outEarly));

  cx.seekBeat(7.5);
  cx.update(0.0);
  const int32_t outLate = cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  const double late = meanRgb(hx.read(outLate));

  INFO("early " << early << " late " << late);
  CHECK(late > early + 30.0);
}

TEST_CASE("live LFO→param wire folds via effrt_published_scalar", "[comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  // The web forward-wire repro, driven through the comp document: white solid →
  // lfo (rate 0, resting output 0) → brightness_contrast(brightness 1,
  // contrast -0.5), clip wire lfo.output → bc.brightness. The LIVE output (0)
  // must fold through the published-state mirror → neutral brightness → the
  // -0.5 contrast alone → grey ~128. Without the fold, brightness stays 1 →
  // much brighter.
  const json doc = mkComposition(json::array({mkTrack(
      "t1", json::array({mkClip(
                "c1", 0, 8,
                json::array(
                    {mkDevice("d1", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}}),
                     mkDevice("lfo", "mod.source.lfo", {{"rate", 0.0}, {"amplitude", 1.0}}),
                     mkDevice("bc", "color.tone.brightness_contrast",
                              {{"brightness", 1.0}, {"contrast", -0.5}})}),
                {{"sketch",
                  {{"devices",
                    json::array(
                        {mkDevice("d1", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}}),
                         mkDevice("lfo", "mod.source.lfo", {{"rate", 0.0}, {"amplitude", 1.0}}),
                         mkDevice("bc", "color.tone.brightness_contrast",
                                  {{"brightness", 1.0}, {"contrast", -0.5}})})},
                   {"wires", json::array({{{"id", "x1"},
                                           {"src", {{"instanceKey", "lfo"}, {"field", "output"}}},
                                           {"dest", {{"instanceKey", "bc"}, {"field", "brightness"}}}}})}}}})}))}));

  // Synthesize the live published state (a resting signed LFO): the provider is
  // the barrel's state-doc seam; here it feeds the same JSON the web host would.
  sketch_executor::effrtSetPublishedStateProvider(
      [](effect_runtime::EffectInstance* i) -> std::string {
        return i->id() == "mod.source.lfo" ? std::string("{\"output\":0.0}") : std::string();
      });

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  cx.seekBeat(1.0);
  cx.update(0.0);
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
  const int32_t out = cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  const double m = meanRgb(hx.read(out));
  sketch_executor::effrtSetPublishedStateProvider(nullptr);

  INFO("output mean " << m << " (expect ~128 grey)");
  CHECK(std::abs(m - 128.0) < 20.0);
}

TEST_CASE("automation baseline yields to a live wire on the same field", "[comp_render]") {
  // The arrangement re-asserts each rail's BASE via per-frame automation
  // (combine 'replace') so a DROPPED writer resets the rail — but a LIVE wire
  // must win on a shared field, else the writer's fold is clobbered every
  // frame (rails sat pinned at base; read wires downstream never moved).
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  // white -> lfo (resting output 0.5 baked into instance state, the host
  // mirror's shape) -> brightness_contrast. Wire lfo.output -> bc.brightness
  // (replace); automation ALSO targets bc.brightness with value 0 (-> dest min
  // -1 -> black). Wire wins => brightness 0 (neutral) => contrast -0.5 grey.
  auto sketch = json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "source.solid_color", "instance_key": "src",
        "params": { "color": [1.0, 1.0, 1.0] } },
      { "type": "module", "module_type": "mod.source.lfo", "instance_key": "lfo",
        "params": { "rate": 0.0, "amplitude": 1.0 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
        "params": { "brightness": 1.0, "contrast": -0.5 } }
    ],
    "instances": {
      "src": { "module_type": "source.solid_color", "state": { "color": [1.0, 1.0, 1.0] } },
      "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } },
      "bc":  { "module_type": "color.tone.brightness_contrast",
               "state": { "brightness": 1.0, "contrast": -0.5 } }
    },
    "wires": [
      { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" },
        "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" }
    ]
  })JSON");
  const auto automation = json::parse(R"JSON([
    { "instance": "bc", "field": "brightness", "value": 0.0,
      "combine": "replace", "magnitude": "unsigned" }
  ])JSON");

  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();

  // WITH the wire: the wire's fold survives (lfo 0.5 -> signed [-1,1] dest ->
  // ~0.5-ish brightness; the exact value is tap_mod's, pinned elsewhere). The
  // automation value 0 -> dest min (-1) -> BLACK must NOT be what renders.
  sketch_executor::SketchExecutor exWired(hx.rt.get(), hx.registry.get(), hx.backend.get());
  exWired.setKeyNamespace("autoprec-a/");
  exWired.setAutomation(automation);
  const int32_t outA = exWired.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, true);
  const double withWire = meanRgb(hx.read(outA));

  // WITHOUT the wire: automation applies -> brightness -1 -> black.
  auto sketchNoWire = sketch;
  sketchNoWire["wires"] = json::array();
  sketch_executor::SketchExecutor exAuto(hx.rt.get(), hx.registry.get(), hx.backend.get());
  exAuto.setKeyNamespace("autoprec-b/");
  exAuto.setAutomation(automation);
  int32_t outTex2 = hx.makeTex();
  const int32_t outB = exAuto.execute(sketchNoWire, inTex, outTex2, W, H, 1.0 / 60.0, true);
  const double autoOnly = meanRgb(hx.read(outB));

  INFO("withWire " << withWire << " autoOnly " << autoOnly);
  CHECK(autoOnly < 20.0);              // automation alone applies (black)
  CHECK(withWire > autoOnly + 60.0);   // the live wire beat the re-assert
}

// ── Eval-skip span (next-boundary-beat) — update()-only, no GPU needed ──────

namespace {

/** A CompExecutor with null backends + hand-seeded minimal schemas: update()
 *  never calls effrt/gpu, so the eval-skip contract tests run anywhere. */
struct EvalHarness {
  comp::CompExecutor cx{nullptr, nullptr, nullptr};
  EvalHarness() {
    cx.registerSchema("source.solid_color", json::object());
    cx.registerCapabilities("source.solid_color", json::array({"generator"}));
    cx.registerSchema("source.video.file", json::object());
    cx.registerCapabilities("source.video.file", json::array({"generator"}));
  }
  /** Play forward `frames` ticks of `dt`, returning the OR of all flags. */
  uint32_t run(int frames, double dt) {
    uint32_t all = 0;
    for (int i = 0; i < frames; i++) all |= cx.update(dt);
    return all;
  }
};

json mkVideoClip(const std::string& id, double startBeat, double lengthBeat) {
  return mkClip(id, startBeat, lengthBeat,
                json::array({mkDevice(id + "_v", "source.video.file")}),
                {{"kind", "video"},
                 {"source", {{"label", id + ".mp4"}, {"durationFrames", 300},
                             {"sourceKey", id}, {"url", "blob:media/" + id}, {"fps", 30}}}});
}

}  // namespace

TEST_CASE("eval-skip: steady playback inside one span evaluates once", "[comp_eval]") {
  EvalHarness h;
  // c1 spans [0,8); c2 enters at 4 — the only boundary ahead of beat 0.5 is 4.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                        json::array({mkDevice("d1", "source.solid_color")}))})),
      mkTrack("t2", json::array({mkClip("c2", 4, 4,
                                        json::array({mkDevice("d2", "source.solid_color")}))})),
  })));
  h.cx.seekBeat(0.5);
  CHECK((h.cx.update(0.0) & comp::kCompStructureChanged) != 0);
  CHECK(h.cx.evalCount() == 1);
  CHECK(h.cx.evalBoundaryBeat() == 4.0);

  // 60 paused frames: beat frozen inside the span — zero re-evals.
  h.run(60, 1.0 / 60.0);
  CHECK(h.cx.evalCount() == 1);

  // Play 1 second (120 BPM → beat 0.5 → 2.5): still inside the span.
  h.cx.play();
  uint32_t flags = h.run(60, 1.0 / 60.0);
  CHECK(h.cx.positionBeat() > 2.0);
  CHECK(h.cx.evalCount() == 1);
  CHECK((flags & comp::kCompStructureChanged) == 0);
  CHECK((flags & comp::kCompHasContent) != 0);  // skipped frames still report content

  // Play across beat 4: exactly ONE re-eval, and it reports the new topology.
  flags = h.run(60, 1.0 / 60.0);  // → ~beat 4.5
  CHECK(h.cx.positionBeat() > 4.0);
  CHECK(h.cx.evalCount() == 2);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK(h.cx.evalBoundaryBeat() == 8.0);
}

TEST_CASE("eval-skip: seeks re-eval only when they leave the span", "[comp_eval]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                        json::array({mkDevice("d1", "source.solid_color")}))})),
  })));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 1);

  // Forward seek WITHIN the span [1, 8): the cached eval still holds.
  h.cx.seekBeat(6.0);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 1);

  // Backward seek (before the span start): conservative re-eval.
  h.cx.seekBeat(0.5);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 2);

  // Seek past the end boundary: re-eval (empty timeline there → content gone).
  h.cx.seekBeat(9.0);
  const uint32_t flags = h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 3);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK((flags & comp::kCompHasContent) == 0);
}

TEST_CASE("eval-skip: cheap ops invalidate exactly when they reach the sketch",
          "[comp_eval]") {
  EvalHarness h;
  json clip = mkClip("c1", 0, 8, json::array({mkDevice("d1", "source.solid_color")}),
                     {{"automation", json::array({{{"id", "l1"},
                                                   {"targetDeviceId", "d1"},
                                                   {"targetField", "scale"},
                                                   {"label", "x"},
                                                   {"points", json::array({{{"x", 0}, {"y", 0}},
                                                                           {{"x", 1}, {"y", 1}}})}}})}});
  h.cx.loadDocument(mkComposition(json::array({mkTrack("t1", json::array({clip}))})));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 1);

  // Steady frame: no re-eval.
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 1);

  // A param reaches the built sketch → invalidates (propagation = rebuild).
  h.cx.setDeviceParam("c1", "d1", "color", json::array({0.5, 0.5, 0.5}));
  CHECK((h.cx.update(0.0) & comp::kCompStructureChanged) == 0);  // same topology
  CHECK(h.cx.evalCount() == 2);

  // Track level is baked as layer opacity → invalidates.
  h.cx.setTrackLevel("t1", 0.5);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 3);

  // Lane points never reach the sketch (read fresh through the cached tree
  // every frame) → NO invalidation.
  const double pts[6] = {0, 0.25, 0, 1, 0.75, 0};
  h.cx.setLanePoints("c1", "l1", pts, 2);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 3);

  // ...but the new lane VALUES flow into this frame's automation regardless
  // (pinned indirectly: the golden automation tests cover values; here we pin
  // the count contract only).

  // The explicit invalidation hook (future live clip triggers) re-evals once.
  h.cx.invalidateEval();
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 4);
  h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 4);
}

TEST_CASE("eval-skip: the warm-lookahead window entry is a boundary", "[comp_eval]") {
  EvalHarness h;
  // A solid now, and a VIDEO clip far ahead at beat 20: the pump must learn
  // about it when it enters the 8-beat lookahead window (beat 12), without a
  // structure change.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("c1", 0, 32,
                                        json::array({mkDevice("d1", "source.solid_color")}))})),
      mkTrack("t2", json::array({mkVideoClip("v1", 20, 4)})),
  })));
  h.cx.setTransportMode(false);  // Fluid — don't hold on the (never-ready) video
  h.cx.seekBeat(1.0);
  uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompVideoSetChanged) == 0);  // pump target starts empty
  CHECK(h.cx.evalCount() == 1);
  CHECK(h.cx.evalBoundaryBeat() == 12.0);  // v1.start - LOOKAHEAD

  // Within the span: seeking to 11.9 re-uses the eval.
  h.cx.seekBeat(11.9);
  flags = h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 1);

  // Crossing into the lookahead window: one re-eval, pump set changes.
  h.cx.seekBeat(12.5);
  flags = h.cx.update(0.0);
  CHECK(h.cx.evalCount() == 2);
  CHECK((flags & comp::kCompVideoSetChanged) != 0);
  CHECK(h.cx.videoDescsJson().find("blob:media/v1") != std::string::npos);
  CHECK((flags & comp::kCompStructureChanged) == 0);  // v1 not ACTIVE yet
  CHECK(h.cx.evalBoundaryBeat() == 20.0);
}

TEST_CASE("eval-skip: a Precise hold reuses the frozen-beat eval", "[comp_eval]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkVideoClip("v1", 0, 8)})),
  })));
  h.cx.seekBeat(1.0);
  h.cx.play();
  // Precise (default) + active unready video → hold, beat frozen.
  uint32_t flags = h.cx.update(1.0 / 60.0);
  CHECK((flags & comp::kCompHoldingPrecise) != 0);
  CHECK(h.cx.evalCount() == 1);
  h.run(30, 1.0 / 60.0);  // held frames: no re-evals
  CHECK(h.cx.evalCount() == 1);
  CHECK(h.cx.positionBeat() == 1.0);

  // Readiness releases the hold; playback resumes inside the same span.
  h.cx.setVideoReady("v1", true);
  flags = h.run(30, 1.0 / 60.0);
  CHECK((flags & comp::kCompHoldingPrecise) == 0);
  CHECK(h.cx.positionBeat() > 1.0);
  CHECK(h.cx.evalCount() == 1);  // still the same span — no re-eval on release
}

// Hidden micro-benchmark: update()-loop cost with the eval-skip span vs with a
// forced per-frame invalidation (≈ the old eval-every-frame behavior). Run
// manually: ./build/test_comp_render "[.comp_bench]" -s
TEST_CASE("eval-skip: update-loop micro-benchmark", "[.comp_bench]") {
  EvalHarness h;
  // A busy timeline: 8 tracks × 16 staggered 4-beat clips (+ some automation).
  json tracks = json::array();
  for (int t = 0; t < 8; t++) {
    json clips = json::array();
    for (int c = 0; c < 16; c++) {
      json clip = mkClip("t" + std::to_string(t) + "c" + std::to_string(c), c * 4.0, 4.0,
                         json::array({mkDevice("d0", "source.solid_color")}));
      clip["automation"] = json::array(
          {{{"id", "l"}, {"targetDeviceId", "d0"}, {"targetField", "scale"}, {"label", "x"},
            {"points", json::array({{{"x", 0}, {"y", 0}}, {{"x", 1}, {"y", 1}}})}}});
      clips.push_back(std::move(clip));
    }
    tracks.push_back(mkTrack("t" + std::to_string(t), std::move(clips)));
  }
  h.cx.loadDocument(mkComposition(std::move(tracks)));
  h.cx.setTransportMode(false);
  h.cx.play();

  auto runLoop = [&](bool forceInvalidate) {
    h.cx.seekBeat(0.0);
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < 3600; i++) {  // 60s of playback at 60fps (120BPM → 120 beats… wraps off the end harmlessly)
      if (forceInvalidate) h.cx.invalidateEval();
      h.cx.update(1.0 / 60.0);
    }
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0)
        .count();
  };

  runLoop(true);  // warm caches/allocators
  const double everyFrameMs = runLoop(true);
  const double skipMs = runLoop(false);
  WARN("update() x3600 — eval-every-frame: " << everyFrameMs << " ms ("
       << everyFrameMs / 3600.0 * 1000.0 << " us/frame), eval-skip: " << skipMs << " ms ("
       << skipMs / 3600.0 * 1000.0 << " us/frame), speedup x"
       << everyFrameMs / std::max(0.001, skipMs) << ", evals=" << h.cx.evalCount());
  CHECK(skipMs < everyFrameMs);
}

TEST_CASE("engine-reserved __opacity__/__enable__ accept wires + automation", "[comp_render]") {
  // Phase-1 reserved-key modulation: the executor folds wires/automation whose
  // dest is an engine-reserved `__` key into its OWN opacity/enable decisions
  // (pre-gate), instead of uselessly setParamFloat-ing the plugin. Chain:
  // white solid -> color.invert. Inverted white = black, so the invert's
  // effective opacity IS the output brightness: 1 -> ~0, 0.5 -> ~127, 0 -> 255.
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  auto sketch = json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "source.solid_color", "instance_key": "src",
        "params": { "color": [1.0, 1.0, 1.0] } },
      { "type": "module", "module_type": "mod.source.lfo", "instance_key": "lfo",
        "params": { "rate": 0.0, "amplitude": 1.0 } },
      { "type": "module", "module_type": "color.invert", "instance_key": "inv", "params": {} }
    ],
    "instances": {
      "src": { "module_type": "source.solid_color", "state": { "color": [1.0, 1.0, 1.0] } },
      "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } },
      "inv": { "module_type": "color.invert", "state": {} }
    },
    "wires": []
  })JSON");

  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();

  SECTION("automation drives __opacity__ and __enable__; clearing restores authored") {
    sketch_executor::SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
    ex.setKeyNamespace("resauto/");
    // Baseline: authored opacity 1 -> fully inverted (black).
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, true);
    const double base = meanRgb(hx.read(outTex));
    const int plans0 = ex.planBuildCountForTest();

    ex.setAutomation(json::parse(
        R"([{ "instance": "inv", "field": "__opacity__", "value": 0.5,
              "combine": "replace", "magnitude": "unsigned" }])"));
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double half = meanRgb(hx.read(outTex));

    ex.setAutomation(json::parse(
        R"([{ "instance": "inv", "field": "__opacity__", "value": 0.0,
              "combine": "replace", "magnitude": "unsigned" }])"));
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double off = meanRgb(hx.read(outTex));

    // `__enable__` is stated as ON: driving it to 0 is what bypasses.
    ex.setAutomation(json::parse(
        R"([{ "instance": "inv", "field": "__enable__", "value": 0.0,
              "combine": "replace", "magnitude": "unsigned" }])"));
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double bypassed = meanRgb(hx.read(outTex));

    // ...and holding it at 1 leaves the effect running (the authored default).
    ex.setAutomation(json::parse(
        R"([{ "instance": "inv", "field": "__enable__", "value": 1.0,
              "combine": "replace", "magnitude": "unsigned" }])"));
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double enabled = meanRgb(hx.read(outTex));

    // Clearing automation restores the authored (opacity 1, enabled) look.
    ex.setAutomation(json::array());
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double restored = meanRgb(hx.read(outTex));

    INFO("base " << base << " half " << half << " off " << off
         << " bypassed " << bypassed << " enabled " << enabled
         << " restored " << restored);
    CHECK(base < 20.0);                        // inverted white = black
    CHECK(std::abs(half - 127.0) < 25.0);      // wet/dry mix at 0.5
    CHECK(off > 235.0);                        // opacity 0 -> passthrough white
    CHECK(bypassed > 235.0);                   // enable < 0.5 -> passthrough
    CHECK(enabled < 20.0);                     // enable >= 0.5 -> the effect runs
    CHECK(restored < 20.0);
    // None of this is structural: the plan never rebuilt.
    CHECK(ex.planBuildCountForTest() == plans0);
  }

  SECTION("a wire drives __opacity__ (and beats automation on the same key)") {
    auto wired = sketch;
    // The LFO's output is DECLARED signed [-1,1]; forcing the wire unsigned
    // prescales v*0.5+0.5 — so the RESTING LFO (output 0) lands at 0.5.
    wired["instances"]["lfo"]["state"]["output"] = 0.0;
    wired["wires"] = json::parse(
        R"([{ "id": "w0", "src": { "instanceKey": "lfo", "field": "output" },
              "dest": { "instanceKey": "inv", "field": "__opacity__" },
              "combine": "replace", "magnitude": "unsigned" }])");
    sketch_executor::SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
    ex.setKeyNamespace("reswire/");
    // Automation says fully transparent; the live wire (resting LFO -> 0.5,
    // unsigned replace into [0,1]) must win -> half mix.
    ex.setAutomation(json::parse(
        R"([{ "instance": "inv", "field": "__opacity__", "value": 0.0,
              "combine": "replace", "magnitude": "unsigned" }])"));
    ex.execute(wired, inTex, outTex, W, H, 1.0 / 60.0, true);
    const double half = meanRgb(hx.read(outTex));
    INFO("wired half " << half);
    CHECK(std::abs(half - 127.0) < 25.0);
    // Telemetry band recorded under the reserved key (wire-driven).
    const auto& mod = ex.lastModulationData();
    REQUIRE(mod.contains("inv"));
    CHECK(mod["inv"].contains("__opacity__"));
  }

  SECTION("a wire wakes a statically-bypassed effect") {
    // The polarity check for `__enable__`: a modulation source at its TOP turns
    // the effect ON. Signed LFO forced unsigned prescales v*0.5+0.5, so
    // +0.5 -> 0.75 (>= 0.5, ON) and -0.5 -> 0.25 (< 0.5, OFF). Under the old
    // `__bypass__` key both of these assertions read the other way round — which
    // is exactly the inversion this key exists to kill.
    auto wired = sketch;
    wired["instances"]["inv"]["state"]["__enable__"] = false;  // authored: OFF
    wired["instances"]["lfo"]["state"]["output"] = 0.5;        // wire says: ON
    wired["wires"] = json::parse(
        R"([{ "id": "w0", "src": { "instanceKey": "lfo", "field": "output" },
              "dest": { "instanceKey": "inv", "field": "__enable__" },
              "combine": "replace", "magnitude": "unsigned" }])");
    sketch_executor::SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
    ex.setKeyNamespace("resunbyp/");
    ex.execute(wired, inTex, outTex, W, H, 1.0 / 60.0, true);
    const double on = meanRgb(hx.read(outTex));

    // Drop the producer below threshold: dormant again (passthrough white).
    wired["instances"]["lfo"]["state"]["output"] = -0.5;
    ex.execute(wired, inTex, outTex, W, H, 1.0 / 60.0, true);
    const double off = meanRgb(hx.read(outTex));

    INFO("enabled " << on << " bypassed " << off);
    CHECK(on < 20.0);    // wire held the effect ON despite authored __enable__=0
    CHECK(off > 235.0);  // wire fell under 0.5 -> dormant passthrough
  }
}

// ── Phase 2: __layer__ composition-param resolution + track-level rail reads ─

TEST_CASE("layer targets resolve per bake site (and a lane forces the elided blend)",
          "[comp_layer]") {
  EvalHarness h;
  const json opacityLane = json::array(
      {{{"id", "L"}, {"targetDeviceId", "__layer__"}, {"targetField", "opacity"},
        {"label", "op"}, {"points", json::array({{{"x", 0}, {"y", 1}}})}}});

  SECTION("black bg: every source clip composites over arr_bg -> blend targets") {
    h.cx.loadDocument(mkComposition(json::array({
        mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                          json::array({mkDevice("d1", "source.solid_color")}))})),
        mkTrack("t2", json::array({mkClip("c2", 0, 8,
                                          json::array({mkDevice("d2", "source.solid_color")}))})),
    })));
    h.cx.seekBeat(1.0);
    h.cx.update(0.0);
    const json lt = json::parse(h.cx.layerTargetsJson());
    REQUIRE(lt.is_object());
    CHECK(lt["t1"]["instanceKey"] == "clip_c1_blend");
    CHECK(lt["t1"]["field"] == "opacity");
    CHECK(lt["t2"]["instanceKey"] == "clip_c2_blend");
  }

  SECTION("transparent bg: the TOP layer's opacity is the first device's __opacity__") {
    json doc = mkComposition(json::array({
        mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                          json::array({mkDevice("d1", "source.solid_color")}))})),
    }));
    doc["meta"]["background"] = {{"mode", "transparent"}};
    h.cx.loadDocument(doc);
    h.cx.seekBeat(1.0);
    h.cx.update(0.0);
    const json lt = json::parse(h.cx.layerTargetsJson());
    CHECK(lt["t1"]["instanceKey"] == "clip_c1_d1");
    CHECK(lt["t1"]["field"] == "__opacity__");
  }

  SECTION("effect-only clip: the adjustment layer's first fx device __opacity__") {
    json doc = mkComposition(json::array({
        mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                          json::array({mkDevice("d1", "source.solid_color")}))})),
        mkTrack("t2", json::array({mkClip("fx1", 0, 8,
                                          json::array({mkDevice("i1", "source.video.file")}))})),
    }));
    // Make fx1 a true effect-only clip: swap its device for a NON-generator.
    h.cx.registerSchema("color.invert", json::object());
    h.cx.registerCapabilities("color.invert", json::array());
    doc["tracks"][1]["clips"][0]["sketch"]["devices"] =
        json::array({mkDevice("i1", "color.invert")});
    h.cx.loadDocument(doc);
    h.cx.seekBeat(1.0);
    h.cx.update(0.0);
    const json lt = json::parse(h.cx.layerTargetsJson());
    CHECK(lt["t2"]["instanceKey"] == "clip_fx1_i1");
    CHECK(lt["t2"]["field"] == "__opacity__");
  }

  SECTION("a group __layer__ lane FORCES the blend `underlying`+opacity>=1 would elide") {
    json g = mkTrack("g1", json::array(), {{"kind", "group"},
                                           {"groupInput", {{"mode", "underlying"}}}});
    json inner = mkTrack("t1", json::array({mkClip(
        "c1", 0, 8, json::array({mkDevice("d1", "source.solid_color")}))}),
        {{"parentId", "g1"}});
    json below = mkTrack("t2", json::array({mkClip(
        "c2", 0, 8, json::array({mkDevice("d2", "source.solid_color")}))}));
    // Without the lane: underlying + opacity 1 elides the group blend.
    h.cx.loadDocument(mkComposition(json::array({g, inner, below})));
    h.cx.seekBeat(1.0);
    h.cx.update(0.0);
    CHECK(h.cx.chainKeysJson().find("group_g1_blend") == std::string::npos);
    CHECK(json::parse(h.cx.layerTargetsJson()).contains("g1") == false);

    // With a __layer__/opacity lane on the group: the blend must exist.
    g["automation"] = opacityLane;
    h.cx.loadDocument(mkComposition(json::array({g, inner, below})));
    h.cx.update(0.0);
    CHECK(h.cx.chainKeysJson().find("group_g1_blend") != std::string::npos);
    const json lt = json::parse(h.cx.layerTargetsJson());
    CHECK(lt["g1"]["instanceKey"] == "group_g1_blend");
    CHECK(lt["g1"]["field"] == "opacity");
  }
}

TEST_CASE("a __layer__ opacity lane and a track-level rail read reach the pixels",
          "[comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  SECTION("track lane fades the layer (blend opacity 1 -> 0 across the clip)") {
    // White solid over the black bg; a track lane drives __layer__/opacity from
    // 1 (beat 0) to 0 (beat 8). At beat ~0 the layer is opaque white; at beat
    // ~7.9 nearly transparent -> black bg shows through.
    json t1 = mkTrack("t1", json::array({mkClip(
        "c1", 0, 8,
        json::array({mkDevice("d1", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}})}))}));
    t1["automation"] = json::array(
        {{{"id", "L"}, {"targetDeviceId", "__layer__"}, {"targetField", "opacity"},
          {"label", "op"},
          {"points", json::array({{{"x", 0}, {"y", 1}}, {{"x", 8}, {"y", 0}}})}}});
    const json doc = mkComposition(json::array({t1}));

    comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
    hx.seed(cx);
    cx.loadDocument(doc);
    int32_t inTex = hx.makeTex(), outTex = hx.makeTex();

    cx.seekBeat(0.01);
    cx.update(0.0);
    const double bright = meanRgb(hx.read(cx.render(inTex, outTex, W, H, 1.0 / 60.0)));

    cx.seekBeat(7.9);
    cx.update(0.0);
    const double dim = meanRgb(hx.read(cx.render(inTex, outTex, W, H, 1.0 / 60.0)));

    INFO("bright " << bright << " dim " << dim);
    CHECK(bright > 220.0);
    CHECK(dim < 30.0);
  }

  SECTION("a rail (return track) drives a track's layer opacity via track.reads") {
    // Writer: a resting LFO (state output 0, declared [-1,1]) exported onto
    // rail R -> remapped to 0.5. Reader: t2's TRACK-level read targets
    // __layer__/opacity -> the white layer blends at 0.5 over black -> gray.
    json writerClip = mkClip("cw", 0, 8,
                             json::array({mkDevice("lfo", "mod.source.lfo",
                                                   {{"rate", 0.0}, {"output", 0.0}})}));
    writerClip["exports"] = json::array(
        {{{"id", "e1"}, {"railId", "R"}, {"sourceDeviceId", "lfo"}, {"sourceField", "output"},
          {"combine", "replace"}}});
    json t1 = mkTrack("t1", json::array({writerClip}));
    json t2 = mkTrack("t2", json::array({mkClip(
        "c2", 0, 8,
        json::array({mkDevice("d2", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}})}))}));
    t2["reads"] = json::array(
        {{{"id", "r1"}, {"railId", "R"}, {"targetDeviceId", "__layer__"},
          {"targetField", "opacity"}, {"combine", "replace"}}});
    json rail = mkTrack("r", json::array(), {{"kind", "rail"}, {"railId", "R"}});
    const json doc = mkComposition(json::array({t1, t2, rail}));

    // The rail accumulator's live `output` flows through the published-state
    // mirror (foldPublishedOutputs); natively that's the barrel's state-doc
    // provider — synthesize the identity shaper's output here, exactly like
    // the LFO-fold test above.
    sketch_executor::effrtSetPublishedStateProvider(
        [](effect_runtime::EffectInstance* i) -> std::string {
          return i->id() == "mod.shaper.remap" ? std::string("{\"output\":0.5}")
                                               : std::string();
        });

    comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
    hx.seed(cx);
    cx.loadDocument(doc);
    cx.seekBeat(1.0);
    int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
    // The rail node precedes the writer in the chain (delayed tap) — settle a
    // few frames before asserting.
    double m = 0;
    for (int i = 0; i < 4; i++) {
      cx.update(0.0);
      m = meanRgb(hx.read(cx.render(inTex, outTex, W, H, 1.0 / 60.0)));
    }
    sketch_executor::effrtSetPublishedStateProvider(nullptr);
    INFO("mean " << m << " (expect ~127: white layer at rail-driven opacity 0.5)");
    CHECK(std::abs(m - 127.0) < 25.0);
  }
}

// ── Phase 3: eval-level track/group bypass via __layer__/bypass lanes ────────

TEST_CASE("a __layer__/bypass lane structurally drops the subtree at its crossing",
          "[comp_bypass]") {
  EvalHarness h;
  // t1: content across [0,16); its bypass lane ramps 0 -> 1 over [0,8] with the
  // 0.5 threshold crossing at beat 4. t2: a second track so hasContent stays
  // true after the drop (we assert the STRUCTURE change, not content loss).
  json t1 = mkTrack("t1", json::array({mkClip(
      "c1", 0, 16, json::array({mkDevice("d1", "source.solid_color")}))}));
  t1["automation"] = json::array(
      {{{"id", "B"}, {"targetDeviceId", "__layer__"}, {"targetField", "bypass"},
        {"label", "byp"},
        {"points", json::array({{{"x", 0}, {"y", 0}}, {{"x", 8}, {"y", 1}}})}}});
  json t2 = mkTrack("t2", json::array({mkClip(
      "c2", 0, 16, json::array({mkDevice("d2", "source.solid_color")}))}));
  h.cx.loadDocument(mkComposition(json::array({t1, t2})));

  h.cx.seekBeat(0.5);
  uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK(h.cx.chainKeysJson().find("clip_c1_d1") != std::string::npos);
  CHECK(h.cx.evalCount() == 1);

  // Play toward the crossing: within the span, decisions stable — no re-eval.
  h.cx.play();
  h.run(60, 1.0 / 60.0);  // -> ~beat 2.5
  CHECK(h.cx.evalCount() == 1);

  // Cross beat 4: the decision flips -> exactly one re-eval, structure changes,
  // t1's chain leaves the composite (t2 remains -> content stays).
  flags = h.run(60, 1.0 / 60.0);  // -> ~beat 4.5
  CHECK(h.cx.positionBeat() > 4.0);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK((flags & comp::kCompHasContent) != 0);
  CHECK(h.cx.evalCount() == 2);
  CHECK(h.cx.chainKeysJson().find("clip_c1_d1") == std::string::npos);
  CHECK(h.cx.chainKeysJson().find("clip_c2_d2") != std::string::npos);

  // Keep playing inside the dropped region: still one span, no churn.
  h.run(60, 1.0 / 60.0);  // -> ~beat 6.5
  CHECK(h.cx.evalCount() == 2);

  // Seeking back before the crossing restores the layer (decision flips back).
  h.cx.pause();
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  CHECK(h.cx.chainKeysJson().find("clip_c1_d1") != std::string::npos);
}

TEST_CASE("a dynamically-bypassed track keeps its video decode warm", "[comp_bypass]") {
  EvalHarness h;
  // A video clip on a track whose bypass lane is ON at the playhead: the layer
  // is dropped (not ACTIVE), but the pump target must keep the clip warm — the
  // warm scan deliberately uses STATIC bypass only, so an un-bypass doesn't
  // stall on a cold decoder (Precise gate).
  json t1 = mkTrack("t1", json::array({mkVideoClip("v1", 0, 8)}));
  t1["automation"] = json::array(
      {{{"id", "B"}, {"targetDeviceId", "__layer__"}, {"targetField", "bypass"},
        {"label", "byp"}, {"points", json::array({{{"x", 0}, {"y", 1}}})}}});
  json t2 = mkTrack("t2", json::array({mkClip(
      "c2", 0, 8, json::array({mkDevice("d2", "source.solid_color")}))}));
  h.cx.loadDocument(mkComposition(json::array({t1, t2})));
  h.cx.setTransportMode(false);  // Fluid: don't hold on the (unready) video
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  // Dropped from the composite...
  CHECK(h.cx.chainKeysJson().find("clip_v1_") == std::string::npos);
  // ...but the pump still warms it.
  CHECK(h.cx.videoDescsJson().find("blob:media/v1") != std::string::npos);
}

// ── Phase 5: rail-driven track/group bypass (post-render readback loop) ──────

TEST_CASE("a return rail structurally toggles another track's bypass (1-frame loop)",
          "[comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  // Writer: an LFO clip on t1 exporting onto rail R. Reader: t2 (a white
  // solid) carries a TRACK-level read {R, __layer__, bypass} — never an
  // executor wire; the comp executor samples the rail's live output after each
  // render, thresholds >= 0.5, and re-evaluates on a decision flip. The rail's
  // live output rides the published-state mirror — synthesize it (the barrel's
  // state-doc seam) and flip it mid-test.
  json writerClip = mkClip("cw", 0, 8,
                           json::array({mkDevice("lfo", "mod.source.lfo",
                                                 {{"rate", 0.0}, {"output", 0.0}})}));
  writerClip["exports"] = json::array(
      {{{"id", "e1"}, {"railId", "R"}, {"sourceDeviceId", "lfo"}, {"sourceField", "output"},
        {"combine", "replace"}}});
  json t1 = mkTrack("t1", json::array({writerClip}));
  json t2 = mkTrack("t2", json::array({mkClip(
      "c2", 0, 8,
      json::array({mkDevice("d2", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}})}))}));
  t2["reads"] = json::array(
      {{{"id", "r1"}, {"railId", "R"}, {"targetDeviceId", "__layer__"},
        {"targetField", "bypass"}, {"combine", "replace"}}});
  json rail = mkTrack("r", json::array(), {{"kind", "rail"}, {"railId", "R"}});
  const json doc = mkComposition(json::array({t1, t2, rail}));

  static double railOutput = 0.0;  // the synthesized live rail value
  sketch_executor::effrtSetPublishedStateProvider(
      [](effect_runtime::EffectInstance* i) -> std::string {
        if (i->id() != "mod.shaper.remap") return std::string();
        return std::string("{\"output\":") + std::to_string(railOutput) + "}";
      });

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  cx.seekBeat(1.0);
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
  auto frame = [&]() {
    cx.update(0.0);
    return meanRgb(hx.read(cx.render(inTex, outTex, W, H, 1.0 / 60.0)));
  };

  // Rail below threshold: t2 renders (white).
  railOutput = 0.25;
  double m = 0;
  for (int i = 0; i < 3; i++) m = frame();
  INFO("below-threshold mean " << m);
  CHECK(m > 200.0);
  const int64_t evalsSettled = cx.evalCount();

  // Steady frames: decisions stable — no re-evals.
  for (int i = 0; i < 5; i++) m = frame();
  CHECK(cx.evalCount() == evalsSettled);

  // Rail crosses the threshold: within a frame of readback latency t2 DROPS.
  railOutput = 0.75;
  for (int i = 0; i < 3; i++) m = frame();
  INFO("above-threshold mean " << m);
  CHECK(m < 30.0);  // white layer structurally gone (black bg + passthroughs)
  CHECK(cx.evalCount() == evalsSettled + 1);  // exactly one re-eval per flip

  // ...and back: the rail node survived the drop (keep-alive), so the value
  // can flip the track back in.
  railOutput = 0.25;
  for (int i = 0; i < 3; i++) m = frame();
  INFO("recovered mean " << m);
  CHECK(m > 200.0);
  CHECK(cx.evalCount() == evalsSettled + 2);

  sketch_executor::effrtSetPublishedStateProvider(nullptr);
}

TEST_CASE("a TRACK-chain LFO wire folds through the published-state mirror",
          "[comp_render]") {
  // The track-FX-bus twin of the clip-level LFO-fold test: the LFO + its wire
  // live on the TRACK's sketch (mod sources on tracks), keyed
  // track_<id>_<dev>. white clip -> track chain [lfo -> bc], track wire
  // lfo.output -> bc.brightness. Live output 0 -> neutral brightness -> the
  // -0.5 contrast alone -> grey ~128. A dropped track wire leaves brightness
  // 1 -> much brighter.
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  json t1 = mkTrack("t1", json::array({mkClip(
      "c1", 0, 8,
      json::array({mkDevice("d1", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}})}))}));
  t1["sketch"] = {
      {"devices", json::array({
          mkDevice("lfo", "mod.source.lfo", {{"rate", 0.0}, {"amplitude", 1.0}}),
          mkDevice("bc", "color.tone.brightness_contrast",
                   {{"brightness", 1.0}, {"contrast", -0.5}})})},
      {"wires", json::array({{{"id", "x1"},
                              {"src", {{"instanceKey", "lfo"}, {"field", "output"}}},
                              {"dest", {{"instanceKey", "bc"}, {"field", "brightness"}}}}})}};
  const json doc = mkComposition(json::array({t1}));

  sketch_executor::effrtSetPublishedStateProvider(
      [](effect_runtime::EffectInstance* i) -> std::string {
        return i->id() == "mod.source.lfo" ? std::string("{\"output\":0.0}") : std::string();
      });

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  cx.seekBeat(1.0);
  cx.update(0.0);
  // The track chain is IN the composite, keyed per-track.
  CHECK(cx.chainKeysJson().find("track_t1_lfo") != std::string::npos);
  CHECK(cx.chainKeysJson().find("track_t1_bc") != std::string::npos);
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
  const int32_t out = cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  const double m = meanRgb(hx.read(out));
  sketch_executor::effrtSetPublishedStateProvider(nullptr);

  INFO("output mean " << m << " (expect ~128 grey)");
  CHECK(std::abs(m - 128.0) < 20.0);
}

TEST_CASE("a TRACK-chain mod source wires to its OWN layer opacity", "[comp_render]") {
  // Mod sources on tracks driving the track's own layer: a track-sketch wire
  // with dest __layer__/opacity resolves to the layer's blend param (emitted
  // after the layer composites — pushOwnerLayerWires). White clip over black
  // bg; the track LFO rests at 0 (signed decl → unsigned 0.5) → half fade.
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  json t1 = mkTrack("t1", json::array({mkClip(
      "c1", 0, 8,
      json::array({mkDevice("d1", "source.solid_color", {{"color", {1.0, 1.0, 1.0}}})}))}));
  t1["sketch"] = {
      {"devices", json::array({mkDevice("lfo", "mod.source.lfo",
                                        {{"rate", 0.0}, {"amplitude", 1.0}})})},
      {"wires", json::array({{{"id", "x1"},
                              {"src", {{"instanceKey", "lfo"}, {"field", "output"}}},
                              {"dest", {{"instanceKey", "__layer__"}, {"field", "opacity"}}},
                              {"combine", "replace"}, {"magnitude", "unsigned"}}})}};
  const json doc = mkComposition(json::array({t1}));

  sketch_executor::effrtSetPublishedStateProvider(
      [](effect_runtime::EffectInstance* i) -> std::string {
        return i->id() == "mod.source.lfo" ? std::string("{\"output\":0.0}") : std::string();
      });

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(doc);
  cx.seekBeat(1.0);
  cx.update(0.0);
  // The wire forced the layer target to resolve (a blend over arr_bg).
  const json lt = json::parse(cx.layerTargetsJson());
  REQUIRE(lt.contains("t1"));
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
  double m = 0;
  for (int i = 0; i < 3; i++) {  // published-state fold has 1-frame latency
    cx.update(0.0);
    m = meanRgb(hx.read(cx.render(inTex, outTex, W, H, 1.0 / 60.0)));
  }
  sketch_executor::effrtSetPublishedStateProvider(nullptr);
  INFO("mean " << m << " (expect ~127: white layer at wire-driven opacity 0.5)");
  CHECK(std::abs(m - 127.0) < 25.0);
}

// ── Scene tracks: transient launch state (update()-only, no GPU) ────────────

namespace {

/** A scene track: kind 'scene'; clips are scenes (startBeat 0, array order). */
json mkSceneTrack(const std::string& id, json scenes, json over = json::object()) {
  json t = mkTrack(id, std::move(scenes), {{"kind", "scene"}});
  t.update(over);
  return t;
}

json mkScene(const std::string& id, double lengthBeat, json over = json::object()) {
  json c = mkClip(id, 0, lengthBeat, json::array({mkDevice(id + "_d", "source.solid_color")}));
  c.update(over);
  return c;
}

}  // namespace

TEST_CASE("scenes: launch/replace/retrigger/stop lifecycle", "[comp_scene]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkSceneTrack("st", json::array({mkScene("s1", 8), mkScene("s2", 8)})),
  })));
  h.cx.seekBeat(0.5);

  // Nothing launched: a scene track alone composites nothing, and its scenes'
  // fake extents contribute no eval boundaries (span = infinity).
  uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) == 0);
  CHECK(h.cx.evalCount() == 1);
  CHECK(h.cx.evalBoundaryBeat() == std::numeric_limits<double>::infinity());

  // Launch s1: exactly one re-eval, content + structure + scenes flags.
  h.cx.launchScene("st", "s1");
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) != 0);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK((flags & comp::kCompScenesChanged) != 0);
  CHECK(h.cx.evalCount() == 2);
  CHECK(json::parse(h.cx.chainKeysJson()).dump().find("clip_s1_") != std::string::npos);

  // Steady playback: the launched scene holds without re-evals.
  h.cx.play();
  flags = h.run(60, 1.0 / 60.0);
  CHECK(h.cx.evalCount() == 2);
  CHECK((flags & comp::kCompScenesChanged) == 0);

  // Launch s2: mutual exclusion — s2 replaces s1 on the track.
  h.cx.launchScene("st", "s2");
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompStructureChanged) != 0);
  const std::string keys2 = json::parse(h.cx.chainKeysJson()).dump();
  CHECK(keys2.find("clip_s2_") != std::string::npos);
  CHECK(keys2.find("clip_s1_") == std::string::npos);

  // Retrigger s2: same topology, re-anchored launch beat.
  const double beatBefore = h.cx.positionBeat();
  const double anchorBefore =
      json::parse(h.cx.sceneStatesJson())["st"]["launchBeat"].get<double>();
  h.run(30, 1.0 / 60.0);  // advance half a second
  h.cx.launchScene("st", "s2");
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompStructureChanged) == 0);
  CHECK((flags & comp::kCompScenesChanged) != 0);
  const double anchorAfter =
      json::parse(h.cx.sceneStatesJson())["st"]["launchBeat"].get<double>();
  CHECK(anchorAfter > anchorBefore);
  CHECK(anchorAfter >= beatBefore);

  // Stop: the track leaves the composite.
  h.cx.stopScene("st");
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) == 0);
  CHECK((flags & comp::kCompScenesChanged) != 0);
  CHECK(json::parse(h.cx.sceneStatesJson()).empty());
}

TEST_CASE("scenes: clip lanes anchor at the launch beat", "[comp_scene]") {
  // Pure comp_eval check: a scene's clip-relative lane evaluates from the
  // LAUNCH beat, not the scene's meaningless startBeat.
  json scene = mkScene("s1", 8);
  scene["automation"] = json::array({{{"id", "l1"},
                                      {"targetDeviceId", "s1_d"},
                                      {"targetField", "scale"},
                                      {"points", json::array({{{"x", 0}, {"y", 0}},
                                                              {{"x", 1}, {"y", 1}}})}}});
  const comp::CompositionM comp = comp::parseComposition(
      mkComposition(json::array({mkSceneTrack("st", json::array({scene}))})));
  std::map<std::string, comp::SceneLaunch> launches;
  launches["st"] = {"s1", 4.0, 2.0};

  auto tree = comp::compositeTreeAtBeat(comp, 6.0, false, nullptr, &launches);
  REQUIRE(tree.size() == 1);
  CHECK(tree[0].anchorBeat == 4.0);
  const json entries = comp::automationEntriesForTree(comp, tree, 6.0);
  REQUIRE(entries.size() == 1);
  // elapsed 2 of span 8 → x=0.25 on the 0→1 ramp.
  CHECK(std::abs(entries[0]["value"].get<double>() - 0.25) < 1e-6);

  // Without launch state (goldens / offline export) the scene track is empty.
  CHECK(comp::compositeTreeAtBeat(comp, 6.0).empty());
}

TEST_CASE("scenes: doc reloads heal, deletes stop, opens reset", "[comp_scene]") {
  EvalHarness h;
  const json doc = mkComposition(json::array({
      mkSceneTrack("st", json::array({mkScene("s1", 8), mkScene("s2", 8)})),
  }));
  h.cx.loadDocument(doc);
  h.cx.seekBeat(0.5);
  h.cx.launchScene("st", "s1");
  h.cx.update(0.0);
  CHECK(!json::parse(h.cx.sceneStatesJson()).empty());

  // An unrelated edit round-trips as a doc reload: the launch SURVIVES.
  h.cx.loadDocument(doc);
  uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) != 0);
  CHECK(json::parse(h.cx.sceneStatesJson()).contains("st"));

  // Deleting the playing scene lands as a reload without it: the launch heals
  // away and the track empties.
  json without = mkComposition(json::array({
      mkSceneTrack("st", json::array({mkScene("s2", 8)})),
  }));
  h.cx.loadDocument(without);
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) == 0);
  CHECK((flags & comp::kCompScenesChanged) != 0);
  CHECK(json::parse(h.cx.sceneStatesJson()).empty());

  // Document open resets everything explicitly.
  h.cx.loadDocument(doc);
  h.cx.launchScene("st", "s2");
  h.cx.update(0.0);
  h.cx.stopAllScenes();
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompHasContent) == 0);
  CHECK(json::parse(h.cx.sceneStatesJson()).empty());
}

TEST_CASE("scenes: one-shot scenes auto-stop when their content ends", "[comp_scene]") {
  EvalHarness h;

  SECTION("effect scene: lengthBeat is the nominal duration") {
    json s = mkScene("s1", 2);  // 2 beats = 1s at 120 BPM
    s["loop"]["mode"] = "one-shot";
    h.cx.loadDocument(mkComposition(json::array({mkSceneTrack("st", json::array({s}))})));
    h.cx.seekBeat(0.0);
    h.cx.launchScene("st", "s1");
    h.cx.update(0.0);
    CHECK(!json::parse(h.cx.sceneStatesJson()).empty());
    h.cx.play();
    h.run(90, 1.0 / 60.0);  // 1.5s → beat 3 > launch(0) + 2
    CHECK(h.cx.positionBeat() > 2.0);
    CHECK(json::parse(h.cx.sceneStatesJson()).empty());
    CHECK((h.cx.update(0.0) & comp::kCompHasContent) == 0);
  }

  SECTION("video scene: the source slice at its speed") {
    json s = mkVideoClip("v1", 0, 32);  // long nominal length; the SLICE rules
    s["loop"] = {{"mode", "one-shot"}, {"startSec", 0.0}, {"endSec", 1.0},
                 {"speed", 1.0}, {"direction", "forward"}};
    h.cx.loadDocument(mkComposition(json::array({mkSceneTrack("st", json::array({s}))})));
    h.cx.setTransportMode(false);  // Fluid — never-ready test video must not hold
    h.cx.seekBeat(0.0);
    h.cx.launchScene("st", "v1");
    h.cx.update(0.0);
    h.cx.play();
    h.run(90, 1.0 / 60.0);  // 1.5s > 1s slice
    CHECK(json::parse(h.cx.sceneStatesJson()).empty());
  }

  SECTION("looping scene never auto-stops") {
    json s = mkScene("s1", 2);  // mode stays 'time' (looping)
    h.cx.loadDocument(mkComposition(json::array({mkSceneTrack("st", json::array({s}))})));
    h.cx.seekBeat(0.0);
    h.cx.launchScene("st", "s1");
    h.cx.update(0.0);
    h.cx.play();
    h.run(240, 1.0 / 60.0);  // 4s → beat 8, far past lengthBeat
    CHECK(!json::parse(h.cx.sceneStatesJson()).empty());
  }
}

TEST_CASE("scenes: scene extents never perturb the timeline", "[comp_scene]") {
  EvalHarness h;
  // A normal clip [0,16) + a scene with fake extent [0,8): the eval span and
  // the composition length must see only the arrangement clip.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("c1", 0, 16,
                                        json::array({mkDevice("d1", "source.solid_color")}))})),
      mkSceneTrack("st", json::array({mkScene("s1", 8)})),
  })));
  h.cx.seekBeat(0.5);
  h.cx.update(0.0);
  CHECK(h.cx.evalBoundaryBeat() == 16.0);  // not the scene's 8

  // A launched scene's video desc carries the LAUNCH beat as its anchor.
  EvalHarness h2;
  h2.cx.loadDocument(mkComposition(json::array({
      mkSceneTrack("st", json::array({mkVideoClip("v1", 0, 8)})),
  })));
  h2.cx.setTransportMode(false);
  h2.cx.seekBeat(5.0);
  h2.cx.launchScene("st", "v1");
  h2.cx.update(0.0);
  const json descs = json::parse(h2.cx.videoDescsJson());
  REQUIRE(descs.size() == 1);
  CHECK(descs[0]["startBeat"].get<double>() == 5.0);
}

// ── Trigger transport: published "triggers" rings → scene launches ──────────

namespace {

/** A scene track with two solid scenes (auto channels 1 and 2) + a normal
 *  track hosting the trigger SOURCE (an LFO caps-overridden as a
 *  trigger_source; the ring is synthesized by the test provider). */
json triggerScenario(json sceneOver1 = json::object(), json trackOver = json::object()) {
  json s1 = mkScene("s1", 8);
  s1.update(sceneOver1);
  json st = mkSceneTrack("st", json::array({s1, mkScene("s2", 8)}));
  st.update(trackOver);
  json host = mkClip("c1", 0, 64,
                     json::array({mkDevice("d1", "source.solid_color"),
                                  mkDevice("trig", "mod.source.lfo", {{"rate", 0.0}})}));
  return mkComposition(json::array({mkTrack("t1", json::array({host})), st}));
}

/** The test-scripted trigger ring, returned for the LFO instance only. */
json g_triggerRing = json::array();

void installTriggerProvider() {
  sketch_executor::effrtSetPublishedStateProvider(
      [](effect_runtime::EffectInstance* i) -> std::string {
        if (i->id() != "mod.source.lfo") return std::string();
        return json{{"output", 0.0}, {"triggers", g_triggerRing}}.dump();
      });
}

/** One full frame: update (materializes any pending launch) + render (reads
 *  the rings post-execute). Returns the launched-scene map after the frame. */
json triggerFrame(comp::CompExecutor& cx, Harness& hx, int32_t inTex, int32_t outTex) {
  cx.update(0.0);
  cx.render(inTex, outTex, W, H, 1.0 / 60.0);
  return json::parse(cx.sceneStatesJson());
}

}  // namespace

TEST_CASE("triggers: ring events launch scenes by channel", "[comp_trigger]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");
  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // The LFO doubles as the test's trigger source (routes rebuild on load).
  cx.registerCapabilities("mod.source.lfo",
                          json::array({"modulation_source", "trigger_source"}));
  g_triggerRing = json::array();
  installTriggerProvider();
  cx.loadDocument(triggerScenario());
  cx.seekBeat(1.0);
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();

  // First frames baseline the ring (no history replay) — nothing launches.
  triggerFrame(cx, hx, inTex, outTex);
  CHECK(triggerFrame(cx, hx, inTex, outTex).empty());

  SECTION("channel 1 launches s1 (auto assignment); dedupe holds; channel 2 switches") {
    g_triggerRing.push_back({{"seq", 1}, {"on", true}, {"channel", 1}, {"velocity", 1.0}});
    triggerFrame(cx, hx, inTex, outTex);  // render consumes; launch lands next update
    json s = triggerFrame(cx, hx, inTex, outTex);
    REQUIRE(s.contains("st"));
    CHECK(s["st"]["sceneId"] == "s1");

    // The same ring re-read every frame must NOT relaunch (seq consumed).
    cx.stopScene("st");
    triggerFrame(cx, hx, inTex, outTex);
    CHECK(triggerFrame(cx, hx, inTex, outTex).empty());

    // A new event on channel 2 launches s2 (mutual exclusion via the slot).
    g_triggerRing.push_back({{"seq", 2}, {"on", true}, {"channel", 2}});
    triggerFrame(cx, hx, inTex, outTex);
    s = triggerFrame(cx, hx, inTex, outTex);
    REQUIRE(s.contains("st"));
    CHECK(s["st"]["sceneId"] == "s2");
  }

  SECTION("off events and unmatched channels are ignored") {
    g_triggerRing.push_back({{"seq", 1}, {"on", false}, {"channel", 1}});
    g_triggerRing.push_back({{"seq", 2}, {"on", true}, {"channel", 9}});
    triggerFrame(cx, hx, inTex, outTex);
    CHECK(triggerFrame(cx, hx, inTex, outTex).empty());
  }

  SECTION("a seq regression means the instance reset - resync, then fire") {
    g_triggerRing.push_back({{"seq", 5}, {"on", true, }, {"channel", 9}});  // consumed (no match)
    triggerFrame(cx, hx, inTex, outTex);
    g_triggerRing = json::array();  // instance reset: ring restarts at seq 1
    g_triggerRing.push_back({{"seq", 1}, {"on", true}, {"channel", 1}});
    triggerFrame(cx, hx, inTex, outTex);
    json s = triggerFrame(cx, hx, inTex, outTex);
    REQUIRE(s.contains("st"));
    CHECK(s["st"]["sceneId"] == "s1");
  }

  sketch_executor::effrtSetPublishedStateProvider(nullptr);
}

TEST_CASE("triggers: rail routing overrides the global default", "[comp_trigger]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");
  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.registerCapabilities("mod.source.lfo",
                          json::array({"modulation_source", "trigger_source"}));
  g_triggerRing = json::array();
  installTriggerProvider();
  int32_t inTex = hx.makeTex(), outTex = hx.makeTex();

  SECTION("a scene listening on a private rail ignores global events") {
    // s2 listens on rail r9; the source (no export) writes GLOBAL.
    json doc = triggerScenario();
    doc["tracks"][1]["clips"][1]["triggerRead"] = {{"id", "tr1"}, {"railId", "r9"}};
    cx.loadDocument(doc);
    cx.seekBeat(1.0);
    triggerFrame(cx, hx, inTex, outTex);  // baseline
    g_triggerRing.push_back({{"seq", 1}, {"on", true}, {"channel", 2}});  // s2's channel
    triggerFrame(cx, hx, inTex, outTex);
    CHECK(triggerFrame(cx, hx, inTex, outTex).empty());  // global ≠ r9
  }

  SECTION("an exported source reaches the scene's private rail") {
    json doc = triggerScenario();
    doc["tracks"][1]["clips"][1]["triggerRead"] = {{"id", "tr1"}, {"railId", "r9"}};
    doc["tracks"][0]["clips"][0]["triggerExports"] =
        json::array({{{"id", "te1"}, {"railId", "r9"}, {"sourceDeviceId", "trig"}}});
    cx.loadDocument(doc);
    cx.seekBeat(1.0);
    triggerFrame(cx, hx, inTex, outTex);  // baseline
    g_triggerRing.push_back({{"seq", 1}, {"on", true}, {"channel", 2}});
    triggerFrame(cx, hx, inTex, outTex);
    json s = triggerFrame(cx, hx, inTex, outTex);
    REQUIRE(s.contains("st"));
    CHECK(s["st"]["sceneId"] == "s2");
    // ...and s1 (still on GLOBAL, channel 1) is NOT reachable via r9.
    g_triggerRing.push_back({{"seq", 2}, {"on", true}, {"channel", 1}});
    triggerFrame(cx, hx, inTex, outTex);
    s = triggerFrame(cx, hx, inTex, outTex);
    CHECK(s["st"]["sceneId"] == "s2");  // unchanged — r9 event, s1 listens global
  }

  SECTION("a TRACK-level listen sets the default for all scenes") {
    json doc = triggerScenario(json::object(),
                               {{"triggerRead", {{"id", "tr2"}, {"railId", "r9"}}}});
    doc["tracks"][0]["clips"][0]["triggerExports"] =
        json::array({{{"id", "te1"}, {"railId", "r9"}, {"sourceDeviceId", "trig"}}});
    cx.loadDocument(doc);
    cx.seekBeat(1.0);
    triggerFrame(cx, hx, inTex, outTex);  // baseline
    g_triggerRing.push_back({{"seq", 1}, {"on", true}, {"channel", 1}});
    triggerFrame(cx, hx, inTex, outTex);
    json s = triggerFrame(cx, hx, inTex, outTex);
    REQUIRE(s.contains("st"));
    CHECK(s["st"]["sceneId"] == "s1");
  }

  sketch_executor::effrtSetPublishedStateProvider(nullptr);
}

TEST_CASE("triggers: mod.trigger.beat ships in core.wasm with the trigger_source cap",
          "[comp_trigger]") {
  // Natively the published-state provider is the barrel's (deferred) seam, so
  // the real ring can't be observed here — the web e2e covers that end to end.
  // This pins the BUNDLE: the effect registers, and its capability + schema
  // reach the comp catalog (what rebuildTriggerRoutes and the UI key off).
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");
  const auto* reg = hx.registry->find("mod.trigger.beat");
  REQUIRE(reg != nullptr);
  bool hasTrig = false;
  for (const auto& c : reg->capabilities) hasTrig |= (c == "trigger_source");
  CHECK(hasTrig);
  comp::CompExecutor cx(nullptr, nullptr, nullptr);
  hx.seed(cx);
  // The route builder resolves it as a trigger source through the catalog.
  const json doc = mkComposition(json::array({
      mkTrack("t1", json::array({mkClip(
          "c1", 0, 8, json::array({mkDevice("trig", "mod.trigger.beat")}))})),
      mkSceneTrack("st", json::array({mkScene("s1", 8)})),
  }));
  cx.loadDocument(doc);
  cx.seekBeat(0.5);
  // The trigger-source clip is modulation-only + alone on its track — it still
  // enters the composite (devices present), so its instance would tick.
  CHECK((cx.update(0.0) & comp::kCompHasContent) != 0);
}

TEST_CASE("scenes: solo/bypass/group interplay", "[comp_scene]") {
  EvalHarness h;
  json st = mkSceneTrack("st", json::array({mkScene("s1", 8)}));

  SECTION("a soloed OTHER track drops the launched scene (solo lineage rule)") {
    h.cx.loadDocument(mkComposition(json::array({
        mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                          json::array({mkDevice("d1", "source.solid_color")}))}),
                {{"soloed", true}}),
        st,
    })));
    h.cx.seekBeat(0.5);
    h.cx.launchScene("st", "s1");
    h.cx.update(0.0);
    const std::string keys = json::parse(h.cx.chainKeysJson()).dump();
    CHECK(keys.find("clip_c1_") != std::string::npos);
    CHECK(keys.find("clip_s1_") == std::string::npos);  // launched but not soloed
  }

  SECTION("a soloed scene track keeps its launched scene exclusively") {
    st["soloed"] = true;
    h.cx.loadDocument(mkComposition(json::array({
        mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                          json::array({mkDevice("d1", "source.solid_color")}))})),
        st,
    })));
    h.cx.seekBeat(0.5);
    h.cx.launchScene("st", "s1");
    h.cx.update(0.0);
    const std::string keys = json::parse(h.cx.chainKeysJson()).dump();
    CHECK(keys.find("clip_s1_") != std::string::npos);
    CHECK(keys.find("clip_c1_") == std::string::npos);
  }

  SECTION("a bypassed scene track drops its launched scene (launch state persists)") {
    st["bypassed"] = true;
    h.cx.loadDocument(mkComposition(json::array({st})));
    h.cx.seekBeat(0.5);
    h.cx.launchScene("st", "s1");
    uint32_t flags = h.cx.update(0.0);
    CHECK((flags & comp::kCompHasContent) == 0);
    // The launch entry survives (un-bypassing brings the scene back).
    CHECK(json::parse(h.cx.sceneStatesJson()).contains("st"));
  }

  SECTION("a scene track inside a group composites through the group") {
    json grp = mkTrack("g1", json::array(), {{"kind", "group"}});
    st["parentId"] = "g1";
    h.cx.loadDocument(mkComposition(json::array({grp, st})));
    h.cx.seekBeat(0.5);
    h.cx.launchScene("st", "s1");
    CHECK((h.cx.update(0.0) & comp::kCompHasContent) != 0);
    CHECK(json::parse(h.cx.chainKeysJson()).dump().find("clip_s1_") != std::string::npos);
  }
}

TEST_CASE("scenes: a video-scene retrigger re-anchors the pump desc", "[comp_scene]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkSceneTrack("st", json::array({mkVideoClip("v1", 0, 8)})),
  })));
  h.cx.setTransportMode(false);
  h.cx.seekBeat(2.0);
  h.cx.launchScene("st", "v1");
  uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompVideoSetChanged) != 0);
  CHECK(json::parse(h.cx.videoDescsJson())[0]["startBeat"].get<double>() == 2.0);
  // A launched scene plays until stopped — its desc window must NOT end at the
  // grid cell's lengthBeat (the web pump treats the window end as "clip over":
  // frames froze one bar after launch + the Precise gate flickered stalls).
  CHECK(json::parse(h.cx.videoDescsJson())[0]["lengthBeat"].get<double>() > 1e6);

  // Retrigger at a later beat: same clip, new anchor → the pump must see a
  // changed desc (kCompVideoSetChanged) so it reconciles the source clock.
  h.cx.seekBeat(6.0);
  h.cx.update(0.0);
  h.cx.launchScene("st", "v1");
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompVideoSetChanged) != 0);
  CHECK(json::parse(h.cx.videoDescsJson())[0]["startBeat"].get<double>() == 6.0);
}

TEST_CASE("cheap op: comp_set_source_transform reaches the pump descs", "[comp_eval]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkVideoClip("v1", 0, 8)})),
  })));
  h.cx.setTransportMode(false);
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  CHECK(json::parse(h.cx.videoDescsJson())[0]["transform"]["scale"].get<double>() == 1.0);

  // The xform-drag fast path: a field-level patch, not a document reload.
  h.cx.setSourceTransform("v1", {{"scale", 0.5}, {"rotation", 0.25}});
  const uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompVideoSetChanged) != 0);
  const json d = json::parse(h.cx.videoDescsJson())[0];
  CHECK(d["transform"]["scale"].get<double>() == 0.5);
  CHECK(d["transform"]["rotation"].get<double>() == 0.25);
  CHECK(d["transform"]["anchorX"].get<double>() == 0.5);  // defaults resolved
}

// ── Transport pre-pass (CompExecutor::transportResolve) ─────────────────────

namespace {

/** A clip whose transport section hosts the streams probe (rate = 1 default). */
json mkTransportClip(const std::string& id, double startBeat, double lengthBeat) {
  json c = mkClip(id, startBeat, lengthBeat,
                  json::array({mkDevice(id + "_d", "source.solid_color",
                                        {{"color", {1.0, 1.0, 1.0}}})}));
  c["transport"] = {
      {"devices", json::array({mkDevice(id + "_tc", "testonly.streams_probe")})},
      {"wires", json::array()}};
  return c;
}

}  // namespace

TEST_CASE("transport pre-pass: rows/flags/required/eval-skip without GPU",
          "[comp_transport]") {
  EvalHarness h;
  h.cx.registerSchema("testonly.streams_probe", json::object());
  h.cx.registerCapabilities("testonly.streams_probe",
                            json::array({"transport_controller"}));
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkTransportClip("c1", 0, 8)})),
  })));

  uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompTransportSetChanged) != 0);
  const auto order = h.cx.transportOrder();
  REQUIRE(order.size() == 1);
  CHECK(order[0] == "c1");
  // The section instance rides the ensure/prune contract.
  CHECK(h.cx.requiredJson().find("clip_c1_transport_c1_tc") != std::string::npos);

  // Eval-skip guard: a transport section must not break the span (steady
  // playback inside one clip still evaluates once).
  h.cx.play();
  const int64_t evals = h.cx.evalCount();
  uint32_t later = 0;
  for (int i = 0; i < 60; i++) later |= h.cx.update(1.0 / 60.0);
  CHECK(h.cx.evalCount() == evals);
  CHECK((later & comp::kCompTransportSetChanged) == 0);

  // An undriven doc reload clears the rows and edges the flag once.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("c1", 0, 8,
          json::array({mkDevice("d1", "source.solid_color")}))})),
  })));
  flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompTransportSetChanged) != 0);
  CHECK(h.cx.transportOrder().empty());
}

TEST_CASE("transport pre-pass: an inert section (no controller) never drives",
          "[comp_transport]") {
  EvalHarness h;  // solid_color/video.file registered; NO transport capability
  json c = mkClip("c1", 0, 8, json::array({mkDevice("d1", "source.solid_color")}));
  c["transport"] = {{"devices", json::array({mkDevice("m1", "source.solid_color")})},
                    {"wires", json::array()}};
  h.cx.loadDocument(mkComposition(json::array({mkTrack("t1", json::array({c}))})));
  const uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompTransportSetChanged) == 0);
  CHECK(h.cx.transportOrder().empty());
  CHECK(h.cx.requiredJson().find("transport") == std::string::npos);
}

TEST_CASE("transport pre-pass: probe publishes same-frame resolved rows (Metal)",
          "[comp_transport][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");
  REQUIRE(hx.bundles.loadBundleFile(TESTONLY_WASM_PATH, *hx.registry,
                                    hx.backend.get(), nullptr) > 0);

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkTransportClip("c1", 0, 64)})),
  })));
  // The probe reads its parent stream through the streams.* imports — point
  // the loaded bundles at this executor's live registry + clock.
  hx.bundles.setStreamsTable(&cx.streamsTable(), &cx.warpClock());

  cx.play();
  cx.update(0.5);  // 120 BPM: +1 beat → transport at 0.5 s
  cx.transportResolve(0.5);
  {
    const auto& rows = cx.transportResolved();
    REQUIRE(rows.size() == 1);
    // Same-frame: the row reflects THIS frame's transport (rate 1 x 0.5 s) —
    // the executor created + ticked the instance inside this very resolve.
    CHECK(rows[0].valid);
    CHECK(rows[0].timeSec == Catch::Approx(0.5).margin(1e-9));
    CHECK(rows[0].active == 1.0);
    CHECK(rows[0].ended == 0.0);
  }

  cx.update(0.5);
  cx.transportResolve(0.5);
  CHECK(cx.transportResolved()[0].timeSec == Catch::Approx(1.0).margin(1e-9));

  // The applied override reroutes the streams content position... this clip
  // has no video source, so instead assert the cheap-op path: a rate edit on
  // the SECTION device lands without a doc reload and scales the next row.
  cx.setDeviceParam("c1", "c1_tc", "rate", 2.0);
  cx.update(0.5);
  cx.transportResolve(0.5);
  CHECK(cx.transportResolved()[0].timeSec == Catch::Approx(3.0).margin(1e-9));
}

TEST_CASE("videoDescFor: a driven clip ships transport:true and no loop",
          "[comp_transport]") {
  EvalHarness h;
  h.cx.registerSchema("testonly.streams_probe", json::object());
  h.cx.registerCapabilities("testonly.streams_probe",
                            json::array({"transport_controller"}));
  json driven = mkVideoClip("v1", 0, 8);
  driven["transport"] = {
      {"devices", json::array({mkDevice("tc", "testonly.streams_probe")})},
      {"wires", json::array()}};
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({driven})),
      mkTrack("t2", json::array({mkVideoClip("v2", 0, 8)})),
  })));
  h.cx.setTransportMode(false);
  h.cx.update(0.0);
  const json descs = json::parse(h.cx.videoDescsJson());
  REQUIRE(descs.size() == 2);
  const json& d1 = descs[0]["clipId"] == "v1" ? descs[0] : descs[1];
  const json& d2 = descs[0]["clipId"] == "v1" ? descs[1] : descs[0];
  CHECK(d1.value("transport", false) == true);
  CHECK(!d1.contains("loop"));
  CHECK(!d1.contains("speed"));
  // The undriven clip's desc is untouched (the legacy path byte-for-byte).
  CHECK(!d2.contains("transport"));
  CHECK(d2.contains("loop"));
  // Row order json matches the driven set.
  CHECK(json::parse(h.cx.transportOrderJson()) == json::array({"v1"}));
}

TEST_CASE("transport_ended stops a driven scene (Metal)",
          "[comp_transport][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");
  REQUIRE(hx.bundles.loadBundleFile(TESTONLY_WASM_PATH, *hx.registry,
                                    hx.backend.get(), nullptr) > 0);

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // A scene track whose only scene is transport-driven; the probe latches
  // transport_ended once its published time reaches 1 second.
  json scene = mkClip("s1", 0, 4,
                      json::array({mkDevice("g", "source.solid_color",
                                            {{"color", {1.0, 0.0, 0.0}}})}));
  scene["transport"] = {
      {"devices", json::array({mkDevice("tc", "testonly.streams_probe",
                                        {{"endAfterSec", 1.0}})})},
      {"wires", json::array()}};
  cx.loadDocument(mkComposition(json::array({
      mkTrack("st", json::array({std::move(scene)}), {{"kind", "scene"}}),
  })));
  hx.bundles.setStreamsTable(&cx.streamsTable(), &cx.warpClock());

  cx.play();
  cx.launchScene("st", "s1");
  cx.update(0.0);
  cx.transportResolve(0.0);
  CHECK(json::parse(cx.sceneStatesJson()).contains("st"));  // playing

  // Advance past 1 s of transport: the probe latches ended, the NEXT heal
  // (top of update) stops the launch — the 1-frame readback loop.
  uint32_t flags = 0;
  for (int i = 0; i < 5 && json::parse(cx.sceneStatesJson()).contains("st"); i++) {
    flags |= cx.update(0.6);
    cx.transportResolve(0.6);
  }
  CHECK(!json::parse(cx.sceneStatesJson()).contains("st"));
  CHECK((flags & comp::kCompScenesChanged) != 0);
}

TEST_CASE("core.transport.time matches clipSourceTimeAt (Metal)",
          "[comp_transport][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // A 10 s source (300f @ 30fps); slice [1,4] at 2x — the 'time' arm with a
  // non-trivial wrap. The effect's params are the ClipLoopConfig field names.
  json clip = mkVideoClip("v1", 0, 64);
  clip["transport"] = {
      {"devices", json::array({mkDevice("tc", "core.transport.time",
                                        {{"startSec", 1.0}, {"endSec", 4.0},
                                         {"speed", 2.0}})})},
      {"wires", json::array()}};
  cx.loadDocument(mkComposition(json::array({mkTrack("t1", json::array({clip}))})));
  hx.bundles.setStreamsTable(&cx.streamsTable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();

  comp::ClipLoopConfig loop;
  loop.mode = comp::ClipPlayMode::Time;
  loop.startSec = 1.0;
  loop.endSec = 4.0;
  loop.speed = 2.0;
  comp::ClipTimeCtx ctx;
  ctx.startBeat = 0;
  ctx.lengthBeat = 64;
  ctx.videoDurSec = 10.0;
  ctx.clock = &cx.warpClock();

  for (int i = 0; i < 8; i++) {
    cx.update(0.4);
    cx.transportResolve(0.4);
    const auto& rows = cx.transportResolved();
    REQUIRE(rows.size() == 1);
    REQUIRE(rows[0].valid);
    const auto expected = comp::clipSourceTimeAt(loop, ctx, cx.positionBeat());
    REQUIRE(expected.has_value());
    CHECK(rows[0].timeSec == Catch::Approx(*expected).margin(1e-6));
    CHECK(rows[0].loopStartSec == Catch::Approx(1.0).margin(1e-9));
    CHECK(rows[0].loopEndSec == Catch::Approx(4.0).margin(1e-9));
    // The applied content time reroutes streams pos(content) 1:1.
    const auto ch = cx.streamsTable().contentByClipId.find("v1");
    REQUIRE(ch != cx.streamsTable().contentByClipId.end());
    const comp::StreamInfo* cs = cx.streamsTable().find(ch->second);
    REQUIRE(cs != nullptr);
    CHECK(comp::contentPosSec(*cs, cx.streamsTable(), cx.warpClock()) ==
          Catch::Approx(rows[0].timeSec).margin(1e-9));
  }
}

TEST_CASE("core.transport.beat_sync consumes per-beat, BPM-locked (Metal)",
          "[comp_transport][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");
  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // Slice [0,8] over 4 beats: at beat 2 the mapping sits at 8*(2/4) = 4 s.
  json clip = mkVideoClip("v1", 0, 64);
  clip["source"]["durationFrames"] = 300;  // 10 s
  clip["transport"] = {
      {"devices", json::array({mkDevice("tc", "core.transport.beat_sync",
                                        {{"endSec", 8.0}, {"syncBeats", 4.0}})})},
      {"wires", json::array()}};
  cx.loadDocument(mkComposition(json::array({mkTrack("t1", json::array({clip}))})));
  hx.bundles.setStreamsTable(&cx.streamsTable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();
  cx.update(1.0);  // 120 BPM: +2 beats
  cx.transportResolve(1.0);
  const auto& rows = cx.transportResolved();
  REQUIRE(rows.size() == 1);
  REQUIRE(rows[0].valid);
  CHECK(rows[0].timeSec == Catch::Approx(4.0).margin(1e-6));
}
