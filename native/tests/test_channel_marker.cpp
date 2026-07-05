// Unit tests for the NanoLooper Ch scene-marker: the nanoch:// config codec and
// the CompositionCache decoding channel → clips from a marker's config blob.

#include <catch2/catch_test_macros.hpp>

#include <string>

#include <nlohmann/json.hpp>

#include "bridge/composition_cache.h"
#include "plugin/nano_barrel/channel_marker_codec.h"
#include "resolume/composition.h"

using json = nlohmann::json;

TEST_CASE("channel_marker codec round-trips uuid + channel", "[channel_marker]") {
  const std::string blob = channel_marker::wrap_config("ABC-123", 3);
  CHECK(channel_marker::is_marker_config(blob));
  CHECK(channel_marker::channel_of(blob) == 3);
  CHECK(channel_marker::uuid_of(blob) == "ABC-123");

  // A barrel blob (or anything else) is not a marker.
  CHECK_FALSE(channel_marker::is_marker_config("nanobarrel://config?xyz"));
  CHECK(channel_marker::channel_of("nanobarrel://config?xyz") == -1);
  CHECK(channel_marker::channel_of("") == -1);
}

TEST_CASE("CompositionCache resolves channel from a marker config blob",
          "[channel_marker][composition_cache]") {
  // A composition with one clip carrying a NanoLooper Ch marker on channel 2.
  const std::string blob = channel_marker::wrap_config("U-1", 2);
  json comp;
  comp["name"] = {{"valuetype", "ParamString"}, {"value", "C"}};
  json marker = {
    {"id", 900},
    {"name", "NanoLooper Ch"},
    {"params", {{"config", {{"id", 901}, {"valuetype", "ParamFile"},
                            {"value", blob}}}}},
  };
  json clip;
  clip["name"] = {{"valuetype", "ParamString"}, {"value", "Marked"}};
  clip["connected"] = {{"valuetype", "ParamState"}, {"value", "Disconnected"},
                       {"id", 950}};
  clip["video"]["effects"] = json::array({marker});
  json layer;
  layer["name"] = {{"valuetype", "ParamString"}, {"value", "Layer #"}};
  layer["clips"] = json::array({clip});
  comp["layers"] = json::array({layer});

  bridge::CompositionCache cache;
  cache.rebuild(resolume::parse_composition(comp));
  REQUIRE(cache.clip_count() == 1);
  bridge::CachedClip cc = cache.get_clip(0);
  // Marker channel 2 (1-based) → cache channel 1 (0-based).
  CHECK(cc.channel == 1);
  CHECK(cc.connect_path == "/composition/layers/1/clips/1/connect");  // 1-based API
  CHECK(cc.connected_param_id == 950);
}
