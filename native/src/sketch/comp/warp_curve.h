// warp_curve.h — warped beat ⇄ seconds mapping for the composition executor.
//
// LOCK-STEP: web/src/views/arrangement/model/beat-grid.ts (WarpCurve) and
// web/src/views/arrangement/engine/warp-clock.ts (WarpClock). The math must be
// IEEE-identical to the TS twins — every arithmetic op in the same order — so
// the web and native playheads agree (shared goldens: test_comp_time.cpp ↔
// comp-goldens.test.ts). Only std::sin may differ from V8's Math.sin by ~1 ulp;
// the goldens compare within tolerance where sin is involved.
//
// Model: instantaneous tempo multiplier m(beat) = 1 + Σ amplitude·wave(...)
// over the active warp segments, integrated (cumulative trapezoid table,
// STEP-beat samples) to "warped units":  unitsAt(beat) = ∫₀ᵇᵉᵃᵗ m(b) db.
// secondsAt(beat) = (60/bpm) · unitsAt(beat).

#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "comp_model.h"

namespace comp {

/** Beats per integration sample (beat-grid.ts STEP). */
inline constexpr double kWarpStep = 0.125;

/** Math.PI (exact double). Kept explicit — M_PI is not guaranteed under wasi. */
inline constexpr double kPi = 3.141592653589793;

inline double waveValue(Waveform kind, double phase) {
  const double p = phase - std::floor(phase);  // [0,1)
  switch (kind) {
    case Waveform::Sine:
      return std::sin(p * kPi * 2);
    case Waveform::Square:
      return p < 0.5 ? 1.0 : -1.0;
    case Waveform::Triangle:
      return p < 0.5 ? p * 4 - 1 : 3 - p * 4;
    case Waveform::Saw:
      return p * 2 - 1;
  }
  return 0;
}

/** Summed warp deviation at a beat (≈ -amp..amp), for the beat-warp lane curve. */
inline double warpDeviationAt(const std::vector<WarpSegment>& segments, double beat) {
  double s = 0;
  for (const auto& seg : segments) {
    if (beat < seg.startBeat || beat > seg.endBeat) continue;
    const double local = (beat - seg.startBeat) / seg.periodBeats + seg.phase;
    s += seg.amplitude * waveValue(seg.waveform, local);
  }
  return s;
}

inline double tempoMultiplier(const std::vector<WarpSegment>& segments, double beat) {
  double m = 1;
  for (const auto& s : segments) {
    if (beat < s.startBeat || beat > s.endBeat) continue;
    const double local = (beat - s.startBeat) / s.periodBeats + s.phase;
    m += s.amplitude * waveValue(s.waveform, local);
  }
  // Clamp the multiplier so it never goes non-positive (grid can't reverse).
  return std::max(0.15, m);
}

class WarpCurve {
 public:
  WarpCurve() : totalBeats_(0) { cum_.push_back(0); }

  WarpCurve(const std::vector<WarpSegment>& segments, double totalBeats)
      : totalBeats_(totalBeats) {
    const int n = static_cast<int>(std::ceil(totalBeats / kWarpStep)) + 1;
    cum_.reserve(std::max(1, n));
    double acc = 0;
    double prevM = tempoMultiplier(segments, 0);
    cum_.push_back(0);
    for (int i = 1; i < n; i++) {
      const double beat = i * kWarpStep;
      const double m = tempoMultiplier(segments, beat);
      acc += ((prevM + m) / 2) * kWarpStep;  // trapezoid
      cum_.push_back(acc);
      prevM = m;
    }
  }

  double totalBeats() const { return totalBeats_; }

  /** Warped units at a beat (linear interp, clamped/extrapolated). */
  double unitsAt(double beat) const {
    if (beat <= 0) return beat;  // neutral before origin
    const double f = beat / kWarpStep;
    const double i = std::floor(f);
    const size_t idx = static_cast<size_t>(i);
    if (idx >= cum_.size() - 1) {
      // Extrapolate beyond the table at neutral tempo (slope 1).
      const double last = cum_.back();
      return last + (beat - (cum_.size() - 1) * kWarpStep);
    }
    const double t = f - i;
    return cum_[idx] * (1 - t) + cum_[idx + 1] * t;
  }

  /** Inverse: the beat at a given warped-units position (binary search). */
  double beatAt(double units) const {
    if (units <= 0) return units;
    const double last = cum_.back();
    if (units >= last) return (cum_.size() - 1) * kWarpStep + (units - last);
    size_t lo = 0;
    size_t hi = cum_.size() - 1;
    while (lo < hi) {
      const size_t mid = (lo + hi) >> 1;
      if (cum_[mid] < units) lo = mid + 1;
      else hi = mid;
    }
    // cum[lo] >= units >= cum[lo-1]
    const size_t i = std::max<size_t>(1, lo);
    const double u0 = cum_[i - 1];
    const double u1 = cum_[i];
    const double t = u1 > u0 ? (units - u0) / (u1 - u0) : 0;
    return (i - 1 + t) * kWarpStep;
  }

 private:
  std::vector<double> cum_;  // cumulative warped units at i*STEP beats
  double totalBeats_;
};

/** Beat ⇄ real-seconds under warp: secondsAt(beat) = (60/bpm)·unitsAt(beat). */
class WarpClock {
 public:
  WarpClock() : secondsPerBeat_(0.5) {}
  WarpClock(WarpCurve curve, double bpm)
      : curve_(std::move(curve)), secondsPerBeat_(60.0 / bpm) {}

  const WarpCurve& curve() const { return curve_; }
  /** Base seconds per beat at the nominal tempo (no warp). */
  double secondsPerBeat() const { return secondsPerBeat_; }

  /** Real seconds elapsed from beat 0 to `beat`, accounting for warp. */
  double secondsAt(double beat) const { return secondsPerBeat_ * curve_.unitsAt(beat); }

  /** Inverse: the (warped) beat playing at `seconds`. */
  double beatAtSeconds(double seconds) const { return curve_.beatAt(seconds / secondsPerBeat_); }

  /** Instantaneous seconds-per-beat at `beat` (central difference). */
  double localSecondsPerBeat(double beat, double eps = 1e-3) const {
    const double lo = std::max(0.0, beat - eps);
    const double hi = beat + eps;
    return (secondsAt(hi) - secondsAt(lo)) / (hi - lo);
  }

  /** Total composition duration in seconds (warp-aware). */
  double durationSeconds() const { return secondsAt(curve_.totalBeats()); }

 private:
  WarpCurve curve_;
  double secondsPerBeat_;
};

}  // namespace comp
