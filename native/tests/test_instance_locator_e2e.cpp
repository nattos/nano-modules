// End-to-end: the real BridgeServer (dylib singleton) connects to a fake
// Resolume server over a real WebSocket, ingests the composition, runs the
// InstanceLocator, and publishes a registered instance's default display name
// into the state document — with no live Resolume.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "bridge/bridge_server.h"
#include "bridge/instance_locator.h"
#include "fake_resolume_server.h"
#include "plugin/nano_barrel/barrel_codec.h"

using json = nlohmann::json;
using namespace std::chrono_literals;

TEST_CASE("BridgeServer locates a barrel via a fake Resolume", "[instance_locator][e2e]") {
  const int kFakePort = 19090;
  const std::string uuid = "9B96D63F-FFFC-4477-97B2-78F8E0CE1795";

  // Fake Resolume with one barrel on layer 0 / clip 0.
  bridge::FakeResolumeServer fake;
  fake.set_composition(bridge::FakeResolumeServer::make_default_composition({uuid}));
  REQUIRE(fake.start(kFakePort));

  // Point the dylib at the fake, and off a live editor port.
  std::string url = "ws://127.0.0.1:" + std::to_string(kFakePort) + "/api/v1";
  setenv("NANO_RESOLUME_URL", url.c_str(), 1);
  setenv("NANO_BRIDGE_PORT", "19091", 1);

  auto& server = bridge::BridgeServer::instance();
  server.acquire();
  // Register the instance under its UUID (as the FFGL barrel would).
  std::string key = server.register_plugin("com.nano.nanobarrel", 0, 1, 0, "", uuid);
  REQUIRE(key == uuid);

  // Wait for the pump to connect, ingest the composition, and publish.
  json resolume;
  for (int i = 0; i < 400; i++) {  // up to ~10s
    json entry = json::parse(server.get_at("/global/plugins/0"), nullptr, false);
    if (!entry.is_discarded() && entry.is_object() && entry.contains("resolume")) {
      resolume = entry["resolume"];
      break;
    }
    std::this_thread::sleep_for(25ms);
  }

  server.release();
  fake.stop();

  REQUIRE_FALSE(resolume.is_null());
  CHECK(resolume["default_name"] == "Layer 1 \xC2\xB7 NanoBarrel");
  CHECK(resolume["location"] == "/layers/0/clips/0/video/effects/0");
}

namespace {

// Two dormant (Disconnected) clips on one layer, both carrying the same uuid —
// a copy-paste collision. Known config ids so the fork write can be attributed.
json make_dup_comp(const std::string& uuid, int64_t cfgA, int64_t cfgB) {
  auto barrel = [](const std::string& u, int64_t cfg) {
    json env = {{"sketch", {{"chain", json::array()}}}, {"uuid", u}};
    std::string blob = barrel_codec::wrap_config(env.dump());
    return json{{"id", cfg + 1}, {"name", "NanoBarrel"},
                {"params", {{"config", {{"id", cfg}, {"valuetype", "ParamFile"},
                                        {"value", blob}}}}}};
  };
  auto clip = [&](const std::string& nm, int64_t cfg) {
    json c;
    c["name"] = {{"valuetype", "ParamString"}, {"value", nm}};
    c["connected"] = {{"valuetype", "ParamState"}, {"value", "Disconnected"}};
    c["video"]["effects"] = json::array({barrel(uuid, cfg)});
    return c;
  };
  json layer;
  layer["name"] = {{"valuetype", "ParamString"}, {"value", "Layer #"}};
  layer["clips"] = json::array({clip("A", cfgA), clip("B", cfgB)});
  json comp;
  comp["name"] = {{"valuetype", "ParamString"}, {"value", "C"}};
  comp["layers"] = json::array({layer});
  return comp;
}

}  // namespace

TEST_CASE("BridgeServer forks a dormant duplicate over the fake Resolume WS",
          "[instance_locator][e2e]") {
  const int kFakePort = 19092;
  const int64_t cfgA = 5100, cfgB = 5200;
  const std::string uuid = "DUP-E2E-0000-0000";

  bridge::FakeResolumeServer fake;
  fake.set_composition(make_dup_comp(uuid, cfgA, cfgB));
  REQUIRE(fake.start(kFakePort));

  std::string url = "ws://127.0.0.1:" + std::to_string(kFakePort) + "/api/v1";
  setenv("NANO_RESOLUME_URL", url.c_str(), 1);
  setenv("NANO_BRIDGE_PORT", "19093", 1);
  setenv("NANO_FORK_DWELL_MS", "150", 1);  // fork quickly for the test

  auto& server = bridge::BridgeServer::instance();
  server.acquire();

  // The pump connects, ingests the collision, dwells ~150ms, then writes a
  // fresh-uuid config to the non-canonical dormant duplicate (cfgB, larger path).
  bridge::FakeResolumeServer::SetRecord fork;
  bool saw_fork = false;
  for (int i = 0; i < 400 && !saw_fork; i++) {  // up to ~10s
    for (auto& s : fake.recorded_sets()) {
      if (s.id == cfgB) { fork = s; saw_fork = true; break; }
    }
    std::this_thread::sleep_for(25ms);
  }

  server.release();
  fake.stop();
  unsetenv("NANO_FORK_DWELL_MS");

  REQUIRE(saw_fork);
  // The write targets the config param by id and carries a distinct new uuid
  // wrapping the same sketch.
  CHECK(fork.path == "/parameter/by-id/" + std::to_string(cfgB));
  REQUIRE(fork.value.is_string());
  std::string new_blob = fork.value.get<std::string>();
  std::string new_uuid = bridge::InstanceLocator::resolve_uuid(new_blob);
  CHECK_FALSE(new_uuid.empty());
  CHECK(new_uuid != uuid);
}
