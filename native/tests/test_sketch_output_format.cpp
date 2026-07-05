// test_sketch_output_format.cpp — the per-sketch output-format override
// (top-level `outputFormat`: internal resolution multiplier/fixed + 8/16F
// working bit depth), end to end through SketchExecutor on a real Metal
// backend.
//
// Covers: the identity guard (no override → zero extra GPU passes, output
// lands directly in the caller's texture), internal-resolution derivation
// (multiplier + fixed + clamps) observed through the chain-entry hook, the
// final stretch/convert blit, 16F intermediates (format 3 pool textures),
// and the actual PRECISION win: a crush→expand contrast chain that bands at
// 8-bit quantized intermediates but round-trips losslessly through 16F.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

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

namespace {

double mean_rgb(const std::vector<uint8_t>& px) {
  long s = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { s += px[i] + px[i+1] + px[i+2]; n += 3; }
  return n ? (double)s / n : 0.0;
}

// One brightness_contrast stage.
nlohmann::json bcEntry(const std::string& key) {
  return nlohmann::json{
    {"type", "module"},
    {"module_type", "color.tone.brightness_contrast"},
    {"instance_key", key},
  };
}

nlohmann::json bcState(double brightness, double contrast) {
  return nlohmann::json{
    {"module_type", "color.tone.brightness_contrast"},
    {"state", {{"brightness", brightness}, {"contrast", contrast}}},
  };
}

// A linear chain of brightness_contrast stages with given (brightness,
// contrast) pairs, plus an optional top-level outputFormat.
nlohmann::json bcChainSketch(const std::vector<std::pair<double,double>>& stages,
                             const nlohmann::json& outputFormat = nullptr) {
  nlohmann::json chain = nlohmann::json::array();
  nlohmann::json instances = nlohmann::json::object();
  for (size_t i = 0; i < stages.size(); ++i) {
    const std::string key = "bc@" + std::to_string(i);
    chain.push_back(bcEntry(key));
    instances[key] = bcState(stages[i].first, stages[i].second);
  }
  nlohmann::json sk = {{"chain", chain}, {"instances", instances},
                       {"wires", nlohmann::json::array()}};
  if (!outputFormat.is_null()) sk["outputFormat"] = outputFormat;
  return sk;
}

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<ModuleRegistry> registry;

  bool init() {
    backend = gpu::createMetalBackend();
    if (!backend || backend->getBackend() != 0) return false;
    if (!bundles.init()) return false;
    rt = std::make_unique<EffectRuntime>(backend.get());
    registry = std::make_unique<ModuleRegistry>(rt.get());
    return bundles.loadBundleFile(CORE_WASM_PATH, *registry, backend.get(), nullptr) > 1;
  }
};

}  // namespace

TEST_CASE("no outputFormat: zero output blits, direct render into output",
          "[output_format]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device / core.wasm");

  const uint32_t W = 64, H = 64;
  const int RGBA8 = 1;
  int inTex = hx.backend->createTexture(W, H, RGBA8);
  int outTex = hx.backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 64);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  hx.backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
  auto sk = bcChainSketch({{0.4, 0.0}});
  int32_t h = ex.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
  hx.backend->submit();

  // The identity guard: the default path gained NO resample/convert pass and
  // the final stage wrote the caller's output texture directly.
  CHECK(ex.outputBlitCount() == 0);
  CHECK(h == outTex);
  auto px = hx.backend->readbackTexture(outTex, W, H);
  CHECK(mean_rgb(px) > mean_rgb(inPix) + 30.0);
}

TEST_CASE("resolution override renders internally scaled, output at host size",
          "[output_format]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device / core.wasm");

  const uint32_t W = 64, H = 64;
  const int RGBA8 = 1;
  int inTex = hx.backend->createTexture(W, H, RGBA8);
  int outTex = hx.backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 64);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  hx.backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());

  // Observe the chain's actual working textures via the chain-entry hook.
  int hookW = 0, hookH = 0, hookFmt = -2;
  ex.setChainEntryHook([&](int, int, int32_t, int32_t output, int, int) {
    if (output < 0) return;
    hookW = hx.backend->getTextureWidth(output);
    hookH = hx.backend->getTextureHeight(output);
    hookFmt = hx.backend->getTextureFormat(output);
  });

  SECTION("multiplier 0.5") {
    auto sk = bcChainSketch({{0.4, 0.0}},
        {{"resolution", {{"mode", "multiplier"}, {"scale", 0.5}}}});
    int32_t h = ex.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    hx.backend->submit();
    CHECK(hookW == 32);
    CHECK(hookH == 32);
    CHECK(ex.outputBlitCount() == 1);
    CHECK(h == outTex);
    // A flat image survives the downscale+stretch with its mean intact.
    auto px = hx.backend->readbackTexture(outTex, W, H);
    CHECK(mean_rgb(px) > mean_rgb(inPix) + 30.0);
  }

  SECTION("fixed 16x24 (aspect-ignoring stretch)") {
    auto sk = bcChainSketch({{0.4, 0.0}},
        {{"resolution", {{"mode", "fixed"}, {"width", 16}, {"height", 24}}}});
    ex.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    hx.backend->submit();
    CHECK(hookW == 16);
    CHECK(hookH == 24);
    CHECK(ex.outputBlitCount() == 1);
  }

  SECTION("clamps: tiny scale floors at 8, huge fixed caps at 8192") {
    auto skTiny = bcChainSketch({{0.4, 0.0}},
        {{"resolution", {{"mode", "multiplier"}, {"scale", 0.01}}}});
    ex.execute(skTiny, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    hx.backend->submit();
    // scale clamps to 0.1 → 6.4 → rounds to 6 → dim floor 8.
    CHECK(hookW == 8);
    CHECK(hookH == 8);

    // The parse-time cap only (don't allocate an 8k texture in the test):
    // fixed 100000x16 clamps the width to 8192.
    auto skBig = bcChainSketch({{0.4, 0.0}},
        {{"resolution", {{"mode", "fixed"}, {"width", 100000}, {"height", 16}}}});
    ex.execute(skBig, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
    hx.backend->submit();
    CHECK(hookW == 8192);
    CHECK(hookH == 16);
  }

  // A present-but-non-number value must NOT abort the executor: JSON.stringify
  // serializes a NaN/Infinity scale to `null`, and nlohmann's value<double>()
  // throws on that (→ WASM `unreachable`). parseOutputFormat now reads defensively
  // and falls back to the host size, exactly like the TS resolveInternalResolution.
  SECTION("malformed numbers fall back to host size instead of aborting") {
    const nlohmann::json badCases[] = {
      {{"resolution", {{"mode", "multiplier"}, {"scale", nullptr}}}},
      {{"resolution", {{"mode", "multiplier"}, {"scale", "0.5"}}}},
      {{"resolution", {{"mode", "fixed"}, {"width", nullptr}, {"height", 24}}}},
      {{"resolution", {{"mode", nullptr}}}},
      {{"bitDepth", nullptr}},
    };
    for (const auto& of : badCases) {
      hookW = hookH = 0;
      auto sk = bcChainSketch({{0.4, 0.0}}, of);
      int32_t h = ex.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
      hx.backend->submit();
      // Survived (no abort) and rendered at the host size with no resample pass.
      CHECK(h == outTex);
      CHECK(hookW == (int)W);
      CHECK(hookH == (int)H);
      CHECK(ex.outputBlitCount() == 0);
    }
  }
}

TEST_CASE("16F bit depth: format-3 intermediates, 8-bit output, no banding",
          "[output_format]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device / core.wasm");

  // Horizontal ramp input, 256 px wide so every 8-bit level appears once.
  const uint32_t W = 256, H = 8;
  const int RGBA8 = 1;
  int inTex = hx.backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 0);
  for (uint32_t y = 0; y < H; ++y)
    for (uint32_t x = 0; x < W; ++x) {
      size_t i = (size_t)(y * W + x) * 4;
      inPix[i] = inPix[i+1] = inPix[i+2] = (uint8_t)x;
      inPix[i+3] = 255;
    }
  hx.backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  // Crush the range to a quarter (contrast -0.75 → 0.25x around mid-gray),
  // then re-expand with two 2x stages (contrast +1 each). Executed as three
  // separate dispatches (fusion off), the intermediates quantize: at 8-bit
  // the crushed image has only ~64 levels, so the re-expanded ramp BANDS in
  // 4-LSB steps; 16F intermediates carry the precision through.
  const std::vector<std::pair<double,double>> stages =
      {{0.0, -0.75}, {0.0, 1.0}, {0.0, 1.0}};

  auto distinctLevels = [&](const std::vector<uint8_t>& px) {
    std::set<uint8_t> lv;
    for (uint32_t x = 0; x < W; ++x) lv.insert(px[(size_t)x * 4]);  // row 0, R
    return (int)lv.size();
  };

  SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
  ex.setFusionEnabled(false);  // fused chains compute in registers — the
                               // intermediates must be REAL textures here

  int fmtSeen = -2;
  ex.setChainEntryHook([&](int, int, int32_t, int32_t output, int, int) {
    if (output >= 0) fmtSeen = hx.backend->getTextureFormat(output);
  });

  int out8 = hx.backend->createTexture(W, H, RGBA8);
  auto sk8 = bcChainSketch(stages);
  ex.execute(sk8, inTex, out8, (int)W, (int)H, 1.0/60.0, true);
  hx.backend->submit();
  auto px8 = hx.backend->readbackTexture(out8, W, H);
  const int levels8 = distinctLevels(px8);

  int out16 = hx.backend->createTexture(W, H, RGBA8);
  auto sk16 = bcChainSketch(stages, {{"bitDepth", 16}});
  ex.execute(sk16, inTex, out16, (int)W, (int)H, 1.0/60.0, true);
  hx.backend->submit();
  // Mid-chain intermediates (the hook fires per stage; the last observed
  // non-final output is a pool texture) must be RGBA16F (format code 3).
  CHECK(fmtSeen == 3);
  CHECK(ex.outputBlitCount() == 1);
  auto px16 = hx.backend->readbackTexture(out16, W, H);
  const int levels16 = distinctLevels(px16);

  INFO("distinct ramp levels — 8-bit: " << levels8 << ", 16F: " << levels16);
  CHECK(levels8 < 100);    // quantized intermediates band the ramp
  CHECK(levels16 > 180);   // 16F round-trips the crush/expand ~losslessly
}

// The barrel preview path scales capture textures with MPS into an RGBA8
// scratch and reads back at 4 bytes/px. Under a 16F sketch the captured
// chain-entry textures are rgba16float — the scaler must convert, not
// reinterpret. (Fallback if this ever breaks on some GPU: pre-convert via a
// blit before scaling — see host_output_blit.h.)
TEST_CASE("preview scaled readback converts a 16F source to 8-bit",
          "[output_format]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  const uint32_t W = 64, H = 64;
  const int RGBA16F = 3;
  int tex = backend->createTexture(W, H, RGBA16F);
  REQUIRE(tex >= 0);
  backend->clearTexture(tex, 0.25f, 0.5f, 0.75f, 1.0f);
  backend->submit();

  auto px = backend->readbackTextureScaled(tex, W, H, 32, 32);
  REQUIRE(px.size() == 32 * 32 * 4);
  // Flat color survives the scale+convert: every pixel ≈ (64, 128, 191, 255).
  long r = 0, g = 0, b = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; }
  const double n = 32.0 * 32.0;
  CHECK(std::abs(r / n - 64.0) < 4.0);
  CHECK(std::abs(g / n - 128.0) < 4.0);
  CHECK(std::abs(b / n - 191.0) < 4.0);
}

TEST_CASE("partial opacity blends into 16F intermediates", "[output_format]") {
  Harness hx;
  if (!hx.init()) SKIP("No Metal device / core.wasm");

  const uint32_t W = 32, H = 32;
  const int RGBA8 = 1;
  int inTex = hx.backend->createTexture(W, H, RGBA8);
  int outTex = hx.backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 64);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  hx.backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());
  const double inMean = mean_rgb(inPix);

  // One strongly-brightening stage at 50% wet/dry — the blend pass writes a
  // 16F pool texture (exercises the per-format WetDryBlend PSO path).
  auto sk = bcChainSketch({{1.0, 0.0}}, {{"bitDepth", 16}});
  sk["instances"]["bc@0"]["state"]["__opacity__"] = 0.5;

  SketchExecutor ex(hx.rt.get(), hx.registry.get(), hx.backend.get());
  ex.execute(sk, inTex, outTex, (int)W, (int)H, 1.0/60.0, true);
  hx.backend->submit();
  auto px = hx.backend->readbackTexture(outTex, W, H);
  const double outMean = mean_rgb(px);
  INFO("in " << inMean << " out " << outMean);
  // Halfway between the input and a hard-brightened (≈255) image.
  CHECK(outMean > inMean + 30.0);
  CHECK(outMean < 240.0);
}
