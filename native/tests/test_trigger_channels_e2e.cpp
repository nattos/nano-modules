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
