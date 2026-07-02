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
