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
//   2b. scale that emission by whichever glint particles are passing, so a
//      glint lights the halo as well as the core (see `glimmer_at`);
//   3. resolve all three planes bottom-to-top in ONE expression, so a
//      masking plane can occlude the halos beneath it while still emitting
//      its own (see `resolve` below — this is the whole reason the effect
//      is a fullscreen pass rather than three additive draws);
//   3b. add the release rings — the same quads thrown outward, opening out
//      and going soft as they fly (see `ring_at`);
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
  // The release rings: the same three quads, thrown outward. Ring i occupies
  // rows 2i and 2i+1, wound the same way `corners` is.
  float4 ghosts[6];
  float4 rel;         // ring halo radius, falloff, -, -
  // Per-ring gain, carrying the release, the opening-out, the local-contrast
  // damping and the one-frame hold — all of it worked out on the host.
  float4 ring_gain;
  float4 glim0;       // glint travel dir x, dir y, -, -
  // One row per glint IN FLIGHT: where it sits on the travel axis, its
  // half-width there, and the brightness and wake depth it was born with. A
  // dead slot is zero gain and zero shade, so there is no count and no branch.
  float4 glints[8];

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

// --- The release rings ---------------------------------------------------
// The throw: the same three quads, flung outward off the stack and ringing
// down. The host has already worked out where they are and how open they have
// gone — everything here is a pure function of the release, so a ring reads as
// an object with a life while costing no state at all.
//
// Deliberately NOT nano_neon_quad. A ring has no inside: no fill to flood, no
// mask to occlude with, and no core — by the time you can see one it is
// already past being a tube. So the exact SIGNED field, the corner rounding
// and the interior light-sum are all work with nothing to show for it, and
// what is left is the cheap half: unsigned distance to four edges, through one
// halo. That is the whole shape.
float ring_at(float2 p, int i) {
  float4 r0 = ghosts[i * 2 + 0];
  float4 r1 = ghosts[i * 2 + 1];
  float2 a = r0.xy, b = r0.zw, c = r1.xy, d = r1.zw;
  float dist = min(min(nano_neon_seg_dist(p, a, b), nano_neon_seg_dist(p, b, c)),
                   min(nano_neon_seg_dist(p, c, d), nano_neon_seg_dist(p, d, a)));
  return nano_neon_halo_profile(dist, rel.x, rel.y);
}

// --- Glimmer --------------------------------------------------------------
// Travelling glints, multiplied into each plane's EMISSION rather than
// composited over the finished picture. That is the point of doing it here at
// all: emission scales the line core, the halo and the fill together, so a
// glint crossing a tube brightens the glow around it as well and reads as
// light in the tube instead of a highlight pasted on top.
//
// These are PARTICLES. The host owns their lives (see
// <sketch/three_planes_glints.h>) and hands us however many are in flight,
// already projected onto the travel axis; all that is left here is to add up
// what they look like. Each is a bright band with a darker, wider wake behind
// it — a glint alone gets brighter, a glint with a wake sweeps CONTRAST past,
// which is what the eye reads as a moving highlight on a surface.
//
// The wake trails, so it sits at a LOWER axis coordinate than the glint (they
// travel toward +axis) — hence `d + wake` rather than `d - wake`.
static const float kGlintWake  = 1.5;   // wake offset, in glint half-widths
static const float kGlintWakeW = 1.8;   // wake width, likewise

float glimmer_at(float2 p) {
  float axis = dot(p, glim0.xy);

  // BRANCHLESS AND FULLY UNROLLED. An early `return` for the idle case looks
  // free and is not: DXC compiles one inside a function into a local naga
  // rejects ("has a type that can't be stored in a local variable"), the
  // SPIR-V -> WGSL translation fails, and the whole effect silently renders
  // nothing on WebGPU. A dead slot carries zero gain instead.
  float m = 0.0;
  [unroll]
  for (int i = 0; i < 8; i++) {
    float4 g = glints[i];
    float w = max(g.y, 1e-4);
    float d = (axis - g.x) / w;
    float k = (d + kGlintWake) / kGlintWakeW;
    // The glint is a SUPER-Gaussian (d^4, not d^2): a flatter top with much
    // faster shoulders, so it reads as a hard-edged slash — an object with a
    // boundary — where a plain Gaussian reads as a soft wash sliding past.
    // The wake stays Gaussian, because a wake IS a soft thing.
    float d2 = d * d;
    m += g.z * exp(-d2 * d2)
       - g.w * exp(-k * k);
  }

  // Clamped at 0 so a deep wake extinguishes a plane rather than inverting it
  // — emission is a multiplier on light, and there is no negative light.
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
  // One sample for all three planes: a glint is a property of the SCREEN, a
  // light sweeping across the whole installation, not of any one plane.
  float glint = glimmer_at(p);

  [unroll]
  for (int i = 0; i < 3; i++) {
    NanoNeonField f = plane_field(p, i);
    float A;
    float3 E = nano_neon_quad_emit(f, plane_color[i].rgb, plane_color[i].w * glint,
                                   fills[i], st, A);
    acc = acc * (1.0 - A) + E;
  }

  // The rings go on TOP of the resolve, additively and without occluding
  // anything. They are light already thrown clear of the stack — nothing left
  // behind can mask them, and they have no body to be masked.
  [unroll]
  for (int k = 0; k < 3; k++) acc += plane_color[k].rgb * (ring_at(p, k) * ring_gain[k]);
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
