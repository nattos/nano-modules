// Unit tests for the process-global trigger_bus (emit / drain seq-gating,
// per-consumer watermarks, metadata version + infoJson).

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <string>

#include <nlohmann/json.hpp>

#include "sketch/trigger_bus.h"

using json = nlohmann::json;

namespace {
constexpr const char* kRail = trigger_bus::kGlobalRail;
}

TEST_CASE("drain returns only events newer than the consumer watermark",
          "[trigger_bus]") {
  trigger_bus::resetForTest();

  // A fresh consumer sees nothing until something is emitted.
  CHECK(trigger_bus::drain("server").empty());

  trigger_bus::emit(kRail, 3, /*on=*/true, 1.0f, "looper");
  trigger_bus::emit(kRail, 3, /*on=*/false, 0.0f, "looper");

  auto first = trigger_bus::drain("server");
  REQUIRE(first.size() == 2);
  CHECK(first[0].channel == 3);
  CHECK(first[0].on == true);
  CHECK(first[0].rail == std::string(kRail));
  CHECK(first[1].on == false);
  CHECK(first[0].seq < first[1].seq);

  // Nothing new → empty; the watermark advanced.
  CHECK(trigger_bus::drain("server").empty());

  // Only the new event comes back.
  trigger_bus::emit(kRail, 5, /*on=*/true, 0.5f, "trig");
  auto second = trigger_bus::drain("server");
  REQUIRE(second.size() == 1);
  CHECK(second[0].channel == 5);
  CHECK(second[0].velocity == 0.5f);
}

TEST_CASE("each consumer keeps an independent watermark", "[trigger_bus]") {
  trigger_bus::resetForTest();
  trigger_bus::emit(kRail, 1, true, 1.0f, "a");
  trigger_bus::emit(kRail, 2, true, 1.0f, "a");

  // Consumer A drains both.
  CHECK(trigger_bus::drain("A").size() == 2);
  // Consumer B, first sight, still sees both (its own watermark starts at 0).
  CHECK(trigger_bus::drain("B").size() == 2);
  // Both are now caught up.
  CHECK(trigger_bus::drain("A").empty());
  CHECK(trigger_bus::drain("B").empty());
}

TEST_CASE("metadata version bumps on new channels, not per event",
          "[trigger_bus]") {
  trigger_bus::resetForTest();
  const uint64_t v0 = trigger_bus::version();

  trigger_bus::emit(kRail, 7, true, 1.0f, "w1");
  const uint64_t v1 = trigger_bus::version();
  CHECK(v1 > v0);  // new channel is metadata

  // Same channel + same writer → no metadata change.
  trigger_bus::emit(kRail, 7, false, 0.0f, "w1");
  CHECK(trigger_bus::version() == v1);

  // A new writer on the channel IS metadata.
  trigger_bus::emit(kRail, 7, true, 1.0f, "w2");
  CHECK(trigger_bus::version() > v1);
}

TEST_CASE("infoJson reflects latest per-channel activity", "[trigger_bus]") {
  trigger_bus::resetForTest();
  trigger_bus::emit(kRail, 2, true, 0.8f, "looperX");

  std::string buf(512, '\0');
  int32_t n = trigger_bus::infoJson(buf.data(), (int32_t)buf.size());
  REQUIRE(n > 0);
  buf.resize(n);
  json j = json::parse(buf);

  REQUIRE(j.contains(kRail));
  REQUIRE(j[kRail].contains("2"));
  CHECK(j[kRail]["2"]["on"] == true);
  CHECK(j[kRail]["2"]["writer"] == "looperX");
  CHECK_THAT(j[kRail]["2"]["velocity"].get<double>(),
             Catch::Matchers::WithinAbs(0.8, 1e-6));
}

TEST_CASE("empty rail argument falls back to the global rail", "[trigger_bus]") {
  trigger_bus::resetForTest();
  trigger_bus::emit(nullptr, 1, true, 1.0f, "w");
  trigger_bus::emit("", 1, false, 0.0f, "w");
  auto ev = trigger_bus::drain("c");
  REQUIRE(ev.size() == 2);
  CHECK(ev[0].rail == std::string(trigger_bus::kGlobalRail));
  CHECK(ev[1].rail == std::string(trigger_bus::kGlobalRail));
}
