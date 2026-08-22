// test_executor_wasm.cpp — the end-to-end proof: drive the unified executor.wasm
// (via WasmExecutorDriver — the SAME driver the barrel + benchmark use) against
// the native EffectRuntime + Metal backend, and assert it renders pixel-identical
// to the in-process native SketchExecutor. Also covers the driver itself.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>
#include <vector>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"
#include "sketch/wasm_executor_driver.h"

using effect_runtime::EffectRuntime;
using sketch_executor::ModuleRegistry;
using sketch_executor::SketchExecutor;
using sketch_executor::WasmEffectBundles;
using sketch_executor::WasmExecutorDriver;

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif
#ifndef EXECUTOR_WASM_PATH
#error "EXECUTOR_WASM_PATH must be defined"
#endif

static double mean_rgb(const std::vector<uint8_t>& px) {
  long s = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { s += px[i] + px[i+1] + px[i+2]; n += 3; }
  return n ? (double)s / n : 0.0;
}

// Directory holding executor.wasm (the driver appends executor.aot / .wasm).
static std::string executorWasmDir() {
  std::string p = EXECUTOR_WASM_PATH;
  auto slash = p.find_last_of('/');
  return slash == std::string::npos ? std::string(".") : p.substr(0, slash);
}

TEST_CASE("executor.wasm renders pixel-identical to the native executor", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  // Native runtime + effects (shared by both executors via the effrt binding).
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  // Load + prime executor.wasm through the shared driver (registers the effrt
  // host functions, creates the executor, pushes every schema).
  WasmExecutorDriver driver;
  REQUIRE(driver.init(executorWasmDir(), &rt, backend.get(), registry.schemas()));

  // A brightness/contrast chain (brightens) — exercises params + a real render.
  const std::string sketch = R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "k0" } ],
    "instances": { "k0": { "module_type": "color.tone.brightness_contrast",
                           "state": { "brightness": 0.5, "contrast": 0.0 } } },
    "wires": []
  })JSON";

  const uint32_t W = 32, H = 32, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 96);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);

  // --- Reference: the native in-process executor on the same sketch. ---
  std::vector<uint8_t> nativeOut;
  {
    SketchExecutor nativeEx(&rt, &registry, backend.get());
    auto j = nlohmann::json::parse(sketch);
    int32_t h = nativeEx.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    nativeOut = backend->readbackTexture(h, W, H);
  }
  REQUIRE(nativeOut.size() == W * H * 4);
  CHECK(mean_rgb(nativeOut) > inMean + 20.0);  // it brightened

  // --- executor.wasm on the same sketch, via the driver. ---
  int32_t wasmHandle = driver.execute(&rt, sketch, inTex, outTex,
                                      (int)W, (int)H, 1.0 / 60.0, /*dirty=*/true);
  backend->submit();
  auto wasmOut = backend->readbackTexture(wasmHandle, W, H);
  REQUIRE(wasmOut.size() == W * H * 4);

  INFO("native mean " << mean_rgb(nativeOut) << "  wasm mean " << mean_rgb(wasmOut)
       << (driver.usingAot() ? "  (AOT)" : "  (interp)"));
  // Byte-identical: same executor source, same effects, same backend.
  size_t diffs = 0;
  for (size_t i = 0; i < wasmOut.size(); ++i) if (wasmOut[i] != nativeOut[i]) ++diffs;
  CHECK(diffs == 0);
}

TEST_CASE("a trailing effect keeps rendering on CLEAN (non-dirty) frames", "[executor_wasm]") {
  // Repro for the arrangement MAIN BUS FX "works only on single-frame bursts":
  // the bus FX is the FINAL chain entry over the composite. On the dirty frame
  // (sketch re-issued) it renders; the worry is a later CLEAN frame (dirty=0,
  // cached plan, state not re-applied) collapsing to identity → passthrough.
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  WasmExecutorDriver driver;
  REQUIRE(driver.init(executorWasmDir(), &rt, backend.get(), registry.schemas()));

  // A single brightness_contrast at brightness=1.0 — the trailing/final stage.
  const std::string sketch = R"JSON({
    "chain": [ { "type":"module","module_type": "color.tone.brightness_contrast", "instance_key": "mbfx@0" } ],
    "instances": { "mbfx@0": { "module_type": "color.tone.brightness_contrast",
                               "state": { "brightness": 1.0, "contrast": 0.0 } } },
    "wires": []
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 96);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);

  // Frame 1 — DIRTY (the re-issue): applies state, builds the plan.
  int32_t h1 = driver.execute(&rt, sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, /*dirty=*/true);
  backend->submit();
  const double m1 = mean_rgb(backend->readbackTexture(h1, W, H));

  // Frames 2..4 — CLEAN (steady state): same sketch, dirty=0, cached plan.
  double m2 = 0;
  for (int f = 0; f < 3; ++f) {
    int32_t h = driver.execute(&rt, sketch, inTex, outTex, (int)W, (int)H, 1.0/60.0, /*dirty=*/false);
    backend->submit();
    m2 = mean_rgb(backend->readbackTexture(h, W, H));
  }

  INFO("in " << inMean << "  dirty " << m1 << "  clean " << m2);
  CHECK(m1 > inMean + 20.0);  // the burst: brightened on the dirty frame
  CHECK(m2 > inMean + 20.0);  // MUST still be brightened on clean frames (not passthrough)
}

TEST_CASE("a trailing effect AFTER a composite.blend renders on clean frames (main-bus shape)", "[executor_wasm]") {
  // The EXACT main-bus structure: bg solid + a source clip composited via
  // composite.blend, then a trailing brightness_contrast (the master FX bus) as
  // the final entry. Reproduces the arrangement composite verbatim, over a dirty
  // then several clean frames.
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  WasmExecutorDriver driver;
  REQUIRE(driver.init(executorWasmDir(), &rt, backend.get(), registry.schemas()));

  // arr_bg(black) , clip(red) , blend(bg over red) , brightness(+1) trailing.
  const std::string sketch = R"JSON({
    "chain": [
      { "type":"module","module_type":"source.solid_color","instance_key":"arr_bg" },
      { "type":"module","module_type":"source.solid_color","instance_key":"clip_gen" },
      { "type":"module","module_type":"composite.blend","instance_key":"clip_blend" },
      { "type":"module","module_type":"color.tone.brightness_contrast","instance_key":"track_main-bus_mbfx" }
    ],
    "instances": {
      "arr_bg":   { "module_type":"source.solid_color","state":{ "color":[0.0,0.0,0.0] } },
      "clip_gen": { "module_type":"source.solid_color","state":{ "color":[0.4,0.0,0.0] } },
      "clip_blend": { "module_type":"composite.blend","state":{ "mode":0,"opacity":1.0 } },
      "track_main-bus_mbfx": { "module_type":"color.tone.brightness_contrast","state":{ "brightness":1.0,"contrast":0.0 } }
    },
    "wires": [
      { "id":"w0","src":{"instanceKey":"arr_bg","field":"tex_out"},"dest":{"instanceKey":"clip_blend","field":"0"} },
      { "id":"w1","src":{"instanceKey":"clip_gen","field":"tex_out"},"dest":{"instanceKey":"clip_blend","field":"1"} }
    ]
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int outTex = backend->createTexture(W, H, RGBA8);

  auto run = [&](bool dirty) -> double {
    int32_t h = driver.execute(&rt, sketch, /*inTex*/-1, outTex, (int)W, (int)H, 1.0/60.0, dirty);
    backend->submit();
    return mean_rgb(backend->readbackTexture(h, W, H));
  };

  const double m1 = run(true);            // dirty (re-issue) — the burst
  double m2 = 0;
  for (int f = 0; f < 3; ++f) m2 = run(false);  // clean frames — steady state

  // Red 0.4 ≈ 102/255; the R channel alone gives mean_rgb ≈ 34 at identity.
  // brightness=+1 must lift it well above that on BOTH dirty and clean frames.
  INFO("dirty " << m1 << "  clean " << m2);
  CHECK(m1 > 50.0);   // brightened on the dirty frame
  CHECK(m2 > 50.0);   // STILL brightened on clean frames (not collapsed to passthrough)
  CHECK(std::abs(m1 - m2) < 2.0);  // identical frame-to-frame (no flicker)
}

TEST_CASE("util.dashboard pure-output knob publishes its authored value", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  // White input → dashboard (knob_0 = 0.5, no input wire) → brightness_contrast.
  // The knob's AUTHORED value drives brightness via the output wire: 0.5 folds to
  // neutral, contrast -0.5 → gray. If the authored knob value doesn't reach the
  // wire, brightness stays its stored 1.0 → white.
  const std::string sketch = R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash@0" },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "bc@0" }
    ],
    "instances": {
      "dash@0": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } },
      "bc@0": { "module_type": "color.tone.brightness_contrast",
                "state": { "brightness": 1.0, "contrast": -0.5 } }
    },
    "wires": [
      { "id": "wout", "src": { "instanceKey": "dash@0", "field": "knob_0" },
        "dest": { "instanceKey": "bc@0", "field": "brightness" } }
    ]
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 255);  // white
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(&rt, &registry, backend.get());
  auto j = nlohmann::json::parse(sketch);
  int32_t h = ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto out = backend->readbackTexture(h, W, H);
  REQUIRE(out.size() == W * H * 4);

  const double m = mean_rgb(out);
  INFO("output mean " << m << " (gray~128 = knob drove brightness; white~255 = wire dropped)");
  CHECK(m < 200.0);            // not white — the knob value reached brightness
  CHECK(std::abs(m - 128.0) < 24.0);  // gray
}

TEST_CASE("multiple wires into one field accumulate per combine (not last-wins)", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 255);  // white
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  // Read the folded value of so@0/out_0 directly from modulation telemetry — no
  // brittle pixel math. Two `add` knobs (0.3 + 0.3) into out_0 must SUM to ~0.6;
  // under the old last-wins fold only the last wire survived ⇒ ~0.3.
  auto outVal = [&](const std::string& sketch) -> double {
    SketchExecutor ex(&rt, &registry, backend.get());
    auto j = nlohmann::json::parse(sketch);
    ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    const auto& md = ex.lastModulationData();
    REQUIRE(md.contains("so@0"));
    REQUIRE(md["so@0"].contains("out_0"));
    return md["so@0"]["out_0"].value("value", -1.0);
  };

  const double one = outVal(R"JSON({
    "chain": [
      { "type":"module","module_type":"util.dashboard","instance_key":"d1@0" },
      { "type":"module","module_type":"util.sketch_output","instance_key":"so@0" }
    ],
    "instances": {
      "d1@0": { "module_type":"util.dashboard","state":{ "knob_0":0.3 } },
      "so@0": { "module_type":"util.sketch_output","state":{} }
    },
    "wires": [
      { "id":"w1","combine":"add","src":{"instanceKey":"d1@0","field":"knob_0"},"dest":{"instanceKey":"so@0","field":"out_0"} }
    ]
  })JSON");

  const double two = outVal(R"JSON({
    "chain": [
      { "type":"module","module_type":"util.dashboard","instance_key":"d1@0" },
      { "type":"module","module_type":"util.dashboard","instance_key":"d2@0" },
      { "type":"module","module_type":"util.sketch_output","instance_key":"so@0" }
    ],
    "instances": {
      "d1@0": { "module_type":"util.dashboard","state":{ "knob_0":0.3 } },
      "d2@0": { "module_type":"util.dashboard","state":{ "knob_0":0.3 } },
      "so@0": { "module_type":"util.sketch_output","state":{} }
    },
    "wires": [
      { "id":"w1","combine":"add","src":{"instanceKey":"d1@0","field":"knob_0"},"dest":{"instanceKey":"so@0","field":"out_0"} },
      { "id":"w2","combine":"add","src":{"instanceKey":"d2@0","field":"knob_0"},"dest":{"instanceKey":"so@0","field":"out_0"} }
    ]
  })JSON");

  INFO("one wire " << one << "  two wires " << two);
  CHECK(std::abs(one - 0.3) < 0.05);  // single wire = the knob value
  CHECK(std::abs(two - 0.6) < 0.05);  // two `add` wires SUM (was 0.3 under last-wins)
}

TEST_CASE("a delayed wire keeps its history when a sibling wire shares the field",
          "[executor_wasm]") {
  // Delay-line state must be per WIRE: with the old per-(instance,field) key,
  // a zero-delay wire into the same field ran applyModDelay's pass-through
  // erase every frame, wiping the delayed sibling's line — its `delay` then
  // read back the just-pushed sample, i.e. never delayed at all.
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  // d1.knob_0 --add--------------------> so.out_0   (no delay)
  // d2.knob_0 --add, delay 0.1s-------> so.out_0
  auto sketchWith = [](double knob2) {
    auto j = nlohmann::json::parse(R"JSON({
      "chain": [
        { "type":"module","module_type":"util.dashboard","instance_key":"d1@0" },
        { "type":"module","module_type":"util.dashboard","instance_key":"d2@0" },
        { "type":"module","module_type":"util.sketch_output","instance_key":"so@0" }
      ],
      "instances": {
        "d1@0": { "module_type":"util.dashboard","state":{ "knob_0":0.2 } },
        "d2@0": { "module_type":"util.dashboard","state":{ "knob_0":0.0 } },
        "so@0": { "module_type":"util.sketch_output","state":{} }
      },
      "wires": [
        { "id":"w1","combine":"add","src":{"instanceKey":"d1@0","field":"knob_0"},"dest":{"instanceKey":"so@0","field":"out_0"} },
        { "id":"w2","combine":"add","mod":{"delay":0.1},"src":{"instanceKey":"d2@0","field":"knob_0"},"dest":{"instanceKey":"so@0","field":"out_0"} }
      ]
    })JSON");
    j["instances"]["d2@0"]["state"]["knob_0"] = knob2;
    return j;
  };
  SketchExecutor ex(&rt, &registry, backend.get());
  auto outVal = [&](nlohmann::json& j, bool dirty) -> double {
    ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, dirty);
    backend->submit();
    const auto& md = ex.lastModulationData();
    REQUIRE(md.contains("so@0"));
    REQUIRE(md["so@0"].contains("out_0"));
    return md["so@0"]["out_0"].value("value", -1.0);
  };

  // Settle well past the 0.1s delay with d2 at 0 → out = 0.2 + delayed(0).
  auto flat = sketchWith(0.0);
  outVal(flat, true);
  for (int i = 0; i < 10; ++i) outVal(flat, false);

  // Step d2 to 0.6. The delayed wire must still read the PRE-step value for
  // ~6 frames (0.1s at 60fps); a wiped line reads the new sample immediately.
  auto stepped = sketchWith(0.6);
  const double atStep = outVal(stepped, true);
  INFO("frame after step " << atStep << " (wiped delay line would read ~0.8)");
  CHECK(std::abs(atStep - 0.2) < 0.05);

  // ...and after the delay elapses the step arrives in full.
  for (int i = 0; i < 12; ++i) outVal(stepped, false);
  const double settled = outVal(stepped, false);
  INFO("settled " << settled);
  CHECK(std::abs(settled - 0.8) < 0.05);
}

TEST_CASE("signed return rail carries bipolar values (no clamp at the relay)", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);

  // A SIGNED rail the arrangement builds: a dashboard knob (an authored [0,1] source)
  // is prescaled to bipolar [-1,1] by the writer wire's remap, then folded into the
  // relay's `input` (relay widened to [-1,1]→[-1,1]). We read the rail input's folded
  // value from modulation telemetry (the relay's `output` is computed, so a downstream
  // wire can't see it without the web host's output mirroring). knob 0 → −1, 0.5 → 0,
  // 1 → +1. A clamp at the [0,1]-declared input field would pin knob 0 at 0 (the tell).
  auto railIn = [&](double knob) -> double {
    SketchExecutor ex(&rt, &registry, backend.get());
    const std::string sketch = std::string(R"JSON({
      "chain": [
        { "type":"module","module_type":"util.dashboard","instance_key":"d@0" },
        { "type":"module","module_type":"mod.shaper.remap","instance_key":"rail_r" },
        { "type":"module","module_type":"util.sketch_output","instance_key":"so@0" }
      ],
      "instances": {
        "d@0": { "module_type":"util.dashboard","state":{ "knob_0":)JSON") + std::to_string(knob) + R"JSON( } },
        "rail_r": { "module_type":"mod.shaper.remap","state":{ "input":0,"in_min":-1,"in_max":1,"out_min":-1,"out_max":1 } },
        "so@0": { "module_type":"util.sketch_output","state":{} }
      },
      "wires": [
        { "id":"w1","combine":"add","src":{"instanceKey":"d@0","field":"knob_0"},"dest":{"instanceKey":"rail_r","field":"input"},"mod":{"remap":{"inMin":0,"inMax":1,"outMin":-1,"outMax":1}} }
      ]
    })JSON";
    auto j = nlohmann::json::parse(sketch);
    ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
    backend->submit();
    const auto& md = ex.lastModulationData();
    REQUIRE(md.contains("rail_r"));
    REQUIRE(md["rail_r"].contains("input"));
    return md["rail_r"]["input"].value("value", -999.0);
  };

  const double lo = railIn(0.0), mid = railIn(0.5), hi = railIn(1.0);
  INFO("knob 0 → " << lo << "  0.5 → " << mid << "  1 → " << hi);
  CHECK(std::abs(lo + 1.0) < 0.05);   // bipolar −1 survived (a [0,1] clamp would give 0)
  CHECK(std::abs(mid - 0.0) < 0.05);  // bipolar 0 = centre
  CHECK(std::abs(hi - 1.0) < 0.05);   // bipolar +1
}

TEST_CASE("util.sketch_output captures a producer's scalar on an output trace", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  // White input → dashboard (knob_0 = 0.5, the PRODUCER) → util.sketch_output.
  // The wire writes the knob value INTO the sketch-output trace out_0. The image
  // is untouched (both effects are identity), and the written value surfaces as
  // modulation telemetry on so@0/out_0 (it never reaches pluginState — see the
  // web getValue→modulationData branch).
  const std::string sketch = R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash@0" },
      { "type": "module", "module_type": "util.sketch_output", "instance_key": "so@0" }
    ],
    "instances": {
      "dash@0": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } },
      "so@0": { "module_type": "util.sketch_output", "state": {} }
    },
    "wires": [
      { "id": "win", "src": { "instanceKey": "dash@0", "field": "knob_0" },
        "dest": { "instanceKey": "so@0", "field": "out_0" } }
    ]
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 255);  // white
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(&rt, &registry, backend.get());
  auto j = nlohmann::json::parse(sketch);
  int32_t h = ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto out = backend->readbackTexture(h, W, H);
  REQUIRE(out.size() == W * H * 4);

  // Image passes through untouched — sketch_output is identity.
  const double m = mean_rgb(out);
  INFO("output mean " << m << " (should be ~255 white — identity passthrough)");
  CHECK(m > 240.0);

  // The wire-written value reached out_0 and was recorded as modulation telemetry.
  const auto& md = ex.lastModulationData();
  REQUIRE(md.contains("so@0"));
  REQUIRE(md["so@0"].contains("out_0"));
  const double v = md["so@0"]["out_0"].value("value", -1.0);
  INFO("out_0 modulation value " << v << " (knob_0 = 0.5 folded into [0,1])");
  CHECK(std::abs(v - 0.5) < 0.1);
}

// An Art-Net card's channels come from the HOST (the ArtNetHost listener on
// native, the dev server's bridge on web) as injected scalars, which ride
// outside the sketch doc and never pass through the effect. Wires read them
// straight out of injectedScalars_, but the editor's output-trace charts read
// PUBLISHED state — and an identity card is alias-skipped before it could ever
// tick and publish. The executor publishes them on the effect's behalf
// (effrt_publish_scalar); without that the trace pins at 0 while the wire moves.
TEST_CASE("host-injected scalars reach an instance's published state", "[executor_wasm]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  const std::string sketch = R"JSON({
    "chain": [
      { "type": "module", "module_type": "control.artnet", "instance_key": "an@0" }
    ],
    "instances": {
      "an@0": { "module_type": "control.artnet",
                "state": { "universe": 1, "channel_count": 2 } }
    }
  })JSON";

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 255);
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(&rt, &registry, backend.get());
  ex.setInjectedScalar("an@0", "ch_0", 0.75f);
  auto j = nlohmann::json::parse(sketch);
  ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();

  auto* inst = rt.findInstance("control.artnet", "an@0");
  REQUIRE(inst != nullptr);
  auto published = nlohmann::json::parse(inst->publishedStateJson(), nullptr, false);
  REQUIRE(published.is_object());
  INFO("published state " << published.dump());
  CHECK(std::abs(published.value("ch_0", -1.0) - 0.75) < 1e-4);
  // Untouched channels stay absent rather than publishing a fabricated 0 —
  // an unfed channel is dormant, exactly as a never-heard universe is.
  CHECK_FALSE(published.contains("ch_1"));
}
