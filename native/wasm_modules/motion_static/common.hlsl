// debug.motion_static — shared math for color + motion passes.
//
// Both passes need to compute the per-pixel velocity. Defining it
// once in this header keeps the two shaders byte-for-byte consistent
// — any drift between the colour visualization and the actual motion
// vectors written for downstream consumers would be invisible at a
// glance and a nightmare to debug. Keep the math here, not in the
// individual shader files.

#ifndef MOTION_STATIC_COMMON_HLSL
#define MOTION_STATIC_COMMON_HLSL

// PCG-style integer hash. Bit-mix of `x` to a uniformly distributed
// uint. Bit-exact across all coordinate ranges — no float-precision
// artifacts (the previous frac-sin hash banded heavily on large
// viewports because `p.x * 123.34` runs out of mantissa precision
// past x ≈ 2^17, producing periodic stripes in the fractional part).
uint ms_pcg_hash(uint x) {
  x = x * 747796405u + 2891336453u;
  uint word = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (word >> 22u) ^ word;
}

// Pixel hash → uniform random in [0, 1]. Seeds the noise field; same
// seed reproduces the exact same pattern. Distinct integer-pixel
// coordinates produce wildly different values, so adjacent pixels
// have uncorrelated noise (no Perlin-style smoothness).
float ms_hash(uint2 p, uint seed) {
  uint h = ms_pcg_hash(p.x + ms_pcg_hash(p.y + ms_pcg_hash(seed)));
  // Divide by 2^32 to land in [0, 1).
  return float(h) * (1.0 / 4294967296.0);
}

// Compute per-pixel velocity in uv-space.
//
//   gid          : integer pixel coordinate
//   vp_size      : viewport in pixels
//   threshold    : noise cutoff [0, 1] — only pixels with noise above
//                  this value receive non-zero velocity
//   swirl        : magnitude scale (uv per frame at noise=1.0)
//   jitter_amt   : direction perturbation [0, 1]
//   seed         : pattern seed
float2 ms_motion_at(uint2 gid, float2 vp_size,
                    float threshold, float swirl,
                    float jitter_amt, float seed) {
  // Convert the float seed (a small int packed into a float by the
  // host) to uint. PCG mixes it with the pixel coords so seed-only
  // changes shift the entire pattern.
  uint useed = uint(seed);
  float n = ms_hash(gid, useed);
  if (n <= threshold) return float2(0.0, 0.0);

  // Magnitude: scale how-much-above-threshold by swirl. Pixels just
  // above the cutoff move slowly; pixels at noise=1 move at the full
  // configured swirl magnitude.
  float magnitude = (n - threshold) / max(1.0 - threshold, 1e-3) * swirl;

  // Concentric tangent direction. d points from center; rotate 90°
  // for the tangent. At the exact center we'd divide by zero, so
  // fall back to +x (the choice doesn't matter — at the center the
  // velocity gets multiplied by zero radial scale anyway in any
  // sensible interpretation; we just need to avoid NaNs).
  float2 uv = (float2(gid) + 0.5) / vp_size;
  float2 d = uv - 0.5;
  float2 tangent = float2(-d.y, d.x);
  float t_len = length(tangent);
  if (t_len < 1e-4) tangent = float2(1.0, 0.0);
  else              tangent = tangent / t_len;

  // Per-pixel direction jitter. Each pixel gets a unique perturbation
  // so even at low jitter the field has a touch of chaos. Re-normalise
  // so jitter doesn't change the magnitude. Seed offsets are arbitrary
  // primes that decorrelate the jitter draws from the threshold draw.
  float jx = ms_hash(gid, useed + 0x9E3779B1u) - 0.5;
  float jy = ms_hash(gid, useed + 0x85EBCA77u) - 0.5;
  tangent = tangent + float2(jx, jy) * jitter_amt;
  float final_len = length(tangent);
  if (final_len > 1e-4) tangent = tangent / final_len;

  return tangent * magnitude;
}

// HSV → RGB. Standard conversion, no surprises. h/s/v in [0, 1].
float3 ms_hsv_to_rgb(float h, float s, float v) {
  float h6 = h * 6.0;
  float c = v * s;
  float x = c * (1.0 - abs(fmod(h6, 2.0) - 1.0));
  float m = v - c;
  float3 rgb;
  if      (h6 < 1.0) rgb = float3(c, x, 0);
  else if (h6 < 2.0) rgb = float3(x, c, 0);
  else if (h6 < 3.0) rgb = float3(0, c, x);
  else if (h6 < 4.0) rgb = float3(0, x, c);
  else if (h6 < 5.0) rgb = float3(x, 0, c);
  else               rgb = float3(c, 0, x);
  return rgb + m;
}

// Visualize a motion vector as colour. HSV polar:
//   hue = atan2(v.y, v.x) mapped to [0, 1] — encodes direction
//   sat = 1
//   val = saturate(|v| * scale) — brightness encodes magnitude
// `vis_scale` is a UI-friendly knob: at swirl=0.01 (default), |v| is
// up to 0.01, so vis_scale=100 maps full magnitude to value=1.
float3 ms_motion_to_color(float2 v, float vis_scale) {
  float vlen = length(v);
  float angle = atan2(v.y, v.x);
  float hue = angle / 6.2832 + 0.5;  // -π..π → 0..1
  float val = saturate(vlen * vis_scale);
  return ms_hsv_to_rgb(hue, 1.0, val);
}

#endif
