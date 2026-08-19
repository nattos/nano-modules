// source.mesh.three_planes — the whole effect, in one fullscreen compute pass.
//
// The CPU has already projected three isometric quads into cover-square
// screen coords and handed us 12 corner points. Per pixel we:
//
//   1. take the EXACT signed distance to each quad's outline (4 segments,
//      always a convex parallelogram under azimuth orbit, so the SDF is
//      exact and the halo is a smooth function of true distance — corners
//      round correctly instead of throwing miter spikes);
//   2. turn that into a line core, a stacked-exponential halo, and an
//      antialiased interior coverage;
//   3. resolve all three planes bottom-to-top in ONE expression, so a
//      masking plane can occlude the halos beneath it while still emitting
//      its own (see `resolve` below — this is the whole reason the effect
//      is a fullscreen pass rather than three additive draws);
//   4. grade the composite through the shared VCR stack.
//
// Nothing here needs an intermediate texture: the accumulator lives in
// registers at float precision and is tone-mapped exactly once, on write.

#include "nano_coords.hlsl"
#include "nano_vcr.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  // Projected corners, cover-square coords. Plane i occupies rows 2i and
  // 2i+1: (c0.xy, c1.zw) then (c2.xy, c3.zw), wound consistently.
  float4 corners[6];

  // rgb = plane colour, w = emission drive (already curved by the host).
  float4 plane_color[3];

  float4 fills;       // xyz = signed fill per plane (+neon / -mask), w unused
  float4 neon0;       // line half-width, line gain, core whiten, halo radius
  float4 neon1;       // halo gain, halo falloff, corner radius, aa width
  float4 misc;        // fill gain, chroma bleed, has_input, debug mode
  float4 view;        // vp_w, vp_h, aspect_x, aspect_y

  VcrGrade grade;
};

// --- Exact signed distance to a convex quad -------------------------------
// iq's polygon SDF, unrolled to four explicit edges (no local arrays, so the
// SPIR-V -> WGSL/MSL translation stays trivially portable). Even-odd crossing
// gives the sign; the per-edge point-segment distance gives the magnitude.

void sd_edge(float2 p, float2 a, float2 b, inout float d2, inout float s) {
  float2 e = b - a;
  float2 w = p - a;
  float2 q = w - e * saturate(dot(w, e) / max(dot(e, e), 1e-12));
  d2 = min(d2, dot(q, q));
  bool3 c = bool3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
  if (all(c) || all(!c)) s = -s;
}

float sd_quad(float2 p, float2 a, float2 b, float2 c, float2 d) {
  float d2 = dot(p - a, p - a);
  float s = 1.0;
  sd_edge(p, a, b, d2, s);
  sd_edge(p, b, c, d2, s);
  sd_edge(p, c, d, d2, s);
  sd_edge(p, d, a, d2, s);
  return s * sqrt(d2);
}

// Stacked exponentials at 0.25x / 1x / 4x the radius. A single Gaussian reads
// flat and synthetic; three octaves is what makes it read as glow. Weights sum
// to 1 at distance 0, so `halo_gain` stays the only intensity control.
// `falloff` 0 = tight and punchy, 1 = wide and soft.
float halo_profile(float ad, float r, float falloff) {
  float r0 = max(r, 1e-4);
  float w = saturate(falloff);
  float3 e = float3(exp(-ad / (r0 * 0.25)),
                    exp(-ad / (r0 * 1.00)),
                    exp(-ad / (r0 * 4.00)));
  float3 wts = lerp(float3(0.60, 0.30, 0.10), float3(0.15, 0.30, 0.55), w);
  return dot(e, wts);
}

float2 corner_of(int i, int k) {
  float4 row = corners[i * 2 + (k >> 1)];
  return (k & 1) ? row.zw : row.xy;
}

// --- The resolve ----------------------------------------------------------
// Bottom-to-top, explicitly ordered. `acc *= (1 - A)` is what lets a black
// plane eat the glow of everything beneath it; `acc += E` immediately after is
// what keeps its OWN outline and halo alive over that black. Fixed-function
// blend cannot express both in one draw — this loop is the effect.
float3 resolve(float2 p, float3 base) {
  float line_hw     = neon0.x;
  float line_gain   = neon0.y;
  float core_whiten = neon0.z;
  float halo_r      = neon0.w;
  float halo_gain   = neon1.x;
  float falloff     = neon1.y;
  float corner_r    = neon1.z;
  float aa          = max(neon1.w, 1e-6);
  float fill_gain   = misc.x;

  float3 acc = base;

  [unroll]
  for (int i = 0; i < 3; i++) {
    float d = sd_quad(p, corner_of(i, 0), corner_of(i, 1),
                         corner_of(i, 2), corner_of(i, 3)) - corner_r;
    float ad = abs(d);

    float inside = saturate(0.5 - d / aa);
    float core   = 1.0 - smoothstep(line_hw - aa, line_hw + aa, ad);
    float halo   = halo_profile(ad, halo_r, falloff);

    float3 col  = plane_color[i].rgb;
    float  emis = plane_color[i].w;
    float  fill = fills[i];

    // Real neon photographs blow their core to white and keep the hue only
    // out in the halo. This is the knob that makes it read as neon at all.
    float3 tint = lerp(col, float3(1.0, 1.0, 1.0), saturate(core_whiten * core));

    float3 E = emis * tint * (core * line_gain
                            + halo * halo_gain
                            + max(fill, 0.0) * inside * fill_gain);
    float  A = -min(fill, 0.0) * inside;

    acc = acc * (1.0 - A) + E;
  }
  return acc;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 vp     = view.xy;
  float2 aspect = view.zw;
  float2 uv     = nano_pixel_to_uv(float2(gid.xy), vp);
  float2 p      = nano_uv_to_cover_square(uv, aspect);

  float4 src   = inputTex.Load(int3(int(gid.x), int(gid.y), 0));
  float  in_op = misc.z;
  float3 base  = src.rgb * in_op;

  int debug_mode = int(misc.w + 0.5);
  if (debug_mode == 1) {
    // Raw distance field of the nearest plane, banded so the morphology of
    // the corners is legible.
    float d = 1e9;
    [unroll]
    for (int i = 0; i < 3; i++) {
      d = min(d, abs(sd_quad(p, corner_of(i, 0), corner_of(i, 1),
                                corner_of(i, 2), corner_of(i, 3)) - neon1.z));
    }
    float bands = frac(d * 20.0);
    outputTex[gid.xy] = float4(bands.xxx * saturate(1.0 - d * 2.0), 1.0);
    return;
  }
  if (debug_mode == 2) {
    // Flat per-plane fill, no glow and no grade — checks the projection and
    // the stacking order on their own.
    float3 flat_c = base * 0.15;
    [unroll]
    for (int i = 0; i < 3; i++) {
      float d = sd_quad(p, corner_of(i, 0), corner_of(i, 1),
                           corner_of(i, 2), corner_of(i, 3));
      float ins = saturate(0.5 - d / max(neon1.w, 1e-6));
      float3 key = float3(i == 0 ? 1.0 : 0.0, i == 1 ? 1.0 : 0.0, i == 2 ? 1.0 : 0.0);
      flat_c = lerp(flat_c, key, ins * 0.75);
    }
    outputTex[gid.xy] = float4(flat_c, 1.0);
    return;
  }

  float3 c;
  float bleed = misc.y;
  if (bleed > 0.0) {
    // Analytic VCR chroma split: re-evaluate the WHOLE resolve at three
    // horizontally-offset positions and keep one channel from each. Exact
    // separation of outline, halo AND masking — no blur kernel involved.
    float o = bleed * 0.02;
    c.r = resolve(p + float2(-o, 0.0), base).r;
    c.g = resolve(p,                   base).g;
    c.b = resolve(p + float2( o, 0.0), base).b;
  } else {
    c = resolve(p, base);
  }

  float3 graded = nano_vcr_grade(c, uv, grade);
  // Stay layerable: alpha carries whatever the input had plus whatever we
  // emitted, so the stack composites correctly when used as an overlay.
  float  a = saturate(max(src.a * in_op,
                          max(graded.r, max(graded.g, graded.b))));
  outputTex[gid.xy] = float4(graded, a);
}
