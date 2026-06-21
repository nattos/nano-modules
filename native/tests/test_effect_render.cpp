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

  const uint8_t IN = 160;
  std::vector<uint8_t> inPix(W * H * 4, IN);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);  // 160

  // acc(blend).tex_a = linear input; acc.tex_b = DELAYED feedback from fb's
  // output (fb sits below acc → delayed). fb is a neutral brightness pass so
  // fb.tex_out == acc's output. opacity 0.5 → frame-blend accumulator.
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "composite.blend", "instance_key": "acc" },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "fb" }
    ],
    "instances": {
      "acc": { "module_type": "composite.blend", "state": { "opacity": 0.5 } },
      "fb":  { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.0, "contrast": 0.0 } }
    },
    "wires": [
      { "id": "wfb", "src": { "instanceKey": "fb", "field": "tex_out" },
                     "dest": { "instanceKey": "acc", "field": "tex_b" } }
    ]
  })JSON");

  double earlyMean = 0.0, lateMean = 0.0;
  for (int frame = 0; frame < 30; ++frame) {
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0 / 60.0,
                                   /*sketchDirty=*/frame == 0);
    backend->submit();
    if (frame == 2) earlyMean = mean_rgb(backend->readbackTexture(out, W, H));
    if (frame == 29) lateMean = mean_rgb(backend->readbackTexture(out, W, H));
  }

  INFO("input " << inMean << "  early(f3) " << earlyMean << "  late(f30) " << lateMean);
  // Converged to the input within RGBA8 rounding.
  CHECK(std::abs(lateMean - inMean) < 6.0);
  // Still mid-transient early — well below the converged value. Proves the
  // feedback is accumulating frame-over-frame (i.e. the delayed wire delivers).
  CHECK(earlyMean < lateMean - 10.0);
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

  // lfo.output mirrored to 0.5 in instance state (the web host injects producer
  // outputs there; the native float write-tap reads them from the JSON).
  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
    ],
    "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
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
// as the forward-wire repro: mod.source.lfo(output 0.5) -> bc.brightness, magnitude
// auto/unsigned/replace into brightness's signed [-1,1]. The band must span the
// dest's [-1,1] (sweeping lfo.output 0..1 → replaceVal -1..1) and the effective
// value must be 0.0 (the live output mid-mapped). A `mod` remap on the wire must
// narrow the band to the remap's (folded) output range.
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
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
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
    CHECK(b["value"].get<double>()   == Catch::Approx(0.0).margin(0.01));
    CHECK(b["min"].get<double>()     == Catch::Approx(-1.0).margin(0.01));
    CHECK(b["max"].get<double>()     == Catch::Approx(1.0).margin(0.01));
    CHECK(b["neutral"].get<double>() == Catch::Approx(-1.0).margin(0.01));  // replace + unsigned → range min (-1)
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
    // remap out [0.25,0.75] folds into the signed [-1,1] dest → [-0.5,0.5].
    CHECK(b["value"].get<double>() == Catch::Approx(0.0).margin(0.01));   // remap midpoint → 0
    CHECK(b["min"].get<double>()   == Catch::Approx(-0.5).margin(0.01));
    CHECK(b["max"].get<double>()   == Catch::Approx(0.5).margin(0.01));
  }

  // An ENVELOPE shaper on the wire reshapes the value the same way mod.shaper.envelope
  // would. Curve (0,0.2)->(1,0.6) maps lfo.output 0.5 → 0.4, narrowing the band
  // to the envelope's [0.2,0.6] output window (swept over the source's [0,1]) —
  // then folded into brightness's signed [-1,1] as [-0.6, 0.2] (2v-1).
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
    CHECK(b["value"].get<double>() == Catch::Approx(-0.2).margin(0.01));  // env(0.5)=0.4 → -0.2
    CHECK(b["min"].get<double>()   == Catch::Approx(-0.6).margin(0.01));  // env(0)=0.2 → -0.6
    CHECK(b["max"].get<double>()   == Catch::Approx(0.2).margin(0.01));   // env(1)=0.6 → 0.2
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
    // Folded into brightness's signed [-1,1]: 2*0.2-1 = -0.6.
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    backend->submit();
    CHECK(executor.lastModulationData()["bc"]["brightness"]["value"].get<double>()
            == Catch::Approx(-0.6).margin(0.02));
    // Frame 2: source jumps to 0.8, but the 1s delay still reads frame 1's 0.2
    // (folded -0.6); without the delay it would track 0.8 (folded +0.6).
    sketch["instances"]["lfo"]["state"]["output"] = 0.8;
    executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, false);
    backend->submit();
    const auto& md = executor.lastModulationData();
    INFO("modulationData = " << md.dump());
    CHECK(md["bc"]["brightness"]["value"].get<double>() == Catch::Approx(-0.6).margin(0.05));
  }

  // Forcing `signed` on a source that EXPLICITLY declares unsigned [0,1]
  // prescales the value to [-1,1] (0→-1, 1→1), so the band spans the FULL dest
  // range. Without the prescale (the old face-value behavior), an unsigned 0..1
  // value read as signed only reaches the upper half ([0.5,1.0]); the [0,1] band
  // below proves the rescale is active. mod.source.lfo.output declares "unsigned".
  SECTION("forced signed on an explicit-unsigned source rescales to bipolar") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": -0.5 } }
      ],
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
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
    CHECK(b["value"].get<double>()   == Catch::Approx(0.0).margin(0.01));  // 0.5→0 (bipolar) → mid
    CHECK(b["min"].get<double>()     == Catch::Approx(-1.0).margin(0.01)); // src 0 → -1 → range min
    CHECK(b["max"].get<double>()     == Catch::Approx(1.0).margin(0.01));  // src 1 → +1 → range max
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
      "instances": { "lfo": { "module_type": "mod.source.lfo", "state": { "output": 0.5 } } },
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
    // src 0.5 → bipolar 0 → *scale 0 → add 0: holds the base (0.5), not -1.0.
    CHECK(b["value"].get<double>()   == Catch::Approx(0.5).margin(0.01));
    CHECK(b["neutral"].get<double>() == Catch::Approx(0.5).margin(0.01));  // add → base
    // Half-scale of the (now wider [-1,1]) swing about the base: 0.5 ± 1.0.
    CHECK(b["min"].get<double>()     == Catch::Approx(-0.5).margin(0.01)); // src 0 → -1.0 → -0.5
    CHECK(b["max"].get<double>()     == Catch::Approx(1.5).margin(0.01));  // src 1 → +1.0 → 1.5
  }
}

// A modulation shaper (mod.shaper.remap) placed DIRECTLY after a modulation generator
// (mod.source.lfo) auto-connects in the executor: the generator's magnitude'd OUTPUT
// channel feeds the shaper's magnitude'd INPUT channel in ABSOLUTE magnitude,
// without the user drawing a wire. Gated on the capability tags (modulation_source
// / modulation_shaper). Observed via lastModulationData(): the auto-connect records
// a band on the shaper's `input`. Explicit wires win; a non-adjacent generator does
// nothing. Same lfo(output 0.5) probe as the wire tests (hand-mirrored into state).
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
    // Absolute passthrough of lfo.output (0.5); band spans the source decl [0,1].
    CHECK(in["value"].get<double>() == Catch::Approx(0.5).margin(0.01));
    CHECK(in["min"].get<double>()   == Catch::Approx(0.0).margin(0.01));
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
    CHECK(in["min"].get<double>() == Catch::Approx(0.25).margin(0.01));
    CHECK(in["max"].get<double>() == Catch::Approx(0.75).margin(0.01));
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
// the prescale: forcing `signed` on a wire from smooth.output, when smooth
// inherited the lfo's EXPLICIT unsigned, rescales 0..1→−1..1 (full bipolar band);
// without a source feeding smooth's input the polarity is unknown, so the same
// forced-signed wire is taken at face value (only the upper half). mod.source.lfo.output
// is "unsigned"; smooth/lfo outputs hand-mirrored into state. The sink is
// color.posterize.amount (an UNSIGNED [0,1] field) — the distinction only shows
// on an unsigned dest, and brightness_contrast is now signed [-1,1].
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

  SECTION("inherits the upstream source's unsigned (forced-signed rescales to full)") {
    auto sketch = nlohmann::json::parse(R"JSON({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
        { "module_type": "mod.source.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
        { "module_type": "mod.shaper.smooth", "instance_key": "sm", "params": { "duration": 0.0 } },
        { "module_type": "color.posterize", "instance_key": "pz", "params": { "amount": 0.5 } }
      ],
      "instances": {
        "lfo": { "module_type": "mod.source.lfo",  "state": { "output": 0.5 } },
        "sm":  { "module_type": "mod.shaper.smooth","state": { "output": 0.5 } }
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
    CHECK(b["value"].get<double>()   == Catch::Approx(0.5).margin(0.01));  // 0.5→bipolar 0→mid
    CHECK(b["min"].get<double>()     == Catch::Approx(0.0).margin(0.01));  // rescaled: full range
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
