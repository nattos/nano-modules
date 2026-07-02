// clip_time.h — the read-side beat→source-time mapper for video clips.
//
// LOCK-STEP: web/src/views/arrangement/engine/clip-time.ts. Keep the math
// byte-identical (same ops, same order) so playback, film strips, and the
// native pump all agree (shared goldens: test_comp_time.cpp ↔
// comp-goldens.test.ts). Everything is IEEE-deterministic except std::sin
// (smoothNoise, warp) which may differ from V8 by ~1 ulp.
//
// Given a clip's ClipLoopConfig (a source SLICE in neutral-speed seconds + a
// play mode) and where the transport is (an arrangement beat), compute WHICH
// second of the source file to display — or nullopt to render transparent.
//
// The math (per the play-mode spec):
//   elapsedSec = secondsAt(beat) − secondsAt(startBeat)  // real seconds into the clip
//   loopLen    = endSec − startSec                        // slice length at neutral speed
//   one-shot : vt = startSec ± speed·elapsedSec ; transparent off the file ends.
//   time     : vt = startSec + fold(±speed·elapsedSec, loopLen) ; loops with BPM + length.
//   beat-sync: vt = startSec + fold(±localBeat, videoBeats)/videoBeats · loopLen.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>

#include "comp_model.h"
#include "warp_curve.h"

namespace comp {

namespace clip_time_detail {

inline constexpr double kEps = 1e-9;

/** JS `((x % m) + m) % m` — fmod is the exact twin of JS `%` for doubles. */
inline double jsmod(double x, double m) { return std::fmod(std::fmod(x, m) + m, m); }

/** Triangle wave: 0 at 0, `period` at `period`, back to 0 at 2·period. */
inline double tri(double x, double period) {
  const double m = jsmod(x, 2 * period);
  return period - std::abs(m - period);
}

/**
 * Map a play-START position into the looping source SLICE [loopStart, loopEnd].
 * `playStart` may sit BEFORE loopStart (a pre-roll played once before the loop
 * kicks in). `consumed` is the (unsigned) source-seconds since the left edge;
 * `dirSign` the play direction.
 */
inline double loopedSourceTime(double playStart, double consumed, double loopStart,
                               double loopEnd, bool pingpong, int dirSign) {
  const double loopLen = loopEnd - loopStart;
  if (loopLen <= kEps) return loopStart;
  if (dirSign >= 0) {
    const double p = playStart + consumed;  // tape advances up from the play-start
    if (p < loopEnd) return p;              // first pass: pre-roll + up to the loop end
    const double over = p - loopEnd;
    return pingpong ? loopEnd - tri(over, loopLen) : loopStart + jsmod(over, loopLen);
  }
  const double p = playStart - consumed;  // reverse: tape descends from the play-start
  if (p > loopStart) return p;
  const double over = loopStart - p;
  return pingpong ? loopStart + tri(over, loopLen) : loopEnd - jsmod(over, loopLen);
}

}  // namespace clip_time_detail

/**
 * Smooth, deterministic, seeded noise in [0,1] — a sum of sines (C∞, bounded,
 * quasi-periodic). Approximates stochastic `random` play mode with a
 * reproducible wander; the same function drives playback AND the film strips.
 */
inline double smoothNoise(double t, double seed) {
  const double p = seed * 6.2831853;  // seed → a phase offset, spread differently per term
  const double s = std::sin(t + p) + 0.6 * std::sin(t * 1.7 + p * 2.3 + 1.1) +
                   0.35 * std::sin(t * 2.9 + p * 4.1 + 2.3);
  return 0.5 + (0.5 * s) / (1 + 0.6 + 0.35);  // ∈ [0,1]
}

/**
 * Stable per-clip noise seed (∈[0,1)) from its id. TS iterates UTF-16 code
 * units; clip ids are ASCII so bytes are identical here.
 */
inline double clipNoiseSeed(const std::string& id) {
  uint64_t h = 0;
  for (const char ch : id) {
    h = (h * 31 + static_cast<uint64_t>(static_cast<unsigned char>(ch))) & 0xffffffffull;
  }
  return static_cast<double>(h % 10007) / 10007;
}

/** Everything the mapper needs about a clip's placement + source (clip-time.ts ClipTimeCtx). */
struct ClipTimeCtx {
  /** Clip start on the arrangement timeline, in beats. */
  double startBeat = 0;
  /** Clip length on the timeline, in beats. */
  double lengthBeat = 0;
  /** Full source duration in seconds (frameCount / fps). */
  double videoDurSec = 0;
  /** Warp-aware beat→real-seconds map (TS passes a closure; here always a WarpClock —
   *  an un-warped clock is just an empty-segment curve). */
  const WarpClock* clock = nullptr;
  /** Per-clip noise seed for `random` mode (clipNoiseSeed). Ignored elsewhere. */
  double seed = 0;
};

/**
 * The source time (seconds into the file) to display at arrangement `beat`,
 * or nullopt to render transparent.
 */
inline std::optional<double> clipSourceTimeAt(const ClipLoopConfig& loop, const ClipTimeCtx& ctx,
                                              double beat) {
  using namespace clip_time_detail;
  const double startSec = loop.startSec;
  const double speed = loop.speed;
  const int dir = loop.direction;
  const double elapsedSec = ctx.clock->secondsAt(beat) - ctx.clock->secondsAt(ctx.startBeat);

  if (loop.mode == ClipPlayMode::OneShot) {
    // Plays once; the end-into-source free-floats. Off either file end ⇒ transparent.
    const double vt = startSec + dir * speed * elapsedSec;
    if (vt < -kEps || vt >= ctx.videoDurSec - kEps) return std::nullopt;
    return vt;
  }

  if (loop.mode == ClipPlayMode::Random) {
    // Deterministic smooth-noise approximation of the stochastic dwell-jump
    // playback: a seeded noise of the timeline beat wandering the slice.
    const double lo = startSec;
    const double hi = loop.endSec.value_or(ctx.videoDurSec);
    const double range = hi - lo;
    if (range <= kEps) return lo;
    const double secPerBeat = std::max(
        1e-3, ctx.clock->secondsAt(ctx.startBeat + 1) - ctx.clock->secondsAt(ctx.startBeat));
    const double dwell = loop.dwell.value_or(RandomDefaults::dwell);
    const double dwellBeats =
        std::max(0.05, loop.dwellUnit == DwellUnit::Sec ? dwell / secPerBeat : dwell);
    const double vt = lo + range * smoothNoise(beat / dwellBeats, ctx.seed);
    if (vt < -kEps || vt >= ctx.videoDurSec - kEps) return std::nullopt;
    return vt;
  }

  // Looping modes (time / beat-sync) share one slice + play-start anchor; they
  // differ only in how fast the source is consumed per beat.
  const double loopStart = startSec;
  const double loopEnd = loop.endSec.value_or(ctx.videoDurSec);
  const double loopLen = loopEnd - loopStart;
  if (loopLen <= kEps) return loopStart;
  const double playStart = loop.playStartSec.value_or(loopStart);
  const bool pingpong = loop.pingpong;

  double consumed;  // unsigned source-seconds consumed since the clip's left edge
  if (loop.mode == ClipPlayMode::BeatSync) {
    // Loop locked to beats (BPM-independent): one loop spans `videoBeats` beats.
    const double videoBeats = loop.syncUseBpm ? loopLen * (loop.syncBpm.value_or(120) / 60)
                                              : loop.syncBeats.value_or(4);
    if (videoBeats <= kEps) return loopStart;
    consumed = ((beat - ctx.startBeat) / videoBeats) * loopLen;
  } else {
    // 'time': consumed at the real-time rate.
    consumed = speed * elapsedSec;
  }

  const double vt = loopedSourceTime(playStart, consumed, loopStart, loopEnd, pingpong, dir);
  // A play-start before the loop can pre-roll off the file ends → transparent.
  if (vt < -kEps || vt >= ctx.videoDurSec - kEps) return std::nullopt;
  return vt;
}

/**
 * The source FRAME to display at `beat`, or nullopt (transparent). floor of the
 * source second × fps, clamped into [0, frameCount-1]. A single-frame source
 * (a still image) always shows frame 0 for the whole clip span.
 */
inline std::optional<int32_t> clipSourceFrameAt(const ClipLoopConfig& loop, const ClipTimeCtx& ctx,
                                                double beat, double fps, int32_t frameCount) {
  if (frameCount <= 1) return 0;
  const auto vt = clipSourceTimeAt(loop, ctx, beat);
  if (!vt) return std::nullopt;
  const double f = std::floor(*vt * fps);
  return static_cast<int32_t>(
      std::min(static_cast<double>(frameCount - 1), std::max(0.0, f)));
}

}  // namespace comp
