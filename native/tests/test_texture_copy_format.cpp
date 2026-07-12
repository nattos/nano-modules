// test_texture_copy_format.cpp — gpu::Device::copy must be channel-order
// correct across a pixel-format boundary.
//
// Regression: "wires out of util.dashboard / control.barrel_macros invert the
// colours (blue -> orange) everywhere, even for effects the wire doesn't touch."
//
// Both effects are identity texture passthroughs whose render() does
// gpu::Device::copy(tex_in, tex_out). An UNwired instance is identity-skipped
// (render() never runs), but ANY wire puts a tap on the entry, which disables
// the identity skip and makes render() run. Device::copy was a RAW BYTE blit,
// and in the barrel the chain's in/out textures are BGRA8 (FFGL interop) while
// the executor's intermediates are RGBA8 — same bytes/pixel, so Metal blits
// them happily and R/B come out swapped. The wire's value and destination are
// irrelevant; its mere presence flips the render path.
//
// These mirror the barrel: BGRA8 (format 0) in/out, RGBA8 intermediates, and
// compare the SAME chain with and without a wire. The all-RGBA8 control pins
// that the fault is the format boundary, not the unfused path.

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <fstream>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

using effect_runtime::EffectRuntime;

namespace {

std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

constexpr int kFmtBGRA8 = 0;
constexpr int kFmtRGBA8 = 1;

// Mean of the center region, returned as LOGICAL r,g,b for a texture whose
// bytes are in `fmt` order.
std::array<double, 3> logical_rgb(const std::vector<uint8_t>& px,
                                  uint32_t W, uint32_t H, int fmt) {
  double c0 = 0, c1 = 0, c2 = 0;
  int n = 0;
  for (uint32_t y = H / 4; y < H - H / 4; ++y) {
    for (uint32_t x = W / 4; x < W - W / 4; ++x) {
      size_t i = (y * W + x) * 4;
      c0 += px[i]; c1 += px[i + 1]; c2 += px[i + 2];
      ++n;
    }
  }
  c0 /= n; c1 /= n; c2 /= n;
  // BGRA bytes: [0]=B [1]=G [2]=R. RGBA bytes: [0]=R [1]=G [2]=B.
  if (fmt == kFmtBGRA8) return {c2, c1, c0};
  return {c0, c1, c2};
}

}  // namespace

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

// ---------------------------------------------------------------------------
// Case 1: dashboard is the FIRST chain entry, downstream of the sketch's BGRA8
// input texture. Its render() raw-copies BGRA8 input -> RGBA8 intermediate.
// The wire's DEST is the SECOND effect — the dashboard is only the source.
// ---------------------------------------------------------------------------
TEST_CASE("wire out of util.dashboard keeps channel order across a BGRA8 boundary",
          "[texture_copy_format]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  // Barrel-like: BGRA8 interop in/out.
  int inTex  = backend->createTexture(W, H, kFmtBGRA8);
  int outTex = backend->createTexture(W, H, kFmtBGRA8);
  REQUIRE(inTex >= 0); REQUIRE(outTex >= 0);

  // Azure blue (r=0, g=128, b=255) written in BGRA byte order.
  std::vector<uint8_t> blue(W * H * 4);
  for (size_t i = 0; i + 3 < blue.size(); i += 4) {
    blue[i + 0] = 255;  // B
    blue[i + 1] = 128;  // G
    blue[i + 2] = 0;    // R
    blue[i + 3] = 255;  // A
  }
  backend->writeTexture(inTex, W, H, blue.data(), (uint32_t)blue.size());

  // chain: dashboard -> bc(#1) -> bc2(#2). The wire (when present) goes from
  // the dashboard to the SECOND effect only.
  const char* kNoWire = R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash",
        "params": { "knob_0": 0.5 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx1",
        "params": { "brightness": 0.0, "contrast": 0.0 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx2",
        "params": { "brightness": 0.0, "contrast": 0.0 } }
    ],
    "instances": { "dash": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } } }
  })JSON";

  const char* kWire = R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash",
        "params": { "knob_0": 0.5 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx1",
        "params": { "brightness": 0.0, "contrast": 0.0 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx2",
        "params": { "brightness": 0.0, "contrast": 0.0 } }
    ],
    "instances": { "dash": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } } },
    "wires": [
      { "id": "w0", "src": { "instanceKey": "dash", "field": "knob_0" },
                    "dest": { "instanceKey": "fx2", "field": "brightness" } }
    ]
  })JSON";

  auto run = [&](const char* js) {
    auto sketch = nlohmann::json::parse(js);
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H,
                                   1.0 / 60.0, /*sketchDirty=*/true);
    backend->submit();
    int fmt = backend->getTextureFormat(out);
    auto px = backend->readbackTexture(out, W, H);
    return logical_rgb(px, W, H, fmt);
  };

  auto base = run(kNoWire);
  INFO("no wire   rgb " << base[0] << "," << base[1] << "," << base[2]);
  CHECK(base[2] > 200.0);  // blue channel dominant
  CHECK(base[0] < 60.0);   // red near zero

  auto wired = run(kWire);
  INFO("with wire rgb " << wired[0] << "," << wired[1] << "," << wired[2]);
  // The wire only targets fx2's brightness (a NEUTRAL fold at knob 0.5), so the
  // image must be unchanged.
  CHECK(wired[2] > 200.0);  // <-- expected to FAIL if R/B swaps (blue -> orange)
  CHECK(wired[0] < 60.0);
}

// ---------------------------------------------------------------------------
// Control: the IDENTICAL wired chain with RGBA8 in/out textures (no BGRA
// anywhere). If this passes, the swap is caused purely by the format-crossing
// raw copy, NOT by tap-disqualified fusion / blend-uniform / blend-mode paths.
// ---------------------------------------------------------------------------
TEST_CASE("control: same wired dashboard chain, all-RGBA8, no swap",
          "[texture_copy_format]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  int inTex  = backend->createTexture(W, H, kFmtRGBA8);
  int outTex = backend->createTexture(W, H, kFmtRGBA8);
  std::vector<uint8_t> blue(W * H * 4);
  for (size_t i = 0; i + 3 < blue.size(); i += 4) {
    blue[i + 0] = 0; blue[i + 1] = 128; blue[i + 2] = 255; blue[i + 3] = 255;
  }
  backend->writeTexture(inTex, W, H, blue.data(), (uint32_t)blue.size());

  auto sketch = nlohmann::json::parse(R"JSON({
    "chain": [
      { "type": "module", "module_type": "util.dashboard", "instance_key": "dash",
        "params": { "knob_0": 0.5 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx1",
        "params": { "brightness": 0.0, "contrast": 0.0 } },
      { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx2",
        "params": { "brightness": 0.0, "contrast": 0.0 } }
    ],
    "instances": { "dash": { "module_type": "util.dashboard", "state": { "knob_0": 0.5 } } },
    "wires": [
      { "id": "w0", "src": { "instanceKey": "dash", "field": "knob_0" },
                    "dest": { "instanceKey": "fx2", "field": "brightness" } }
    ]
  })JSON");
  int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H,
                                 1.0 / 60.0, true);
  backend->submit();
  auto rgb = logical_rgb(backend->readbackTexture(out, W, H), W, H,
                         backend->getTextureFormat(out));
  INFO("all-RGBA8 wired rgb " << rgb[0] << "," << rgb[1] << "," << rgb[2]);
  CHECK(rgb[2] > 200.0);
  CHECK(rgb[0] < 60.0);
}

// ---------------------------------------------------------------------------
// Case 2: control.barrel_macros as the LAST chain entry (its tex_out IS the
// caller's BGRA8 output texture; tex_in is an RGBA8 intermediate). Chain is a
// pure generator (no BGRA input), so this isolates the OUTPUT-side raw copy.
// ---------------------------------------------------------------------------
TEST_CASE("wire out of control.barrel_macros (last entry) keeps channel order",
          "[texture_copy_format]") {
  auto backend = gpu::createMetalBackend();
  if (!backend || backend->getBackend() != 0) SKIP("No Metal device available");

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, backend.get(), nullptr) > 1);
  sketch_executor::SketchExecutor executor(&rt, &registry, backend.get());

  const uint32_t W = 16, H = 16;
  int inTex  = backend->createTexture(W, H, kFmtRGBA8);
  int outTex = backend->createTexture(W, H, kFmtBGRA8);  // barrel interop output
  REQUIRE(outTex >= 0);
  std::vector<uint8_t> blk(W * H * 4, 0);
  backend->writeTexture(inTex, W, H, blk.data(), (uint32_t)blk.size());

  // solid azure-blue generator -> bc(#1) -> barrel_macros(last). Wire (when
  // present) from macro_0 to fx1.brightness.
  auto sketchFor = [](bool wire) {
    nlohmann::json s = nlohmann::json::parse(R"JSON({
      "chain": [
        { "type": "module", "module_type": "source.solid_color", "instance_key": "src",
          "params": { "color": [0.0, 0.5, 1.0] } },
        { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "fx1",
          "params": { "brightness": 0.0, "contrast": 0.0 } },
        { "type": "module", "module_type": "control.barrel_macros", "instance_key": "mac" }
      ],
      "instances": { "mac": { "module_type": "control.barrel_macros", "state": { "macro_0": 0.5 } } }
    })JSON");
    if (wire) {
      s["wires"] = nlohmann::json::parse(R"JSON([
        { "id": "w0", "src": { "instanceKey": "mac", "field": "macro_0" },
                      "dest": { "instanceKey": "fx1", "field": "brightness" } }
      ])JSON");
    }
    return s;
  };

  auto run = [&](bool wire) {
    auto sketch = sketchFor(wire);
    int32_t out = executor.execute(sketch, inTex, outTex, (int)W, (int)H,
                                   1.0 / 60.0, /*sketchDirty=*/true);
    backend->submit();
    int fmt = backend->getTextureFormat(out);
    auto px = backend->readbackTexture(out, W, H);
    return logical_rgb(px, W, H, fmt);
  };

  auto base = run(false);
  INFO("no wire   rgb " << base[0] << "," << base[1] << "," << base[2]);
  CHECK(base[2] > 200.0);
  CHECK(base[0] < 60.0);

  auto wired = run(true);
  INFO("with wire rgb " << wired[0] << "," << wired[1] << "," << wired[2]);
  CHECK(wired[2] > 200.0);  // <-- expected to FAIL if R/B swaps
  CHECK(wired[0] < 60.0);
}
