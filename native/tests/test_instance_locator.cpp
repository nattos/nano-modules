// Unit tests for bridge::InstanceLocator — enumerating NanoBarrel effects in a
// Resolume composition, resolving their inline config UUIDs, deriving default
// display names, and publishing them into the StateDocument.

#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include "bridge/instance_locator.h"
#include "bridge/state_document.h"
#include "plugin/nano_barrel/barrel_codec.h"
#include "plugin/nano_barrel/channel_marker_codec.h"

using json = nlohmann::json;
using namespace bridge;

namespace {

// Build a NanoBarrel effect node whose `config` FILE param carries `uuid`,
// mirroring the live-captured shape.
json make_barrel(const std::string& uuid, int64_t config_id) {
  json env = {{"sketch", {{"chain", json::array()}}}, {"uuid", uuid}};
  std::string blob = barrel_codec::wrap_config(env.dump());
  return {
    {"id", config_id + 1000},
    {"name", "NanoBarrel"},
    {"display_name", "NanoBarrel"},
    {"params", {
      {"config", {{"id", config_id}, {"valuetype", "ParamFile"}, {"value", blob}}},
      {"macro_00", {{"id", config_id + 1}, {"valuetype", "ParamRange"}, {"value", 0}}},
    }},
  };
}

json name_field(const std::string& v) {
  return {{"valuetype", "ParamString"}, {"value", v}};
}

// Build a NanoLooper Ch marker effect whose `config` FILE param carries
// {uuid, channel, name} in the nanoch:// scheme.
json make_marker(const std::string& uuid, int64_t config_id, int channel,
                 const std::string& name) {
  std::string blob = channel_marker::wrap_config(uuid, channel, name);
  return {
    {"id", config_id + 1000},
    {"name", "NanoLooper Ch"},
    {"display_name", "NanoLooper Ch"},
    {"params", {
      {"config", {{"id", config_id}, {"valuetype", "ParamFile"}, {"value", blob}}},
    }},
  };
}

// A composition with: a clip-mounted barrel, a layer-mounted barrel, and a
// composition-level barrel.
json make_composition() {
  json comp;
  comp["name"] = name_field("Hyrax IROIRO1");
  // Composition-level effect.
  comp["video"]["effects"] = json::array({make_barrel("COMP-UUID", 9000)});
  // Layer 0: no effects, one clip with no barrel.
  // Layer 1: a clip-mounted barrel + a layer-level barrel.
  json layer0 = {{"name", name_field("Layer #")}, {"clips", json::array()}};
  json layer1;
  layer1["name"] = name_field("Layer #");
  layer1["video"]["effects"] = json::array({make_barrel("LAYER-UUID", 8000)});
  json clip;
  clip["name"] = name_field("My Clip");
  clip["video"]["effects"] = json::array({make_barrel("CLIP-UUID", 7000)});
  layer1["clips"] = json::array({clip});
  comp["layers"] = json::array({layer0, layer1});
  return comp;
}

}  // namespace

TEST_CASE("enumerate finds barrels at all placement scopes", "[instance_locator]") {
  auto placements = InstanceLocator::enumerate(make_composition());
  REQUIRE(placements.size() == 3);

  // enumerate is a structural walk: it leaves uuid empty (update() resolves it
  // through a cache). Resolve here to index by uuid.
  std::map<std::string, BarrelPlacement> by_uuid;
  for (auto& p : placements) {
    CHECK(p.uuid.empty());
    p.uuid = InstanceLocator::resolve_uuid(p.config_value);
    by_uuid[p.uuid] = p;
  }

  REQUIRE(by_uuid.count("CLIP-UUID"));
  REQUIRE(by_uuid.count("LAYER-UUID"));
  REQUIRE(by_uuid.count("COMP-UUID"));

  auto& clip = by_uuid["CLIP-UUID"];
  CHECK(clip.scope == PlacementScope::Clip);
  CHECK(clip.path == "/layers/1/clips/0/video/effects/0");
  CHECK(clip.layer_index == 1);
  CHECK(clip.clip_index == 0);
  CHECK(clip.clip_name == "My Clip");
  CHECK(clip.config_param_id == 7000);
  CHECK(clip.config_value.rfind("nanobarrel://config?", 0) == 0);

  auto& layer = by_uuid["LAYER-UUID"];
  CHECK(layer.scope == PlacementScope::Layer);
  CHECK(layer.path == "/layers/1/video/effects/0");

  auto& c = by_uuid["COMP-UUID"];
  CHECK(c.scope == PlacementScope::Composition);
  CHECK(c.path == "/video/effects/0");
}

TEST_CASE("non-barrel effects are ignored", "[instance_locator]") {
  json comp;
  json layer;
  json clip;
  clip["name"] = name_field("x");
  clip["video"]["effects"] = json::array({
    {{"id", 1}, {"name", "Transform"}, {"params", {{"Angle", {{"id", 2}, {"valuetype", "ParamRange"}, {"value", 0}}}}}},
    // A config-less "NanoBarrel"-named effect must NOT match.
    {{"id", 3}, {"name", "NanoBarrel"}, {"params", json::object()}},
  });
  layer["name"] = name_field("Layer #");
  layer["clips"] = json::array({clip});
  comp["layers"] = json::array({layer});
  CHECK(InstanceLocator::enumerate(comp).empty());
}

TEST_CASE("default_name_for expands # and combines layer/clip", "[instance_locator]") {
  BarrelPlacement clip;
  clip.scope = PlacementScope::Clip;
  clip.layer_name = "Layer #";
  clip.layer_index = 1;  // ordinal 2
  clip.clip_name = "My Clip";
  clip.clip_index = 0;
  CHECK(InstanceLocator::default_name_for(clip) == "Layer 2 \xC2\xB7 My Clip");

  BarrelPlacement layer;
  layer.scope = PlacementScope::Layer;
  layer.layer_name = "Layer #";
  layer.layer_index = 2;  // ordinal 3
  CHECK(InstanceLocator::default_name_for(layer) == "Layer 3");

  BarrelPlacement comp;
  comp.scope = PlacementScope::Composition;
  comp.comp_name = "Hyrax IROIRO1";
  CHECK(InstanceLocator::default_name_for(comp) == "Hyrax IROIRO1");

  // Empty clip name → "Clip N".
  BarrelPlacement bare;
  bare.scope = PlacementScope::Clip;
  bare.layer_name = "";
  bare.layer_index = 0;
  bare.clip_name = "";
  bare.clip_index = 2;
  CHECK(InstanceLocator::default_name_for(bare) == "Layer 1 \xC2\xB7 Clip 3");
}

TEST_CASE("update publishes default names for registered instances", "[instance_locator]") {
  StateDocument doc;
  // Register the clip barrel's instance (== its UUID key).
  doc.register_plugin(PluginMetadata{"com.nano.nanobarrel", 0, 1, 0}, "CLIP-UUID");
  doc.drain_patches();  // clear registration patches

  InstanceLocator loc;
  loc.update(make_composition(), doc);

  // The registered instance got a resolume.default_name; unregistered ones did not.
  json entry = doc.get_at("/global/plugins/0");
  REQUIRE(entry.contains("resolume"));
  CHECK(entry["resolume"]["default_name"] == "Layer 2 \xC2\xB7 My Clip");
  CHECK(entry["resolume"]["location"] == "/layers/1/clips/0/video/effects/0");

  // A patch was emitted for the publish.
  auto patches = doc.drain_patches();
  bool saw_resolume = false;
  for (auto& p : patches) if (p.path.find("/resolume") != std::string::npos) saw_resolume = true;
  CHECK(saw_resolume);

  // Re-running with the same composition must NOT re-emit (dedupe).
  loc.update(make_composition(), doc);
  auto patches2 = doc.drain_patches();
  bool saw_resolume2 = false;
  for (auto& p : patches2) if (p.path.find("/resolume") != std::string::npos) saw_resolume2 = true;
  CHECK_FALSE(saw_resolume2);
}

TEST_CASE("editing a sketch (config changes, uuid stable) does not republish", "[instance_locator]") {
  // A barrel with uuid U and a given sketch payload, on layer 0 / clip 0.
  auto comp_with_sketch = [](const json& sketch) {
    std::string blob = barrel_codec::wrap_config(json({{"sketch", sketch}, {"uuid", "U"}}).dump());
    json barrel = {{"id", 5}, {"name", "NanoBarrel"},
                   {"params", {{"config", {{"id", 4242}, {"valuetype", "ParamFile"}, {"value", blob}}}}}};
    json clip;
    clip["name"] = name_field("Clip");
    clip["video"]["effects"] = json::array({barrel});
    json layer = {{"name", name_field("Layer #")}, {"clips", json::array({clip})}};
    return json{{"name", name_field("C")}, {"layers", json::array({layer})}};
  };

  StateDocument doc;
  doc.register_plugin(PluginMetadata{"com.nano.nanobarrel", 0, 1, 0}, "U");
  doc.drain_patches();

  InstanceLocator loc;
  loc.update(comp_with_sketch({{"chain", json::array()}}), doc);
  doc.drain_patches();  // clear the first publish

  // Edit the sketch: config blob changes (bigger), UUID stays "U".
  json big_sketch = {{"chain", json::array()}, {"blob", std::string(4096, 'x')}};
  loc.update(comp_with_sketch(big_sketch), doc);

  // Same location + name → no new resolume patch.
  bool republished = false;
  for (auto& p : doc.drain_patches())
    if (p.path.find("/resolume") != std::string::npos) republished = true;
  CHECK_FALSE(republished);
  CHECK(loc.paths_for_uuid("U").count("/layers/0/clips/0/video/effects/0"));
}

namespace {

// A layer with two clips, each carrying a barrel; configurable uuid, connected
// state, and config-param id per clip (so a fork write can be attributed).
json two_clip_comp(const std::string& uuidA, const std::string& connA, int64_t cfgA,
                   const std::string& uuidB, const std::string& connB, int64_t cfgB) {
  auto mkclip = [](const std::string& nm, const std::string& conn,
                   const std::string& uuid, int64_t cfg) {
    json clip;
    clip["name"] = name_field(nm);
    clip["connected"] = {{"valuetype", "ParamState"}, {"value", conn}};
    clip["video"]["effects"] = json::array({make_barrel(uuid, cfg)});
    return clip;
  };
  json layer;
  layer["name"] = name_field("Layer #");
  layer["clips"] = json::array({mkclip("A", connA, uuidA, cfgA),
                                mkclip("B", connB, uuidB, cfgB)});
  json comp;
  comp["name"] = name_field("C");
  comp["layers"] = json::array({layer});
  return comp;
}

// Wire an InstanceLocator with a capturing fork writer + deterministic minter.
struct ForkHarness {
  InstanceLocator loc;
  StateDocument doc;
  std::vector<std::pair<int64_t, std::string>> writes;  // (config_id, blob)
  int mint_n = 0;
  ForkHarness() {
    loc.set_dwell_ms(100);
    loc.set_uuid_minter([this] { return "NEW-" + std::to_string(++mint_n); });
    loc.set_fork_writer([this](int64_t id, const std::string& blob) {
      writes.push_back({id, blob});
    });
  }
};

}  // namespace

TEST_CASE("dormant copy-paste duplicate is forked after the dwell", "[instance_locator]") {
  ForkHarness h;
  auto comp = two_clip_comp("DUP", "Disconnected", 100, "DUP", "Disconnected", 200);

  // Before the dwell elapses: collision recorded, nothing forked.
  h.loc.update(comp, h.doc, /*now_ms=*/1000);
  CHECK(h.writes.empty());

  // After the dwell: the non-canonical dormant duplicate (larger path, cfg 200)
  // is forked; the canonical (smallest path, cfg 100) is left alone.
  h.loc.update(comp, h.doc, /*now_ms=*/1200);
  REQUIRE(h.writes.size() == 1);
  CHECK(h.writes[0].first == 200);

  // The forked blob carries a fresh uuid but the SAME sketch.
  CHECK(InstanceLocator::resolve_uuid(h.writes[0].second) == "NEW-1");
  CHECK(InstanceLocator::resolve_sketch(h.writes[0].second) ==
        InstanceLocator::resolve_sketch(barrel_codec::wrap_config(
            json({{"sketch", {{"chain", json::array()}}}, {"uuid", "DUP"}}).dump())));

  // Re-running with the unchanged composition must NOT re-fork (write-back is
  // still in flight; the blob hasn't changed).
  h.loc.update(comp, h.doc, /*now_ms=*/1300);
  CHECK(h.writes.size() == 1);
}

TEST_CASE("dormant duplicated marker is forked, preserving channel + name",
          "[instance_locator]") {
  ForkHarness h;
  // Two clips each carrying the SAME marker (uuid DUP, channel 3, "Bass"),
  // both dormant — the common "duplicate a clip to make a variation" case.
  auto mkclip = [](const std::string& nm, const std::string& uuid, int64_t cfg) {
    json clip;
    clip["name"] = name_field(nm);
    clip["connected"] = {{"valuetype", "ParamState"}, {"value", "Disconnected"}};
    clip["video"]["effects"] = json::array({make_marker(uuid, cfg, 3, "Bass")});
    return clip;
  };
  json layer;
  layer["name"] = name_field("Layer #");
  layer["clips"] = json::array({mkclip("A", "DUP", 100), mkclip("B", "DUP", 200)});
  json comp;
  comp["name"] = name_field("C");
  comp["layers"] = json::array({layer});

  h.loc.update(comp, h.doc, /*now_ms=*/1000);
  CHECK(h.writes.empty());                 // dwell not elapsed
  h.loc.update(comp, h.doc, /*now_ms=*/1200);

  // The non-canonical dormant duplicate (cfg 200) is forked with a fresh uuid,
  // and it stays a valid marker blob carrying the SAME channel + name.
  REQUIRE(h.writes.size() == 1);
  CHECK(h.writes[0].first == 200);
  const std::string& blob = h.writes[0].second;
  CHECK(channel_marker::is_marker_config(blob));
  CHECK(channel_marker::uuid_of(blob) == "NEW-1");
  CHECK(channel_marker::channel_of(blob) == 3);
  CHECK(channel_marker::name_of(blob) == "Bass");
}

TEST_CASE("a live copy is kept; the dormant one is forked regardless of path order",
          "[instance_locator]") {
  ForkHarness h;
  // clip 0 (smaller path) is DORMANT; clip 1 (larger path) is LIVE. Canonical
  // must follow live-ness, not path order → fork clip 0 (cfg 100), keep clip 1.
  auto comp = two_clip_comp("DUP", "Disconnected", 100, "DUP", "Connected", 200);
  h.loc.update(comp, h.doc, 1000);
  h.loc.update(comp, h.doc, 1200);
  REQUIRE(h.writes.size() == 1);
  CHECK(h.writes[0].first == 100);
}

TEST_CASE("two live copies are left to the registration-time remint", "[instance_locator]") {
  ForkHarness h;
  auto comp = two_clip_comp("DUP", "Connected", 100, "DUP", "Connected", 200);
  h.loc.update(comp, h.doc, 1000);
  h.loc.update(comp, h.doc, 1200);
  CHECK(h.writes.empty());
}

TEST_CASE("forking is disabled without a clock or once the collision clears",
          "[instance_locator]") {
  ForkHarness h;
  auto dup = two_clip_comp("DUP", "Disconnected", 100, "DUP", "Disconnected", 200);

  // now_ms == 0 disables forking entirely (Phase 1 naming still runs).
  h.loc.update(dup, h.doc, /*now_ms=*/0);
  CHECK(h.writes.empty());

  // A composition with distinct uuids never collides, so never forks.
  auto distinct = two_clip_comp("U1", "Disconnected", 100, "U2", "Disconnected", 200);
  h.loc.update(distinct, h.doc, 1000);
  h.loc.update(distinct, h.doc, 5000);
  CHECK(h.writes.empty());
}

TEST_CASE("copy-paste collision surfaces as one uuid at multiple paths", "[instance_locator]") {
  // Two clips carrying the SAME uuid (a Resolume copy-paste).
  json comp;
  json layer;
  layer["name"] = name_field("Layer #");
  json clipA, clipB;
  clipA["name"] = name_field("A");
  clipA["video"]["effects"] = json::array({make_barrel("DUP-UUID", 100)});
  clipB["name"] = name_field("B");
  clipB["video"]["effects"] = json::array({make_barrel("DUP-UUID", 200)});
  layer["clips"] = json::array({clipA, clipB});
  comp["layers"] = json::array({layer});

  StateDocument doc;
  InstanceLocator loc;
  loc.update(comp, doc);

  auto paths = loc.paths_for_uuid("DUP-UUID");
  REQUIRE(paths.size() == 2);
  CHECK(paths.count("/layers/0/clips/0/video/effects/0"));
  CHECK(paths.count("/layers/0/clips/1/video/effects/0"));
}
