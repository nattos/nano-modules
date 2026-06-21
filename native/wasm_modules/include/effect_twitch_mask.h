#pragma once
/*
 * effect_twitch_mask.h — roaming "twitch" vignette mask (CPU side).
 *
 * Each frame, picks a random anchor + intensity from the performer params; the
 * GPU then applies nano_twitch_mask() (shaders_common/nano_twitch.hlsl) with the
 * resulting anchor/strength to suppress a roaming oval region. Extracted from
 * motion.local_delay; also drives the standalone filter.glitch.twitch_mask effect.
 *
 * Param semantics:
 *   amount    0 = off; modulation depth into the mask. 0..0.5 ramps depth
 *             (the old 0..1 amount × a uniform random weight); 0.5..1 holds
 *             depth at full and BOOSTS the random weight, skewing each frame's
 *             intensity toward 1.0 (cuts harder, more often).
 *   shape     -1..1 bipolar. Sign sets polarity (+ blacks the rim/outside,
 *             - the centre/inside); magnitude morphs the pattern (no dead zone
 *             at 0): |1| radial vignette → |0.5| linear gradient toward the
 *             centre → |0| solid (uniform). See nano_twitch_mask().
 *   radius    0..1 cover-square radius of the oval.
 *   softness  0..1 falloff width.
 *   position  -1 → spawn on an outer ring, +1 → spawn near the centre. The whole
 *             spawn range scales out with `radius`, so a big twitch roams further.
 *
 * Header-only; owns a per-instance PRNG (LCG). Seed it once (seed()) for a
 * distinct sequence per instance; otherwise every instance shares one default.
 *
 * Usage:
 *   #include <effect_twitch_mask.h>
 *   fx::TwitchMask s_twitch;                 // optionally s_twitch.seed(id)
 *
 *   // per frame:
 *   auto f = s_twitch.update({amount, shape, radius, softness, position});
 *   // pack f.anchor_x, f.anchor_y, f.strength (+ shape, radius, softness) into
 *   // the uniform; the shader calls nano_twitch_mask(...).
 */

#include <cmath>
#include <cstdint>

namespace fx {

class TwitchMask {
public:
  struct Params {
    float amount;
    float shape;
    float radius;
    float softness;
    float position;
  };
  struct Frame {
    float anchor_x;
    float anchor_y;
    float strength;   // amount × this frame's random intensity, in [0, 1]
  };

  /// Distinct PRNG seed (e.g. a per-instance counter). 0 falls back to default.
  void seed(uint32_t s) { rng_ = s ? s : 0x2545F491u; }

  /// Advance one frame. Returns this frame's anchor + strength. amount <= 0
  /// returns a zero frame and leaves the PRNG untouched (no draw).
  Frame update(const Params& p) {
    Frame f{0.0f, 0.0f, 0.0f};
    if (p.amount <= 0.0f) return f;

    // Random anchor: an oval whose ring radius is biased by `position` and
    // scaled out by `radius`. Cover-square coords (isotropic → oval via aspect).
    float ang  = unit() * 2.0f * kPi;
    float base = 0.5f * (1.0f - p.position);          // +1 → 0 (centre), -1 → 1 (rim)
    float rr   = base + (unit() - 0.5f) * 0.6f;       // bias toward base, soft spread
    if (rr < 0.0f) rr = 0.0f;
    rr *= 1.0f + p.radius;                            // bigger twitch roams further out
    f.anchor_x = rr * std::cos(ang);
    f.anchor_y = rr * std::sin(ang);

    // amount remap: 0..0.5 ramps depth; 0.5..1 boosts the random weight.
    float depth = fminf(p.amount * 2.0f, 1.0f);
    float over  = fmaxf(p.amount - 0.5f, 0.0f) * 2.0f;  // 0..1 over the top half
    float boost = 1.0f + over * over * 15.0f;           // quadratic ramp, 1 → 16 at amount=1
    float intensity = fminf(unit() * boost, 1.0f);
    f.strength = depth * intensity;
    return f;
  }

private:
  static constexpr float kPi = 3.14159265358979f;
  uint32_t rng_ = 0x2545F491u;

  // Per-instance uniform random in [0, 1) (LCG).
  float unit() {
    rng_ = rng_ * 1664525u + 1013904223u;
    return (float)((rng_ >> 8) & 0xFFFFFFu) / (float)0x1000000;
  }
};

} // namespace fx
