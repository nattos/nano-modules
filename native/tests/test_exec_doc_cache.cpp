// test_exec_doc_cache.cpp — goldens for the clean-frame exec-doc cache.
//
// The executor rebuilds its lowered execution doc (columns normalization,
// wire→tap lowering, augmentation) on DIRTY frames only and reuses it while
// the sketch is clean. These tests pin the states that must keep flowing
// across CLEAN frames — where a stale cache would silently freeze them:
//
//   1. A wire from a live producer (mod.source.lfo) keeps modulating on clean
//      frames — captureWriteTaps reads the producer's LIVE published state,
//      never a doc mirror.
//   2. Host-injected scalars (setInjectedScalar — the barrel's macro knobs)
//      flow through wires per frame without any doc mutation or dirty.
//   3. Toggling `__enable__` (a state edit → dirty frame) rebuilds correctly
//      in BOTH directions, and the post-toggle state holds on clean frames.
//   4. A structural edit (wire added) on a dirty frame takes effect.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
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

  double frame(const json& sketch, bool dirty, double dt = 1.0 / 60.0) {
    int out = executor->execute(sketch, inTex, outTex, (int)W, (int)H, dt, dirty);
    backend->submit();
    return mean_rgb(backend->readbackTexture(out, W, H));
  }
};

}  // namespace

TEST_CASE("exec-doc cache: live producer wires keep modulating on clean frames",
          "[exec_doc_cache]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  // Slow triangle LFO (unsynced) wired replace → brightness [-1,1]. As the LFO
  // sweeps 0→1 the folded brightness sweeps -1→1, so the frame luma must MOVE
  // across clean frames. contrast 0, white input: luma tracks brightness up.
  auto sketch = json::parse(R"({
    "chain": [
      { "module_type": "mod.source.lfo", "instance_key": "lfo",
        "params": { "waveform": 0, "rate": 1.0, "sync": 0, "amplitude": 1.0 } },
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [0.5,0.5,0.5] } },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
        "params": { "brightness": 0.0, "contrast": 0.0 } }
    ],
    "wires": [
      { "id": "w0", "src": { "instanceKey": "lfo", "field": "output" },
        "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" }
    ]
  })");

  const double m0 = h.frame(sketch, /*dirty=*/true);
  // Advance well within one LFO period on CLEAN frames only.
  double mPrev = m0;
  bool moved = false;
  for (int i = 0; i < 12; ++i) {
    const double m = h.frame(sketch, /*dirty=*/false, 1.0 / 30.0);
    if (std::abs(m - mPrev) > 1.0) moved = true;
    mPrev = m;
  }
  INFO("m0=" << m0 << " mLast=" << mPrev);
  // A frozen cache pins the wire at the dirty-frame value → no movement.
  CHECK(moved);
}

TEST_CASE("exec-doc cache: injected scalars (barrel macros) flow on clean frames",
          "[exec_doc_cache]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  auto sketch = json::parse(R"({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [0.5,0.5,0.5] } },
      { "module_type": "control.barrel_macros", "instance_key": "mac", "params": {} },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
        "params": { "brightness": 0.0, "contrast": 0.0 } }
    ],
    "wires": [
      { "id": "w0", "src": { "instanceKey": "mac", "field": "macro_0" },
        "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" }
    ]
  })");

  // Dirty frame with the knob at 0.5 → auto magnitude maps unsigned 0.5 to
  // brightness ~0 (neutral): mid grey.
  h.executor->setInjectedScalar("mac", "macro_0", 0.5f);
  const double mNeutral = h.frame(sketch, /*dirty=*/true);

  // Knob to 1.0 on a CLEAN frame → brightness +1 → much brighter. No doc
  // mutation, no dirty — the injected table alone must carry it.
  h.executor->setInjectedScalar("mac", "macro_0", 1.0f);
  const double mBright = h.frame(sketch, /*dirty=*/false);

  // And back down, still clean.
  h.executor->setInjectedScalar("mac", "macro_0", 0.0f);
  const double mDark = h.frame(sketch, /*dirty=*/false);

  INFO("neutral=" << mNeutral << " bright=" << mBright << " dark=" << mDark);
  CHECK(mBright > mNeutral + 40.0);
  CHECK(mDark < mNeutral - 40.0);
}

TEST_CASE("exec-doc cache: __enable__ toggles rebuild in both directions",
          "[exec_doc_cache]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  auto mk = [](bool enabled) {
    json sk = json::parse(R"({
      "chain": [
        { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [0.25,0.25,0.25] } },
        { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
          "params": { "brightness": 1.0, "contrast": 0.0 } }
      ],
      "instances": { "bc": { "module_type": "color.tone.brightness_contrast",
                             "state": { "brightness": 1.0 } } },
      "wires": []
    })");
    sk["instances"]["bc"]["state"]["__enable__"] = enabled;
    return sk;
  };

  // ON (dirty) → brightened; clean frames hold the same value.
  const double on0 = h.frame(mk(true), /*dirty=*/true);
  const double on1 = h.frame(mk(true), /*dirty=*/false);
  const double on2 = h.frame(mk(true), /*dirty=*/false);
  CHECK(on1 == Catch::Approx(on0).margin(2.0));
  CHECK(on2 == Catch::Approx(on0).margin(2.0));

  // OFF (state edit → dirty) → passthrough (much darker); clean frames hold.
  const double off0 = h.frame(mk(false), /*dirty=*/true);
  const double off1 = h.frame(mk(false), /*dirty=*/false);
  INFO("on=" << on0 << " off=" << off0);
  CHECK(off0 < on0 - 40.0);
  CHECK(off1 == Catch::Approx(off0).margin(2.0));

  // Back ON (dirty) → brightened again — the rebuild isn't one-way.
  const double on3 = h.frame(mk(true), /*dirty=*/true);
  CHECK(on3 == Catch::Approx(on0).margin(2.0));
}

TEST_CASE("exec-doc cache: a wire added on a dirty frame takes effect",
          "[exec_doc_cache]") {
  Harness h;
  if (!h.init()) SKIP("No Metal device available");

  json base = json::parse(R"({
    "chain": [
      { "module_type": "source.solid_color", "instance_key": "src", "params": { "color": [0.5,0.5,0.5] } },
      { "module_type": "control.barrel_macros", "instance_key": "mac", "params": {} },
      { "module_type": "color.tone.brightness_contrast", "instance_key": "bc",
        "params": { "brightness": 0.0, "contrast": 0.0 } }
    ],
    "wires": []
  })");

  h.executor->setInjectedScalar("mac", "macro_0", 1.0f);
  const double mNoWire = h.frame(base, /*dirty=*/true);
  const double mNoWireClean = h.frame(base, /*dirty=*/false);
  CHECK(mNoWireClean == Catch::Approx(mNoWire).margin(2.0));

  json wired = base;
  wired["wires"] = json::array({ json::parse(R"(
    { "id": "w0", "src": { "instanceKey": "mac", "field": "macro_0" },
      "dest": { "instanceKey": "bc", "field": "brightness" }, "combine": "replace" })") });
  const double mWired = h.frame(wired, /*dirty=*/true);
  const double mWiredClean = h.frame(wired, /*dirty=*/false);
  INFO("noWire=" << mNoWire << " wired=" << mWired);
  CHECK(mWired > mNoWire + 40.0);   // knob 1.0 → brightness +1
  CHECK(mWiredClean == Catch::Approx(mWired).margin(2.0));
}
