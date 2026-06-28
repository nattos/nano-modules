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
  float rate;        // noise density: fraction of angular cells that inject
  float sharp;       // gaussian radial thickness of the freshly injected band

  float ang_cells;   // grain frequency: noise cells around the circle
  float spawn_amp;   // amplitude of the injected noise
  float burst;       // forced full-strength ring emission (trigger), 0 normally
  uint  frame;       // frame index → fresh noise every frame
}

static const float DW_NOISE_POWER = 2.0;   // grain contrast / sparsity

uint dw_hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float dw_unit(uint h) { return (h >> 8) * (1.0 / 16777216.0); }

// C1 wrapping value-noise band around the circle: `cells` integer cells, hashed
// per cell with `seed`, smoothstep-interpolated. Continuous across the angle
// seam (cell index wraps mod n) so there's no discontinuity at angle 0/2π.
float dw_noise01(float a01, float cells, uint seed) {
  float n = max(cells, 1.0);
  float a = a01 * n;
  uint  i0 = (uint)floor(a) % (uint)n;
  uint  i1 = (i0 + 1u) % (uint)n;
  float f  = frac(a);
  float h0 = dw_unit(dw_hash(i0 * 0x85EBCA77u ^ seed));
  float h1 = dw_unit(dw_hash(i1 * 0x85EBCA77u ^ seed));
  return lerp(h0, h1, f * f * (3.0 - 2.0 * f));
}

// The D-wave's turbulent grain: a fresh value-noise band around the circle
// (frequency `cells`) is generated EVERY frame; `rate` thresholds it so only
// the brightest fraction of angles inject (sparse grain), and a power curve
// sets the contrast. Independent per-frame noise injected at the centre then
// advects outward → radial turbulent streaks (the original's per-frame random
// array, FillArray Source:Random). No fixed angular structure → no valleys.
float dw_inject(float a01, float cells, uint frame, float rate) {
  float r   = dw_noise01(a01, cells, dw_hash(frame * 0x9E3779B1u));
  float thr = 1.0 - rate;
  float n   = saturate((r - thr) / max(rate, 1e-3));
  return pow(n, DW_NOISE_POWER);
}

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

  // Inject fresh per-angle noise into the centre band (row ≈ 0). The band is a
  // gaussian in radius (thickness from `sharp`) so each frame's noise is born
  // tight at the centre and marches outward over subsequent frames, leaving
  // turbulent radial streaks. burst (trigger) forces a full coherent ring.
  float inj  = dw_inject(uv.x, ang_cells, frame, rate);
  float ring = exp(-sharp * uv.y * uv.y);
  val += spawn_amp * ring * saturate(inj + burst);

  curField[gid.xy] = float4(val, 0.0, 0.0, 0.0);
}
