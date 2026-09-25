// test_effect_migrations.cpp — effect state migrations
// (src/sketch/effect_migrations.h). The cases are shared with the web twin
// through web/test/fixtures/effect-migration-cases.json.

#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <iterator>
#include <string>

#include <nlohmann/json.hpp>

#include "sketch/effect_migrations.h"

TEST_CASE("effect migrations match the shared cases", "[effect_migrations]") {
  std::ifstream in(EFFECT_MIGRATION_FIXTURE);
  REQUIRE(in.good());
  const auto fixture = nlohmann::json::parse(
      std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()));
  for (const auto& c : fixture["cases"]) {
    INFO(c["name"].get<std::string>());
    nlohmann::json inst = c["instance"];
    effect_migrations::migrateInstance(inst);
    CHECK(inst == c["expected"]);
    // Idempotent: a second pass changes nothing.
    CHECK_FALSE(effect_migrations::migrateInstance(inst));
    CHECK(inst == c["expected"]);
  }
}

TEST_CASE("migrateSketch upgrades every instance", "[effect_migrations]") {
  auto sketch = nlohmann::json::parse(R"({
    "chain": [], "wires": [],
    "instances": {
      "a": {"module_type": "mod.source.lfo", "state": {"rate": 0.2}},
      "b": {"module_type": "mod.source.lfo", "state": {"rate": 7.5},
            "version": {"module": [1, 0, 0], "effect": [1, 2, 0]}}
    }})");
  CHECK(effect_migrations::migrateSketch(sketch));
  CHECK(sketch["instances"]["a"]["state"]["rate"].get<double>() == 2.0);
  CHECK(sketch["instances"]["b"]["state"]["rate"].get<double>() == 7.5);
  CHECK_FALSE(effect_migrations::migrateSketch(sketch));
}
