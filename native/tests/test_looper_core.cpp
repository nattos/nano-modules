// Unit tests for the reworked NanoLooper sequencer core (wasm_modules/nanolooper
// /core.cpp), compiled natively (pure C++, cmath only). Covers the rework:
//   - a note records HOW LONG it was held (begin/end), and repeats that gate;
//   - onset quantization and length quantization are each independently optional;
//   - playback windows wrap the loop seam and diff cleanly per frame;
//   - a still-held (pending) note does not play back (the live press covers it).

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "../wasm_modules/nanolooper/core.h"

namespace {
bool active_ch(const LooperCore& c, double phase, int ch) {
  int a[NUM_CHANNELS];
  looper_active_channels(&c, phase, a);
  return a[ch] != 0;
}
constexpr double LOOP = (double)NUM_STEPS;  // 16
}  // namespace

TEST_CASE("note records its gate duration", "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);

  looper_begin_note(&c, 0, 2.0);
  looper_end_note(&c, 0, 5.0);

  REQUIRE(c.event_count == 1);
  CHECK(c.events[0].channel == 0);
  CHECK(c.events[0].start == 2.0);
  CHECK(c.events[0].length == 3.0);

  // The gate is on across [2, 5) and off elsewhere — repeats what was played.
  CHECK(active_ch(c, 2.0, 0));
  CHECK(active_ch(c, 4.99, 0));
  CHECK_FALSE(active_ch(c, 5.01, 0));
  CHECK_FALSE(active_ch(c, 1.0, 0));
  CHECK_FALSE(active_ch(c, 6.0, 0));
}

TEST_CASE("a held note plays back only after release (pending excluded)",
          "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);

  looper_begin_note(&c, 1, 4.0);  // still held — pending
  CHECK_FALSE(active_ch(c, 4.5, 1));  // live press covers it, not the sequencer

  looper_end_note(&c, 1, 7.0);
  CHECK(active_ch(c, 4.5, 1));  // now the recorded window plays back
  CHECK(active_ch(c, 6.9, 1));
  CHECK_FALSE(active_ch(c, 7.5, 1));
}

TEST_CASE("quantize_start floors the onset but keeps the real hold length",
          "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);
  looper_set_quantize(&c, /*q_start=*/1, /*q_length=*/0);

  looper_begin_note(&c, 0, 2.7);
  looper_end_note(&c, 0, 5.3);

  REQUIRE(c.event_count == 1);
  CHECK(c.events[0].start == 2.0);              // snapped down to the step grid
  CHECK(c.events[0].length == Catch::Approx(2.6));  // real hold (5.3 - 2.7)
}

TEST_CASE("quantize_length snaps the gate to whole steps, min one",
          "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);
  looper_set_quantize(&c, /*q_start=*/0, /*q_length=*/1);

  // A short tap still yields a one-step gate.
  looper_begin_note(&c, 0, 1.0);
  looper_end_note(&c, 0, 1.2);
  CHECK(c.events[0].length == 1.0);

  // 2.6 steps rounds up to 3.
  looper_begin_note(&c, 1, 1.0);
  looper_end_note(&c, 1, 3.6);
  CHECK(c.events[1].length == 3.0);
}

TEST_CASE("gate window wraps the loop seam", "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);

  looper_begin_note(&c, 2, 15.0);
  looper_end_note(&c, 2, 2.0);  // held across the seam: length 3 → [15, 18)

  REQUIRE(c.event_count == 1);
  CHECK(c.events[2 - 2].length == 3.0);  // events[0]
  CHECK(active_ch(c, 15.5, 2));
  CHECK(active_ch(c, 0.5, 2));   // wrapped tail
  CHECK(active_ch(c, 1.9, 2));
  CHECK_FALSE(active_ch(c, 2.5, 2));
  CHECK_FALSE(active_ch(c, 10.0, 2));
}

TEST_CASE("overdub at the same onset reuses the slot", "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);
  looper_set_quantize(&c, 1, 0);

  looper_begin_note(&c, 0, 3.0);
  looper_end_note(&c, 0, 4.0);
  looper_begin_note(&c, 0, 3.4);   // same step (3) — should not pile up
  looper_end_note(&c, 0, 7.0);

  CHECK(c.event_count == 1);
  CHECK(c.events[0].start == 3.0);
}

TEST_CASE("onset and coverage overlay queries", "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);

  looper_begin_note(&c, 0, 2.0);
  looper_end_note(&c, 0, 5.0);  // [2, 5): onset step 2, covers 2,3,4

  CHECK(looper_has_event(&c, 0, 2));
  CHECK_FALSE(looper_has_event(&c, 0, 3));

  CHECK(looper_step_covered(&c, 0, 2));
  CHECK(looper_step_covered(&c, 0, 3));
  CHECK(looper_step_covered(&c, 0, 4));
  CHECK_FALSE(looper_step_covered(&c, 0, 5));
  CHECK_FALSE(looper_step_covered(&c, 0, 1));
}

TEST_CASE("clear and undo restore the pattern", "[looper_core]") {
  LooperCore c;
  looper_init(&c, LOOP);

  looper_begin_note(&c, 0, 1.0);
  looper_end_note(&c, 0, 2.0);
  looper_begin_note(&c, 1, 4.0);
  looper_end_note(&c, 1, 6.0);
  REQUIRE(c.event_count == 2);

  looper_clear_channel(&c, 0);
  CHECK(c.event_count == 1);
  CHECK(c.events[0].channel == 1);

  looper_undo(&c);
  CHECK(c.event_count == 2);

  looper_clear_all(&c);
  CHECK(c.event_count == 0);
  looper_undo(&c);
  CHECK(c.event_count == 2);
}
