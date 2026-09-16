// test_nk2_driver.cpp — the native half of the LOCK-STEP nanoKONTROL2 driver
// contract.
//
// Consumes the SAME golden fixture as web/src/midi/drivers/nanokontrol2.test.ts
// (native/tests/fixtures/nk2_goldens.json): identical MIDI bytes must emit
// identical {endpoint, value} events (1e-6 tolerance; TS folds in double, this
// driver in float) and identical outgoing bytes.
//
// Also pins the factory-scene CC map, which is copied from the Korg manual
// rather than derived — the TS test pins the same numbers, so a "tidy" on
// either side fails loudly here.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <fstream>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "midi/driver_registry.h"

using nlohmann::json;

static json loadGoldens() {
  std::ifstream f(NK2_GOLDENS_PATH);
  REQUIRE(f.good());
  return json::parse(f);
}

/// Sparse fixture patch over the ARRAY sections: { "faders": { "0": { "cc":
/// 99 } } } merges into config["faders"][0]. `configTop` sets top-level
/// scalars. Same application as the TS test.
static void applyPatches(json& config, const json& patch, const json& top) {
  if (patch.is_object()) {
    for (const auto& [section, entries] : patch.items()) {
      for (const auto& [idx, fields] : entries.items()) {
        auto& target = config[section][std::stoi(idx)];
        for (const auto& [k, v] : fields.items()) target[k] = v;
      }
    }
  }
  if (top.is_object()) {
    for (const auto& [k, v] : top.items()) config[k] = v;
  }
}

static std::unique_ptr<nano_midi::DeviceDriver> makeDriver(const json& config) {
  auto driver = nano_midi::createDriverForTemplate(nano_midi::kNk2TemplateId, config);
  REQUIRE(driver);
  return driver;
}

TEST_CASE("nanoKONTROL2 driver parse — shared goldens", "[nk2_driver]") {
  const json goldens = loadGoldens();
  for (const auto& g : goldens["parse"]) {
    SECTION(g.value("name", "?")) {
      json config = nano_midi::defaultNanoKontrol2Config();
      applyPatches(config, g.value("configPatch", json()), g.value("configTop", json()));

      std::vector<std::pair<std::string, float>> emitted;
      auto driver = makeDriver(config);
      const auto getValue = [](const std::string&) { return 0.0f; };
      const auto emit = [&](const std::string& ep, float v) { emitted.emplace_back(ep, v); };
      for (const auto& m : g["messages"]) {
        std::vector<uint8_t> bytes;
        for (const auto& b : m) bytes.push_back(static_cast<uint8_t>(b.get<int>()));
        driver->onMessage(bytes.data(), bytes.size(), getValue, emit);
      }

      const auto& expect = g["expect"];
      REQUIRE(emitted.size() == expect.size());
      for (size_t i = 0; i < emitted.size(); ++i) {
        CHECK(emitted[i].first == expect[i].value("controlId", ""));
        CHECK(emitted[i].second ==
              Catch::Approx(expect[i].value("value", 0.0)).margin(1e-6));
      }
    }
  }
}

TEST_CASE("nanoKONTROL2 driver renderOutput — shared goldens", "[nk2_driver]") {
  const json goldens = loadGoldens();
  for (const auto& g : goldens["render"]) {
    SECTION(g.value("name", "?")) {
      json config = nano_midi::defaultNanoKontrol2Config();
      applyPatches(config, g.value("configPatch", json()), g.value("configTop", json()));

      std::map<std::string, float> values;
      for (const auto& [k, v] : g["values"].items()) values[k] = v.get<float>();
      // Unknown endpoints read NaN, which the driver skips — the same thing
      // the TS side expresses as an absent map entry.
      const auto read = [&](const std::string& ep) {
        auto it = values.find(ep);
        return it != values.end() ? it->second : std::numeric_limits<float>::quiet_NaN();
      };

      std::vector<std::vector<int>> sent;
      const auto send = [&](uint8_t a, uint8_t b, uint8_t c) {
        sent.push_back({a, b, c});
      };

      auto driver = makeDriver(config);
      driver->renderOutput(read, send);
      const auto expectBytes = [&](const json& want, const std::vector<std::vector<int>>& got) {
        REQUIRE(got.size() == want.size());
        for (size_t i = 0; i < got.size(); ++i) {
          REQUIRE(got[i].size() == want[i].size());
          for (size_t b = 0; b < got[i].size(); ++b) {
            CHECK(got[i][b] == want[i][b].get<int>());
          }
        }
      };
      expectBytes(g["expect"], sent);

      // A second pass with unchanged values must be silent (lastSent dedupe).
      sent.clear();
      driver->renderOutput(read, send);
      expectBytes(g["repeatExpect"], sent);
    }
  }
}

TEST_CASE("nanoKONTROL2 factory config matches the manual's CC-mode scene",
          "[nk2_driver]") {
  const json c = nano_midi::defaultNanoKontrol2Config();
  CHECK(c["channel"].get<int>() == 0);
  CHECK(c["ledMode"].get<std::string>() == "internal");
  const auto ccs = [&](const char* group) {
    std::vector<int> out;
    for (const auto& e : c[group]) out.push_back(e.value("cc", -1));
    return out;
  };
  CHECK(ccs("faders") == std::vector<int>{0, 1, 2, 3, 4, 5, 6, 7});
  CHECK(ccs("knobs") == std::vector<int>{16, 17, 18, 19, 20, 21, 22, 23});
  CHECK(ccs("solo") == std::vector<int>{32, 33, 34, 35, 36, 37, 38, 39});
  CHECK(ccs("mute") == std::vector<int>{48, 49, 50, 51, 52, 53, 54, 55});
  CHECK(ccs("rec") == std::vector<int>{64, 65, 66, 67, 68, 69, 70, 71});
  // NK2_TRANSPORT order: trackPrev, trackNext, cycle, markerSet, markerPrev,
  // markerNext, rew, ff, stop, play, rec.
  CHECK(ccs("transport") == std::vector<int>{58, 59, 46, 60, 61, 62, 43, 44, 42, 41, 45});
}

TEST_CASE("nanoKONTROL2 slot bases are the wire contract", "[nk2_driver]") {
  // Changing any of these silently re-points every saved wire at a different
  // physical control, so they are pinned on both sides.
  CHECK(nano_midi::nk2Endpoint(0) == "b0/e00/turn");    // fader 1
  CHECK(nano_midi::nk2Endpoint(7) == "b0/e07/turn");    // fader 8
  CHECK(nano_midi::nk2Endpoint(8) == "b0/e08/turn");    // knob 1
  CHECK(nano_midi::nk2Endpoint(15) == "b0/e15/turn");   // knob 8
  CHECK(nano_midi::nk2Endpoint(16) == "b0/e16/press");  // S 1
  CHECK(nano_midi::nk2Endpoint(24) == "b0/e24/press");  // M 1
  CHECK(nano_midi::nk2Endpoint(32) == "b0/e32/press");  // R 1
  CHECK(nano_midi::nk2Endpoint(40) == "b0/e40/press");  // transport, first
  CHECK(nano_midi::nk2Endpoint(50) == "b0/e50/press");  // transport, last
  CHECK(nano_midi::kNk2Slots == 51);
}

TEST_CASE("the driver registry knows every template the editor can wire",
          "[nk2_driver]") {
  // A template with no native driver is silently skipped by the MIDI host, so
  // its controls feed the editor but never the barrel — the bug this file was
  // written for. Any template self-registered on the web needs an entry here.
  CHECK(nano_midi::createDriverForTemplate(nano_midi::kMftTemplateId,
                                           nano_midi::defaultMftConfig()) != nullptr);
  CHECK(nano_midi::createDriverForTemplate(nano_midi::kNk2TemplateId,
                                           nano_midi::defaultNanoKontrol2Config()) != nullptr);
  CHECK(nano_midi::createDriverForTemplate("com.nano.midi.nope", json::object()) == nullptr);
}
