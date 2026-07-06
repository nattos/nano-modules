// End-to-end: emit a trigger onto the process-global trigger rail; the real
// BridgeServer pump drains it, matches the channel to a NanoLooper-Ch-marked
// clip in the (fake) Resolume composition, and issues a "connect" over the WS.
// No live Resolume.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "bridge/bridge_server.h"
#include "plugin/nano_barrel/channel_marker_codec.h"
#include "sketch/trigger_bus.h"
#include "fake_resolume_server.h"

using json = nlohmann::json;
using namespace std::chrono_literals;

namespace {

// One layer, one clip (index 0) carrying a NanoLooper Ch scene marker whose
// nanoch:// config blob declares Channel 1, currently Disconnected — the
// CompositionCache decodes it to channel 0 (→ trigger channel 1). This is the
// first-class (registering-plugin) resolution path.
json make_channel_comp() {
  json marker = {
    {"id", 900},
    {"name", "NanoLooper Ch"},
    {"params", {{"config", {{"id", 901}, {"valuetype", "ParamFile"},
                            {"value", channel_marker::wrap_config("U-e2e", 1)}}}}},
  };
  json clip;
  clip["name"] = {{"valuetype", "ParamString"}, {"value", "Marked"}};
  clip["connected"] = {{"valuetype", "ParamState"}, {"value", "Disconnected"},
                       {"id", 950}};
  clip["video"]["effects"] = json::array({marker});
  json layer;
  layer["name"] = {{"valuetype", "ParamString"}, {"value", "Layer #"}};
  layer["clips"] = json::array({clip});
  json comp;
  comp["name"] = {{"valuetype", "ParamString"}, {"value", "C"}};
  comp["layers"] = json::array({layer});
  return comp;
}

}  // namespace

TEST_CASE("BridgeServer launches a channel-marked clip from a rail trigger",
          "[clip_launcher][e2e]") {
  const int kFakePort = 19094;
  const std::string kConnectPath = "/composition/layers/1/clips/1/connect";  // 1-based API

  bridge::FakeResolumeServer fake;
  fake.set_composition(make_channel_comp());
  REQUIRE(fake.start(kFakePort));

  std::string url = "ws://127.0.0.1:" + std::to_string(kFakePort) + "/api/v1";
  setenv("NANO_RESOLUME_URL", url.c_str(), 1);
  setenv("NANO_BRIDGE_PORT", "19095", 1);
  setenv("NANO_LAUNCH_DEBOUNCE_MS", "40", 1);

  auto& server = bridge::BridgeServer::instance();
  server.acquire();
  trigger_bus::resetForTest();

  // Emit an on-trigger on channel 1 each iteration (the bus consumes on drain,
  // and the comp may not be ingested on the very first tick) until the fake
  // records the clip's connect action.
  bool saw_connect = false;
  for (int i = 0; i < 400 && !saw_connect; i++) {
    trigger_bus::emit(trigger_bus::kGlobalRail, 1, /*on=*/true, 1.0f, "test");
    std::this_thread::sleep_for(25ms);
    for (const auto& p : fake.recorded_triggers()) {
      if (p == kConnectPath) { saw_connect = true; break; }
    }
  }

  server.release();
  fake.stop();
  unsetenv("NANO_LAUNCH_DEBOUNCE_MS");

  CHECK(saw_connect);
}

// --- Reconciler-vs-quirks: drive the real BridgeServer + ClipLauncher against
// the fake's MODELLED Resolume trigger latches (piano stuck-on, Normal-clip
// connect:false no-op + stuck-off) and assert it converges. The fake broadcasts
// connected-param updates, which the server subscribes to; the reconciler drives
// each clip to its desired state with the re-arm state machine. ---

namespace {

const std::string kRed = "/composition/layers/1/clips/1/connect";   // Normal, ch1
const std::string kBlue = "/composition/layers/2/clips/1/connect";  // Piano,  ch2

// Emit on channel `ch` (value `on`) each iteration until the fake reports clip
// `path` at the wanted connected state (the reconciler runs on the pump thread).
bool drive_until(bridge::FakeResolumeServer& fake, int ch, bool on,
                 const std::string& path, bool want_connected, int iters = 300) {
  for (int i = 0; i < iters; i++) {
    trigger_bus::emit(trigger_bus::kGlobalRail, ch, on, 1.0f, "test");
    std::this_thread::sleep_for(20ms);
    if ((fake.clip_connected(path) == "Connected") == want_connected) return true;
  }
  return false;
}

// RAII: fake Resolume with the two-clip test comp + an acquired BridgeServer
// pointed at it, small debounce/dwell for fast convergence.
struct Rig {
  bridge::FakeResolumeServer fake;
  Rig(int fake_port, int bridge_port) {
    fake.set_composition(bridge::FakeResolumeServer::make_trigger_test_composition());
    REQUIRE(fake.start(fake_port));
    std::string url = "ws://127.0.0.1:" + std::to_string(fake_port) + "/api/v1";
    setenv("NANO_RESOLUME_URL", url.c_str(), 1);
    setenv("NANO_BRIDGE_PORT", std::to_string(bridge_port).c_str(), 1);
    setenv("NANO_LAUNCH_DEBOUNCE_MS", "30", 1);
    setenv("NANO_LAUNCH_REARM_DWELL_MS", "30", 1);
    bridge::BridgeServer::instance().acquire();
    trigger_bus::resetForTest();
    // Let the pump connect to the fake, cache the composition, and subscribe to
    // the clips' connected params — so a seed_stuck() broadcast afterwards is
    // actually observed (mirrors reality: the server has long been subscribed
    // when a user click latches a clip).
    std::this_thread::sleep_for(200ms);
  }
  ~Rig() {
    bridge::BridgeServer::instance().release();
    fake.stop();
    unsetenv("NANO_LAUNCH_DEBOUNCE_MS");
    unsetenv("NANO_LAUNCH_REARM_DWELL_MS");
  }
};

}  // namespace

TEST_CASE("reconciler: piano clip connects then cleanly disconnects",
          "[clip_launcher][e2e]") {
  Rig r(19100, 19101);
  CHECK(drive_until(r.fake, 2, /*on=*/true, kBlue, /*want_connected=*/true));
  CHECK(drive_until(r.fake, 2, /*on=*/false, kBlue, /*want_connected=*/false));
}

TEST_CASE("reconciler: recovers a stuck-ON piano clip via re-arm",
          "[clip_launcher][e2e]") {
  Rig r(19102, 19103);
  // As if a user click latched Blue on. Desired OFF; a bare disconnect is
  // dropped by the (modelled) stuck clip — only the re-arm toggle releases it.
  r.fake.seed_stuck(kBlue, /*stuck_on=*/true, /*stuck_off=*/false);
  CHECK(drive_until(r.fake, 2, /*on=*/false, kBlue, /*want_connected=*/false));
}

TEST_CASE("reconciler: normal clip connects", "[clip_launcher][e2e]") {
  Rig r(19104, 19105);
  CHECK(drive_until(r.fake, 1, /*on=*/true, kRed, /*want_connected=*/true));
}

TEST_CASE("reconciler: normal clip disconnects by eviction (not connect:false)",
          "[clip_launcher][e2e]") {
  Rig r(19106, 19107);
  CHECK(drive_until(r.fake, 1, /*on=*/true, kRed, /*want_connected=*/true));
  // Off via eviction (connecting the empty clip on the layer) — connect:false
  // is a no-op on a Normal clip in the fake, so only eviction turns it off.
  CHECK(drive_until(r.fake, 1, /*on=*/false, kRed, /*want_connected=*/false));
}

TEST_CASE("reconciler: recovers a stuck-OFF normal clip via re-arm",
          "[clip_launcher][e2e]") {
  Rig r(19108, 19109);
  // As if a prior eviction latched Red stuck-off. Desired ON; a plain connect is
  // dropped — the re-arm (connect:false then connect:true) clears it and connects.
  r.fake.seed_stuck(kRed, /*stuck_on=*/false, /*stuck_off=*/true);
  CHECK(drive_until(r.fake, 1, /*on=*/true, kRed, /*want_connected=*/true));
}
