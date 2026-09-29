// test_comp_lights.cpp — light devices end to end on the GPU: a comp host
// renders, its LightRunner reads back what each light samples, and the DMX
// that reaches the sink matches the picture. Covers the composite (no route),
// a routed track (`__out__` → a light, the track sent nowhere), a dead route,
// a switched-off output, and a test pattern overriding the picture.
//
// The sink is a capture — no socket (artnet_sender has its own loopback test).

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <mutex>
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

namespace {

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

/// t1: a red clip (the composite). t2: a green clip, SENT NOWHERE — only a
/// route can see it. Light p1 is placed; `route` feeds it t2's output.
json mkDoc(bool route, bool t2Plays = true) {
  json tracks = json::array({
      mkTrack("t1", json::array({mkClip("a", json::array({solid("ra", 1, 0, 0)}))})),
      mkTrack("t2", t2Plays ? json::array({mkClip("b", json::array({solid("gb", 0, 1, 0)}))})
                            : json::array(),
              {{"output", {{"mode", "none"}}}}),
      mkTrack("main-bus", json::array(), {{"kind", "group"}, {"name", "Main Bus"}}),
  });
  json doc = {{"meta", {{"resolution", {{"width", 64}, {"height", 64}}}, {"baseBPM", 120},
                        {"timeSignature", {4, 4}}}},
              {"tracks", tracks}, {"rails", json::array()},
              {"playMode", {{"defaultMode", "time"}}},
              {"devices", json::array({{{"id", "p1"}, {"kind", "light"}, {"deviceId", "rig1"},
                                        {"enabled", true}}})}};
  if (route) {
    doc["routes"] = json::array({{{"id", "r1"},
                                  {"src", {{"kind", "port"}, {"trackId", "t2"}, {"portId", "__out__"}}},
                                  {"dest", {{"kind", "device"}, {"placementId", "p1"}}}}});
  }
  return doc;
}

/// One light: a 2-pixel vertical strip down the middle, RGB on universe 3 from
/// channel 10.
json mkPlan(bool enabled = true) {
  return {{"outputs", json::array({{{"placementId", "p1"}, {"enabled", enabled},
      {"fixtures", json::array({{{"slotId", "s1"}, {"universe", 3}, {"channel", 10},
                                  {"dest", "127.0.0.1:1"}, {"format", "rgb"}, {"gamma", 1.0},
                                  {"footprints", json::array({{0.45, 0.0, 0.55, 0.5},
                                                              {0.45, 0.5, 0.55, 1.0}})}}})}}})}};
}

int q(int v) { return std::min(255, (v + 4) / 8 * 8); }
std::vector<int> q(const std::vector<uint8_t>& v) {
  std::vector<int> out;
  for (uint8_t x : v) out.push_back(q(x));
  return out;
}

struct Capture : bridge::LightSink {
  std::mutex mu;
  lights::Frames last;
  int submits = 0;
  void submit(const lights::Frames& f) override {
    std::lock_guard<std::mutex> lk(mu);
    last = f;
    submits++;
  }
  /// Channels [ch, ch+n) of universe 3 (1-based ch), or empty when not sent.
  /// Rounded to steps of 8: the resampler and the sketch format may land a
  /// full channel on 254.
  std::vector<int> channels(int ch, int n) {
    std::lock_guard<std::mutex> lk(mu);
    auto it = last.find({"", "127.0.0.1:1", 3});
    if (it == last.end()) return {};
    std::vector<int> out;
    for (int i = 0; i < n; i++) out.push_back(q(it->second[ch - 1 + i]));
    return out;
  }
};

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
    cfg.width = 64;
    cfg.height = 64;
    return std::make_unique<bridge::CompHost>(backend.get(), rt.get(), registry.get(), &bundles, cfg);
  }

  /// Frames, each submitted then read back — as renderComp runs them.
  void frames(bridge::CompHost& h, int n = 4) {
    for (int i = 0; i < n; i++) {
      h.step(1.0 / 60);
      backend->submit();
      h.runLights();
      backend->drainPreviewReadbacks();
    }
  }
  /// Frames until `done` (a fresh chain takes a variable few to show
  /// content), at most `max`.
  template <class F>
  bool framesUntil(bridge::CompHost& h, F done, int max = 120) {
    for (int i = 0; i < max; i++) {
      frames(h, 1);
      if (done()) return true;
    }
    return false;
  }
};

}  // namespace

TEST_CASE("lights: an unrouted light samples the composite", "[comp_lights]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  Capture sink;  // outlives the host: its readbacks call into it
  auto h = hx.host();
  h->lights().setSink(&sink);
  h->loadDocument(mkDoc(false));
  h->lights().setPlan(mkPlan());
  const std::vector<int> red = {255, 0, 0, 255, 0, 0};
  CHECK(hx.framesUntil(*h, [&] { return sink.channels(10, 6) == red; }));
  CHECK(sink.channels(9, 1) == std::vector<int>({0}));
  // What the UI draws: the same colours, pre-gamma.
  const auto colors = h->lights().colors();
  REQUIRE(colors.count("p1"));
  CHECK(q(colors.at("p1")) == std::vector<int>({255, 0, 0, 255, 0, 0}));
}

TEST_CASE("lights: a routed light samples its track, which is sent nowhere", "[comp_lights]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  Capture sink;  // outlives the host: its readbacks call into it
  auto h = hx.host();
  h->lights().setSink(&sink);
  h->loadDocument(mkDoc(true));
  h->lights().setPlan(mkPlan());
  const std::vector<int> green = {0, 255, 0, 0, 255, 0};
  CHECK(hx.framesUntil(*h, [&] { return sink.channels(10, 6) == green; }));

  // Its source track has nothing playing: the route is dead, the light dark.
  h->loadDocument(mkDoc(true, /*t2Plays=*/false));
  const std::vector<int> black = {0, 0, 0, 0, 0, 0};
  CHECK(hx.framesUntil(*h, [&] { return sink.channels(10, 6) == black; }, 8));
}

TEST_CASE("lights: switched off sends nothing; a test pattern overrides", "[comp_lights]") {
  Harness hx;
  if (!hx.init()) SKIP("No GPU device available");
  Capture sink;  // outlives the host: its readbacks call into it
  auto h = hx.host();
  h->lights().setSink(&sink);
  h->loadDocument(mkDoc(false));
  h->lights().setPlan(mkPlan(/*enabled=*/false));
  // It still samples, so the UI shows what it WOULD send…
  const std::vector<int> red = {255, 0, 0, 255, 0, 0};
  CHECK(hx.framesUntil(*h, [&] { return q(h->lights().colors().at("p1")) == red; }));
  // …but sends nothing.
  CHECK(sink.channels(10, 3).empty());

  // A test pattern is an explicit request to light it, off or not.
  h->lights().setTest("p1", "", "white");
  hx.frames(*h, 1);
  CHECK(sink.channels(10, 6) == std::vector<int>({255, 255, 255, 255, 255, 255}));
  h->lights().setTest("p1", "", "");
  hx.frames(*h, 1);
  CHECK(sink.channels(10, 3).empty());
}
