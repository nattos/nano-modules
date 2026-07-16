// test_transient_shaper.cpp — behavior goldens for the adaptive beat-grid
// transient sharpener core (sketch/transient_shaper.h) backing
// mod.shaper.transient_shaper.
//
// The synthetic signal models real Resolume FFT bass captures (trance,
// four-on-the-floor): the level rides an ELEVATED floor (~0.4 — the rolling
// bassline never lets it fall to zero), each kick steps the peak-hold up by
// only ~0.2 of full scale, the hold falls LINEARLY (Resolume's "Fall"), and a
// one-pole rise smear stands in for the analyzer's smoothing (20 ms crisp,
// 50 ms for the laggy configuration the shaper exists to fix).
//
// Everything runs at a deterministic dt — fixed 240 fps for the timing
// goldens, plus a seeded-LCG 4..20 ms jitter variant where robustness is the
// point. Hundreds of bars simulate in milliseconds; this is where the
// algorithm is validated (the web e2e is only a wiring smoke).

#include "sketch/transient_shaper.h"

#include <catch2/catch_test_macros.hpp>
#include <cmath>
#include <utility>
#include <vector>

using transient_shaper::Params;
using transient_shaper::Result;
using transient_shaper::Shaper;

namespace {

// Resolume-flavored bass generator: kick impulses -> exp tail -> linear-fall
// peak hold riding an elevated floor -> one-pole rise smear.
struct KickSim {
  double bpm = 128.0;
  float base = 0.40f;       // sustained bass floor
  float kick_gain = 0.22f;  // kick step above the floor
  float fall = 0.8f;        // peak-hold linear fall, level/s
  float rise_tau = 0.020f;  // analyzer rise smear (0.050 = "laggy")
  bool pattern[16] = {};    // which 16th slots carry a kick

  double t = 0.0;
  float kick = 0.0f;   // kick energy envelope
  float ph = 0.0f;     // peak hold
  float sm = 0.0f;     // smoothed output (feed this to the shaper)
  bool kicked_this_step = false;

  KickSim() { ph = sm = base; }

  double barSeconds() const { return 240.0 / bpm; }
  double barPhase() const { return std::fmod(t / barSeconds(), 1.0); }

  void step(double dt) {
    kicked_this_step = false;
    const double slot_sec = barSeconds() / 16.0;
    const long k0 = (long)std::floor(t / slot_sec);
    const long k1 = (long)std::floor((t + dt) / slot_sec);
    for (long k = k0 + 1; k <= k1; ++k) {
      if (pattern[k % 16]) {
        kick = kick_gain;
        kicked_this_step = true;
      }
    }
    kick *= (float)std::exp(-dt / 0.120);
    const float raw = base + kick;
    ph = std::fmax(raw, ph - fall * (float)dt);
    sm += (ph - sm) * (1.0f - (float)std::exp(-dt / rise_tau));
    t += dt;
  }
};

// Deterministic dt source: fixed step, or seeded-LCG jitter in [4, 20] ms.
struct DtSource {
  bool jitter = false;
  unsigned state = 12345u;
  double next() {
    if (!jitter) return 1.0 / 240.0;
    state = state * 1664525u + 1013904223u;
    return 0.004 + 0.016 * ((state >> 8) & 0xffff) / 65535.0;
  }
};

struct Harness {
  KickSim sim;
  Shaper sh;
  Params p;
  DtSource dts;
  int fires = 0;

  // Advance `seconds`, calling fn(x, result, dt) per tick when provided.
  template <typename F>
  void run(double seconds, F&& fn) {
    const double t_end = sim.t + seconds;
    while (sim.t < t_end) {
      const double dt = dts.next();
      sim.step(dt);
      const Result r = sh.tick(sim.sm, sim.barPhase(), sim.bpm, dt, p);
      if (r.fired) fires++;
      fn(sim.sm, r, dt);
    }
  }
  void run(double seconds) {
    run(seconds, [](float, const Result&, double) {});
  }
  void runBars(double bars) { run(bars * sim.barSeconds()); }

  void fourOnFloor(bool on) {
    for (int i = 0; i < 16; i++) sim.pattern[i] = false;
    if (on) sim.pattern[0] = sim.pattern[4] = sim.pattern[8] = sim.pattern[12] = on;
  }
};

}  // namespace

TEST_CASE("flat input: no fires, bit-exact passthrough", "[transient_shaper]") {
  for (bool jitter : {false, true}) {
    Harness h;
    h.dts.jitter = jitter;
    bool exact = true;
    h.run(20 * h.sim.barSeconds(), [&](float x, const Result& r, double) {
      if (r.output != x) exact = false;
    });
    CHECK(h.fires == 0);
    CHECK(exact);
  }
}

TEST_CASE("four-on-the-floor converges: kick slots confident, others silent",
          "[transient_shaper]") {
  for (bool jitter : {false, true}) {
    Harness h;
    h.dts.jitter = jitter;
    h.fourOnFloor(true);
    h.runBars(8);
    for (int s = 0; s < 16; s++) {
      if (s % 4 == 0) {
        CHECK(h.sh.slots[s].conf > 0.8f);
        CHECK(h.sh.slots[s].peak > h.sim.base + 0.5f * h.sim.kick_gain);
      } else {
        CHECK(h.sh.slots[s].conf < 0.1f);
      }
    }
    CHECK(h.fires >= 28);   // ~4 per bar once running
  }
}

TEST_CASE("converged output rises to 80% of its swing earlier than the laggy input",
          "[transient_shaper]") {
  Harness h;
  h.sim.rise_tau = 0.050f;   // the laggy configuration the shaper exists for
  h.p.amount = 1.0f;
  h.fourOnFloor(true);
  h.runBars(12);

  // Measure over the next 4 bars: per kick, time from the kick impulse to
  // each signal reaching floor + 80% of ITS OWN swing within a 300 ms window.
  struct Window {
    bool active = false;
    double t0 = 0, elapsed = 0;
    float floor_in = 0, floor_out = 0;
    float max_in = 0, max_out = 0;
    // (time, value) trace, coarse: sampled per tick
    double t80_in = -1, t80_out = -1;
  } w;
  double worst_gain = 1e9;   // min (t80_in - t80_out) across kicks
  int measured = 0;
  float prev_x = h.sim.sm;
  float prev_out = h.sim.sm;
  // Two passes over the same window set: first find maxima, then thresholds.
  // Simpler online version: record traces per window.
  std::vector<std::pair<double, std::pair<float, float>>> trace;
  h.run(4 * h.sim.barSeconds(), [&](float x, const Result& r, double dt) {
    if (h.sim.kicked_this_step && !w.active) {
      w.active = true;
      w.elapsed = 0;
      w.floor_in = prev_x;
      w.floor_out = prev_out;
      trace.clear();
    }
    if (w.active) {
      w.elapsed += dt;
      trace.push_back({w.elapsed, {x, r.output}});
      if (w.elapsed >= 0.300) {
        float max_in = 0, max_out = 0;
        for (auto& e : trace) {
          max_in = std::fmax(max_in, e.second.first);
          max_out = std::fmax(max_out, e.second.second);
        }
        const float th_in = w.floor_in + 0.8f * (max_in - w.floor_in);
        const float th_out = w.floor_out + 0.8f * (max_out - w.floor_out);
        double t_in = -1, t_out = -1;
        for (auto& e : trace) {
          if (t_in < 0 && e.second.first >= th_in) t_in = e.first;
          if (t_out < 0 && e.second.second >= th_out) t_out = e.first;
        }
        if (t_in > 0 && t_out > 0) {
          worst_gain = std::fmin(worst_gain, t_in - t_out);
          measured++;
        }
        w.active = false;
      }
    }
    prev_x = x;
    prev_out = r.output;
  });
  REQUIRE(measured >= 8);
  // The enhanced output must reach 80% of its swing at least 15 ms earlier
  // than the laggy input on EVERY measured kick.
  CHECK(worst_gain >= 0.015);
}

TEST_CASE("detection-first: a breakdown fires no ghost boosts", "[transient_shaper]") {
  Harness h;
  h.fourOnFloor(true);
  h.runBars(8);
  REQUIRE(h.sh.slots[0].conf > 0.7f);

  // Kill the kicks; give the tail one bar to settle to the flat floor.
  h.fourOnFloor(false);
  h.sim.kick = 0.0f;
  h.runBars(1);

  h.fires = 0;
  bool exact = true;
  h.run(2 * h.sim.barSeconds(), [&](float x, const Result& r, double) {
    if (r.output != x) exact = false;
  });
  CHECK(h.fires == 0);
  CHECK(exact);
}

TEST_CASE("misses decay confidence within a few bars", "[transient_shaper]") {
  Harness h;
  h.fourOnFloor(true);
  h.runBars(8);
  REQUIRE(h.sh.slots[4].conf > 0.8f);
  h.fourOnFloor(false);
  h.sim.kick = 0.0f;
  h.runBars(4);
  for (int s = 0; s < 16; s += 4) CHECK(h.sh.slots[s].conf < 0.3f);
}

TEST_CASE("non-repetitive kicks never earn confidence or real boost",
          "[transient_shaper]") {
  Harness h;
  unsigned rng = 777u;
  float max_boost = 0.0f;
  float max_conf = 0.0f;
  for (int bar = 0; bar < 32; bar++) {
    rng = rng * 1664525u + 1013904223u;
    for (int i = 0; i < 16; i++) h.sim.pattern[i] = false;
    h.sim.pattern[(rng >> 12) % 16] = true;   // one kick, random slot, per bar
    h.run(h.sim.barSeconds(), [&](float x, const Result& r, double) {
      max_boost = std::fmax(max_boost, r.output - x);
    });
    for (int s = 0; s < 16; s++) max_conf = std::fmax(max_conf, h.sh.slots[s].conf);
  }
  CHECK(max_conf < 0.5f);
  CHECK(max_boost < 0.12f);
}

TEST_CASE("pluck: fast attack, parameterized release, exact-zero rest",
          "[transient_shaper]") {
  Harness h;
  h.sim.pattern[0] = true;   // one kick per bar
  h.runBars(2);              // let one land

  // Catch the next fire and trace the pluck.
  double since_fire = -1;
  double t_peak = -1, t_low = -1;
  bool saw_zero = false;
  h.run(1.5 * h.sim.barSeconds(), [&](float, const Result& r, double dt) {
    if (r.fired) since_fire = 0;
    else if (since_fire >= 0) since_fire += dt;
    if (since_fire >= 0) {
      if (t_peak < 0 && r.pluck > 0.9f) t_peak = since_fire;
      if (t_peak >= 0 && t_low < 0 && r.pluck < 0.05f) t_low = since_fire;
      if (t_low >= 0 && r.pluck == 0.0f) saw_zero = true;
    }
  });
  REQUIRE(since_fire >= 0);            // a fire happened
  REQUIRE(t_peak >= 0);
  CHECK(t_peak < 0.035);               // >0.9 within 35 ms
  REQUIRE(t_low >= 0);
  CHECK(t_low < 3.5 * 0.18 + 0.05);    // below 0.05 within ~3.5 releases
  CHECK(saw_zero);                     // flushes to exact 0
}

TEST_CASE("seek: bar-phase jump reseeds runtime, keeps learning, no ghost fire",
          "[transient_shaper]") {
  Harness h;
  h.fourOnFloor(true);
  h.runBars(8);
  REQUIRE(h.sh.slots[0].conf > 0.7f);

  // Flatten the signal, settle, snapshot the learned layer.
  h.fourOnFloor(false);
  h.sim.kick = 0.0f;
  h.runBars(1);
  float conf_before[16];
  for (int s = 0; s < 16; s++) conf_before[s] = h.sh.slots[s].conf;

  // Jump the transport +0.4 bar (a scrub, not a wrap).
  h.sim.t += 0.4 * h.sim.barSeconds();
  h.fires = 0;
  const double dt = 1.0 / 240.0;
  h.sim.step(dt);
  h.sh.tick(h.sim.sm, h.sim.barPhase(), h.sim.bpm, dt, h.p);
  // Immediately after the reseed tick: learned layer untouched.
  for (int s = 0; s < 16; s++) CHECK(h.sh.slots[s].conf == conf_before[s]);
  // And no fire materializes out of the reseed for the next 100 ms.
  h.run(0.100);
  CHECK(h.fires == 0);
}
