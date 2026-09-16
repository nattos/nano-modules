// test_midi_host.cpp — headless MidiHost table goldens (no CoreMIDI start()).
//
// Two folds live here:
//   - `knownAs` fan-out: a wire may reference an alias uuid of a device (a
//     ghost adopted from another profile/composition — web
//     DeviceInstance.knownAs), and its rail key is the alias, so the alias
//     entry must carry the canonical device's values.
//   - CONTROL aliases (device→device wires, midi_alias.h): every endpoint in
//     an alias group reads the group's most recently written member, so a
//     spare controller can take over from a desk that stopped sending.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include "midi/midi_host.h"

using nlohmann::json;

TEST_CASE("externalScalars fans out per knownAs alias", "[midi_host]") {
  auto& host = nano_midi::MidiHost::instance();

  // Library: one device answering to two extra uuids. Values arrive via the
  // sim-override path (headless — no hardware), keyed by the CANONICAL id.
  host.setLibrary(json::parse(R"([
    { "id": "canon-uuid", "templateId": "com.nano.midi.mft",
      "name": "MFT", "knownAs": ["ghost-a", "ghost-b"], "identities": [] }
  ])"));
  host.setSimOverrides(json::parse(R"({
    "canon-uuid": { "b0/e05/turn": 0.42, "b1/e08/press": 1.0 }
  })"));

  const json out = host.externalScalars();
  REQUIRE(out.contains("midi:canon-uuid"));
  REQUIRE(out.contains("midi:ghost-a"));
  REQUIRE(out.contains("midi:ghost-b"));
  CHECK(out["midi:ghost-a"] == out["midi:canon-uuid"]);
  CHECK(out["midi:ghost-b"]["b0/e05/turn"].get<double>() == Catch::Approx(0.42));

  // An alias must never clobber a real entry: give the alias uuid its own
  // sim values — the direct entry wins over the fan-out copy.
  host.setSimOverrides(json::parse(R"({
    "canon-uuid": { "b0/e05/turn": 0.1 },
    "ghost-a":    { "b0/e05/turn": 0.9 }
  })"));
  const json out2 = host.externalScalars();
  CHECK(out2["midi:ghost-a"]["b0/e05/turn"].get<double>() == Catch::Approx(0.9));
  CHECK(out2["midi:canon-uuid"]["b0/e05/turn"].get<double>() == Catch::Approx(0.1));

  // Reset for any later tests sharing the singleton.
  host.setLibrary(json::array());
  host.setSimOverrides(json::object());
}

TEST_CASE("externalScalars folds control aliases, last touched winning", "[midi_host]") {
  auto& host = nano_midi::MidiHost::instance();
  host.setLibrary(json::parse(R"([
    { "id": "desk",  "templateId": "com.nano.midi.mft", "identities": [] },
    { "id": "spare", "templateId": "com.nano.midi.mft", "identities": [] }
  ])"));
  // One encoder aliased across the two desks, read out of a real sketch doc.
  host.setAliases(nano_midi::collectAliasEdges(json::parse(R"({
    "wires": [
      { "id": "a1", "src":  { "instanceKey": "midi:desk",  "field": "b0/e05/turn" },
                    "dest": { "instanceKey": "midi:spare", "field": "b0/e05/turn" } }
    ]
  })")));

  // Headless, so values arrive through the sim-override path — which stamps a
  // write sequence exactly as a hardware turn does.
  host.setSimOverrides(json::parse(R"({ "desk": { "b0/e05/turn": 1.0 } })"));
  json out = host.externalScalars();
  CHECK(out["midi:desk"]["b0/e05/turn"].get<double>() == 1.0);
  // The spare has reported nothing of its own and still answers for the desk.
  CHECK(out["midi:spare"]["b0/e05/turn"].get<double>() == 1.0);

  // The desk dies (stops writing) and the spare is turned: it takes over.
  host.setSimOverrides(json::parse(R"({
    "desk":  { "b0/e05/turn": 1.0 },
    "spare": { "b0/e05/turn": 0.25 }
  })"));
  out = host.externalScalars();
  CHECK(out["midi:desk"]["b0/e05/turn"].get<double>() == 0.25);
  CHECK(out["midi:spare"]["b0/e05/turn"].get<double>() == 0.25);

  // The desk comes back — the newer write wins again.
  host.setSimOverrides(json::parse(R"({
    "desk":  { "b0/e05/turn": 0.5 },
    "spare": { "b0/e05/turn": 0.25 }
  })"));
  out = host.externalScalars();
  CHECK(out["midi:desk"]["b0/e05/turn"].get<double>() == 0.5);
  CHECK(out["midi:spare"]["b0/e05/turn"].get<double>() == 0.5);

  // Un-aliased endpoints are untouched by any of this.
  host.setSimOverrides(json::parse(R"({
    "desk": { "b0/e05/turn": 0.5, "b0/e06/turn": 0.75 }
  })"));
  out = host.externalScalars();
  CHECK(out["midi:desk"]["b0/e06/turn"].get<double>() == 0.75);
  CHECK_FALSE(out["midi:spare"].contains("b0/e06/turn"));

  // Dropping the aliases restores each device to its own values.
  host.setAliases({});
  out = host.externalScalars();
  CHECK(out["midi:desk"]["b0/e05/turn"].get<double>() == 0.5);
  CHECK_FALSE(out.contains("midi:spare"));

  host.setLibrary(json::array());
  host.setSimOverrides(json::object());
}

TEST_CASE("setAliases bumps the version only on a real change", "[midi_host]") {
  auto& host = nano_midi::MidiHost::instance();
  const std::vector<nano_midi::AliasEdge> edges{
      { { "desk", "b0/e05/turn" }, { "spare", "b0/e05/turn" } }};
  host.setAliases(edges);
  const uint64_t v = host.version();
  host.setAliases(edges);
  CHECK(host.version() == v);          // identical set — no re-push
  host.setAliases({});
  CHECK(host.version() > v);
}

TEST_CASE("an untouched alias group leaves its endpoints dormant", "[midi_host]") {
  auto& host = nano_midi::MidiHost::instance();
  host.setAliases({{ { "ghost-a", "b0/e00/turn" }, { "ghost-b", "b0/e00/turn" } }});
  host.setSimOverrides(json::object());
  const json out = host.externalScalars();
  // No value anywhere in the group, so no rail is seeded and the wires that
  // read these endpoints keep their authored values.
  CHECK_FALSE(out.contains("midi:ghost-a"));
  CHECK_FALSE(out.contains("midi:ghost-b"));
  host.setAliases({});
}
