// test_three_planes_rig.cpp — goldens for the show logic behind
// `mod.rig.three_planes`. Host-free: three_planes_rig.h is deliberately free of
// the effect ABI so the meter's ballistics can be driven at an exact dt here,
// with no wasm bundle, no executor and no GPU.
//
// What the effect itself adds on top is the schema, the patch decode and the
// publish. Those are covered by web/test/three-planes-rig.test.ts, which is the
// only place the normalisation contract meets a real wire fold.

#include "sketch/three_planes_rig.h"

#include <cmath>
#include <vector>

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

/// The emission rails carry a FRACTION of three_planes' emission range, and
/// that range runs PAST fully lit — the headroom the sweep's bounce overshoots
/// into. So what a golden means by "this floor sits at 0.8" is `rail(0.8)`.
/// Mirrors the header's own division exactly, so the bit-equality cases below
/// stay bit-equality cases.
float rail(float level) { return level / kEmissionMax; }

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
    CHECK_THAT(o.emission[0], WithinAbs(rail(1.0f), 1e-6));
    CHECK_THAT(o.emission[1], WithinAbs(rail(1.0f), 1e-6));
    CHECK_THAT(o.emission[2], WithinAbs(rail(1.0f), 1e-6));
  }
  // With holes: only the floor that actually fired, plus the cap (which is the
  // same floor here), so the two below go dark under an active meter.
  {
    Core c;
    p.allow_holes = true;
    const Out o = step(c, p, 0, 0, 1, 0, 0.1f);
    CHECK_THAT(o.emission[0], WithinAbs(rail(0.12f), 1e-6));
    CHECK_THAT(o.emission[1], WithinAbs(rail(0.12f), 1e-6));
    CHECK_THAT(o.emission[2], WithinAbs(rail(1.0f), 1e-6));
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
  p.flam_rate = 0.0f;      // the chop is its own case; this one is the envelope
  p.emission_on = 0.4f;    // leave headroom, or the blip just clamps at 1
  p.emission_off = 0.0f;
  Core c;

  // Lit base plus the full blip on the frame it lands.
  const Out hit = step(c, p, 1, 0, 0, 0, 0.02f);
  CHECK_THAT(hit.emission[0], WithinAbs(rail(0.9f), 1e-6));
  // Ease-out: (1 - t/T)^2, so it is already well down a fifth of the way in.
  const Out mid = idle(c, p, 0.02f);
  CHECK(mid.emission[0] < hit.emission[0]);
  CHECK(mid.emission[0] > rail(p.emission_on));
  // Well past flam_time nothing is ringing any more.
  for (int i = 0; i < 10; ++i) idle(c, p, 0.02f);
  CHECK(c.flam_live[0] == false);
}

// --- The flam's chop ------------------------------------------------------
// An accent that only ever adds light is a bump on a lit tower. The flam takes
// the floor AWAY between its strokes, and how fast it does that is counted in
// frames rather than timed, because the fastest chop worth having — one frame
// lit, one frame black — has no name in seconds.

namespace {

/// One flam, read frame by frame: true where floor 0 is showing anything at
/// all, false where the chop has taken it to black. Struck on the first frame.
std::vector<bool> flamFrames(Params& p, int frames, float dt) {
  Core c;
  std::vector<bool> on;
  for (int i = 0; i < frames; ++i) {
    const Out o = step(c, p, i == 0 ? 1.0f : 0.0f, 0, 0, 0, dt);
    on.push_back(o.emission[0] > 0.0f);
  }
  return on;
}

int countBlack(const std::vector<bool>& on) {
  int n = 0;
  for (bool v : on) if (!v) ++n;
  return n;
}

}  // namespace

TEST_CASE("a flam chops to BLACK, not merely to brighter",
          "[three_planes_rig][flam]") {
  // The hole is half the accent. A floor that is lit underneath still goes out
  // — the chop overrides the base, because a lit floor with a hole punched in
  // it is the whole idea.
  Params p;
  p.flam_time = 0.5f;
  p.emission_on = 1.0f;    // fully lit underneath, and it still goes dark
  p.emission_off = 0.0f;
  const std::vector<bool> on = flamFrames(p, 20, 0.016f);

  CHECK(on[0]);                      // struck: a hit you cannot see is not a hit
  CHECK(countBlack(on) > 0);         // ...and it does reach black
}

TEST_CASE("at the top of the range the flam alternates every frame",
          "[three_planes_rig][flam]") {
  // The fastest thing a display can show, and the reason the chop is counted
  // instead of timed: there is no duration that names "one frame".
  Params p;
  p.flam_time = 0.5f;
  p.flam_rate = 1.0f;
  const std::vector<bool> on = flamFrames(p, 12, 0.016f);
  for (size_t i = 0; i < on.size(); ++i) CHECK(on[i] == (i % 2 == 0));
}

TEST_CASE("the chop is counted in FRAMES, not seconds",
          "[three_planes_rig][flam]") {
  // The same knob has to strobe the same way on a 60 Hz display and a 144 Hz
  // one. Timed, it would not: name a duration and it lands on some fraction of
  // a frame, and which frames it catches drifts with the pacing.
  Params fast;
  fast.flam_time = 2.0f;   // long enough that neither run retires
  Params slow = fast;
  const std::vector<bool> a = flamFrames(fast, 16, 0.004f);
  const std::vector<bool> b = flamFrames(slow, 16, 0.040f);   // ten times the dt
  CHECK(a == b);
  CHECK(countBlack(a) > 0);   // and it is a real pattern, not a run of ones
}

TEST_CASE("dialled down, an ordinary flam never reaches its first black",
          "[three_planes_rig][flam]") {
  // 0 is "no chop" without being a special case: the half-period simply grows
  // longer than the blip it would have cut up.
  Params p;
  p.flam_rate = 0.0f;
  const std::vector<bool> on = flamFrames(p, 12, 0.016f);   // default 0.18 s flam
  CHECK(countBlack(on) == 0);
}

TEST_CASE("the chop halves with the knob, like a clock divider",
          "[three_planes_rig][flam]") {
  CHECK(detail::flamHalfFrames(1.0f) == 1);
  CHECK(detail::flamHalfFrames(0.8f) == 2);
  CHECK(detail::flamHalfFrames(0.6f) == 4);
  CHECK(detail::flamHalfFrames(0.4f) == 8);
  CHECK(detail::flamHalfFrames(0.2f) == 16);
  CHECK(detail::flamHalfFrames(0.0f) == 32);
  // Out of range is clamped, not wrapped — a wire can carry anything.
  CHECK(detail::flamHalfFrames(2.0f) == 1);
  CHECK(detail::flamHalfFrames(-1.0f) == 32);
}

TEST_CASE("a paused transport neither strobes nor freezes on the hole",
          "[three_planes_rig][flam]") {
  // A stopped clock still ticks: the executor calls tick() every frame whether
  // or not time moved. Left to itself the chop would keep alternating over a
  // frozen frame — and worse, could stop on a black one and stay there, since
  // the envelope is frozen too and nothing would ever end it. A frozen frame
  // shows the light.
  Params p;
  p.flam_time = 0.5f;
  p.flam_rate = 1.0f;      // would alternate every frame if it advanced
  Core c;
  CHECK(step(c, p, 1, 0, 0, 0, 0.016f).emission[0] > 0.0f);
  for (int i = 0; i < 8; ++i) CHECK(idle(c, p, 0.0f).emission[0] > 0.0f);
  // And the flam is exactly where it was left: no time passed.
  CHECK(c.flam_live[0]);
  CHECK_THAT(c.flam_t[0], WithinAbs(0.016, 1e-6));
}

TEST_CASE("a stalled frame advances the chop by one step, not by its length",
          "[three_planes_rig][flam]") {
  // The counterpart: a frame that took a quarter of a second is still ONE
  // frame. Counting is what makes that true for free — there is no dt in the
  // chop to clamp in the first place.
  Params p;
  p.flam_time = 2.0f;
  p.flam_rate = 1.0f;
  Core c;
  step(c, p, 1, 0, 0, 0, 0.016f);              // frame 0: lit
  CHECK(idle(c, p, 4.0f).emission[0] == 0.0f); // frame 1 (stalled): black
  CHECK(idle(c, p, 0.016f).emission[0] > 0.0f);// frame 2: lit again
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
  p.led_meter = false;   // nothing else reading the meter, so it is truly off
  p.emission_on = 0.8f;
  Core c;

  // Full-scale hits on every channel at once — in the meter mode this would peg
  // the tower and fire three flams. Here it changes nothing at all.
  const Out hit = step(c, p, 1, 1, 1, 1, 0.1f);
  const Out quiet = idle(c, p, 0.1f);

  for (int i = 0; i < kLayers; ++i) {
    CHECK_THAT(hit.emission[i], WithinAbs(rail(0.8f), 1e-6));
    CHECK_THAT(quiet.emission[i], WithinAbs(rail(0.8f), 1e-6));
  }
  // No meter, no cap: the rails report the meter, and there isn't one.
  CHECK(hit.meter == 0.0f);
  CHECK(hit.peak == 0.0f);
  CHECK(hit.peak_layer == -1);
}

TEST_CASE("Solid reads the colours DOWN the tower", "[three_planes_rig]") {
  Params p;
  p.mode = ModeSolid;
  Core c;
  const Out o = step(c, p, 1, 1, 1, 1, 0.1f);

  // top = Highlight, middle = Primary, bottom = Secondary. The highlight goes
  // where the eye goes, and where the peak cap lands in the other mode — the
  // pose you cut TO should not disagree with the one you cut FROM about which
  // floor is the important one.
  CHECK_THAT(o.color[2].g, WithinAbs(p.highlight.g, 1e-6));
  CHECK_THAT(o.color[2].b, WithinAbs(p.highlight.b, 1e-6));
  CHECK_THAT(o.color[1].r, WithinAbs(p.primary.r, 1e-6));
  CHECK_THAT(o.color[1].b, WithinAbs(p.primary.b, 1e-6));
  CHECK_THAT(o.color[0].r, WithinAbs(p.secondary.r, 1e-6));
  CHECK_THAT(o.color[0].g, WithinAbs(p.secondary.g, 1e-6));

  // And a hit does not swing them — there are no flams in this mode.
  const Out again = step(c, p, 0, 0, 0, 0, 0.05f);
  CHECK_THAT(again.color[2].g, WithinAbs(p.highlight.g, 1e-6));
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
  // With LED Meter on, the meter keeps running for the bars and there is
  // nothing to park — that is the case below this one. This is the other pose.
  p.led_meter = false;
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
  CHECK_THAT(back.emission[2], WithinAbs(rail(0.4f), 1e-6));

  // Dropping and re-raising it is a fresh edge, and does flam.
  step(c, p, 0, 0, 0, 0, 0.01f);
  CHECK(step(c, p, 0, 0, 1, 0, 0.01f).emission[2] > rail(0.4f));
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

// ---------------------------------------------------------------------------
// The sweep: one bipolar knob whose POSITION dims the tower and whose SPEED
// throws glints. Everything below drives it at an exact dt, which is the whole
// reason SweepCore lives in the header rather than in the wasm module — the
// motion estimator is a time-domain thing and a golden has to own the clock.
// ---------------------------------------------------------------------------

namespace {

/// One frame with the sweep knob parked at `sweep`. No gates: every case below
/// is about the sweep, and a gate would move the emission underneath it.
Out sweepAt(Core& c, Params& p, float sweep, float dt) {
  p.sweep = sweep;
  return idle(c, p, dt);
}

/// Drive the knob from `from` to `to` at a constant speed, returning the last
/// frame. `step` is the value change per frame — 0 holds it still.
Out drag(Core& c, Params& p, float from, float to, float dt, int frames) {
  Out o{};
  for (int i = 0; i < frames; ++i) {
    const float u = frames > 1 ? (float)i / (float)(frames - 1) : 1.0f;
    o = sweepAt(c, p, from + (to - from) * u, dt);
  }
  return o;
}

/// A hand still ON the knob: `center`, worked back and forth by a hair.
///
/// The flicker's life is armed by MOTION and runs out when the knob is left
/// alone (kFlickWake, `sweep_settle`), so any case about WHERE IN THE FADE the
/// flicker lives has to keep a hand on it — otherwise it is measuring the
/// settle instead. The excursion is a hundredth of the range against a fade
/// that spans half of it, so the dimmer barely moves: these cases and the
/// settle's own cases below stay independent.
///
/// A TRIANGLE over 24 frames, and not a per-frame dither, which is the trap
/// here and worth stating. The rate estimator is a boxcar over `sweep_window`
/// — at 0.09 s and 60 Hz, six frames — and a value that alternates every frame
/// has moved exactly nowhere across an even-length window. It reads as a knob
/// at a dead stop however hard it is being shaken. Anything sampling a window
/// can be aliased against; the fix is to move slower than it, as a hand does.
float riding(float center, int frame) {
  const float phase = (float)(frame % 24) / 24.0f;
  return center + 0.01f * (4.0f * std::fabs(phase - 0.5f) - 1.0f);
}

/// How many of the three floors sit away from the majority this frame. The
/// flicker is defined as touching ONE at a time, so this is the assertion.
int oddFloorsOut(const Out& o) {
  int odd = 0;
  for (int i = 0; i < kLayers; ++i) {
    int same = 0;
    for (int j = 0; j < kLayers; ++j)
      if (std::fabs(o.emission[i] - o.emission[j]) < 1e-4f) ++same;
    if (same == 1) ++odd;   // matches only itself
  }
  return odd;
}

/// How FAR the odd floor sits from the other two — the depth of the stutter,
/// where oddFloorsOut only counts whether there is one. The settle is an
/// exponential and never reaches an exact zero on any schedule worth writing a
/// test around, so "has it stopped" has to be a question about size.
float flickerDepth(const Out& o) {
  static_assert(kLayers == 3, "the majority of three is its middle value");
  float e[kLayers];
  for (int i = 0; i < kLayers; ++i) e[i] = o.emission[i];
  for (int i = 0; i < kLayers; ++i)
    for (int j = i + 1; j < kLayers; ++j)
      if (e[j] < e[i]) { const float t = e[i]; e[i] = e[j]; e[j] = t; }
  const float med = e[1];
  const float lo = std::fabs(e[0] - med), hi = std::fabs(e[2] - med);
  return lo > hi ? lo : hi;
}

}  // namespace

TEST_CASE("the sweep at rest costs nothing", "[three_planes_rig][sweep]") {
  // The centre IS the default, so a card nobody has wired must look exactly
  // like it did before the sweep existed: full emission, no glint, no motion.
  Core c;
  Params p;
  p.mode = ModeSolid;
  Out o{};
  for (int i = 0; i < 60; ++i) o = sweepAt(c, p, kSweepCenter, 0.016f);

  for (int i = 0; i < kLayers; ++i)
    REQUIRE_THAT(o.emission[i], WithinAbs(rail(1.0f), 1e-5));
  REQUIRE(o.sweep_speed == 0.0f);
  REQUIRE_THAT(o.sweep_out, WithinAbs(kSweepCenter, 1e-6));
}

TEST_CASE("a knob that starts off-centre does not fire a ghost glint",
          "[three_planes_rig][sweep]") {
  // The initial state replay delivers a sketch's stored `sweep` as a real patch
  // BEFORE the first tick. Differencing that against the default centre would
  // read as an instantaneous full-throw drag — the trap mod.shaper.motion seeds
  // its window against, for the same reason.
  Core c;
  Params p;
  p.mode = ModeSolid;
  const Out first = sweepAt(c, p, 0.9f, 0.016f);
  REQUIRE(first.sweep_speed == 0.0f);
}

TEST_CASE("most of the middle is a deadzone at full brightness",
          "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;   // isolate the position law

  // Anywhere inside the deadzone reads exactly as the centre does. That is the
  // point of it: you can ride the knob around home without touching the look.
  const float inside = kSweepCenter + 0.5f * p.sweep_deadzone * 0.9f;
  for (int i = 0; i < 5; ++i) sweepAt(c, p, inside, 0.016f);
  const Out o = sweepAt(c, p, inside, 0.016f);
  for (int i = 0; i < kLayers; ++i) REQUIRE_THAT(o.emission[i], WithinAbs(rail(1.0f), 1e-5));
}

TEST_CASE("either extreme fades the tower to black", "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;

  for (int i = 0; i < 5; ++i) sweepAt(c, p, 1.0f, 0.016f);
  const Out top = sweepAt(c, p, 1.0f, 0.016f);
  for (int i = 0; i < kLayers; ++i) REQUIRE_THAT(top.emission[i], WithinAbs(0.0, 1e-5));

  // Signed in concept, unsigned in magnitude: the two ends are the same
  // gesture in opposite directions, so they must land on the same picture.
  Core c2;
  Params p2 = p;
  for (int i = 0; i < 5; ++i) sweepAt(c2, p2, 0.0f, 0.016f);
  const Out bottom = sweepAt(c2, p2, 0.0f, 0.016f);
  for (int i = 0; i < kLayers; ++i)
    REQUIRE_THAT(bottom.emission[i], WithinAbs(top.emission[i], 1e-6));
}

TEST_CASE("Fade Depth floors how dark the ends go", "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  p.sweep_depth = 0.4f;
  for (int i = 0; i < 5; ++i) sweepAt(c, p, 1.0f, 0.016f);
  const Out o = sweepAt(c, p, 1.0f, 0.016f);
  for (int i = 0; i < kLayers; ++i) REQUIRE_THAT(o.emission[i], WithinAbs(rail(0.6f), 1e-5));
}

TEST_CASE("Deadzone 0 starts the fade the moment you leave centre",
          "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  p.sweep_deadzone = 0.0f;
  for (int i = 0; i < 5; ++i) sweepAt(c, p, 0.75f, 0.016f);
  const Out o = sweepAt(c, p, 0.75f, 0.016f);
  // Half a throw out, smoothstepped: 1 - (0.5^2 * (3 - 1)) = 0.5.
  REQUIRE_THAT(o.emission[0], WithinAbs(rail(0.5f), 1e-5));
}

TEST_CASE("the sweep dims the meter's own picture rather than replacing it",
          "[three_planes_rig][sweep]") {
  // The position law is a DIMMER over whatever the mode painted, so the
  // relative shape of the tower survives it. Half-brightness must halve every
  // floor, lit and unlit alike, not flatten them together.
  Core c;
  Params p;
  p.sweep_flicker = 0.0f;
  p.sweep_deadzone = 0.0f;
  p.allow_holes = false;

  Core ref;
  Params refp = p;
  Out lit{}, dimmed{};
  for (int i = 0; i < 4; ++i) {
    lit = step(ref, refp, 1, 0, 0, 0, 0.016f);                    // sweep at home
    p.sweep = 0.75f;
    const float sig[kSignals] = {1, 0, 0, 0};
    dimmed = c.tick(p, sig, 0.016f);
  }
  for (int i = 0; i < kLayers; ++i)
    REQUIRE_THAT(dimmed.emission[i], WithinAbs(lit.emission[i] * 0.5f, 1e-5));
}

TEST_CASE("speed is measured over the window, so a stepping encoder reads true",
          "[three_planes_rig][sweep]") {
  // The reason this is a boxcar and not a per-frame difference. A MIDI encoder
  // does not send a smooth ramp; it sends a step every few frames. Differenced
  // per frame those steps read as full-scale spikes.
  Params p;
  p.mode = ModeSolid;
  p.sweep_window = 0.2f;
  p.sweep_sense = 2.0f;   // 2 full throws / second pegs the meter

  // Same gesture both ways: 1.0 throws per second, so half of full scale.
  Core smooth;
  Params sp = p;
  float peak_smooth = 0.0f;
  for (int i = 0; i < 60; ++i) {
    const Out o = sweepAt(smooth, sp, 0.016f * (float)i * 1.0f, 0.016f);
    if (i > 20) peak_smooth = o.sweep_speed;
  }
  REQUIRE_THAT(peak_smooth, WithinAbs(0.5, 0.05));

  Core stepped;
  Params tp = p;
  float last_stepped = 0.0f, peak_stepped = 0.0f;
  for (int i = 0; i < 60; ++i) {
    // 0.05 every fifth frame at dt 0.01 — the same 1.0 / second, delivered in
    // lumps five times the size.
    const float v = 0.05f * (float)(i / 5);
    const Out o = sweepAt(stepped, tp, v, 0.01f);
    if (i > 25) {
      last_stepped = o.sweep_speed;
      if (o.sweep_speed > peak_stepped) peak_stepped = o.sweep_speed;
    }
  }
  REQUIRE_THAT(last_stepped, WithinAbs(0.5, 0.15));
  REQUIRE(peak_stepped < 0.8f);   // never mistakes a step for a flick

  // ...and with the window closed it does exactly what it must not: pegs.
  Core raw;
  Params rp = p;
  rp.sweep_window = 0.0f;
  float peak_raw = 0.0f;
  for (int i = 0; i < 60; ++i) {
    const Out o = sweepAt(raw, rp, 0.05f * (float)(i / 5), 0.01f);
    if (o.sweep_speed > peak_raw) peak_raw = o.sweep_speed;
  }
  REQUIRE(peak_raw > 0.99f);
}

TEST_CASE("the glint coasts to a stop and then reads exact zero",
          "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  const Out moving = drag(c, p, 0.5f, 0.9f, 0.016f, 30);
  REQUIRE(moving.sweep_speed > 0.2f);

  // Immediately after: still coasting, because Glint Decay is what keeps a
  // flick alive past the gesture rather than cutting it dead.
  const Out justAfter = sweepAt(c, p, 0.9f, 0.016f);
  REQUIRE(justAfter.sweep_speed > 0.0f);
  REQUIRE(justAfter.sweep_speed < moving.sweep_speed);

  Out rested{};
  for (int i = 0; i < 160; ++i) rested = sweepAt(c, p, 0.9f, 0.016f);
  REQUIRE(rested.sweep_speed == 0.0f);   // an exact zero, not an epsilon tail
}

TEST_CASE("the knob goes out verbatim for the glints",
          "[three_planes_rig][sweep]") {
  // source.mesh.three_planes throws glints from the GESTURE, not from a level,
  // so what it needs is the knob and its motion — which means this rail must
  // be the knob, untouched by the envelope that shapes Sweep Speed.
  Core c;
  Params p;
  p.mode = ModeSolid;
  for (const float v : {0.0f, 0.17f, 0.5f, 0.83f, 1.0f}) {
    const Out o = sweepAt(c, p, v, 0.016f);
    REQUIRE_THAT(o.sweep_out, WithinAbs(v, 1e-6));
  }
}

TEST_CASE("the flicker lives in the fade and touches one floor at a time",
          "[three_planes_rig][sweep]") {
  // Halfway out: smoothstep(0.5) = 0.5, so gain 0.5 and the drive is at its
  // peak. 0.45 deadzone + half of the remaining throw.
  const float half_out = kSweepCenter +
                         0.5f * (0.45f + 0.5f * (1.0f - 0.45f));
  Core c;
  Params p;
  p.mode = ModeSolid;

  int flicker_frames = 0, worst = 0;
  for (int i = 0; i < 400; ++i) {
    const Out o = sweepAt(c, p, riding(half_out, i), 0.016f);
    const int odd = oddFloorsOut(o);
    if (odd > 0) ++flicker_frames;
    if (odd > worst) worst = odd;
  }
  REQUIRE(flicker_frames > 10);   // it actually stutters
  REQUIRE(worst == 1);            // never two floors at once
}

TEST_CASE("the flicker is silent at full brightness and once it is black",
          "[three_planes_rig][sweep]") {
  // Both ends of the fade have nothing to show: a tower at full brightness is
  // not struggling, and a black one cannot be seen to.
  Core home;
  Params p;
  p.mode = ModeSolid;
  for (int i = 0; i < 400; ++i) {
    const Out o = sweepAt(home, p, kSweepCenter, 0.016f);
    REQUIRE(oddFloorsOut(o) == 0);
    REQUIRE_THAT(o.emission[0], WithinAbs(rail(1.0f), 1e-5));
  }

  Core dark;
  Params dp = p;
  for (int i = 0; i < 400; ++i) {
    const Out o = sweepAt(dark, dp, 1.0f, 0.016f);
    REQUIRE_THAT(o.emission[0], WithinAbs(0.0, 1e-6));
    REQUIRE_THAT(o.emission[1], WithinAbs(0.0, 1e-6));
    REQUIRE_THAT(o.emission[2], WithinAbs(0.0, 1e-6));
  }
}

TEST_CASE("a flickering floor TOGGLES — a dark one comes up",
          "[three_planes_rig][sweep]") {
  // "One will either go out or turn on." In the meter mode with nothing
  // playing every floor sits at the unlit level, so the only stutter available
  // is upward — and a design that could only dim would show nothing at all.
  const float half_out = kSweepCenter + 0.5f * (0.45f + 0.5f * (1.0f - 0.45f));
  Core c;
  Params p;   // EV Meter, no gates: all three floors rest at emission_off
  int lifted = 0;
  for (int i = 0; i < 400; ++i) {
    const Out o = sweepAt(c, p, riding(half_out, i), 0.016f);
    for (int k = 0; k < kLayers; ++k) {
      // Brighter than the unlit level it would otherwise be dimmed to.
      if (o.emission[k] > rail(p.emission_off * 0.5f) + 1e-3f) ++lifted;
    }
  }
  REQUIRE(lifted > 10);
}

// ---------------------------------------------------------------------------
// THE SETTLE. Where in the fade the knob sits says how hard the tubes CAN
// stutter; whether they still are is a separate fact, carried by a life the
// knob's motion arms and stillness runs out. Positional flicker alone made
// parking mid-fade a permanent fault rather than a place you can leave the
// piece.
// ---------------------------------------------------------------------------

namespace {
/// Halfway out: smoothstep(0.5) = 0.5, so the drive is at its peak. Same
/// position the flicker cases above use.
const float kHalfOut = kSweepCenter + 0.5f * (0.45f + 0.5f * (1.0f - 0.45f));

/// The worst stutter seen over `frames` with the knob left exactly where the
/// caller put it. Returns the depth, so an exponential tail can be measured
/// rather than merely detected.
float worstOver(Core& c, Params& p, float sweep, int frames) {
  float worst = 0.0f;
  for (int i = 0; i < frames; ++i) {
    const float d = flickerDepth(sweepAt(c, p, sweep, 0.016f));
    if (d > worst) worst = d;
  }
  return worst;
}
}  // namespace

TEST_CASE("the stutter runs out when the knob is abandoned",
          "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;

  // Sweep out to the middle of the fade over half a second, then let go.
  drag(c, p, kSweepCenter, kHalfOut, 0.016f, 32);

  // It is still arguing on the way down — the first settle's worth of frames
  // has real blips in it, which is the flicker the sweep is there for.
  const float during = worstOver(c, p, kHalfOut, (int)(p.sweep_settle / 0.016f));
  REQUIRE(during > 0.05f);

  // Four more settles pass...
  worstOver(c, p, kHalfOut, (int)(4.0f * p.sweep_settle / 0.016f));

  // ...and there is nothing left to see. Not an exact zero — an exponential
  // does not offer one — but a fifth of a percent of the range, which is below
  // anything a projector resolves.
  const float after = worstOver(c, p, kHalfOut, (int)(2.0f / 0.016f));
  REQUIRE(after < 0.01f);
  REQUIRE(after < during * 0.1f);
}

TEST_CASE("riding the knob keeps the tubes struggling indefinitely",
          "[three_planes_rig][sweep]") {
  // The settle must not have made the flicker a one-shot: a hand still on the
  // knob is a tower still in trouble, however long it goes on for. Same
  // position and the same number of frames as the case above, which sees
  // nothing by the end.
  Core c;
  Params p;
  p.mode = ModeSolid;
  drag(c, p, kSweepCenter, kHalfOut, 0.016f, 32);

  float late = 0.0f;
  const int frames = (int)(6.0f / 0.016f);
  for (int i = 0; i < frames; ++i) {
    const float d = flickerDepth(sweepAt(c, p, riding(kHalfOut, i), 0.016f));
    if (i > frames / 2 && d > late) late = d;   // the SECOND half only
  }
  REQUIRE(late > 0.05f);
}

TEST_CASE("a knob that was already parked in the fade never starts",
          "[three_planes_rig][sweep]") {
  // A card that comes up with the sweep stored mid-fade shows a tower that
  // settled long ago, not one still fighting. The life starts at zero and only
  // motion arms it, so a sketch that never touches the knob is silent — which
  // is also what keeps a stored value from reading as a gesture on frame one,
  // the same rule knob_rate.h's seeding exists for.
  Core c;
  Params p;
  p.mode = ModeSolid;
  REQUIRE(worstOver(c, p, kHalfOut, 400) < 1e-5f);
}

TEST_CASE("Settle at 0 stutters only while the hand is moving",
          "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_settle = 0.0f;

  // Moving: unchanged. The gate is on motion, not on speed, so an unhurried
  // crawl through the fade stutters exactly as hard as a slam — which is the
  // whole reason the life is not simply `speed`.
  float moving = 0.0f;
  for (int i = 0; i < 400; ++i) {
    const float d = flickerDepth(sweepAt(c, p, riding(kHalfOut, i), 0.016f));
    if (d > moving) moving = d;
  }
  REQUIRE(moving > 0.05f);

  // Stopped: gone within a boxcar window. Not instantly — the rate estimator
  // reports the displacement over the last `sweep_window`, so the knob is
  // still measurably moving for that long after the hand comes off, and that
  // is a fact about the measurement rather than about the settle.
  const int window_frames = (int)(p.sweep_window / 0.016f) + 2;
  worstOver(c, p, kHalfOut, window_frames);
  REQUIRE(worstOver(c, p, kHalfOut, 200) < 1e-5f);
}

// ---------------------------------------------------------------------------
// THE THROW. Reaching either end of the sweep mutes the tower, and that mute
// is the point of the gesture — but a mute that is only "dark" has nothing in
// it, because the brightness just tracks the knob and reversing undoes it
// exactly. So the middle CHARGES, arriving at a mute spends the charge, and
// what was thrown rings out on its own clock afterwards.
// ---------------------------------------------------------------------------

/// A constant-speed sweep between two knob positions. `ranges_per_second` is
/// exactly what the charge reads off the gesture.
///
/// Sweeps rather than jumps ON PURPOSE. A knob that teleports from one
/// extreme to the other really has crossed the middle, at an enormous speed,
/// so it charges fully and fires in the same frame — correct, and useless for
/// measuring anything.
Out sweepAcross(Core& c, Params& p, float from, float to, float ranges_per_second) {
  const float dt = 0.008f;
  const float step = ranges_per_second * dt;
  Out o{};
  if (from > to) for (float v = from; v > to; v -= step) o = sweepAt(c, p, v, dt);
  else           for (float v = from; v < to; v += step) o = sweepAt(c, p, v, dt);
  return o;
}

/// The whole gesture: from one extreme, through the middle, to the mute at the
/// other end. Returns what it threw.
float flick(Core& c, Params& p, float ranges_per_second) {
  return sweepAcross(c, p, 0.95f, 0.02f, ranges_per_second).release;
}

TEST_CASE("dawdling in the middle charges nothing",
          "[three_planes_rig][sweep]") {
  // Filling by the second had the gesture backwards: a short sharp flick
  // through the middle is the most emphatic thing you can do with the knob,
  // and it spent almost no time in the band. So loitering earns nothing.
  Core c;
  Params p;
  p.mode = ModeSolid;
  Out o{};
  for (int i = 0; i < 200; ++i) o = sweepAt(c, p, kSweepCenter, 0.016f);
  REQUIRE(c.sweep.charge == 0.0f);
  REQUIRE(o.release == 0.0f);

  // ...and creeping out to a mute on an empty charge throws nothing at all.
  o = sweepAcross(c, p, kSweepCenter, 0.02f, 0.02f);
  REQUIRE(o.release == 0.0f);
}

TEST_CASE("a vigorous pass charges the throw", "[three_planes_rig][sweep]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  sweepAcross(c, p, 0.95f, 0.15f, 2.5f);   // through the middle, firmly
  REQUIRE(c.sweep.charge > 0.9f);

  // Even the hardest gesture pays a little bleed on the run from the band out
  // to the mute, so a full throw lands a shade under 1 rather than on it.
  const Out o = sweepAcross(c, p, 0.15f, 0.02f, 2.5f);   // on to the mute
  REQUIRE(o.release > 0.85f);
  REQUIRE(c.sweep.charge == 0.0f);   // spent, all at once
  // ...and the tower is muted under it — that being what fired the throw in
  // the first place. What you see is the release, not a brightening of
  // anything that was already there.
  for (int i = 0; i < kLayers; ++i) REQUIRE(o.emission[i] < rail(kMuteGain));
}

TEST_CASE("flick harder, throw harder", "[three_planes_rig][sweep]") {
  const auto thrown = [](float ranges_per_second) {
    Core c;
    Params p;
    p.mode = ModeSolid;
    p.latch_drive = 1.0f;   // no help from the drive: read the pass as it was
    return flick(c, p, ranges_per_second);
  };
  const float gentle = thrown(0.35f);
  const float firm = thrown(2.5f);
  REQUIRE(gentle > 0.0f);
  REQUIRE(firm > gentle * 2.0f);
  REQUIRE(firm > 0.85f);
}

TEST_CASE("the charge bleeds away, so dawdling throws soft",
          "[three_planes_rig][sweep]") {
  // Held indefinitely, a hard flick followed by a slow wander out still threw
  // everything — which makes it impossible to be quiet on purpose. The throw
  // is as big as the whole GESTURE was, not just its best instant.
  const auto thrown = [](float out_speed) {
    Core c;
    Params p;
    p.mode = ModeSolid;
    sweepAcross(c, p, 0.95f, 0.30f, 3.0f);   // the same hard pass, both times
    return sweepAcross(c, p, 0.30f, 0.02f, out_speed).release;
  };
  const float straight = thrown(3.0f);
  const float dawdled = thrown(0.18f);
  REQUIRE(straight > 0.85f);          // flick and go: a wallop
  REQUIRE(dawdled < straight * 0.4f); // flick and amble: a whisper
  REQUIRE(dawdled > 0.0f);            // ...but still the same gesture
}

TEST_CASE("Latch Drive decides how squashed the reading is",
          "[three_planes_rig][sweep]") {
  const auto thrown = [](float drive) {
    Core c;
    Params p;
    p.mode = ModeSolid;
    p.latch_drive = drive;
    return flick(c, p, 0.9f);   // an ordinary, unhurried sweep
  };
  const float polite = thrown(1.0f);
  const float driven = thrown(3.0f);
  REQUIRE(polite < 0.5f);    // the raw reading is a meter's, and too tame
  REQUIRE(driven > 0.7f);    // ...and above 1 an ordinary sweep all but pegs it
}

TEST_CASE("the tail is causal: nothing the knob does cancels it",
          "[three_planes_rig][sweep]") {
  // THE WHOLE POINT. If the afterglow tracked the knob it would be a dimmer
  // with extra steps; because it rings on its own clock you can sweep straight
  // back and relight the tower OVER a tail that is still running. That overlap
  // is the move.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  // Ring Out long enough that the tail is still plainly alive once the
  // relight's own bounce has finished swinging: the claim here is that the two
  // clocks are independent, and a tower still ringing its way down onto the
  // base would confuse one for the other.
  p.ring_time = 3.0f;
  const float thrown = flick(c, p, 2.5f);
  REQUIRE(thrown > 0.85f);

  Out o{};
  for (int i = 0; i < 40; ++i) o = sweepAt(c, p, kSweepCenter, 0.016f);
  REQUIRE(o.release > 0.5f);           // still ringing...
  REQUIRE(o.release < thrown);         // ...and falling
  for (int i = 0; i < kLayers; ++i)    // ...over a fully relit tower
    REQUIRE_THAT(o.emission[i], WithinAbs(rail(1.0f), 1e-5));
}

TEST_CASE("Ring Out is how long the tail lasts", "[three_planes_rig][sweep]") {
  const auto ringing_after = [](float ring, float seconds) {
    Core c;
    Params p;
    p.mode = ModeSolid;
    p.ring_time = ring;
    flick(c, p, 2.5f);
    Out o{};
    for (float t = 0.0f; t < seconds; t += 0.016f) o = sweepAt(c, p, 0.02f, 0.016f);
    return o.release;
  };
  REQUIRE(ringing_after(0.3f, 0.5f) == 0.0f);    // short: over and done
  REQUIRE(ringing_after(3.0f, 0.5f) > 0.5f);     // long: barely started
}

TEST_CASE("one pass is one throw", "[three_planes_rig][sweep]") {
  // Sitting at the end must not keep firing, and neither must jogging about
  // out there. The charge has to be earned by another pass through the middle
  // first — which is what makes the gesture a round trip rather than a switch.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.ring_time = 0.25f;
  REQUIRE(flick(c, p, 2.5f) > 0.85f);

  // Ring it out while jogging about at the muted end, well clear of centre.
  Out o{};
  for (int i = 0; i < 60; ++i) o = sweepAt(c, p, i % 2 ? 0.02f : 0.11f, 0.016f);
  REQUIRE(o.release == 0.0f);
  for (int i = 0; i < 60; ++i) o = sweepAt(c, p, i % 2 ? 0.02f : 0.11f, 0.016f);
  REQUIRE(o.release == 0.0f);

  // Cross the middle again and it fires again — because that pass is a new
  // gesture, not because the knob happens to be somewhere.
  REQUIRE(sweepAcross(c, p, 0.02f, 0.98f, 2.5f).release > 0.85f);
}

TEST_CASE("a transport stall neither spikes the glint nor blanks the tower",
          "[three_planes_rig][sweep]") {
  // dt is clamped at kMaxDt upstream, but the sweep also has to survive the
  // frame where a knob moved a long way across that clamped step.
  Core c;
  Params p;
  p.mode = ModeSolid;
  for (int i = 0; i < 10; ++i) sweepAt(c, p, kSweepCenter, 0.016f);
  const Out stalled = sweepAt(c, p, 0.62f, 4.0f);   // clamps to kMaxDt
  REQUIRE(stalled.sweep_speed >= 0.0f);
  REQUIRE(stalled.sweep_speed <= 1.0f);
  REQUIRE_THAT(stalled.sweep_out, WithinAbs(0.62, 1e-5));
  for (int i = 0; i < kLayers; ++i) REQUIRE(stalled.emission[i] >= 0.0f);

  // A zero-dt frame (a paused transport re-publishing) must not divide by it.
  const Out paused = sweepAt(c, p, 0.62f, 0.0f);
  REQUIRE(paused.sweep_speed >= 0.0f);
  REQUIRE(paused.sweep_speed <= 1.0f);
}

// --- The orbit ------------------------------------------------------------
// An angular velocity, and therefore the only MEMORY in the camera path. Every
// other camera control is a pose you can name; this one is wherever it got to,
// which is why it has a button.

namespace {

/// Turns travelled from the baseline, signed and unwrapped-ish: the rail is a
/// [0,1) turn, so a value just under 1 is read as a small negative angle.
double turnedFrom(const Out& o, const Params& p) {
  double d = (double)o.azimuth - (double)p.azimuth_base;
  if (d > 0.5) d -= 1.0;
  if (d < -0.5) d += 1.0;
  return d;
}

}  // namespace

TEST_CASE("an orbit rate of nothing never moves the camera",
          "[three_planes_rig][orbit]") {
  Core c;
  Params p;
  Out o{};
  for (int i = 0; i < 600; ++i) o = idle(c, p, 0.016f);
  REQUIRE_THAT(o.azimuth, WithinAbs(p.azimuth_base, 1e-6));
}

TEST_CASE("the orbit turns at the rate it is given, and remembers",
          "[three_planes_rig][orbit]") {
  Core c;
  Params p;
  p.orbit_rate = 36.0f;   // a tenth of a turn per second
  Out o{};
  for (int i = 0; i < 100; ++i) o = idle(c, p, 0.01f);   // one second
  REQUIRE_THAT(turnedFrom(o, p), WithinAbs(0.1, 1e-4));
  // Memory: another second is another tenth, not the same tenth again.
  for (int i = 0; i < 100; ++i) o = idle(c, p, 0.01f);
  REQUIRE_THAT(turnedFrom(o, p), WithinAbs(0.2, 1e-4));
}

TEST_CASE("the orbit is signed, and wraps rather than piling up",
          "[three_planes_rig][orbit]") {
  Core back;
  Params p;
  p.orbit_rate = -36.0f;
  Out o{};
  for (int i = 0; i < 100; ++i) o = idle(back, p, 0.01f);
  REQUIRE_THAT(turnedFrom(o, p), WithinAbs(-0.1, 1e-4));

  // Past a full turn it comes round again — the rail is an angle, not a
  // distance, and a camera that saturated at 360 deg would simply stop.
  Core far;
  p.orbit_rate = 90.0f;
  for (int i = 0; i < 500; ++i) o = idle(far, p, 0.01f);   // 450 deg
  REQUIRE(o.azimuth >= 0.0f);
  REQUIRE(o.azimuth < 1.0f);
  REQUIRE_THAT(turnedFrom(o, p), WithinAbs(0.25, 1e-4));
}

TEST_CASE("Reset Orbit pops the camera back onto the baseline",
          "[three_planes_rig][orbit]") {
  Core c;
  Params p;
  p.orbit_rate = 90.0f;
  for (int i = 0; i < 100; ++i) idle(c, p, 0.01f);
  REQUIRE(std::fabs(turnedFrom(idle(c, p, 0.01f), p)) > 0.2);

  // One frame, no travel: a cue you have to wait for is not a cue.
  c.resetOrbit();
  const Out back = idle(c, p, 0.0f);
  REQUIRE_THAT(turnedFrom(back, p), WithinAbs(0.0, 1e-6));
  // ...and it carries on turning from there, rather than being switched off.
  for (int i = 0; i < 10; ++i) idle(c, p, 0.01f);
  REQUIRE(turnedFrom(idle(c, p, 0.01f), p) > 0.0);
}

TEST_CASE("a move swings around wherever the orbit has got to",
          "[three_planes_rig][orbit]") {
  // The two compose: the move is measured from the BASE pose, the orbit rides
  // on top of the result. So a cue fired mid-orbit still reads as the same
  // swing, just not from the same place.
  Params p;
  p.show_azimuth = 30.0f;
  p.orbit_rate = 0.0f;
  Core still;
  still.trigger(AnimShow, p);
  // Captured on a zero-length frame so the reading is the accumulated turn and
  // not the accumulated turn plus however long the capture itself took.
  const Out a = idle(still, p, 0.0f);

  Params q = p;
  q.orbit_rate = 90.0f;
  Core turning;
  for (int i = 0; i < 40; ++i) idle(turning, q, 0.01f);   // 36 deg round
  turning.trigger(AnimShow, q);
  const Out b = idle(turning, q, 0.0f);

  // Same move, 0.1 of a turn further round.
  REQUIRE_THAT(turnedFrom(b, q) - turnedFrom(a, p), WithinAbs(0.1, 2e-3));
}

TEST_CASE("the orbit runs in Solid too", "[three_planes_rig][orbit]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.orbit_rate = 36.0f;
  Out o{};
  for (int i = 0; i < 100; ++i) o = idle(c, p, 0.01f);
  REQUIRE_THAT(turnedFrom(o, p), WithinAbs(0.1, 1e-4));
}

// --- The beat, and the walk it lights --------------------------------------
// A floor fills on the beat and HOLDS until the next one, so the light climbs
// the tower: bottom, middle, top, rest. Which floor is read off the transport
// rather than counted here, and a crossing the guard does not believe is not a
// step.

namespace {

/// A hand-driven transport. The bar phase advances at the tempo, so a beat
/// line arrives every 60/bpm seconds exactly — and can also be moved by hand,
/// which is how a sync that is not confident is played back.
struct Grid {
  double phase = 0.0;
  void advance(Params& p, float dt) {
    phase += (double)dt * ((double)p.bpm / 60.0) / (double)kBeatsPerBar;
    phase -= std::floor(phase);
    p.bar_phase = (float)phase;
  }
};

/// Which floor is holding this frame, or -1 for none. The rail rests at the
/// middle of three_planes' signed range, so "filled" is anything off it.
int litFloor(const Out& o) {
  for (int i = 0; i < kLayers; ++i)
    if (std::fabs(o.fill[i] - 0.5f) > 1e-4f) return i;
  return -1;
}

/// Park the transport just before a beat line and step over it. The parking
/// frame has to land in the beat BEFORE the line — anything further back is
/// itself a crossing, and the guard would then eat the step under test.
Out beatAt(Core& c, Params& p, double line) {
  p.bar_phase = (float)(line - 0.02);
  idle(c, p, 0.016f);
  p.bar_phase = (float)(line + 0.02);
  return idle(c, p, 0.016f);
}

}  // namespace

TEST_CASE("an unfilled plane publishes the middle of the range, not the bottom",
          "[three_planes_rig][beat]") {
  // three_planes' Fill is SIGNED — the bottom of it is a full black mask — so
  // a rail that rested at 0 would flood every plane with darkness the moment
  // it was wired up.
  Core c;
  Params p;
  p.beat_fill = 0.0f;
  Out o{};
  for (int i = 0; i < 30; ++i) o = idle(c, p, 0.016f);
  for (int i = 0; i < kLayers; ++i) REQUIRE_THAT(o.fill[i], WithinAbs(0.5, 1e-6));
}

TEST_CASE("arming the card is not a beat", "[three_planes_rig][beat]") {
  // The first frame SEEDS the grid and takes nothing. Otherwise every card
  // would light a floor the instant it was created, wherever the transport
  // happened to be standing.
  Core c;
  Params p;
  p.bar_phase = 0.4f;   // mid-beat, and not on a line
  REQUIRE(litFloor(idle(c, p, 0.016f)) == -1);
  p.bar_phase = 0.45f;
  REQUIRE(litFloor(idle(c, p, 0.016f)) == -1);
}

TEST_CASE("the fill walks up the tower, a floor a beat, and rests",
          "[three_planes_rig][beat]") {
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_rest = true;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.9f;
  idle(c, p, 0.016f);   // seed near the end of a bar

  Grid g;
  g.phase = 0.9;
  // Two full bars at 120 bpm is four seconds.
  std::vector<int> seen;
  int was = -2;
  for (int i = 0; i < 260; ++i) {
    g.advance(p, 0.016f);
    const int now = litFloor(idle(c, p, 0.016f));
    if (now != was) { seen.push_back(now); was = now; }
  }
  // Bottom, middle, top, rest — twice, and starting on the downbeat wherever
  // the card happened to be armed.
  REQUIRE(seen.size() >= 9);
  const std::vector<int> want = {-1, 0, 1, 2, -1, 0, 1, 2, -1};
  for (size_t i = 0; i < want.size(); ++i) CHECK(seen[i] == want[i]);
}

TEST_CASE("a lit floor HOLDS until the beat that takes it off",
          "[three_planes_rig][beat]") {
  // Not a pulse: nothing decays, nothing eases. The step that ends one floor
  // is the step that lights the next.
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_fill = 1.0f;
  idle(c, p, 0.016f);

  const Out hit = beatAt(c, p, 0.25);   // beat 2 of the bar: the middle floor
  REQUIRE(litFloor(hit) == 1);
  Grid g;
  g.phase = 0.27;
  for (int i = 0; i < 28; ++i) {        // most of a beat later...
    g.advance(p, 0.016f);
    const Out o = idle(c, p, 0.016f);
    REQUIRE(litFloor(o) == 1);
    REQUIRE_THAT(o.fill[1], WithinAbs(hit.fill[1], 1e-6));   // and just as hard
  }
}

TEST_CASE("which floor lights comes off the global clock, not from counting",
          "[three_planes_rig][beat]") {
  // Start mid-bar and the walk is already where the bar says it should be —
  // no phase of its own to drift out of step. Beat 3 lights the TOP floor
  // whether or not this card saw beats 1 and 2.
  Core c;
  Params p;
  p.beat_fill = 1.0f;
  // Armed mid-bar, having seen no beat at all, and the very first one it takes
  // is beat 3 — so it lights the TOP floor, not the bottom one a counter
  // starting from nothing would have reached for.
  REQUIRE(litFloor(beatAt(c, p, 0.5)) == 2);
}

TEST_CASE("a beat inside half a beat of the last one is not a step",
          "[three_planes_rig][beat]") {
  // The guard. A sync that is re-locking walks the phase across several lines
  // in a handful of frames; only the first of them moves the tower.
  Core c;
  Params p;
  p.bpm = 120.0f;      // half a beat is 0.25 s
  p.beat_fill = 1.0f;
  p.bar_phase = 0.2f;
  idle(c, p, 0.016f);   // seed

  p.bar_phase = 0.3f;                          // crosses into beat 2
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 1);
  // ~0.03 s later, two more lines. Real time says neither can be a beat, so
  // the middle floor stays exactly where it is.
  p.bar_phase = 0.55f;
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 1);
  p.bar_phase = 0.8f;
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 1);
}

TEST_CASE("...and one that waited is", "[three_planes_rig][beat]") {
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.2f;
  idle(c, p, 0.016f);

  p.bar_phase = 0.3f;
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 1);
  for (int i = 0; i < 20; ++i) idle(c, p, 0.016f);   // 0.32 s — past the guard
  p.bar_phase = 0.55f;
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 2);
}

TEST_CASE("a dropped beat does not put the walk out of step",
          "[three_planes_rig][beat]") {
  // The reason the step is read rather than counted. Throw a beat away to the
  // guard and a counter would be one floor behind for ever after; reading the
  // bar, the next beat lands where the bar says and the walk is back on it.
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_rest = true;   // the pose with a beat that is nobody's floor
  p.beat_fill = 1.0f;
  p.bar_phase = 0.02f;
  idle(c, p, 0.016f);

  REQUIRE(litFloor(beatAt(c, p, 0.25)) == 1);   // beat 2: middle
  p.bar_phase = 0.55f;                          // beat 3 arrives far too soon
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 1);   // ...and is thrown away
  for (int i = 0; i < 20; ++i) idle(c, p, 0.016f);
  p.bar_phase = 0.8f;                           // beat 4: the REST, not beat 3
  REQUIRE(litFloor(idle(c, p, 0.016f)) == -1);
}

TEST_CASE("a burst cannot lock the beat out for ever",
          "[three_planes_rig][beat]") {
  // Which is why the guard is measured from the last ACCEPTED beat and not
  // from the last crossing seen. Timed from the rejects, a sync stuck in a
  // burst would push the window ahead of itself and never step again.
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.0f;
  idle(c, p, 0.016f);

  double ph = 0.0;
  for (int i = 0; i < 20; ++i) {   // a line crossed every other frame
    ph += 0.13;
    ph -= std::floor(ph);
    p.bar_phase = (float)ph;
    idle(c, p, 0.016f);
  }
  // The guard has long since expired against the FIRST of them, so the walk is
  // moving again by now rather than being permanently deaf.
  Grid g;
  g.phase = ph;
  int changes = 0, was = litFloor(idle(c, p, 0.0f));
  for (int i = 0; i < 260; ++i) {
    g.advance(p, 0.016f);
    const int now = litFloor(idle(c, p, 0.016f));
    if (now != was) { ++changes; was = now; }
  }
  REQUIRE(changes >= 6);
}

TEST_CASE("a scrub backwards takes nothing", "[three_planes_rig][beat]") {
  Core c;
  Params p;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.6f;
  idle(c, p, 0.016f);
  p.bar_phase = 0.4f;   // back over a line, not forward across one
  REQUIRE(litFloor(idle(c, p, 0.016f)) == -1);
}

TEST_CASE("the downbeat is a beat like any other", "[three_planes_rig][beat]") {
  // The phase wraps at the bar, so the crossing has to be reconstructed from
  // the bar count rather than read off the phase — otherwise the downbeat, the
  // one beat the whole walk is anchored to, would be the one that never fired.
  Core c;
  Params p;
  p.beat_rest = true;   // the walk that is anchored to the bar at all
  p.beat_fill = 1.0f;
  p.bar_phase = 0.98f;
  idle(c, p, 0.016f);
  p.bar_phase = 0.02f;
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 0);   // and it lights the bottom
}

TEST_CASE("Beat Fill is signed: turned down it masks instead of fills",
          "[three_planes_rig][beat]") {
  Core c;
  Params p;
  p.beat_fill = -1.0f;
  p.bar_phase = 0.1f;
  idle(c, p, 0.016f);
  const Out o = beatAt(c, p, 0.25);
  REQUIRE(o.fill[1] < 0.5f - 1e-4f);   // below the middle: a black mask
  REQUIRE_THAT(o.fill[0], WithinAbs(0.5, 1e-6));
}

TEST_CASE("Beat Fill at zero is the whole off switch",
          "[three_planes_rig][beat]") {
  Core c;
  Params p;
  p.beat_fill = 0.0f;
  p.bar_phase = 0.1f;
  idle(c, p, 0.016f);
  const Out o = beatAt(c, p, 0.25);
  for (int i = 0; i < kLayers; ++i) REQUIRE_THAT(o.fill[i], WithinAbs(0.5, 1e-6));
}

TEST_CASE("the beat runs in Solid too", "[three_planes_rig][beat]") {
  // It is driven by the transport, not by the feed — so it is not the mode's
  // business. Solid means nothing reacting, not nothing on the grid.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.1f;
  idle(c, p, 0.016f);
  REQUIRE(litFloor(beatAt(c, p, 0.25)) == 1);
}

// --- The bounce -----------------------------------------------------------
// Sweeping back IN from an end, the light does not simply track the knob: it
// runs ahead of it and springs back, by an amount set by how fast you came.
// Everything below is stated against the POSITION LAW rather than against
// absolute numbers, because "the light is ahead of your hand" is the claim —
// how bright the hand itself asks for is the dimmer's business, and pinned
// separately above.

namespace {

/// What the knob's position alone asks for, this frame. The bounce is measured
/// as the gap between the light and this.
float positionOf(const Params& p, float sweep) {
  return SweepCore::positionGain(p, sweep);
}

struct Bounce {
  float peak = 0.0f;    ///< furthest the light ran AHEAD of the knob
  float sag = 0.0f;     ///< furthest it fell BEHIND afterwards (negative)
  float settled = 0.0f; ///< the gap once everything has stopped
  bool exact = false;   ///< ...and whether that gap is exactly nothing
  int peak_frame = -1;
};

/// Sweep from `from` to `to` over `frames`, then hold for `tail` more, and
/// report how the light sat against the position law throughout.
Bounce sweepIn(Core& c, Params& p, float from, float to, int frames, int tail) {
  Bounce b;
  for (int i = 0; i < frames + tail; ++i) {
    const float u = i < frames ? (float)i / (float)(frames - 1) : 1.0f;
    const float knob = from + (to - from) * u;
    const Out o = sweepAt(c, p, knob, 0.016f);
    // Back into lit units, where 1 is a fully lit floor: every threshold
    // below is a statement about the light, not about the rail's scaling.
    const float gap = o.emission[0] * kEmissionMax - positionOf(p, knob);
    if (gap > b.peak) {
      b.peak = gap;
      b.peak_frame = i;
    }
    if (b.peak_frame >= 0 && i > b.peak_frame && gap < b.sag) b.sag = gap;
    b.settled = gap;
    b.exact = o.emission[0] == rail(positionOf(p, knob));
  }
  return b;
}

/// Park the knob out at one end, with the sweep's own history settled, so a
/// return reads as a return rather than as a jump.
void parkOut(Core& c, Params& p, float end) {
  for (int i = 0; i < 40; ++i) sweepAt(c, p, end, 0.016f);
}

}  // namespace

TEST_CASE("Bounce dialled out is the dimmer exactly as it was",
          "[three_planes_rig][sweep][bounce]") {
  // The whole thing has to be free when it is off — not nearly free. The
  // spring lands on an exact zero for this: a card that never touches the knob
  // must be bit-identical to the positional dimmer without it.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  p.sweep_bounce = 0.0f;
  parkOut(c, p, 1.0f);

  for (int i = 0; i < 40; ++i) {
    const float knob = 1.0f - 0.5f * (float)i / 39.0f;
    const Out o = sweepAt(c, p, knob, 0.016f);
    REQUIRE(o.emission[0] == rail(positionOf(p, knob)));
  }
}

TEST_CASE("coming back in, the light runs ahead of the knob and springs back",
          "[three_planes_rig][sweep][bounce]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  parkOut(c, p, 1.0f);

  const Bounce b = sweepIn(c, p, 1.0f, kSweepCenter, 8, 60);

  // Ahead of the hand on the way in — the tower relights before the knob says
  // it should, which is the overshoot.
  REQUIRE(b.peak > 0.08f);
  // ...and behind it afterwards. This is the half you can actually see when
  // the sweep ends at home: the light has already saturated, so the overshoot
  // is clipped away and the DIP is the bounce.
  REQUIRE(b.sag < -0.03f);
  // And then it is over, exactly. A spring that crept would leave the tower a
  // hair off its own dimmer for ever.
  REQUIRE(b.exact);
}

TEST_CASE("the overshoot goes past the BASE level, not just past the knob",
          "[three_planes_rig][sweep][bounce]") {
  // The reason three_planes' emission range runs past fully lit at all. A
  // sweep that comes all the way home ends where the position law is already
  // at full, so an overshoot clipped there is spent against a ceiling: what
  // survives is the light arriving a frame early and then dipping, which reads
  // as a return that got there sooner rather than as one that HIT. Given
  // somewhere to go, the landing punches through the base and falls back to it.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  parkOut(c, p, 1.0f);

  float peak = 0.0f;
  Out o{};
  for (int i = 0; i < 68; ++i) {
    const float u = i < 8 ? (float)i / 7.0f : 1.0f;
    o = sweepAt(c, p, 1.0f + (kSweepCenter - 1.0f) * u, 0.016f);
    if (o.emission[0] > peak) peak = o.emission[0];
  }
  // At the SHIPPING default, not only at the top of the knob: a bounce nobody
  // has dialled up still has to be a thing you can see.
  REQUIRE(peak > rail(p.emission_on) * 1.12f);
  // Overdrive, not overflow — the rail still tops out at its own full scale.
  REQUIRE(peak <= 1.0f);
  // And it lands back ON the base, exactly.
  REQUIRE(o.emission[0] == rail(p.emission_on));
}

TEST_CASE("a knob that clears the whole band in one frame still bounces",
          "[three_planes_rig][sweep][bounce]") {
  // The gesture this card is FOR: a hard flick home, which on a stepping
  // encoder can be a single sample. Reading the fade's slope where the knob
  // LANDED would find the deadzone — flat, nothing there to run ahead of — and
  // lose the best gesture available outright. The drive is the secant across
  // the rate window instead, so what counts is the climb the knob actually
  // made, not where it came to rest.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  parkOut(c, p, 1.0f);

  float peak = 0.0f;
  Out o{};
  for (int i = 0; i < 80; ++i) {
    o = sweepAt(c, p, kSweepCenter, 0.016f);   // one frame, end to home
    if (o.emission[0] > peak) peak = o.emission[0];
  }
  REQUIRE(peak > rail(p.emission_on) * 1.15f);
  REQUIRE(o.emission[0] == rail(p.emission_on));
}

TEST_CASE("how far it overshoots is how fast you came",
          "[three_planes_rig][sweep][bounce]") {
  // The point of the whole mechanism: there is no velocity term downstream —
  // the lead is a lookahead in TIME, so speed is the only thing that decides
  // how much of one you get.
  Core fast_c;
  Params fast_p;
  fast_p.mode = ModeSolid;
  fast_p.sweep_flicker = 0.0f;
  parkOut(fast_c, fast_p, 1.0f);
  const Bounce fast = sweepIn(fast_c, fast_p, 1.0f, kSweepCenter, 10, 60);

  Core slow_c;
  Params slow_p = fast_p;
  parkOut(slow_c, slow_p, 1.0f);
  const Bounce slow = sweepIn(slow_c, slow_p, 1.0f, kSweepCenter, 75, 60);

  REQUIRE(slow.peak < fast.peak * 0.4f);
  REQUIRE(slow.sag > -0.01f);   // an unhurried return does not bounce at all
}

TEST_CASE("Bounce scales it, and nothing else does",
          "[three_planes_rig][sweep][bounce]") {
  Core soft_c;
  Params soft_p;
  soft_p.mode = ModeSolid;
  soft_p.sweep_flicker = 0.0f;
  soft_p.sweep_bounce = 0.25f;
  parkOut(soft_c, soft_p, 1.0f);
  const Bounce soft = sweepIn(soft_c, soft_p, 1.0f, kSweepCenter, 10, 60);

  Core hard_c;
  Params hard_p = soft_p;
  hard_p.sweep_bounce = 1.0f;
  parkOut(hard_c, hard_p, 1.0f);
  const Bounce hard = sweepIn(hard_c, hard_p, 1.0f, kSweepCenter, 10, 60);

  REQUIRE(hard.peak > soft.peak * 2.0f);
  REQUIRE(hard.sag < soft.sag);
}

TEST_CASE("nothing swells on the way OUT", "[three_planes_rig][sweep][bounce]") {
  // Going out is a blackout. A blackout that brightens before it falls is not
  // a gesture, it is a light with a fault in it — so the bounce is inward-only
  // and the fade is exactly the position law, however hard you throw the knob.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  for (int i = 0; i < 20; ++i) sweepAt(c, p, kSweepCenter, 0.016f);

  for (int i = 0; i < 10; ++i) {
    const float knob = kSweepCenter + 0.5f * (float)i / 9.0f;
    const Out o = sweepAt(c, p, knob, 0.016f);
    REQUIRE(o.emission[0] == rail(positionOf(p, knob)));
  }
}

TEST_CASE("riding the knob around home still costs nothing",
          "[three_planes_rig][sweep][bounce]") {
  // The deadzone's whole promise is that you can work around centre without
  // touching the look. The drive rides the fade's own slope, which is flat
  // across the deadzone — so however briskly you cross it, there is nothing
  // there for the light to run ahead of.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  const float inside = 0.5f * p.sweep_deadzone * 0.9f;

  Out o{};
  for (int i = 0; i < 90; ++i)
    o = sweepAt(c, p, kSweepCenter + (i % 2 ? inside : -inside), 0.016f);
  for (int i = 0; i < kLayers; ++i) REQUIRE_THAT(o.emission[i], WithinAbs(rail(1.0f), 1e-6));
}

TEST_CASE("the bounce does not move the mute, or the throw that hangs off it",
          "[three_planes_rig][sweep][bounce]") {
  // Where the mute is is a fact about the KNOB. It must not move because you
  // arrived at it quickly — so everything downstream of the position law (the
  // flicker's drive, the charge, the release) reads the positional gain and
  // not the bounced one. Same gesture, bounce in and out: identical throw.
  Core plain_c;
  Params plain_p;
  plain_p.mode = ModeSolid;
  plain_p.sweep_bounce = 0.0f;

  Core bouncy_c;
  Params bouncy_p = plain_p;
  bouncy_p.sweep_bounce = 1.0f;

  // A flick from one end clean through the middle to the other: an inward leg
  // that bounces, then an outward one that arrives at the mute and throws.
  for (int i = 0; i < 30; ++i) {
    const float knob = 0.02f + 0.96f * (float)i / 29.0f;
    const Out a = sweepAt(plain_c, plain_p, knob, 0.016f);
    const Out b = sweepAt(bouncy_c, bouncy_p, knob, 0.016f);
    REQUIRE(b.release == a.release);
    REQUIRE(b.sweep_speed == a.sweep_speed);
  }
  Out last{};
  for (int i = 0; i < 20; ++i) {
    last = sweepAt(plain_c, plain_p, 0.98f, 0.016f);
    REQUIRE(sweepAt(bouncy_c, bouncy_p, 0.98f, 0.016f).release == last.release);
  }
  REQUIRE(last.release > 0.5f);   // the gesture really did throw
}

TEST_CASE("a dropped frame damps the bounce rather than detonating it",
          "[three_planes_rig][sweep][bounce]") {
  // Explicit integration of a stiff spring across the stall clamp's quarter
  // second is exactly how one of these blows up. It is sub-stepped for that,
  // and this is the golden that says so.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  p.sweep_bounce = 1.0f;
  parkOut(c, p, 1.0f);

  // Get it swinging, then hand it a stalled frame mid-swing.
  for (int i = 0; i < 5; ++i) sweepAt(c, p, 1.0f - 0.06f * (float)(i + 1), 0.016f);
  const Out stalled = sweepAt(c, p, 0.6f, 4.0f);   // clamps to kMaxDt
  REQUIRE(stalled.emission[0] == stalled.emission[0]);   // not NaN
  REQUIRE(stalled.emission[0] >= 0.0f);
  REQUIRE(stalled.emission[0] <= 1.0f);

  Out o{};
  for (int i = 0; i < 60; ++i) o = sweepAt(c, p, 0.6f, 0.016f);
  REQUIRE_THAT(o.emission[0], WithinAbs(rail(positionOf(p, 0.6f)), 1e-6));
}

// ---------------------------------------------------------------------------
// The rest-free walk.
//
// Three floors do not divide a four-beat bar, so a walk with no rest in it
// cannot also be bar-locked: it cycles every three beats and lands somewhere
// new each downbeat. What it keeps is where it comes from — the absolute beat,
// not a count kept here — which is what a dropped beat tests.

TEST_CASE("with the rest off the walk never stops climbing",
          "[three_planes_rig][beat]") {
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_fill = 1.0f;   // beat_rest defaults OFF
  p.bar_phase = 0.9f;
  idle(c, p, 0.016f);

  Grid g;
  g.phase = 0.9;
  std::vector<int> seen;
  int was = -2;
  for (int i = 0; i < 260; ++i) {
    g.advance(p, 0.016f);
    const int now = litFloor(idle(c, p, 0.016f));
    if (now != was) { seen.push_back(now); was = now; }
  }

  // Dark until the first beat arrives, and lit from then on — there is no beat
  // left over to go dark on.
  REQUIRE(seen.size() >= 8);
  CHECK(seen[0] == -1);
  for (size_t i = 1; i < seen.size(); ++i) {
    CHECK(seen[i] != -1);
    if (i >= 2) CHECK(seen[i] == (seen[i - 1] + 1) % kLayers);
  }
}

TEST_CASE("the rest-free walk starts each bar one floor higher",
          "[three_planes_rig][beat]") {
  // Three against four, stated as the thing you actually see: the downbeat is
  // on the bottom floor, then the middle, then the top, then round. It is the
  // one property the rest was there to prevent, and the reason it is optional.
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.9f;
  idle(c, p, 0.016f);

  Grid g;
  g.phase = 0.9;
  std::vector<int> downbeat;
  double prev = g.phase;
  int wait = -1;
  for (int i = 0; i < 600; ++i) {
    g.advance(p, 0.016f);
    const int now = litFloor(idle(c, p, 0.016f));
    if (g.phase < prev) wait = 6;              // just wrapped into a new bar
    else if (wait > 0) --wait;
    else if (wait == 0) { downbeat.push_back(now); wait = -1; }
    prev = g.phase;
  }

  REQUIRE(downbeat.size() >= 4);
  for (size_t i = 1; i < downbeat.size(); ++i)
    CHECK(downbeat[i] == (downbeat[i - 1] + 1) % kLayers);
}

TEST_CASE("a dropped beat does not put the rest-free walk out of step",
          "[three_planes_rig][beat]") {
  // Same reason as the four-beat walk's, and it survives the shorter cycle
  // because the floor is still folded out of the ABSOLUTE beat rather than
  // counted from the last one taken.
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.02f;
  idle(c, p, 0.016f);                            // seeded on beat 1 of bar 1

  REQUIRE(litFloor(beatAt(c, p, 0.25)) == 1);    // beat 2 -> middle
  p.bar_phase = 0.55f;                           // beat 3 arrives far too soon
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 1);    // ...and is thrown away
  for (int i = 0; i < 20; ++i) idle(c, p, 0.016f);
  p.bar_phase = 0.8f;                            // beat 4, and beat 3 is lost
  REQUIRE(litFloor(idle(c, p, 0.016f)) == 0);    // 3 % 3 — the bottom, on time
}

TEST_CASE("Rest brings the dark beat back", "[three_planes_rig][beat]") {
  // The same transport, read both ways, so the switch is the only difference.
  Core c;
  Params p;
  p.bpm = 120.0f;
  p.beat_rest = true;
  p.beat_fill = 1.0f;
  p.bar_phase = 0.02f;
  idle(c, p, 0.016f);

  // The guard is half a WALL-CLOCK beat, so the transport has to be left alone
  // for long enough between the lines or the second one is thrown away.
  const auto settle = [](Core& core, Params& pp) {
    for (int i = 0; i < 20; ++i) idle(core, pp, 0.016f);
  };

  CHECK(litFloor(beatAt(c, p, 0.25)) == 1);
  settle(c, p);
  CHECK(litFloor(beatAt(c, p, 0.5)) == 2);
  settle(c, p);
  CHECK(litFloor(beatAt(c, p, 0.75)) == -1);   // the rest

  Core c2;
  Params q = p;
  q.beat_rest = false;
  q.bar_phase = 0.02f;
  idle(c2, q, 0.016f);
  CHECK(litFloor(beatAt(c2, q, 0.25)) == 1);
  settle(c2, q);
  CHECK(litFloor(beatAt(c2, q, 0.5)) == 2);
  settle(c2, q);
  CHECK(litFloor(beatAt(c2, q, 0.75)) == 0);   // ...is the bottom floor again
}

// ---------------------------------------------------------------------------
// Strobe: Solid with the mains chopped.

TEST_CASE("Strobe alternates the whole tower between lit and black",
          "[three_planes_rig][strobe]") {
  Core c;
  Params p;
  p.mode = ModeStrobe;
  p.led_meter = false;
  p.emission_on = 0.8f;

  for (int k = 0; k < 6; ++k) {
    const Out o = idle(c, p, 0.016f);
    for (int i = 0; i < kLayers; ++i) {
      if (k % 2 == 0) CHECK_THAT(o.emission[i], WithinAbs(rail(0.8f), 1e-6));
      else            CHECK(o.emission[i] == 0.0f);
    }
  }
}

TEST_CASE("Strobe reads the colours the way Solid does",
          "[three_planes_rig][strobe]") {
  // It is Solid chopped, not a mode of its own — so the tower it is chopping
  // has to be the same tower, down the same way: Secondary, Primary, Highlight.
  Core c;
  Params p;
  p.mode = ModeStrobe;
  p.led_meter = false;
  const Out o = idle(c, p, 0.016f);
  CHECK_THAT(o.color[0].r, WithinAbs(p.secondary.r, 1e-6));
  CHECK_THAT(o.color[1].r, WithinAbs(p.primary.r, 1e-6));
  CHECK_THAT(o.color[2].r, WithinAbs(p.highlight.r, 1e-6));
}

TEST_CASE("Strobe ignores the feed as completely as Solid does",
          "[three_planes_rig][strobe]") {
  Core c;
  Params p;
  p.mode = ModeStrobe;
  p.led_meter = false;
  p.emission_on = 0.8f;

  const Out lit = step(c, p, 1, 1, 1, 1, 0.016f);   // frame 0: lit
  idle(c, p, 0.016f);                               // frame 1: black
  const Out quiet = idle(c, p, 0.016f);             // frame 2: lit again
  for (int i = 0; i < kLayers; ++i)
    CHECK_THAT(lit.emission[i], WithinAbs(quiet.emission[i], 1e-6));
}

TEST_CASE("a frozen frame shows the light, not the hole",
          "[three_planes_rig][strobe]") {
  // Same rule the flam's chop has, for the same reason: a stopped clock must
  // not strobe, and it must not leave the tower parked on the black half.
  Core c;
  Params p;
  p.mode = ModeStrobe;
  p.led_meter = false;
  p.emission_on = 0.8f;

  idle(c, p, 0.016f);                        // frame 0, lit
  const Out frozen = idle(c, p, 0.0f);       // ...and time stops
  for (int i = 0; i < kLayers; ++i)
    CHECK_THAT(frozen.emission[i], WithinAbs(rail(0.8f), 1e-6));
  // The count did not advance either, so the chop resumes where it stopped.
  CHECK(idle(c, p, 0.016f).emission[0] == 0.0f);
}

TEST_CASE("the sweep dims the chop but cannot slow it",
          "[three_planes_rig][strobe][sweep]") {
  Core c;
  Params p;
  p.mode = ModeStrobe;
  p.led_meter = false;
  p.sweep_flicker = 0.0f;   // no stutter to confuse the reading
  // Parked halfway down the fade, and left there long enough to settle.
  p.sweep = kSweepCenter + 0.5f * (p.sweep_deadzone +
                                   0.5f * (1.0f - p.sweep_deadzone));
  for (int i = 0; i < 200; ++i) idle(c, p, 0.05f);

  const Out a = idle(c, p, 0.016f);
  const Out b = idle(c, p, 0.016f);
  const float hi = a.emission[0] > b.emission[0] ? a.emission[0] : b.emission[0];
  const float lo = a.emission[0] < b.emission[0] ? a.emission[0] : b.emission[0];
  CHECK(lo == 0.0f);                  // still all the way to black
  CHECK(hi > 0.05f);                  // ...from somewhere dimmer than full
  CHECK(hi < rail(1.0f) - 1e-3f);
}

// ---------------------------------------------------------------------------
// The LED rails: what the bars show, which outside EV Meter is not the picture.

TEST_CASE("in EV Meter the bars and the picture are the same tower",
          "[three_planes_rig][led]") {
  Core c;
  Params p;
  const Out o = step(c, p, 0, 1, 0, 0, 0.1f);
  for (int i = 0; i < kLayers; ++i) {
    CHECK(o.led_emission[i] == o.emission[i]);
    CHECK(o.led_color[i].r == o.color[i].r);
    CHECK(o.led_color[i].g == o.color[i].g);
    CHECK(o.led_color[i].b == o.color[i].b);
  }
}

TEST_CASE("the bars keep reading the meter while the screen sits Solid",
          "[three_planes_rig][led]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.emission_on = 0.8f;

  // A hit on the top floor. The picture does not move; the bars do.
  Out o = step(c, p, 0, 0, 1, 0, 0.1f);
  for (int i = 0; i < kLayers; ++i)
    CHECK_THAT(o.emission[i], WithinAbs(rail(0.8f), 1e-6));
  CHECK(o.peak_layer == 2);
  CHECK(o.led_emission[2] > rail(p.emission_off));

  // Let the feed go quiet. The screen is exactly where it was; the bars have
  // fallen back to the unlit level, and their top floor has given up the cap's
  // colour with it.
  for (int i = 0; i < 60; ++i) o = idle(c, p, 0.1f);
  for (int i = 0; i < kLayers; ++i) {
    CHECK_THAT(o.emission[i], WithinAbs(rail(0.8f), 1e-6));
    CHECK_THAT(o.led_emission[i], WithinAbs(rail(p.emission_off), 1e-6));
  }
  CHECK_THAT(o.color[2].r, WithinAbs(p.highlight.r, 1e-6));
  CHECK_THAT(o.led_color[2].r, WithinAbs(p.secondary.r, 1e-6));
}

TEST_CASE("the meter rails report the meter wherever it is running",
          "[three_planes_rig][led]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  const Out o = step(c, p, 0, 0, 1, 0, 0.1f);
  CHECK_THAT(o.meter, WithinAbs(1.0, 1e-6));
  CHECK_THAT(o.peak, WithinAbs(1.0, 1e-6));
}

TEST_CASE("LED Meter off puts the bars back on the picture",
          "[three_planes_rig][led]") {
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.led_meter = false;
  const Out o = step(c, p, 1, 1, 1, 1, 0.1f);
  for (int i = 0; i < kLayers; ++i) {
    CHECK(o.led_emission[i] == o.emission[i]);
    CHECK(o.led_color[i].r == o.color[i].r);
  }
  CHECK(o.meter == 0.0f);
}

TEST_CASE("the chop is the screen's, not the room's",
          "[three_planes_rig][led][strobe]") {
  // Strobe is a thing done to the picture. The bars are a different fixture,
  // and while they are on the meter they hold steady through it.
  Core c;
  Params p;
  p.mode = ModeStrobe;
  const Out a = idle(c, p, 0.016f);
  const Out b = idle(c, p, 0.016f);
  CHECK(a.emission[0] != b.emission[0]);
  CHECK_THAT(a.led_emission[0], WithinAbs(b.led_emission[0], 1e-9));
}

TEST_CASE("the sweep takes the bars out with the tower",
          "[three_planes_rig][led][sweep]") {
  // The other half of that: the chop is the screen's, but the dimmer is the
  // room's. Reaching for an end is a blackout, and a blackout is everything.
  Core c;
  Params p;
  p.mode = ModeSolid;
  p.sweep_flicker = 0.0f;
  p.sweep = 1.0f;
  Out o{};
  for (int i = 0; i < 80; ++i) o = idle(c, p, 0.05f);
  for (int i = 0; i < kLayers; ++i) {
    CHECK(o.emission[i] < 1e-4f);
    CHECK(o.led_emission[i] < 1e-4f);
  }
}
