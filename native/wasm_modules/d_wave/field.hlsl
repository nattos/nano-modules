// warp.legacy.d_wave — D-wave field update (polar ripple buffer).
//
// The "D wave" is a persistent 2D strength buffer indexed by (angle, radius):
//   X (column) = angle around the centre,  Y (row) = radius from the centre.
// Ripples are stochastically spawned at the centre (row ≈ 0), march OUTWARD in
// radius over time, and decay in amplitude as they travel. The warp pass reads
// this buffer in polar space to radially distort the input — concentric
// expanding distortion rings. This is the ported core of the shipped NanoGraph
// Darkburst's distortion field (the only block the team actually used live).
//
// One pass per frame: ping-pong. `prevField` is last frame's buffer; we write
// the propagated + freshly-spawned buffer into `curField` (RGBA16F, .r only).
// All timing is dt-accumulated (style guide §2.1): the caller bakes dt into
// y_shift / decay / spawn_prob so the look is frame-rate independent.

Texture2D<float4>   prevField : register(t0);
SamplerState        samp      : register(s1);   // Linear + Repeat (angle wraps)
RWTexture2D<float4> curField  : register(u2);

cbuffer Uniforms : register(b3) {
  float y_shift;     // normalized rows the field marches outward this frame
  float decay;       // per-frame amplitude multiplier (≤ 1)
  float spawn_prob;  // P(a sector emits a ripple) this frame (Poisson)
  float sharp;       // gaussian radial sharpness of a fresh ring

  float sectors;     // number of angular spawn sectors (ripple arcs)
  float spawn_amp;   // amplitude of a fresh ripple
  float burst;       // forced full-circle emission (trigger), 0 normally
  uint  frame;       // frame index → decorrelates the per-frame spawn hash
}

static const float DW_PI = 3.14159265358979323846;

uint dw_hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float dw_unit(uint h) { return (h >> 8) * (1.0 / 16777216.0); }

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  curField.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  // Propagate: row y is fed from row (y - y_shift) of the previous frame, so
  // content moves toward larger radius (outward). Clamp the source row into
  // [0,1] so the Repeat sampler (needed for the angle wrap in the warp pass)
  // doesn't wrap the radius axis. X is unshifted, so its addressing is moot.
  float ySrc = clamp(uv.y - y_shift, 0.0, 1.0);
  float prev = prevField.SampleLevel(samp, float2(uv.x, ySrc), 0).r;
  float val = prev * decay;

  // Spawn: divide the circle into `sectors` arcs; each arc fires a fresh ripple
  // with probability spawn_prob this frame. A Hann window across the arc fades
  // its angular ends so it reads as an arc/blob, not a hard-edged sector. The
  // ripple is a gaussian centred at the middle (row 0) so it's born small and
  // marches out over subsequent frames.
  float ang = uv.x * sectors;
  float sec = floor(ang);
  float win = sin((ang - sec) * DW_PI);              // 0 at sector edges
  uint  h   = dw_hash((uint)sec * 0x9E3779B1u ^ (frame * 0x85EBCA77u));
  float fire = (dw_unit(h) < spawn_prob) ? 1.0 : 0.0;
  float ring = exp(-sharp * uv.y * uv.y);

  // burst (trigger) lights every sector at once — a full-circle shock ripple.
  val += spawn_amp * ring * (fire * win + burst);

  curField[gid.xy] = float4(val, 0.0, 0.0, 0.0);
}
