// test_skip_jog.cpp — fx::SkipJog (effect_utils.h): the shared "skip the empty
// stretches" engagement ramp used by source.brutal_fold / source.phase_fold.
//
// Locks the three properties the effects rely on:
//   1. Hysteresis — engages below `lo`, stays engaged until content clears `hi`.
//   2. C2 continuity — engagement (and its 1st/2nd time-derivative) is smooth
//      across the whole engage/disengage sweep, so a jog driven by it never pops.
//   3. rising() — a one-shot edge per empty stretch (for firing a snap).

#include <catch2/catch_all.hpp>
#include <effect_utils.h>
#include <vector>
#include <cmath>

using Catch::Approx;

namespace {
constexpr float kLo = 0.25f, kHi = 0.40f;
constexpr float kIn = 0.6f, kOut = 0.15f, kDt = 1.0f / 60.0f;

// Run the ramp to steady state at a fixed content, return final engagement.
float settle(fx::SkipJog& j, float content, int frames = 600) {
  float e = 0.0f;
  for (int i = 0; i < frames; i++) e = j.update(content, kLo, kHi, kIn, kOut, kDt);
  return e;
}

// Frames for engagement to first reach `mark` from the current state at a fixed
// content. Returns -1 if it never gets there within the cap.
int frames_to(fx::SkipJog& j, float content, float mark, bool rising, int cap = 2000) {
  for (int i = 0; i < cap; i++) {
    float e = j.update(content, kLo, kHi, kIn, kOut, kDt);
    if (rising ? (e >= mark) : (e <= mark)) return i + 1;
  }
  return -1;
}
}  // namespace

TEST_CASE("SkipJog engages when content falls below lo", "[skip_jog]") {
  fx::SkipJog j;
  REQUIRE(j.engaged == Approx(0.0f));
  float e = settle(j, 0.1f);                 // clearly empty
  REQUIRE(e == Approx(1.0f).margin(1e-4));   // fully engaged
}

TEST_CASE("SkipJog hysteresis: content in [lo,hi] holds state", "[skip_jog]") {
  // Engaged, then raise content into the dead band — must STAY engaged.
  fx::SkipJog up;
  settle(up, 0.1f);
  float held = settle(up, 0.32f);            // between lo and hi
  REQUIRE(held == Approx(1.0f).margin(1e-4));

  // Disengaged, then lower content into the dead band — must STAY disengaged.
  fx::SkipJog down;                          // starts disengaged
  float still = settle(down, 0.32f);
  REQUIRE(still == Approx(0.0f).margin(1e-4));

  // Only clearing hi releases it.
  float released = settle(up, 0.6f);
  REQUIRE(released == Approx(0.0f).margin(1e-4));
}

TEST_CASE("SkipJog engagement is C2 across a full engage/disengage sweep", "[skip_jog]") {
  fx::SkipJog j;
  std::vector<float> e;
  // 60 empty frames (engage, slow), then 60 rich frames (disengage, fast) —
  // spans both ends of both ramps.
  for (int i = 0; i < 60; i++) e.push_back(j.update(0.1f, kLo, kHi, kIn, kOut, kDt));
  for (int i = 0; i < 60; i++) e.push_back(j.update(0.9f, kLo, kHi, kIn, kOut, kDt));

  // First difference (velocity ∝) and second difference (accel ∝) stay bounded
  // and never jump — smootherstep has zero slope/curvature at both ends, and the
  // phase is linear in time, so there are no discontinuities to trip these. The
  // faster out-ramp bounds velocity by dt/ramp_out * (15/8).
  const float maxV = kDt / kOut * 2.0f;      // smootherstep peak slope is 15/8
  for (size_t i = 1; i < e.size(); i++) {
    float v = std::fabs(e[i] - e[i - 1]);
    REQUIRE(v <= maxV + 1e-4f);
  }
  // 2nd difference ≈ |S''|max·step² with step = dt/ramp_out ≈ 0.11 and
  // |S''|max ≈ 5.77 → ~0.071. Bound just above that; a true kink would be O(1).
  for (size_t i = 2; i < e.size(); i++) {
    float a = std::fabs(e[i] - 2.0f * e[i - 1] + e[i - 2]);
    REQUIRE(a <= 0.08f);                      // smooth sampling, no discontinuity
  }
  // Values stay in range throughout.
  for (float v : e) REQUIRE((v >= -1e-5f && v <= 1.0f + 1e-5f));
}

TEST_CASE("SkipJog disengages faster than it engages", "[skip_jog]") {
  // With ramp_out < ramp_in, leaving the skip (1→~0) must take fewer frames than
  // entering it (0→~1) — the harsher slowdown the effect wants.
  fx::SkipJog up;
  int in_frames = frames_to(up, 0.1f, 0.98f, /*rising=*/true);
  REQUIRE(in_frames > 0);
  fx::SkipJog down;
  settle(down, 0.1f);                         // fully engaged
  int out_frames = frames_to(down, 0.9f, 0.02f, /*rising=*/false);
  REQUIRE(out_frames > 0);
  REQUIRE(out_frames < in_frames);
  // Roughly tracks the ramp ratio (0.15 / 0.6 = 1/4), allowing slack.
  REQUIRE(out_frames <= in_frames / 2);
}

TEST_CASE("SkipJog rising() fires once per empty stretch", "[skip_jog]") {
  fx::SkipJog j;
  int edges = 0;
  auto run = [&](float content, int frames) {
    for (int i = 0; i < frames; i++) {
      j.update(content, kLo, kHi, kIn, kOut, kDt);
      if (j.rising()) edges++;
    }
  };
  run(0.1f, 100);        // empty → engage: exactly one rising edge
  REQUIRE(edges == 1);
  run(0.9f, 100);        // recover → disengage + re-arm
  run(0.1f, 100);        // empty again → a second edge
  REQUIRE(edges == 2);
}
