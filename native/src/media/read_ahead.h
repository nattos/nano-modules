// read_ahead.h — which frames to pre-cache, and which to pin, for the current
// access mode.
//
// LOCK-STEP: web/src/video/read-ahead.ts. Shared goldens:
// web/src/video/video-policy-goldens.test.ts (UPDATE_GOLDENS=1) ↔
// native/tests/test_video_policy.cpp. Keep the two files byte-parallel — a
// precache-depth or hit-rate number only compares across hosts if both pick
// the same frames.
//
// Pure policy: no filesystem, no GPU, no decoder.

#pragma once

#include <string>
#include <vector>

#include "access_classifier.h"

namespace nano_media {

/// Per-pull read-ahead depth for ring-shaped modes (Sequential / Reverse /
/// Strided). Sized to roughly cover the gap between consecutive pulls on a
/// 30 fps timeline.
inline constexpr int kReadAheadDepth = 5;

struct ReadAheadInputs {
  AccessMode mode = AccessMode::Sequential;
  int frameIdx = 0;
  int frameCount = 0;
  /// Sign of the most recent non-zero motion (+1 forward, −1 backward).
  int motionDir = 1;
  int depth = kReadAheadDepth;
  /// Detected stride for the Strided mode (signed). Unset ⇒ 1.
  bool hasStride = false;
  int stride = 1;
};

/**
 * Sequential and Reverse both pre-cache in the ACTUAL direction of motion
 * (`motionDir`), not the mode's nominal direction. For a steady run the two
 * agree; for an oscillating pattern (ping-pong, LFO) the classified mode lags
 * each turn, so following the live direction keeps the read-ahead ahead of the
 * playhead through every reversal.
 */
inline std::vector<int> computeReadAheadTargets(const ReadAheadInputs& inp) {
  const auto inRange = [&](int i) { return i >= 0 && i < inp.frameCount; };
  std::vector<int> out;
  switch (inp.mode) {
    case AccessMode::Sequential:
    case AccessMode::Reverse: {
      const int dir = inp.motionDir < 0 ? -1 : 1;
      for (int k = 1; k <= inp.depth; k++) {
        const int t = inp.frameIdx + k * dir;
        if (inRange(t)) out.push_back(t);
      }
      return out;
    }
    case AccessMode::Strided: {
      const int stride = inp.hasStride ? inp.stride : 1;
      for (int k = 1; k <= inp.depth; k++) {
        const int t = inp.frameIdx + k * stride;
        if (inRange(t)) out.push_back(t);
      }
      return out;
    }
    case AccessMode::Loop:
      // Loop pinning covers the range; light read-ahead for the next one.
      if (inRange(inp.frameIdx + 1)) out.push_back(inp.frameIdx + 1);
      return out;
    case AccessMode::Scrub:
      if (inRange(inp.frameIdx - 1)) out.push_back(inp.frameIdx - 1);
      if (inRange(inp.frameIdx + 1)) out.push_back(inp.frameIdx + 1);
      return out;
    case AccessMode::Hotspots:
    case AccessMode::Random:
    default:
      return out;
  }
}

/**
 * Which frames the cache should PIN (hold against LRU eviction) for the current
 * access mode: a Loop's whole range, or the detected hot frames. Every other
 * mode pins nothing and rides read-ahead alone.
 */
inline std::vector<int> computePinnedFrames(const ClassifierSnapshot& snap) {
  std::vector<int> out;
  if (snap.mode == AccessMode::Loop && snap.hasLoopRange) {
    for (int i = snap.loopRangeA; i <= snap.loopRangeB; i++) out.push_back(i);
    return out;
  }
  if (snap.mode == AccessMode::Hotspots && snap.hasHotFrames) return snap.hotFrames;
  return out;
}

}  // namespace nano_media
