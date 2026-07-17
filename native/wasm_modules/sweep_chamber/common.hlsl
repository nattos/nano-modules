// source.particles.sweep_chamber — shared helpers + GPU-resident layouts.
//
// Successor to source.legacy.double_chamber, modeled on flow_swarm's
// structure. The sim couples three layers through ONE coarse field texture
// pair (built per frame from the swept input): a particle pool, streamline
// tracers ("lines"), and a global calm↔intense response derived from the
// swept image itself. Every consumer of the field takes bilinear taps at
// FIELD_RES — no full-res convolutions anywhere in the sim.
//
// Spaces (flow_swarm conventions):
//   pos      — screen uv. vel — uv/s.
//   iso      — screen-isotropic vector space (1 unit = min(W,H) px). Directions
//              and gradients live here so circles stay round on any aspect;
//              convert to uv displacement by multiplying by aspect=(min/W,min/H).
//   s-space  — centred iso position: s = (uv - 0.5) / aspect.

#ifndef SWEEP_CHAMBER_COMMON_HLSL
#define SWEEP_CHAMBER_COMMON_HLSL

// ---- PCG bit-mix integer hash ----
uint swc_hash(uint x) {
  x = x * 747796405u + 2891336453u;
  uint word = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (word >> 22u) ^ word;
}
uint swc_hash2(uint a, uint b) { return swc_hash(a + swc_hash(b)); }
uint swc_hash3(uint a, uint b, uint c) { return swc_hash(a + swc_hash(b + swc_hash(c))); }
float swc_unit(uint h)   { return float(h) * (1.0 / 4294967296.0); }   // [0,1)
float swc_signed(uint h) { return swc_unit(h) * 2.0 - 1.0; }            // [-1,1)

// ---- captured color + per-particle "z phase" packed into one float slot ----
// (z drives the per-particle image-curl factor; only ever bit-reinterpreted.)
uint swc_pack_rgbz(float3 c, float z) {
  uint r  = (uint)(saturate(c.r) * 255.0 + 0.5);
  uint g  = (uint)(saturate(c.g) * 255.0 + 0.5);
  uint b  = (uint)(saturate(c.b) * 255.0 + 0.5);
  uint zz = (uint)(saturate(z)   * 255.0 + 0.5);
  return r | (g << 8u) | (b << 16u) | (zz << 24u);
}
float3 swc_unpack_rgb(uint p) {
  return float3(float(p & 0xFFu), float((p >> 8u) & 0xFFu),
                float((p >> 16u) & 0xFFu)) * (1.0 / 255.0);
}
float swc_unpack_z(uint p) { return float((p >> 24u) & 0xFFu) * (1.0 / 255.0); }

// ---- luma metric (double_chamber parity) + 90° perp ----
float swc_lum(float3 c) { return max(c.r, max(c.g, c.b)); }
float2 swc_perp(float2 v) { return float2(v.y, -v.x); }

// ---- HSV → RGB (flow-direction tint) ----
float3 swc_hsv_to_rgb(float3 hsv) {
  float h = frac(hsv.x);
  float s = saturate(hsv.y);
  float v = saturate(hsv.z);
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

// ---- point shape mask (particle-local corner ∈ [-1,1]²) ----
//   0 point · 1 gaussian · 2 circle/squircle · 3 solid
float swc_mask(float2 n, uint kind, float param) {
  if (kind == 1u) {
    float sigma = lerp(0.25, 0.85, saturate(param));
    float r2 = dot(n, n);
    float g = exp(-r2 / (sigma * sigma));
    float window = smoothstep(1.0, 0.85, sqrt(r2));
    return g * window;
  }
  if (kind == 2u) {
    float k = lerp(2.0, 8.0, saturate(param));
    float v = pow(abs(n.x), k) + pow(abs(n.y), k);
    float r = pow(max(v, 1e-8), 1.0 / k);
    return smoothstep(1.0, 0.92, r);
  }
  return 1.0;
}

// ===========================================================
// Sweep window — the built-in luma band-pass. Smooth trapezoid, C1
// everywhere. The center slider ∈ [0,1] is remapped so 0 and 1 always mean
// "window fully off either end of the luma range" regardless of width and
// softness: at both extremes the swept luma L' ≡ 0 everywhere → the whole
// image reads as black and the sim free-flows on the noise field alone.
// (This is the fix for the old effect's pure-white/pure-black endpoint
// pathologies — no external pre-processing sweep required.)
// ===========================================================
float swc_sweep(float luma, float center01, float width, float softness) {
  float hw   = width * 0.5;
  float soft = max(lerp(0.01, 0.5, saturate(softness)), 1e-3);
  float lo   = -(hw + soft) - 0.001;   // center here → window ≡ 0 below black
  float hi   = 1.0 + (hw + soft) + 0.001;   // → window ≡ 0 above white
  float c    = lerp(lo, hi, saturate(center01));
  return smoothstep(c - hw - soft, c - hw, luma)
       * (1.0 - smoothstep(c + hw, c + hw + soft, luma));
}

// ===========================================================
// 2D gradient (Perlin) noise, quintic fade, ANALYTIC derivative — C2 in
// space so the velocity derived from it is C1: no seams, no kinks (the old
// dc_field's sign()/abs()/pow() discontinuities are exactly what this
// replaces). Corner gradients rotate over time at per-corner rates
// (Perlin–Neyret flow noise) so eddies churn smoothly.
// Returns ∇ψ of the scalar noise ψ at p.
// ===========================================================
float2 swc_gnoise_grad(float2 p, float t, uint oseed) {
  float2 fl = floor(p);
  int2   ii = int2(fl);
  float2 f  = p - fl;
  float2 g[4];
  [unroll] for (int k = 0; k < 4; k++) {
    int2 c = int2(k & 1, k >> 1);
    uint hh = swc_hash3(uint(ii.x + c.x), uint(ii.y + c.y), oseed);
    float a0   = swc_unit(hh) * 6.2831853;
    float spin = 0.5 + swc_unit(swc_hash(hh ^ 0x9E3779B1u));   // per-eddy churn rate
    float a    = a0 + t * spin;                                 // t pre-scaled by caller
    g[k] = float2(cos(a), sin(a));
  }
  float n00 = dot(g[0], f);
  float n10 = dot(g[1], f - float2(1, 0));
  float n01 = dot(g[2], f - float2(0, 1));
  float n11 = dot(g[3], f - float2(1, 1));
  float2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);        // quintic (C2)
  float2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float k1 = n10 - n00, k2 = n01 - n00, k4 = n00 - n10 - n01 + n11;
  float2 gi = g[0] + u.x * (g[1] - g[0]) + u.y * (g[2] - g[0])
            + u.x * u.y * (g[0] - g[1] - g[2] + g[3]);
  return gi + du * float2(k1 + k4 * u.y, k2 + k4 * u.x);        // analytic ∇ψ
}

// ===========================================================
// Field texture channel contract (both FIELD_RES², RGBA16F):
//   field_a: .r = mean swept luma L' over the cell   (smooth scalar, gradient src)
//            .gb = intra-cell offset to the luma peak (texel units, |off| ≤ 0.5;
//                  a sharpened L'^4-weighted centroid — continuous, unlike argmax)
//            .a = MAX swept luma over the cell        (ridge detector: stays high
//                  on a crest where the gradient vanishes)
//   field_b: .rg = curl-noise background velocity    (uv/s)
//            .ba = image gradient G = ∇L'·GAIN·edgeFade, in ISO space
//                  (to_image / to_image_curl are composed per-consumer so the
//                  per-particle z-phase curl factor survives a single tap)
// A consumer composes, given its own curl factor cf:
//   vel_uv = fb.rg + (fb.ba·to_image + perp(fb.ba)·to_image_curl·cf) · aspect
// ===========================================================

// ---- particle layout — 2 vec4 = 32 bytes ----
//   a.xy = pos (screen uv), a.z = life_remain (s), a.w = life_total (s)
//   b.xy = velocity (uv/s), b.z = size (isotropic uv), b.w = asfloat(packed rgbz)
struct Particle { float4 a; float4 b; };

// ---- tracers ("lines"): field streamline tracers with grip + ballistics ----
//   a.xy = seed pos (uv), a.z = life/time, a.w = seed angle
//   b.xy = seed velocity (uv/s — ballistic momentum, inherits the fling)
//   b.z  = grip ∈ [0,1] (EMA of trace-mean L'max: how hard the image holds it)
//   b.w  = curvature κ (signed, rad per iso-unit of path; rolled at reseed —
//          the free-space "ballistic arc" bend)
struct TracerState { float4 a; float4 b; };
//   Seg.a = (p0.xy, p1.xy) in uv;  Seg.b = (rgb, alpha·weight)
struct Seg { float4 a; float4 b; };

// ---- VS → FS varyings ----
struct VsOut {
  float4 pos     : SV_Position;
  float2 corner  : TEXCOORD0;                       // quad-local [-1,1]²
  nointerpolation float4 col_life : TEXCOORD1;      // rgb = captured color, w = life_norm
  nointerpolation float4 vel      : TEXCOORD2;      // xy = velocity, z = speed, w = unused
};

struct LineVsOut {
  float4 pos    : SV_Position;
  float2 local  : TEXCOORD0;   // .x along [0,1], .y across [-1,1]
  nointerpolation float4 col : TEXCOORD1;
};

#endif // SWEEP_CHAMBER_COMMON_HLSL
