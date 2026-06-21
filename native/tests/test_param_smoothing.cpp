// test_param_smoothing.cpp — native half of the LOCK-STEP param-smoothing
// contract. These goldens MUST match web/src/param-smoothing.test.ts exactly:
// the engine `FieldOptions.smoothing` option and the mod.shaper.smooth shaper effect
// shape the ramp with the same math on both hosts. If a formula changes, change
// both files and keep these numbers in sync (same discipline as tap_mod).

#include "sketch/param_smoothing.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

using Catch::Matchers::WithinAbs;
using namespace param_smoothing;

TEST_CASE("advanceSmooth ramps linearly to a stepped target then holds", "[param_smoothing]") {
  // Settled at 0, target steps to 1 with a 1s linear ramp at dt=0.25.
  SmoothState st = initSmooth(0.0f, 1.0f);
  CHECK_THAT(advanceSmooth(st, 1.0f, 1.0f, 0.25f), WithinAbs(0.25, 1e-6));
  CHECK_THAT(advanceSmooth(st, 1.0f, 1.0f, 0.25f), WithinAbs(0.50, 1e-6));
  CHECK_THAT(advanceSmooth(st, 1.0f, 1.0f, 0.25f), WithinAbs(0.75, 1e-6));
  CHECK_THAT(advanceSmooth(st, 1.0f, 1.0f, 0.25f), WithinAbs(1.00, 1e-6));
  // Holds exactly at the target — no overshoot, no residual decay.
  CHECK(advanceSmooth(st, 1.0f, 1.0f, 0.25f) == 1.0f);
  CHECK(advanceSmooth(st, 1.0f, 1.0f, 5.0f) == 1.0f);
}

TEST_CASE("advanceSmooth clamps a big step to the target exactly", "[param_smoothing]") {
  SmoothState st = initSmooth(0.0f, 1.0f);
  CHECK(advanceSmooth(st, 1.0f, 1.0f, 10.0f) == 1.0f);
}

TEST_CASE("advanceSmooth treats duration <= 0 as instant", "[param_smoothing]") {
  SmoothState st = initSmooth(0.0f, 0.0f);
  CHECK(advanceSmooth(st, 1.0f, 0.0f, 0.016f) == 1.0f);
  SmoothState st2 = initSmooth(5.0f, 0.5f);
  CHECK(advanceSmooth(st2, -3.0f, -1.0f, 0.016f) == -3.0f);
}

TEST_CASE("advanceSmooth restarts from the current value on a mid-ramp retarget",
          "[param_smoothing]") {
  SmoothState st = initSmooth(0.0f, 1.0f);
  advanceSmooth(st, 1.0f, 1.0f, 0.25f);   // current = 0.25, heading to 1
  CHECK_THAT(st.current, WithinAbs(0.25, 1e-6));
  // Retarget to 0 while mid-ramp: start := current (0.25), timer resets.
  advanceSmooth(st, 0.0f, 1.0f, 0.0f);
  CHECK_THAT(st.start, WithinAbs(0.25, 1e-6));
  CHECK(st.target == 0.0f);
  CHECK(st.elapsed == 0.0f);
  // Now ramps 0.25 -> 0 over 1s.
  CHECK_THAT(advanceSmooth(st, 0.0f, 1.0f, 0.5f), WithinAbs(0.125, 1e-6));
  CHECK_THAT(advanceSmooth(st, 0.0f, 1.0f, 0.5f), WithinAbs(0.0, 1e-6));
}

TEST_CASE("initSmooth starts settled so a freshly-loaded param does not ramp from 0",
          "[param_smoothing]") {
  SmoothState st = initSmooth(0.7f, 1.0f);
  // Same target on the first frame ⇒ no reset, already at the value.
  CHECK(advanceSmooth(st, 0.7f, 1.0f, 0.016f) == 0.7f);
}
