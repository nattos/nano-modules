// test_three_planes_glints.cpp — goldens for the glint particles
// `source.mesh.three_planes` flashes across its quads. Host-free:
// three_planes_glints.h carries no effect ABI, so a lifetime can be driven at
// an exact dt here with no wasm bundle, no executor and no GPU.
//
// What the effect adds on top is the projection onto the travel axis and the
// two exponentials that draw one. Those are covered by web/test/three_planes.
//
// The brief these pin: a glint is an INDEPENDENT OBJECT. It is born, it
// crosses, it dies at the far boundary, and while it is in flight the knob
// that threw it cannot reach it — except through the one shared speed, which
// exists precisely so two of them can never swap places.

#include "sketch/three_planes_glints.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <vector>

using Catch::Matchers::WithinAbs;
using namespace three_planes_glints;

namespace {

/// Run `frames` ticks at a fixed dt.
void run(Core& c, const Params& p, int frames, float dt = 1.0f / 60.0f) {
  for (int i = 0; i < frames; ++i) c.tick(p, dt);
}

/// Live positions, nearest-to-death first. The order is the birth order
/// reversed, and it is the thing that must never change.
std::vector<float> positions(const Core& c) {
  std::vector<float> v;
  for (int i = 0; i < kMaxLive; ++i)
    if (c.glints[i].live) v.push_back(c.glints[i].pos);
  return v;
}

/// Highest live position — the glint closest to dying.
float oldest(const Core& c) {
  float best = -1.0f;
  for (int i = 0; i < kMaxLive; ++i)
    if (c.glints[i].live && c.glints[i].pos > best) best = c.glints[i].pos;
  return best;
}

Params driven(float drive) {
  Params p;
  p.drive = drive;
  return p;
}

}  // namespace

TEST_CASE("no drive, no glints", "[three_planes_glints]") {
  // An unwired card is quiet. This is what makes the whole feature free for
  // every existing sketch that never asks for it.
  Core c;
  run(c, driven(0.0f), 600);
  REQUIRE(c.liveCount() == 0);
}

TEST_CASE("the first tick with drive throws one immediately",
          "[three_planes_glints]") {
  // The arrival countdown starts at zero on purpose: reaching for the knob and
  // waiting a beat for the first glint would read as lag, not as randomness.
  Core c;
  c.tick(driven(1.0f), 1.0f / 60.0f);
  REQUIRE(c.liveCount() == 1);
  // Exactly ON the birth edge for its first frame: the tick moves what is
  // already in flight and THEN takes arrivals, so a newborn cannot skip
  // forward by the frame it was born in.
  REQUIRE(c.glints[0].pos == 0.0f);
  c.tick(driven(1.0f), 1.0f / 60.0f);
  REQUIRE(c.glints[0].pos > 0.0f);
  REQUIRE(c.glints[0].pos < 0.1f);
}

TEST_CASE("a glint crosses and dies at the far boundary",
          "[three_planes_glints]") {
  Core c;
  Params p = driven(1.0f);
  p.density = 0.01f;   // one arrival, then nothing for a hundred seconds
  c.tick(p, 1.0f / 60.0f);
  REQUIRE(c.liveCount() == 1);

  // Monotone travel the whole way, and gone the moment it passes 1.
  float last = c.glints[0].pos;
  bool died = false;
  for (int i = 0; i < 600 && !died; ++i) {
    c.tick(p, 1.0f / 60.0f);
    if (c.liveCount() == 0) { died = true; break; }
    REQUIRE(c.glints[0].pos > last);
    last = c.glints[0].pos;
  }
  REQUIRE(died);
  REQUIRE(last > 0.9f);   // it made it to the boundary, not out early
  // At the default 1.2 crossings/s a full-drive crossing takes ~0.83 s.
  REQUIRE(c.liveCount() == 0);
}

TEST_CASE("nothing about a live glint changes after it is born",
          "[three_planes_glints]") {
  // THE BRIEF. Once thrown, a glint is under its own power: dropping the drive
  // to nothing mid-flight must not dim it, narrow it, or take its wake away.
  Core c;
  Params p = driven(1.0f);
  p.density = 0.01f;
  c.tick(p, 1.0f / 60.0f);
  REQUIRE(c.liveCount() == 1);
  const Glint born = c.glints[0];

  run(c, driven(0.0f), 20);
  REQUIRE(c.liveCount() == 1);
  REQUIRE_THAT(c.glints[0].gain, WithinAbs(born.gain, 0.0));
  REQUIRE_THAT(c.glints[0].width, WithinAbs(born.width, 0.0));
  REQUIRE_THAT(c.glints[0].shade, WithinAbs(born.shade, 0.0));
  // ...but it HAS moved on. Speed is the one thing the drive still owns.
  REQUIRE(c.glints[0].pos > born.pos);
}

TEST_CASE("speed is the one thing the drive still reaches",
          "[three_planes_glints]") {
  // And it must reach every live glint equally: two glints travelling at their
  // own speeds would eventually cross, and the moment they overlap they stop
  // being two things.
  Core fast, slow;
  Params pf = driven(1.0f), ps = driven(0.0f);
  pf.density = ps.density = 0.01f;
  fast.tick(pf, 1.0f / 60.0f);
  slow.tick(pf, 1.0f / 60.0f);   // same birth, then diverge
  run(fast, pf, 20);
  run(slow, ps, 20);
  REQUIRE(fast.glints[0].pos > slow.glints[0].pos);
  // Idle is a floor, not a stop: a glint always finishes its crossing.
  REQUIRE(slow.glints[0].pos > 0.0f);
  REQUIRE_THAT(slow.glints[0].pos / fast.glints[0].pos,
               WithinAbs(kIdleSpeed, 0.02));
}

TEST_CASE("glints never cross or swap order", "[three_planes_glints]") {
  // Driven hard, with the drive swinging around underneath them — which is the
  // case that would break it if speed were ever per-glint.
  Core c;
  for (int i = 0; i < 900; ++i) {
    Params p = driven(i % 120 < 60 ? 1.0f : 0.15f);
    p.density = 9.0f;
    c.tick(p, 1.0f / 60.0f);
    // Separation is established at birth and preserved by the shared speed, so
    // no two live glints may ever be closer than the spawn gap.
    const std::vector<float> v = positions(c);
    for (size_t a = 0; a < v.size(); ++a)
      for (size_t b = a + 1; b < v.size(); ++b)
        REQUIRE(std::fabs(v[a] - v[b]) >= kMinGap - 1e-4f);
  }
}

TEST_CASE("arrivals are independently spaced, not a metronome",
          "[three_planes_glints]") {
  // A pattern is exactly what these stopped being. Exponential inter-arrival
  // times give a real spread of gaps; a fixed period would give one gap over
  // and over, which is what the spread check below would catch.
  Core c;
  Params p = driven(1.0f);
  p.density = 6.0f;
  p.speed = 0.6f;   // long lives, so several are up at once

  std::vector<float> gaps;
  int prev_live = 0;
  float since = 0.0f;
  for (int i = 0; i < 3000; ++i) {
    c.tick(p, 1.0f / 60.0f);
    since += 1.0f / 60.0f;
    const int n = c.liveCount();
    // A rise in the population is an arrival (deaths only ever lower it, and
    // the two cannot land on the same frame at these rates).
    if (n > prev_live) { gaps.push_back(since); since = 0.0f; }
    prev_live = n;
  }
  REQUIRE(gaps.size() > 20);
  float lo = gaps[0], hi = gaps[0], sum = 0.0f;
  for (float g : gaps) { lo = g < lo ? g : lo; hi = g > hi ? g : hi; sum += g; }
  const float mean = sum / (float)gaps.size();
  // Genuinely spread: the longest wait is several times the shortest.
  REQUIRE(hi > lo * 3.0f);
  // ...and still around the requested rate. The floor is loose because the
  // spawn gap and the eight-slot ceiling both suppress arrivals at this
  // density, which lengthens the mean; what matters is that it is not a
  // metronome, and that the rate knob still means something.
  REQUIRE(mean > 1.0f / (p.density * 2.0f));
  REQUIRE(mean < 1.0f);
}

TEST_CASE("each glint gets its own look, drawn once", "[three_planes_glints]") {
  Core c;
  Params p = driven(1.0f);
  p.density = 5.0f;
  p.speed = 0.5f;
  run(c, p, 240);
  REQUIRE(c.liveCount() >= 3);

  float lo = 9.0f, hi = -9.0f;
  for (int i = 0; i < kMaxLive; ++i) {
    if (!c.glints[i].live) continue;
    REQUIRE(c.glints[i].gain > 0.0f);
    REQUIRE(c.glints[i].width > 0.0f);
    lo = c.glints[i].gain < lo ? c.glints[i].gain : lo;
    hi = c.glints[i].gain > hi ? c.glints[i].gain : hi;
  }
  REQUIRE(hi > lo);   // not one repeated stamp
}

TEST_CASE("a harder sweep puts more of them on screen at once",
          "[three_planes_glints]") {
  // Spawn rate scales with the drive outright while travel only lifts off a
  // floor, so density follows the knob — WITHOUT any individual glint's
  // brightness following it. That split is the whole point.
  const auto occupancy = [](float drive) {
    Core c;
    Params p = driven(drive);
    p.density = 6.0f;
    p.speed = 0.8f;
    long total = 0;
    for (int i = 0; i < 1800; ++i) {
      c.tick(p, 1.0f / 60.0f);
      if (i > 120) total += c.liveCount();   // past the fill-up transient
    }
    return (double)total / 1680.0;
  };
  const double hard = occupancy(1.0f);
  const double gentle = occupancy(0.25f);
  REQUIRE(hard > gentle * 1.5);
  REQUIRE(gentle > 0.0);
}

TEST_CASE("the slots are a ceiling, not a recycling ring",
          "[three_planes_glints]") {
  // Overdriven far past what eight slots can hold. An arrival that finds no
  // room is DROPPED — never evicts someone — because a glint vanishing in
  // mid-flight is the one thing a particle here may not do.
  Core c;
  Params p = driven(1.0f);
  p.density = 16.0f;
  p.speed = 0.4f;
  float prev[kMaxLive] = {};
  bool was_live[kMaxLive] = {};
  for (int i = 0; i < 1200; ++i) {
    c.tick(p, 1.0f / 60.0f);
    REQUIRE(c.liveCount() <= kMaxLive);
    for (int k = 0; k < kMaxLive; ++k) {
      // A slot may only go dark from the far end of the travel.
      if (was_live[k] && !c.glints[k].live) REQUIRE(prev[k] > 0.85f);
      was_live[k] = c.glints[k].live;
      prev[k] = c.glints[k].pos;
    }
  }
}

TEST_CASE("a transport stall arrives once, and carries no debt",
          "[three_planes_glints]") {
  // dt is clamped, so a stalled frame advances by kMaxDt rather than by the
  // wall-clock gap. Several arrivals are owed over that step — and only ONE of
  // them can land, because every arrival is at the birth edge and the
  // separation rule refuses to stack them. That is the right answer: a stall
  // should not vomit a wall of glints on top of each other.
  Core c;
  Params p = driven(1.0f);
  p.density = 12.0f;
  p.speed = 0.5f;
  c.tick(p, 4.0f);
  REQUIRE(c.liveCount() == 1);
  REQUIRE(oldest(c) <= 1.0f);

  // Nor is the refused credit banked: the very next frame must not fire the
  // arrivals the stall could not place. It comes back at the ordinary rate.
  c.tick(p, 1.0f / 60.0f);
  REQUIRE(c.liveCount() == 1);

  // And a zero-dt frame (a paused transport re-publishing) changes nothing.
  const int before = c.liveCount();
  c.tick(p, 0.0f);
  REQUIRE(c.liveCount() == before);
}

TEST_CASE("reset clears the sky", "[three_planes_glints]") {
  Core c;
  run(c, driven(1.0f), 120);
  REQUIRE(c.liveCount() > 0);
  c.reset();
  REQUIRE(c.liveCount() == 0);
}
