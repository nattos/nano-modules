// source.mesh.three_planes — the whole effect, in one fullscreen compute pass.
//
// The CPU has already projected three isometric quads into cover-square
// screen coords and handed us 12 corner points. Per pixel we:
//
//   1. take the EXACT signed distance to each quad's outline and its glow
//      field (nano_neon_quad.hlsl — shared with source.mesh.three_walls, and
//      where the reasoning behind the two fields lives);
//   2. turn that into a line core, a stacked-exponential halo, and an
//      antialiased interior coverage;
//   2b. scale that emission by the travelling glimmer, so a glint lights the
//      halo as well as the core (see `glimmer_at`);
//   3. resolve all three planes bottom-to-top in ONE expression, so a
//      masking plane can occlude the halos beneath it while still emitting
//      its own (see `resolve` below — this is the whole reason the effect
//      is a fullscreen pass rather than three additive draws);
//   4. grade the composite through the shared VCR stack.
//
// Nothing here needs an intermediate texture: the accumulator lives in
// registers at float precision and is tone-mapped exactly once, on write.

#include "nano_coords.hlsl"
#include "nano_neon_quad.hlsl"
#include "nano_vcr.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  // Projected corners, cover-square coords. Plane i occupies rows 2i and
  // 2i+1: (c0.xy, c1.zw) then (c2.xy, c3.zw), wound consistently.
  float4 corners[6];

  // rgb = plane colour, w = emission drive (already curved by the host).
  float4 plane_color[3];

  float4 fills;       // xyz = signed fill per plane (+neon / -mask), w = halo smooth
  float4 neon0;       // line half-width, line gain, core whiten, halo radius
  float4 neon1;       // halo gain, halo falloff, corner radius, aa width
  float4 misc;        // fill gain, chroma bleed, has_input, debug mode
  float4 view;        // vp_w, vp_h, aspect_x, aspect_y
  float4 glim0;       // glint phase, amount, travel dir x, dir y
  float4 glim1;       // glint density, width, gain, shadow

  VcrGrade grade;
};

// This effect predates the shared NeonStyle block and keeps its own historical
// float4 packing, so the style is assembled here rather than embedded in the
// cbuffer. Same bytes in, same bytes out — three_walls, which is new, embeds
// NeonStyle directly instead.
NeonStyle neon_style() {
  NeonStyle st;
  st.line_hw     = neon0.x;
  st.line_gain   = neon0.y;
  st.core_whiten = neon0.z;
  st.halo_r      = neon0.w;
  st.halo_gain   = neon1.x;
  st.falloff     = neon1.y;
  st.corner_r    = neon1.z;
  st.aa          = neon1.w;
  st.fill_gain   = misc.x;
  st.halo_smooth = fills.w;
  st.pad0        = 0.0;
  st.pad1        = 0.0;
  return st;
}

// --- Glimmer --------------------------------------------------------------
// Travelling diagonal glints, multiplied into each plane's EMISSION rather
// than composited over the finished picture. That is the point of doing it
// here at all: emission scales the line core, the halo and the fill together,
// so a glint crossing a tube brightens the glow around it as well and reads as
// light in the tube instead of a highlight pasted on top.
//
// Two band sets at incommensurate spacings. The first is always present; the
// second fades in with `amount`, which is what makes a fast sweep read as
// DENSER rather than merely brighter. Both key off the same phase, and the
// second travels at exactly TWO periods per wrap — an integer, so the rail's
// 1 -> 0 wrap is seamless for both sets rather than just the first.
//
// The shadow sits half a period behind each glint and is deliberately wider
// than it: a bright line with a soft dark wake behind it reads as contrast
// sweeping past, where two equally hard bands read as a grating.

/// One band set: a bright glint, and a wider dark wake half a period behind it.
float glimmer_band(float axis, float phase, float density, float speed,
                   float w, float gain, float shadow) {
  float u  = frac(axis * density - phase * speed);
  float tb = min(u, 1.0 - u);   // 0 at the glint, wrapped
  float td = abs(u - 0.5);      // 0 at the shadow, half a period behind
  return exp(-(tb * tb) / (w * w)) * gain
       - exp(-(td * td) / (w * w * 3.24)) * shadow;
}

float glimmer_at(float2 p) {
  float axis    = dot(p, glim0.zw);
  float amt     = glim0.y;
  float phase   = glim0.x;
  float density = glim1.x;
  float w       = max(glim1.y, 1e-3);
  float gain    = glim1.z;
  float shadow  = glim1.w;

  // BRANCHLESS ON PURPOSE. The obvious `if (amt <= 0) return 1.0;` costs
  // nothing to write and breaks the effect on WebGPU: DXC compiles an early
  // return inside a function into a local whose type naga rejects ("has a type
  // that can't be stored in a local variable"), the shader fails translation,
  // and three_planes silently renders nothing at all. No guard is needed
  // anyway — `amt` scales both terms, so an unwired card computes m = 0 and
  // this returns exactly 1.0.
  //
  // The fine set travels at exactly TWO periods per wrap — an integer, so the
  // rail's 1 -> 0 wrap is seamless for it as well as for the coarse one.
  float m = amt       * glimmer_band(axis, phase, density,         1.0, w, gain, shadow)
          + amt * amt * glimmer_band(axis, phase, density * 1.618, 2.0, w, gain, shadow);

  // Clamped at 0 so a deep shadow extinguishes a plane rather than inverting
  // it — emission is a multiplier on light, and there is no negative light.
  return max(0.0, 1.0 + m);
}

float2 corner_of(int i, int k) {
  float4 row = corners[i * 2 + (k >> 1)];
  return (k & 1) ? row.zw : row.xy;
}

NanoNeonField plane_field(float2 p, int i) {
  return nano_neon_quad(p, corner_of(i, 0), corner_of(i, 1),
                           corner_of(i, 2), corner_of(i, 3),
                        neon1.z, neon0.w, neon1.y, fills.w);
}

// --- The resolve ----------------------------------------------------------
// Bottom-to-top, explicitly ordered. `acc *= (1 - A)` is what lets a black
// plane eat the glow of everything beneath it; `acc += E` immediately after is
// what keeps its OWN outline and halo alive over that black. Fixed-function
// blend cannot express both in one draw — this loop is the effect.
float3 resolve(float2 p, float3 base) {
  NeonStyle st = neon_style();
  float3 acc = base;
  // One sample for all three planes: the glint is a property of the SCREEN,
  // a light sweeping across the whole installation, not of any one plane.
  float glint = glimmer_at(p);

  [unroll]
  for (int i = 0; i < 3; i++) {
    NanoNeonField f = plane_field(p, i);
    float A;
    float3 E = nano_neon_quad_emit(f, plane_color[i].rgb, plane_color[i].w * glint,
                                   fills[i], st, A);
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
    for (int i = 0; i < 3; i++) d = min(d, abs(plane_field(p, i).sd));
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
      float ins = saturate(0.5 - plane_field(p, i).sd / max(neon1.w, 1e-6));
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
