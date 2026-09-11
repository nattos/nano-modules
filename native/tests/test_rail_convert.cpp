// test_rail_convert.cpp — fitting a wire's value to the width of its destination.
//
// Replays the shared fixture web/test/fixtures/rail-convert-cases.json, which
// web/src/state/wire-convert-vocab.test.ts also reads. The TS side has no math
// to replay (the web runs this very code through executor.wasm) — it pins only
// that the editor's `WireConvert` union names the same modes, so a mode added
// here can't silently be un-selectable in the UI.
//
// Pure logic — no GPU, no bundles, no executor.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "sketch/rail_convert.h"

using nlohmann::json;
using Catch::Matchers::WithinAbs;

TEST_CASE("width conversion matches the shared fixture", "[rail_convert]") {
  std::ifstream f(RAIL_CONVERT_FIXTURE);
  REQUIRE(f.good());
  json fx;
  f >> fx;
  REQUIRE(fx.contains("cases"));

  for (const auto& c : fx.at("cases")) {
    const std::string name = c.value("name", std::string());
    INFO("case: " << name);

    std::vector<float> rail;
    for (const auto& v : c.at("rail")) rail.push_back((float)v.get<double>());

    std::vector<float> defaults;
    if (c.contains("destDefaults")) {
      for (const auto& v : c.at("destDefaults")) defaults.push_back((float)v.get<double>());
    }

    rail_convert::Lanes lanes;
    lanes.src = c.value("srcLane", -1);
    lanes.dest = c.value("destLane", -1);
    lanes.convert = rail_convert::parseConvert(c.value("convert", std::string("auto")));

    const int destWidth = c.at("destWidth").get<int>();
    const rail_convert::Fit fit = rail_convert::apply(
        rail.data(), (int)rail.size(), lanes, destWidth,
        defaults.data(), (int)defaults.size());

    const json& expected = c.at("expected");
    REQUIRE(fit.n == destWidth);
    REQUIRE((int)expected.size() == destWidth);

    for (int i = 0; i < destWidth; ++i) {
      INFO("lane " << i);
      const bool driven = (fit.laneMask & (1u << i)) != 0;
      if (expected[i].is_null()) {
        // Undriven: the consumer keeps what it had. comps[i] is meaningless.
        CHECK_FALSE(driven);
        continue;
      }
      CHECK(driven);
      CHECK_THAT(fit.comps[i], WithinAbs(expected[i].get<double>(), 1e-6));
    }
    // No stray bits above the destination width.
    const uint32_t inRange = (destWidth >= 32) ? ~0u : ((1u << destWidth) - 1u);
    CHECK((fit.laneMask & ~inRange) == 0u);
  }
}

TEST_CASE("convert mode names round-trip", "[rail_convert]") {
  for (auto m : {rail_convert::Convert::Auto, rail_convert::Convert::Broadcast,
                 rail_convert::Convert::Truncate, rail_convert::Convert::Pad}) {
    CHECK(rail_convert::parseConvert(rail_convert::convertName(m)) == m);
  }
  // Anything unrecognised is Auto — a document from a newer build that names a
  // mode this one doesn't have still connects, it just fits by the default rule.
  CHECK(rail_convert::parseConvert("") == rail_convert::Convert::Auto);
  CHECK(rail_convert::parseConvert("swizzle") == rail_convert::Convert::Auto);
}

TEST_CASE("a destination wider than float4 is clamped, not overrun", "[rail_convert]") {
  const float rail[] = {0.5f};
  rail_convert::Lanes lanes;
  const rail_convert::Fit fit =
      rail_convert::apply(rail, 1, lanes, 9, nullptr, 0);
  CHECK(fit.n == rail_convert::kMaxComps);
  CHECK(fit.laneMask == 0xFu);
}
