// test_barrel_render.cpp — the FFGL barrel's render path, everything except
// the texture share.
//
// What the plugin actually does per frame is five ABI calls into a library it
// loaded at runtime: register, acquire, ask for the GPU device, create an
// executor, render. Nothing else in the tree covers that path — test_barrel_
// isolation drives SketchExecutor directly, which skips the library boundary,
// the state document and the whole of BarrelRuntime.
//
// So this test is the plugin, minus GL. It loads libbridge_server through the
// same BridgeLoader the plugin uses, makes its input and output textures on
// the device the ABI hands back (barrel_probe_tex.h — the same format and bind
// flags as the interop pair, just not shared with GL), renders, and reads the
// pixels back. The one thing left unproven is whether those textures are also
// visible to OpenGL, which is what WGL_NV_DX_interop2 / IOSurface do and what
// no headless test can answer.
//
// It therefore fails for real on: a broken library load, a missing export, a
// device that isn't the backend's, a texture the backend cannot adopt, a
// wrong-way bind flag, a sketch that doesn't reach the executor, a render that
// writes the wrong texture, and a passthrough reported as a write.

#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "plugin/bridge_loader.h"

#include "barrel_probe_tex.h"
#include "wasm_paths.h"

#ifndef BRIDGE_DYLIB_PATH
#error "BRIDGE_DYLIB_PATH must be defined at compile time"
#endif
#ifndef BARREL_WASM_DIR
#error "BARREL_WASM_DIR must be defined at compile time"
#endif

namespace {

constexpr int kW = 64;
constexpr int kH = 64;

// The wasm bundles live beside the binary under a staged run, exactly as they
// do beside the plugin. This is a DIRECTORY, so NANO_WASM_DIR replaces it
// outright — nanoStagedPath keeps a basename, which is right for the baked
// per-bundle FILE paths everywhere else and wrong here.
const char* wasmDir() {
  const char* env = std::getenv("NANO_WASM_DIR");
  return (env && *env) ? env : BARREL_WASM_DIR;
}

// Brightness 1.0 saturates whatever comes in; brightness -1.0 crushes it. Two
// sketches that cannot be confused for each other, or for "nothing ran".
std::string brightSketch(double brightness) {
  return std::string(R"JSON({
    "chain": [ { "type": "module",
                 "module_type": "color.tone.brightness_contrast",
                 "instance_key": "bc@0" } ],
    "instances": { "bc@0": { "module_type": "color.tone.brightness_contrast",
                             "state": { "brightness": )JSON") +
         std::to_string(brightness) + R"JSON(, "contrast": 0.0 } } },
    "wires": []
  })JSON";
}

double meanRgb(const std::vector<uint8_t>& px) {
  long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? (double)sum / n : 0.0;
}

// One barrel, set up the way the plugin sets one up. Teardown mirrors
// DeInitGL: destroy the executor, release the runtime, unregister.
struct Barrel {
  plugin::BridgeLoader loader;
  BridgeHandle h = nullptr;
  std::string key;
  void* device = nullptr;
  bool rt_ready = false;

  // Why start() failed, so a run with no GPU can skip while a run with a GPU
  // and no effects FAILS. A test that skips on both reports success having
  // done nothing, which is how a staged run hides a wrong bundle path.
  std::string failure;

  bool up() const { return h && rt_ready && device; }

  bool start(const char* requested_key) {
    // A real host never reads these pixels on the CPU: it hands the output
    // texture to GL, and the backend deliberately waits only until the frame is
    // SCHEDULED, leaving the cross-API ordering to the host's own glFlush
    // (metal_backend.mm's endSubmitBatch says so at length). A test IS a CPU
    // pixel consumer, so it has to ask for the blocking flush the same way the
    // backend's own readbackTexture does — otherwise every frame reads back the
    // PREVIOUS one, which looks exactly like an off-by-one in the engine.
    // Must be set before rt_acquire, which is what builds the backend.
    // (No-op on D3D11: Map(READ) on the immediate context is already ordered
    // behind everything queued ahead of it.)
#ifdef _WIN32
    _putenv_s("NANO_WAIT_COMPLETED", "1");
#else
    setenv("NANO_WAIT_COMPLETED", "1", 1);
#endif
    if (!loader.load(kBridgeLib)) return false;
    h = loader.bridge_init();
    if (!h) return false;

    char keybuf[128] = {0};
    const int n = loader.bridge_register_plugin(h, "com.nano.nanobarrel", 0, 1, 0,
                                                /*schema_json=*/"", requested_key,
                                                keybuf, sizeof(keybuf));
    key = (n > 0) ? std::string(keybuf, std::strlen(keybuf)) : std::string(requested_key);

    rt_ready = loader.bridge_rt_acquire(h, wasmDir(), "") != 0;
    device = loader.bridge_rt_gpu_device(h);
    if (!device) { failure = "no GPU device"; return false; }
    if (!rt_ready) {
      // The device came up, so this is not "no GPU" — the bundles are missing
      // or the path is wrong, and that is a failure, not an absence.
      failure = std::string("runtime acquired no effects from ") + wasmDir();
      return false;
    }
    loader.bridge_executor_create(h, key.c_str());
    return true;
  }

  void setSketch(const std::string& sketch_json) {
    loader.bridge_set_at(h, ("/plugins/" + key + "/state/sketch").c_str(),
                         sketch_json.c_str());
  }

  int render(void* in_tex, void* out_tex, bool dirty) {
    return renderAt(in_tex, out_tex, kW, kH, dirty);
  }

  // The viewport is the OUTPUT size. The input texture may be any size — the
  // plugin sizes its input interop from the host's input texture and its
  // output interop from the viewport, and nothing in FFGL says they agree.
  int renderAt(void* in_tex, void* out_tex, int w, int hgt, bool dirty) {
    const float macros[8] = {0};
    return loader.bridge_executor_render(h, key.c_str(), in_tex, out_tex, w, hgt,
                                         1.0 / 60.0, 0.0, dirty ? 1 : 0,
                                         macros, 8, 0.0, 120.0);
  }

  ~Barrel() {
    if (!h) return;
    if (rt_ready) {
      loader.bridge_executor_destroy(h, key.c_str());
      loader.bridge_rt_release(h);
    }
    loader.bridge_unregister_plugin(h, key.c_str());
    loader.bridge_release(h);
  }
};

}  // namespace

TEST_CASE("the barrel renders a sketch into a texture it made itself",
          "[barrel_render]") {
  Barrel b;
  if (!b.start("test-barrel-render")) {
    if (b.device) FAIL(b.failure);
    SKIP("no GPU device");
  }

  // The barrel builds its interop pair against THIS device, so the engine can
  // only render into it if it is the backend's own. A runtime that made a
  // second device of its own would pass every other assertion in this file and
  // fail only here.
  void* in_tex = barrel_probe::createTexture(b.device, kW, kH);
  void* out_tex = barrel_probe::createTexture(b.device, kW, kH);
  REQUIRE(in_tex != nullptr);
  REQUIRE(out_tex != nullptr);

  // Mid grey in, so both directions have somewhere to go.
  barrel_probe::fillTexture(b.device, in_tex, kW, kH, 128, 128, 128, 255);
  barrel_probe::fillTexture(b.device, out_tex, kW, kH, 0, 0, 0, 255);

  b.setSketch(brightSketch(1.0));
  const int usedBright = b.render(in_tex, out_tex, /*dirty=*/true);
  REQUIRE(usedBright == 1);

  std::vector<uint8_t> bright;
  REQUIRE(barrel_probe::readTexture(b.device, out_tex, kW, kH, bright));
  const double brightMean = meanRgb(bright);

  b.setSketch(brightSketch(-1.0));
  const int usedDark = b.render(in_tex, out_tex, /*dirty=*/true);
  REQUIRE(usedDark == 1);

  std::vector<uint8_t> dark;
  REQUIRE(barrel_probe::readTexture(b.device, out_tex, kW, kH, dark));
  const double darkMean = meanRgb(dark);

  INFO("bright mean " << brightMean << ", dark mean " << darkMean
                      << " (input was 128)");
  // Not "different from the input" — that would pass if the output stayed the
  // black it was cleared to. The two renders have to move the SAME input in
  // OPPOSITE directions, which only a real brightness_contrast dispatch does.
  REQUIRE(brightMean > 150.0);
  REQUIRE(darkMean < 110.0);

  barrel_probe::releaseTexture(in_tex);
  barrel_probe::releaseTexture(out_tex);
}

TEST_CASE("a sketch with no image producer reports passthrough",
          "[barrel_render]") {
  Barrel b;
  if (!b.start("test-barrel-passthrough")) {
    if (b.device) FAIL(b.failure);
    SKIP("no GPU device");
  }

  void* in_tex = barrel_probe::createTexture(b.device, kW, kH);
  void* out_tex = barrel_probe::createTexture(b.device, kW, kH);
  REQUIRE(in_tex != nullptr);
  REQUIRE(out_tex != nullptr);
  barrel_probe::fillTexture(b.device, in_tex, kW, kH, 200, 100, 50, 255);

  // An empty chain produces no image, so the runtime returns 0 and the plugin
  // presents its INPUT. Getting this backwards is not a subtle bug — the
  // barrel would blit an untouched output texture over the host's frame and
  // the clip would go black.
  b.setSketch(R"JSON({"chain": [], "instances": {}, "wires": []})JSON");
  REQUIRE(b.render(in_tex, out_tex, /*dirty=*/true) == 0);

  barrel_probe::releaseTexture(in_tex);
  barrel_probe::releaseTexture(out_tex);
}

TEST_CASE("the runtime publishes an effect catalog for the editor",
          "[barrel_render]") {
  Barrel b;
  if (!b.start("test-barrel-schemas")) {
    if (b.device) FAIL(b.failure);
    SKIP("no GPU device");
  }

  // publishSchemasIfReady() pushes this into the instance's state doc; without
  // it the editor's inspector and insert chips come up empty, which looks like
  // a UI bug and is really a missing bundle load.
  char* raw = b.loader.bridge_rt_schemas(b.h);
  REQUIRE(raw != nullptr);
  const std::string schemas(raw);
  b.loader.bridge_free_string(raw);

  REQUIRE(schemas.size() > 2);
  REQUIRE(schemas.find("color.tone.brightness_contrast") != std::string::npos);
}

// The runtime's input contract, which the first Windows Resolume run broke:
// the input arrived zoomed into a corner, while generators (which ignore the
// input) were fine. The cause was the PLUGIN sizing its input interop from the
// host texture while the executor renders at the viewport; macOS Resolume always handed a viewport-sized input, so it had
// never shown. The plugin now stretches the host input to the viewport in its
// GL blit (nano_barrel_plugin.cpp, ensureInterop), and nano_diag's ffgl probe
// drives that stretch end to end. What is pinned HERE is the runtime side:
//
//   at the viewport size, the WHOLE input frame reaches the effect, and the
//   effect actually runs on it — a gradient, so a crop or a flip shows; the
//   flat fill every earlier case used hides both.
//
// What the runtime does with a WRONG-sized input is deliberately not pinned:
// effects read their input by pixel position at the render size, so an input
// twice the viewport shows as its top-left quarter blown up 2x — the Windows
// "zoom" exactly. That is a contract violation the runtime now logs, not a
// behaviour to preserve.
namespace {

std::vector<uint8_t> gradientBgra(int w, int h) {
  // Red ramps left→right, green top→bottom, both 32..223.
  std::vector<uint8_t> bgra((size_t)w * h * 4);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      uint8_t* p = &bgra[((size_t)y * w + x) * 4];
      p[0] = 64;
      p[1] = (uint8_t)(32 + 191 * y / (h - 1));
      p[2] = (uint8_t)(32 + 191 * x / (w - 1));
      p[3] = 255;
    }
  return bgra;
}

}  // namespace

TEST_CASE("the whole input frame reaches the effect, and the effect runs on it",
          "[barrel_render]") {
  Barrel b;
  if (!b.start("test-barrel-gradient")) {
    if (b.device) FAIL(b.failure);
    SKIP("no GPU device");
  }
  void* in_tex = barrel_probe::createTexture(b.device, kW, kH);
  void* out_tex = barrel_probe::createTexture(b.device, kW, kH);
  REQUIRE(in_tex != nullptr);
  REQUIRE(out_tex != nullptr);
  const std::vector<uint8_t> grad = gradientBgra(kW, kH);
  barrel_probe::uploadTexture(b.device, in_tex, kW, kH, grad.data());

  // The geometry probe has to be NEAR-identity but not identity: brightness 0 /
  // contrast 0 is recognised as an identity stage and skipped, which reports
  // passthrough (0) and would make this test measure nothing.
  b.setSketch(brightSketch(0.02));
  REQUIRE(b.render(in_tex, out_tex, true) == 1);
  std::vector<uint8_t> id;
  REQUIRE(barrel_probe::readTexture(b.device, out_tex, kW, kH, id));
  auto at = [&](const std::vector<uint8_t>& px, int x, int y) {
    return &px[((size_t)y * kW + x) * 4];
  };
  const int rLeft = at(id, 1, kH / 2)[0], rRight = at(id, kW - 2, kH / 2)[0];
  const int gTop = at(id, kW / 2, 1)[1], gBottom = at(id, kW / 2, kH - 2)[1];
  INFO("R left " << rLeft << " right " << rRight << ", G top " << gTop
       << " bottom " << gBottom << " (input spans 32..223 on both)");
  // A 2x centre crop would pull both spans in to roughly 80..175.
  CHECK(rLeft < 60);
  CHECK(rRight > 195);
  CHECK(gTop < 60);        // row 0 is the top: not flipped
  CHECK(gBottom > 195);

  // And the effect does something to THIS input — not merely "returned 1".
  b.setSketch(brightSketch(0.5));
  REQUIRE(b.render(in_tex, out_tex, true) == 1);
  std::vector<uint8_t> lit;
  REQUIRE(barrel_probe::readTexture(b.device, out_tex, kW, kH, lit));
  INFO("mean at brightness 0.02: " << meanRgb(id) << ", at +0.5: " << meanRgb(lit));
  CHECK(meanRgb(lit) > meanRgb(id) + 20.0);

  barrel_probe::releaseTexture(in_tex);
  barrel_probe::releaseTexture(out_tex);
}
