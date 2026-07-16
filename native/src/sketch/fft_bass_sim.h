#pragma once
/*
 * fft_bass_sim.h — Synthetic Resolume-FFT low-band signal model.
 *
 * Reproduces the shape of real Arena FFT bass captures (trance,
 * four-on-the-floor) so beat-reactive modules can be built and tested
 * without routing audio: the level rides an ELEVATED floor (the rolling
 * bassline never lets it fall to zero), each kick steps a peak hold up by
 * a modest gain, the hold falls LINEARLY (Resolume's "Fall" smoothing),
 * a one-pole rise smear stands in for the analyzer's attack lag, and an
 * optional 8th-note wobble models the between-kick bass groove that makes
 * real captures wiggle.
 *
 * The caller drives it with a bar-grid position in 16th-note units
 * (u = frac(barPhase) * 16) plus dt — kicks fire when a slot line whose
 * `pattern` bit is set is crossed. A bar wrap continues seamlessly; any
 * larger jump (scrub/seek) advances without firing phantom kicks.
 *
 * Header-only and dependency-light so it compiles in the native runtime
 * and any wasm effect bundle. Backs the mod.source.bass_sim effect, and is
 * the signal generator for native/tests/test_transient_shaper.cpp — the
 * effect and the transient-shaper goldens share ONE pinned signal model.
 */

#include <cmath>

namespace fft_bass_sim {

// Kick energy tail: the underlying band energy decays exponentially at this
// tau; the peak hold's linear fall rides on top.
constexpr float kKickTau = 0.120f;

struct Params {
  float base = 0.40f;        // sustained bass floor
  float kick_gain = 0.22f;   // kick step above the floor
  float fall = 0.8f;         // peak-hold linear fall, level/s ("Fall")
  float rise_tau = 0.020f;   // analyzer rise smear, s (0.050 = "laggy")
  float wobble = 0.0f;       // 8th-note bass-groove wiggle amplitude
  unsigned pattern = 0x1111; // bit k = kick on 16th slot k (0x1111 = 4-floor)
};

struct Sim {
  float kick = 0.0f;    // kick energy envelope
  float ph = 0.0f;      // peak hold
  float sm = 0.0f;      // smoothed output level
  double prev_u = -1.0; // sentinel: first step seeds without firing
  bool kicked = false;  // a kick fired during the last step (test hook)

  void reset() { *this = Sim{}; }

  // Advance to bar-grid position `u` (16th-note units, [0, 16)) over `dt`
  // seconds and return the smoothed level.
  float step(double u, double dt, const Params& p) {
    kicked = false;
    if (!(dt > 0.0)) dt = 0.0;         // NaN/negative guard
    if (dt > 0.050) dt = 0.050;        // stall clamp

    // Slot-line crossings over (prev_u, u], wrap-aware. A jump larger than
    // any real frame advances silently (seek — the music didn't play).
    if (prev_u < 0.0) {
      prev_u = u;
      kick = 0.0f;
      ph = sm = target(u, p);
    } else {
      double du = u - prev_u;
      if (du < -8.0) du += 16.0;       // bar wrap
      if (du > 0.0 && du <= 2.0) {
        for (long k = (long)std::floor(prev_u) + 1;
             k <= (long)std::floor(prev_u + du); ++k) {
          if (p.pattern & (1u << (unsigned)(((k % 16) + 16) % 16))) {
            kick = p.kick_gain;
            kicked = true;
          }
        }
      }
      prev_u = u;
    }

    kick *= (float)std::exp(-dt / kKickTau);
    const float raw = target(u, p);
    ph = std::fmax(raw, ph - p.fall * (float)dt);
    const float tau = std::fmax(p.rise_tau, 1e-4f);
    sm += (ph - sm) * (1.0f - (float)std::exp(-dt / tau));
    return sm < 0.0f ? 0.0f : (sm > 1.0f ? 1.0f : sm);
  }

 private:
  // Instantaneous band energy: floor + kick tail + the 8th-note groove.
  float target(double u, const Params& p) const {
    const float w = p.wobble > 0.0f
        ? p.wobble * 0.5f * (1.0f + (float)std::sin(3.14159265358979 * u))
        : 0.0f;
    return p.base + kick + w;
  }
};

}  // namespace fft_bass_sim
