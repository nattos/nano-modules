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
//   4. A live LFO→param wire folds through effrt_published_state_json (the
//      producer-output mirror running in-process).

#include <catch2/catch_test_macros.hpp>

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

TEST_CASE("live LFO→param wire folds via effrt_published_state_json", "[comp_render]") {
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

TEST_CASE("engine-reserved __opacity__/__bypass__ accept wires + automation", "[comp_render]") {
  // Phase-1 reserved-key modulation: the executor folds wires/automation whose
  // dest is an engine-reserved `__` key into its OWN opacity/bypass decisions
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

  SECTION("automation drives __opacity__ and __bypass__; clearing restores authored") {
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

    ex.setAutomation(json::parse(
        R"([{ "instance": "inv", "field": "__bypass__", "value": 1.0,
              "combine": "replace", "magnitude": "unsigned" }])"));
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double bypassed = meanRgb(hx.read(outTex));

    // Clearing automation restores the authored (opacity 1, unbypassed) look.
    ex.setAutomation(json::array());
    ex.execute(sketch, inTex, outTex, W, H, 1.0 / 60.0, false);
    const double restored = meanRgb(hx.read(outTex));

    INFO("base " << base << " half " << half << " off " << off
         << " bypassed " << bypassed << " restored " << restored);
    CHECK(base < 20.0);                        // inverted white = black
    CHECK(std::abs(half - 127.0) < 25.0);      // wet/dry mix at 0.5
    CHECK(off > 235.0);                        // opacity 0 -> passthrough white
    CHECK(bypassed > 235.0);                   // bypass >= 0.5 -> passthrough
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

  SECTION("a wire un-bypasses a statically-bypassed effect") {
    auto wired = sketch;
    // Signed LFO forced unsigned prescales v*0.5+0.5: -0.5 -> 0.25 (< 0.5, ON),
    // +0.5 -> 0.75 (>= 0.5, OFF).
    wired["instances"]["inv"]["state"]["__bypass__"] = true;  // authored: OFF
    wired["instances"]["lfo"]["state"]["output"] = -0.5;      // wire says: ON
    wired["wires"] = json::parse(
        R"([{ "id": "w0", "src": { "instanceKey": "lfo", "field": "output" },
              "dest": { "instanceKey": "inv", "field": "__bypass__" },
              "combine": "replace", "magnitude": "unsigned" }])");
    sketch_executor::SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
    ex.setKeyNamespace("resunbyp/");
    ex.execute(wired, inTex, outTex, W, H, 1.0 / 60.0, true);
    const double on = meanRgb(hx.read(outTex));

    // Flip the producer above threshold: bypassed again (passthrough white).
    wired["instances"]["lfo"]["state"]["output"] = 0.5;
    ex.execute(wired, inTex, outTex, W, H, 1.0 / 60.0, true);
    const double off = meanRgb(hx.read(outTex));

    INFO("unbypassed " << on << " bypassed " << off);
    CHECK(on < 20.0);    // wire held the effect ON despite authored __bypass__
    CHECK(off > 235.0);  // wire crossed 0.5 -> dormant passthrough
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
