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

TEST_CASE("pending launches: deferred commit, request anchor, class/mode policy",
          "[comp_pending]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkScene("s1", 8),
                         mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.setVideoReadyFeed();  // the web bridge's handshake
  h.cx.play();

  // Effect-only scenes never defer (nothing to decode). Empty track + video
  // scene DOES defer (uniform policy: the transport never holds for scenes).
  h.cx.launchScene("st", "s1", comp::CompExecutor::kLaunchLoose);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "s1");
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());

  // Video scene, loose: DEFERS — the outgoing keeps playing; the incoming
  // ships ACTIVE-SHAPED in the pump set so the host warms + injects it.
  const double reqBeat = h.cx.positionBeat();
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchLoose);
  h.run(3, 1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "s1");
  CHECK(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v1");
  {
    bool pumped = false;
    for (const auto& d : json::parse(h.cx.videoDescsJson())) {
      if (d["clipId"] == "v1") {
        pumped = true;
        CHECK(d["startBeat"].get<double>() == Catch::Approx(reqBeat).margin(1e-9));
        CHECK(d["lengthBeat"].get<double>() > 1e8);  // active-shaped, unbounded
      }
    }
    CHECK(pumped);
  }

  // Readiness commits — anchored at the REQUEST beat, not the commit beat.
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  {
    const json live = json::parse(h.cx.sceneStatesJson());
    CHECK(live["st"]["sceneId"] == "v1");
    CHECK(live["st"]["launchBeat"].get<double>() == Catch::Approx(reqBeat).margin(1e-9));
  }
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());

  // Live mode + INSTANT: commits immediately even when not ready (keep
  // pumping frames).
  h.cx.setTransportMode(false);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");

  // v1 left the pump set when v2 took over → its ready latch was PRUNED (a
  // stale latch would commit instantly against a DISPOSED decoder — exactly
  // the handover flash). Live + loose → lingers on v2 until ready again.
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchLoose);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");
  CHECK(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v1");
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");

  // Precise defers even INSTANT-class launches.
  h.cx.setTransportMode(true);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");
  CHECK(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v2");

  // Deadline: 2.5 s of WALL-CLOCK dt force-commits without readiness.
  h.run(80, 1.0 / 30.0);  // ~2.7 s
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());

  // Release the post-deadline precise hold (v2 active but unready): once v2
  // is ready and displayed commits, v1 leaves the pump union and its ready
  // latch prunes — so the next v1 launch defers. (While v1 was still
  // DISPLAYED under the hold, relaunching it instantly was CORRECT: its
  // decoder was warm.)
  h.cx.setVideoReady("v2", true);
  h.cx.update(1.0 / 60.0);
  h.cx.update(1.0 / 60.0);

  // stopScene clears a pending entry (and the live one).
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchLoose);
  h.cx.update(1.0 / 60.0);
  CHECK(!json::parse(h.cx.pendingScenesJson()).empty());
  h.cx.stopScene("st");
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());
  CHECK(json::parse(h.cx.sceneStatesJson()).empty());
}

TEST_CASE("pending launches: heal defers the outgoing; doc reloads preserve pending",
          "[comp_pending]") {
  EvalHarness h;
  json oneShot = mkVideoClip("v1", 0, 4);
  oneShot["loop"] = {{"mode", "one-shot"}, {"startSec", 0}, {"speed", 1},
                     {"direction", "forward"}};
  oneShot["source"]["durationFrames"] = 30;  // 1 s — elapses fast
  const json doc = mkComposition(json::array({mkSceneTrack(
      "st", json::array({oneShot, mkVideoClip("v2", 4, 4)}))}));
  h.cx.loadDocument(doc);
  h.cx.setVideoReadyFeed();
  h.cx.play();

  h.cx.setVideoReady("v1", true);
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchLoose);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");

  // Play past the one-shot's 1 s end WITH a pending successor: the heal must
  // NOT stop the outgoing mid-window (no transparent hole) — the commit
  // replaces it instead.
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchLoose);
  h.run(90, 1.0 / 60.0);  // 1.5 s: past the one-shot end, under the deadline
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");  // still alive
  CHECK(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v2");

  // A doc reload mid-window (every undoable edit round-trips) PRESERVES the
  // pending entry; a reload that removed the scene drops it.
  h.cx.loadDocument(doc);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v2");
  h.cx.setVideoReady("v2", true);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());
}

TEST_CASE("primed precache: candidates prime + pre-instantiate; readiness fast-path "
          "commits same-call",
          "[comp_pending]") {
  EvalHarness h;
  h.cx.registerSchema("core.transport.follow", json::object());
  h.cx.registerCapabilities("core.transport.follow",
                            json::array({"transport_section"}));
  // v1: 10 s looping video with a FOLLOWER (arms the candidate precache near
  // each pass boundary). v2: the launchable sibling the follow would pick.
  json v1 = mkVideoClip("v1", 0, 4);
  v1["transport"] = {{"devices", json::array({mkDevice("f", "core.transport.follow")})},
                     {"wires", json::array()}};
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({std::move(v1), mkVideoClip("v2", 4, 4)}))})));
  h.cx.setVideoReadyFeed();
  h.cx.setTransportMode(true);  // Precise
  h.cx.play();

  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");

  // Far from the pass boundary: NOT armed — v2 stays out of the pump set
  // (scene clips are excluded from the plain warm scan).
  h.run(60, 1.0 / 60.0);  // ~1 s in
  for (const auto& d : json::parse(h.cx.videoDescsJson())) CHECK(d["clipId"] != "v2");

  // Inside the last kScenePrewarmSec of v1's pass: v2 ships PRIMED (the pump
  // injects its entry frame + reports real entry readiness) and its
  // post-commit chain pre-instantiates through requiredJson.
  h.run(60 * 8, 1.0 / 60.0);  // ~9 s in, ~1 s remaining
  {
    bool sawV2 = false;
    for (const auto& d : json::parse(h.cx.videoDescsJson())) {
      if (d["clipId"] != "v2") continue;
      sawV2 = true;
      CHECK(d.value("prime", false));
    }
    CHECK(sawV2);
    CHECK(h.cx.requiredJson().find("v2_v") != std::string::npos);
  }

  // The primed readiness edge lands BEFORE the follow fires, and the latch
  // survives while the candidate stays pumped...
  h.cx.setVideoReady("v2", true);
  h.run(3, 1.0 / 60.0);

  // ...so the launch hits the readyClips_ fast path: committed SAME-CALL with
  // no pending window — a window here renders the outgoing clip wrapping
  // back to its start (the "plays 1-3 frames of the first clip" artifact),
  // even in Precise mode.
  const double reqBeat = h.cx.positionBeat();
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchLoose);
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());
  const json live = json::parse(h.cx.sceneStatesJson());
  CHECK(live["st"]["sceneId"] == "v2");
  CHECK(live["st"]["launchBeat"].get<double>() == Catch::Approx(reqBeat).margin(1e-9));
}

TEST_CASE("linger clamp: the outgoing scene's desc freezes at its pass end while a "
          "launch pends",
          "[comp_pending]") {
  EvalHarness h;
  // v1: a 10 s looping video (300f @ 30). v2: the cold incoming.
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.setVideoReadyFeed();
  h.cx.setTransportMode(true);  // Precise: ALL launches defer while cold
  h.cx.play();

  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");
  const double launchBeat =
      json::parse(h.cx.sceneStatesJson())["st"]["launchBeat"].get<double>();

  // ~2 s into v1's 10 s pass: a COLD manual launch of v2 defers, and v1's
  // desc must now carry the freeze beat — the end of the pass in progress
  // (launch + 10 s ⇒ +20 beats @120), pulled a sub-frame margin inside it.
  h.run(120, 1.0 / 60.0);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v2");
  {
    bool sawV1 = false, sawV2 = false;
    for (const auto& d : json::parse(h.cx.videoDescsJson())) {
      if (d["clipId"] == "v1") {
        sawV1 = true;
        REQUIRE(d.contains("holdBeat"));
        const double hold = d["holdBeat"].get<double>();
        CHECK(hold > h.cx.positionBeat());  // still ahead: play out the pass
        CHECK(hold < launchBeat + 20.0);    // strictly INSIDE the pass...
        CHECK(hold == Catch::Approx(launchBeat + 20.0).margin(0.05));  // ...just
      } else if (d["clipId"] == "v2") {
        sawV2 = true;
        CHECK(!d.contains("holdBeat"));  // only the OUTGOING is clamped
      }
    }
    CHECK(sawV1);
    CHECK(sawV2);
  }

  // The commit replaces v1 — the clamp leaves with it.
  h.cx.setVideoReady("v2", true);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");
  for (const auto& d : json::parse(h.cx.videoDescsJson())) {
    CHECK(!d.contains("holdBeat"));
  }
}

namespace {

/** True when clipId ships in videoDescsJson; primed reports the prime flag. */
bool descShips(comp::CompExecutor& cx, const std::string& clipId, bool* primed = nullptr) {
  for (const auto& d : json::parse(cx.videoDescsJson())) {
    if (d["clipId"] != clipId) continue;
    if (primed) *primed = d.value("prime", false);
    return true;
  }
  return false;
}

}  // namespace

TEST_CASE("streams.announce: exact-target precache — primed desc, pre-instantiation, "
          "expiry/retract, fast-commit",
          "[comp_announce]") {
  EvalHarness h;
  // v1..v3 video scenes + e1 effect-only, NO followers anywhere — the
  // proximity heuristic never arms, so everything warmed below is the
  // announce's doing.
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4),
                         mkVideoClip("v3", 8, 4),
                         mkClip("e1", 12, 4,
                                json::array({mkDevice("e1_d", "source.solid_color")}))}))})));
  h.cx.setVideoReadyFeed();
  h.cx.setTransportMode(true);  // Precise
  h.cx.play();

  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");

  auto& table = h.cx.streamsTableMutable();
  const int64_t handle = table.trackByTrackId.at("st");

  // (a) Announce v2 (ordinal 1): its desc ships PRIMED and its post-commit
  // chain pre-instantiates; v3 stays cold (no heuristic in play).
  table.pendingOps.push_back({2, handle, 1.0, 1, 1.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  {
    bool primed = false;
    CHECK(descShips(h.cx, "v2", &primed));
    CHECK(primed);
    CHECK(!descShips(h.cx, "v3"));
    CHECK(h.cx.requiredJson().find("v2_v") != std::string::npos);
  }

  // (d) Retract (t < 0) drops it immediately.
  table.pendingOps.push_back({2, handle, -1.0, 1, 0.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  CHECK(!descShips(h.cx, "v2"));

  // (g) An effect-only target pre-instantiates its chain but ships no desc
  // (descs are video-only; its instant commit still renders on frame 1).
  table.pendingOps.push_back({2, handle, 3.0, 1, 0.5});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  CHECK(h.cx.requiredJson().find("clip_e1_") != std::string::npos);
  CHECK(!descShips(h.cx, "e1"));
  table.pendingOps.push_back({2, handle, -1.0, 1, 0.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);

  // Outside the warm window (eta > kScenePrewarmSec): accepted but inert.
  table.pendingOps.push_back({2, handle, 1.0, 1, 10.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  CHECK(!descShips(h.cx, "v2"));

  // (c) Staleness: an in-window announce not re-asserted for > 0.5 s expires.
  table.pendingOps.push_back({2, handle, 1.0, 1, 1.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  CHECK(descShips(h.cx, "v2"));
  h.run(40, 1.0 / 60.0);  // ~0.67 s silent
  CHECK(!descShips(h.cx, "v2"));

  // (e) Announce → primed readiness latches → the launch fast-commits
  // SAME-CALL at the request anchor (no pending window), Precise mode.
  table.pendingOps.push_back({2, handle, 1.0, 1, 1.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  h.cx.setVideoReady("v2", true);
  h.run(2, 1.0 / 60.0);
  const double reqBeat = h.cx.positionBeat();
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  CHECK(json::parse(h.cx.pendingScenesJson()).empty());
  const json live = json::parse(h.cx.sceneStatesJson());
  CHECK(live["st"]["sceneId"] == "v2");
  CHECK(live["st"]["launchBeat"].get<double>() == Catch::Approx(reqBeat).margin(1e-9));
}

TEST_CASE("streams.announce: empty-track announce warms; validation drops bad targets",
          "[comp_announce]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.setVideoReadyFeed();
  h.cx.play();

  auto& table = h.cx.streamsTableMutable();
  const int64_t handle = table.trackByTrackId.at("st");

  // Nothing playing on the track: an announce still warms its target (the
  // heuristic path needs a live scene; a declared intro cue does not).
  table.pendingOps.push_back({2, handle, 0.0, 1, 1.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  {
    bool primed = false;
    CHECK(descShips(h.cx, "v1", &primed));
    CHECK(primed);
  }

  // A bad ordinal is dropped at the drain (same matcher as seek) — the prior
  // announce keeps its slot.
  table.pendingOps.push_back({2, handle, 99.0, 1, 1.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  CHECK(descShips(h.cx, "v1"));
  CHECK(!descShips(h.cx, "v2"));
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
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());

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
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());

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
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
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
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();
  cx.update(1.0);  // 120 BPM: +2 beats
  cx.transportResolve(1.0);
  const auto& rows = cx.transportResolved();
  REQUIRE(rows.size() == 1);
  REQUIRE(rows[0].valid);
  CHECK(rows[0].timeSec == Catch::Approx(4.0).margin(1e-6));
}

// ── Follow actions (transport_section: non-driving section members) ─────────

TEST_CASE("follower-only section: executes but never drives; heal defers",
          "[comp_follow]") {
  EvalHarness h;
  h.cx.registerSchema("core.transport.follow", json::object());
  h.cx.registerCapabilities("core.transport.follow",
                            json::array({"transport_section"}));
  // A ONE-SHOT video scene carrying only a follower: without the section the
  // heal would auto-stop it after its 2 s slice; with it, the follower owns
  // the end — the scene must outlive its standard duration (the follower
  // never fires here because transportResolve is never called: GPU-less).
  json scene = mkClip("s1", 0, 4,
                      json::array({mkDevice("v", "source.video.file")}),
                      {{"kind", "video"},
                       {"loop", {{"mode", "one-shot"}, {"startSec", 0}, {"speed", 1}}},
                       {"source", {{"label", "s1.mp4"}, {"durationFrames", 60},
                                   {"fps", 30}, {"url", "blob:media/s1"}}}});
  scene["transport"] = {
      {"devices", json::array({mkDevice("f", "core.transport.follow")})},
      {"wires", json::array()}};
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("st", json::array({std::move(scene)}), {{"kind", "scene"}}),
  })));
  h.cx.setTransportMode(false);

  h.cx.launchScene("st", "s1");
  uint32_t flags = h.cx.update(0.0);
  // The section EXECUTES: its instance is required (web ensure/prune) and the
  // set-changed flag fired for the sketch...
  CHECK((flags & comp::kCompStructureChanged) != 0);
  CHECK(h.cx.requiredJson().find("clip_s1_transport_f") != std::string::npos);
  // ...but nothing DRIVES: no times rows, and the video desc keeps its loop.
  CHECK(h.cx.transportOrder().empty());
  const json descs = json::parse(h.cx.videoDescsJson());
  REQUIRE(descs.size() == 1);
  CHECK(!descs[0].contains("transport"));
  CHECK(descs[0].contains("loop"));

  // Play 3 s of transport (past the 2 s one-shot slice): heal must NOT stop
  // the scene — the follower owns its end.
  h.cx.play();
  for (int i = 0; i < 30; i++) h.cx.update(0.1);
  CHECK(json::parse(h.cx.sceneStatesJson()).contains("st"));
}

TEST_CASE("drainStreamOps: queued seek launches a launchable scene; validation drops the rest",
          "[comp_follow]") {
  EvalHarness h;
  json red = mkClip("red", 0, 4, json::array({mkDevice("r", "source.solid_color")}));
  json green = mkClip("green", 4, 4, json::array({mkDevice("g", "source.solid_color")}));
  json ghost = mkClip("ghost", 8, 4, json::array());  // EMPTY: no event, unlaunchable
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("st", json::array({red, green, ghost}), {{"kind", "scene"}}),
  })));
  h.cx.update(0.0);

  auto& table = h.cx.streamsTableMutable();
  const auto th = table.trackByTrackId.find("st");
  REQUIRE(th != table.trackByTrackId.end());
  const int64_t handle = th->second;

  // Seek to ordinal 1 (green) — applied by the entry drain even though NO
  // transport section exists (F4: render-fired ops must not strand).
  table.pendingOps.push_back({0, handle, 1.0});
  h.cx.transportResolve(0.0);
  h.cx.update(0.0);
  json states = json::parse(h.cx.sceneStatesJson());
  REQUIRE(states.contains("st"));
  CHECK(states["st"]["sceneId"] == "green");

  // The empty scene (ordinal 2) has no start event → the seek is dropped.
  table.pendingOps.push_back({0, handle, 2.0});
  h.cx.transportResolve(0.0);
  h.cx.update(0.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "green");

  // Stop.
  table.pendingOps.push_back({1, handle, 0.0});
  h.cx.transportResolve(0.0);
  h.cx.update(0.0);
  CHECK(!json::parse(h.cx.sceneStatesJson()).contains("st"));
}

TEST_CASE("streams.next_launch: the table mirrors announces and pending commits",
          "[comp_announce]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.setVideoReadyFeed();
  h.cx.play();

  auto& table = h.cx.streamsTableMutable();
  const int64_t handle = table.trackByTrackId.at("st");
  const comp::StreamInfo* s = table.find(handle);
  REQUIRE(s != nullptr);
  CHECK(s->nlState == 0);  // idle: no upcoming launch

  // A queued announce lands in the mirror: state 1 + target ordinal + eta.
  table.pendingOps.push_back({2, handle, 1.0, 1, 3.0});
  h.cx.transportResolve(0.0);
  h.cx.update(0.0);
  CHECK(s->nlState == 1);
  CHECK(s->nlOrdinal == 1);
  CHECK(s->nlCls == 1);
  CHECK(s->nlEtaSec == Catch::Approx(3.0).margin(1e-9));

  // The declared eta decays as the announce ages without a re-assert...
  h.cx.update(0.2);
  CHECK(s->nlState == 1);
  CHECK(s->nlEtaSec == Catch::Approx(2.8).margin(1e-9));
  // ...and a silent announce expires entirely (kAnnounceStaleSec).
  h.cx.update(0.4);
  CHECK(s->nlState == 0);

  // A deferred handover mirrors as state 2 (pending commit) and WINS over a
  // fresh announce on the same track.
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchLoose);
  h.cx.update(1.0 / 60.0);
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");
  table.pendingOps.push_back({2, handle, 1.0, 1, 2.0});  // announce v2
  h.cx.transportResolve(0.0);
  h.cx.update(0.0);
  CHECK(s->nlState == 1);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchLoose);  // defers
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v2");
  CHECK(s->nlState == 2);
  CHECK(s->nlOrdinal == 1);
  CHECK(s->nlEtaSec == 0.0);

  // The commit clears both halves (fulfilled announce + drained pending).
  h.cx.setVideoReady("v2", true);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");
  CHECK(s->nlState == 0);
}

namespace {

/** The fork entry riding track `st`, or null. */
json forkOf(comp::CompExecutor& cx) {
  const json s = json::parse(cx.sceneStatesJson());
  if (!s.contains("st") || !s["st"].contains("fork")) return nullptr;
  return s["st"]["fork"];
}

}  // namespace

TEST_CASE("fork: arm + commit detaches the outgoing under its own identity",
          "[comp_fork]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4),
                         mkVideoClip("v3", 8, 4)}))})));
  h.cx.play();
  auto& table = h.cx.streamsTableMutable();
  const int64_t contentV1 = table.contentByClipId.at("v1");
  const int64_t contentV2 = table.contentByClipId.at("v2");

  // v1 live (no ready feed → immediate commits, the barrel-degrade path).
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  const double v1Anchor =
      json::parse(h.cx.sceneStatesJson())["st"]["launchBeat"].get<double>();

  // Arm alone is invisible; an unconsumed arm expires after kForkArmStaleSec.
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  CHECK(forkOf(h.cx).is_null());

  // Commit v2 while armed → the evicted v1 moves into the fork slot with its
  // anchors FROZEN (adopted identity — its content stream never re-anchors).
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");
  json f = forkOf(h.cx);
  REQUIRE(!f.is_null());
  CHECK(f["clipId"] == "v1");
  CHECK(f["anchorBeat"].get<double>() == Catch::Approx(v1Anchor).margin(1e-9));
  const comp::StreamInfo* cs = table.find(contentV1);
  REQUIRE(cs != nullptr);
  CHECK(cs->anchorBeat == Catch::Approx(v1Anchor).margin(1e-9));

  // Owner re-asserts keep the detached fork alive well past the stale window.
  for (int i = 0; i < 10; i++) {
    table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
    h.cx.transportResolve(0.0);
    h.cx.update(0.1);
  }
  CHECK(!forkOf(h.cx).is_null());

  // While the fork runs, a relaunch of the LIVE scene is dropped (the
  // announcer's redundant boundary fire must not re-anchor v2 mid-fade).
  const double v2Anchor =
      json::parse(h.cx.sceneStatesJson())["st"]["launchBeat"].get<double>();
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["launchBeat"].get<double>() ==
        Catch::Approx(v2Anchor).margin(1e-9));

  // Snap-finish: arming the NEW live scene and committing a third launch
  // releases the old fork and detaches v2 in its place.
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});  // keep v1 fork alive
  table.pendingOps.push_back({3, contentV2, 0.0, 1, 0});  // arm v2
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v3", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  f = forkOf(h.cx);
  REQUIRE(!f.is_null());
  CHECK(f["clipId"] == "v2");

  // Owner silence releases (no re-asserts for > kForkArmStaleSec).
  h.cx.update(0.3);
  h.cx.update(0.3);
  CHECK(forkOf(h.cx).is_null());
}

TEST_CASE("fork: A->A relaunch skips; stop verbs and TTL release", "[comp_fork]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.play();
  auto& table = h.cx.streamsTableMutable();
  const int64_t contentV1 = table.contentByClipId.at("v1");

  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);

  // A→A: an armed fork whose clip is retriggered SKIPS (identity collision —
  // plain retrigger semantics, no fork).
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  CHECK(forkOf(h.cx).is_null());
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");

  // Fork v1 under v2, then release via streams.stop on the FORK stream.
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  REQUIRE(!forkOf(h.cx).is_null());
  table.pendingOps.push_back({1, contentV1, 0.0});
  h.cx.transportResolve(0.0);
  CHECK(forkOf(h.cx).is_null());
  // The live scene is untouched by the fork release.
  CHECK(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v2");

  // TTL backstop: even a diligently re-asserted fork dies at kForkMaxSec.
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  REQUIRE(!forkOf(h.cx).is_null());
  for (int i = 0; i < 26; i++) {
    table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
    h.cx.transportResolve(0.0);
    h.cx.update(0.4);
  }
  CHECK(forkOf(h.cx).is_null());

  // stopScene clears the whole fork lifecycle on the track.
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  REQUIRE(!forkOf(h.cx).is_null());
  h.cx.stopScene("st");
  CHECK(forkOf(h.cx).is_null());
  CHECK(!json::parse(h.cx.sceneStatesJson()).contains("st"));
}

TEST_CASE("fork: a second leaf + the track xfade blend; desc byte-parity",
          "[comp_fork]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.play();
  auto& table = h.cx.streamsTableMutable();
  const int64_t contentV1 = table.contentByClipId.at("v1");

  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  // The live v1 desc — the fork's desc must be BYTE-IDENTICAL to it.
  json v1Desc;
  for (const auto& d : json::parse(h.cx.videoDescsJson())) {
    if (d["clipId"] == "v1") v1Desc = d;
  }
  REQUIRE(!v1Desc.is_null());

  // Arm + commit v2: the tree grows the fork leaf and the track xfade node.
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  REQUIRE(!forkOf(h.cx).is_null());
  const std::string keys = h.cx.chainKeysJson();
  CHECK(keys.find("clip_v1_v1_v") != std::string::npos);   // outgoing source
  CHECK(keys.find("clip_v2_v2_v") != std::string::npos);   // incoming source
  CHECK(keys.find("track_st_xfade") != std::string::npos); // the A/B crossfader
  // requiredJson keeps BOTH chains alive (instance continuity across detach).
  CHECK(h.cx.requiredJson().find("clip_v1_v1_v") != std::string::npos);
  // Pump set: both descs; the fork's is byte-identical to the live one (no
  // holdBeat, same anchors) so the pump/decoder survives untouched.
  json v1After, v2After;
  for (const auto& d : json::parse(h.cx.videoDescsJson())) {
    if (d["clipId"] == "v1") v1After = d;
    if (d["clipId"] == "v2") v2After = d;
  }
  REQUIRE(!v1After.is_null());
  REQUIRE(!v2After.is_null());
  CHECK(v1After == v1Desc);

  // Release (fade done): the fork leaf + xfade node leave the build.
  table.pendingOps.push_back({1, contentV1, 0.0});
  h.cx.transportResolve(0.0);
  h.cx.update(1.0 / 60.0);
  const std::string after = h.cx.chainKeysJson();
  CHECK(after.find("clip_v1_v1_v") == std::string::npos);
  CHECK(after.find("track_st_xfade") == std::string::npos);
  CHECK(after.find("clip_v2_v2_v") != std::string::npos);
}

TEST_CASE("track transport section: parsed, built, track-keyed, never drives",
          "[comp_fork]") {
  EvalHarness h;
  h.cx.registerSchema("core.transport.follow", json::object());
  h.cx.registerCapabilities("core.transport.follow", json::array({"transport_section"}));
  json track = mkSceneTrack("st", json::array({mkVideoClip("v1", 0, 4)}));
  track["transport"] = {
      {"devices", json::array({mkDevice("x1", "core.transport.follow")})},
      {"wires", json::array()}};
  h.cx.loadDocument(mkComposition(json::array({track})));
  h.cx.update(0.0);
  // The track section's device rides requiredJson under the track-scoped
  // transport key (streams.parent() resolves it to the track's own stream).
  CHECK(h.cx.requiredJson().find("track_st_transport_x1") != std::string::npos);
  // A track has no content clock: sections here never produce times rows.
  CHECK(h.cx.transportOrder().empty());
  // Launching the scene doesn't change that (the clip has no section).
  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchInstant);
  h.cx.update(1.0 / 60.0);
  CHECK(h.cx.transportOrder().empty());
  CHECK(h.cx.requiredJson().find("track_st_transport_x1") != std::string::npos);
}

TEST_CASE("fork: an armed track suppresses the linger clamp", "[comp_fork]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({mkSceneTrack(
      "st", json::array({mkVideoClip("v1", 0, 4), mkVideoClip("v2", 4, 4)}))})));
  h.cx.setVideoReadyFeed();
  h.cx.play();
  auto& table = h.cx.streamsTableMutable();
  const int64_t contentV1 = table.contentByClipId.at("v1");

  h.cx.launchScene("st", "v1", comp::CompExecutor::kLaunchLoose);
  h.cx.update(1.0 / 60.0);
  h.cx.setVideoReady("v1", true);
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.sceneStatesJson())["st"]["sceneId"] == "v1");

  // Armed fork → the deferred launch's outgoing desc ships NO holdBeat (the
  // fork plays through the window into the fade; a freeze would fight it).
  table.pendingOps.push_back({3, contentV1, 0.0, 1, 0});
  h.cx.transportResolve(0.0);
  h.cx.launchScene("st", "v2", comp::CompExecutor::kLaunchLoose);  // defers
  h.cx.update(1.0 / 60.0);
  REQUIRE(json::parse(h.cx.pendingScenesJson())["st"]["sceneId"] == "v2");
  for (const auto& d : json::parse(h.cx.videoDescsJson())) {
    if (d["clipId"] == "v1") CHECK(!d.contains("holdBeat"));
  }
}

namespace {

/** A solid-color scene at grid `startBeat` carrying core.transport.follow. */
json mkFollowScene(const std::string& id, double startBeat, json followState) {
  json c = mkClip(id, startBeat, 4,
                  json::array({mkDevice(id + "_g", "source.solid_color")}),
                  {{"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}}}});
  c["transport"] = {
      {"devices", json::array({mkDevice(id + "_f", "core.transport.follow",
                                        std::move(followState))})},
      {"wires", json::array()}};
  return c;
}

/** The playing scene id on track `st`, or "" when the track is silent. */
std::string playingScene(comp::CompExecutor& cx) {
  const json s = json::parse(cx.sceneStatesJson());
  return s.contains("st") ? s["st"].value("sceneId", std::string()) : std::string();
}

/** Step update+resolve until the playing scene changes (or frames run out). */
std::string stepUntilChange(comp::CompExecutor& cx, const std::string& from,
                            int maxFrames, double dt = 0.1) {
  for (int i = 0; i < maxFrames; i++) {
    cx.update(dt);
    cx.transportResolve(dt);
    const std::string now = playingScene(cx);
    if (now != from) return now;
  }
  return from;
}

}  // namespace

TEST_CASE("follow: Next wraps within the contiguous group; gaps excluded (Metal)",
          "[comp_follow][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // Grid: red(bar 0) + green(bar 1) contiguous; blue at bar 3 across a gap —
  // a separate group. Effect-only scenes, lengthBeat 4 @120 BPM ⇒ standard
  // duration 2 s. All three carry Follow(Next, Group).
  const json follow = {{"mode", 0 /*Next*/}, {"scope", 0 /*Group*/}};
  cx.loadDocument(mkComposition(json::array({
      mkTrack("st", json::array({mkFollowScene("red", 0, follow),
                                 mkFollowScene("green", 4, follow),
                                 mkFollowScene("blue", 12, follow)}),
              {{"kind", "scene"}}),
  })));
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();

  cx.launchScene("st", "red");
  cx.update(0.0);
  cx.transportResolve(0.0);
  REQUIRE(playingScene(cx) == "red");

  // red's 2 s elapse → green (Next within the group).
  CHECK(stepUntilChange(cx, "red", 40) == "green");
  // green is the group's END → Next wraps to red, never to blue (the gap).
  CHECK(stepUntilChange(cx, "green", 40) == "red");
  // ...and the cycle keeps going (the relaunch re-armed the follower).
  CHECK(stepUntilChange(cx, "red", 40) == "green");
}

TEST_CASE("follow: Group = TOUCHING cells — unaligned spans group, a gap splits (Metal)",
          "[comp_follow][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // red [0,3) + green [3,5): touching but NOT bar-aligned — the old integer
  // grid-slot rule (startBeat ÷ bar) put them at slots 0 and 0.75, never
  // contiguous, so Group self-looped on freeform docs. blue [8,12) sits
  // across a spatial gap: a separate group.
  const json follow = {{"mode", 0 /*Next*/}, {"scope", 0 /*Group*/}};
  json red = mkFollowScene("red", 0, follow);
  red["lengthBeat"] = 3;  // 1.5 s @120
  json green = mkFollowScene("green", 3, follow);
  green["lengthBeat"] = 2;  // 1 s
  cx.loadDocument(mkComposition(json::array({
      mkTrack("st",
              json::array({std::move(red), std::move(green), mkFollowScene("blue", 8, follow)}),
              {{"kind", "scene"}}),
  })));
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();

  cx.launchScene("st", "red");
  cx.update(0.0);
  cx.transportResolve(0.0);
  REQUIRE(playingScene(cx) == "red");

  // red elapses → green (same touching group despite the odd alignment)...
  CHECK(stepUntilChange(cx, "red", 40) == "green");
  // ...green is the group's end → wraps to red, never to blue across the gap.
  CHECK(stepUntilChange(cx, "green", 40) == "red");
  CHECK(stepUntilChange(cx, "red", 40) == "green");
}

TEST_CASE("follow announces its target: a Last jump OUTSIDE the proximity set primes and "
          "fast-commits (Metal)",
          "[comp_follow][comp_announce][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // Six video scenes; only v1 carries a follower — mode LAST, so the fire
  // target is v6 (ordinal 5), OUTSIDE the 4-nearest proximity heuristic
  // (which, from ordinal 0, would only ever warm v2..v5). The announce is
  // the only way v6 gets primed. Beats=4 (2 s @120) fires well inside v1's
  // 10 s content pass, so the heuristic window never even arms.
  json v1 = mkVideoClip("v1", 0, 4);
  v1["transport"] = {
      {"devices",
       json::array({mkDevice("v1_f", "core.transport.follow",
                             {{"mode", 3 /*Last*/}, {"scope", 1 /*Track*/},
                              {"followAfter", 1 /*Beats*/}, {"followBeats", 4}})})},
      {"wires", json::array()}};
  cx.loadDocument(mkComposition(json::array({
      mkTrack("st",
              json::array({std::move(v1), mkVideoClip("v2", 4, 4), mkVideoClip("v3", 8, 4),
                           mkVideoClip("v4", 12, 4), mkVideoClip("v5", 16, 4),
                           mkVideoClip("v6", 20, 4)}),
              {{"kind", "scene"}}),
  })));
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setVideoReadyFeed();
  cx.setTransportMode(true);  // Precise
  cx.play();

  cx.launchScene("st", "v1");
  cx.update(1.0 / 60.0);
  cx.transportResolve(1.0 / 60.0);
  cx.setVideoReady("v1", true);
  cx.update(1.0 / 60.0);
  cx.transportResolve(1.0 / 60.0);
  REQUIRE(playingScene(cx) == "v1");

  // A few frames in: the follower announced v6 (remaining 2 s ≤ the 4 s
  // horizon from the first tick) → primed desc + pre-instantiated chain.
  for (int i = 0; i < 5; i++) {
    cx.update(1.0 / 60.0);
    cx.transportResolve(1.0 / 60.0);
  }
  {
    bool sawV6 = false, v6Primed = false;
    for (const auto& d : json::parse(cx.videoDescsJson())) {
      if (d["clipId"] == "v6") {
        sawV6 = true;
        v6Primed = d.value("prime", false);
      }
      CHECK(d["clipId"] != "v2");  // proximity did NOT arm — announce-only
    }
    CHECK(sawV6);
    CHECK(v6Primed);
    CHECK(cx.requiredJson().find("v6_v") != std::string::npos);
  }

  // Primed readiness latches pre-fire → the follow's seek fast-commits:
  // NO pending window opens across the whole handover.
  cx.setVideoReady("v6", true);
  bool sawPending = false;
  for (int i = 0; i < 80 && playingScene(cx) == "v1"; i++) {
    cx.update(0.05);
    cx.transportResolve(0.05);
    if (!json::parse(cx.pendingScenesJson()).empty()) sawPending = true;
  }
  CHECK(playingScene(cx) == "v6");
  CHECK(!sawPending);
}

TEST_CASE("transition.xfade: announced launch triggers early, forks the outgoing, "
          "fades, releases (Metal)",
          "[comp_fork][comp_xfade][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // red + green solid scenes with Follow(Next, Track): red's standard duration
  // is 2 s @120. The TRACK carries transition.xfade (fadeSec 0.5): the follow
  // announces its target, the crossfade triggers green EARLY at eta ≤ 0.5 s,
  // red detaches into the fork, and the fade completes at red's true end.
  const json follow = {{"mode", 0 /*Next*/}, {"scope", 1 /*Track*/}};
  json track = mkTrack("st", json::array({mkFollowScene("red", 0, follow),
                                          mkFollowScene("green", 4, follow)}),
                       {{"kind", "scene"}});
  track["transport"] = {
      {"devices", json::array({mkDevice("x1", "transition.xfade", {{"fadeSec", 0.5}})})},
      {"wires", json::array()}};
  cx.loadDocument(mkComposition(json::array({std::move(track)})));
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setTransportMode(false);  // Live; no ready feed → commits are immediate
  cx.play();

  cx.launchScene("st", "red");
  cx.update(0.0);
  cx.transportResolve(0.0);
  REQUIRE(playingScene(cx) == "red");

  // Step until the flip. The crossfade must trigger EARLY: green commits
  // around red's 1.5 s mark (2 s boundary − 0.5 s fade), well before 2 s.
  int flipFrame = -1;
  for (int i = 0; i < 40; i++) {
    cx.update(0.05);
    cx.transportResolve(0.05);
    if (playingScene(cx) == "green") { flipFrame = i; break; }
  }
  REQUIRE(flipFrame >= 0);
  CHECK(flipFrame >= 20);  // not instantly (fade window is only the last 0.5 s)
  CHECK(flipFrame <= 36);  // meaningfully before the 2 s boundary (frame ~40)

  // The detach: red rides the fork slot; the composite holds BOTH chains and
  // the track xfade blend; red's chain stays in requiredJson (continuity).
  {
    const json f = json::parse(cx.sceneStatesJson())["st"].value("fork", json());
    REQUIRE(!f.is_null());
    CHECK(f["clipId"] == "red");
  }
  // One more frame: the commit invalidated the eval; the rebuild (two-leaf
  // tree + xfade node) lands at the next update.
  cx.update(0.05);
  cx.transportResolve(0.05);
  const std::string keys = cx.chainKeysJson();
  CHECK(keys.find("track_st_xfade") != std::string::npos);
  CHECK(keys.find("clip_red_red_g") != std::string::npos);
  CHECK(keys.find("clip_green_green_g") != std::string::npos);
  CHECK(cx.requiredJson().find("clip_red_red_g") != std::string::npos);

  // Mid-fade the fork survives on the effect's re-asserts (well past the
  // 0.5 s arm-staleness window counted from the detach)...
  for (int i = 0; i < 6; i++) {
    cx.update(0.05);
    cx.transportResolve(0.05);
  }
  CHECK(!json::parse(cx.sceneStatesJson())["st"].value("fork", json()).is_null());

  // ...and once the fade completes, the effect releases it: the fork leaf and
  // the xfade node leave the build, green plays on alone.
  for (int i = 0; i < 20; i++) {
    cx.update(0.05);
    cx.transportResolve(0.05);
  }
  CHECK(json::parse(cx.sceneStatesJson())["st"].value("fork", json()).is_null());
  const std::string after = cx.chainKeysJson();
  CHECK(after.find("track_st_xfade") == std::string::npos);
  CHECK(after.find("clip_red_red_g") == std::string::npos);
  CHECK(playingScene(cx) == "green");

  // The cycle repeats: green's follow announces red; the next transition
  // crossfades too (fork slot = green this time).
  bool sawGreenFork = false;
  for (int i = 0; i < 60 && playingScene(cx) == "green"; i++) {
    cx.update(0.05);
    cx.transportResolve(0.05);
  }
  CHECK(playingScene(cx) == "red");
  for (int i = 0; i < 4; i++) {
    const json f = json::parse(cx.sceneStatesJson())["st"].value("fork", json());
    if (!f.is_null() && f["clipId"] == "green") sawGreenFork = true;
    cx.update(0.05);
    cx.transportResolve(0.05);
  }
  CHECK(sawGreenFork);
}

TEST_CASE("follow: Track scope crosses gaps; Stop ends the track (Metal)",
          "[comp_follow][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // green(bar 1) follows with Track scope → its Next is blue ACROSS the gap;
  // blue follows with Stop → the track goes silent after blue's duration.
  cx.loadDocument(mkComposition(json::array({
      mkTrack("st",
              json::array({mkFollowScene("red", 0, {{"mode", 0}, {"scope", 1}}),
                           mkFollowScene("green", 4, {{"mode", 0}, {"scope", 1 /*Track*/}}),
                           mkFollowScene("blue", 12, {{"mode", 7 /*Stop*/}})}),
              {{"kind", "scene"}}),
  })));
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();

  cx.launchScene("st", "green");
  cx.update(0.0);
  cx.transportResolve(0.0);
  REQUIRE(playingScene(cx) == "green");

  CHECK(stepUntilChange(cx, "green", 40) == "blue");
  // blue's Stop: the launch map empties (heal deferred to the follower all
  // along — the one-shot config math never stopped anyone here).
  CHECK(stepUntilChange(cx, "blue", 40) == "");
}

TEST_CASE("follow: an EMPTY gap scene is launchable and its section executes (Metal)",
          "[comp_follow][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
  hx.seed(cx);
  // red(bar 0) → gap(bar 1): a scene with NO content devices, ONLY a Follow in
  // its transport section — a timed blank. It must be launchable (start event)
  // and its section must execute despite producing no composite-tree leaf,
  // then hand the track on to blue(bar 2) after its own standard duration.
  const json follow = {{"mode", 0 /*Next*/}, {"scope", 1 /*Track*/}};
  json gap = mkClip("gap", 4, 4, json::array());
  gap["transport"] = {
      {"devices", json::array({mkDevice("gap_f", "core.transport.follow", follow)})},
      {"wires", json::array()}};
  cx.loadDocument(mkComposition(json::array({
      mkTrack("st",
              json::array({mkFollowScene("red", 0, follow), std::move(gap),
                           mkFollowScene("blue", 8, follow)}),
              {{"kind", "scene"}}),
  })));
  hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
  cx.setTransportMode(false);
  cx.play();

  cx.launchScene("st", "red");
  cx.update(0.0);
  cx.transportResolve(0.0);
  REQUIRE(playingScene(cx) == "red");

  // red's 2 s elapse → Next lands ON the gap (it has a start event now)...
  CHECK(stepUntilChange(cx, "red", 40) == "gap");
  // ...which renders NOTHING (no leaf ⇒ no content) but its section runs.
  CHECK((cx.update(0.0) & comp::kCompHasContent) == 0);
  CHECK(cx.requiredJson().find("clip_gap_transport_gap_f") != std::string::npos);
  // The gap's own standard duration (lengthBeat 4 @120 ⇒ 2 s) elapses → blue.
  CHECK(stepUntilChange(cx, "gap", 40) == "blue");
}

TEST_CASE("transition.xfade: SHORT scenes fade on every hop — no settle blackout, "
          "no same-tick arm/seek race (Metal)",
          "[comp_fork][comp_xfade][comp_render]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  // Regression (user repro): fadeSec 0.3, scene A fires at ~1.83 s, scene B
  // fires at `bFireSec`. Two past failure modes:
  //  - B <= ~0.8 s: B's boundary landed inside the effect's old post-fade
  //    settle blackout (fade 0.3 + 0.5 s), during which it neither armed nor
  //    triggered -> the flip found no fork (cut). Fixed by arming the live
  //    scene's fork EVERY tick, mid-fade included.
  //  - B <= 1.10 s (= fade + settle + trigger window) on the WEB: the first
  //    re-arm after the settle and the early-trigger seek landed on the same
  //    tick, and the raw-forwarded arm (comp_queue_stream_op -> pendingOps)
  //    was only drained at transportResolve — AFTER applyPendingLaunches had
  //    committed the seek. Fixed by draining stream ops at the top of
  //    update(); the continuous arm covers it too.
  auto run = [&](double bFireSec) -> std::string {
    comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
    hx.seed(cx);
    const json followA = {{"mode", 0}, {"scope", 1},
                          {"followAfter", 2}, {"followSec", 1.8333}};
    const json followB = {{"mode", 0}, {"scope", 1},
                          {"followAfter", 2}, {"followSec", bFireSec}};
    json track = mkTrack("st", json::array({mkFollowScene("red", 0, followA),
                                            mkFollowScene("green", 4, followB)}),
                         {{"kind", "scene"}});
    track["transport"] = {
        {"devices", json::array({mkDevice("x1", "transition.xfade", {{"fadeSec", 0.3}})})},
        {"wires", json::array()}};
    cx.loadDocument(mkComposition(json::array({std::move(track)})));
    hx.bundles.setStreamsTable(&cx.streamsTableMutable(), &cx.warpClock());
    cx.setTransportMode(false);
    cx.play();
    cx.launchScene("st", "red");
    cx.update(0.0);
    cx.transportResolve(0.0);
    const double dt = 1.0 / 60.0;
    // Phase 1: red -> green (should always fade).
    bool fork1 = false;
    for (int i = 0; i < 400 && playingScene(cx) == "red"; i++) {
      cx.update(dt); cx.transportResolve(dt);
    }
    if (playingScene(cx) != "green") return "no-first-flip";
    for (int i = 0; i < 6; i++) {
      if (!json::parse(cx.sceneStatesJson())["st"].value("fork", json()).is_null())
        fork1 = true;
      cx.update(dt); cx.transportResolve(dt);
    }
    // Phase 2: green -> red. Watch for the fork across the flip.
    bool fork2 = false;
    for (int i = 0; i < 400 && playingScene(cx) == "green"; i++) {
      cx.update(dt); cx.transportResolve(dt);
      const json f = json::parse(cx.sceneStatesJson())["st"].value("fork", json());
      if (!f.is_null() && f["clipId"] == "green") fork2 = true;
    }
    if (playingScene(cx) != "red") return "no-second-flip";
    for (int i = 0; i < 8; i++) {
      const json f = json::parse(cx.sceneStatesJson())["st"].value("fork", json());
      if (!f.is_null() && f["clipId"] == "green") fork2 = true;
      cx.update(dt); cx.transportResolve(dt);
    }
    std::string r = fork1 ? "fade1" : "CUT1";
    r += fork2 ? "+fade2" : "+CUT2";
    return r;
  };

  for (double b : {0.45, 0.6, 1.0, 1.10, 1.11}) {
    INFO("B fire " << b << " s");
    CHECK(run(b) == "fade1+fade2");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCE CLIPS (M2): a clip that owns an interior mini-timeline. Its sub-clips
// composite among themselves over a PASS-THROUGH seed, the sequence clip's own
// chain runs over that, and the result blends up — a short-lived track/layer.
// ─────────────────────────────────────────────────────────────────────────────

namespace {

/** A sequence clip wrapping `subClips` (their startBeat is LANE-LOCAL). */
json mkSequenceClip(const std::string& id, double startBeat, double lengthBeat,
                    const std::string& laneId, json subClips, json ownDevices = json::array(),
                    json laneOver = json::object()) {
  json lane = {{"id", laneId}, {"name", "Sequence"}, {"kind", "track"},
               {"parentId", nullptr}, {"sketch", {{"devices", json::array()}}},
               {"automation", json::array()}, {"clips", std::move(subClips)}};
  lane.update(laneOver);
  return mkClip(id, startBeat, lengthBeat, std::move(ownDevices),
                {{"kind", "sequence"}, {"sequence", std::move(lane)}});
}

}  // namespace

TEST_CASE("sequence: the interior sub-clip renders under the sequence clip's own chain",
          "[comp_sequence]") {
  EvalHarness h;
  h.cx.registerSchema("color.saturate", json::object());
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 8, "lane1",
                        json::array({mkClip("sub1", 0, 4,
                                            json::array({mkDevice("g1", "source.solid_color")})),
                                     mkClip("sub2", 4, 4,
                                            json::array({mkDevice("g2", "source.solid_color")}))}),
                        json::array({mkDevice("fx", "color.saturate")}))})),
  })));

  // At beat 1 the interior is on sub1; the sequence's own FX runs over it.
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  const std::string keys = h.cx.chainKeysJson();
  INFO(keys);
  CHECK(keys.find("clip_sub1_g1") != std::string::npos);   // interior leaf
  CHECK(keys.find("clip_seq_fx") != std::string::npos);    // the sequence's OWN chain
  CHECK(keys.find("clip_sub2_g2") == std::string::npos);   // not yet active

  // At beat 5 the interior has moved on to sub2 — same outer clip, new interior.
  h.cx.seekBeat(5.0);
  h.cx.update(0.0);
  const std::string keys2 = h.cx.chainKeysJson();
  INFO(keys2);
  CHECK(keys2.find("clip_sub2_g2") != std::string::npos);
  CHECK(keys2.find("clip_sub1_g1") == std::string::npos);
  CHECK(keys2.find("clip_seq_fx") != std::string::npos);
}

TEST_CASE("sequence: the interior lane has its own FX bus, keyed per lane",
          "[comp_sequence]") {
  EvalHarness h;
  h.cx.registerSchema("color.saturate", json::object());
  json lane = json::object();
  lane["sketch"] = {{"devices", json::array({mkDevice("lfx", "color.saturate")})}};
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 8, "lane1",
                        json::array({mkClip("sub1", 0, 8,
                                            json::array({mkDevice("g1", "source.solid_color")}))}),
                        json::array(), lane)})),
  })));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  // The lane is a real Track, so its chain keys as a track FX bus.
  CHECK(h.cx.chainKeysJson().find("track_lane1_lfx") != std::string::npos);
}

TEST_CASE("sequence: an EFFECT-ONLY interior sub-clip processes the underlying composite",
          "[comp_sequence]") {
  EvalHarness h;
  h.cx.registerSchema("color.saturate", json::object());
  // Track 1 (above) draws a solid; track 2 holds a sequence whose only interior
  // clip is effect-only. With a pass-through ('underlying') seed it has the
  // track-1 composite to process; with a transparent seed it would render nothing.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("bg", 0, 8,
                                        json::array({mkDevice("g1", "source.solid_color")}))})),
      mkTrack("t2", json::array({mkSequenceClip(
                        "seq", 0, 8, "lane1",
                        json::array({mkClip("sub1", 0, 8,
                                            json::array({mkDevice("e1", "color.saturate")}))}))})),
  })));
  h.cx.seekBeat(1.0);
  CHECK((h.cx.update(0.0) & comp::kCompHasContent) != 0);
  const std::string keys = h.cx.chainKeysJson();
  INFO(keys);
  CHECK((keys.find("clip_g1") != std::string::npos ||
         keys.find("clip_bg_g1") != std::string::npos));
  CHECK(keys.find("clip_sub1_e1") != std::string::npos);
}

TEST_CASE("sequence: an empty interior with no own chain contributes nothing",
          "[comp_sequence]") {
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip("seq", 0, 8, "lane1", json::array())})),
  })));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  CHECK(h.cx.chainKeysJson().find("clip_seq") == std::string::npos);
}

TEST_CASE("sequence: an empty interior still renders the clip's OWN chain",
          "[comp_sequence]") {
  EvalHarness h;
  h.cx.registerSchema("color.saturate", json::object());
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("bg", 0, 8,
                                        json::array({mkDevice("g1", "source.solid_color")}))})),
      mkTrack("t2", json::array({mkSequenceClip(
                        "seq", 0, 8, "lane1", json::array(),
                        json::array({mkDevice("fx", "color.saturate")}))})),
  })));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  // A consolidated-but-emptied sequence degrades to a pass-through adjustment
  // layer carrying its own FX — never to "silently gone".
  CHECK(h.cx.chainKeysJson().find("clip_seq_fx") != std::string::npos);
}

TEST_CASE("sequence: the interior loops when the clip outruns its interior extent",
          "[comp_sequence]") {
  EvalHarness h;
  // Interior extent 4 beats (= 2 s at 120 BPM); the clip spans 16 beats, so the
  // interior plays four passes under the default 'time' play mode.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 16, "lane1",
                        json::array({mkClip("subA", 0, 2,
                                            json::array({mkDevice("ga", "source.solid_color")})),
                                     mkClip("subB", 2, 2,
                                            json::array({mkDevice("gb", "source.solid_color")}))}))})),
  })));
  // Beat 1 → interior beat 1 → subA. Beat 3 → interior beat 3 → subB.
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  CHECK(h.cx.chainKeysJson().find("clip_subA_ga") != std::string::npos);
  h.cx.seekBeat(3.0);
  h.cx.update(0.0);
  CHECK(h.cx.chainKeysJson().find("clip_subB_gb") != std::string::npos);
  // Beat 5 is one full pass later → back on subA (the interior WRAPPED).
  h.cx.seekBeat(5.0);
  h.cx.update(0.0);
  CHECK(h.cx.chainKeysJson().find("clip_subA_ga") != std::string::npos);
  CHECK(h.cx.chainKeysJson().find("clip_subB_gb") == std::string::npos);
}

TEST_CASE("sequence: layerTargets records the OUTER track, not the interior lane",
          "[comp_sequence]") {
  EvalHarness h;
  h.cx.registerSchema("color.saturate", json::object());
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("bg", 0, 8,
                                        json::array({mkDevice("g1", "source.solid_color")}))})),
      mkTrack("t2", json::array({mkSequenceClip(
                        "seq", 0, 8, "lane1",
                        json::array({mkClip("sub1", 0, 8,
                                            json::array({mkDevice("g2", "source.solid_color")}))}),
                        json::array({mkDevice("fx", "color.saturate")}))}),
               {{"level", 0.5}}),
  })));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);
  const json lt = json::parse(h.cx.layerTargetsJson());
  INFO(lt.dump());
  // The sequence clip's layer owner is its ARRANGEMENT track (t2). The interior
  // sub-leaf's owner is the LANE (lane1) — distinct ids, no collision.
  CHECK(lt.contains("t2"));
  CHECK(lt["t2"]["instanceKey"].get<std::string>().find("clip_seq") != std::string::npos);
}

TEST_CASE("sequence: interior video follows the synthetic times row (nested mapping)",
          "[comp_sequence]") {
  // The four-level mapping proved end to end:
  //   arrangement beat -> the sequence's content sec -> interior beat
  //                    -> the sub-clip's own source sec
  // At 120 BPM one beat = 0.5 s, and every link here is identity-shaped, so
  // the expected source second is hand-computable.
  EvalHarness h;
  json sub = mkVideoClip("v1", 0, 8);   // lane-local: interior beats 0..8
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip("seq", 4, 8, "lane1",
                                                json::array({std::move(sub)}))})),
  })));

  auto rowFor = [&](const std::string& clipId) -> comp::CompExecutor::TransportResolved {
    const json order = json::parse(h.cx.transportOrderJson());
    for (size_t i = 0; i < order.size(); ++i) {
      if (order[i].get<std::string>() == clipId) return h.cx.transportResolved()[i];
    }
    return {};
  };

  // Beat 6 = 2 beats into a sequence clip that starts at beat 4 ⇒ 1.0 s of
  // content ⇒ interior beat 2 ⇒ 1.0 s into the sub-clip's own source.
  h.cx.seekBeat(6.0);
  h.cx.update(0.0);
  h.cx.transportResolve(0.0);
  const auto r = rowFor("v1");
  INFO(h.cx.transportOrderJson());
  CHECK(r.valid);
  CHECK(r.active >= 0.5);
  CHECK(r.timeSec == Catch::Approx(1.0).margin(1e-6));

  // The desc reaches the pump, transport-shaped and unbounded (never rebased
  // per loop pass — that would churn the desc every wrap and reset the pump).
  const json descs = json::parse(h.cx.videoDescsJson());
  INFO(descs.dump());
  bool found = false;
  for (const auto& d : descs) {
    if (d.value("clipId", std::string()) != "v1") continue;
    found = true;
    CHECK(d.value("transport", false) == true);
    CHECK(d.contains("loop") == false);
    CHECK(d.value("startBeat", -1.0) == 4.0);       // the SEQUENCE clip's start
    CHECK(d.value("lengthBeat", 0.0) > 1e8);        // unbounded
  }
  CHECK(found);
}

TEST_CASE("sequence: the interior clock keeps mapping across a loop wrap",
          "[comp_sequence]") {
  EvalHarness h;
  // Interior extent 4 beats (2 s); the clip spans 16 beats ⇒ four passes.
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip("seq", 0, 16, "lane1",
                                                json::array({mkVideoClip("v1", 0, 4)}))})),
  })));
  auto timeAt = [&](double beat) {
    h.cx.seekBeat(beat);
    h.cx.update(0.0);
    h.cx.transportResolve(0.0);
    const json order = json::parse(h.cx.transportOrderJson());
    for (size_t i = 0; i < order.size(); ++i) {
      if (order[i].get<std::string>() == "v1") return h.cx.transportResolved()[i].timeSec;
    }
    return -1.0;
  };
  // Beat 1 → 0.5 s in. Beat 5 is ONE FULL PASS later → the same 0.5 s.
  CHECK(timeAt(1.0) == Catch::Approx(0.5).margin(1e-6));
  CHECK(timeAt(5.0) == Catch::Approx(0.5).margin(1e-6));
  CHECK(timeAt(3.0) == Catch::Approx(1.5).margin(1e-6));
}

TEST_CASE("sequence: the transport ROW SET changes when an interior row appears",
          "[comp_sequence]") {
  // Synthetic rows contribute no chain entries, so the section-sketch signature
  // can't see them appear — without a separate row signature the host's
  // row-order mirror goes stale and interior video freezes on the old row.
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip("seq", 0, 8, "lane1",
                                                json::array({mkVideoClip("v1", 0, 8)}))})),
  })));
  h.cx.seekBeat(1.0);
  const uint32_t flags = h.cx.update(0.0);
  CHECK((flags & comp::kCompTransportSetChanged) != 0);
  CHECK(json::parse(h.cx.transportOrderJson()).size() == 1);
}

TEST_CASE("sequence: the interior is a kind-6 content stream", "[comp_sequence]") {
  // kStreamKindSequenceContent was RESERVED by M1 and left unhandled in
  // streamPos/PosSec/Loop (they answered NaN through the default arm) — this
  // pins both the minting and those three now-closed holes.
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 16, "lane1",
                        json::array({mkClip("sub1", 0, 4,
                                            json::array({mkDevice("g1", "source.solid_color")}))}))})),
  })));
  h.cx.seekBeat(1.0);
  h.cx.update(0.0);

  const json tbl = json::parse(h.cx.streamsJson());
  INFO(tbl.dump(2));
  const json& streams = tbl.at("streams");
  bool found = false;
  for (const auto& s : streams) {
    if (s.value("ownerId", std::string()) != "seq") continue;
    found = true;
    CHECK(s.value("kind", 0) == 6);                       // SequenceContent
    // "Media duration" = the INTERIOR extent: 4 beats at 120 BPM = 2 s.
    CHECK(s.value("videoDurSec", 0.0) == Catch::Approx(2.0).margin(1e-9));
  }
  CHECK(found);
}

// ── Prefetch / announce parity: a sequence clip must prewarm and take launch
// hints exactly as if its sub-clips were sitting on a plain track. ───────────

namespace {

/** Video clip ids present in the pump/warm desc set. */
std::set<std::string> warmedIds(comp::CompExecutor& cx) {
  std::set<std::string> out;
  for (const auto& d : json::parse(cx.videoDescsJson())) {
    out.insert(d.value("clipId", std::string()));
  }
  return out;
}

}  // namespace

TEST_CASE("sequence prefetch parity: track mode warms the same upcoming clips",
          "[comp_sequence]") {
  // Same four media clips, twice: loose on a track, and grouped into a
  // sequence clip spanning the same beats. The warm set must match at every
  // playhead — the lookahead is just expressed on the interior axis.
  auto looseDoc = [] {
    return mkComposition(json::array({
        mkTrack("t1", json::array({mkVideoClip("v0", 0, 8), mkVideoClip("v1", 8, 8),
                                   mkVideoClip("v2", 16, 8), mkVideoClip("v3", 24, 8)})),
    }));
  };
  auto seqDoc = [] {
    return mkComposition(json::array({
        mkTrack("t1", json::array({mkSequenceClip(
                          "seq", 0, 32, "lane1",
                          json::array({mkVideoClip("v0", 0, 8), mkVideoClip("v1", 8, 8),
                                       mkVideoClip("v2", 16, 8), mkVideoClip("v3", 24, 8)}))})),
    }));
  };

  EvalHarness a, b;
  a.cx.loadDocument(looseDoc());
  b.cx.loadDocument(seqDoc());

  // kLookaheadBeats is 8, so each playhead should reach exactly one clip ahead.
  for (const double beat : {0.0, 4.0, 9.0, 17.0, 25.0}) {
    a.cx.seekBeat(beat); a.cx.update(0.0); a.cx.transportResolve(0.0);
    b.cx.seekBeat(beat); b.cx.update(0.0); b.cx.transportResolve(0.0);
    const auto loose = warmedIds(a.cx);
    const auto seq = warmedIds(b.cx);
    INFO("beat " << beat);
    INFO("loose: " << json(std::vector<std::string>(loose.begin(), loose.end())).dump());
    INFO("seq:   " << json(std::vector<std::string>(seq.begin(), seq.end())).dump());
    CHECK(seq == loose);
  }
}

TEST_CASE("sequence prefetch: a distant sub-clip is NOT warmed early",
          "[comp_sequence]") {
  // The bound matters: grouping must not turn "warm what's next" into "open
  // every decoder in the interior".
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 64, "lane1",
                        json::array({mkVideoClip("near", 0, 8), mkVideoClip("far", 48, 8)}))})),
  })));
  h.cx.seekBeat(0.0);
  h.cx.update(0.0);
  h.cx.transportResolve(0.0);
  const auto w = warmedIds(h.cx);
  CHECK(w.count("near") == 1);
  CHECK(w.count("far") == 0);   // 48 beats out — far past the lookahead

  // ...but it IS warmed once the interior clock approaches it.
  h.cx.seekBeat(44.0);
  h.cx.update(0.0);
  h.cx.transportResolve(0.0);
  CHECK(warmedIds(h.cx).count("far") == 1);
}

TEST_CASE("sequence prefetch: a LOOPING interior warms across the wrap",
          "[comp_sequence]") {
  // The interior boundary recurs every pass, so the clip at interior beat 0 is
  // "upcoming" again as the pass ends — a forward-only scan would miss it and
  // the loop point would hitch.
  EvalHarness h;
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 64, "lane1",
                        json::array({mkVideoClip("head", 0, 8), mkVideoClip("tail", 8, 8)}))})),
  })));
  // Interior extent 16 beats; at beat 14 the next 8 beats wrap past 16 back to 0.
  h.cx.seekBeat(14.0);
  h.cx.update(0.0);
  h.cx.transportResolve(0.0);
  const auto w = warmedIds(h.cx);
  INFO(h.cx.videoDescsJson());
  CHECK(w.count("tail") == 1);
  CHECK(w.count("head") == 1);  // the wrap target
}

TEST_CASE("sequence scene mode: launch, prewarm and announce reach the interior lane",
          "[comp_sequence]") {
  // A scene-mode interior is a scene track in every respect — it just lives
  // inside a clip. Its lane id keys sceneLaunch_/announces_ like any track id.
  EvalHarness h;
  json laneScene = json::object();
  laneScene["kind"] = "scene";
  h.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 32, "lane1",
                        json::array({mkVideoClip("sA", 0, 4), mkVideoClip("sB", 4, 4),
                                     mkVideoClip("sC", 8, 4)}),
                        json::array(), laneScene)})),
  })));
  h.cx.seekBeat(0.0);
  h.cx.update(0.0);

  // Nothing launched ⇒ the interior renders nothing (scenes don't follow beats).
  CHECK(h.cx.chainKeysJson().find("clip_sA") == std::string::npos);

  // Launching by the LANE's id works — findSceneClip resolves interior lanes.
  h.cx.launchScene("lane1", "sA");
  h.cx.update(0.0);
  INFO(h.cx.chainKeysJson());
  CHECK(h.cx.chainKeysJson().find("clip_sA") != std::string::npos);
  CHECK(warmedIds(h.cx).count("sA") == 1);

  // The precache planner reaches the interior: with a scene live, its nearest
  // launchable siblings warm (the ordinal machinery needs the LANE's track
  // stream, which is minted unenumerated).
  h.cx.transportResolve(0.0);
  const auto w = warmedIds(h.cx);
  INFO(json(std::vector<std::string>(w.begin(), w.end())).dump());
  CHECK((w.count("sB") == 1 || w.count("sC") == 1));

  // An ANNOUNCE (the autopilot's "I'll launch ordinal N in ~eta") targets the
  // lane and pins its target into the warm set ahead of the fire.
  h.cx.announceScene("lane1", "sC", 0.4, 1);
  h.cx.update(0.0);
  CHECK(warmedIds(h.cx).count("sC") == 1);
}

TEST_CASE("sequence scene mode: the interior lane gets a real track stream",
          "[comp_sequence]") {
  // streams.parent() from an effect inside the interior must resolve to the
  // LANE (not the session clock), and the lane must NOT consume an enumerated
  // ordinal (that would renumber every existing track stream).
  EvalHarness plain, seq;
  plain.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkClip("c1", 0, 8,
                                        json::array({mkDevice("d1", "source.solid_color")}))})),
  })));
  json laneScene = json::object();
  laneScene["kind"] = "scene";
  seq.cx.loadDocument(mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip(
                        "seq", 0, 8, "lane1",
                        json::array({mkClip("c1", 0, 8,
                                            json::array({mkDevice("d1", "source.solid_color")}))}),
                        json::array(), laneScene)})),
  })));
  const json a = json::parse(plain.cx.streamsJson());
  const json b = json::parse(seq.cx.streamsJson());
  CHECK(b.value("enumCount", -1) == a.value("enumCount", -2));  // unenumerated

  bool laneFound = false;
  for (const auto& s : b.at("streams")) {
    if (s.value("ownerId", std::string()) != "lane1") continue;
    laneFound = true;
    CHECK(s.value("kind", 0) == 4);      // SceneTrack — the lane is in scene mode
    CHECK(s.value("index", 0) == -1);    // present but not enumerated
  }
  CHECK(laneFound);
}

TEST_CASE("sequence repro: interior video with follow sections + an xfade on the sequence",
          "[comp_seqrepro]") {
  // Shape taken from a real user document: a 60-beat sequence clip at beat 12
  // whose own transport section holds transition.xfade, containing two media
  // sub-clips at interior 0..4 and 18..22, each with core.transport.follow.
  EvalHarness h;
  h.cx.registerSchema("transition.xfade", json::object());
  h.cx.registerCapabilities("transition.xfade", json::array({"transport_section"}));
  h.cx.registerSchema("core.transport.follow", json::object());
  h.cx.registerCapabilities("core.transport.follow", json::array({"transport_section"}));

  auto sub = [](const std::string& id, double start, double endSec, int frames, double fps) {
    json c = mkClip(id, start, 4, json::array({mkDevice(id + "_v", "source.video.file")}),
                    {{"kind", "video"},
                     {"source", {{"label", id}, {"durationFrames", frames}, {"sourceKey", id},
                                 {"url", "blob:media/" + id}, {"fps", fps}}},
                     {"loop", {{"mode", "time"}, {"startSec", 0}, {"endSec", endSec},
                               {"speed", 1}, {"direction", "forward"}}},
                     {"transport", {{"devices", json::array({
                          mkDevice(id + "_f", "core.transport.follow")})}}}});
    return c;
  };
  json seq = mkSequenceClip("seq", 12, 60, "lane1",
                            json::array({sub("subA", 0, 1.8333333333333333, 55, 30),
                                         sub("subB", 18, 0.95, 250, 25)}));
  seq["transport"] = {{"devices", json::array({mkDevice("xf", "transition.xfade")})}};
  h.cx.loadDocument(mkComposition(json::array({ mkTrack("t1", json::array({seq})) })));

  h.cx.seekBeat(13.0);   // 1 beat into the sequence ⇒ interior beat 1 ⇒ subA live
  h.cx.update(0.0);
  h.cx.transportResolve(0.0);

  INFO("chain:  " << h.cx.chainKeysJson());
  INFO("descs:  " << h.cx.videoDescsJson());
  INFO("order:  " << h.cx.transportOrderJson());
  {
    std::string rows;
    const json order = json::parse(h.cx.transportOrderJson());
    for (size_t i = 0; i < order.size(); ++i) {
      const auto& r = h.cx.transportResolved()[i];
      rows += order[i].get<std::string>() + "{valid=" + std::to_string(r.valid) +
              " active=" + std::to_string(r.active) + " t=" + std::to_string(r.timeSec) + "} ";
    }
    INFO("rows:   " << rows);
  }

  CHECK(h.cx.chainKeysJson().find("clip_subA_subA_v") != std::string::npos);

  const json order = json::parse(h.cx.transportOrderJson());
  int rowIdx = -1;
  for (size_t i = 0; i < order.size(); ++i) {
    if (order[i].get<std::string>() == "subA") rowIdx = static_cast<int>(i);
  }
  REQUIRE(rowIdx >= 0);                                  // the pump needs a row
  const auto& r = h.cx.transportResolved()[rowIdx];
  CHECK(r.valid);
  CHECK(r.active >= 0.5);                                // else the pump injects NOTHING
  CHECK(r.timeSec == Catch::Approx(0.5).margin(1e-6));   // 1 beat @120bpm = 0.5 s in
}

TEST_CASE("sequence renders its interior to real pixels (GPU)", "[comp_render][comp_sequence]") {
  // Compositing in isolation — a solid-colour interior clip, no video pump.
  // If a sequence renders transparent/black while the same clip on a plain
  // track renders red, the bug is in compositeSequence, not the decode path.
  Harness hx;
  if (!hx.init()) SKIP("No Metal device available");

  auto redClip = [](const std::string& id, double start, double len) {
    return mkClip(id, start, len,
                  json::array({mkDevice(id + "_d", "source.solid_color",
                                        {{"color", {1.0, 0.0, 0.0}}})}));
  };

  // A: the clip on a plain track.
  const json looseDoc = mkComposition(json::array({
      mkTrack("t1", json::array({redClip("c1", 0, 8)})),
  }));
  // B: the SAME clip inside a sequence clip spanning the same beats.
  const json seqDoc = mkComposition(json::array({
      mkTrack("t1", json::array({mkSequenceClip("seq", 0, 8, "lane1",
                                                json::array({redClip("c1", 0, 8)}))})),
  }));

  auto renderMean = [&](const json& doc) {
    comp::CompExecutor cx(hx.rt.get(), hx.registry.get(), hx.backend.get());
    hx.seed(cx);
    cx.loadDocument(doc);
    cx.seekBeat(1.0);
    const uint32_t flags = cx.update(0.0);
    INFO("chain: " << cx.chainKeysJson());
    CHECK((flags & comp::kCompHasContent) != 0);
    int32_t inTex = hx.makeTex(), outTex = hx.makeTex();
    const int32_t out = cx.render(inTex, outTex, W, H, 1.0 / 60.0);
    return meanRgb(hx.read(out));
  };

  const double loose = renderMean(looseDoc);
  const double seq = renderMean(seqDoc);
  INFO("loose mean " << loose << "  sequence mean " << seq);
  CHECK(loose > 10.0);                       // the reference actually drew something
  CHECK(seq == Catch::Approx(loose).margin(1.0));  // the sequence must match it

  // TRANSPARENT background — a DIFFERENT path: the accumulator starts empty, so
  // nothing composites the layer over a base and the blend node is elided. This
  // is the real-world default for a comp destined for a video mixer.
  auto withTransparentBg = [](json doc) {
    doc["meta"]["background"] = {{"mode", "transparent"}};
    return doc;
  };
  const double looseT = renderMean(withTransparentBg(looseDoc));
  const double seqT = renderMean(withTransparentBg(seqDoc));
  INFO("transparent bg — loose " << looseT << "  sequence " << seqT);
  CHECK(looseT > 10.0);
  CHECK(seqT == Catch::Approx(looseT).margin(1.0));
}
