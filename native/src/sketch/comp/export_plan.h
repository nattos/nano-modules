// export_plan.h — the offline export frame plan.
//
// LOCK-STEP: `planExportFrames` in
// web/src/views/arrangement/engine/export-renderer.ts. Pure math over a
// WarpClock — no GPU, no filesystem — so it lives with the rest of comp rather
// than in the host, and both exporters lay their frames on the same grid.

#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "warp_curve.h"

namespace comp {

struct ExportFrame {
  int index = 0;
  /// Absolute transport seconds for this frame (drives the effect clock).
  double tSec = 0;
  /// The (warp-resolved) beat playing at `tSec`.
  double beat = 0;
};

/**
 * Plan the output frames over `[startBeat, endBeat]` at `fps`: walk REAL
 * (warped) seconds in `1/fps` steps from the start's seconds to the end's,
 * mapping each tick back to its (warped) beat. Walking in SECONDS, not beats,
 * is what makes the output cadence uniform in time — a warp that slows a region
 * simply yields more frames there.
 */
inline std::vector<ExportFrame> planExportFrames(const WarpClock& clock, double fps,
                                                 double startBeat, double endBeat) {
  const double startSec = clock.secondsAt(std::max(0.0, startBeat));
  const double endSec = clock.secondsAt(std::max(startBeat, endBeat));
  const double durSec = std::max(0.0, endSec - startSec);
  // TS: Math.round — half rounds up, unlike std::round's half-away-from-zero.
  // Only a non-negative product reaches this, so floor(x+0.5) is exact here.
  const int total = std::max(1, (int)std::floor(durSec * fps + 0.5));
  std::vector<ExportFrame> frames;
  frames.reserve((size_t)total);
  for (int i = 0; i < total; i++) {
    ExportFrame f;
    f.index = i;
    f.tSec = startSec + i / fps;
    f.beat = clock.beatAtSeconds(f.tSec);
    frames.push_back(f);
  }
  return frames;
}

}  // namespace comp
