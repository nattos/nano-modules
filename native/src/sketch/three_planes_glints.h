#pragma once
/*
 * three_planes_glints.h — the glints `source.mesh.three_planes` flashes across
 * its quads: the glare off metal in an old cel-animated show.
 *
 * THESE ARE PARTICLES, NOT A PATTERN. Each glint is an independent object: it
 * is born at one boundary, travels across the picture, and dies at the other.
 * Nothing recycles it, nothing fades it out early, and nothing about the state
 * of the knob that spawned it reaches it afterwards. That is the whole design
 * brief, and it is what a moving PERIODIC field cannot express — a grating has
 * no individuals in it, so slowing the sweep visibly dims and re-spaces glints
 * that were already in flight.
 *
 * What the live drive still controls:
 *
 *   SPAWN RATE — arrivals per second, so a hard sweep throws more of them.
 *                Arrivals are exponentially spaced (a Poisson process), which
 *                is what makes them read as independent events rather than as
 *                a metronome with jitter on it.
 *   SPEED      — shared by every live glint, and the ONE exception to "under
 *                their own power". It has to be shared: two glints travelling
 *                at their own speeds would eventually cross, and the moment
 *                they overlap they stop being two things.
 *
 * Everything else about a glint — how bright, how wide, how dark its wake — is
 * drawn once at birth and then belongs to it.
 *
 * Because spawn rate scales with the drive FASTER than the travel does (speed
 * only lifts off a floor, see kIdleSpeed), a harder sweep also puts more of
 * them on screen at once. Density follows the knob without any glint's own
 * brightness following it.
 *
 * Host-free, like three_planes_rig.h and three_walls_show.h: no effect ABI, no
 * GPU, so the Catch2 goldens drive the whole thing at an exact dt.
 */

#include <cmath>

namespace three_planes_glints {

/// How many glints can be in flight at once. An arrival with every slot busy is
/// DROPPED rather than stealing one, so this is a ceiling on density, not a
/// recycling ring — see `spawn`.
constexpr int kMaxLive = 8;

/// A frame longer than this is a transport stall, not slow motion. Same clamp,
/// and the same reason, as three_planes_rig.h's.
constexpr float kMaxDt = 0.25f;

/// Travel speed at zero drive, as a fraction of the full-drive speed. NOT zero:
/// a glint must always reach the boundary and die, and letting go of the knob
/// should not park one in the middle of the picture forever.
constexpr float kIdleSpeed = 0.30f;

/// Minimum separation, in travel units (0 = birth edge, 1 = death edge), between
/// an arrival and the youngest glint already in flight. Poisson arrivals will
/// happily put two on top of each other, and two overlapping glints read as one
/// fat one — which is exactly the thing these stopped being a pattern to avoid.
constexpr float kMinGap = 0.08f;

/// The spread of per-glint widths drawn at birth, as multiples of the effect's
/// base width. The effect needs the TOP of this range to size the margins that
/// hide a glint's entry and its wake's exit — and those margins have to be the
/// same for every glint, or `pos` would map to a different place on screen for
/// each of them and two could cross.
constexpr float kMinWidthFactor = 0.60f;
constexpr float kMaxWidthFactor = 1.40f;

/// Read fresh each tick. `drive` is the rig's Glint rail; the other two are
/// style knobs on the effect.
struct Params {
  float drive = 0.0f;     ///< 0..1. Spawns and speed only — never a live glint's look.
  float density = 5.0f;   ///< arrivals per second at full drive
  float speed = 1.2f;     ///< crossings per second at full drive
};

/// One glint in flight. The three look values are drawn at birth and never
/// touched again — that is what "under its own power" means here.
struct Glint {
  float pos = 0.0f;    ///< 0 at the birth boundary, 1 at the death boundary
  float gain = 0.0f;   ///< brightness factor
  float width = 1.0f;  ///< width factor
  float shade = 0.0f;  ///< depth of the dark wake behind it
  bool live = false;
};

struct Core {
  Glint glints[kMaxLive];
  /// Countdown to the next arrival, in EXPECTED arrivals rather than seconds —
  /// so a drive that changes mid-wait re-times the arrival correctly instead of
  /// honouring a deadline set under the old rate. Starts at 0, so the first
  /// tick with any drive at all throws a glint immediately.
  float spawn_c = 0.0f;
  unsigned rng = 0x2545f491u;

  void reset() { *this = Core(); }

  /// How many are in flight. For the goldens and for the effect's uniform fill.
  int liveCount() const {
    int n = 0;
    for (int i = 0; i < kMaxLive; ++i) if (glints[i].live) ++n;
    return n;
  }

  void tick(const Params& p, float dt) {
    if (dt < 0.0f) dt = 0.0f;
    if (dt > kMaxDt) dt = kMaxDt;
    const float drive = p.drive < 0.0f ? 0.0f : (p.drive > 1.0f ? 1.0f : p.drive);

    // --- Travel. One speed for everyone, which is what keeps the order they
    //     were born in — and therefore their separation — intact forever.
    const float v = p.speed * (kIdleSpeed + (1.0f - kIdleSpeed) * drive);
    for (int i = 0; i < kMaxLive; ++i) {
      Glint& g = glints[i];
      if (!g.live) continue;
      g.pos += v * dt;
      if (g.pos > 1.0f) g = Glint();   // reached the boundary: gone
    }

    // --- Arrivals. Exponentially spaced: independent events, not a metronome.
    const float rate = p.density * drive;
    if (rate > 0.0f && dt > 0.0f) {
      spawn_c -= rate * dt;
      // A long frame can owe more than one arrival; pay them all, so a stall
      // does not silently swallow glints.
      for (int guard = 0; spawn_c <= 0.0f && guard < kMaxLive * 2; ++guard) {
        spawn();
        float u = rand01();
        if (u < 1e-6f) u = 1e-6f;
        spawn_c += -std::log(u);   // mean 1, so `rate` really is per second
      }
      if (spawn_c <= 0.0f) spawn_c = 1e-3f;
    }
  }

 private:
  /// xorshift32 — deterministic given the same dt sequence, which is what lets
  /// a golden pin any of this at all.
  float rand01() {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return (float)(rng & 0xFFFFFFu) * (1.0f / 16777216.0f);
  }

  void spawn() {
    // Not on top of the youngest one. Poisson arrivals cluster by nature, and a
    // cluster is indistinguishable from a single wide glint.
    for (int i = 0; i < kMaxLive; ++i)
      if (glints[i].live && glints[i].pos < kMinGap) return;

    for (int i = 0; i < kMaxLive; ++i) {
      Glint& g = glints[i];
      if (g.live) continue;
      g.live = true;
      g.pos = 0.0f;
      // Drawn once, kept for life. The spread is what stops a stream of them
      // reading as one repeated stamp.
      g.gain = 0.45f + 0.55f * rand01();
      g.width = kMinWidthFactor + (kMaxWidthFactor - kMinWidthFactor) * rand01();
      g.shade = 0.40f + 0.60f * rand01();
      return;
    }
    // Every slot busy: the arrival is DROPPED rather than evicting someone.
    // Stealing a live slot would make a glint vanish in mid-flight, which is
    // the one thing a particle here is not allowed to do.
  }
};

}  // namespace three_planes_glints
