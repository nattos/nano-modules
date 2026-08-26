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

TEST_CASE("Show pops in at −half, eases across, and pops back", "[three_planes_rig]") {
  Core c;
  Params p;
  p.show_time = 1.0f;
  p.show_azimuth = 30.0f;

  c.trigger(AnimShow, p);
  // FIRST tick is already at the start pose — that discontinuity from the
  // baseline is the gesture, not an artefact.
  const Out first = idle(c, p, 1e-4f);
  CHECK_THAT(first.azimuth, WithinAbs(0.125 - 15.0 / 360.0, 2e-4));

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
  CHECK_THAT(last, WithinAbs(0.125 + 15.0 / 360.0, 2e-4));
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

TEST_CASE("Glance drops the deck while it swings", "[three_planes_rig]") {
  Core c;
  Params p;
  p.glance_time = 0.5f;
  p.glance_azimuth = 30.0f;
  p.glance_elevation = 15.0f;

  c.trigger(AnimGlance, p);
  const Out first = idle(c, p, 1e-4f);
  CHECK_THAT(first.azimuth, WithinAbs(0.125 - 15.0 / 360.0, 2e-4));
  CHECK_THAT(first.elevation, WithinAbs((35.264389682754654 + 7.5) / 89.0, 2e-4));

  Out last = first;
  while (c.anim != AnimNone) {
    const Out o = idle(c, p, 1e-4f);
    if (c.anim != AnimNone) last = o;
  }
  CHECK_THAT(last.azimuth, WithinAbs(0.125 + 15.0 / 360.0, 2e-4));
  CHECK_THAT(last.elevation, WithinAbs((35.264389682754654 - 7.5) / 89.0, 2e-4));
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
