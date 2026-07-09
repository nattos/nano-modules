#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "bridge/composition_cache.h"
#include "resolume/composition.h"

using bridge::CompositionCache;

// Minimal composition JSON with channel tags
static const char* TEST_COMPOSITION = R"({
  "name": {"value": "Test"},
  "layers": [
    {
      "id": 1,
      "name": {"value": "Layer 1"},
      "clips": [
        {
          "id": 101,
          "name": {"value": "Clip A"},
          "connected": {"value": "Connected", "id": 9001},
          "video": {
            "effects": [
              {
                "id": 201,
                "name": "NLCH",
                "display_name": "NanoLooper Ch",
                "params": {
                  "Channel": {"id": 301, "valuetype": "ParamFloat", "value": 0.0}
                }
              }
            ]
          }
        },
        {
          "id": 102,
          "name": {"value": "Clip B"},
          "connected": {"value": "Disconnected", "id": 9002},
          "video": {
            "effects": [
              {
                "id": 202,
                "name": "NLCH",
                "display_name": "NanoLooper Ch",
                "params": {
                  "Channel": {"id": 302, "valuetype": "ParamFloat", "value": 0.6667}
                }
              }
            ]
          }
        },
        {
          "id": 103,
          "name": {"value": "Clip C"},
          "connected": {"value": "Empty", "id": 9003}
        }
      ]
    },
    {
      "id": 2,
      "name": {"value": "Layer 2"},
      "clips": [
        {
          "id": 104,
          "name": {"value": "Clip D"},
          "connected": {"value": "Connected", "id": 9004},
          "video": {
            "effects": [
              {
                "id": 203,
                "name": "NLCH",
                "display_name": "NanoLooper Ch",
                "params": {
                  "Channel": {"id": 303, "valuetype": "ParamFloat", "value": 1.0}
                }
              }
            ]
          }
        }
      ]
    }
  ]
})";

TEST_CASE("CompositionCache empty before rebuild", "[composition_cache]") {
  CompositionCache cache;
  REQUIRE(cache.clip_count() == 0);
}

TEST_CASE("CompositionCache rebuild populates clips", "[composition_cache]") {
  auto j = nlohmann::json::parse(TEST_COMPOSITION);
  auto comp = resolume::parse_composition(j);

  CompositionCache cache;
  cache.rebuild(comp);

  REQUIRE(cache.clip_count() == 4);  // 3 from layer 1, 1 from layer 2
}

TEST_CASE("CompositionCache channel assignment from the marker Channel param", "[composition_cache]") {
  // The NanoLooper Ch marker exposes "Channel" as an FF_TYPE_STANDARD 0..1
  // slider; the server reads that broadcast value back via the shared
  // norm_to_channel encoding (0.0 -> ch1, 1.0 -> ch4). There is no "Off" — a
  // marker always names a channel; a clip with no marker is unassigned (-1).
  auto j = nlohmann::json::parse(TEST_COMPOSITION);
  auto comp = resolume::parse_composition(j);

  CompositionCache cache;
  cache.rebuild(comp);

  auto clip_a = cache.get_clip(0);
  REQUIRE(clip_a.clip_id == 101);
  REQUIRE(clip_a.name == "Clip A");
  REQUIRE(clip_a.channel == 0);  // 0.0 -> Channel 1 -> 0-based 0
  REQUIRE(clip_a.connected == true);
  REQUIRE(clip_a.connected_param_id == 9001);

  auto clip_b = cache.get_clip(1);
  REQUIRE(clip_b.clip_id == 102);
  REQUIRE(clip_b.channel == 2);  // 0.667 -> Channel 3 -> 0-based 2
  REQUIRE(clip_b.connected == false);

  auto clip_c = cache.get_clip(2);
  REQUIRE(clip_c.clip_id == 103);
  REQUIRE(clip_c.channel == -1);  // no marker effect

  auto clip_d = cache.get_clip(3);
  REQUIRE(clip_d.clip_id == 104);
  REQUIRE(clip_d.channel == 3);  // 1.0 -> Channel 4 -> 0-based 3
}

TEST_CASE("CompositionCache channel assignment across the slider range", "[composition_cache]") {
  auto j = nlohmann::json::parse(R"({
    "layers": [{
      "id": 1, "name": {"value": "L"},
      "clips": [
        {"id": 1, "name": {"value": "C1"}, "connected": {"value": "Connected", "id": 1},
         "video": {"effects": [{"id": 1, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 1, "valuetype": "ParamFloat", "value": 0.0}}}]}},
        {"id": 2, "name": {"value": "C2"}, "connected": {"value": "Connected", "id": 2},
         "video": {"effects": [{"id": 2, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 2, "valuetype": "ParamFloat", "value": 1.0}}}]}},
        {"id": 3, "name": {"value": "C3"}, "connected": {"value": "Connected", "id": 3},
         "video": {"effects": [{"id": 3, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 3, "valuetype": "ParamFloat", "value": 0.3333}}}]}}
      ]
    }]
  })");
  auto comp = resolume::parse_composition(j);

  CompositionCache cache;
  cache.rebuild(comp);

  REQUIRE(cache.get_clip(0).channel == 0);   // 0.0    -> Channel 1
  REQUIRE(cache.get_clip(1).channel == 3);   // 1.0    -> Channel 4
  REQUIRE(cache.get_clip(2).channel == 1);   // 0.333  -> Channel 2
}

TEST_CASE("CompositionCache resolves an uncapped channel from a text Channel param",
          "[composition_cache]") {
  // The marker's "Channel" is now an FF_TYPE_TEXT param holding the 1-based
  // channel integer as a string — uncapped (the old slider maxed at 4). The
  // param id is captured for write-back (channel reassignment).
  auto j = nlohmann::json::parse(R"({
    "layers": [{
      "id": 1, "name": {"value": "L"},
      "clips": [
        {"id": 1, "name": {"value": "C1"}, "connected": {"value": "Connected", "id": 1},
         "video": {"effects": [{"id": 1, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 701, "valuetype": "ParamText", "value": "7"}}}]}},
        {"id": 2, "name": {"value": "C2"}, "connected": {"value": "Connected", "id": 2},
         "video": {"effects": [{"id": 2, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 702, "valuetype": "ParamText", "value": "12"}}}]}}
      ]
    }]
  })");
  auto comp = resolume::parse_composition(j);

  CompositionCache cache;
  cache.rebuild(comp);

  auto c1 = cache.get_clip(0);
  REQUIRE(c1.channel == 6);              // "7" -> 1-based 7 -> 0-based 6
  REQUIRE(c1.channel_param_id == 701);  // captured for write-back

  auto c2 = cache.get_clip(1);
  REQUIRE(c2.channel == 11);            // "12" -> uncapped
  REQUIRE(c2.channel_param_id == 702);
}

TEST_CASE("CompositionCache find_by_marker and find_by_placement", "[composition_cache]") {
  auto j = nlohmann::json::parse(TEST_COMPOSITION);
  auto comp = resolume::parse_composition(j);
  CompositionCache cache;
  cache.rebuild(comp);

  // Clip A's marker uuid — rebuild decodes it from the config blob; here the
  // test comp has no blob, so marker_uuid is empty. Use placement instead for
  // the uuid-less clips, and assert find_by_marker misses on an unknown key.
  bridge::CachedClip out;
  REQUIRE_FALSE(cache.find_by_marker("does-not-exist", out));

  REQUIRE(cache.find_by_placement(0, 0, out));   // layer 0, clip 0 = Clip A
  REQUIRE(out.clip_id == 101);
  REQUIRE(out.connected == true);

  REQUIRE(cache.find_by_placement(1, 0, out));   // layer 1, clip 0 = Clip D
  REQUIRE(out.clip_id == 104);

  REQUIRE_FALSE(cache.find_by_placement(9, 9, out));  // out of range
}

TEST_CASE("CompositionCache out-of-bounds returns empty clip", "[composition_cache]") {
  CompositionCache cache;
  auto clip = cache.get_clip(999);
  REQUIRE(clip.clip_id == 0);
  REQUIRE(clip.channel == -1);
}

TEST_CASE("CompositionCache BPM get/set", "[composition_cache]") {
  CompositionCache cache;
  REQUIRE(cache.bpm() == 120.0);  // default
  cache.set_bpm(140.0);
  REQUIRE(cache.bpm() == 140.0);
}
