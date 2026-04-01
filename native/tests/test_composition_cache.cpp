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
                  "Channel": {"id": 301, "valuetype": "ParamChoice", "value": "Channel 1"}
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
                  "Channel": {"id": 302, "valuetype": "ParamChoice", "value": "Channel 3"}
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
                  "Channel": {"id": 303, "valuetype": "ParamChoice", "value": "Off"}
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

TEST_CASE("CompositionCache channel assignment from string values", "[composition_cache]") {
  auto j = nlohmann::json::parse(TEST_COMPOSITION);
  auto comp = resolume::parse_composition(j);

  CompositionCache cache;
  cache.rebuild(comp);

  auto clip_a = cache.get_clip(0);
  REQUIRE(clip_a.clip_id == 101);
  REQUIRE(clip_a.name == "Clip A");
  REQUIRE(clip_a.channel == 0);  // "Channel 1" -> 0
  REQUIRE(clip_a.connected == true);
  REQUIRE(clip_a.connected_param_id == 9001);

  auto clip_b = cache.get_clip(1);
  REQUIRE(clip_b.clip_id == 102);
  REQUIRE(clip_b.channel == 2);  // "Channel 3" -> 2
  REQUIRE(clip_b.connected == false);

  auto clip_c = cache.get_clip(2);
  REQUIRE(clip_c.clip_id == 103);
  REQUIRE(clip_c.channel == -1);  // no tag effect

  auto clip_d = cache.get_clip(3);
  REQUIRE(clip_d.clip_id == 104);
  REQUIRE(clip_d.channel == -1);  // "Off" -> -1
}

TEST_CASE("CompositionCache channel assignment from numeric values", "[composition_cache]") {
  auto j = nlohmann::json::parse(R"({
    "layers": [{
      "id": 1, "name": {"value": "L"},
      "clips": [
        {"id": 1, "name": {"value": "C1"}, "connected": {"value": "Connected", "id": 1},
         "video": {"effects": [{"id": 1, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 1, "valuetype": "ParamChoice", "value": 0.2}}}]}},
        {"id": 2, "name": {"value": "C2"}, "connected": {"value": "Connected", "id": 2},
         "video": {"effects": [{"id": 2, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 2, "valuetype": "ParamChoice", "value": 0.8}}}]}},
        {"id": 3, "name": {"value": "C3"}, "connected": {"value": "Connected", "id": 3},
         "video": {"effects": [{"id": 3, "name": "NLCH", "display_name": "NanoLooper Ch",
           "params": {"Channel": {"id": 3, "valuetype": "ParamChoice", "value": 0.0}}}]}}
      ]
    }]
  })");
  auto comp = resolume::parse_composition(j);

  CompositionCache cache;
  cache.rebuild(comp);

  REQUIRE(cache.get_clip(0).channel == 0);   // 0.2 -> Channel 1
  REQUIRE(cache.get_clip(1).channel == 3);   // 0.8 -> Channel 4
  REQUIRE(cache.get_clip(2).channel == -1);  // 0.0 -> Off
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
