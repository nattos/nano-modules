// Marker → channel → /global/channels, driven headlessly against the fake
// Resolume server (no live Resolume). Covers what we validated live:
//   - a NanoLooper Ch marker's uuid/channel/name resolve from the composition
//     ONLY when the config blob is broadcast (the FF_TYPE_TEXT fix);
//   - an empty config (the pre-fix bug) leaves the clip's key empty — which is
//     exactly what left the Instances-tab thumbnails black;
//   - the BridgeServer pump publishes /global/channels for the web grid.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "bridge/bridge_server.h"
#include "bridge/composition_cache.h"
#include "resolume/composition.h"
#include "fake_resolume_server.h"

using json = nlohmann::json;
using namespace std::chrono_literals;
using MS = bridge::FakeResolumeServer::MarkerSpec;

TEST_CASE("CompositionCache resolves a fake NanoLooper Ch marker comp",
          "[trigger_channels]") {
  json comp = bridge::FakeResolumeServer::make_marker_composition({
    MS{"U-BASS", 1, "Bass", "Connected", false},
    MS{"U-DRUM", 2, "Drums", "Disconnected", false},
  });

  bridge::CompositionCache cache;
  cache.rebuild(resolume::parse_composition(comp));
  REQUIRE(cache.clip_count() == 2);

  bridge::CachedClip a = cache.get_clip(0);
  CHECK(a.channel == 0);  // channel 1 (1-based) → 0-based
  CHECK(a.marker_uuid == "U-BASS");
  CHECK(a.channel_name == "Bass");
  CHECK(a.connected == true);
  CHECK(a.connect_path == "/composition/layers/1/clips/1/connect");

  bridge::CachedClip b = cache.get_clip(1);
  CHECK(b.channel == 1);
  CHECK(b.marker_uuid == "U-DRUM");
  CHECK(b.channel_name == "Drums");
  CHECK(b.connected == false);
  CHECK(b.connect_path == "/composition/layers/2/clips/1/connect");
}

TEST_CASE("empty marker config yields no uuid (the pre-fix thumbnail bug)",
          "[trigger_channels]") {
  json comp = bridge::FakeResolumeServer::make_marker_composition({
    MS{"U-X", 1, "X", "Connected", /*empty_config=*/true},
  });

  bridge::CompositionCache cache;
  cache.rebuild(resolume::parse_composition(comp));
  REQUIRE(cache.clip_count() == 1);
  bridge::CachedClip c = cache.get_clip(0);

  // Channel + name still resolve from the broadcast float/text params...
  CHECK(c.channel == 0);
  CHECK(c.channel_name == "X");
  // ...but with no config blob there is no uuid — so /global/channels carried
  // clip.key == "" and the web could not observe/draw the thumbnail.
  CHECK(c.marker_uuid.empty());
}

TEST_CASE("BridgeServer publishes /global/channels for marker clips",
          "[trigger_channels][e2e]") {
  const int kFakePort = 19096;

  bridge::FakeResolumeServer fake;
  fake.set_composition(bridge::FakeResolumeServer::make_marker_composition({
    MS{"U-BASS", 1, "Bass", "Connected", false},
  }));
  REQUIRE(fake.start(kFakePort));

  std::string url = "ws://127.0.0.1:" + std::to_string(kFakePort) + "/api/v1";
  setenv("NANO_RESOLUME_URL", url.c_str(), 1);
  setenv("NANO_BRIDGE_PORT", "19097", 1);

  auto& server = bridge::BridgeServer::instance();
  server.acquire();

  // Poll until the pump ingests the comp and publishes /global/channels.
  json channels;
  for (int i = 0; i < 200 && channels.is_null(); i++) {
    std::this_thread::sleep_for(25ms);
    auto doc = json::parse(server.get_at("/global/channels"), nullptr, false);
    if (doc.is_object() && doc.contains("1")) channels = doc;
  }

  server.release();
  fake.stop();

  REQUIRE(channels.contains("1"));
  const auto& ch1 = channels["1"];
  CHECK(ch1.value("name", std::string()) == "Bass");
  REQUIRE(ch1["clips"].is_array());
  REQUIRE(ch1["clips"].size() == 1);
  const auto& clip = ch1["clips"][0];
  CHECK(clip.value("key", std::string()) == "U-BASS");
  CHECK(clip.value("clip", std::string()) == "Solid Color");
  CHECK(clip.value("connected", false) == true);
}

// reassign_channel end-to-end: a bridge WS client's drop/edit writes the
// marker's Channel param at the fake Resolume AND /global/channels moves the
// clip — optimistically on the same pump tick (verified separately below),
// then reconciled by the fake's composition rebroadcast (the live-Arena loop).
TEST_CASE("reassign_channel: param write + /global/channels move",
          "[trigger_channels][e2e]") {
  const int kFakePort = 19110, kBridgePort = 19111;

  bridge::FakeResolumeServer fake;
  fake.set_composition(bridge::FakeResolumeServer::make_marker_composition({
    MS{"U-BASS", 1, "Bass", "Connected", false},
    MS{"U-DRUM", 2, "Drums", "Disconnected", false},
  }));
  REQUIRE(fake.start(kFakePort));

  std::string url = "ws://127.0.0.1:" + std::to_string(kFakePort) + "/api/v1";
  setenv("NANO_RESOLUME_URL", url.c_str(), 1);
  setenv("NANO_BRIDGE_PORT", std::to_string(kBridgePort).c_str(), 1);

  auto& server = bridge::BridgeServer::instance();
  server.acquire();

  auto channels_doc = [&]() -> json {
    return json::parse(server.get_at("/global/channels"), nullptr, false);
  };
  auto clip_on_channel = [&](const json& doc, const char* ch, const char* key) {
    if (!doc.is_object() || !doc.contains(ch) || !doc[ch]["clips"].is_array())
      return false;
    for (const auto& c : doc[ch]["clips"])
      if (c.value("key", std::string()) == key) return true;
    return false;
  };

  // Wait for the initial publish (U-BASS on channel 1).
  json initial;
  for (int i = 0; i < 200; i++) {
    std::this_thread::sleep_for(25ms);
    json d = channels_doc();
    if (clip_on_channel(d, "1", "U-BASS")) { initial = d; break; }
  }
  REQUIRE(clip_on_channel(initial, "1", "U-BASS"));

  // Connect to the bridge as the web would and reassign U-BASS -> channel 3.
  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:" + std::to_string(kBridgePort));
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  for (int i = 0; i < 300 && client.getReadyState() != ix::ReadyState::Open; i++)
    std::this_thread::sleep_for(10ms);
  REQUIRE(client.getReadyState() == ix::ReadyState::Open);
  client.send(json{{"action", "reassign_channel"},
                   {"key", "U-BASS"}, {"channel", 3}}.dump());

  // /global/channels must move the clip to "3" (and off "1").
  json moved;
  for (int i = 0; i < 200; i++) {
    std::this_thread::sleep_for(25ms);
    json d = channels_doc();
    if (clip_on_channel(d, "3", "U-BASS")) { moved = d; break; }
  }
  CHECK(clip_on_channel(moved, "3", "U-BASS"));
  CHECK(!clip_on_channel(moved, "1", "U-BASS"));
  CHECK(clip_on_channel(moved, "2", "U-DRUM"));  // bystander untouched

  // The fake received the Channel param write (string, FF_TYPE_TEXT form).
  bool set_seen = false;
  for (const auto& s : fake.recorded_sets()) {
    if (s.value.is_string() && s.value.get<std::string>() == "3") set_seen = true;
  }
  CHECK(set_seen);

  client.stop();
  server.release();
  fake.stop();
}

// The optimistic half in isolation: with Resolume unreachable (no set lands,
// no rebroadcast reconciles), the cache/doc still move on the pump tick — the
// UI reflects the user's intent immediately and the next real composition
// broadcast remains the authority.
TEST_CASE("reassign_channel: optimistic /global/channels move without Resolume",
          "[trigger_channels][e2e]") {
  const int kFakePort = 19112, kBridgePort = 19113;

  bridge::FakeResolumeServer fake;
  fake.set_composition(bridge::FakeResolumeServer::make_marker_composition({
    MS{"U-SOLO", 1, "Solo", "Connected", false},
  }));
  REQUIRE(fake.start(kFakePort));

  std::string url = "ws://127.0.0.1:" + std::to_string(kFakePort) + "/api/v1";
  setenv("NANO_RESOLUME_URL", url.c_str(), 1);
  setenv("NANO_BRIDGE_PORT", std::to_string(kBridgePort).c_str(), 1);

  auto& server = bridge::BridgeServer::instance();
  server.acquire();

  auto has_on = [&](const char* ch, const char* key) {
    json d = json::parse(server.get_at("/global/channels"), nullptr, false);
    if (!d.is_object() || !d.contains(ch) || !d[ch]["clips"].is_array()) return false;
    for (const auto& c : d[ch]["clips"])
      if (c.value("key", std::string()) == key) return true;
    return false;
  };
  for (int i = 0; i < 200 && !has_on("1", "U-SOLO"); i++)
    std::this_thread::sleep_for(25ms);
  REQUIRE(has_on("1", "U-SOLO"));

  // Take Resolume away — the cache keeps its last composition.
  fake.stop();
  std::this_thread::sleep_for(100ms);

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:" + std::to_string(kBridgePort));
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  for (int i = 0; i < 300 && client.getReadyState() != ix::ReadyState::Open; i++)
    std::this_thread::sleep_for(10ms);
  REQUIRE(client.getReadyState() == ix::ReadyState::Open);
  client.send(json{{"action", "reassign_channel"},
                   {"key", "U-SOLO"}, {"channel", 2}}.dump());

  bool moved = false;
  for (int i = 0; i < 200 && !moved; i++) {
    std::this_thread::sleep_for(25ms);
    moved = has_on("2", "U-SOLO");
  }
  CHECK(moved);

  client.stop();
  server.release();
}
