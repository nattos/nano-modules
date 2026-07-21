// test_published_state.cpp — the structured published-state store + the
// numeric readers that killed the per-frame JSON round-trips.
//
// state::set_val publishes STRUCTURED values onto the instance (no per-publish
// stringify); the frame-rate consumers read them numerically:
// publishedScalar (one scalar) and readTriggers (the 5-doubles-per-event
// effrt.h layout). publishedStateJson survives as the telemetry-only
// serialization (barrel plugin_states publish) and must stay byte-stable
// across frames so the downstream dedup-by-compare keeps working.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <nlohmann/json.hpp>

#include "runtime/effect_runtime.h"

using effect_runtime::EffectDesc;
using effect_runtime::EffectInstance;
using effect_runtime::readTriggersFromRing;
using nlohmann::json;

namespace {
EffectInstance makeInstance() {
  EffectDesc desc;
  desc.id = "test.published_state";
  return EffectInstance(nullptr, desc);
}
}  // namespace

TEST_CASE("hostSetVal stores structured; publishedScalar reads numerically") {
  auto inst = makeInstance();
  inst.hostSetVal("gain", json(0.75));
  inst.hostSetVal("armed", json(true));
  inst.hostSetVal("label", json("hi"));
  inst.hostSetVal("/slash_path", json(2.0));  // leading slash is stripped

  double v = 0.0;
  REQUIRE(inst.publishedScalar("gain", 4, &v));
  CHECK(v == 0.75);
  REQUIRE(inst.publishedScalar("armed", 5, &v));
  CHECK(v == 1.0);
  REQUIRE(inst.publishedScalar("slash_path", 10, &v));
  CHECK(v == 2.0);
  CHECK_FALSE(inst.publishedScalar("label", 5, &v));    // non-scalar
  CHECK_FALSE(inst.publishedScalar("missing", 7, &v));  // never published
}

TEST_CASE("whole-state replace clears and re-seeds the store") {
  auto inst = makeInstance();
  inst.hostSetVal("old", json(1.0));
  inst.hostSetVal("", json({{"fresh", 3.5}}));

  double v = 0.0;
  CHECK_FALSE(inst.publishedScalar("old", 3, &v));
  REQUIRE(inst.publishedScalar("fresh", 5, &v));
  CHECK(v == 3.5);
}

TEST_CASE("publishedStateJson is the byte-stable telemetry serialization") {
  auto inst = makeInstance();
  CHECK(inst.publishedStateJson().empty());
  inst.hostSetVal("b", json(2.0));
  inst.hostSetVal("a", json(1.0));
  const std::string first = inst.publishedStateJson();
  CHECK(json::parse(first) == json({{"a", 1.0}, {"b", 2.0}}));
  // Re-publishing the same values must serialize identically (dedup-by-compare
  // downstream in the barrel telemetry).
  inst.hostSetVal("b", json(2.0));
  CHECK(inst.publishedStateJson() == first);
}

TEST_CASE("readTriggers emits the effrt.h 5-double event layout") {
  auto inst = makeInstance();
  inst.hostSetVal("triggers", json::array({
      // Full event, strict with explicit deadline.
      {{"seq", 7}, {"on", true}, {"channel", 3}, {"velocity", 0.5},
       {"precision", {{"mode", "strict"}, {"deadline", 40}}}},
      // Strict with NO deadline → folds to the 100ms default.
      {{"seq", 8}, {"on", false}, {"channel", 1},
       {"precision", {{"mode", "strict"}}}},
      // Bare event: channel unpublished → NaN, velocity defaults to 1,
      // precision absent → deadline 0 ("any").
      {{"seq", 9}, {"on", true}},
  }));

  double buf[3 * 5] = {0};
  REQUIRE(inst.readTriggers(buf, 3) == 3);
  CHECK(buf[0] == 7.0);   // seq
  CHECK(buf[1] == 1.0);   // on
  CHECK(buf[2] == 3.0);   // channel
  CHECK(buf[3] == 0.5);   // velocity
  CHECK(buf[4] == 40.0);  // strict deadline

  CHECK(buf[5] == 8.0);
  CHECK(buf[6] == 0.0);
  CHECK(buf[7] == 1.0);
  CHECK(buf[9] == 100.0);  // strict, no deadline → 100

  CHECK(buf[10] == 9.0);
  CHECK(buf[11] == 1.0);
  CHECK(std::isnan(buf[12]));  // channel unpublished
  CHECK(buf[13] == 1.0);       // velocity default
  CHECK(buf[14] == 0.0);       // precision "any"
}

TEST_CASE("readTriggers: -1 = no ring, 0 = empty ring (watermark baselining)") {
  // The distinction is load-bearing: callers baseline their seq watermark on
  // an EXISTING-but-empty ring (count 0) so the first real event fires, but
  // defer on -1 (ring not published yet) so a populated ring's history isn't
  // replayed on first sight.
  auto inst = makeInstance();
  double buf[2 * 5] = {0};
  CHECK(inst.readTriggers(buf, 2) == -1);             // nothing published
  inst.hostSetVal("triggers", json(42.0));            // not an array
  CHECK(inst.readTriggers(buf, 2) == -1);
  inst.hostSetVal("triggers", json::array());         // empty ring exists
  CHECK(inst.readTriggers(buf, 2) == 0);
  inst.hostSetVal("triggers", json::array({
      {{"seq", 1}, {"on", true}, {"channel", 0}},
      {{"seq", 2}, {"on", true}, {"channel", 0}},
      {{"seq", 3}, {"on", true}, {"channel", 0}},
  }));
  CHECK(inst.readTriggers(buf, 2) == 2);              // cap truncates
  CHECK(buf[5] == 2.0);
}

TEST_CASE("readTriggersFromRing skips non-object entries") {
  const json ring = json::array({17, {{"seq", 4}, {"on", true}, {"channel", 2}}});
  double buf[5] = {0};
  REQUIRE(readTriggersFromRing(ring, buf, 4) == 1);
  CHECK(buf[0] == 4.0);
  CHECK(buf[2] == 2.0);
}
