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
