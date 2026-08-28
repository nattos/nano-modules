// test_three_walls_show.cpp — goldens for the moves behind
// `source.mesh.three_walls`. Host-free: three_walls_show.h is deliberately free
// of the effect ABI so the tunnel can be driven at an exact dt here, with no
// wasm bundle, no executor and no GPU.
//
// The frame-locked cases in particular can only be pinned here. A web e2e runs
// on a real rAF clock where a frame is 4-20 ms, so it cannot hold a fraction of
// a move steady; this can.

#include "sketch/three_walls_show.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

using Catch::Matchers::WithinAbs;
using namespace three_walls_show;

namespace {

/// One frame at an exact dt.
Out step(Core& c, const Params& p, float dt) { return c.tick(p, dt); }

/// N frames, returning the last.
Out run(Core& c, const Params& p, float dt, int n) {
  Out o;
  for (int i = 0; i < n; ++i) o = c.tick(p, dt);
  return o;
}

constexpr float kFrame = 1.0f / 60.0f;

}  // namespace

// --- depth mapping ----------------------------------------------------------

TEST_CASE("phase maps geometrically from far to near", "[three_walls_show]") {
  Params p;
  p.z_far = 8.0f;
  p.z_near = 0.5f;

  CHECK_THAT(depthOf(0.0f, p), WithinAbs(8.0, 1e-4));
  CHECK_THAT(depthOf(1.0f, p), WithinAbs(0.5, 1e-4));
  // Geometric, not linear: the midpoint is the GEOMETRIC mean, so equal steps
  // of phase are equal RATIOS of depth — which is what makes the apparent size
  // grow at a constant rate.
  CHECK_THAT(depthOf(0.5f, p), WithinAbs(2.0, 1e-3));   // sqrt(8 * 0.5)
  CHECK(depthOf(0.5f, p) < (8.0f + 0.5f) * 0.5f);       // and well below linear

  // Ratios between equal phase steps agree.
  const float r1 = depthOf(0.25f, p) / depthOf(0.50f, p);
  const float r2 = depthOf(0.50f, p) / depthOf(0.75f, p);
  CHECK_THAT(r1, WithinAbs(r2, 1e-3));
}

TEST_CASE("phase is clamped, so a quad cannot fall out the back", "[three_walls_show]") {
  Params p;
  CHECK_THAT(depthOf(-1.0f, p), WithinAbs(depthOf(0.0f, p), 1e-5));
  CHECK_THAT(depthOf(2.0f, p), WithinAbs(depthOf(1.0f, p), 1e-5));
}

// --- rest -------------------------------------------------------------------

TEST_CASE("at rest nothing is live — the card is black", "[three_walls_show]") {
  Core c;
  Params p;
  const Out o = run(c, p, kFrame, 30);
  for (int i = 0; i < kQuads; ++i) CHECK_FALSE(o.live[i]);
  CHECK(o.rate == 0.0f);
}

// --- Pulse ------------------------------------------------------------------

TEST_CASE("Pulse is a train LED BY THE HIGHLIGHT", "[three_walls_show]") {
  Core c;
  Params p;
  p.pulse_time = 0.5f;
  p.pulse_stagger = 0.2f;

  c.trigger(MovePulse);
  // First frame: only the LAST quad has started. That one carries the highlight
  // colour, and it has to arrive first or the pulse lands on the wrong one.
  const Out first = step(c, p, kFrame);
  CHECK(first.live[2]);
  CHECK_FALSE(first.live[1]);
  CHECK_FALSE(first.live[0]);

  // Past the second stagger, quads 3 and 2 are both in flight.
  const Out mid = run(c, p, kFrame, 14);   // t ~= 0.25 s
  CHECK(mid.live[2]);
  CHECK(mid.live[1]);
  CHECK_FALSE(mid.live[0]);
  // ...and the leader is further down the tunnel than the one chasing it.
  CHECK(mid.z[2] < mid.z[1]);
}

TEST_CASE("Pulse retires by itself and leaves the card black", "[three_walls_show]") {
  Core c;
  Params p;
  p.pulse_time = 0.3f;
  p.pulse_stagger = 0.1f;

  c.trigger(MovePulse);
  // Total train = 2*stagger + travel = 0.5 s. Run well past it.
  const Out o = run(c, p, kFrame, 60);
  CHECK(c.move == MoveNone);
  for (int i = 0; i < kQuads; ++i) CHECK_FALSE(o.live[i]);
}

TEST_CASE("a Pulse quad crosses the whole tunnel", "[three_walls_show]") {
  Core c;
  Params p;
  p.pulse_time = 0.5f;
  p.pulse_stagger = 0.0f;   // all three together, so quad 1 is representative

  c.trigger(MovePulse);
  const Out first = step(c, p, 1e-4f);
  CHECK_THAT(first.z[0], WithinAbs(p.z_far, 0.05));

  // Last frame before it retires is essentially at the near end.
  Out last = first;
  for (int i = 0; i < 5000 && c.move != MoveNone; ++i) {
    const Out o = step(c, p, 1e-4f);
    if (c.move != MoveNone) last = o;
  }
  CHECK(last.z[0] < p.z_near * 1.2f);
}

// --- gates ------------------------------------------------------------------

TEST_CASE("a gate runs while held and stops on release", "[three_walls_show]") {
  Core c;
  Params p;

  c.trigger(MoveResonate);
  const Out held = run(c, p, kFrame, 10);
  for (int i = 0; i < kQuads; ++i) CHECK(held.live[i]);

  c.release(MoveResonate);
  const Out after = step(c, p, kFrame);
  CHECK(c.move == MoveNone);
  for (int i = 0; i < kQuads; ++i) CHECK_FALSE(after.live[i]);
}

TEST_CASE("releasing a gate that is no longer running does nothing",
          "[three_walls_show]") {
  Core c;
  Params p;

  c.trigger(MoveCycles);
  run(c, p, kFrame, 5);
  c.trigger(MoveResonate);        // Cycles was dropped here
  run(c, p, kFrame, 5);

  // The stale release must not stop the move that took over.
  c.release(MoveCycles);
  CHECK(c.move == MoveResonate);
  const Out o = step(c, p, kFrame);
  CHECK(o.live[0]);
}

TEST_CASE("the moves are monophonic — a new one drops the old",
          "[three_walls_show]") {
  Core c;
  Params p;

  c.trigger(MoveCycles);
  run(c, p, kFrame, 20);
  CHECK(c.move == MoveCycles);

  c.trigger(MovePulse);
  CHECK(c.move == MovePulse);
  // And the new move starts from its own beginning, not from where Cycles was.
  CHECK(c.move_t == 0.0f);
}

// --- Resonate ---------------------------------------------------------------

TEST_CASE("Resonate spaces the quads evenly down the tunnel", "[three_walls_show]") {
  Core c;
  Params p;
  c.trigger(MoveResonate);
  const Out o = step(c, p, kFrame);
  // Phases a third apart. Depth is geometric in phase, so equal phase gaps are
  // equal depth RATIOS — evenly spaced as the eye reads it.
  const float r1 = o.z[0] / o.z[1];
  const float r2 = o.z[1] / o.z[2];
  CHECK_THAT(r1, WithinAbs(r2, 1e-3));
}

TEST_CASE("the Resonate rate ramps f0 -> f1 over the ramp time",
          "[three_walls_show]") {
  Core c;
  Params p;
  p.resonate_f0 = 2.0f;
  p.resonate_f1 = 10.0f;
  p.resonate_ramp = 1.0f;

  c.trigger(MoveResonate);
  CHECK_THAT(step(c, p, 1e-4f).rate, WithinAbs(2.0, 0.05));
  // Halfway through, the shared ease curve is at its midpoint whatever its
  // strength, so the rate is the midpoint too.
  const Out half = run(c, p, 1e-4f, 5000);
  CHECK_THAT(half.rate, WithinAbs(6.0, 0.2));
  const Out done = run(c, p, 1e-4f, 5001);
  CHECK_THAT(done.rate, WithinAbs(10.0, 0.05));
}

TEST_CASE("Resonate Rev runs the tunnel backwards", "[three_walls_show]") {
  Params p;
  p.resonate_f0 = p.resonate_f1 = 1.0f;   // constant rate, so the sign is all that differs

  Core fwd, rev;
  fwd.trigger(MoveResonate);
  rev.trigger(MoveResonateRev);
  // Quad 2 starts mid-tunnel, so neither direction wraps over this window and
  // the sign of the travel is readable directly.
  const float start = fwd.phase[1];
  const Out a = run(fwd, p, kFrame, 5);
  const Out b = run(rev, p, kFrame, 5);

  // Forward means approaching: phase rises, depth falls. Backwards is the
  // mirror image, and by the same amount.
  CHECK(a.phase[1] > start);
  CHECK(b.phase[1] < start);
  CHECK(a.z[1] < depthOf(start, p));
  CHECK(b.z[1] > depthOf(start, p));
  CHECK_THAT(a.phase[1] - start, WithinAbs(start - b.phase[1], 1e-6));
}

// --- the frame lock ---------------------------------------------------------

TEST_CASE("the frame-locked advance holds steady under jittered dt",
          "[three_walls_show]") {
  // This is the whole point of estimating the frame time rather than
  // integrating dt: the per-frame step has to stay put while the frame time
  // wobbles, because a constant step is what lands the quads on the same depths
  // every frame and makes the aliasing a pattern instead of a smear.
  Params p;
  p.resonate_f0 = p.resonate_f1 = 12.0f;   // no ramp, so any drift is the dt

  Core c;
  c.trigger(MoveResonate);
  for (int i = 0; i < 120; ++i) c.tick(p, kFrame);   // settle the estimate

  // Frame times all over the place — 8 ms to 28 ms, a 3.5x swing, far worse
  // than anything a real compositor produces.
  float lo = 1e9f, hi = -1e9f;
  for (int i = 0; i < 16; ++i) {
    const float dt = (i % 2 == 0) ? 0.008f : 0.028f;
    const float was = c.phase[0];
    c.tick(p, dt);
    float d = c.phase[0] - was;
    if (d < -0.5f) d += 1.0f;   // wrap
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const float spread = (hi - lo) / ((hi + lo) * 0.5f);
  CHECK(spread < 0.05f);

  // The contrast that makes the point: integrating dt straight would have put
  // the steps in the same 3.5x ratio as the frame times.
  const float naive_spread = (0.028f - 0.008f) / (0.018f);
  CHECK(naive_spread > 1.0f);
  CHECK(spread < naive_spread * 0.1f);
}

TEST_CASE("the frame-time estimate is unbiased under jitter", "[three_walls_show]") {
  // Smoothing 1/dt instead of dt would converge on the MEAN OF THE RECIPROCAL —
  // 80 fps for an 8/28 ms alternation whose true rate is 56 — and run the
  // tunnel 40% fast. Settle on jittered frames and check the rate it believes.
  Params p;
  Core c;
  c.trigger(MoveResonate);
  for (int i = 0; i < 1200; ++i) c.tick(p, (i % 2 == 0) ? 0.008f : 0.028f);
  const Out o = c.tick(p, 0.008f);
  CHECK_THAT(o.fps, WithinAbs(1.0 / 0.018, 2.0));   // ~55.6, not ~80
}

TEST_CASE("the fps estimate is seeded on the first frame, not ramped into",
          "[three_walls_show]") {
  Core c;
  Params p;
  c.trigger(MoveResonate);
  const Out first = c.tick(p, kFrame);
  CHECK_THAT(first.fps, WithinAbs(60.0, 0.5));
}

TEST_CASE("the fps estimate ignores stalls and single-steps", "[three_walls_show]") {
  Core c;
  Params p;
  c.trigger(MoveResonate);
  for (int i = 0; i < 60; ++i) c.tick(p, kFrame);

  // A 2-second hitch. dt is clamped to kMaxDt first, and the estimate floors at
  // kMinFps, so one bad frame cannot drag the tunnel to a halt.
  const Out stalled = c.tick(p, 2.0f);
  CHECK(stalled.fps >= kMinFps);
  // The sample is clamped into the believable band before it is averaged, so
  // one catastrophic frame moves the estimate by a few percent, not by half.
  CHECK(stalled.fps > 55.0f);
}

// --- Cycles -----------------------------------------------------------------

TEST_CASE("Cycles counter-rotates two quads so they beat", "[three_walls_show]") {
  Core c;
  Params p;
  p.cycles_f0 = p.cycles_f1 = 1.0f;
  p.cycles_rev_f0 = p.cycles_rev_f1 = 1.0f;

  c.trigger(MoveCycles);
  // The quads start spread down the tunnel, so each is measured against its own
  // start rather than against the far end.
  const float start1 = c.phase[1];
  const float start2 = c.phase[2];
  const Out o = run(c, p, kFrame, 6);

  // Quad 3 (highlight) forward — phase rises, so it is approaching.
  CHECK(o.phase[2] > start2);
  CHECK(o.z[2] < depthOf(start2, p));
  // Quad 2 (secondary) backward — phase falls, so it is receding.
  CHECK(o.phase[1] < start1);
  CHECK(o.z[1] > depthOf(start1, p));
}

TEST_CASE("the Cycles ramps are separate, so the beat drifts",
          "[three_walls_show]") {
  Params p;
  // The defaults must not be two identical curves: identical opposed ramps beat
  // at a fixed rate, which is exactly what we do not want.
  CHECK(p.cycles_f1 != p.cycles_rev_f1);

  Core c;
  c.trigger(MoveCycles);
  run(c, p, kFrame, 120);
  // Two seconds in, the forward and reverse quads have covered different
  // ground — the beat is drifting, not locked.
  const float fwd_travel = c.phase[2];
  const float rev_travel = 1.0f - c.phase[1];
  CHECK(fwd_travel != rev_travel);
}

TEST_CASE("Cycles' third quad reverses on its duty cycle", "[three_walls_show]") {
  Core c;
  Params p;
  p.cycles_f0 = p.cycles_f1 = 1.0f;
  p.cycles_duty = 0.5f;
  p.cycles_duty_period = 1.0f;

  c.trigger(MoveCycles);
  // First half of the period: forward, so depth falls.
  const Out fwd = run(c, p, kFrame, 20);   // t ~= 0.33 s
  const float after_fwd = fwd.phase[0];
  CHECK(after_fwd > 0.0f);
  CHECK(after_fwd < 0.5f);

  // Second half: backward, so it gives ground back.
  run(c, p, kFrame, 20);                   // t ~= 0.66 s, past the duty edge
  const Out rev = run(c, p, kFrame, 10);
  CHECK(rev.phase[0] < after_fwd + 0.34f);   // not still climbing at full rate
}

// --- housekeeping -----------------------------------------------------------

TEST_CASE("a stall is clamped rather than teleporting the tunnel",
          "[three_walls_show]") {
  Params p;
  p.cycles_f0 = p.cycles_f1 = 1.0f;

  Core a, b;
  a.trigger(MoveCycles);
  b.trigger(MoveCycles);
  a.tick(p, kMaxDt);
  b.tick(p, 5.0f);     // a five-second hitch reads as exactly kMaxDt
  CHECK_THAT(a.phase[2], WithinAbs(b.phase[2], 1e-6));
}

TEST_CASE("reset returns the tunnel to rest", "[three_walls_show]") {
  Core c;
  Params p;
  c.trigger(MoveResonate);
  run(c, p, kFrame, 30);
  c.reset();
  CHECK(c.move == MoveNone);
  const Out o = c.tick(p, kFrame);
  for (int i = 0; i < kQuads; ++i) CHECK_FALSE(o.live[i]);
}
