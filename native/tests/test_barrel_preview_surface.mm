// test_barrel_preview_surface.mm — the barrel's shared-surface preview
// transport, end to end on the native side.
//
// The plugin path exactly as test_barrel_render drives it (BridgeLoader,
// acquire, executor, render into textures on the ABI's device), plus a
// WebSocket client standing in for the desktop editor: it observes the
// instance, asks for a preview with `"transport": "surface"`, and reads each
// NBPS announcement's surface BY TOKEN, the way the Electron addon does
// (IOSurfaceLookup). What must hold:
//
//   - frames arrive as NBPS on the MAIN socket, with no lane client at all;
//   - the surface holds this frame, scaled, upright, BGRA;
//   - the ring is the back-pressure: unreleased, at most kRing slots are ever
//     announced; `preview_release` frees them and frames resume.

#include <catch2/catch_test_macros.hpp>

#import <IOSurface/IOSurface.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "plugin/bridge_loader.h"

#include "barrel_probe_tex.h"
#include "wasm_paths.h"

using namespace std::chrono_literals;

namespace {

constexpr int kW = 64, kH = 64;
constexpr int kPort = 19141;
constexpr int kRing = 3;  // BarrelRuntime's kSurfaceRing

struct Nbps {
  int slot = 0;
  std::string key, traceId;
  int w = 0, h = 0;
  uint32_t seq = 0;
  uint64_t token = 0;
};

bool parseNbps(const std::string& b, Nbps& out) {
  if (b.size() < 26 || b.compare(0, 4, "NBPS") != 0 || (uint8_t)b[4] != 1) return false;
  auto u = [&](size_t off, int n) {
    uint64_t v = 0;
    for (int i = 0; i < n; ++i) v |= (uint64_t)(uint8_t)b[off + i] << (8 * i);
    return v;
  };
  out.slot = (uint8_t)b[5];
  const size_t keyLen = u(6, 2), idLen = u(8, 2);
  out.w = (int)u(10, 2);
  out.h = (int)u(12, 2);
  out.seq = (uint32_t)u(14, 4);
  out.token = u(18, 8);
  if (b.size() < 26 + keyLen + idLen) return false;
  out.key = b.substr(26, keyLen);
  out.traceId = b.substr(26 + keyLen, idLen);
  return true;
}

std::vector<uint8_t> gradientBgra(int w, int h) {
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

std::vector<uint8_t> readByToken(uint64_t token, int& w, int& h) {
  IOSurfaceRef s = IOSurfaceLookup((IOSurfaceID)token);
  if (!s) return {};
  IOSurfaceLock(s, kIOSurfaceLockReadOnly, nullptr);
  w = (int)IOSurfaceGetWidth(s);
  h = (int)IOSurfaceGetHeight(s);
  const size_t stride = IOSurfaceGetBytesPerRow(s);
  const uint8_t* base = (const uint8_t*)IOSurfaceGetBaseAddress(s);
  std::vector<uint8_t> out((size_t)w * h * 4);
  for (int y = 0; y < h; y++) memcpy(&out[(size_t)y * w * 4], base + y * stride, (size_t)w * 4);
  IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, nullptr);
  CFRelease(s);
  return out;
}

}  // namespace

TEST_CASE("surface previews: NBPS on the main socket, pixels by token, ring back-pressure",
          "[barrel_preview_surface]") {
  setenv("NANO_WAIT_COMPLETED", "1", 1);
  setenv("NANO_BRIDGE_PORT", std::to_string(kPort).c_str(), 1);
  setenv("NANO_BARREL_PREVIEW_HZ", "1000", 1);  // capture every rendered frame
  // Hold unreleased slots for the whole test, so the cap is the ring, not the
  // reclaim timeout (first frames compile shaders and can take over a second).
  setenv("NANO_SURFACE_RECLAIM_MS", "60000", 1);

  plugin::BridgeLoader loader;
  REQUIRE(loader.load(kBridgeLib));
  BridgeHandle h = loader.bridge_init();
  REQUIRE(h);
  char keybuf[128] = {0};
  loader.bridge_register_plugin(h, "com.nano.nanobarrel", 0, 1, 0, "", "surface-test",
                                keybuf, sizeof(keybuf));
  const std::string key = keybuf[0] ? keybuf : "surface-test";
  const char* envWasm = getenv("NANO_WASM_DIR");
  const bool rt = loader.bridge_rt_acquire(h, envWasm && *envWasm ? envWasm : BARREL_WASM_DIR, "") != 0;
  void* device = loader.bridge_rt_gpu_device(h);
  if (!device) SKIP("no GPU device");
  REQUIRE(rt);
  loader.bridge_executor_create(h, key.c_str());

  // The editor.
  std::mutex mu;
  std::vector<Nbps> got;
  std::atomic<int> otherBinary{0};
  ix::WebSocket ws;
  ws.setUrl("ws://127.0.0.1:" + std::to_string(kPort));
  ws.disablePerMessageDeflate();
  ws.setOnMessageCallback([&](const ix::WebSocketMessagePtr& m) {
    if (m->type != ix::WebSocketMessageType::Message || !m->binary) return;
    Nbps n;
    if (parseNbps(m->str, n)) { std::lock_guard<std::mutex> lk(mu); got.push_back(n); }
    else otherBinary++;
  });
  ws.start();
  for (int i = 0; i < 300 && ws.getReadyState() != ix::ReadyState::Open; i++)
    std::this_thread::sleep_for(10ms);
  REQUIRE(ws.getReadyState() == ix::ReadyState::Open);
  ws.send(nlohmann::json{{"action", "observe"}, {"path", "/plugins/" + key + "/state"}}.dump());
  std::this_thread::sleep_for(200ms);  // let the pump register the observation

  // A near-identity chain, so the preview shows the input's gradient.
  loader.bridge_set_at(h, ("/plugins/" + key + "/state/sketch").c_str(), R"JSON({
    "chain": [ { "type": "module", "module_type": "color.tone.brightness_contrast",
                 "instance_key": "bc@0" } ],
    "instances": { "bc@0": { "module_type": "color.tone.brightness_contrast",
                             "state": { "brightness": 0.02, "contrast": 0.0 } } },
    "wires": [] })JSON");
  loader.bridge_set_at(h, ("/plugins/" + key + "/state/preview_requests").c_str(), R"JSON({
    "mon": { "target": { "type": "sketch_output" }, "width": 32, "height": 32,
             "transport": "surface" } })JSON");

  void* in_tex = barrel_probe::createTexture(device, kW, kH);
  void* out_tex = barrel_probe::createTexture(device, kW, kH);
  REQUIRE(in_tex);
  REQUIRE(out_tex);
  const auto grad = gradientBgra(kW, kH);
  barrel_probe::uploadTexture(device, in_tex, kW, kH, grad.data());

  double elapsed = 0.0;
  const float macros[8] = {0};
  auto renderFrames = [&](int n) {
    for (int i = 0; i < n; ++i) {
      elapsed += 1.0 / 60.0;
      loader.bridge_executor_render(h, key.c_str(), in_tex, out_tex, kW, kH, 1.0 / 60.0,
                                    elapsed, i == 0 ? 1 : 0, macros, 8, 0.0, 120.0);
      std::this_thread::sleep_for(15ms);
    }
    std::this_thread::sleep_for(150ms);  // GPU completion + socket delivery
  };
  auto snapshot = [&] { std::lock_guard<std::mutex> lk(mu); return got; };

  // --- Frames flow, and nothing releases them: the ring caps them. ---------
  renderFrames(20);
  auto first = snapshot();
  REQUIRE(!first.empty());
  CHECK(first.size() <= (size_t)kRing);
  CHECK(otherBinary.load() == 0);  // no NBPV on the main socket
  std::set<uint64_t> tokens;
  for (const auto& n : first) {
    CHECK(n.key == key);
    CHECK(n.traceId == "mon");
    CHECK(n.w == 32);
    CHECK(n.h == 32);
    tokens.insert(n.token);
  }
  CHECK(tokens.size() == first.size());  // one surface per slot

  // --- The pixels, read the way the editor process opens them. -------------
  int sw = 0, sh = 0;
  const auto px = readByToken(first.back().token, sw, sh);
  REQUIRE(sw == 32);
  REQUIRE(sh == 32);
  auto at = [&](int x, int y) { return &px[((size_t)y * sw + x) * 4]; };  // B,G,R,A
  CHECK((int)at(1, 16)[2] < 70);         // red ramps left -> right
  CHECK((int)at(30, 16)[2] > 190);
  CHECK((int)at(16, 1)[1] < 70);         // green top -> bottom: upright
  CHECK((int)at(16, 30)[1] > 190);

  // --- Release them all: frames resume. -------------------------------------
  for (uint64_t t : tokens)
    ws.send(nlohmann::json{{"action", "preview_release"}, {"token", t}}.dump());
  std::this_thread::sleep_for(150ms);
  renderFrames(10);
  const auto after = snapshot();
  CHECK(after.size() > first.size());
  CHECK(after.back().seq > first.back().seq);

  ws.stop();
  barrel_probe::releaseTexture(in_tex);
  barrel_probe::releaseTexture(out_tex);
  loader.bridge_executor_destroy(h, key.c_str());
  loader.bridge_rt_release(h);
  loader.bridge_unregister_plugin(h, key.c_str());
  loader.bridge_release(h);
}
