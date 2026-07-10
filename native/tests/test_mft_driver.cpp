// test_mft_driver.cpp — the native half of the LOCK-STEP MFT driver contract.
//
// Consumes the SAME golden fixture as web/src/midi/drivers/mft.test.ts
// (native/tests/fixtures/mft_goldens.json): identical MIDI bytes must emit
// identical {endpoint, value} events (1e-6 tolerance; TS folds in double,
// this driver in float) and identical outgoing bytes.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <cmath>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "midi/mft_driver.h"

using nlohmann::json;

static json loadGoldens() {
  std::ifstream f(MFT_GOLDENS_PATH);
  REQUIRE(f.good());
  return json::parse(f);
}

// Sparse fixture patch: { "encoders": { "5": { "mode": "relative" } } }
// merges into config["encoders"][5] — same application as the TS test.
static void applyConfigPatch(json& config, const json& patch) {
  if (!patch.is_object()) return;
  for (const auto& [section, entries] : patch.items()) {
    for (const auto& [idx, fields] : entries.items()) {
      auto& target = config[section][std::stoi(idx)];
      for (const auto& [k, v] : fields.items()) target[k] = v;
    }
  }
}

TEST_CASE("MFT driver parse — shared goldens", "[mft_driver]") {
  const json goldens = loadGoldens();
  for (const auto& g : goldens["parse"]) {
    SECTION(g.value("name", "?")) {
      json config = nano_midi::defaultMftConfig();
      applyConfigPatch(config, g.value("configPatch", json()));

      std::map<std::string, float> hardware;
      const json seeds = g.value("seedValues", json::object());
      for (const auto& [k, v] : seeds.items()) {
        hardware[k] = v.get<float>();
      }
      std::vector<std::pair<std::string, float>> emitted;

      auto driver = nano_midi::createDriverForTemplate(nano_midi::kMftTemplateId, config);
      REQUIRE(driver);
      const auto getValue = [&](const std::string& ep) {
        auto it = hardware.find(ep);
        return it != hardware.end() ? it->second : 0.0f;
      };
      const auto emit = [&](const std::string& ep, float v) {
        hardware[ep] = v;
        emitted.emplace_back(ep, v);
      };
      for (const auto& m : g["messages"]) {
        std::vector<uint8_t> bytes;
        for (const auto& b : m) bytes.push_back((uint8_t)b.get<int>());
        driver->onMessage(bytes.data(), bytes.size(), getValue, emit);
      }

      const auto& expect = g["expect"];
      REQUIRE(emitted.size() == expect.size());
      for (size_t i = 0; i < emitted.size(); ++i) {
        CHECK(emitted[i].first == expect[i].value("controlId", ""));
        CHECK(emitted[i].second ==
              Catch::Approx(expect[i].value("value", 0.0)).margin(1e-6));
      }
      if (g.contains("expectBank")) {
        CHECK(driver->activeBank() == g["expectBank"].get<int>());
      }
    }
  }
}

TEST_CASE("MFT driver renderOutput — shared goldens", "[mft_driver]") {
  const json goldens = loadGoldens();
  for (const auto& g : goldens["render"]) {
    SECTION(g.value("name", "?")) {
      json config = nano_midi::defaultMftConfig();
      applyConfigPatch(config, g.value("configPatch", json()));
      auto driver = nano_midi::createDriverForTemplate(nano_midi::kMftTemplateId, config);
      REQUIRE(driver);

      std::map<std::string, float> table;
      for (const auto& [k, v] : g["values"].items()) table[k] = v.get<float>();
      const auto values = [&](const std::string& ep) {
        auto it = table.find(ep);
        return it != table.end() ? it->second : std::nanf("");
      };

      std::vector<std::vector<int>> sent;
      const auto send = [&](uint8_t s, uint8_t d1, uint8_t d2) {
        sent.push_back({(int)s, (int)d1, (int)d2});
      };

      driver->renderOutput(values, send);
      json expected = g["expect"];
      REQUIRE(sent.size() == expected.size());
      for (size_t i = 0; i < sent.size(); ++i) {
        CHECK(sent[i] == expected[i].get<std::vector<int>>());
      }

      sent.clear();
      driver->renderOutput(values, send);
      CHECK(sent.size() == g["repeatExpect"].size());
    }
  }
}
