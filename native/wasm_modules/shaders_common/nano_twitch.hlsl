// nano_twitch.hlsl — roaming "twitch" vignette mask.
//
// A mask anchored at an arbitrary (per-frame random) point: given cover-square
// coords `sq`, an `anchor`, a radius/softness falloff, a bipolar `shape` and an
// overall `strength` in [0, 1], returns a [0, 1] multiplier (1 = unaffected).
//
// `shape` is bipolar. Its SIGN sets polarity (+ suppresses the far/rim side,
// − the near/centre side); its MAGNITUDE morphs the pattern continuously, so
// there's no dead zone at shape ≈ 0:
//   |shape| = 1   radial vignette (a disk around the anchor)
//   |shape| = 0.5 linear gradient oriented along the anchor→centre axis
//   |shape| = 0   solid (uniform suppression — a full flash, not a no-op)
// The visible amount is `strength` alone (not scaled by |shape|).
//
// The CPU side picks the per-frame anchor + strength — see
// include/effect_twitch_mask.h (fx::TwitchMask). Used by video.twitch_mask and
// video.local_delay's spatial mask.

#ifndef NANO_TWITCH_HLSL
#define NANO_TWITCH_HLSL

float nano_twitch_mask(float2 sq, float2 anchor, float radius, float softness,
                       float shape, float strength) {
  float soft = max(softness, 1e-4);
  float2 rel = sq - anchor;

  // Radial selector: 0 near the anchor → 1 far from it (iso-lines = circles).
  float t = smoothstep(radius, radius + soft, length(rel));

  // Linear selector: a ramp along the centre↔anchor axis, measured from the
  // CENTRE (cover-square origin) so it stays put as the anchor roams. The far-
  // from-anchor side darkens (1, matching the radial polarity at the seam); the
  // centre + anchor side stay transparent. The 0.5 crossing sits OUT along the
  // far side at distance (radius + 0.15) — a small baseline outward bias keeps
  // the centre clear, and bigger radius pushes the dark further out still.
  // So the centre reads ~0. `softness` sets the ramp
  // width — a hard step at 0 → a gently tilted slope at 1. Falls back to a
  // fixed axis when the anchor sits at the centre.
  float2 n = (dot(anchor, anchor) > 1e-8) ? normalize(anchor) : float2(0.0, 1.0);
  float u   = dot(sq, n);                  // signed distance from centre along the axis
  float mid = -(radius + 0.15);            // 0.5 crossing pushed out the far side (+bias)
  float wid = 0.15 + softness * 0.85;      // ramp half-width (tilt)
  float lin = saturate(0.5 - (u - mid) / (2.0 * wid));

  // Polarity from the sign; the three pattern targets blended by |shape|.
  float s_radial = (shape >= 0.0) ? t   : (1.0 - t);
  float s_linear = (shape >= 0.0) ? lin : (1.0 - lin);
  float s_solid  = 1.0;

  // |shape| morphs the pattern. The solid only fades in VERY close to 0 (over
  // [0, 0.12]) so it doesn't bleed into the linear regime; linear holds across
  // the lower-mid range; the upper half (>0.5) morphs linear → radial.
  float a = abs(shape);
  float suppress = lerp(s_solid, s_linear, saturate(a / 0.12));      // solid → linear (near 0)
  suppress = lerp(suppress, s_radial, saturate((a - 0.5) * 2.0));    // linear → radial (upper half)

  return lerp(1.0, 1.0 - suppress, saturate(strength));
}

#endif // NANO_TWITCH_HLSL
