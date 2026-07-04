// test_effect_render.cpp — end-to-end GPU render of a WASM effect (barrel-
// loads-WASM). Loads brightness_contrast from core.wasm, registers it through
// the WASM ModuleRegistry (module_init compiles its SPV→MSL shader + PSO on a
// real Metal backend), wires tex_in/tex_out, drives doRender via the WASM
// EffectInstance driver, and verifies the output pixels brighten.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/param_cache.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "runtime/text_host.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using wasm::WasmHost;
using wasm::WasmEffectDesc;
using effect_runtime::EffectRuntime;
using effect_runtime::EffectInstance;

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

static double mean_rgb(const std::vector<uint8_t>& px) {
  long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? static_cast<double>(sum) / n : 0.0;
}

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

TEST_CASE("WASM GPU effect renders via Metal (brightness_contrast)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  auto bytecode = load_file(CORE_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // The backend must be set before module_init runs (it compiles the shader).
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "color.tone.brightness_contrast") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  // Register ONLY this effect — registering the whole bundle would run every
  // effect's module_init, some of which use host imports not yet wired.
  REQUIRE(registry.registerWasmEffect("color.tone.brightness_contrast",
                                      "Brightness & Contrast", &host, id, *w));

  EffectInstance* inst = rt.instanceFor("color.tone.brightness_contrast", "k0");
  REQUIRE(inst != nullptr);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0);
  REQUIRE(outTex >= 0);

  // Fill the input with mid-gray (64,64,64,255).
  std::vector<uint8_t> inPixels(W * H * 4, 64);
  for (size_t i = 3; i < inPixels.size(); i += 4) inPixels[i] = 255;
  backend->writeTexture(inTex, W, H, inPixels.data(),
                        static_cast<uint32_t>(inPixels.size()));

  inst->setTextureField("tex_in", inTex);
  inst->setTextureField("tex_out", outTex);

  const double inMean = mean_rgb(inPixels);

  // brightness +0.5 (> neutral 0) should lift the output above the input.
  inst->setParamFloat("brightness", 0.5f);
  inst->setParamFloat("contrast", 0.0f);
  inst->doRender(W, H);  // effect calls gpu.submit() internally (commit+wait)
  auto bright = backend->readbackTexture(outTex, W, H);
  REQUIRE(bright.size() == W * H * 4);
  INFO("in mean " << inMean << "  bright mean " << mean_rgb(bright));
  CHECK(mean_rgb(bright) > inMean + 30.0);

  // Neutral (0/0) is identity: output ~= input.
  inst->setParamFloat("brightness", 0.0f);
  inst->setParamFloat("contrast", 0.0f);
  inst->doRender(W, H);
  auto ident = backend->readbackTexture(outTex, W, H);
  INFO("ident mean " << mean_rgb(ident));
  CHECK(std::abs(mean_rgb(ident) - inMean) < 8.0);

  host.shutdown();
}

// The slot-based GPU input ABI: composite.blend reads its two inputs via
// gpu::Device::inputTexture(0/1) and writes via renderTarget() — NOT
// textureForField. This locks the executor↔host plumbing that feeds those
// (EffectInstance::setInputTextureSlots → WasmContext::input_texture_handles,
// and GPUBackend::setSurface → getSurfaceTexture). Without it the effect bails
// to black; texture wires into multi-input effects depend on it.
TEST_CASE("WASM slot-based input ABI blends two textures (composite.blend)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  auto bytecode = load_file(CORE_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "composite.blend") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(registry.registerWasmEffect("composite.blend", "Blend", &host, id, *w));

  EffectInstance* inst = rt.instanceFor("composite.blend", "k0");
  REQUIRE(inst != nullptr);

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int texA = backend->createTexture(W, H, RGBA8);   // dark
  int texB = backend->createTexture(W, H, RGBA8);   // bright
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(texA >= 0); REQUIRE(texB >= 0); REQUIRE(outTex >= 0);

  std::vector<uint8_t> aPix(W * H * 4, 40);
  std::vector<uint8_t> bPix(W * H * 4, 200);
  for (size_t i = 3; i < aPix.size(); i += 4) { aPix[i] = 255; bPix[i] = 255; }
  backend->writeTexture(texA, W, H, aPix.data(), (uint32_t)aPix.size());
  backend->writeTexture(texB, W, H, bPix.data(), (uint32_t)bPix.size());

  // Slot 0 = A, slot 1 = B (mirrors the executor's per-stage publish).
  inst->setInputTextureSlots({texA, texB});
  backend->setSurface(outTex, W, H);  // renderTarget() resolves here

  // opacity = 1 → output = B (bright).
  inst->setParamFloat("opacity", 1.0f);
  inst->doRender(W, H);
  auto allB = backend->readbackTexture(outTex, W, H);
  INFO("opacity=1 mean " << mean_rgb(allB) << " (expect ~200)");
  CHECK(mean_rgb(allB) > 180.0);

  // opacity = 0 → output = A (dark). Proves slot 0 is wired independently.
  inst->setParamFloat("opacity", 0.0f);
  inst->doRender(W, H);
  auto allA = backend->readbackTexture(outTex, W, H);
  INFO("opacity=0 mean " << mean_rgb(allA) << " (expect ~40)");
  CHECK(mean_rgb(allA) < 60.0);

  // opacity = 0.5 → midpoint of the two slots.
  inst->setParamFloat("opacity", 0.5f);
  inst->doRender(W, H);
  auto mid = backend->readbackTexture(outTex, W, H);
  INFO("opacity=0.5 mean " << mean_rgb(mid) << " (expect ~120)");
  CHECK(std::abs(mean_rgb(mid) - 120.0) < 25.0);

  // --- Blend modes (mode select drives the shader switch). A=40, B=200 ---
  inst->setParamFloat("opacity", 1.0f);

  // Multiply (mode 2): (40/255)*(200/255)*255 ≈ 31 — darker than EITHER input.
  inst->setParamFloat("mode", 2.0f);
  inst->doRender(W, H);
  auto mul = backend->readbackTexture(outTex, W, H);
  INFO("Multiply mean " << mean_rgb(mul) << " (expect ~31)");
  CHECK(std::abs(mean_rgb(mul) - 31.0) < 15.0);

  // Add (mode 1): min(1, 40/255 + 200/255)*255 ≈ 240 — brighter than EITHER.
  inst->setParamFloat("mode", 1.0f);
  inst->doRender(W, H);
  auto add = backend->readbackTexture(outTex, W, H);
  INFO("Add mean " << mean_rgb(add) << " (expect ~240)");
  CHECK(mean_rgb(add) > 220.0);

  host.shutdown();
}

TEST_CASE("full core.wasm bundle registers every effect under Metal", "[effect_render]") {
  // The barrel cutover gate: loading the bundle and registering ALL of its
  // effects runs each one's module_init (schema publish + shader/PSO compile).
  // None may trip on an unimplemented host import.
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  auto bytecode = load_file(CORE_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const size_t declared = host.registered_effects(id).size();
  INFO("bundle declares " << declared << " effect(s)");
  REQUIRE(declared > 1);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  int n = registry.registerWasmBundle(host, id);
  INFO("registered " << n);
  CHECK(n == static_cast<int>(declared));

  // Every registered effect published a non-empty schema → its module_init ran
  // through state::init without trapping. (The render case above proves the
  // shader/PSO path for a representative effect.)
  auto schemas = registry.schemas();
  int withSchema = 0;
  for (const auto& kv : schemas) {
    if (kv.second.is_object() && !kv.second.empty()) ++withSchema;
  }
  INFO("effects with non-empty schema: " << withSchema << "/" << n);
  CHECK(withSchema == n);

  host.shutdown();
}

// Positional-delay (feedback) wire through the full SketchExecutor. A wire
// whose producer sits BELOW its consumer in the chain feeds the PREVIOUS
// frame's value — the executor retains a 1-frame texture copy. Here a blend
// accumulator mixes the constant input with its own delayed output:
//   out_n = (1-O)*input + O*out_{n-1}   → converges to `input` over frames.
// Without the delay path the wire (producer below) delivers nothing and blend
// never accumulates, so observing monotonic convergence to the input proves
// the retained-copy feedback delivers.
TEST_CASE("positional-delay feedback wire converges (blend accumulator)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 32, H = 32;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);

  auto writeInput = [&](uint8_t v) {
    std::vector<uint8_t> px(W * H * 4, v);
    for (size_t i = 3; i < px.size(); i += 4) px[i] = 255;  // opaque
    backend->writeTexture(inTex, W, H, px.data(), (uint32_t)px.size());
  };

  // acc(blend).tex_a = input; acc.tex_b = DELAYED feedback from fb's output (fb
  // sits below acc → the wire is a back-edge delivering fb's PREVIOUS-frame
  // output). fb is a near-neutral pass so fb.tex_out tracks acc's output.
  // opacity 0.5 → a one-pole frame blend: out ≈ 0.5*input + 0.5*(prev output).
  //
  // Under alpha-correct source-over a CONSTANT opaque input reaches steady state
  // on frame 0 (a transparent first feedback reveals the base), so it shows no
  // transient. Instead we STEP the input: settle on a low value, then jump high
  // and watch the output RAMP toward the new value over several frames. That
  // ramp exists ONLY because the feedback delivers a delayed (previous-frame)
  // value — with no delay the output would jump to the new input immediately.
  //
  // fb uses a tiny non-zero contrast so it is NOT an identity passthrough (an
  // identity stage is aliased to its input, which would collapse the one-frame
  // delay) while staying close enough to neutral for the blend math above.
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "composite.blend", "instance_key": "acc" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "fb" }
    ],
    "instances": {
      "acc": { "module_type": "composite.blend", "state": { "opacity": 0.5 } },
      "fb":  { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.0, "contrast": 0.01 } }
    },
    "wires": [
      { "id": "wfb", "src": { "instanceKey": "fb", "field": "tex_out" },
                     "dest": { "instanceKey": "acc", "field": "tex_b" } }
    ]
  })JSON");

  const uint8_t LO = 40, HI = 200;
  int32_t out = 0;

  // Settle the accumulator on LO.
  writeInput(LO);
  for (int f = 0; f < 24; ++f) {
    out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0,
                           /*sketchDirty=*/f == 0);
    backend->submit();
  }
  const double settledLo = mean_rgb(backend->readbackTexture(out, W, H));

  // Step the input to HI. One frame later the output is dragged by the feedback
  // (still carrying the LO-ish previous output), so it lands well below HI.
  writeInput(HI);
  out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, false);
  backend->submit();
  const double earlyMean = mean_rgb(backend->readbackTexture(out, W, H));

  // After many frames the feedback catches up and the output converges to HI.
  for (int f = 0; f < 30; ++f) {
    out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, false);
    backend->submit();
  }
  const double lateMean = mean_rgb(backend->readbackTexture(out, W, H));

  INFO("settledLo " << settledLo << "  early(step) " << earlyMean
       << "  late " << lateMean);
  CHECK(std::abs(settledLo - LO) < 8.0);   // converged to LO before the step
  CHECK(std::abs(lateMean - HI) < 8.0);    // eventually converges to HI
  CHECK(earlyMean > settledLo + 10.0);     // it HAS started moving up after the step
  CHECK(earlyMean < lateMean - 20.0);      // ...but lags — proof the delayed wire delivers
}

// Disabling an effect makes it INVISIBLE to modulation auto-connect: a
// downstream shaper skips a bypassed shaper and re-routes to the nearest
// ENABLED producer above it. chain: lfo(out 0.5) -> mid(smooth, out 0.9) ->
// tail(remap). The tail's input auto-connects to its nearest enabled producer;
// probe it via lastModulationData (same mechanism as the chaining test above).
//   - mid enabled : tail.input = mid.output (0.9).
//   - mid disabled: tail skips mid, connects to lfo → tail.input = lfo.output (0.5).
// Only __bypass__ on mid differs, so the 0.9 -> 0.5 flip isolates the re-route.
TEST_CASE("disabled shaper is skipped by modulation auto-connect", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  auto buildSketch = [](bool midBypassed) {
    nlohmann::json midState = {{"output", 0.9}};
    if (midBypassed) midState["__bypass__"] = true;
    return nlohmann::json{
      {"chain", nlohmann::json::array({
        {{"module_type", "source.solid_color"}, {"instance_key", "src"}, {"params", {{"color", {1.0, 1.0, 1.0}}}}},
        {{"module_type", "mod.source.lfo"},     {"instance_key", "lfo"}, {"params", {{"rate", 0.0}, {"amplitude", 1.0}}}},
        {{"module_type", "mod.shaper.smooth"},  {"instance_key", "mid"}, {"params", nlohmann::json::object()}},
        {{"module_type", "mod.shaper.remap"},   {"instance_key", "tail"},{"params", nlohmann::json::object()}},
      })},
      {"instances", {
        {"lfo", {{"module_type", "mod.source.lfo"},    {"state", {{"output", 0.5}}}}},
        {"mid", {{"module_type", "mod.shaper.smooth"}, {"state", midState}}},
      }},
    };
  };

  auto tailInput = [&](bool midBypassed) {
    auto sketch = buildSketch(midBypassed);
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, /*sketchDirty=*/true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("tail"));
    REQUIRE(md["tail"].contains("input"));
    return md["tail"]["input"]["value"].get<double>();
  };

  // mid enabled: tail auto-connects to mid (its output, 0.9).
  CHECK(tailInput(false) == Catch::Approx(0.9).margin(0.02));
  // mid disabled: tail skips it and re-routes to lfo (its output, 0.5).
  CHECK(tailInput(true) == Catch::Approx(0.5).margin(0.02));
}

// Plan-rebuild gating (#105): on a dirty frame the executor rebuilds its
// structural plan ONLY when the chain topology actually changed, not on every
// param edit. A continuous slider/knob drag sets the coarse value-dirty flag
// each frame, but those edits change only effect param VALUES (read live via
// applyState / read taps) — never the plan. This test reuses ONE SketchExecutor
// across frames and asserts: (a) a param-only dirty frame applies the new value
// WITHOUT bumping the buildPlan counter (cached plan reused), and (b) a topology
// change (adding a chain entry) DOES force a rebuild.
TEST_CASE("param-only edits reuse the plan; topology changes rebuild it",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);

  std::vector<uint8_t> inPix(W * H * 4, 64);  // mid-gray
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);  // 64

  auto runFrame = [&](const nlohmann::json& sketch, bool dirty) {
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H,
                                   1.0 / 60.0, dirty);
    backend->submit();
    return mean_rgb(backend->readbackTexture(out, W, H));
  };

  // Frame 0 (dirty): one brightness_contrast at +0.5 (> neutral 0) → lifts.
  auto bright = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "bc" } ],
    "instances": {
      "bc": { "module_type": "color.tone.brightness_contrast",
              "state": { "brightness": 0.5, "contrast": 0.0 } }
    }
  })JSON");
  double m0 = runFrame(bright, /*dirty=*/true);
  const int afterFirst = executor.planBuildCountForTest();
  REQUIRE(afterFirst >= 1);             // first frame builds the plan
  CHECK(m0 > inMean + 20.0);            // brightened

  // Frame 1 (dirty, PARAM-ONLY): same topology, brightness -0.5 (< neutral) →
  // darkens. The structural signature is unchanged, so the plan must be REUSED
  // (counter steady) even though the value-dirty flag is set, yet the new value
  // must still take effect (applyState runs on the dirty flag).
  auto dark = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "bc" } ],
    "instances": {
      "bc": { "module_type": "color.tone.brightness_contrast",
              "state": { "brightness": -0.5, "contrast": 0.0 } }
    }
  })JSON");
  double m1 = runFrame(dark, /*dirty=*/true);
  CHECK(executor.planBuildCountForTest() == afterFirst);  // NO rebuild
  CHECK(m1 < inMean - 10.0);                              // value applied → darkened
  CHECK(m1 < m0 - 30.0);

  // Frame 2 (NOT dirty): steady state — no rebuild, output stable.
  double m2 = runFrame(dark, /*dirty=*/false);
  CHECK(executor.planBuildCountForTest() == afterFirst);  // still no rebuild
  CHECK(std::abs(m2 - m1) < 4.0);

  // Frame 3 (dirty, TOPOLOGY CHANGE): append a second brightness_contrast. The
  // signature changes (new chain entry), so the plan MUST rebuild.
  auto twoStage = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc2" }
    ],
    "instances": {
      "bc":  { "module_type": "color.tone.brightness_contrast",
               "state": { "brightness": -0.5, "contrast": 0.0 } },
      "bc2": { "module_type": "color.tone.brightness_contrast",
               "state": { "brightness": 0.5, "contrast": 0.0 } }
    }
  })JSON");
  runFrame(twoStage, /*dirty=*/true);
  CHECK(executor.planBuildCountForTest() == afterFirst + 1);  // rebuilt for topology
}

// Gap #1 repro (task #106). Two parity fixes, both exercised here:
//  (A) legacy `entry.params` fallback — the sketch carries field values on the
//      chain entry's `params` (no instances[key].state); the executor must apply
//      them (TS executor falls back to entry.params). Without it the solid_color
//      sources render their DEFAULT grey and the blend is grey, not red/blue.
//  (B) a texture wire whose DEST field is the schema's NAMED input slot
//      (composite.blend tex_a/tex_b) OR a NUMERIC positional index ('0'/'1') must
//      both reach inputTexture(0/1). The editor uses both spellings.
// Sketch: red(solid)→blue(solid)→blend, all params on entry.params, opacity 0 →
// output == tex_a (red). Run once with named dests, once with numeric.
TEST_CASE("entry.params + named/numeric input wires drive composite.blend",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);
  std::vector<uint8_t> blk(W * H * 4, 0);
  for (size_t i = 3; i < blk.size(); i += 4) blk[i] = 255;
  backend->writeTexture(inTex, W, H, blk.data(), (uint32_t)blk.size());

  // chain: red(solid) -> blue(solid) -> blend; wires red.tex_out->blend.<destA>,
  // blue.tex_out->blend.<destB>. Field values live on entry.params (NO instances
  // map) to exercise the legacy fallback. opacity 0 -> output == tex_a (red).
  auto sketchFor = [](const char* destA, const char* destB) {
    return nlohmann::json::parse(std::string(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "red",  "params": { "color": [1.0, 0.0, 0.0] } },
        { "module_type": "source.solid_color", "instance_key": "blue", "params": { "color": [0.0, 0.0, 1.0] } },
        { "module_type": "composite.blend", "instance_key": "mix", "params": { "opacity": 0.0 } }
      ],
      "wires": [
        { "id": "wa", "src": { "instanceKey": "red",  "field": "tex_out" }, "dest": { "instanceKey": "mix", "field": ")JSON")
      + destA + R"JSON(" } },
        { "id": "wb", "src": { "instanceKey": "blue", "field": "tex_out" }, "dest": { "instanceKey": "mix", "field": ")JSON"
      + destB + R"JSON(" } }
      ]
    })JSON");
  };

  auto meanOf = [&](const nlohmann::json& sketch) {
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0,
                                   /*sketchDirty=*/true);
    backend->submit();
    auto px = backend->readbackTexture(out, W, H);
    // Return per-channel mean of the center region.
    double r = 0, g = 0, b = 0; int n = 0;
    for (uint32_t y = 4; y < 12; ++y) for (uint32_t x = 4; x < 12; ++x) {
      size_t i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; ++n;
    }
    return std::array<double, 3>{r / n, g / n, b / n};
  };

  // Numeric dests already work today — sanity anchor.
  auto numeric = meanOf(sketchFor("0", "1"));
  INFO("numeric '0'/'1' rgb " << numeric[0] << "," << numeric[1] << "," << numeric[2]);
  CHECK(numeric[0] > 200.0);   // red present
  CHECK(numeric[2] < 60.0);    // blue suppressed (opacity 0 → tex_a)

  // Named dests must behave identically.
  auto named = meanOf(sketchFor("tex_a", "tex_b"));
  INFO("named 'tex_a'/'tex_b' rgb " << named[0] << "," << named[1] << "," << named[2]);
  CHECK(named[0] > 200.0);     // red present  ← the failing assertion
  CHECK(named[2] < 60.0);      // blue suppressed
}

// Gap #3 regression (task #106): the entry.params fallback must merge PER FIELD,
// not all-or-nothing. The web host mirrors a producer's live OUTPUT scalars into
// instances[key].state, leaving it partially populated; an all-or-nothing skip
// then drops the entry.params INPUT fields (e.g. mod.source.lfo's rate), so the effect
// runs at schema defaults. Here bc carries a partial instances.state
// {brightness:0.0} (the "mirrored" field) AND entry.params {contrast:-1.0}. With
// the per-field merge, contrast=-1.0 (0× scale) is applied → black; with the old
// all-or-nothing skip, contrast stays default 0.0 (1×) → the white passes through.
TEST_CASE("entry.params merges per-field over partial instance state",
          "[effect_render]") {
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

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
        "params": { "brightness": 0.0, "contrast": -1.0 } }
    ],
    "instances": { "bc": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.0 } } }
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
  backend->submit();
  auto px = backend->readbackTexture(out, W, H);
  double m = mean_rgb(px);
  INFO("output mean " << m << " (expect ~0 black: contrast=-1 from entry.params applied)");
  CHECK(m < 30.0);
}

// Gap #3 repro of the EXACT web engine-wires "forward scalar wire" sketch:
// white -> mod.source.lfo(rate 0) -> brightness_contrast, wire lfo.output -> brightness.
// lfo.output==0.5 (mirrored into instance state, as the web host does) folds into
// brightness's signed [-1,1] -> 0 (neutral, magnitude auto/unsigned). With
// contrast -0.5 (0.5x scale) on white -> output grey ~128.
TEST_CASE("forward scalar wire lfo.output -> brightness (web repro)",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  // lfo.output mirrored to its rest in instance state (the web host injects
  // producer outputs there; the native float write-tap reads them from JSON).
  // The LFO is now a SIGNED source resting at 0 (was unipolar resting at 0.5),
  // so a resting source applies a neutral modulation → grey output.
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
    ],
    "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.0 } } },
    "wires": [
      { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" } }
    ]
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
  backend->submit();
  auto px = backend->readbackTexture(out, W, H);
  double m = mean_rgb(px);
  INFO("output mean " << m << " (expect ~128 grey)");
  CHECK(std::abs(m - 128.0) < 20.0);
}

// Modulation telemetry: the executor records, for every modulated scalar input,
// the effective resolved value + the swing band the wire can drive it through
// (lastModulationData(), the source of the editor's slider band). Same sketch
// as the forward-wire repro: mod.source.lfo -> bc.brightness, magnitude auto/
// replace into brightness's signed [-1,1]. mod.source.lfo.output is now itself a
// SIGNED source in [-1,1] resting at 0, so a resting source (output 0) records
// value 0 with neutral 0 and the band spanning the dest's [-1,1]. A `mod` shaper
// (remap/envelope) reshapes the value + band; its output flows through directly
// (NO re-fold into the dest range) — see the per-section notes.
TEST_CASE("executor records modulated-input value + swing band", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  SECTION("plain wire — band spans the dest's declared [-1,1]") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.0 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" } }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    REQUIRE(md["bc"].contains("brightness"));
    const auto& b = md["bc"]["brightness"];
    CHECK(b["value"].get<double>()   == Catch::Approx(0.0).margin(0.01));   // resting signed source → 0
    CHECK(b["min"].get<double>()     == Catch::Approx(-1.0).margin(0.01));
    CHECK(b["max"].get<double>()     == Catch::Approx(1.0).margin(0.01));
    CHECK(b["neutral"].get<double>() == Catch::Approx(0.0).margin(0.01));   // signed replace → midpoint (0)
  }

  SECTION("a remap on the wire narrows the band to the remap output range") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" },
          "mod": { "remap": { "inMin": 0.0, "inMax": 1.0, "outMin": 0.25, "outMax": 0.75 } } }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    REQUIRE(md["bc"].contains("brightness"));
    const auto& b = md["bc"]["brightness"];
    // remap out [0.25,0.75] flows through directly (no re-fold): live source 0.5
    // → remap(0.5)=0.5; the band is the swept remap range mapped into the dest.
    CHECK(b["value"].get<double>() == Catch::Approx(0.5).margin(0.01));   // remap(0.5) = 0.5
    CHECK(b["min"].get<double>()   == Catch::Approx(-0.25).margin(0.01));
    CHECK(b["max"].get<double>()   == Catch::Approx(0.75).margin(0.01));
  }

  // An ENVELOPE shaper on the wire reshapes the value the same way mod.shaper.envelope
  // would. Curve (0,0.2)->(1,0.6) maps lfo.output 0.5 -> 0.4, narrowing the band
  // to the envelope's [0.2,0.6] output window (swept over the source). The shaped
  // output flows through directly (no re-fold into brightness's signed range).
  SECTION("an envelope on the wire reshapes the value + band") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": 0.25 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" },
          "mod": { "envelope": [0.0, 0.2, 0.0, 1.0, 0.6, 0.0] } }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    const auto& b = md["bc"]["brightness"];
    CHECK(b["value"].get<double>() == Catch::Approx(0.4).margin(0.01));   // env(0.5) = 0.4
    CHECK(b["min"].get<double>()   == Catch::Approx(0.2).margin(0.01));   // env(0)  = 0.2
    CHECK(b["max"].get<double>()   == Catch::Approx(0.6).margin(0.01));   // env(1)  = 0.6
  }

  // A DELAY shaper on the wire lags the value: it's stateful across frames, so a
  // generous (1s) delay still reads the FIRST frame's value after the source
  // jumps on the second frame. Without the delay the value would track the source
  // (0.8) immediately. Proves the executor's per-input delay line is wired in.
  SECTION("a delay on the wire lags the value across frames") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": 0.25 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.2 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" },
          "mod": { "delay": 1.0 } }
      ]
    })JSON");
    // Frame 1: source 0.2 — the delay underruns to the only (== current) sample.
    // The value flows through directly (no re-fold): 0.2.
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    CHECK(executor.lastModulationData()["bc"]["brightness"]["value"].get<double>()
            == Catch::Approx(0.2).margin(0.02));
    // Frame 2: source jumps to 0.8, but the 1s delay still reads frame 1's 0.2;
    // without the delay it would track 0.8 immediately.
    sketch["instances"]["lfo"]["state"]["output"] = 0.8;
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, false);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    CHECK(md["bc"]["brightness"]["value"].get<double>() == Catch::Approx(0.2).margin(0.05));
  }

  // mod.source.lfo.output is now itself a SIGNED source resting at 0, so an
  // explicit `magnitude: "signed"` is a no-op here (it already is signed): a
  // resting source (output 0) maps to the dest's midpoint 0 with the band
  // spanning the full signed [-1,1]. (Historically this section forced signed on
  // the then-unsigned lfo to prove the prescale; the source flipping to signed
  // makes the override redundant, but the bipolar band + 0 rest still hold.)
  SECTION("signed magnitude on the (now signed) source spans the bipolar band") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.0 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" },
          "magnitude": "signed" }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    REQUIRE(md["bc"].contains("brightness"));
    const auto& b = md["bc"]["brightness"];
    CHECK(b["value"].get<double>()   == Catch::Approx(0.0).margin(0.01));  // resting source → mid
    CHECK(b["min"].get<double>()     == Catch::Approx(-1.0).margin(0.01)); // src -1 → range min
    CHECK(b["max"].get<double>()     == Catch::Approx(1.0).margin(0.01));  // src +1 → range max
    CHECK(b["neutral"].get<double>() == Catch::Approx(0.0).margin(0.01));  // signed replace → midpoint (0)
  }

  // The polarity prescale must apply BEFORE `scale` (it's a reinterpretation of
  // the source range), so `scale` scales the bipolar swing around its neutral
  // (0 for signed). Regression: when the prescale ran AFTER applyTapMod, the
  // affine bias landed outside `scale`, so a sub-1 scale dragged the effective
  // value toward -1 instead of holding the add-neutral (the base value).
  SECTION("scale on a forced-signed add wire holds the neutral, not -1") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 0.5, "contrast": -0.5 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.0 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "bc", "field": "brightness" },
          "magnitude": "signed", "combine": "add", "mod": { "scale": 0.5 } }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("bc"));
    REQUIRE(md["bc"].contains("brightness"));
    const auto& b = md["bc"]["brightness"];
    // resting signed src 0 -> *scale 0 -> add 0: holds the base (0.5), not -1.0.
    CHECK(b["value"].get<double>()   == Catch::Approx(0.5).margin(0.01));
    CHECK(b["neutral"].get<double>() == Catch::Approx(0.5).margin(0.01));  // add → base
    // Half-scale of the (now wider [-1,1]) swing about the base: 0.5 ± 1.0.
    CHECK(b["min"].get<double>()     == Catch::Approx(-0.5).margin(0.01)); // src 0 → -1.0 → -0.5
    CHECK(b["max"].get<double>()     == Catch::Approx(1.5).margin(0.01));  // src 1 → +1.0 → 1.5
  }
}

// A modulation shaper (mod.shaper.remap) placed DIRECTLY after a modulation generator
// (mod.source.lfo) auto-connects in the executor: the generator's OUTPUT channel
// feeds the shaper's INPUT channel without the user drawing a wire. Gated on the
// capability tags (modulation_source / modulation_shaper). Observed via
// lastModulationData(): the auto-connect records a band on the shaper's `input`
// spanning the source's signed declared range [-1,1]. Explicit wires win; a
// non-adjacent generator does nothing. Same lfo(output 0.5) probe as the wire
// tests (hand-mirrored into state).
TEST_CASE("modulation shaper auto-connects to a preceding generator", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  SECTION("adjacent generator -> shaper auto-connects (absolute) with NO wires") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "mod.shaper.remap", "instance_key": "rm", "params": {} }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } }
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("rm"));
    REQUIRE(md["rm"].contains("input"));
    const auto& in = md["rm"]["input"];
    // Passthrough of lfo.output (0.5); band spans the source's signed decl [-1,1]
    // (the source is now a signed modulation source resting at 0).
    CHECK(in["value"].get<double>() == Catch::Approx(0.5).margin(0.01));
    CHECK(in["min"].get<double>()   == Catch::Approx(-1.0).margin(0.01));
    CHECK(in["max"].get<double>()   == Catch::Approx(1.0).margin(0.01));
  }

  SECTION("an explicit wire on the shaper input suppresses the auto-connect") {
    // Explicit wire with a remap narrowing the band to [0.25,0.75]; if the
    // absolute auto-connect had also fired (or overridden), the band would be
    // [0,1]. The narrowed band proves the explicit wire is the only connection.
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "mod.shaper.remap", "instance_key": "rm", "params": {} }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" }, "dest": { "instanceKey": "rm", "field": "input" },
          "mod": { "remap": { "inMin": 0.0, "inMax": 1.0, "outMin": 0.25, "outMax": 0.75 } } }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("rm"));
    REQUIRE(md["rm"].contains("input"));
    const auto& in = md["rm"]["input"];
    // Explicit remap [0,1]->[0.25,0.75] swept over the signed source → [0.375,0.875]
    // (narrower than the auto-connect's full [-1,1], proving the wire is the only
    // connection).
    CHECK(in["min"].get<double>() == Catch::Approx(0.375).margin(0.01));
    CHECK(in["max"].get<double>() == Catch::Approx(0.875).margin(0.01));
  }

  SECTION("a shaper NOT directly after a generator is left unconnected") {
    // brightness_contrast sits between the lfo and the shaper, so the shaper's
    // nearest predecessor is NOT a modulation source — no auto-connect.
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 0.0, "contrast": 0.0 } },
        { "module_type": "mod.shaper.remap", "instance_key": "rm", "params": {} }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } }
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    // No tap on rm.input → nothing recorded for it.
    CHECK((!md.contains("rm") || !md["rm"].contains("input")));
  }
}

// Shapers CHAIN: a shaper directly after ANOTHER shaper (not just a source)
// auto-connects too, so mod.source.lfo -> mod.shaper.smooth -> mod.shaper.remap wires up end to end
// without the user drawing anything. Both intermediate inputs record a band
// (observed via lastModulationData); the producer outputs are hand-mirrored into
// instance state since the native test harness doesn't run the live mirror.
TEST_CASE("modulation shapers chain via auto-connect", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
      { "module_type": "mod.shaper.smooth", "instance_key": "sm", "params": { "duration": 0.0 } },
      { "module_type": "mod.shaper.remap", "instance_key": "rm", "params": {} }
    ],
    "instances": {
      "lfo": { "module_type": "mod.source.lfo",  "state": { "output": 0.5 } },
      "sm":  { "module_type": "mod.shaper.smooth","state": { "output": 0.7 } }
    }
  })JSON");
  executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
  backend->submit();
  const auto& md = executor.lastModulationData();
  INFO("modulationData = " << md.dump());
  // lfo -> smooth.input (absolute passthrough of lfo.output 0.5).
  REQUIRE(md.contains("sm"));
  REQUIRE(md["sm"].contains("input"));
  CHECK(md["sm"]["input"]["value"].get<double>() == Catch::Approx(0.5).margin(0.01));
  // smooth -> remap.input (absolute passthrough of smooth.output 0.7) — proves
  // the SECOND hop (shaper->shaper) auto-connected.
  REQUIRE(md.contains("rm"));
  REQUIRE(md["rm"].contains("input"));
  CHECK(md["rm"]["input"]["value"].get<double>() == Catch::Approx(0.7).margin(0.01));
}

// A shaper output declared `magnitude:"inherit"` (mod.shaper.smooth/mod.shaper.delay are
// range-preserving) mirrors the polarity of whatever drives its input. Probe via
// the prescale: a `signed` wire from smooth.output, when smooth inherited the
// lfo's SIGNED polarity, spans the full bipolar band (a resting source → the
// dest's midpoint); without a source feeding smooth's input the polarity is
// unknown, so the same wire is taken at face value (only the upper half).
// mod.source.lfo.output is now itself signed; smooth/lfo outputs hand-mirrored
// into state. The sink is color.posterize.amount (an UNSIGNED [0,1] field) — the
// distinction only shows on an unsigned dest, and brightness_contrast is signed.
TEST_CASE("shaper output polarity inherits its input (inherit mode)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> white(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, white.data(), (uint32_t)white.size());

  SECTION("inherits the upstream source's signed polarity (spans the full bipolar band)") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "mod.shaper.smooth", "instance_key": "sm", "params": { "duration": 0.0 } },
        { "module_type": "color.posterize", "instance_key": "pz", "params": { "amount": 0.5 } }
      ],
      "instances": {
        "lfo": { "module_type": "mod.source.lfo",  "state": { "output": 0.0 } },
        "sm":  { "module_type": "mod.shaper.smooth","state": { "output": 0.0 } }
      },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "sm", "field": "output" }, "dest": { "instanceKey": "pz", "field": "amount" }, "magnitude": "signed" }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("pz"));
    REQUIRE(md["pz"].contains("amount"));
    const auto& b = md["pz"]["amount"];
    // NOTE: now that lfo.output is itself signed, smooth inherits "signed" and a
    // forced-signed wire is a no-op (no unsigned→signed rescale), so this lands
    // at face value (upper half [0.5,1]) — the same as the unwired case below.
    // The former inherit-unsigned-vs-unknown distinction collapsed with the
    // source's flip to signed.
    CHECK(b["value"].get<double>()   == Catch::Approx(0.5).margin(0.01));  // face value of resting 0
    CHECK(b["min"].get<double>()     == Catch::Approx(0.5).margin(0.01));  // upper half only
    CHECK(b["max"].get<double>()     == Catch::Approx(1.0).margin(0.01));
    CHECK(b["neutral"].get<double>() == Catch::Approx(0.5).margin(0.01));  // signed replace
  }

  SECTION("unwired shaper input → unknown polarity → forced-signed taken at face value") {
    // No source before smooth → its input is unconnected → inherit resolves to
    // unknown, so forcing signed does NOT rescale (only the upper half).
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.shaper.smooth", "instance_key": "sm", "params": { "duration": 0.0 } },
        { "module_type": "color.posterize", "instance_key": "pz", "params": { "amount": 0.5 } }
      ],
      "instances": {
        "sm": { "module_type": "mod.shaper.smooth", "state": { "output": 0.5 } }
      },
      "wires": [
        { "id": "w0", "src": { "instanceKey": "sm", "field": "output" }, "dest": { "instanceKey": "pz", "field": "amount" }, "magnitude": "signed" }
      ]
    })JSON");
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    REQUIRE(md.contains("pz"));
    REQUIRE(md["pz"].contains("amount"));
    const auto& b = md["pz"]["amount"];
    // 0.5 read as signed face value → (0.5+1)/2 = 0.75; band spans only [0.5,1].
    CHECK(b["value"].get<double>() == Catch::Approx(0.75).margin(0.01));
    CHECK(b["min"].get<double>()   == Catch::Approx(0.5).margin(0.01));
    CHECK(b["max"].get<double>()   == Catch::Approx(1.0).margin(0.01));
  }
}

// The engine-level `FieldOptions.smoothing` option linearly ramps a scalar
// field's final value toward each new target over `duration` seconds (the same
// param_smoothing math as mod.shaper.smooth). It's applied IN the executor (standalone
// path, after read taps), so it works on web AND native. Probe: gray input ->
// brightness_contrast (brightness 0/contrast 0 = identity = gray); step
// brightness 0 -> 1.0. With smoothing a single dt=0.25 / 1s-ramp frame lands
// only ~1/4 of the way (brightness ~0.25), markedly darker than the instant
// jump to brightness 1.0; after enough frames it catches up.
TEST_CASE("engine FieldOptions.smoothing ramps a stepped param in the executor",
          "[effect_render]") {
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
  std::vector<uint8_t> gray(W * H * 4, 128);
  for (size_t i = 3; i < gray.size(); i += 4) gray[i] = 255;
  backend->writeTexture(inTex, W, H, gray.data(), (uint32_t)gray.size());

  // bc entry with optional smoothing on `brightness`; `key` isolates the
  // executor's per-instance ramp state between the smoothed and instant runs.
  auto makeSketch = [](const char* key, bool smooth, double brightness) {
    nlohmann::json entry = {
      {"module_type", "color.tone.brightness_contrast"},
      {"instance_key", key},
    };
    if (smooth) {
      entry["fieldOptions"] = {
        {"brightness", {{"smoothing", {{"enabled", true}, {"duration", 1.0}}}}}
      };
    }
    return nlohmann::json{
      {"chain", nlohmann::json::array({entry})},
      {"instances", {{key, {{"module_type", "color.tone.brightness_contrast"},
                            {"state", {{"brightness", brightness}, {"contrast", 0.0}}}}}}},
    };
  };
  auto runMean = [&](const nlohmann::json& sk, double dt) {
    executor.execute(sk, inTex, outTex, (int)W, (int)H, dt, true);
    backend->submit();
    return mean_rgb(backend->readbackTexture(outTex, W, H));
  };

  // Smoothed: settle at identity (gray), then step brightness -> 1.0 for ONE
  // short frame (dt 0.25 of a 1s ramp).
  double smSettled = runMean(makeSketch("bcS", true, 0.0), 1.0 / 60.0);
  double smStep    = runMean(makeSketch("bcS", true, 1.0), 0.25);
  // Instant (no smoothing): same step jumps straight to brightness 1.0.
  double inSettled = runMean(makeSketch("bcI", false, 0.0), 1.0 / 60.0);
  double inStep    = runMean(makeSketch("bcI", false, 1.0), 0.25);

  INFO("smSettled=" << smSettled << " smStep=" << smStep
       << " inSettled=" << inSettled << " inStep=" << inStep);
  // Identity at brightness 0 → gray passes through (~128), both runs.
  CHECK(smSettled == Catch::Approx(128.0).margin(8.0));
  CHECK(inSettled == Catch::Approx(128.0).margin(8.0));
  // Instant jumps fully bright; smoothed lands only partway.
  CHECK(inStep > smStep + 15.0);   // smoothing visibly lagged the step
  CHECK(smStep > smSettled + 2.0); // …but it did advance toward the target

  // Keep stepping (target held at 1.0): the ramp finishes and catches up.
  double smCaught = smStep;
  for (int i = 0; i < 12; ++i) smCaught = runMean(makeSketch("bcS", true, 1.0), 0.25);
  INFO("smCaught=" << smCaught << " inStep=" << inStep);
  CHECK(smCaught == Catch::Approx(inStep).margin(6.0));
}

// Effects declare queryable "capabilities" — a top-level schema array, separate
// from the per-field io flags. The two-tier vocabulary pairs an UMBRELLA tag
// with an arity/channel-SPECIFIC one (channels themselves stay implicit: the
// magnitude'd scalar outputs). A plain image effect declares none. This drives
// the editor's modulation palettes. Exercises host.h .capability() emission →
// schema JSON → native ModuleRegistry parse, end to end.
TEST_CASE("effects expose declarative capability tags", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);

  // mod.source.lfo (env_lfo lifecycle) → single-channel modulation source: declares
  // both the umbrella and the single-channel specialization, not the multi one.
  const auto* lfo = registry.find("mod.source.lfo");
  REQUIRE(lfo != nullptr);
  const auto& caps = lfo->capabilities;
  auto has = [&](const char* s) {
    return std::find(caps.begin(), caps.end(), std::string(s)) != caps.end();
  };
  CHECK(has("modulation_source"));
  CHECK(has("modulation_source_single"));
  CHECK_FALSE(has("modulation_source_multi"));

  // A generator declares the standalone `generator` capability (now explicit,
  // no longer inferred from the "generator.*" category string alone).
  const auto* solid = registry.find("source.solid_color");
  REQUIRE(solid != nullptr);
  const auto& gcaps = solid->capabilities;
  CHECK(std::find(gcaps.begin(), gcaps.end(), std::string("generator")) != gcaps.end());

  // mod.shaper.remap (mod_remap lifecycle) → unary modulation shaper: declares the
  // umbrella shaper tag and the 1-in-1-out specialization, NOT the source tags.
  const auto* remap = registry.find("mod.shaper.remap");
  REQUIRE(remap != nullptr);
  const auto& rcaps = remap->capabilities;
  auto rhas = [&](const char* s) {
    return std::find(rcaps.begin(), rcaps.end(), std::string(s)) != rcaps.end();
  };
  CHECK(rhas("modulation_shaper"));
  CHECK(rhas("modulation_shaper_unary"));
  CHECK_FALSE(rhas("modulation_source"));

  // mod.shaper.smooth (mod_smooth lifecycle) → also a unary modulation shaper.
  const auto* smooth = registry.find("mod.shaper.smooth");
  REQUIRE(smooth != nullptr);
  const auto& scaps = smooth->capabilities;
  auto shas = [&](const char* s) {
    return std::find(scaps.begin(), scaps.end(), std::string(s)) != scaps.end();
  };
  CHECK(shas("modulation_shaper"));
  CHECK(shas("modulation_shaper_unary"));

  // mod.shaper.delay (mod_delay lifecycle) → also a unary modulation shaper.
  const auto* delay = registry.find("mod.shaper.delay");
  REQUIRE(delay != nullptr);
  const auto& dcaps = delay->capabilities;
  CHECK(std::find(dcaps.begin(), dcaps.end(), std::string("modulation_shaper")) != dcaps.end());
  CHECK(std::find(dcaps.begin(), dcaps.end(), std::string("modulation_shaper_unary")) != dcaps.end());

  // mod.shaper.envelope (mod_envelope lifecycle) → also a unary modulation shaper.
  const auto* envp = registry.find("mod.shaper.envelope");
  REQUIRE(envp != nullptr);
  const auto& ecaps = envp->capabilities;
  CHECK(std::find(ecaps.begin(), ecaps.end(), std::string("modulation_shaper")) != ecaps.end());
  CHECK(std::find(ecaps.begin(), ecaps.end(), std::string("modulation_shaper_unary")) != ecaps.end());

  // A plain stateless image effect declares its temporal contract
  // (time_independent) but NO generator/modulation capabilities.
  const auto* bc = registry.find("color.tone.brightness_contrast");
  REQUIRE(bc != nullptr);
  const auto& bcaps = bc->capabilities;
  auto bhas = [&](const char* s) {
    return std::find(bcaps.begin(), bcaps.end(), std::string(s)) != bcaps.end();
  };
  CHECK(bhas("time_independent"));
  CHECK_FALSE(bhas("generator"));
  CHECK_FALSE(bhas("modulation_source"));
  CHECK_FALSE(bhas("seekable_approximate"));
  CHECK_FALSE(bhas("seekable_prefill"));
}

// A trapping module_init must not poison the rest of the bundle. The native
// bundles path runs EVERY effect's module_init eagerly at registration, all in
// ONE shared wasm instance. If an effect traps mid-module_init (e.g. on an
// unlinked gpu import), WAMR does NOT restore the aux-stack pointer, so every
// effect registered AFTER it hits "out of bounds memory access" and silently
// publishes an EMPTY schema. testonly.wasm exercises this: debug.gpu_test (and
// the MRT debug effects) call bindings-explicit render-PSO factories that the
// bundles host must implement. With the full gpu PSO surface registered, every
// effect after gpu_test — including the high-index debug.particles_emitter /
// debug.particles_renderer — registers its schema intact.
//
// (The particles render path is now cross-platform: particles_renderer is
// HLSL→SPV shaded, so it renders on the native Metal backend too — covered by
// the "particles_emitter → particles_renderer" render test below, in addition
// to web/test/particles.test.ts.)
TEST_CASE("bundle registration survives a trapping module_init (full PSO surface)",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);

  // debug.spinningtris and the particles effects all register AFTER
  // debug.gpu_test; before the PSO-surface fix their schemas came back empty.
  auto requireSchema = [&](const char* mt) {
    const auto* m = registry.find(mt);
    INFO("module " << mt);
    REQUIRE(m != nullptr);
    REQUIRE(m->schemaFields.is_object());
    CHECK(!m->schemaFields.empty());
  };
  requireSchema("debug.spinningtris");
  requireSchema("debug.particles_emitter");
  requireSchema("debug.particles_renderer");

  // The emitter's particles_out struct must carry its GPU-buffer leaves — the
  // producer side of the struct buffer rail.
  const auto& emitFields = registry.find("debug.particles_emitter")->schemaFields;
  REQUIRE(emitFields.contains("particles_out"));
  const auto& outFields = emitFields["particles_out"].value("fields", nlohmann::json::object());
  REQUIRE(outFields.contains("positions"));
  CHECK(outFields["positions"].value("type", std::string()) == "array");
  CHECK(outFields["positions"].value("gpu", false) == true);
}

// Native pixel coverage for the GPU storage-buffer struct rail + the instanced
// render-PSO factory (create_instanced_render_pso_layout) + buffer_for_field.
// debug.particles_emitter publishes positions/velocities into GPU storage
// buffers exposed as a struct rail; debug.particles_renderer (now HLSL→SPV,
// no longer web-only) instances one quad per particle, reading positions[iid]
// from the bound buffer in its vertex shader and outputting the tint. We run
// enough frames for the emitter's CPU physics to lift particles into the frame,
// then assert tinted (≈255,178,51) pixels appear over the dark clear. This is
// the first NATIVE end-to-end exercise of the buffer rail — web covers it via
// particles.test.ts; the native Metal path had none (the renderer used inline
// WGSL, which the MSL-only backend couldn't compile).
TEST_CASE("particles_emitter → particles_renderer draws tinted particles (buffer rail)",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 64, H = 64; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  // Renderer's `particles_in` struct input auto-connects to the emitter's
  // `particles_out` (the GPU-buffer + scalar leaves flow over the struct rail).
  // `type:"module"` is required for the augmenter to auto-connect the struct
  // rail (particles_in ← particles_out); without it the chain entries are
  // skipped and no implicit taps are generated.
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "debug.particles_emitter",  "instance_key": "emit" },
      { "type": "module", "module_type": "debug.particles_renderer", "instance_key": "render" }
    ],
    "instances": {
      "render": { "module_type": "debug.particles_renderer",
                  "state": { "particle_size": 0.05, "tint": [1.0, 0.7, 0.2, 1.0] } }
    },
    "wires": []
  })JSON");

  // Run frames so the emitter's per-tick physics carries particles up from the
  // bottom spawn edge into the viewport (mirrors the web test's waitFrames=30).
  std::vector<uint8_t> px;
  for (int frame = 0; frame < 40; ++frame) {
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0,
                                   /*sketchDirty=*/frame == 0);
    backend->submit();
    if (frame == 39) px = backend->readbackTexture(out, W, H);
  }

  // Count tinted (≈255,178,51) pixels — same predicate as the web test.
  size_t tinted = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    int r = px[i], g = px[i + 1], b = px[i + 2];
    if (r > 120 && g > 60 && g < 220 && b < 120) ++tinted;
  }
  double coverage = double(tinted) / double(W * H);
  INFO("tinted coverage = " << coverage << " (" << tinted << " px)");
  CHECK(coverage >= 0.005);
}

// Native functional coverage for the bindings-explicit render-PSO factory
// (create_render_pso_layout). debug.gpu_test is SPV-shaded (cross-platform):
// its module_init builds a render PSO via createRenderPSO(..., Bindings()), and
// render() runs a compute pass that writes a fullscreen-quad vertex buffer, then
// rasterizes it. The compute shader fills R=0, G=0.5, B=1.0 → a uniform
// (0,128,255). This is the first NATIVE render through create_render_pso_layout
// — web exercises it via gpu-pipeline.test.ts / gpu-host.ts; the native Metal
// path had none (the effects calling these factories were assumed web-only).
TEST_CASE("debug.gpu_test renders a solid color via create_render_pso_layout",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 32, H = 32; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "debug.gpu_test", "instance_key": "g" } ],
    "instances": {}, "wires": []
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto px = backend->readbackTexture(out, W, H);

  // Center pixel should be the compute-generated solid (0, 128, 255).
  const size_t c = ((size_t)(H / 2) * W + (W / 2)) * 4;
  INFO("center rgba = " << (int)px[c] << "," << (int)px[c+1] << ","
                        << (int)px[c+2] << "," << (int)px[c+3]);
  CHECK(std::abs((int)px[c + 0] -   0) <= 4);
  CHECK(std::abs((int)px[c + 1] - 128) <= 6);
  CHECK(std::abs((int)px[c + 2] - 255) <= 4);
}

// Native pixel coverage for debug.spinningtris (compute generates a vertex
// buffer; a plain vertex-buffer render pass rasterizes it). It is SPV-shaded so
// it renders on the MSL-only native backend. Previously only its SCHEMA was
// covered ("bundle registration survives a trapping module_init") — an
// arrangement workspace then mistook a wrong/aspirational id ("generator."
// vs the actual "debug." prefix) for a native render regression. The id never
// resolved, so it "rendered nothing"; the effect itself is fine. This test
// pins the real render so that ambiguity can't recur: default state = 100
// triangles over a dark (0.05,0.05,0.08) clear, run a few frames so the time
// accumulator advances, and assert a healthy count of colored (non-clear)
// pixels appear.
TEST_CASE("debug.spinningtris rasterizes its triangles (native vertex-buffer render)",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 64, H = 64; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "debug.spinningtris", "instance_key": "g" } ],
    "instances": {}, "wires": []
  })JSON");
  int32_t out = 0;
  for (int f = 0; f < 5; f++) {
    out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, f == 0);
    backend->submit();
  }
  auto px = backend->readbackTexture(out, W, H);
  // Count pixels that differ from the dark clear (~13,13,20). 100 triangles
  // over a 64x64 frame cover a substantial fraction.
  int nonClear = 0;
  for (size_t i = 0; i < (size_t)W * H; i++) {
    int r = px[i*4], g = px[i*4+1], b = px[i*4+2];
    if (std::abs(r-13) > 20 || std::abs(g-13) > 20 || std::abs(b-20) > 20) nonClear++;
  }
  INFO("nonClear pixels = " << nonClear << " / " << (W*H));
  CHECK(nonClear > 100);
}

// Native functional coverage for the MRT factories (create_instanced_render_pso
// _mrt_layout + begin_render_pass_mrt). debug.mrt_test (SPV-shaded) renders a
// fullscreen triangle into TWO color attachments — (1,0,0,1) to target0 and
// (0,1,0,1) to target1 — then a combine compute merges (t0.r, t1.g, 0, 1). Both
// attachments written → uniform YELLOW (255,255,0); if MRT silently degraded to
// one attachment, target1 stays its black clear and the output is red. So this
// both exercises the MRT host ABI natively and verifies real MRT behavior on
// Metal (web covers it via platform-features.test.ts).
TEST_CASE("debug.mrt_test writes both MRT attachments (native yellow round-trip)",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 32, H = 32; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> black(W * H * 4, 0);
  black[3] = 255;  // (the input is unused; mrt_test is a generator)
  backend->writeTexture(inTex, W, H, black.data(), (uint32_t)black.size());

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "debug.mrt_test", "instance_key": "m" } ],
    "instances": {}, "wires": []
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto px = backend->readbackTexture(out, W, H);

  const size_t c = ((size_t)(H / 2) * W + (W / 2)) * 4;
  INFO("center rgba = " << (int)px[c] << "," << (int)px[c+1] << ","
                        << (int)px[c+2] << "," << (int)px[c+3] << " (yellow=MRT ok, red=degraded)");
  CHECK(std::abs((int)px[c + 0] - 255) <= 4);   // R from target0
  CHECK(std::abs((int)px[c + 1] - 255) <= 4);   // G from target1 — the MRT proof
  CHECK(std::abs((int)px[c + 2] -   0) <= 4);
}

// Native coverage for 3D textures (createTexture3D + storage-3D write +
// sampled-3D read). debug.lut3d_test (now HLSL→SPV, no longer web-guarded)
// fills a 16³ identity LUT (x/15, y/15, z/15) via a texture_storage_3d write,
// then nearest-cell looks it up via a sampled texture_3d. An identity LUT
// round-trips a uniform input within ~1 cell of quantization; midpoint colors
// round-trip exact, and the 0/1 endpoints are exact. This is the first NATIVE
// exercise of the Metal 3D-texture path (web covers it via
// platform-features.test.ts).
TEST_CASE("debug.lut3d_test round-trips colors through a native 3D LUT",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [ { "type": "module", "module_type": "debug.lut3d_test", "instance_key": "lut" } ],
    "instances": {}, "wires": []
  })JSON");

  // Run a uniform input color through the LUT and read back the center pixel.
  auto roundTrip = [&](uint8_t r, uint8_t g, uint8_t b) {
    std::vector<uint8_t> in(W * H * 4);
    for (size_t i = 0; i + 3 < in.size(); i += 4) {
      in[i] = r; in[i + 1] = g; in[i + 2] = b; in[i + 3] = 255;
    }
    backend->writeTexture(inTex, W, H, in.data(), (uint32_t)in.size());
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    auto px = backend->readbackTexture(out, W, H);
    const size_t c = ((size_t)(H / 2) * W + (W / 2)) * 4;
    INFO("in (" << (int)r << "," << (int)g << "," << (int)b << ") -> out ("
         << (int)px[c] << "," << (int)px[c+1] << "," << (int)px[c+2] << ")");
    return std::array<int,3>{ px[c], px[c+1], px[c+2] };
  };

  // Midpoint color (0.4,0.6,0.8) → cells (6,9,12) → (6/15,9/15,12/15)*255
  // ≈ (102,153,204). Identity LUT → near-exact round-trip.
  auto mid = roundTrip(102, 153, 204);
  CHECK(std::abs(mid[0] - 102) <= 3);
  CHECK(std::abs(mid[1] - 153) <= 3);
  CHECK(std::abs(mid[2] - 204) <= 3);

  // Endpoints are exact (0 → 0, 1 → 1).
  auto black = roundTrip(0, 0, 0);
  CHECK(black[0] <= 2); CHECK(black[1] <= 2); CHECK(black[2] <= 2);
  auto white = roundTrip(255, 255, 255);
  CHECK(white[0] >= 253); CHECK(white[1] >= 253); CHECK(white[2] >= 253);
}

// Native coverage for read-write storage textures (createTexture R32F bound
// read_write + an in-place RMW within one dispatch). debug.rw_storage_test (now
// HLSL→SPV, no longer web-guarded) writes 0.25 to an r32float scratch, reads it
// back, adds 0.5, reads again, and writes the 0.75 result to the rgba8 output —
// so a passing run requires the binding to honor BOTH reads and writes on the
// same r32float storage texture. 0.75 → round(0.75*255) = 191. First NATIVE
// exercise of the Metal read-write storage path (web: platform-features).
TEST_CASE("debug.rw_storage_test does an in-place r32f read-write RMW (native)",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [ { "type": "module", "module_type": "debug.rw_storage_test", "instance_key": "rw" } ],
    "instances": {}, "wires": []
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto px = backend->readbackTexture(out, W, H);

  // Every pixel should be the uniform RMW result 0.75 → ~191.
  const size_t c = ((size_t)(H / 2) * W + (W / 2)) * 4;
  INFO("center rgba = " << (int)px[c] << "," << (int)px[c+1] << ","
                        << (int)px[c+2] << "," << (int)px[c+3]);
  CHECK(std::abs((int)px[c + 0] - 191) <= 2);
  CHECK(std::abs((int)px[c + 1] - 191) <= 2);
  CHECK(std::abs((int)px[c + 2] - 191) <= 2);
}

// Trap reporting: debug.trap_test's module_init publishes a schema then
// deliberately traps. A trapped module_init can't be cleanly contained, so the
// host instead flags it (EffectInstance::moduleInitTrapped, surfaced on the
// registry) and logs loudly — turning what was a silent, hours-to-diagnose
// schema corruption into an obvious signal. trap_test is registered LAST so it
// poisons nothing; this asserts the flag fires for it and NOT for a normal
// effect, and that the real effects all registered intact.
TEST_CASE("a trapping module_init is detected and flagged, not silent",
          "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TESTONLY_WASM_PATH, registry, backend.get(), nullptr) > 0);

  // trap_test is flagged as trapped, and still published its pre-trap schema.
  const auto* trap = registry.find("debug.trap_test");
  REQUIRE(trap != nullptr);
  CHECK(trap->moduleInitTrapped);
  CHECK(!trap->schemaFields.empty());

  // A normal effect is NOT flagged and registered its schema. (Because trap_test
  // is last, nothing it could poison comes after it — the whole bundle is clean.)
  const auto* normal = registry.find("motion.blur");
  REQUIRE(normal != nullptr);
  CHECK_FALSE(normal->moduleInitTrapped);
  CHECK(!normal->schemaFields.empty());
}

// Debug counters (Debug Info panel). fillDebugStats writes 7 int32s:
// [effectsExecuted, standaloneDispatches, fusedRuns, fusedStages,
//  dispatchesSaved, gpuDispatches, identitySkipped]. Exercise the three paths a
// stage can take — fused, standalone, identity-skipped — and assert the derived
// arithmetic (gpuDispatches = standalone + fusedRuns; dispatchesSaved =
// fusedStages − fusedRuns) holds.
TEST_CASE("debug stats count fused / standalone / identity stages", "[effect_render]") {
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
  std::vector<uint8_t> gray(W * H * 4, 64);
  for (size_t i = 3; i < gray.size(); i += 4) gray[i] = 255;
  backend->writeTexture(inTex, W, H, gray.data(), (uint32_t)gray.size());

  auto run = [&](const nlohmann::json& sketch, int32_t out[7]) {
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, /*dirty=*/true);
    backend->submit();
    executor.fillDebugStats(out);
  };

  // Two non-identity brightness_contrast stages → fuse into ONE kernel.
  auto twoFused = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "color.tone.brightness_contrast", "instance_key": "a" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "b" }
    ],
    "instances": {
      "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.5, "contrast": 0.0 } },
      "b": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": -0.5, "contrast": 0.0 } }
    }
  })JSON");
  int32_t s[7];
  run(twoFused, s);
  INFO("fused stats: eff=" << s[0] << " std=" << s[1] << " fr=" << s[2]
       << " fs=" << s[3] << " saved=" << s[4] << " gpu=" << s[5] << " id=" << s[6]);
  REQUIRE(executor.fusedRunCount() == 1);   // confirms they actually fused
  CHECK(s[0] == 2);                          // effectsExecuted
  CHECK(s[1] == 0);                          // standaloneDispatches
  CHECK(s[2] == 1);                          // fusedRuns
  CHECK(s[3] == 2);                          // fusedStages
  CHECK(s[4] == 1);                          // dispatchesSaved = 2 − 1
  CHECK(s[5] == 1);                          // gpuDispatches  = 0 + 1
  CHECK(s[6] == 0);                          // identitySkipped

  // Single non-identity stage → one standalone dispatch (no fusion of size 1).
  auto one = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "a" } ],
    "instances": { "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.5, "contrast": 0.0 } } }
  })JSON");
  run(one, s);
  CHECK(s[0] == 1);  // effectsExecuted
  CHECK(s[1] == 1);  // standaloneDispatches
  CHECK(s[2] == 0);  // fusedRuns
  CHECK(s[5] == 1);  // gpuDispatches
  CHECK(s[6] == 0);  // identitySkipped

  // Single NEUTRAL brightness_contrast (0/0) → identity → skipped, no dispatch.
  auto ident = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "a" } ],
    "instances": { "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.0, "contrast": 0.0 } } }
  })JSON");
  run(ident, s);
  CHECK(s[0] == 1);  // effectsExecuted (still processed)
  CHECK(s[1] == 0);  // standaloneDispatches
  CHECK(s[5] == 0);  // gpuDispatches — nothing hit the GPU
  CHECK(s[6] == 1);  // identitySkipped

  // A non-Normal __blend__ splits an otherwise-fusable pair: the moded stage
  // goes standalone and wet/dry-blends against the MATERIALIZED upstream
  // output. Golden: both stages brighten, second at Darken → min(stage1,
  // brighter(stage1)) = stage1, so the pair must render exactly like stage 1
  // alone.
  auto refOne = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "a" } ],
    "instances": { "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.3, "contrast": 0.0 } } }
  })JSON");
  run(refOne, s);
  auto refPx = backend->readbackTexture(outTex, W, H);
  const double refMean = mean_rgb(refPx);

  auto darkenPair = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "color.tone.brightness_contrast", "instance_key": "a" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "b" }
    ],
    "instances": {
      "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.3, "contrast": 0.0 } },
      "b": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.3, "contrast": 0.0, "__blend__": 5 } }
    }
  })JSON");
  run(darkenPair, s);
  auto pairPx = backend->readbackTexture(outTex, W, H);
  INFO("darken-pair stats: eff=" << s[0] << " std=" << s[1] << " fr=" << s[2]
       << " gpu=" << s[5] << "  ref mean " << refMean
       << " pair mean " << mean_rgb(pairPx));
  CHECK(s[2] == 0);  // fusedRuns — the mode split the group
  CHECK(s[1] == 2);  // both stages standalone
  // Pixel golden: Darken against the materialized dry == stage-1-only output.
  CHECK(std::abs(mean_rgb(pairPx) - refMean) < 2.0);
}

// REPRO (#alpha): "when the first generator has alpha in (0,1), effects after
// don't render / output is transparent". Drives a fractional-alpha texture into
// a fusion-eligible chain and asserts the downstream effects still transform the
// RGB exactly as they do for an opaque input — i.e. the executor does NOT gate
// rendering on alpha. If this passes, the breakage is in compositing/display,
// not the executor.
TEST_CASE("fractional input alpha does not break downstream rendering", "[effect_render][alpha]") {
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

  // Two non-identity brightness stages → they fuse (no self-cancellation).
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "color.tone.brightness_contrast", "instance_key": "a" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "b" }
    ],
    "instances": {
      "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.4, "contrast": 0.0 } },
      "b": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.4, "contrast": 0.0 } }
    }
  })JSON");

  auto runWithAlpha = [&](uint8_t alpha, double& rgbMean, double& aMean) {
    std::vector<uint8_t> px(W * H * 4, 64);          // RGB = 64
    for (size_t i = 3; i < px.size(); i += 4) px[i] = alpha;
    backend->writeTexture(inTex, W, H, px.data(), (uint32_t)px.size());
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    rgbMean = mean_rgb(o);
    long s = 0, n = 0;
    for (size_t i = 3; i < o.size(); i += 4) { s += o[i]; ++n; }
    aMean = n ? (double)s / n : 0.0;
  };

  double rgbOpaque = 0, aOpaque = 0, rgbFrac = 0, aFrac = 0;
  runWithAlpha(255, rgbOpaque, aOpaque);
  runWithAlpha(96,  rgbFrac,   aFrac);

  INFO("[texture alpha] opaque: rgb " << rgbOpaque << " a " << aOpaque
       << "  | fractional(96): rgb " << rgbFrac << " a " << aFrac);
  // The chain actually did something (RGB moved well off the input's 64).
  CHECK(std::abs(rgbOpaque - 64.0) > 20.0);
  // Downstream RGB is identical whether the input was opaque or not — the
  // executor does NOT gate rendering on alpha — and the alpha is preserved.
  CHECK(std::abs(rgbFrac - rgbOpaque) < 2.0);
  CHECK(std::abs(aOpaque - 255.0) < 2.0);
  CHECK(std::abs(aFrac - 96.0) < 2.0);

  // ---- Now the __opacity__ partial path: first stage at opacity 0.5, then a
  // second effect. Does the SECOND effect still render on the result? ----
  auto partialFirst = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "color.tone.brightness_contrast", "instance_key": "a" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "b" }
    ],
    "instances": {
      "a": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.8, "contrast": 0.0, "__opacity__": 0.5 } },
      "b": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.8, "contrast": 0.0 } }
    }
  })JSON");
  {
    std::vector<uint8_t> px(W * H * 4, 64);
    for (size_t i = 3; i < px.size(); i += 4) px[i] = 255;
    backend->writeTexture(inTex, W, H, px.data(), (uint32_t)px.size());
    int32_t out = executor.execute(partialFirst, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    int32_t s7[7]; executor.fillDebugStats(s7);
    double m = mean_rgb(backend->readbackTexture(out, W, H));
    INFO("[__opacity__ first=0.5] out rgb " << m << "  stats eff=" << s7[0]
         << " std=" << s7[1] << " fr=" << s7[2] << " gpu=" << s7[5]);
    // The downstream (second) brightness must still lift the result clearly
    // above the input — i.e. effects after a partial-opacity stage DO render.
    CHECK(m > 64.0 + 10.0);
  }

  // ---- The literal scenario: a GENERATOR first (strict output, no upstream
  // input → inputHandle = -1), then a downstream effect. solid_color writes a
  // known color; brightness must then transform it. ----
  auto genFirst = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "g" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "e" }
    ],
    "instances": {
      "g": { "module_type": "source.solid_color", "state": { "color": [0.25, 0.25, 0.25] } },
      "e": { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.6, "contrast": 0.0 } }
    }
  })JSON");
  {
    // NO upstream input — pass -1, the way a top-of-deck sketch runs.
    int32_t out = executor.execute(genFirst, -1, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    int32_t s7[7]; executor.fillDebugStats(s7);
    auto o = backend->readbackTexture(out, W, H);
    double m = mean_rgb(o);
    long sa = 0, na = 0; for (size_t i = 3; i < o.size(); i += 4) { sa += o[i]; ++na; }
    double a = na ? (double)sa / na : 0.0;
    INFO("[generator first, no input] out rgb " << m << " a " << a
         << "  stats eff=" << s7[0] << " std=" << s7[1] << " fr=" << s7[2] << " gpu=" << s7[5]);
    // The generator's 0.25 grey (~64) lifted by brightness 0.8 → well above it,
    // and fully opaque. Downstream effect rendered on the generator's output.
    CHECK(m > 64.0 + 10.0);
    CHECK(a > 250.0);
  }
}

// REPRO (#stuck): two source.solid_color in series; the FIRST has partial
// effect opacity (__opacity__ = 0.9). Changing the SECOND's color must update
// the output every frame — the user reports it freezes at the last frame.
TEST_CASE("partial-opacity first stage does not freeze downstream output", "[effect_render][alpha]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16; const int RGBA8 = 1;
  int outTex = backend->createTexture(W, H, RGBA8);

  auto frame = [&](double secondBlue, double firstOpacity) {
    char buf[640];
    std::snprintf(buf, sizeof(buf), R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "g1" },
        { "module_type": "source.solid_color", "instance_key": "g2" }
      ],
      "instances": {
        "g1": { "module_type": "source.solid_color", "state": { "color": [0.2, 0.2, 0.2], "__opacity__": %.3f } },
        "g2": { "module_type": "source.solid_color", "state": { "color": [0.0, 0.0, %.3f] } }
      }
    })JSON", firstOpacity, secondBlue);
    auto sk = nlohmann::json::parse(buf);
    int32_t out = executor.execute(sk, -1, outTex, (int)W, (int)H, 1.0/60.0, /*dirty=*/true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    long s = 0, n = 0; for (size_t i = 2; i < o.size(); i += 4) { s += o[i]; ++n; }  // mean BLUE
    return n ? (double)s / n : 0.0;
  };

  // Control: first stage fully opaque → changing g2's blue clearly moves output.
  double ctlLo = frame(0.2, 1.0);
  double ctlHi = frame(0.9, 1.0);
  INFO("control (op=1.0): blue lo " << ctlLo << "  hi " << ctlHi);
  CHECK(ctlHi - ctlLo > 100.0);

  // Bug case: first stage at opacity 0.9 → changing g2's blue must STILL move it.
  double lo = frame(0.2, 0.9);
  double hi = frame(0.9, 0.9);
  INFO("partial (op=0.9): blue lo " << lo << "  hi " << hi);
  CHECK(hi - lo > 100.0);
}

// REPRO: per-effect __opacity__ endpoints blend wrong in native mode.
// User report: 1.0 correct; 0.99 shows a DARKENED current output; 0.01 mostly
// previous; 0.0 breaks the chain input. The blend contract is
// out = mix(prev, fx, opacity) per channel, so 0.99 must be ~identical to 1.0
// and 0.0 must be exactly the previous stage's output.
TEST_CASE("per-effect opacity endpoints follow mix(prev, fx, opacity)",
          "[effect_render][alpha]") {
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

  // Two generators: g1 solid RED, g2 solid BLUE at swept opacity.
  // Expected out = mix(red, blue, op).
  auto frame = [&](double op, double rgba[4]) {
    char buf[640];
    std::snprintf(buf, sizeof(buf), R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "g1" },
        { "module_type": "source.solid_color", "instance_key": "g2" }
      ],
      "instances": {
        "g1": { "module_type": "source.solid_color", "state": { "color": [1.0, 0.0, 0.0] } },
        "g2": { "module_type": "source.solid_color", "state": { "color": [0.0, 0.0, 1.0], "__opacity__": %.4f } }
      }
    })JSON", op);
    auto sk = nlohmann::json::parse(buf);
    int32_t out = executor.execute(sk, -1, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    for (int c = 0; c < 4; ++c) {
      long s = 0, n = 0;
      for (size_t i = c; i < o.size(); i += 4) { s += o[i]; ++n; }
      rgba[c] = n ? (double)s / n : 0.0;
    }
    return out;
  };

  double full[4], near1[4], half[4], near0[4], zero[4];
  frame(1.0,  full);
  frame(0.99, near1);
  frame(0.5,  half);
  frame(0.01, near0);
  frame(0.0,  zero);
  INFO("op=1.0  rgba " << full[0]  << "," << full[1]  << "," << full[2]  << "," << full[3]);
  INFO("op=0.99 rgba " << near1[0] << "," << near1[1] << "," << near1[2] << "," << near1[3]);
  INFO("op=0.5  rgba " << half[0]  << "," << half[1]  << "," << half[2]  << "," << half[3]);
  INFO("op=0.01 rgba " << near0[0] << "," << near0[1] << "," << near0[2] << "," << near0[3]);
  INFO("op=0.0  rgba " << zero[0]  << "," << zero[1]  << "," << zero[2]  << "," << zero[3]);

  // 1.0 → pure blue.
  CHECK(full[2] > 250.0); CHECK(full[0] < 5.0); CHECK(full[3] > 250.0);
  // 0.99 → indistinguishable from 1.0 (the reported bug: it darkens).
  CHECK(std::abs(near1[2] - full[2]) < 8.0);
  CHECK(near1[3] > 250.0);
  // 0.5 → true midpoint of red/blue, alpha stays opaque.
  CHECK(std::abs(half[0] - 127.5) < 8.0);
  CHECK(std::abs(half[2] - 127.5) < 8.0);
  CHECK(half[3] > 250.0);
  // 0.01 → almost pure red.
  CHECK(near0[0] > 245.0); CHECK(near0[2] < 10.0);
  // 0.0 → exactly the previous stage (red), chain intact.
  CHECK(zero[0] > 250.0); CHECK(zero[2] < 5.0); CHECK(zero[3] > 250.0);

  // REGRESSION (the actual user bug): TWO wet/dry blends in ONE frame. The
  // frame is a single command buffer and gpu_write_buffer writes immediately,
  // so a shared uniform buffer makes EVERY blend dispatch read the LAST
  // opacity written. Chain: red @0.5 then blue @0.25 (no input).
  //   correct: stage1 = mix(black, red, 0.5) = (128,0,0)
  //            stage2 = mix(stage1, blue, 0.25) = (96,0,64)
  //   bug:     both blends read 0.25 → (48,0,64)
  {
    auto sk = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "g1" },
        { "module_type": "source.solid_color", "instance_key": "g2" }
      ],
      "instances": {
        "g1": { "module_type": "source.solid_color", "state": { "color": [1.0, 0.0, 0.0], "__opacity__": 0.5 } },
        "g2": { "module_type": "source.solid_color", "state": { "color": [0.0, 0.0, 1.0], "__opacity__": 0.25 } }
      }
    })JSON");
    double rgba[4];
    int32_t out = executor.execute(sk, -1, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    for (int c = 0; c < 4; ++c) {
      long s = 0, n = 0;
      for (size_t i = c; i < o.size(); i += 4) { s += o[i]; ++n; }
      rgba[c] = n ? (double)s / n : 0.0;
    }
    INFO("two-blend frame (0.5 then 0.25): rgba "
         << rgba[0] << "," << rgba[1] << "," << rgba[2] << "," << rgba[3]);
    CHECK(std::abs(rgba[0] - 95.6) < 6.0);   // 0.75 * 127.5
    CHECK(std::abs(rgba[2] - 63.75) < 6.0);  // 0.25 * 255
  }

  // REGRESSION companion: partial stage followed by an opacity-0 passthrough
  // FINAL stage. The passthrough's copyToOutput is itself a blend encode at
  // opacity 1.0 — with the shared-uniform bug it forced the earlier partial
  // stage to full strength ("opacity 0 changes the sketch").
  {
    auto sk = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "g1" },
        { "module_type": "source.solid_color", "instance_key": "g2" }
      ],
      "instances": {
        "g1": { "module_type": "source.solid_color", "state": { "color": [1.0, 0.0, 0.0], "__opacity__": 0.5 } },
        "g2": { "module_type": "source.solid_color", "state": { "color": [0.0, 0.0, 1.0], "__opacity__": 0.0 } }
      }
    })JSON");
    double rgba[4];
    int32_t out = executor.execute(sk, -1, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    for (int c = 0; c < 4; ++c) {
      long s = 0, n = 0;
      for (size_t i = c; i < o.size(); i += 4) { s += o[i]; ++n; }
      rgba[c] = n ? (double)s / n : 0.0;
    }
    INFO("partial then passthrough-final (0.5 then 0.0): rgba "
         << rgba[0] << "," << rgba[1] << "," << rgba[2] << "," << rgba[3]);
    // Expected: half-red (128,0,0) — g1's 0.5 blend must NOT become 1.0.
    CHECK(std::abs(rgba[0] - 127.5) < 6.0);
    CHECK(rgba[2] < 5.0);
  }

  // -- Per-effect blend modes (__blend__, the composite.blend enum) --
  // red base, blue top: Add@1.0 → magenta; Multiply@1.0 → black;
  // Add@0.5 → source-over at half coverage = (255,0,128).
  {
    auto blendFrame = [&](int mode, double op, double rgba[4]) {
      char buf[720];
      std::snprintf(buf, sizeof(buf), R"JSON({
        "chain": [
          { "module_type": "source.solid_color", "instance_key": "g1" },
          { "module_type": "source.solid_color", "instance_key": "g2" }
        ],
        "instances": {
          "g1": { "module_type": "source.solid_color", "state": { "color": [1.0, 0.0, 0.0] } },
          "g2": { "module_type": "source.solid_color", "state": { "color": [0.0, 0.0, 1.0], "__opacity__": %.3f, "__blend__": %d } }
        }
      })JSON", op, mode);
      auto sk = nlohmann::json::parse(buf);
      int32_t out = executor.execute(sk, -1, outTex, (int)W, (int)H, 1.0/60.0, true);
      backend->submit();
      auto o = backend->readbackTexture(out, W, H);
      for (int c = 0; c < 4; ++c) {
        long s = 0, n = 0;
        for (size_t i = c; i < o.size(); i += 4) { s += o[i]; ++n; }
        rgba[c] = n ? (double)s / n : 0.0;
      }
    };
    double add1[4], mul1[4], addHalf[4];
    blendFrame(/*Add*/ 1, 1.0, add1);
    blendFrame(/*Multiply*/ 2, 1.0, mul1);
    blendFrame(/*Add*/ 1, 0.5, addHalf);
    INFO("Add@1.0 rgba " << add1[0] << "," << add1[1] << "," << add1[2] << "," << add1[3]);
    INFO("Mul@1.0 rgba " << mul1[0] << "," << mul1[1] << "," << mul1[2] << "," << mul1[3]);
    INFO("Add@0.5 rgba " << addHalf[0] << "," << addHalf[1] << "," << addHalf[2] << "," << addHalf[3]);
    // Add at full opacity: red + blue = magenta (mode runs even at opacity 1).
    CHECK(add1[0] > 250.0); CHECK(add1[2] > 250.0); CHECK(add1[1] < 5.0);
    CHECK(add1[3] > 250.0);
    // Multiply at full opacity: red × blue = black.
    CHECK(mul1[0] < 5.0); CHECK(mul1[2] < 5.0); CHECK(mul1[3] > 250.0);
    // Add at half opacity: source-over half coverage of the blended magenta
    // over the red base → (255, 0, 128).
    CHECK(addHalf[0] > 250.0);
    CHECK(std::abs(addHalf[2] - 127.5) < 6.0);
  }

  // Blend mode must defeat the identity skip: an identity effect at Multiply
  // squares the image (duplicate-layer trick) instead of aliasing through.
  {
    std::vector<uint8_t> px(W * H * 4);
    for (size_t i = 0; i < px.size(); i += 4) {
      px[i] = 128; px[i+1] = 128; px[i+2] = 128; px[i+3] = 255;
    }
    backend->writeTexture(inTex, W, H, px.data(), (uint32_t)px.size());
    auto sk = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "color.tone.brightness_contrast", "instance_key": "e" }
      ],
      "instances": {
        "e": { "module_type": "color.tone.brightness_contrast",
               "state": { "brightness": 0.0, "contrast": 0.0, "__blend__": 2 } }
      }
    })JSON");
    int32_t out = executor.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    double m = mean_rgb(o);
    INFO("identity + Multiply: mean rgb " << m << " (0.5^2 = 0.25 -> ~64; alias bug -> 128)");
    CHECK(std::abs(m - 64.0) < 6.0);
  }

  // Single-effect chain over a REAL input at opacity 0: the sketch must pass
  // its input through (out == input), not lose it.
  {
    std::vector<uint8_t> px(W * H * 4);
    for (size_t i = 0; i < px.size(); i += 4) {
      px[i] = 10; px[i+1] = 200; px[i+2] = 30; px[i+3] = 255;  // green-ish
    }
    backend->writeTexture(inTex, W, H, px.data(), (uint32_t)px.size());
    auto sk = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "color.tone.brightness_contrast", "instance_key": "e" }
      ],
      "instances": {
        "e": { "module_type": "color.tone.brightness_contrast",
               "state": { "brightness": 0.9, "contrast": 0.0, "__opacity__": 0.0 } }
      }
    })JSON");
    int32_t out = executor.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    auto o = backend->readbackTexture(out, W, H);
    double g = 0; long n = 0;
    for (size_t i = 1; i < o.size(); i += 4) { g += o[i]; ++n; }
    g /= (double)n;
    INFO("single-effect op=0: out handle " << out << " (in " << inTex
         << ", outTex " << outTex << "), mean green " << g);
    // Whatever handle comes back, its contents must be the untouched input.
    CHECK(std::abs(g - 200.0) < 3.0);
  }
}

#ifdef TEXT_WASM_PATH
// Text-effect migration (step #4): source.text.plain loads from text.wasm — the same
// bundle path as every other effect — instead of being statically linked. Its
// text.* imports (layout/measure/render/atlas/glyphs/release) must resolve to
// the native TextEngine through the "text" WAMR namespace registered by
// WasmEffectBundles::init → registerTextHostFunctions. This is the only test
// that drives text.wasm on native; without the bridge the imports are unresolved
// and the bundle fails to instantiate (or renders blank).
//
// Mirrors text_effect_smoke.mm's executor-overlay case but through the WASM
// bundle: render "Hello" over a solid-red input via tex_in/tex_out, assert the
// text texels brighten the output AND the red background shows through behind it.
TEST_CASE("text.wasm renders source.text.plain via the native text bridge", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  // Fonts are a HOST concern (the text.* service owns the TextEngine); install
  // the system UI font + CJK fallbacks before rendering — null primary path.
  effect_runtime::textInstallDefaultFonts(nullptr);

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());  // also registers the "text" WAMR namespace
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(TEXT_WASM_PATH, registry, backend.get(), nullptr) >= 1);

  EffectInstance* inst = rt.instanceFor("source.text.plain", "k0");
  REQUIRE(inst != nullptr);

  const uint32_t W = 256, H = 128; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);

  inst->setParamJson("text", "\"Hello\"");
  inst->setTextureField("tex_in", inTex);
  inst->setTextureField("tex_out", outTex);
  inst->setFieldConnected("tex_in",  /*input*/true,  /*output*/false);
  inst->setFieldConnected("tex_out", /*input*/false, /*output*/true);

  backend->clearTexture(inTex, 1, 0, 0, 1);   // red background
  backend->clearTexture(outTex, 0, 0, 0, 1);
  backend->submit();
  inst->doRender(W, H);
  auto px = backend->readbackTexture(outTex, W, H);
  REQUIRE(px.size() == W * H * 4);

  // Glyph texels: bright on all channels (text is white over red). Count them.
  long glyph = 0, redBg = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) ++glyph;
    else if (px[i] > 200 && px[i + 1] < 60 && px[i + 2] < 60) ++redBg;
  }
  INFO("glyph(white) px " << glyph << "  redBg px " << redBg);
  CHECK(glyph > 50);                  // real glyph coverage drawn
  CHECK(redBg > W * H / 2);           // input background composited through

  // Second phase (#text-alpha), SAME backend + instance: disconnect tex_in.
  // source.text.plain/richtext are generators, so with no input they must leave
  // TRANSPARENCY between glyphs rather than paint opaque black. Folded into this
  // test (not a separate TEST_CASE) on purpose: the text engine's GPU resources
  // are a process-global singleton bound to the FIRST backend, so a second
  // backend in another case would render against stale handles.
  inst->setTextureField("tex_in", -1);
  inst->setFieldConnected("tex_in", /*input*/false, /*output*/false);
  backend->clearTexture(outTex, 0, 0, 1, 1);   // opaque blue → a transparent clear is provable
  backend->submit();
  inst->doRender(W, H);
  auto px2 = backend->readbackTexture(outTex, W, H);
  REQUIRE(px2.size() == W * H * 4);
  long glyph2 = 0, transparent = 0;
  for (size_t i = 0; i + 3 < px2.size(); i += 4) {
    const uint8_t a = px2[i + 3];
    if (a < 16) ++transparent;                                      // see-through
    if (a > 200 && px2[i] > 150 && px2[i+1] > 150 && px2[i+2] > 150) ++glyph2;  // opaque white glyph
  }
  INFO("no-input: glyph " << glyph2 << "  transparent " << transparent << " / " << (W * H));
  CHECK(glyph2 > 50);                 // glyphs still drawn (opaque)
  CHECK(transparent > W * H / 2);     // mostly TRANSPARENT, not opaque black
}
#endif  // TEXT_WASM_PATH

// triangulate — the topology-following GPU triangulation effect (nano bundle).
// Validates the P2 pipeline end-to-end on Metal: downsample→blur→feature (via
// the Density debug view — a left-bright/right-dark input must read brighter on
// the left) and the JFA Voronoi partition (via the Voronoi debug view — the
// random per-cell colouring must produce high spatial variance, which is only
// possible if the seed pool splatted and the jump-flood propagated).
#ifdef NANO_WASM_PATH
static double stddev_luma(const std::vector<uint8_t>& px) {
  double m = mean_rgb(px), s = 0; long n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    double l = (px[i] + px[i + 1] + px[i + 2]) / 3.0;
    s += (l - m / 3.0) * (l - m / 3.0); ++n;   // mean_rgb averages 3 channels
  }
  return n ? std::sqrt(s / n) : 0.0;
}

TEST_CASE("WASM GPU effect renders topology triangulation (triangulate)", "[effect_render]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  auto bytecode = load_file(NANO_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);
  host.set_gpu_backend(id, backend.get());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id))
    if (e.id == "filter.mesh.triangulate") { w = &e; break; }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(registry.registerWasmEffect("filter.mesh.triangulate", "Triangulate", &host, id, *w));
  EffectInstance* inst = rt.instanceFor("filter.mesh.triangulate", "k0");
  REQUIRE(inst != nullptr);

  const uint32_t W = 128, H = 128;
  const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);

  // Left half bright, right half dark.
  std::vector<uint8_t> inPixels(W * H * 4, 0);
  for (uint32_t y = 0; y < H; ++y)
    for (uint32_t x = 0; x < W; ++x) {
      size_t i = (y * W + x) * 4;
      uint8_t v = (x < W / 2) ? 210 : 25;
      inPixels[i] = inPixels[i + 1] = inPixels[i + 2] = v; inPixels[i + 3] = 255;
    }
  backend->writeTexture(inTex, W, H, inPixels.data(), (uint32_t)inPixels.size());
  inst->setTextureField("tex_in", inTex);
  inst->setTextureField("tex_out", outTex);
  inst->setParamFloat("density", 0.4f);
  inst->setParamFloat("feature_scale", 0.35f);

  auto halves = [&](const std::vector<uint8_t>& px, double& left, double& right) {
    double sl = 0, sr = 0; long nl = 0, nr = 0;
    for (uint32_t y = 0; y < H; ++y)
      for (uint32_t x = 0; x < W; ++x) {
        size_t i = (y * W + x) * 4;
        double l = (px[i] + px[i + 1] + px[i + 2]) / 3.0;
        if (x < W / 2) { sl += l; ++nl; } else { sr += l; ++nr; }
      }
    left = nl ? sl / nl : 0; right = nr ? sr / nr : 0;
  };

  // A. Density debug view → left (bright input) reads brighter than right.
  inst->setParamFloat("debug_view", 1.0f);
  inst->doRender(W, H);
  inst->doRender(W, H);
  auto density = backend->readbackTexture(outTex, W, H);
  REQUIRE(density.size() == W * H * 4);
  double dl = 0, dr = 0; halves(density, dl, dr);
  INFO("density view: left " << dl << "  right " << dr);
  CHECK(dl > dr + 20.0);

  // B. Voronoi debug view → random per-cell colours → high spatial variance.
  inst->setParamFloat("debug_view", 5.0f);
  inst->doRender(W, H);
  auto voronoi = backend->readbackTexture(outTex, W, H);
  double sd = stddev_luma(voronoi);
  INFO("voronoi view stddev " << sd);
  CHECK(sd > 20.0);

  // C. Mesh output (debug off, dark backdrop, white edges): the Delaunay edges
  // must rasterize as lit pixels over the black background — validates edge
  // extraction + the instanced line render pass over the compute backdrop.
  inst->setParamFloat("debug_view", 0.0f);
  inst->setParamFloat("bg_mode", 1.0f);     // dark
  inst->setParamFloat("density", 0.05f);    // sparse enough for gaps on a 128px canvas
  inst->setParamFloat("line_width", 0.0f);  // thin (~1px) lines
  inst->setParamArray("line_color", {1.0f, 1.0f, 1.0f});
  inst->doRender(W, H);
  inst->doRender(W, H);
  auto mesh = backend->readbackTexture(outTex, W, H);
  long lit = 0, dark = 0;
  for (size_t i = 0; i + 3 < mesh.size(); i += 4) {
    double l = (mesh[i] + mesh[i + 1] + mesh[i + 2]) / 3.0;
    if (l > 60.0) ++lit; else ++dark;
  }
  INFO("mesh: lit " << lit << "  dark " << dark << " / " << (W * H));
  CHECK(lit > 40);                          // edges drawn (mesh rasterizes)
  CHECK(dark > (long)(W * H) / 10);         // structured wireframe, not a full-screen fill

  host.shutdown();
}
#endif  // NANO_WASM_PATH

// ---------------------------------------------------------------------------
// Sidechannel bus — cross-executor texture channels (sidechannel_bus.h).
//
// Two SketchExecutors sharing ONE runtime + backend is exactly the barrel
// topology (one dylib, one Metal device, N per-instance executors). Executor A
// runs util.sidechannel_out; executor B runs util.sidechannel_in on the same
// channel. Covers: unwritten → transparent; A-then-B same-frame crossover;
// B-before-A one-frame latency; writer bypassed/stopped → black after at most
// one held frame; custom TEXT channel + size-mismatched reader (scaled blit);
// same-executor writer-below-reader feedback staying fresh (the >= rule).
#include "sketch/sidechannel_bus.h"

TEST_CASE("sidechannel bus passes textures across executors", "[effect_render][sidechannel]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) {
    SKIP("No Metal device available");
  }

  sidechannel_bus::resetForTest();  // process-global — scrub prior state

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor A(&rt, &registry, backend.get());
  A.setKeyNamespace("A/");
  A.setBusTag("writerA");
  sketch_executor::SketchExecutor B(&rt, &registry, backend.get());
  B.setKeyNamespace("B/");
  B.setBusTag("readerB");

  const uint32_t W = 32, H = 32;
  const int RGBA8 = 1;
  int inA = backend->createTexture(W, H, RGBA8);
  int outA = backend->createTexture(W, H, RGBA8);
  int inB = backend->createTexture(W, H, RGBA8);
  int outB = backend->createTexture(W, H, RGBA8);
  REQUIRE(inA >= 0); REQUIRE(outA >= 0); REQUIRE(inB >= 0); REQUIRE(outB >= 0);

  // A's content is a solid mid-red; B's own chain input is solid white — any
  // white in B's output would mean the reader failed to REPLACE its input.
  auto writeSolid = [&](int tex, uint8_t r, uint8_t g, uint8_t b) {
    std::vector<uint8_t> px(W * H * 4);
    for (size_t i = 0; i < px.size(); i += 4) {
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
    backend->writeTexture(tex, W, H, px.data(), (uint32_t)px.size());
  };
  writeSolid(inA, 200, 40, 40);
  writeSolid(inB, 255, 255, 255);

  auto meanCh = [&](int tex, uint32_t w, uint32_t h, int c) {
    auto px = backend->readbackTexture(tex, w, h);
    REQUIRE(px.size() == (size_t)w * h * 4);
    long sum = 0; long n = 0;
    for (size_t i = 0; i + 3 < px.size(); i += 4) { sum += px[i + (size_t)c]; ++n; }
    return n ? (double)sum / n : 0.0;
  };

  auto sketchA = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "util.sidechannel_out", "instance_key": "so" } ],
    "instances": {
      "so": { "module_type": "util.sidechannel_out", "state": { "channel": 3 } }
    }
  })JSON");
  auto sketchB = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "util.sidechannel_in", "instance_key": "si" } ],
    "instances": {
      "si": { "module_type": "util.sidechannel_in", "state": { "channel": 3 } }
    }
  })JSON");

  auto runA = [&](bool dirty) {
    int32_t out = A.execute(sketchA, inA, outA, (int)W, (int)H, 1.0 / 60.0, dirty);
    backend->submit();
    return out;
  };
  auto runB = [&](bool dirty) {
    int32_t out = B.execute(sketchB, inB, outB, (int)W, (int)H, 1.0 / 60.0, dirty);
    backend->submit();
    return out;
  };

  // 1) Reader before ANY write: transparent black (unplugged cable).
  int32_t bOut = runB(true);
  CHECK(meanCh(bOut, W, H, 0) < 4.0);
  CHECK(meanCh(bOut, W, H, 3) < 4.0);  // alpha too — transparent, not opaque black

  // 2) A then B: same-frame crossover; B's output IS A's input (REPLACE — no
  //    white from B's own chain input). A's own chain passes through untouched.
  int32_t aOut = runA(true);
  bOut = runB(false);
  CHECK(std::abs(meanCh(aOut, W, H, 0) - 200.0) < 6.0);   // A passthrough intact
  CHECK(std::abs(meanCh(bOut, W, H, 0) - 200.0) < 6.0);   // red arrived
  CHECK(std::abs(meanCh(bOut, W, H, 1) - 40.0) < 6.0);
  CHECK(meanCh(bOut, W, H, 3) > 250.0);                   // opaque

  // 3) Steady B-BEFORE-A alternation: each B frame sees the previous frame's
  //    A write (1-frame latency), never black. The very first B after the
  //    order flip is legitimately stale (nothing was written since its own
  //    last render — a stopped writer and a not-yet-run writer look alike),
  //    so assertions start at the second alternation.
  for (int f = 0; f < 3; ++f) {
    bOut = runB(false);
    runA(false);
    if (f >= 1) CHECK(std::abs(meanCh(bOut, W, H, 0) - 200.0) < 6.0);
  }

  // 4) Writer BYPASSED: no publish. B holds at most one more frame (its
  //    prevSeq still predates A's last live write), then goes black.
  sketchA["instances"]["so"]["state"]["__bypass__"] = 1;
  runA(true);
  runB(false);                       // ≤1 held frame allowed here
  runA(false);
  bOut = runB(false);                // by now the channel must read stale
  CHECK(meanCh(bOut, W, H, 0) < 4.0);
  CHECK(meanCh(bOut, W, H, 3) < 4.0);
  sketchA["instances"]["so"]["state"].erase("__bypass__");

  // 5) Writer STOPPED entirely (A no longer executes): same decay to black.
  runA(true);
  bOut = runB(false);
  CHECK(std::abs(meanCh(bOut, W, H, 0) - 200.0) < 6.0);   // alive again first
  bOut = runB(false);
  bOut = runB(false);
  CHECK(meanCh(bOut, W, H, 0) < 4.0);

  // 6) Custom TEXT channel + size-mismatched reader (scaled blit path): B
  //    re-reads channel "aux" on a half-size canvas.
  sketchA["instances"]["so"]["state"] = {{"channel", 0}, {"channel_name", "aux"}};
  sketchB["instances"]["si"]["state"] = {{"channel", 0}, {"channel_name", " aux "}};
  const uint32_t W2 = 16, H2 = 16;
  int outB2 = backend->createTexture(W2, H2, RGBA8);
  REQUIRE(outB2 >= 0);
  runA(true);
  int32_t b2 = B.execute(sketchB, inB, outB2, (int)W2, (int)H2, 1.0 / 60.0, true);
  backend->submit();
  CHECK(std::abs(meanCh(b2, W2, H2, 0) - 200.0) < 8.0);   // scaled red arrived

  // 7) Same-executor writer-BELOW-reader feedback loop stays fresh (the >=
  //    freshness rule): si(ch 5) -> brightness(+0.3) -> so(ch 5). Each frame
  //    the reader picks up the previous frame's brightened output, so the
  //    image climbs from black toward white instead of flickering black.
  auto sketchLoop = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "util.sidechannel_in",  "instance_key": "si" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc" },
      { "module_type": "util.sidechannel_out", "instance_key": "so" }
    ],
    "instances": {
      "si": { "module_type": "util.sidechannel_in",  "state": { "channel": 5 } },
      "bc": { "module_type": "color.tone.brightness_contrast",
              "state": { "brightness": 0.3, "contrast": 0.0 } },
      "so": { "module_type": "util.sidechannel_out", "state": { "channel": 5 } }
    }
  })JSON");
  double prevMean = -1.0;
  int32_t loopOut = 0;
  for (int f = 0; f < 4; ++f) {
    loopOut = A.execute(sketchLoop, inA, outA, (int)W, (int)H, 1.0 / 60.0, f == 0);
    backend->submit();
    const double m = meanCh(loopOut, W, H, 0);
    if (f >= 2) {
      CHECK(m > 40.0);         // fresh — a `>` rule would read stale → black
      CHECK(m >= prevMean - 2.0);
    }
    prevMean = m;
  }

  // 8) Channel metadata: version stable across plain re-writes, writer tag
  //    surfaced in infoJson.
  const uint64_t v0 = sidechannel_bus::version();
  runA(true);   // dirty: A last executed sketchLoop — switching sketches
  runA(false);
  CHECK(sidechannel_bus::version() == v0);   // no metadata change per write
  std::vector<char> buf(4096);
  const int32_t n = sidechannel_bus::infoJson(buf.data(), (int32_t)buf.size());
  REQUIRE(n > 0);
  REQUIRE(n <= (int32_t)buf.size());
  auto info = nlohmann::json::parse(std::string(buf.data(), (size_t)n));
  REQUIRE(info.contains("aux"));
  CHECK(info["aux"]["writer"] == "writerA");
  CHECK(info["aux"]["w"] == (int)W);
  REQUIRE(info.contains("3"));
  CHECK(info["3"]["writer"] == "writerA");

  // 9) `send_in` override wire: a texture wired into the send's secondary
  //    input is what gets PUBLISHED, while the send's own output stays the
  //    chain passthrough. Chain: blue(solid) -> green(solid) -> send(ch 6,
  //    wire blue.tex_out -> send_in). A's output = green (chain), the
  //    channel = blue (override). Dropping the wire reverts to the chain.
  auto sketchSend = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "ovr" },
      { "module_type": "source.solid_color", "instance_key": "main" },
      { "module_type": "util.sidechannel_out", "instance_key": "so2" }
    ],
    "instances": {
      "ovr":  { "module_type": "source.solid_color", "state": { "color": [0.0, 0.0, 1.0, 1.0] } },
      "main": { "module_type": "source.solid_color", "state": { "color": [0.0, 1.0, 0.0, 1.0] } },
      "so2":  { "module_type": "util.sidechannel_out", "state": { "channel": 6 } }
    },
    "wires": [
      { "id": "wovr", "src": { "instanceKey": "ovr", "field": "tex_out" },
                      "dest": { "instanceKey": "so2", "field": "send_in" } }
    ]
  })JSON");
  sketchB["instances"]["si"]["state"] = {{"channel", 6}};
  int32_t sendOut = A.execute(sketchSend, inA, outA, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  bOut = runB(true);
  CHECK(meanCh(sendOut, W, H, 1) > 250.0);  // A's own output: chain green…
  CHECK(meanCh(sendOut, W, H, 2) < 4.0);    // …not the wired blue
  CHECK(meanCh(bOut, W, H, 2) > 250.0);     // channel carries the wired blue…
  CHECK(meanCh(bOut, W, H, 1) < 4.0);       // …not the chain green

  // Wire removed → the publish reverts to the chain input (green).
  sketchSend.erase("wires");
  A.execute(sketchSend, inA, outA, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  bOut = runB(false);
  CHECK(meanCh(bOut, W, H, 1) > 250.0);
  CHECK(meanCh(bOut, W, H, 2) < 4.0);

  sidechannel_bus::resetForTest();  // release bus textures while backend lives
}

// ---------------------------------------------------------------------------
// Arena crash repro (2026-07-04): three relaunches, three identical SIGSEGVs on
// the Render Thread at a STABLE low address (~0xd432c0) that WAMR's trap
// handler refused as a wasm OOB — the signature of a wasm offset dereferenced
// off a dead/NULL memory base. Live topology at crash time (recovered from the
// composition's nanobarrel://config blobs): two active barrel instances in one
// process — [brutal_fold → auto_level → edges] and [barrel_macros → shape_burst
// + a macro_0→manual wire] — at 1920×1080, with the web client editing (the
// crash always followed a `regenerate`, i.e. a dirty rebuild that destroys and
// re-creates the wasm effect instances). This case replays exactly that:
// alternating executors, per-frame param churn, trigger events, and periodic
// dirty rebuilds.
#ifdef NANO_WASM_PATH
TEST_CASE("arena repro: brutal_fold + shape_burst chains survive regenerate churn",
          "[effect_render][arena_repro]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(NANO_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor A(&rt, &registry, backend.get());
  A.setKeyNamespace("A/");
  sketch_executor::SketchExecutor B(&rt, &registry, backend.get());
  B.setKeyNamespace("B/");

  const uint32_t W = 1920, H = 1080;
  const int RGBA8 = 1;
  int inA = backend->createTexture(W, H, RGBA8);
  int outA = backend->createTexture(W, H, RGBA8);
  int inB = backend->createTexture(W, H, RGBA8);
  int outB = backend->createTexture(W, H, RGBA8);
  REQUIRE(inA >= 0); REQUIRE(outA >= 0); REQUIRE(inB >= 0); REQUIRE(outB >= 0);

  // Instance states lifted from the crashing composition (help text dropped).
  auto sketchA = nlohmann::json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "source.brutal_fold",     "instance_key": "bf" },
      { "type": "module", "module_type": "color.tone.auto_level",  "instance_key": "al" },
      { "type": "module", "module_type": "filter.edges",           "instance_key": "ed" }
    ],
    "instances": {
      "bf": { "module_type": "source.brutal_fold", "state": {
        "anim_amount": 1, "complexity": 0.2924, "order": 0.2062, "liveliness": 1,
        "time_speed": 0.12, "scale": 0.7, "extrude": 1, "fog": 5,
        "interp_cells": true, "second_structure": true, "vol_amount": 1,
        "vol_depth": 0.12, "vol_radius": 0.5, "vol_shape": 1, "vol_z": 0.55,
        "diff_hue_hi": 0.586, "diff_hue_lo": 0.283, "diff_hue_mid": 0.815
      } },
      "al": { "module_type": "color.tone.auto_level", "state": {
        "equalize": 0.87, "median_pull": 0.57, "median_target": 0.41 } },
      "ed": { "module_type": "filter.edges", "state": {
        "bg": [0,0,0], "keep_input": 0, "line": [1,1,1],
        "radius": 0.14, "threshold": 0.17 } }
    }
  })JSON");

  auto sketchB = nlohmann::json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "control.barrel_macros", "instance_key": "mac" },
      { "type": "module", "module_type": "source.shape_burst",    "instance_key": "burst" }
    ],
    "instances": {
      "mac": { "module_type": "control.barrel_macros", "state": { "macro_0": 0.0 } },
      "burst": { "module_type": "source.shape_burst", "state": {
        "auto_rate": 0, "composite": 0, "distort": 0.15, "distort_freq": 0.4,
        "duration": 0.3, "manual": 0, "voices": 1, "shape": 0,
        "thickness": 0.03, "min_scale": 0.05, "max_scale": 1.2,
        "motion_strength": 1, "tilt": 0, "trigger": 0 } }
    },
    "wires": [
      { "id": "w0", "combine": "add",
        "src":  { "instanceKey": "mac",   "field": "macro_0" },
        "dest": { "instanceKey": "burst", "field": "manual" } }
    ]
  })JSON");

  for (int f = 0; f < 900; ++f) {
    // The web client editing → periodic full regenerates (plan rebuild:
    // destroy + re-create every wasm effect instance).
    const bool dirty = (f % 60) == 0;
    // Live param churn (macro knob riding, brutal_fold pad drag).
    sketchB["instances"]["mac"]["state"]["macro_0"] = 0.5 + 0.5 * std::sin(f * 0.11);
    sketchA["instances"]["bf"]["state"]["complexity"] = 0.29 + 0.2 * std::sin(f * 0.05);
    // Occasional trigger events firing shape_burst voices.
    if (f % 90 == 30) sketchB["instances"]["burst"]["state"]["trigger"] = f;

    int32_t oA = A.execute(sketchA, inA, outA, (int)W, (int)H, 1.0 / 60.0, dirty);
    backend->submit();
    int32_t oB = B.execute(sketchB, inB, outB, (int)W, (int)H, 1.0 / 60.0, dirty);
    backend->submit();
    REQUIRE(oA > 0);
    REQUIRE(oB > 0);
  }

  // Surviving 900 frames (15 dirty rebuilds) without a signal IS the assertion.
  auto pxA = backend->readbackTexture(outA, W, H);
  auto pxB = backend->readbackTexture(outB, W, H);
  CHECK(pxA.size() == (size_t)W * H * 4);
  CHECK(pxB.size() == (size_t)W * H * 4);
}
#endif  // NANO_WASM_PATH

// Second Arena repro axis: the user isolated a MULTI-CARD PASTE that crashed
// seconds later — a 5-filter chain including two LEGACY-bundle effects
// (color.legacy.bicolor_grad, filter.legacy.subtle_blur). legacy.wasm is the
// ~14MB module, which is exactly where a NULL-membase dereference at the
// crash's stable in-bounds offset (~0xd432c0, 13.9MB) would land. Resolume
// additionally renders one instance at ALTERNATING sizes (composition output
// vs preview panel) — so this case drives the pasted chain over a non-black
// input with per-frame 1920×1080 ↔ 1754×987 viewport thrash and periodic
// dirty rebuilds (the paste itself is a regenerate).
#ifdef LEGACY_WASM_PATH
TEST_CASE("arena repro: pasted legacy filter chain survives viewport thrash",
          "[effect_render][arena_repro]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  REQUIRE(bundles.loadBundleFile(LEGACY_WASM_PATH, registry, backend.get(), nullptr) > 1);

  sketch_executor::SketchExecutor ex(&rt, &registry, backend.get());

  const uint32_t W1 = 1920, H1 = 1080, W2 = 1754, H2 = 987;
  const int RGBA8 = 1;
  int in1 = backend->createTexture(W1, H1, RGBA8);
  int out1 = backend->createTexture(W1, H1, RGBA8);
  int in2 = backend->createTexture(W2, H2, RGBA8);
  int out2 = backend->createTexture(W2, H2, RGBA8);
  REQUIRE(in1 >= 0); REQUIRE(out1 >= 0); REQUIRE(in2 >= 0); REQUIRE(out2 >= 0);

  // Non-black, non-uniform input (the filters analyze content — bicolor_grad
  // isolates a mid-band, subtle_blur displaces by hue).
  auto fillGradient = [&](int tex, uint32_t w, uint32_t h) {
    std::vector<uint8_t> px((size_t)w * h * 4);
    for (uint32_t y = 0; y < h; ++y)
      for (uint32_t x = 0; x < w; ++x) {
        size_t i = ((size_t)y * w + x) * 4;
        px[i] = (uint8_t)(255 * x / w);
        px[i + 1] = (uint8_t)(255 * y / h);
        px[i + 2] = (uint8_t)(255 - (255 * x / w));
        px[i + 3] = 255;
      }
    backend->writeTexture(tex, w, h, px.data(), (uint32_t)px.size());
  };
  fillGradient(in1, W1, H1);
  fillGradient(in2, W2, H2);

  // The exact pasted payload (help text dropped; __opacity__ kept — a partial-
  // opacity FIRST stage rides the executor's reserved-key path).
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "color.legacy.bicolor_grad",  "instance_key": "bg"  },
      { "type": "module", "module_type": "color.temperature",          "instance_key": "ct"  },
      { "type": "module", "module_type": "color.hsl",                  "instance_key": "hsl" },
      { "type": "module", "module_type": "filter.vignette",            "instance_key": "vig" },
      { "type": "module", "module_type": "filter.legacy.subtle_blur",  "instance_key": "sb"  }
    ],
    "instances": {
      "bg":  { "module_type": "color.legacy.bicolor_grad", "state": {
        "__opacity__": 0.49, "blend": 1, "color_sat": 0.05, "isolation": 0.3,
        "midband": 0.2, "mode": 0, "neutral": [0.05, 0.05, 0.06],
        "neutral_mix": 0.25, "reverse": false, "scale": 1, "smoothing": 0.85 } },
      "ct":  { "module_type": "color.temperature", "state": { "temperature": 1 } },
      "hsl": { "module_type": "color.hsl", "state": {
        "hue_shift": -0.18, "lightness": -0.35, "saturation": 1 } },
      "vig": { "module_type": "filter.vignette", "state": {
        "amount": -0.52, "center": [0, 0], "radius": 0.6, "shape": 0,
        "softness": 0.4, "squash": 0 } },
      "sb":  { "module_type": "filter.legacy.subtle_blur", "state": {
        "amount": 0.15, "blur": 0.09, "hue": 0.22, "movement": 1, "quality": 0.3 } }
    }
  })JSON");

  for (int f = 0; f < 1200; ++f) {
    const bool dirty = (f % 120) == 0;   // periodic re-paste / plan rebuild
    const bool small = (f % 2) == 1;     // per-frame Resolume preview-size thrash
    int32_t out = small
      ? ex.execute(sketch, in2, out2, (int)W2, (int)H2, 1.0 / 60.0, dirty)
      : ex.execute(sketch, in1, out1, (int)W1, (int)H1, 1.0 / 60.0, dirty);
    backend->submit();
    REQUIRE(out > 0);
  }

  auto px = backend->readbackTexture(out1, W1, H1);
  CHECK(px.size() == (size_t)W1 * H1 * 4);
}

// Backend-level golden for buffer versioning (write-after-bind): inside a
// submit batch, a CPU write to a buffer that already has dispatched readers
// must NOT be observed by them — the backend swaps in a fresh backing buffer
// so each dispatch reads the latest write that PRECEDED its encode. This is
// what papers over the native/web submit asymmetry (effect-called submit() is
// a no-op in-batch natively but a real flush on web); without it the second
// write would win for BOTH dispatches (the lut_collection all-cubes-identical
// bug class).
TEST_CASE("write-after-bind versions the buffer inside a submit batch",
          "[effect_render][gpu_backend]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  const char* kCopyMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;
kernel void copy_word(const device uint* src [[buffer(0)]],
                      device uint* dst       [[buffer(1)]],
                      uint3 gid [[thread_position_in_grid]]) {
  if (gid.x == 0 && gid.y == 0) dst[0] = src[0];
}
)MSL";
  int32_t shader = backend->createShaderModule(kCopyMSL);
  REQUIRE(shader > 0);
  int32_t pso = backend->createComputePSO(shader, "copy_word");
  REQUIRE(pso > 0);

  int32_t src  = backend->createBuffer(4, 0);
  int32_t dstA = backend->createBuffer(4, 0);
  int32_t dstB = backend->createBuffer(4, 0);
  REQUIRE(src > 0); REQUIRE(dstA > 0); REQUIRE(dstB > 0);

  auto writeU32 = [&](int32_t buf, uint32_t v) {
    backend->writeBuffer(buf, 0, (const uint8_t*)&v, 4);
  };
  auto copyPass = [&](int32_t from, int32_t to) {
    int32_t pass = backend->beginComputePass();
    backend->computeSetPSO(pass, pso);
    backend->computeSetBuffer(pass, from, 0, 0);
    backend->computeSetBuffer(pass, to, 0, 1);
    backend->computeDispatch(pass, 1, 1, 1);
    backend->endComputePass(pass);
  };

  backend->beginSubmitBatch();
  writeU32(src, 111);          // legit: set→write→dispatch order (no version)
  copyPass(src, dstA);         // reads 111
  writeU32(src, 222);          // hazard: src has a dispatched reader → version
  copyPass(src, dstB);         // reads 222
  backend->endSubmitBatch();

  uint32_t a = 0, b = 0;
  REQUIRE(backend->readBuffer(dstA, 0, &a, 4) == 4);
  REQUIRE(backend->readBuffer(dstB, 0, &b, 4) == 4);
  INFO("dstA=" << a << " dstB=" << b);
  CHECK(a == 111);   // without versioning: 222 (last write won)
  CHECK(b == 222);
}

// REGRESSION: lut_collection bakes its 13 preset cubes on the first render —
// inside the executor's whole-frame command batch, where effect-called
// gpu::Device::submit() is a no-op and gpu_write_buffer is an immediate CPU
// write. The original bake reused ONE staging buffer with a submit() between
// presets, so every fill dispatch read the LAST preset's bytes: all 13 cubes
// held "Hue Rotate 270" and every preset rendered identically (web was fine —
// its submit really flushes). Fixed with one staging buffer per preset.
// Asserted semantically: "Mono" must be grayscale (Hue270 is wildly colored),
// and distinct presets must render distinct pixels.
TEST_CASE("lut_collection presets bake distinct cubes in one batched frame",
          "[effect_render][lut]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(LEGACY_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 64, H = 64; const int RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);

  // Gradient input (r=x, g=y, b=0) — sweeps a plane of the LUT cube.
  std::vector<uint8_t> px((size_t)W * H * 4);
  for (uint32_t y = 0; y < H; ++y)
    for (uint32_t x = 0; x < W; ++x) {
      size_t i = ((size_t)y * W + x) * 4;
      px[i] = (uint8_t)(255 * x / (W - 1));
      px[i + 1] = (uint8_t)(255 * y / (H - 1));
      px[i + 2] = 0;
      px[i + 3] = 255;
    }
  backend->writeTexture(inTex, W, H, px.data(), (uint32_t)px.size());

  auto renderPreset = [&](int lut) {
    char buf[512];
    std::snprintf(buf, sizeof(buf), R"JSON({
      "chain": [ { "module_type": "color.legacy.lut_collection", "instance_key": "lut" } ],
      "instances": {
        "lut": { "module_type": "color.legacy.lut_collection",
                 "state": { "lut": %d, "amount": 1.0, "pregain": 0.0 } }
      }
    })JSON", lut);
    auto sk = nlohmann::json::parse(buf);
    int32_t out = executor.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    REQUIRE(out > 0);
    return backend->readbackTexture(out, W, H);
  };

  // Frame 1 selects "Mono" (preset 6) so the bake AND a bake-dependent apply
  // ride the same batched command buffer.
  auto mono = renderPreset(6);
  REQUIRE(mono.size() == px.size());
  int maxChanDelta = 0;
  for (size_t i = 0; i < mono.size(); i += 4) {
    int r = mono[i], g = mono[i + 1], b = mono[i + 2];
    maxChanDelta = std::max({maxChanDelta, std::abs(r - g), std::abs(r - b)});
  }
  INFO("Mono max |r-g| / |r-b| over all pixels: " << maxChanDelta);
  CHECK(maxChanDelta <= 8);   // bug rendered Hue Rotate 270 here (delta ~230)

  auto process = renderPreset(0);
  auto hue270  = renderPreset(12);
  auto meanAbsDiff = [](const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
    long s = 0, n = 0;
    for (size_t i = 0; i < a.size(); i += 4) {   // rgb only
      s += std::abs((int)a[i] - (int)b[i]) + std::abs((int)a[i+1] - (int)b[i+1])
         + std::abs((int)a[i+2] - (int)b[i+2]);
      n += 3;
    }
    return n ? (double)s / n : 0.0;
  };
  INFO("meanAbsDiff mono/process " << meanAbsDiff(mono, process)
       << " mono/hue270 " << meanAbsDiff(mono, hue270)
       << " process/hue270 " << meanAbsDiff(process, hue270));
  CHECK(meanAbsDiff(mono, process) > 15.0);    // bug: all three identical (0)
  CHECK(meanAbsDiff(mono, hue270) > 15.0);
  CHECK(meanAbsDiff(process, hue270) > 15.0);
}
#endif  // LEGACY_WASM_PATH
