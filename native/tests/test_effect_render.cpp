// test_effect_render.cpp — end-to-end GPU render of a WASM effect (barrel-
// loads-WASM). Loads brightness_contrast from core.wasm, registers it through
// the WASM ModuleRegistry (module_init compiles its SPV→MSL shader + PSO on a
// real Metal backend), wires tex_in/tex_out, drives doRender via the WASM
// EffectInstance driver, and verifies the output pixels brighten.

#include <catch2/catch_test_macros.hpp>

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
    if (e.id == "video.brightness_contrast") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  // Register ONLY this effect — registering the whole bundle would run every
  // effect's module_init, some of which use host imports not yet wired.
  REQUIRE(registry.registerWasmEffect("video.brightness_contrast",
                                      "Brightness/Contrast", &host, id, *w));

  EffectInstance* inst = rt.instanceFor("video.brightness_contrast", "k0");
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

  // brightness 0.75 (> neutral 0.5) should lift the output above the input.
  inst->setParamFloat("brightness", 0.75f);
  inst->setParamFloat("contrast", 0.5f);
  inst->doRender(W, H);  // effect calls gpu.submit() internally (commit+wait)
  auto bright = backend->readbackTexture(outTex, W, H);
  REQUIRE(bright.size() == W * H * 4);
  INFO("in mean " << inMean << "  bright mean " << mean_rgb(bright));
  CHECK(mean_rgb(bright) > inMean + 30.0);

  // Neutral (0.5/0.5) is identity: output ~= input.
  inst->setParamFloat("brightness", 0.5f);
  inst->setParamFloat("contrast", 0.5f);
  inst->doRender(W, H);
  auto ident = backend->readbackTexture(outTex, W, H);
  INFO("ident mean " << mean_rgb(ident));
  CHECK(std::abs(mean_rgb(ident) - inMean) < 8.0);

  host.shutdown();
}

// The slot-based GPU input ABI: video.blend reads its two inputs via
// gpu::Device::inputTexture(0/1) and writes via renderTarget() — NOT
// textureForField. This locks the executor↔host plumbing that feeds those
// (EffectInstance::setInputTextureSlots → WasmContext::input_texture_handles,
// and GPUBackend::setSurface → getSurfaceTexture). Without it the effect bails
// to black; texture wires into multi-input effects depend on it.
TEST_CASE("WASM slot-based input ABI blends two textures (video.blend)", "[effect_render]") {
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
    if (e.id == "video.blend") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(registry.registerWasmEffect("video.blend", "Blend", &host, id, *w));

  EffectInstance* inst = rt.instanceFor("video.blend", "k0");
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
      { "module_type": "video.blend", "instance_key": "acc" },
      { "module_type": "video.brightness_contrast", "instance_key": "fb" }
    ],
    "instances": {
      "acc": { "module_type": "video.blend", "state": { "opacity": 0.5 } },
      "fb":  { "module_type": "video.brightness_contrast", "state": { "brightness": 0.5, "contrast": 0.5 } }
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

  // Frame 0 (dirty): one brightness_contrast at 0.75 (> neutral 0.5) → lifts.
  auto bright = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "video.brightness_contrast", "instance_key": "bc" } ],
    "instances": {
      "bc": { "module_type": "video.brightness_contrast",
              "state": { "brightness": 0.75, "contrast": 0.5 } }
    }
  })JSON");
  double m0 = runFrame(bright, /*dirty=*/true);
  const int afterFirst = executor.planBuildCountForTest();
  REQUIRE(afterFirst >= 1);             // first frame builds the plan
  CHECK(m0 > inMean + 20.0);            // brightened

  // Frame 1 (dirty, PARAM-ONLY): same topology, brightness 0.25 (< neutral) →
  // darkens. The structural signature is unchanged, so the plan must be REUSED
  // (counter steady) even though the value-dirty flag is set, yet the new value
  // must still take effect (applyState runs on the dirty flag).
  auto dark = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "video.brightness_contrast", "instance_key": "bc" } ],
    "instances": {
      "bc": { "module_type": "video.brightness_contrast",
              "state": { "brightness": 0.25, "contrast": 0.5 } }
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
      { "module_type": "video.brightness_contrast", "instance_key": "bc" },
      { "module_type": "video.brightness_contrast", "instance_key": "bc2" }
    ],
    "instances": {
      "bc":  { "module_type": "video.brightness_contrast",
               "state": { "brightness": 0.25, "contrast": 0.5 } },
      "bc2": { "module_type": "video.brightness_contrast",
               "state": { "brightness": 0.75, "contrast": 0.5 } }
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
//      (video.blend tex_a/tex_b) OR a NUMERIC positional index ('0'/'1') must
//      both reach inputTexture(0/1). The editor uses both spellings.
// Sketch: red(solid)→blue(solid)→blend, all params on entry.params, opacity 0 →
// output == tex_a (red). Run once with named dests, once with numeric.
TEST_CASE("entry.params + named/numeric input wires drive video.blend",
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
        { "module_type": "generator.solid_color", "instance_key": "red",  "params": { "color": [1.0, 0.0, 0.0] } },
        { "module_type": "generator.solid_color", "instance_key": "blue", "params": { "color": [0.0, 0.0, 1.0] } },
        { "module_type": "video.blend", "instance_key": "mix", "params": { "opacity": 0.0 } }
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
// then drops the entry.params INPUT fields (e.g. data.lfo's rate), so the effect
// runs at schema defaults. Here bc carries a partial instances.state
// {brightness:0.5} (the "mirrored" field) AND entry.params {contrast:0.0}. With
// the per-field merge, contrast=0.0 is applied → black; with the old
// all-or-nothing skip, contrast stays default 0.5 → the white passes through.
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
      { "module_type": "generator.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "video.brightness_contrast", "instance_key": "bc",
        "params": { "brightness": 0.5, "contrast": 0.0 } }
    ],
    "instances": { "bc": { "module_type": "video.brightness_contrast", "state": { "brightness": 0.5 } } }
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
  backend->submit();
  auto px = backend->readbackTexture(out, W, H);
  double m = mean_rgb(px);
  INFO("output mean " << m << " (expect ~0 black: contrast=0 from entry.params applied)");
  CHECK(m < 30.0);
}

// Gap #3 repro of the EXACT web engine-wires "forward scalar wire" sketch:
// white -> data.lfo(rate 0) -> brightness_contrast, wire lfo.output -> brightness.
// lfo.output==0.5 (mirrored into instance state, as the web host does) -> brightness
// must land 0.5 (neutral, magnitude auto/unsigned) -> output grey ~128.
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
      { "module_type": "generator.solid_color", "instance_key": "src", "params": { "color": [1.0,1.0,1.0] } },
      { "module_type": "data.lfo", "instance_key": "lfo", "params": { "rate": 0.0, "amplitude": 1.0 } },
      { "module_type": "video.brightness_contrast", "instance_key": "bc", "params": { "brightness": 1.0, "contrast": 0.25 } }
    ],
    "instances": { "lfo": { "module_type": "data.lfo", "state": { "output": 0.5 } } },
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
      { "module_type": "video.brightness_contrast", "instance_key": "a" },
      { "module_type": "video.brightness_contrast", "instance_key": "b" }
    ],
    "instances": {
      "a": { "module_type": "video.brightness_contrast", "state": { "brightness": 0.75, "contrast": 0.5 } },
      "b": { "module_type": "video.brightness_contrast", "state": { "brightness": 0.25, "contrast": 0.5 } }
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
    "chain": [ { "module_type": "video.brightness_contrast", "instance_key": "a" } ],
    "instances": { "a": { "module_type": "video.brightness_contrast", "state": { "brightness": 0.75, "contrast": 0.5 } } }
  })JSON");
  run(one, s);
  CHECK(s[0] == 1);  // effectsExecuted
  CHECK(s[1] == 1);  // standaloneDispatches
  CHECK(s[2] == 0);  // fusedRuns
  CHECK(s[5] == 1);  // gpuDispatches
  CHECK(s[6] == 0);  // identitySkipped

  // Single NEUTRAL brightness_contrast (0.5/0.5) → identity → skipped, no dispatch.
  auto ident = nlohmann::json::parse(R"JSON({
    "chain": [ { "module_type": "video.brightness_contrast", "instance_key": "a" } ],
    "instances": { "a": { "module_type": "video.brightness_contrast", "state": { "brightness": 0.5, "contrast": 0.5 } } }
  })JSON");
  run(ident, s);
  CHECK(s[0] == 1);  // effectsExecuted (still processed)
  CHECK(s[1] == 0);  // standaloneDispatches
  CHECK(s[5] == 0);  // gpuDispatches — nothing hit the GPU
  CHECK(s[6] == 1);  // identitySkipped
}

#ifdef TEXT_WASM_PATH
// Text-effect migration (step #4): gen.text loads from text.wasm — the same
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
TEST_CASE("text.wasm renders gen.text via the native text bridge", "[effect_render]") {
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

  EffectInstance* inst = rt.instanceFor("gen.text", "k0");
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
}
#endif  // TEXT_WASM_PATH
