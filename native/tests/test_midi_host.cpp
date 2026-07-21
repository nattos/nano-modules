// test_midi_host.cpp — headless MidiHost table goldens (no CoreMIDI start()).
//
// The external-scalar table must fan out per `knownAs` alias: a wire may
// reference an alias uuid of a device (a ghost adopted from another
// profile/composition — web DeviceInstance.knownAs), and its rail key is the
// alias, so the alias entry must carry the canonical device's values.

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
