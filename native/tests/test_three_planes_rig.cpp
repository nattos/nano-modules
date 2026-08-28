// test_three_planes_rig.cpp — goldens for the show logic behind
// `mod.rig.three_planes`. Host-free: three_planes_rig.h is deliberately free of
// the effect ABI so the meter's ballistics can be driven at an exact dt here,
// with no wasm bundle, no executor and no GPU.
//
// What the effect itself adds on top is the schema, the patch decode and the
// publish. Those are covered by web/test/three-planes-rig.test.ts, which is the
// only place the normalisation contract meets a real wire fold.

#include "sketch/three_planes_rig.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

using Catch::Matchers::WithinAbs;
using namespace three_planes_rig;

namespace {

/// One frame with an explicit gate pattern. Values are raw signal levels, so a
/// 0.49 exercises the quantizer's losing side.
Out step(Core& c, const Params& p, float s1, float s2, float s3, float s4, float dt) {
  const float sig[kSignals] = {s1, s2, s3, s4};
  return c.tick(p, sig, dt);
}

Out idle(Core& c, const Params& p, float dt) { return step(c, p, 0, 0, 0, 0, dt); }

/// The azimuth rail is a [0,1) turn, so an end pose past either end wraps.
double wrapped(double turn) {
  double f = turn - (double)(long long)turn;
  return f < 0.0 ? f + 1.0 : f;
}

constexpr double kBaseElevation = 35.264389682754654 / 89.0;
constexpr double kBaseSpacing = 0.42 / 1.5;

}  // namespace

TEST_CASE("a gate is on/off at 0.5 — velocity is thrown away", "[three_planes_rig]") {
  Core c;
  Params p;
  // Just under: nothing fires, the meter stays dead.
  CHECK(step(c, p, 0.49f, 0, 0, 0, 0.1f).meter == 0.0f);
  // Just over, and full-scale, land on exactly the same height.
  const float justOver = step(c, p, 0.51f, 0, 0, 0, 0.1f).meter;
  Core c2;
  const float full = step(c2, p, 1.0f, 0, 0, 0, 0.1f).meter;
  CHECK(justOver == full);
}

TEST_CASE("the meter steps up instantly and falls one floor per meter_fall", "[three_planes_rig]") {
  Core c;
  Params p;
  p.meter_fall = 0.5f;   // half a second per floor

  // A hit on signal 2 (level 2) is a STEP, not a ramp — one tick, full height.
  CHECK_THAT(step(c, p, 0, 1, 0, 0, 0.1f).meter, WithinAbs(2.0 / 3.0, 1e-6));

  // Then it falls at 1 floor / 0.5 s = 0.2 levels per 0.1 s tick.
  CHECK_THAT(idle(c, p, 0.1f).meter, WithinAbs(1.8 / 3.0, 1e-6));
  CHECK_THAT(idle(c, p, 0.1f).meter, WithinAbs(1.6 / 3.0, 1e-6));

  // A fresh hit while it is still falling re-seats it at full height.
  CHECK_THAT(step(c, p, 0, 1, 0, 0, 0.1f).meter, WithinAbs(2.0 / 3.0, 1e-6));

  // And it bottoms out at 0 rather than going negative.
  for (int i = 0; i < 100; ++i) idle(c, p, 0.1f);
  CHECK(c.meter == 0.0f);
}

TEST_CASE("the peak holds flat, then sinks, and never falls below the meter", "[three_planes_rig]") {
  Core c;
  Params p;
  p.meter_fall = 0.1f;   // meter drops a floor per tick below
  p.peak_hold = 0.5f;
  p.peak_fall = 1.0f;    // a floor per second once the hold expires

  CHECK_THAT(step(c, p, 0, 0, 1, 0, 0.1f).peak, WithinAbs(1.0, 1e-6));   // 3/3

  // Five ticks of 0.1 s reach the hold exactly; the cap has not moved.
  for (int i = 0; i < 5; ++i) idle(c, p, 0.1f);
  CHECK_THAT(c.peak, WithinAbs(3.0, 1e-6));
  CHECK(c.meter == 0.0f);   // the meter is long gone — that is the point of a cap

  // Past the hold it sinks at 0.1 levels per tick.
  CHECK_THAT(idle(c, p, 0.1f).peak, WithinAbs(2.9 / 3.0, 1e-6));
  CHECK_THAT(idle(c, p, 0.1f).peak, WithinAbs(2.8 / 3.0, 1e-6));

  // A hit that lands BELOW the cap does not re-arm it. The cap is a record of
  // how loud it got, so a quieter hit must not reach up and hold it — it keeps
  // sinking on the timer it was already on.
  CHECK_THAT(step(c, p, 0, 1, 0, 0, 0.1f).peak, WithinAbs(2.7 / 3.0, 1e-6));
  CHECK(c.hold_t > p.peak_hold);

  // A hit that reaches the cap DOES re-arm it, hold and all.
  for (int i = 0; i < 5; ++i) idle(c, p, 0.1f);   // sink it well under 3
  REQUIRE(c.peak < 3.0f);
  CHECK_THAT(step(c, p, 0, 0, 1, 0, 0.1f).peak, WithinAbs(1.0, 1e-6));
  CHECK(c.hold_t == 0.0f);
}

TEST_CASE("signals 3 and 4 share the top floor", "[three_planes_rig]") {
  Params p;   // default levels 1 / 2 / 3 / 3
  Core a, b;
  const Out o3 = step(a, p, 0, 0, 1, 0, 0.1f);
  const Out o4 = step(b, p, 0, 0, 0, 1, 0.1f);
  CHECK(o3.peak_layer == 2);
  CHECK(o4.peak_layer == 2);
  CHECK(o3.emission[2] == o4.emission[2]);
  CHECK(o3.meter == o4.meter);
}

TEST_CASE("Allow Holes lights only what is ringing — except the cap", "[three_planes_rig]") {
  Params p;
  p.emission_on = 1.0f;
  p.emission_off = 0.12f;
  p.flam_emission = 0.0f;   // isolate the lit/unlit decision from the blip

  // A lone top-floor hit. Filled in: the whole tower is lit under the meter.
  {
    Core c;
    const Out o = step(c, p, 0, 0, 1, 0, 0.1f);
    CHECK(o.peak_layer == 2);
    CHECK_THAT(o.emission[0], WithinAbs(1.0, 1e-6));
    CHECK_THAT(o.emission[1], WithinAbs(1.0, 1e-6));
    CHECK_THAT(o.emission[2], WithinAbs(1.0, 1e-6));
  }
  // With holes: only the floor that actually fired, plus the cap (which is the
  // same floor here), so the two below go dark under an active meter.
  {
    Core c;
    p.allow_holes = true;
    const Out o = step(c, p, 0, 0, 1, 0, 0.1f);
    CHECK_THAT(o.emission[0], WithinAbs(0.12, 1e-6));
    CHECK_THAT(o.emission[1], WithinAbs(0.12, 1e-6));
    CHECK_THAT(o.emission[2], WithinAbs(1.0, 1e-6));
  }
}

TEST_CASE("the cap flams the OTHER way round", "[three_planes_rig]") {
  Params p;
  p.flam_color = 1.0f;
  p.flam_time = 0.2f;
  Core c;

  // Bottom and top fire together: the top wears the cap, the bottom does not.
  const Out hit = step(c, p, 1, 0, 1, 0, 0.01f);
  REQUIRE(hit.peak_layer == 2);
  // A plain floor flams to PRIMARY (magenta).
  CHECK_THAT(hit.color[0].r, WithinAbs(p.primary.r, 1e-5));
  CHECK_THAT(hit.color[0].g, WithinAbs(p.primary.g, 1e-5));
  CHECK_THAT(hit.color[0].b, WithinAbs(p.primary.b, 1e-5));
  // The cap flams to SECONDARY (violet) — inverted, so the top never reads like
  // the rest of the tower even mid-hit.
  CHECK_THAT(hit.color[2].r, WithinAbs(p.secondary.r, 1e-5));
  CHECK_THAT(hit.color[2].g, WithinAbs(p.secondary.g, 1e-5));
  CHECK_THAT(hit.color[2].b, WithinAbs(p.secondary.b, 1e-5));

  // Once the flams retire, a plain floor rests on SECONDARY and the cap on
  // HIGHLIGHT (cyan).
  for (int i = 0; i < 40; ++i) idle(c, p, 0.01f);
  const Out rest = idle(c, p, 0.01f);
  REQUIRE(rest.peak_layer == 2);   // still held
  CHECK_THAT(rest.color[0].r, WithinAbs(p.secondary.r, 1e-5));
  CHECK_THAT(rest.color[0].b, WithinAbs(p.secondary.b, 1e-5));
  CHECK_THAT(rest.color[2].r, WithinAbs(p.highlight.r, 1e-5));
  CHECK_THAT(rest.color[2].g, WithinAbs(p.highlight.g, 1e-5));
  CHECK_THAT(rest.color[2].b, WithinAbs(p.highlight.b, 1e-5));
}

TEST_CASE("a flam brightens its own floor and retires", "[three_planes_rig]") {
  Params p;
  p.flam_time = 0.1f;
  p.flam_emission = 0.5f;
  p.emission_on = 0.4f;    // leave headroom, or the blip just clamps at 1
  p.emission_off = 0.0f;
  Core c;

  // Lit base plus the full blip on the frame it lands.
  const Out hit = step(c, p, 1, 0, 0, 0, 0.02f);
  CHECK_THAT(hit.emission[0], WithinAbs(0.9, 1e-6));
  // Ease-out: (1 - t/T)^2, so it is already well down a fifth of the way in.
  const Out mid = idle(c, p, 0.02f);
  CHECK(mid.emission[0] < hit.emission[0]);
  CHECK(mid.emission[0] > p.emission_on);
  // Well past flam_time nothing is ringing any more.
  for (int i = 0; i < 10; ++i) idle(c, p, 0.02f);
  CHECK(c.flam_live[0] == false);
}

TEST_CASE("an idle rig publishes the baselines, normalised", "[three_planes_rig]") {
  Core c;
  Params p;
  const Out o = idle(c, p, 0.016f);
  CHECK_THAT(o.azimuth, WithinAbs(0.125, 1e-6));
  CHECK_THAT(o.elevation, WithinAbs(kBaseElevation, 1e-6));
  CHECK_THAT(o.spacing, WithinAbs(kBaseSpacing, 1e-6));
  CHECK(o.anim_phase == 0.0f);
}

TEST_CASE("Show pops in at +half, eases across, and pops back", "[three_planes_rig]") {
  Core c;
  Params p;
  p.show_time = 1.0f;
  p.show_azimuth = 30.0f;

  c.trigger(AnimShow, p);
  // FIRST tick is already at the start pose — that discontinuity from the
  // baseline is the gesture, not an artefact.
  const Out first = idle(c, p, 1e-4f);
  CHECK_THAT(first.azimuth, WithinAbs(0.125 + 15.0 / 360.0, 2e-4));

  float last = first.azimuth;
  bool retired = false;
  for (int i = 0; i < 20000 && !retired; ++i) {
    const Out o = idle(c, p, 1e-4f);
    if (c.anim == AnimNone) {
      // And the SECOND pop: straight back to baseline the frame it expires.
      CHECK_THAT(o.azimuth, WithinAbs(0.125, 1e-6));
      CHECK(o.anim_phase == 0.0f);
      retired = true;
    } else {
      last = o.azimuth;
    }
  }
  REQUIRE(retired);
  CHECK_THAT(last, WithinAbs(0.125 - 15.0 / 360.0, 2e-4));
}

TEST_CASE("Sweep Up ends on its target elevation, then pops back", "[three_planes_rig]") {
  Core c;
  Params p;
  p.sweep_time = 0.5f;
  p.sweep_target = 0.0f;   // side-on

  c.trigger(AnimSweepUp, p);
  // Starts ON the baseline — this is the one move with no start-pop.
  CHECK_THAT(idle(c, p, 1e-4f).elevation, WithinAbs(kBaseElevation, 1e-3));

  // Keep the last frame the move actually produced — the retiring tick already
  // reads as the baseline, which is the pop asserted separately below.
  float last = 1.0f;
  while (c.anim != AnimNone) {
    const Out o = idle(c, p, 1e-4f);
    if (c.anim != AnimNone) last = o.elevation;
  }
  CHECK_THAT(last, WithinAbs(0.0, 1e-3));
  CHECK_THAT(idle(c, p, 1e-4f).elevation, WithinAbs(kBaseElevation, 1e-6));
}

TEST_CASE("Unfold grows from nothing and LANDS on the baseline", "[three_planes_rig]") {
  Core c;
  Params p;
  p.unfold_time = 0.5f;

  c.trigger(AnimUnfold, p);
  CHECK_THAT(idle(c, p, 1e-4f).spacing, WithinAbs(0.0, 1e-3));

  float last = 0.0f;
  while (c.anim != AnimNone) {
    const Out o = idle(c, p, 1e-4f);
    if (c.anim != AnimNone) last = o.spacing;
  }
  // No end-pop: the last animated frame and the first idle one agree.
  CHECK_THAT(last, WithinAbs(kBaseSpacing, 1e-3));
  CHECK_THAT(idle(c, p, 1e-4f).spacing, WithinAbs(kBaseSpacing, 1e-6));
}

TEST_CASE("Glance lifts the deck while it swings", "[three_planes_rig]") {
  Core c;
  Params p;
  p.glance_time = 0.5f;
  p.glance_azimuth = 30.0f;
  p.glance_elevation = 15.0f;

  c.trigger(AnimGlance, p);
  const Out first = idle(c, p, 1e-4f);
  CHECK_THAT(first.azimuth, WithinAbs(0.125 + 15.0 / 360.0, 2e-4));
  CHECK_THAT(first.elevation, WithinAbs((35.264389682754654 - 7.5) / 89.0, 2e-4));

  Out last = first;
  while (c.anim != AnimNone) {
    const Out o = idle(c, p, 1e-4f);
    if (c.anim != AnimNone) last = o;
  }
  CHECK_THAT(last.azimuth, WithinAbs(0.125 - 15.0 / 360.0, 2e-4));
  CHECK_THAT(last.elevation, WithinAbs((35.264389682754654 + 7.5) / 89.0, 2e-4));
}

TEST_CASE("the moves are monophonic — a new one drops the old", "[three_planes_rig]") {
  Core c;
  Params p;
  p.show_time = 2.0f;
  p.glance_time = 0.5f;

  c.trigger(AnimShow, p);
  for (int i = 0; i < 10; ++i) idle(c, p, 0.01f);
  REQUIRE(c.anim == AnimShow);

  c.trigger(AnimGlance, p);
  CHECK(c.anim == AnimGlance);
  CHECK(c.anim_t == 0.0f);
  CHECK_THAT(c.anim_dur, WithinAbs(0.5, 1e-6));
}

TEST_CASE("a transport stall is clamped, not fast-forwarded", "[three_planes_rig]") {
  Core c;
  Params p;
  p.meter_fall = 1.0f;
  p.peak_hold = 0.0f;
  p.peak_fall = 1.0f;

  step(c, p, 0, 0, 1, 0, 0.016f);
  REQUIRE(c.meter == 3.0f);
  // Ten seconds of wall clock arrives as one frame; ageing by it would blank
  // the whole tower. kMaxDt caps the step at a quarter second.
  idle(c, p, 10.0f);
  CHECK_THAT(c.meter, WithinAbs(3.0 - 0.25, 1e-6));
}

// --- Solid ------------------------------------------------------------------
//
// The mode that does nothing, which is the point of it. These cases mostly
// assert ABSENCES: no reaction to the gates, no cap, no flam.

TEST_CASE("Solid lights every floor and ignores the signals entirely", "[three_planes_rig]") {
  Params p;
  p.mode = ModeSolid;
  p.emission_on = 0.8f;
  Core c;

  // Full-scale hits on every channel at once — in the meter mode this would peg
  // the tower and fire three flams. Here it changes nothing at all.
  const Out hit = step(c, p, 1, 1, 1, 1, 0.1f);
  const Out quiet = idle(c, p, 0.1f);

  for (int i = 0; i < kLayers; ++i) {
    CHECK_THAT(hit.emission[i], WithinAbs(0.8, 1e-6));
    CHECK_THAT(quiet.emission[i], WithinAbs(0.8, 1e-6));
  }
  // No meter, no cap: the rails report the meter, and there isn't one.
  CHECK(hit.meter == 0.0f);
  CHECK(hit.peak == 0.0f);
  CHECK(hit.peak_layer == -1);
}

TEST_CASE("Solid colours the floors the way three_planes ships them", "[three_planes_rig]") {
  Params p;
  p.mode = ModeSolid;
  Core c;
  const Out o = step(c, p, 1, 1, 1, 1, 0.1f);

  // bottom = Primary, middle = Highlight, top = Secondary — the three roles'
  // defaults ARE the effect's own plane1/2/3 defaults, so an untouched rig in
  // this mode reproduces the unwired look.
  CHECK_THAT(o.color[0].r, WithinAbs(p.primary.r, 1e-6));
  CHECK_THAT(o.color[0].b, WithinAbs(p.primary.b, 1e-6));
  CHECK_THAT(o.color[1].g, WithinAbs(p.highlight.g, 1e-6));
  CHECK_THAT(o.color[1].b, WithinAbs(p.highlight.b, 1e-6));
  CHECK_THAT(o.color[2].r, WithinAbs(p.secondary.r, 1e-6));
  CHECK_THAT(o.color[2].g, WithinAbs(p.secondary.g, 1e-6));

  // And a hit does not swing them — there are no flams in this mode.
  const Out again = step(c, p, 0, 0, 0, 0, 0.05f);
  CHECK_THAT(again.color[0].r, WithinAbs(p.primary.r, 1e-6));
}

TEST_CASE("the moves still run in Solid", "[three_planes_rig]") {
  Params p;
  p.mode = ModeSolid;
  p.unfold_time = 1.0f;
  Core c;

  idle(c, p, 0.1f);
  c.trigger(AnimUnfold, p);
  // Unfold starts collapsed and grows to the baseline — the tower is static,
  // the camera is not.
  CHECK_THAT(idle(c, p, 0.01f).spacing, WithinAbs(0.0, 1e-3));
  for (int i = 0; i < 40; ++i) idle(c, p, 0.01f);
  const float mid = idle(c, p, 0.01f).spacing;
  CHECK(mid > 0.0f);
  CHECK(mid < kBaseSpacing);
}

TEST_CASE("Solid parks the meter, and the way back is not a hit", "[three_planes_rig]") {
  Params p;
  p.peak_hold = 10.0f;    // a cap that would still be standing on the way back
  Core c;

  // Peg it in the meter mode.
  const Out loud = step(c, p, 0, 0, 1, 0, 0.1f);
  CHECK_THAT(loud.meter, WithinAbs(1.0, 1e-6));
  CHECK(loud.peak_layer == 2);

  // A spell in Solid, with the signal still held high the whole time.
  p.mode = ModeSolid;
  for (int i = 0; i < 5; ++i) step(c, p, 0, 0, 1, 0, 0.1f);

  // Back to the meter with the signal RELEASED: the ballistics resume from
  // zero, not from the reading they were parked on. A cap that would still have
  // seconds of hold left is gone with them.
  p.mode = ModeEvMeter;
  const Out back = step(c, p, 0, 0, 0, 0, 0.1f);
  CHECK(back.meter == 0.0f);
  CHECK(back.peak == 0.0f);
  CHECK(back.peak_layer == -1);
}

TEST_CASE("a signal held across a mode change does not read as a fresh hit",
          "[three_planes_rig]") {
  Params p;
  p.emission_on = 0.4f;   // headroom, so a flam blip would show
  p.flam_emission = 0.5f;
  Core c;

  step(c, p, 0, 0, 1, 0, 0.1f);          // the hit, in the meter mode
  p.mode = ModeSolid;
  for (int i = 0; i < 5; ++i) step(c, p, 0, 0, 1, 0, 0.1f);

  // Still high on the way back. The meter is level-driven, so it re-reads the
  // height immediately — that is a meter doing its job, not a retrigger...
  p.mode = ModeEvMeter;
  const Out back = step(c, p, 0, 0, 1, 0, 0.1f);
  CHECK_THAT(back.meter, WithinAbs(1.0, 1e-6));
  // ...but there is no FLAM, because the edge was consumed before the mode
  // changed and `prev_on` kept tracking through the quiet mode.
  CHECK_THAT(back.emission[2], WithinAbs(0.4, 1e-6));

  // Dropping and re-raising it is a fresh edge, and does flam.
  step(c, p, 0, 0, 0, 0, 0.01f);
  CHECK(step(c, p, 0, 0, 1, 0, 0.01f).emission[2] > 0.4f);
}

// --- the end-of-move hold ---------------------------------------------------

TEST_CASE("Hold parks a move on its end pose before the pop", "[three_planes_rig]") {
  Params p;
  p.show_time = 0.5f;
  p.show_azimuth = 180.0f;   // ±90 deg, so the poses are far apart
  p.move_hold = 0.4f;
  Core c;

  c.trigger(AnimShow, p);
  // Travel: 0.5 s at 0.05 s a tick.
  for (int i = 0; i < 10; ++i) idle(c, p, 0.05f);

  // Past the travel time the phase saturates instead of ending — the move is
  // sitting on its end pose, which is the baseline plus half the swing.
  // Reversed polarity: Show ends a quarter turn BELOW the baseline, which wraps.
  const float endAz = wrapped(0.125 - 90.0 / 360.0);
  for (int i = 0; i < 7; ++i) {
    const Out o = idle(c, p, 0.05f);
    CHECK(c.anim == AnimShow);
    CHECK_THAT(o.anim_phase, WithinAbs(1.0, 1e-6));
    CHECK_THAT(o.azimuth, WithinAbs(endAz, 1e-5));
  }

  // Then the pop, on the far side of travel + hold.
  const Out done = idle(c, p, 0.05f);
  CHECK(c.anim == AnimNone);
  CHECK_THAT(done.azimuth, WithinAbs(0.125, 1e-6));
}

TEST_CASE("Hold defaults to nothing — travel then pop, unchanged", "[three_planes_rig]") {
  Params p;
  p.show_time = 0.5f;
  Core c;
  CHECK(p.move_hold == 0.0f);

  c.trigger(AnimShow, p);
  for (int i = 0; i < 9; ++i) idle(c, p, 0.05f);
  CHECK(c.anim == AnimShow);       // still travelling at 0.45 s
  idle(c, p, 0.05f);
  CHECK(c.anim == AnimNone);       // and gone the moment the travel ends
}

TEST_CASE("the hold is captured at trigger time, like the duration",
          "[three_planes_rig]") {
  Params p;
  p.show_time = 0.5f;
  p.move_hold = 0.4f;
  Core c;
  c.trigger(AnimShow, p);

  // Turning the knob to zero mid-move must not cut short what is already
  // running — same rule the travel time follows.
  p.move_hold = 0.0f;
  for (int i = 0; i < 12; ++i) idle(c, p, 0.05f);
  CHECK(c.anim == AnimShow);
}

// --- the sweep's wind-up, and the ease knob ---------------------------------

TEST_CASE("Sweep Start dips the deck before it climbs", "[three_planes_rig]") {
  Core c;
  Params p;
  p.sweep_time = 0.5f;
  p.sweep_target = 0.0f;      // side-on
  p.sweep_start = -20.0f;     // wind up 20 deg BELOW the baseline first

  c.trigger(AnimSweepUp, p);
  // The entry pop the default (0) does not have: it starts below the baseline.
  const Out first = idle(c, p, 1e-4f);
  CHECK_THAT(first.elevation, WithinAbs((35.264389682754654 - 20.0) / 89.0, 2e-4));
  CHECK(first.elevation < kBaseElevation);

  float last = 1.0f;
  while (c.anim != AnimNone) {
    const Out o = idle(c, p, 1e-4f);
    if (c.anim != AnimNone) last = o.elevation;
  }
  // Same destination as before — the wind-up moves the START, not the target.
  CHECK_THAT(last, WithinAbs(0.0, 1e-3));
}

TEST_CASE("Ease 0 is straight-line travel, 1 floats out of both ends",
          "[three_planes_rig]") {
  Params p;
  p.show_time = 1.0f;
  p.show_azimuth = 180.0f;    // a big swing, so the shapes separate clearly

  // Halfway through, every ease lands on the midpoint — the curves differ in
  // how they get there, not where they end up.
  auto atFraction = [&](float ease, float frac) {
    Params q = p;
    q.move_ease = ease;
    Core c;
    c.trigger(AnimShow, q);
    Out o = idle(c, q, 1e-4f);
    const int steps = (int)(frac * 10000.0f);
    for (int i = 0; i < steps; ++i) o = idle(c, q, 1e-4f);
    return o.anim_phase;
  };

  CHECK_THAT(atFraction(0.0f, 0.5f), WithinAbs(0.5, 2e-3));
  CHECK_THAT(atFraction(0.5f, 0.5f), WithinAbs(0.5, 2e-3));
  CHECK_THAT(atFraction(1.0f, 0.5f), WithinAbs(0.5, 2e-3));

  // A quarter of the way in, linear is already a quarter across; the eased
  // curves are still gathering themselves, and more so the harder the ease.
  const float lin  = atFraction(0.0f, 0.25f);
  const float soft = atFraction(0.5f, 0.25f);
  const float hard = atFraction(1.0f, 0.25f);
  CHECK_THAT(lin, WithinAbs(0.25, 5e-3));
  CHECK(soft < lin - 0.05f);
  CHECK(hard < soft - 0.01f);
}

TEST_CASE("the default ease is the smoothstep the moves always had",
          "[three_planes_rig]") {
  Params p;
  CHECK(p.move_ease == 0.5f);
  // smoothstep(0.25) = 0.15625
  CHECK_THAT(detail::easeCurve(0.25f, 0.5f), WithinAbs(0.15625, 1e-6));
  CHECK_THAT(detail::easeCurve(0.25f, 0.0f), WithinAbs(0.25, 1e-6));
  // smootherstep(0.25) = 0.103515625
  CHECK_THAT(detail::easeCurve(0.25f, 1.0f), WithinAbs(0.103515625, 1e-6));
  // Endpoints are endpoints whatever the shape.
  for (float e : {0.0f, 0.5f, 1.0f}) {
    CHECK_THAT(detail::easeCurve(0.0f, e), WithinAbs(0.0, 1e-6));
    CHECK_THAT(detail::easeCurve(1.0f, e), WithinAbs(1.0, 1e-6));
  }
}
