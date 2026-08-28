// test_three_planes_glints.cpp — goldens for the glints
// `source.mesh.three_planes` flashes across its quads. Host-free:
// three_planes_glints.h carries no effect ABI, so a gesture can be driven at an
// exact dt here with no wasm bundle, no executor and no GPU.
//
// The brief these pin, in the order the header states it:
//
//   * move the knob at a constant speed across its whole range, and ONE glint
//     crosses the planes at exactly that rate;
//   * the launch is guaranteed, and guaranteed to happen while moving;
//   * sign is thrown away — reverse the knob and the glints carry on;
//   * a live glint keeps everything except its speed, which is shared so two
//     can never cross;
//   * small extra glints arrive only once the sweep is brisk.
//
// What the effect adds on top is the projection onto the travel axis and the
// two exponentials that draw one. Those are covered by web/test/three_planes.

#include "sketch/three_planes_glints.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <vector>

using Catch::Matchers::WithinAbs;
using namespace three_planes_glints;

namespace {

constexpr float kDt = 1.0f / 120.0f;   // fine enough that a gesture is smooth

/// Hold the knob still for `seconds`.
void hold(Core& c, Params& p, float at, float seconds) {
  p.sweep = at;
  for (float t = 0.0f; t < seconds; t += kDt) c.tick(p, kDt);
}

/// Sweep the knob from `from` to `to` at a constant speed, over `seconds`.
/// Returns where the knob was on the frame a glint was launched (or `to` if
/// none was) — which is what the crossing-rate invariant has to measure from.
float sweep(Core& c, Params& p, float from, float to, float seconds) {
  const int n = (int)(seconds / kDt);
  const unsigned before = c.launches;
  float at_launch = to;
  bool seen = false;
  for (int i = 0; i < n; ++i) {
    p.sweep = from + (to - from) * ((float)(i + 1) / (float)n);
    c.tick(p, kDt);
    if (!seen && c.launches > before) { at_launch = p.sweep; seen = true; }
  }
  return at_launch;
}

int launchedCount(const Core& c) {
  int n = 0;
  for (int i = 0; i < kMaxLive; ++i) if (c.glints[i].live && c.glints[i].launched) ++n;
  return n;
}

/// The one launched glint, or nullptr.
const Glint* launched(const Core& c) {
  for (int i = 0; i < kMaxLive; ++i)
    if (c.glints[i].live && c.glints[i].launched) return &c.glints[i];
  return nullptr;
}

std::vector<float> positions(const Core& c) {
  std::vector<float> v;
  for (int i = 0; i < kMaxLive; ++i) if (c.glints[i].live) v.push_back(c.glints[i].pos);
  return v;
}

/// A knob that starts outside the band, so the first entry is a real one.
Params settled(Core& c, float park = 0.95f) {
  Params p;
  p.chaos = 0.0f;   // most cases are about the launched glint alone
  hold(c, p, park, 0.5f);
  return p;
}

}  // namespace

TEST_CASE("one traverse throws exactly one glint", "[three_planes_glints]") {
  Core c;
  Params p = settled(c);
  sweep(c, p, 0.95f, 0.05f, 0.6f);
  REQUIRE(c.launches == 1);
  REQUIRE(launchedCount(c) == 1);

  // ...and coming back throws exactly one more. ENTERING the band is the
  // event, so a there-and-back is two gestures and two glints. (Counted
  // cumulatively: the first one may well have crossed and died by now.)
  sweep(c, p, 0.05f, 0.95f, 0.6f);
  REQUIRE(c.launches == 2);
}

TEST_CASE("a constant sweep crosses the planes at exactly that rate",
          "[three_planes_glints]") {
  // THE INVARIANT, as an equality rather than a trend: `pos` is measured in
  // crossings precisely so that the distance a glint has covered IS the
  // distance the knob has covered since it was launched, times Ratio.
  for (const float T : {0.4f, 0.8f, 1.6f}) {
    Core c;
    Params p = settled(c);
    const float at = sweep(c, p, 0.95f, 0.35f, T);
    const Glint* g = launched(c);
    REQUIRE(g != nullptr);

    // Born `lead` outside the picture, and it does not move on the frame it
    // was born — hence the one-tick allowance in the tolerance.
    const float knob = at - 0.35f;
    REQUIRE_THAT(g->pos + p.lead, WithinAbs(knob, 0.02));
  }
}

TEST_CASE("Ratio is the exchange rate between knob and picture",
          "[three_planes_glints]") {
  // Same gesture, twice the ratio, twice the ground covered. Stopped short of
  // the end of the throw so the faster glint is still alive to be measured.
  Core slow, fast;
  Params ps = settled(slow), pf = settled(fast);
  pf.ratio = 2.0f;
  const float a_at = sweep(slow, ps, 0.95f, 0.40f, 0.8f);
  const float b_at = sweep(fast, pf, 0.95f, 0.40f, 0.8f);
  const Glint* a = launched(slow);
  const Glint* b = launched(fast);
  REQUIRE(a != nullptr);
  REQUIRE(b != nullptr);
  REQUIRE_THAT(a_at, WithinAbs(b_at, 1e-4));   // same gesture, same launch point
  REQUIRE_THAT((b->pos + pf.lead) / (a->pos + ps.lead), WithinAbs(2.0, 0.1));
}

TEST_CASE("a launch cannot happen standing still", "[three_planes_glints]") {
  // Which is the reason the band ENTRY is the event and not the band itself: a
  // knob parked in the middle — where an untouched card sits — has no gesture
  // behind it, and a glint with no speed would just sit there.
  Core c;
  Params p;
  p.chaos = 0.0f;
  hold(c, p, 0.5f, 2.0f);
  REQUIRE(c.liveCount() == 0);
}

TEST_CASE("the launch takes the speed of the gesture that threw it",
          "[three_planes_glints]") {
  // Instant attack: at the moment of the launch the shared speed already IS
  // the knob's speed, so a fast gesture throws a fast glint from its first
  // frame rather than winding up.
  Core c;
  Params p = settled(c);
  sweep(c, p, 0.95f, 0.72f, 0.25f);   // arrive at the band edge at ~0.9 range/s
  const float before = c.speed;
  c.tick(p, kDt);                     // ...and cross it
  REQUIRE(before > 0.5f);
  REQUIRE_THAT(c.speed, WithinAbs(before, 0.25));
}

TEST_CASE("sign is thrown away: reversing does not turn a glint round",
          "[three_planes_glints]") {
  Core c;
  Params p = settled(c);
  sweep(c, p, 0.95f, 0.30f, 0.5f);
  const Glint* g = launched(c);
  REQUIRE(g != nullptr);
  const float at_reversal = g->pos;

  // Straight back the other way, just as fast.
  sweep(c, p, 0.30f, 0.95f, 0.5f);
  // It kept going forward the whole time — never paused, never came back.
  for (int i = 0; i < kMaxLive; ++i)
    if (c.glints[i].live && c.glints[i].launched)
      REQUIRE(c.glints[i].pos > at_reversal);
}

TEST_CASE("nothing about a live glint changes after it is born",
          "[three_planes_glints]") {
  // Once thrown, a glint is under its own power: letting go of the knob must
  // not dim it, narrow it, or take its wake away.
  Core c;
  Params p = settled(c);
  sweep(c, p, 0.95f, 0.60f, 0.3f);
  const Glint* g = launched(c);
  REQUIRE(g != nullptr);
  const Glint born = *g;

  hold(c, p, 0.60f, 0.3f);
  const Glint* now = launched(c);
  REQUIRE(now != nullptr);
  REQUIRE_THAT(now->gain, WithinAbs(born.gain, 0.0));
  REQUIRE_THAT(now->width, WithinAbs(born.width, 0.0));
  REQUIRE_THAT(now->shade, WithinAbs(born.shade, 0.0));
  // ...but it HAS moved on. Speed is the one thing the knob still owns, and it
  // idles rather than stopping, so a glint always finishes its crossing.
  REQUIRE(now->pos > born.pos);
}

TEST_CASE("a glint crosses and dies past the far boundary",
          "[three_planes_glints]") {
  Core c;
  Params p = settled(c);
  sweep(c, p, 0.95f, 0.05f, 0.5f);
  REQUIRE(c.liveCount() == 1);

  float last = -9.0f;
  bool died = false;
  for (int i = 0; i < 4000 && !died; ++i) {
    c.tick(p, kDt);
    if (c.liveCount() == 0) { died = true; break; }
    REQUIRE(c.glints[0].pos > last);   // monotone the whole way
    last = c.glints[0].pos;
  }
  REQUIRE(died);
  REQUIRE(last > 1.0f);   // it made it past the picture, not out early
}

TEST_CASE("glints never cross or swap order", "[three_planes_glints]") {
  // Driven hard, with the knob thrashing back and forth — which is the case
  // that would break it if speed were ever per-glint.
  Core c;
  Params p;
  p.chaos = 10.0f;
  float at = 0.95f;
  for (int g = 0; g < 40; ++g) {
    at = (g % 2) ? 0.95f : 0.05f;
    sweep(c, p, (g % 2) ? 0.05f : 0.95f, at, 0.05f + 0.01f * (float)(g % 7));
    const std::vector<float> v = positions(c);
    for (size_t a = 0; a < v.size(); ++a)
      for (size_t b = a + 1; b < v.size(); ++b)
        REQUIRE(std::fabs(v[a] - v[b]) >= kMinGap - 1e-4f);
  }
}

TEST_CASE("an unhurried sweep is one clean glint and nothing else",
          "[three_planes_glints]") {
  // Chaos is a HIGH-speed thing. A gentle traverse must not scuff itself up,
  // or the gesture stops being legible.
  Core c;
  Params p = settled(c);
  p.chaos = 8.0f;
  sweep(c, p, 0.95f, 0.05f, 2.5f);   // ~0.36 ranges/s, well under kChaosFrom
  REQUIRE(c.liveCount() == 1);
  REQUIRE(launchedCount(c) == 1);
}

TEST_CASE("a fast sweep scuffs itself up with small ones",
          "[three_planes_glints]") {
  Core c;
  Params p = settled(c);
  p.chaos = 10.0f;
  sweep(c, p, 0.95f, 0.05f, 0.18f);   // ~5 ranges/s: well past kChaosFull
  REQUIRE(launchedCount(c) == 1);
  REQUIRE(c.liveCount() > 1);

  // And they are unmistakably the small ones: every chaos glint is narrower
  // and dimmer than the launched glint it is sitting under.
  const Glint* big = launched(c);
  REQUIRE(big != nullptr);
  for (int i = 0; i < kMaxLive; ++i) {
    const Glint& g = c.glints[i];
    if (!g.live || g.launched) continue;
    REQUIRE(g.width < big->width);
    REQUIRE(g.gain < big->gain);
  }
}

TEST_CASE("the launch is guaranteed even when the sky is full",
          "[three_planes_glints]") {
  // Chaos arrivals are dropped when there is no room; a launch is not. It is
  // the gesture, and a gesture that sometimes does nothing is not a control.
  Core c;
  Params p;
  p.chaos = 16.0f;
  // Thrash until the slots are saturated with chaos.
  for (int g = 0; g < 12; ++g)
    sweep(c, p, (g % 2) ? 0.05f : 0.95f, (g % 2) ? 0.95f : 0.05f, 0.10f);
  REQUIRE(c.liveCount() >= 1);

  const unsigned before = c.launches;
  sweep(c, p, 0.95f, 0.05f, 0.10f);
  REQUIRE(c.launches == before + 1);
}

TEST_CASE("a transport stall neither loses the gesture nor bursts",
          "[three_planes_glints]") {
  // dt is clamped, so a stalled frame advances by kMaxDt rather than by the
  // wall-clock gap. The knob still moved across the band during it, so the
  // launch must still happen — exactly once.
  Core c;
  Params p;
  p.chaos = 12.0f;
  hold(c, p, 0.95f, 0.3f);
  p.sweep = 0.05f;
  c.tick(p, 4.0f);
  // The knob was never SEEN inside the band — it went straight past it — but
  // it changed sides, and that is a traverse however few samples it took.
  REQUIRE(c.launches == 1);
  REQUIRE(c.liveCount() <= kMaxLive);

  // And a zero-dt frame (a paused transport re-publishing) changes nothing.
  const int before = c.liveCount();
  c.tick(p, 0.0f);
  REQUIRE(c.liveCount() == before);
}

TEST_CASE("Chaos 0 leaves the gesture completely alone",
          "[three_planes_glints]") {
  Core c;
  Params p = settled(c);
  p.chaos = 0.0f;
  for (int g = 0; g < 6; ++g)
    sweep(c, p, (g % 2) ? 0.05f : 0.95f, (g % 2) ? 0.95f : 0.05f, 0.12f);
  REQUIRE(c.launches == 6);
  REQUIRE(c.liveCount() == launchedCount(c));   // every glint up there is a gesture
}

TEST_CASE("reset clears the sky", "[three_planes_glints]") {
  Core c;
  Params p = settled(c);
  sweep(c, p, 0.95f, 0.05f, 0.4f);
  REQUIRE(c.liveCount() > 0);
  c.reset();
  REQUIRE(c.liveCount() == 0);
}
