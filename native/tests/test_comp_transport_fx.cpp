// test_comp_transport_fx.cpp — the transport SECTION data model: a clip's
// `transport` mini-sketch (comp_model.h ClipM.transport ↔ composition.ts
// Clip.transport) and the driving-device precedence rule (sketch_build.h
// transportDeviceOf ↔ composition.ts clipTransportDevice). The executor
// pre-pass that consumes this lands on top; these are its model rails.

#include "sketch/comp/comp_catalog.h"
#include "sketch/comp/comp_model.h"
#include "sketch/comp/sketch_build.h"

#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace {

comp::Catalog transportCatalog() {
  comp::Catalog cat;
  cat.registerCapabilities("core.transport.time", json::array({"transport_controller"}));
  cat.registerCapabilities("testonly.streams_probe",
                           json::array({"transport_controller"}));
  cat.registerCapabilities("mod.source.lfo", json::array({"modulation_source"}));
  return cat;
}

}  // namespace

TEST_CASE("parseClip: transport section round-trips; absent stays absent",
          "[comp_transport_fx]") {
  const json withSection = {
      {"id", "c1"},
      {"startBeat", 0},
      {"lengthBeat", 8},
      {"sketch", {{"devices", json::array()}}},
      {"transport",
       {{"devices", json::array({{{"id", "t1"},
                                  {"moduleType", "core.transport.time"},
                                  {"state", {{"speed", 2.0}}}}})},
        {"wires", json::array()}}},
  };
  comp::ClipM c = comp::parseClip(withSection);
  REQUIRE(c.hasTransport);
  REQUIRE(c.transport.devices.size() == 1);
  CHECK(c.transport.devices[0].id == "t1");
  CHECK(c.transport.devices[0].moduleType == "core.transport.time");
  CHECK(c.transport.devices[0].state.value("speed", 0.0) == 2.0);

  comp::ClipM plain = comp::parseClip({{"id", "c2"}, {"startBeat", 0}, {"lengthBeat", 4}});
  CHECK(!plain.hasTransport);
  CHECK(plain.transport.devices.empty());

  // A present-but-non-object transport is treated as absent (defensive parse).
  comp::ClipM bad = comp::parseClip({{"id", "c3"}, {"transport", 7}});
  CHECK(!bad.hasTransport);
}

TEST_CASE("transportDeviceOf: precedence truth table (last catalog-known wins)",
          "[comp_transport_fx]") {
  const comp::Catalog cat = transportCatalog();
  auto clipWith = [](json devices) {
    return comp::parseClip({{"id", "c"},
                            {"sketch", {{"devices", json::array()}}},
                            {"transport", {{"devices", std::move(devices)}}}});
  };

  // No section ⇒ ClipLoopConfig drives.
  comp::ClipM none = comp::parseClip({{"id", "c"}});
  CHECK(comp::transportDeviceOf(none, cat) == nullptr);

  // A section whose devices the catalog doesn't tag as transport controllers
  // does NOT drive (an lfo parked there is inert).
  comp::ClipM inert = clipWith(json::array(
      {{{"id", "m1"}, {"moduleType", "mod.source.lfo"}}}));
  CHECK(comp::transportDeviceOf(inert, cat) == nullptr);

  // One controller drives.
  comp::ClipM one = clipWith(json::array(
      {{{"id", "t1"}, {"moduleType", "core.transport.time"}}}));
  const comp::DeviceM* d1 = comp::transportDeviceOf(one, cat);
  REQUIRE(d1 != nullptr);
  CHECK(d1->id == "t1");

  // Several: the LAST controller in section order wins; trailing non-transport
  // devices don't steal it.
  comp::ClipM many = clipWith(json::array({
      {{"id", "t1"}, {"moduleType", "core.transport.time"}},
      {{"id", "t2"}, {"moduleType", "testonly.streams_probe"}},
      {{"id", "m1"}, {"moduleType", "mod.source.lfo"}},
  }));
  const comp::DeviceM* dLast = comp::transportDeviceOf(many, cat);
  REQUIRE(dLast != nullptr);
  CHECK(dLast->id == "t2");
}

TEST_CASE("transportInstanceKey: the transport_ infix namespace",
          "[comp_transport_fx]") {
  CHECK(comp::transportInstanceKey("c1", "d1") == "clip_c1_transport_d1");
  // Disjoint from the pixel-sketch key of the same (clip, device) pair.
  CHECK(comp::transportInstanceKey("c1", "d1") != comp::clipInstanceKey("c1", "d1"));
  // Still clip_-prefixed so the streams self-scoping resolves the owner.
  CHECK(comp::transportInstanceKey("c1", "d1").rfind("clip_c1_", 0) == 0);
}
