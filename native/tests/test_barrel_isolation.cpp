// test_barrel_isolation.cpp — proves the core correctness mechanism of the
// shared-runtime migration: many SketchExecutors share ONE EffectRuntime, and
// per-instance effect state stays isolated by namespacing each executor's
// instance keys (SketchExecutor::setKeyNamespace, the barrel UUID prefix).
//
// Two executors render sketches whose effects use the SAME bare instance_key
// ("bc@0"). Without namespacing both would collide on the pool key
// `type|bc@0` and share one EffectInstance (barrel A's state would bleed into
// barrel B). With namespacing they map to `type|A@bc@0` and `type|B@bc@0` —
// two distinct pool entries. We assert the pool grows to two, that the two
// renders are independent, and that destroyInstancesWithKeyPrefix frees only
// the matching namespace (the per-barrel teardown path).

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;
using sketch_executor::ModuleRegistry;
using sketch_executor::SketchExecutor;
using sketch_executor::WasmEffectBundles;

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

static double mean_rgb(const std::vector<uint8_t>& px) {
  long s = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { s += px[i] + px[i+1] + px[i+2]; n += 3; }
  return n ? (double)s / n : 0.0;
}

// brightness_contrast at a given brightness, keyed "bc@0" in BOTH executors so
// the only thing keeping them apart is the namespace.
static std::string brightSketch(double brightness) {
  return std::string(R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "bc@0" } ],
    "instances": { "bc@0": { "module_type": "color.tone.brightness_contrast",
                             "state": { "brightness": )JSON") +
         std::to_string(brightness) + R"JSON(, "contrast": 0.0 } } },
    "wires": []
  })JSON";
}

TEST_CASE("two namespaced executors isolate effect state in one shared runtime",
          "[barrel_isolation]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  // ONE runtime + effect set, shared by both executors (the dylib model).
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  REQUIRE(rt.instancePoolSize() == 0);

  SketchExecutor exA(&rt, &registry, backend.get());
  SketchExecutor exB(&rt, &registry, backend.get());
  exA.setKeyNamespace("A@");
  exB.setKeyNamespace("B@");

  const uint32_t W = 32, H = 32, RGBA8 = 1;
  int inTex  = backend->createTexture(W, H, RGBA8);
  int outA   = backend->createTexture(W, H, RGBA8);
  int outB   = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 96);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);

  // A brightens hard (→ near white); B leaves the image alone.
  auto skA = nlohmann::json::parse(brightSketch(1.0));
  auto skB = nlohmann::json::parse(brightSketch(0.0));

  int32_t hA = exA.execute(skA, inTex, outA, (int)W, (int)H, 1.0 / 60.0, true);
  int32_t hB = exB.execute(skB, inTex, outB, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();

  auto pxA = backend->readbackTexture(hA, W, H);
  auto pxB = backend->readbackTexture(hB, W, H);
  REQUIRE(pxA.size() == W * H * 4);
  REQUIRE(pxB.size() == W * H * 4);

  // The bare key "bc@0" collides; namespacing must have produced TWO distinct
  // pooled instances (A@bc@0, B@bc@0) — not one shared one.
  CHECK(rt.instancePoolSize() == 2);

  // Independent renders: A brightened well past the input, B did not.
  INFO("A mean " << mean_rgb(pxA) << "  B mean " << mean_rgb(pxB)
       << "  in mean " << inMean);
  CHECK(mean_rgb(pxA) > inMean + 20.0);
  CHECK(mean_rgb(pxB) <= inMean + 5.0);

  SECTION("prefix teardown frees only the matching namespace") {
    rt.destroyInstancesWithKeyPrefix("A@");
    CHECK(rt.instancePoolSize() == 1);  // only B@bc@0 remains

    // B still renders (its instance survived); re-running B does NOT grow the
    // pool (reuses B@bc@0), confirming the surviving entry is B's.
    int32_t hB2 = exB.execute(skB, inTex, outB, (int)W, (int)H, 1.0 / 60.0, false);
    backend->submit();
    (void)hB2;
    CHECK(rt.instancePoolSize() == 1);

    // A re-renders fresh: its instance was freed, so this re-creates A@bc@0 and
    // the pool grows back to two.
    int32_t hA2 = exA.execute(skA, inTex, outA, (int)W, (int)H, 1.0 / 60.0, false);
    backend->submit();
    (void)hA2;
    CHECK(rt.instancePoolSize() == 2);
  }
}

// Regression: a final passthrough/identity stage lands its result in the output
// via a copy. The barrel's output is a BGRA8 interop while intermediates are
// RGBA8, so a raw cross-format blit byte-copies and swaps R/B (a red sketch went
// blue). The copy must instead go through a format-correct render. Existing tests
// all use RGBA8 outputs, so they never exercised the mismatch — hence this one
// pins a BGRA8 output and compares the copy path against a direct render.
TEST_CASE("final passthrough copies into a BGRA output without swapping R/B",
          "[barrel_isolation]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);

  const uint32_t W = 32, H = 32;
  const int RGBA8 = 1, BGRA8 = 0;
  int inTex   = backend->createTexture(W, H, RGBA8);
  int outRef  = backend->createTexture(W, H, BGRA8);   // matches the barrel interop
  int outCopy = backend->createTexture(W, H, BGRA8);
  // Red overall (R/B distinct → a swap is unmistakable) AND a vertical gradient
  // in G (Y-asymmetric → a Y-flip is unmistakable too).
  std::vector<uint8_t> inPix(W * H * 4, 0);
  for (uint32_t y = 0; y < H; ++y)
    for (uint32_t x = 0; x < W; ++x) {
      size_t i = (size_t)(y * W + x) * 4;
      inPix[i] = 255;                                  // R
      inPix[i + 1] = (uint8_t)(y * 255 / (H - 1));     // G ramps top→bottom
      inPix[i + 3] = 255;
    }
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  // Reference: one non-identity stage renders DIRECTLY into the BGRA output.
  const std::string direct = R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "a" } ],
    "instances": { "a": { "module_type": "color.tone.brightness_contrast",
                          "state": { "brightness": 0.2, "contrast": 0.0 } } }, "wires": [] })JSON";
  // Test: same visual result, but the FINAL stage is an identity at partial
  // opacity → fusion-ineligible → standalone → identity-skip → copy-to-output.
  const std::string viaCopy = R"JSON({
    "chain": [ { "module_type": "color.tone.brightness_contrast", "instance_key": "a" },
               { "module_type": "color.tone.brightness_contrast", "instance_key": "b" } ],
    "instances": { "a": { "module_type": "color.tone.brightness_contrast",
                          "state": { "brightness": 0.2, "contrast": 0.0 } },
                   "b": { "module_type": "color.tone.brightness_contrast",
                          "state": { "brightness": 0.0, "contrast": 0.0, "__opacity__": 0.9 } } },
    "wires": [] })JSON";

  SketchExecutor ex(&rt, &registry, backend.get());

  auto jd = nlohmann::json::parse(direct);
  int32_t hd = ex.execute(jd, inTex, outRef, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto ref = backend->readbackTexture(hd, W, H);

  auto jc = nlohmann::json::parse(viaCopy);
  int32_t hc = ex.execute(jc, inTex, outCopy, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  auto got = backend->readbackTexture(hc, W, H);

  REQUIRE(ref.size() == W * H * 4);
  REQUIRE(got.size() == W * H * 4);
  // The trailing identity is a pure passthrough, so the copy path must produce
  // the SAME bytes as the direct render. A raw cross-format blit would swap R/B.
  size_t diffs = 0;
  for (size_t i = 0; i < got.size(); ++i) {
    int d = (int)got[i] - (int)ref[i];
    if (d < -2 || d > 2) ++diffs;
  }
  INFO("ref bgra[0..2]=" << (int)ref[0] << "," << (int)ref[1] << "," << (int)ref[2]
       << "  got bgra[0..2]=" << (int)got[0] << "," << (int)got[1] << "," << (int)got[2]);
  CHECK(diffs == 0);
}
