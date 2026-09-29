// test_comp_displays.cpp — display devices on the GPU: a comp host renders,
// its DisplayRunner presents onto OFFSCREEN targets (fake screens — nothing
// opens on a real one), and the presented pixels match the picture: Fit
// letterboxes in black, Fill crops, Stretch fills; a routed display shows its
// track; an off display closes; a display with no screen stays inert; screen
// binding never picks the main screen on its own.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/comp_host.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"

#include "wasm_paths.h"

using effect_runtime::EffectRuntime;
using json = nlohmann::json;
using bridge::DisplayOutput;
using bridge::DisplayScreen;

namespace {

// The show renders 64×36 (16:9); the fake screen is 64×48 (4:3), so Fit
// leaves 6-pixel bars top and bottom.
constexpr int kW = 64, kH = 36;
constexpr int kScreenW = 64, kScreenH = 48;

json mkDevice(const std::string& id, const std::string& type, json state = json::object()) {
  return {{"id", id}, {"moduleType", type}, {"name", type}, {"capabilities", json::array()},
          {"state", std::move(state)}};
}

json mkClip(const std::string& id, json devices) {
  return {{"id", id}, {"name", id}, {"startBeat", 0}, {"lengthBeat", 16},
          {"kind", "effect"}, {"sketch", {{"devices", std::move(devices)}}},
          {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}, {"direction", "forward"}}},
          {"automation", json::array()}, {"exports", json::array()}, {"warps", json::array()}};
}

json solid(const std::string& id, double r, double g, double b) {
  return mkDevice(id, "source.solid_color", {{"color", {r, g, b}}});
}

json mkTrack(const std::string& id, json clips, json extra = json::object()) {
  json t = {{"id", id}, {"name", id}, {"kind", "track"}, {"parentId", nullptr},
            {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
            {"clips", std::move(clips)}};
  t.update(extra);
  return t;
}

/// t1: red (the composite). t2: green, SENT NOWHERE — only a route shows it.
/// Display d1 is placed; `route` feeds it t2's output.
json mkDoc(bool route) {
  json tracks = json::array({
      mkTrack("t1", json::array({mkClip("a", json::array({solid("ra", 1, 0, 0)}))})),
      mkTrack("t2", json::array({mkClip("b", json::array({solid("gb", 0, 1, 0)}))}),
              {{"output", {{"mode", "none"}}}}),
      mkTrack("main-bus", json::array(), {{"kind", "group"}, {"name", "Main Bus"}}),
  });
  json doc = {{"meta", {{"resolution", {{"width", kW}, {"height", kH}}}, {"baseBPM", 120},
                        {"timeSignature", {4, 4}}}},
              {"tracks", tracks}, {"rails", json::array()},
              {"playMode", {{"defaultMode", "time"}}},
              {"devices", json::array({{{"id", "d1"}, {"kind", "display"}, {"deviceId", "display.1"},
                                        {"enabled", true}}})}};
  if (route) {
    doc["routes"] = json::array({{{"id", "r1"},
                                  {"src", {{"kind", "port"}, {"trackId", "t2"}, {"portId", "__out__"}}},
                                  {"dest", {{"kind", "device"}, {"placementId", "d1"}}}}});
  }
  return doc;
}

json mkPlan(const std::string& fit = "fit", bool enabled = true, bool window = false) {
  json o = {{"placementId", "d1"}, {"slotId", "display.1"}, {"name", "Display 1"},
            {"enabled", enabled}, {"screenUuid", ""}, {"ordinal", 1}, {"window", window},
            {"fit", fit}};
  if (window) o["windowFrame"] = {{"x", 0}, {"y", 0}, {"w", 32}, {"h", 32}};
  return {{"outputs", json::array({o})}};
}

std::vector<DisplayScreen> fakeScreens() {
  return {{"MAIN", "Built-in", 1440, 900, 60, true}, {"EXT", "Projector", kScreenW, kScreenH, 60, false}};
}

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  sketch_executor::WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;

  bool init() {
    backend = gpu::createBackend();
    if (!backend) return false;
    if (!bundles.init()) return false;
    rt = std::make_unique<EffectRuntime>(backend.get());
    registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
    return bundles.loadBundleFile(kCoreWasm, *registry, backend.get(), nullptr) > 1;
  }

  std::unique_ptr<bridge::CompHost> host() {
    bridge::CompHost::Config cfg;
    cfg.width = kW;
    cfg.height = kH;
    return std::make_unique<bridge::CompHost>(backend.get(), rt.get(), registry.get(), &bundles, cfg);
  }

  /// Frames, each submitted then presented — as renderComp runs them.
  void frames(bridge::CompHost& h, int n = 1) {
    for (int i = 0; i < n; i++) {
      h.step(1.0 / 60);
      backend->submit();
      h.runDisplays();
      backend->drainPreviewReadbacks();
    }
  }

  /// BGRA pixel (x, y) of what d1 was last presented, as {r, g, b}; empty if
  /// it has no target.
  std::vector<int> pixel(bridge::CompHost& h, int x, int y) {
    const int32_t tex = h.displays().targetTexture("d1");
    if (tex <= 0) return {};
    const auto px = backend->readbackTexture(tex, kScreenW, kScreenH);
    const size_t i = ((size_t)y * kScreenW + x) * 4;
    auto r8 = [](int v) { return std::min(255, (v + 4) / 8 * 8); };
    return {r8(px[i + 2]), r8(px[i + 1]), r8(px[i + 0])};
  }

  template <class F>
  bool framesUntil(bridge::CompHost& h, F done, int max = 120) {
    for (int i = 0; i < max; i++) {
      frames(h);
      if (done()) return true;
    }
    return false;
  }
};

const std::vector<int> kRed = {255, 0, 0};
const std::vector<int> kGreen = {0, 255, 0};
const std::vector<int> kBlack = {0, 0, 0};

}  // namespace

TEST_CASE("displays: screen binding never picks the main screen on its own", "[comp_displays]") {
  const auto screens = std::vector<DisplayScreen>{
      {"A", "Built-in", 1440, 900, 60, true},
      {"B", "Projector", 1920, 1080, 60, false},
      {"C", "Monitor", 2560, 1440, 60, false},
  };
  DisplayOutput o;
  o.ordinal = 1;
  CHECK(bridge::resolveDisplayScreen(o, screens) == 1);  // the first EXTERNAL screen
  o.ordinal = 2;
  CHECK(bridge::resolveDisplayScreen(o, screens) == 2);
  o.ordinal = 3;
  CHECK(bridge::resolveDisplayScreen(o, screens) == -1);  // no third external: inert
  // A remembered screen wins — the main one too, when chosen explicitly.
  o.screenUuid = "A";
  CHECK(bridge::resolveDisplayScreen(o, screens) == 0);
  // …and when it isn't connected, the automatic binding stands in.
  o.screenUuid = "gone";
  o.ordinal = 1;
  CHECK(bridge::resolveDisplayScreen(o, screens) == 1);
  // A laptop alone: Display 1 has nowhere to go.
  CHECK(bridge::resolveDisplayScreen(o, {screens[0]}) == -1);
}

TEST_CASE("displays: Fit letterboxes, Fill crops, Stretch fills", "[comp_displays]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  bridge::OffscreenDisplays screens(fakeScreens());  // outlives the host
  auto h = hx.host();
  h->displays().setSurfaces(&screens);
  h->loadDocument(mkDoc(false));

  h->displays().setPlan(mkPlan("fit"));
  REQUIRE(hx.framesUntil(*h, [&] { return hx.pixel(*h, 32, 18) == kRed; }));
  CHECK(hx.pixel(*h, 32, 24) == kRed);
  CHECK(hx.pixel(*h, 32, 1) == kBlack);   // the bars
  CHECK(hx.pixel(*h, 32, 46) == kBlack);
  CHECK(hx.pixel(*h, 32, 4) == kBlack);   // right up to the picture's edge
  CHECK(hx.pixel(*h, 32, 7) == kRed);
  auto st = h->displays().status()["d1"];
  CHECK(st["state"] == "showing");
  CHECK(st["width"] == kScreenW);
  CHECK(st["height"] == kScreenH);
  CHECK(st["screen"]["uuid"] == "EXT");

  h->displays().setPlan(mkPlan("fill"));
  hx.frames(*h);
  CHECK(hx.pixel(*h, 32, 1) == kRed);
  CHECK(hx.pixel(*h, 1, 24) == kRed);

  h->displays().setPlan(mkPlan("stretch"));
  hx.frames(*h);
  CHECK(hx.pixel(*h, 32, 1) == kRed);
  CHECK(hx.pixel(*h, 32, 46) == kRed);

  // The report's probe (offscreen only): 16×16 RGB of what was presented.
  hx.frames(*h, 20);
  CHECK(h->displays().status()["d1"].contains("probe"));
}

TEST_CASE("displays: a routed display shows its track; switched off, it closes", "[comp_displays]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  bridge::OffscreenDisplays screens(fakeScreens());
  auto h = hx.host();
  h->displays().setSurfaces(&screens);
  h->loadDocument(mkDoc(true));
  h->displays().setPlan(mkPlan("stretch"));
  CHECK(hx.framesUntil(*h, [&] { return hx.pixel(*h, 32, 24) == kGreen; }));

  h->displays().setPlan(mkPlan("stretch", /*enabled=*/false));
  hx.frames(*h);
  CHECK(h->displays().targetTexture("d1") == -1);
  CHECK(h->displays().status()["d1"]["state"] == "off");

  // The master switch off: an enabled display shows nothing either.
  json plan = mkPlan("stretch");
  plan["armed"] = false;
  h->displays().setPlan(plan);
  hx.frames(*h);
  CHECK(h->displays().targetTexture("d1") == -1);
  CHECK(h->displays().status()["d1"]["state"] == "disarmed");
  plan["armed"] = true;
  h->displays().setPlan(plan);
  hx.frames(*h);
  CHECK(h->displays().targetTexture("d1") > 0);
}

TEST_CASE("displays: no screen is an unplugged cable; a window opens anyway", "[comp_displays]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  bridge::OffscreenDisplays laptop({{"MAIN", "Built-in", 1440, 900, 60, true}});
  auto h = hx.host();
  h->displays().setSurfaces(&laptop);
  h->loadDocument(mkDoc(false));
  h->displays().setPlan(mkPlan());
  hx.frames(*h, 3);
  CHECK(h->displays().targetTexture("d1") == -1);
  CHECK(h->displays().status()["d1"]["state"] == "no-screen");

  // Rehearsing in a window: no screen needed.
  h->displays().setPlan(mkPlan("fit", true, /*window=*/true));
  hx.frames(*h);
  auto st = h->displays().status()["d1"];
  CHECK(st["state"] == "window");
  CHECK(st["width"] == 32);

  // Identify reaches the provider (the window, here).
  h->displays().identify({{"label", "Display 1"}, {"window", true}});
  const auto ev = h->displays().takeEvents();
  REQUIRE(ev.size() == 1);
  CHECK(ev[0]["type"] == "identified");
  CHECK(ev[0]["label"] == "Display 1");
}

TEST_CASE("displays: presenting never waits on the screen", "[comp_displays]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  const int32_t t = hx.backend->createOffscreenPresentTarget(256, 256);
  REQUIRE(t > 0);
  CHECK(hx.backend->presentTargetTexture(t) > 0);
  CHECK_FALSE(hx.backend->presentScaled(t + 1000, -1, gpu::GPUBackend::PresentFit::Fit));
  // Back to back, faster than the GPU retires them: some are skipped, none
  // blocks.
  const auto t0 = std::chrono::steady_clock::now();
  int shown = 0;
  for (int i = 0; i < 50; i++) {
    if (hx.backend->presentScaled(t, -1, gpu::GPUBackend::PresentFit::Fit)) shown++;
  }
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(shown >= 1);
  CHECK(ms < 500);
  hx.backend->releasePresentTarget(t);
}
