// test_delay_line.cpp — goldens for the time-stamped ring-buffer delay line
// (delay_line.h) backing the mod.shaper.delay shaper. Pins the interpolation + clamp +
// wraparound behavior. Uses a tiny capacity so buffer-full eviction is exercised.

#include "sketch/delay_line.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

using Catch::Matchers::WithinAbs;

TEST_CASE("delay line interpolates between bracketing samples", "[delay_line]") {
  delay_line::DelayLine<8> dl;
  dl.push(0.0, 0.0f);
  dl.push(1.0, 10.0f);
  dl.push(2.0, 20.0f);
  dl.push(3.0, 30.0f);

  // Exact sample times.
  CHECK_THAT(dl.read(2.0), WithinAbs(20.0, 1e-5));
  // Linear interpolation between samples.
  CHECK_THAT(dl.read(1.5), WithinAbs(15.0, 1e-5));
  CHECK_THAT(dl.read(0.25), WithinAbs(2.5, 1e-5));
  CHECK_THAT(dl.read(2.75), WithinAbs(27.5, 1e-5));
}

TEST_CASE("delay line clamps outside the buffered range", "[delay_line]") {
  delay_line::DelayLine<8> dl;
  dl.push(0.0, 5.0f);
  dl.push(1.0, 9.0f);
  // target >= newest → newest value (e.g. delay 0).
  CHECK(dl.read(1.0) == 9.0f);
  CHECK(dl.read(2.0) == 9.0f);
  // target older than the oldest sample → oldest value (graceful underrun).
  CHECK(dl.read(-1.0) == 5.0f);
  // Empty line reads 0.
  delay_line::DelayLine<8> empty;
  CHECK(empty.read(0.0) == 0.0f);
}

TEST_CASE("delay line evicts oldest samples when full (ring wraparound)", "[delay_line]") {
  delay_line::DelayLine<4> dl;   // holds only the 4 most recent samples
  for (int i = 0; i < 6; ++i) dl.push((double)i, (float)(i * 10));
  // Pushed t=0..5; only t=2,3,4,5 survive. Reading older than 2 clamps to t=2.
  CHECK(dl.read(2.0) == 20.0f);
  CHECK(dl.read(0.0) == 20.0f);   // 0 and 1 were evicted → clamp to oldest (t=2)
  CHECK_THAT(dl.read(3.5), WithinAbs(35.0, 1e-5));
  CHECK(dl.read(5.0) == 50.0f);   // newest
}

TEST_CASE("delay line models a fixed-dt read at a 2-frame lag", "[delay_line]") {
  // Push a ramp at dt=0.25 (clock 0.25, 0.5, ...) and read 0.5s in the past:
  // the output is the value from 2 frames ago.
  delay_line::DelayLine<64> dl;
  double clock = 0.0;
  float last = 0.0f;
  for (int i = 1; i <= 8; ++i) {
    clock += 0.25;
    const float value = (float)i;     // 1,2,3,...
    dl.push(clock, value);
    last = dl.read(clock - 0.5);      // 0.5s ago = 2 samples back
  }
  // At clock=2.0 (i=8, value 8), 0.5s ago is clock 1.5 → value 6.
  CHECK_THAT(last, WithinAbs(6.0, 1e-5));
}
