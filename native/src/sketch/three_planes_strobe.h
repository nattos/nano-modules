#pragma once
/*
 * three_planes_strobe.h — the OTHER thing `source.mesh.three_planes` can do
 * with a throw.
 *
 * The release has two modes, and they are the same event told two ways:
 *
 *   Grow   — the stack is flung outward as three expanding rings that open up
 *            and go soft. Energy leaving the frame. (Pure geometry; it lives
 *            in the effect and needs no state at all.)
 *   Strobe — the stack does not move. It comes straight back where it was, as
 *            bare wireframe, and then breaks up: the floors flam one at a time
 *            on a fast roll whose DUTY CYCLE putters out until there is
 *            nothing left. Energy rattling around inside the frame.
 *
 * This header is Strobe's clock. What it does, in the order it happens:
 *
 *   1. THE ARRIVAL. Step 0 lights the whole stack — the one moment you see all
 *      three floors — so the picture lands before it falls apart.
 *   2. THE ROLL. From step 1 it is strictly one floor at a time, bouncing up
 *      and back down the tower so consecutive hits are always neighbours and
 *      the eye can follow it.
 *   3. THE FLAM. A grace stroke on the NEXT floor lands just before each step
 *      changes, quieter than the main one. That is what makes it a flam rather
 *      than a metronome; dial `grace` to 0 for a plain roll.
 *   4. THE PUTTER. The on-window is a fraction of the release, so the hits get
 *      SHORTER as the tail runs down while the rate stays exactly where it
 *      was. That is the whole decay: not a fade — a gate closing. Once the
 *      window falls below a frame the hits start missing frames outright and
 *      it sputters, which is the sound of the thing running out.
 *
 * Brightness is deliberately NOT part of the decay. Every hit is as hard as
 * the first and there are simply fewer of them, which is what keeps a long
 * tail legible over a picture that may already be relighting underneath it.
 * How hard a throw was is already carried by how long the tail lasts (the rig
 * spends its latched charge into `release`, and a weak throw is a short one).
 *
 * Host-free, like three_planes_glints.h and three_planes_rig.h: no effect ABI,
 * no GPU, so the Catch2 goldens drive the whole roll at an exact dt.
 */

#include <cmath>

namespace three_planes_strobe {

constexpr int kPlanes = 3;

/// The roll: which floor each step lights, once the arrival is over. A bounce
/// up and back down, so no step is ever more than one floor from the last.
constexpr int kSteps = 4;
constexpr int kOrder[kSteps] = {0, 1, 2, 1};

/// Steps at the head of a throw that light the WHOLE stack — the arrival.
constexpr int kOpenSteps = 1;

/// How loud the grace stroke is against the main one. A grace note is quieter
/// by definition; if it were not, a flam would just be two hits.
constexpr float kGraceGain = 0.45f;

/// Same stall clamp as the rest of the instrument: a dropped frame must not
/// teleport the roll to a random place in its cycle.
constexpr float kMaxDt = 0.25f;

struct Params {
  float release = 0.0f;   ///< the throw: the rig's charge at the hit, 0 spent
  float rate    = 22.0f;  ///< steps per second — constant through the decay
  float duty    = 0.55f;  ///< on-window, as a fraction of a step at full release
  float grace   = 0.35f;  ///< grace stroke, as a fraction of a STEP
};

struct Core {
  float clock = 0.0f;             ///< steps since the throw
  float gain[kPlanes] = {};       ///< 0..1 per floor, this frame
  float last_release = 0.0f;

  void reset() { *this = Core(); }

  void tick(const Params& p, float dt);
};

inline float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

inline void Core::tick(const Params& p, float dt) {
  if (dt < 0.0f) dt = 0.0f;
  if (dt > kMaxDt) dt = kMaxDt;

  const float rel = clamp01(p.release);
  for (int i = 0; i < kPlanes; ++i) gain[i] = 0.0f;

  // A fresh throw restarts the roll, even over a tail still running: the
  // arrival is the point, and a second hit that landed mid-bounce would read
  // as the first one stumbling rather than as a new one.
  if (rel > last_release + 1e-4f) clock = 0.0f;
  last_release = rel;

  if (rel <= 0.0f) { clock = 0.0f; return; }

  const long long step = (long long)std::floor(clock);
  const float frac = clock - (float)step;
  clock += (p.rate > 0.0f ? p.rate : 0.0f) * dt;

  // The putter. `duty` is the window at FULL release, and the release is what
  // shrinks it — so the rate never changes and the hits simply get shorter.
  const float duty = clamp01(p.duty) * rel;

  if (step < kOpenSteps) {
    // The arrival: the whole stack, and for the WHOLE step rather than for the
    // duty window. It is the hit the tail hangs off — half a frame of it at a
    // brisk rate on a slow display is not a hit, it is a dropout. The roll
    // picks up the instant it ends, so there is no gap to fill either.
    for (int i = 0; i < kPlanes; ++i) gain[i] = 1.0f;
    // No grace out of the arrival — it is a hit, not a stroke in the roll.
    return;
  }

  if (duty <= 0.0f) return;   // a zero window silences the roll, not the arrival

  const int k = (int)((step - kOpenSteps) % kSteps);
  if (frac < duty) gain[kOrder[k]] = 1.0f;

  // The grace stroke, tucked against the end of the step: the next floor
  // speaks a moment early and quietly, then lands.
  //
  // Measured against the STEP, not against the on-window, and that matters at
  // the rates this runs at. A roll of 22 steps/s on a 60 Hz display is under
  // three frames a step, so a grace scaled by the window too would be half a
  // frame wide — it would land on some steps and miss others, and a control
  // that only sometimes does anything is worse than no control. It still
  // putters, because the release scales it like everything else.
  const float gw = clamp01(p.grace) * rel;
  if (gw > 0.0f && frac > 1.0f - gw) {
    const int nxt = kOrder[(k + 1) % kSteps];
    if (gain[nxt] < kGraceGain) gain[nxt] = kGraceGain;
  }
}

}  // namespace three_planes_strobe
