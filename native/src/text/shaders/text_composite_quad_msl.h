#pragma once
// text_composite_quad_msl.h — quad-based MSDF text compositor for the Metal
// backend. Replaces the former per-pixel compute kernel, which looped EVERY
// glyph for EVERY output pixel (O(canvas·glyphs)), which is the
// power-of-the-GPU done backwards. Here each glyph/box is an instanced QUAD that
// only rasterizes its own pixels, so total fragment work ≈ ink area, not
// canvas·glyphs. MSDF is preserved (the fragment samples the same atlas and runs
// the same median + screenPxRange AA).
//
// Pixel-exact with the CPU golden Engine::rasterize (and therefore the WebGPU
// path): we reproduce its math, and rely on two ordering facts —
//   1. the fragment's [[position]].xy IS the pixel center (gid + 0.5), so the
//      per-fragment math is identical to the compute kernel's per-pixel math;
//   2. instanced primitives blend in instance order, and we draw bg → boxes →
//      glyphs in document order, so the alpha-over accumulation matches the
//      golden's loop order.
//
// One render pass onto the target (cleared opaque black), three pipelines (all
// straight-alpha `AlphaOver` blend, src.rgb*src.a + dst*(1-src.a)):
//   bg_vs/bg_fs       — fullscreen triangle, samples bg at pixel/canvas; alpha=1
//                       so AlphaOver == replace (initialises col = bg sample).
//   box_vs/box_fs     — instanced rounded-box fill + border ring, collapsed into
//                       ONE straight-alpha output (the golden does two sequential
//                       composites per box; they fold algebraically into a single
//                       src-over: see below).
//   glyph_vs/glyph_fs — instanced glyph quad, coverage × run alpha. Coverage is
//                       the MSDF sample, the analytic outline, or a blend of the
//                       two (per-glyph aux.z) — see te_outline_cov.
//
// Bindings (Metal index spaces are per-class; renderSetBuffer binds a buffer to
// BOTH vertex+fragment so [[buffer(n)]] resolves in either stage):
//   buffer(0)=glyphs  buffer(1)=boxes  buffer(2)=uniforms U
//   buffer(3)=outlines (analytic-outline arena, the Precise path)
//   fragment texture(0)=atlas_arr (2D array, LINEAR)  texture(1)=bg
//   fragment sampler(0)=linear/clamp
//
// Record layouts are byte-identical to text_engine::GlyphQuad (96B),
// text_engine::BoxQuad (112B), and the UBO in host_impls_text.cpp.
//
// STILL MSL-ONLY, and so still broken on D3D11: the backend is handed this
// source verbatim and FXC reports "X1505: No include handler specified" for all
// three vertex stages. The executor's compute shaders were unified through
// HLSL→SPIR-V (src/sketch/shaders/), and this one belongs in that pipeline too
// — but it is a RENDER path, and D3D11's render PSOs are still at the -1
// defaults, so converting it now would rewrite a pixel-exact-golden Metal path
// (spirv-cross MSL in place of this hand-written source) with nothing on the
// other side able to prove it bought anything. It goes with the render stage.
//
// Its bindings will have to be renumbered when it does: MSL gives buffers,
// textures and samplers their own index spaces, so buffer(0..3) + texture(0..1)
// + sampler(0) all collide in the single binding namespace SPIR-V uses. The
// host slots in host_impls_text.cpp move in lock-step.

static const char* kTextCompositeQuadMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;

struct Glyph { float4 rect; float4 uv; float4 rgba; float4 aux; float4 clip; float4 clipr; };
struct Box   { float4 rect; float4 rgba; float4 radius; float4 clip; float4 clipr; float4 bord; float4 bcol; };
struct U {
  uint  canvas_w; uint canvas_h; uint glyph_count; uint atlas_w; uint atlas_h;
  float origin_x;  float origin_y; uint atlas_kind; float atlas_px_range;
  uint  box_count; float _p1; float _p2;
};

static inline float te_median3(float a, float b, float c) {
  return max(min(a, b), min(max(a, b), c));
}

// Analytic outline coverage (the Precise path). `arena` is the engine's outline
// buffer, `ofs` the glyph's record (vec4 units), `e` the sample point in the
// glyph's EM space (y-up), `ppe` its screen pixels per em. The record layout is
// documented in text_engine.h.
//
// Per CONTOUR in the sample's band we take a signed distance — positive on that
// contour's own filled side, matching msdfgen's convention — then combine them
// the way msdfgen's OverlappingContourCombiner does. Taking the nearest segment
// of any contour is wrong wherever outlines overlap (CJK strokes, synthetic
// bold): the nearest edge is often BURIED inside the filled region, and treating
// it as boundary paints a seam through solid ink.
//
// One band serves both loops: segments are registered into every band within the
// antialiasing reach, and any segment crossing this scanline necessarily
// overlaps this band.
//
// EXACT MIRROR of outlineCoverage() in native/src/text/text_engine.cpp (the CPU
// golden) and the WGSL twin in web/src/text-engine.ts. Move all three together.
static inline float te_outline_cov(device const float4* arena, uint ofs,
                                   float2 e, float ppe) {
  float4 plane = arena[ofs];
  float4 hdr   = arena[ofs + 1u];
  int   bandCount = int(hdr.x);
  float bandDy    = hdr.y;
  if (bandCount <= 0 || bandDy <= 0.0 || ppe <= 0.0) { return 0.0; }
  float planeT = plane.w;

  int b = clamp(int(floor((planeT - e.y) / bandDy)), 0, bandCount - 1);
  float4 band = arena[ofs + 2u + uint(b)];
  int runOfs = int(band.x), runCount = int(band.y);

  const float kFar = 1e30;
  float innerNear = kFar, innerDeep = -kFar;   // w>0, d>=0 : containing filled contours
  float outerNear = kFar, outerDeep =  kFar;   // w<0, d<=0 : containing holes
  float crossPos  = kFar;                      // w<0, d>=0 : hole edge on the filled side
  float crossNeg  = -kFar;                     // w>0, d<=0 : filled edge on the empty side
  float shapeSigned = 0.0, shapeNear = kFar;   // plain nearest edge, sign and all

  for (int r = 0; r < runCount; r++) {
    float4 run = arena[ofs + uint(runOfs + r)];
    uint  segOfs   = ofs + uint(run.x);
    int   segCount = int(run.y);
    float winding  = run.z;
    if (segCount <= 0) { continue; }

    float best = kFar;
    int   cross = 0;
    for (int i = 0; i < segCount; i++) {
      float4 sg = arena[segOfs + uint(i)];
      float2 d2v = sg.zw - sg.xy;
      float len2 = dot(d2v, d2v);
      float t = (len2 > 0.0) ? clamp(dot(e - sg.xy, d2v) / len2, 0.0, 1.0) : 0.0;
      float2 q = sg.xy + t * d2v - e;
      best = min(best, dot(q, q));
      if ((sg.y <= e.y) != (sg.w <= e.y)) {                 // crosses this scanline
        float xc = sg.x + (e.y - sg.y) * (sg.z - sg.x) / (sg.w - sg.y);
        if (xc > e.x) { cross += (sg.w > sg.y) ? 1 : -1; }  // ray to +x, nonzero rule
      }
    }

    // Signed distance to THIS contour: positive on the side it fills, which for
    // a hole is the outside of it.
    float dist = sqrt(best);
    float d = (cross != 0 ? dist : -dist) * winding;
    float ad = abs(d);

    if (ad < shapeNear) { shapeNear = ad; shapeSigned = d; }
    if (winding > 0.0) {
      if (d >= 0.0) { innerNear = min(innerNear, ad); innerDeep = max(innerDeep, d); }
      else          { crossNeg = max(crossNeg, d); }
    } else {
      if (d <= 0.0) { outerNear = min(outerNear, ad); outerDeep = min(outerDeep, d); }
      else          { crossPos = min(crossPos, d); }
    }
  }

  // No geometry on this scanline at all. A point inside the shape always has the
  // outline crossing its scanline, so an empty band means "outside", not "on the
  // edge" — falling through with d = 0 would paint a 50% grey block.
  if (shapeNear >= kFar) { return 0.0; }

  float d;
  if (innerNear < kFar && innerNear <= outerNear) {
    // Inside a filled contour. The deepest one wins over any edge buried under
    // it, but a hole edge is real boundary and still caps how deep we can be.
    d = min(min(innerDeep, outerNear), crossPos);
  } else if (outerNear < kFar) {
    d = max(max(outerDeep, -innerNear), crossNeg);   // inside a hole: the mirror image
  } else {
    // Outside everything — every interior point is farther than the boundary,
    // so the plain nearest edge is already exact.
    d = shapeSigned;
  }
  return clamp(0.5 + d * ppe, 0.0, 1.0);            // positive inside, as msdfgen
}

// Signed distance (px) to a rounded box; radius=(tl,tr,br,bl), per-quadrant.
static inline float sd_round_box(float2 p, float2 c, float2 h, float4 rad) {
  float2 d = p - c;
  bool top = d.y < 0.0;
  float r = (d.x > 0.0) ? (top ? rad.y : rad.z) : (top ? rad.x : rad.w);
  r = clamp(r, 0.0, min(h.x, h.y));
  float2 q = abs(d) - h + float2(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, float2(0.0, 0.0))) - r;
}

// overflow:hidden coverage mask for pixel p; clip.z<=0 -> unclipped.
static inline float clip_cov(float2 p, float4 clip, float4 clipr, constant U& u) {
  if (clip.z <= 0.0 || clip.w <= 0.0) { return 1.0; }
  float2 c = float2(clip.x + u.origin_x + clip.z * 0.5,
                    clip.y + u.origin_y + clip.w * 0.5);
  float sd = sd_round_box(p, c, float2(clip.z * 0.5, clip.w * 0.5), clipr);
  return clamp(0.5 - sd, 0.0, 1.0);
}

// Unit-quad corner for a 6-vertex (two-triangle) quad.
static inline float2 quad_corner(uint vid) {
  float x = (vid == 1u || vid == 3u || vid == 4u) ? 1.0 : 0.0;
  float y = (vid == 2u || vid == 4u || vid == 5u) ? 1.0 : 0.0;
  return float2(x, y);
}

// pixel-space (x,y) → clip space; y flips (texture y-down → NDC y-up).
static inline float4 px_to_clip(float2 px, constant U& u) {
  return float4(px.x / float(u.canvas_w) * 2.0 - 1.0,
                1.0 - px.y / float(u.canvas_h) * 2.0, 0.0, 1.0);
}

// ---- background (fullscreen) ------------------------------------------------
struct BgOut { float4 pos [[position]]; };
vertex BgOut bg_vs(uint vid [[vertex_id]]) {
  // Single oversized triangle covering the [-1,1] viewport.
  float2 p = float2((vid == 2u) ? 3.0 : -1.0, (vid == 1u) ? 3.0 : -1.0);
  BgOut o; o.pos = float4(p, 0.0, 1.0); return o;
}
fragment float4 bg_fs(BgOut in [[stage_in]],
                      constant U& u                [[buffer(2)]],
                      texture2d<float> bg_tex      [[texture(1)]],
                      sampler samp                 [[sampler(0)]]) {
  // [[position]].xy is the pixel center (X+0.5, Y+0.5) — same as the compute
  // kernel's bg_uv = (gid+0.5)/canvas. alpha=1 → AlphaOver replaces the clear.
  float2 uv = in.pos.xy / float2(float(u.canvas_w), float(u.canvas_h));
  return float4(bg_tex.sample(samp, uv, level(0.0)).rgb, 1.0);
}

// ---- boxes (instanced rounded-rect fill + border) ---------------------------
struct BoxOut {
  float4 pos [[position]];
  float4 rect   [[flat]]; float4 rgba [[flat]]; float4 radius [[flat]];
  float4 clip   [[flat]]; float4 clipr [[flat]];
  float4 bord   [[flat]]; float4 bcol [[flat]];
};
vertex BoxOut box_vs(uint vid [[vertex_id]], uint iid [[instance_id]],
                     device const Box* boxes [[buffer(1)]],
                     constant U& u           [[buffer(2)]]) {
  Box b = boxes[iid];
  float2 corner = quad_corner(vid);
  // Expand the quad 1px on every side so the SDF anti-aliased edge (coverage
  // non-zero only within 0.5px of the box) is fully captured.
  float ox = b.rect.x + u.origin_x - 1.0, oy = b.rect.y + u.origin_y - 1.0;
  float w  = b.rect.z + 2.0,              h  = b.rect.w + 2.0;
  float2 px = float2(ox + corner.x * w, oy + corner.y * h);
  BoxOut o;
  o.pos = px_to_clip(px, u);
  o.rect = b.rect; o.rgba = b.rgba; o.radius = b.radius;
  o.clip = b.clip; o.clipr = b.clipr; o.bord = b.bord; o.bcol = b.bcol;
  return o;
}
fragment float4 box_fs(BoxOut in [[stage_in]], constant U& u [[buffer(2)]]) {
  float2 p = in.pos.xy;
  float2 c = float2(in.rect.x + u.origin_x + in.rect.z * 0.5,
                    in.rect.y + u.origin_y + in.rect.w * 0.5);
  float sd = sd_round_box(p, c, float2(in.rect.z * 0.5, in.rect.w * 0.5), in.radius);
  float clip = clip_cov(p, in.clip, in.clipr, u);
  float shape = clamp(0.5 - sd, 0.0, 1.0);
  float bw = in.bord.x;
  float inner = (bw > 0.0) ? clamp(0.5 - (sd + bw), 0.0, 1.0) : shape;
  float ring = max(shape - inner, 0.0);
  // Golden does: col = fill over col; col = ring over col. Fold the two
  // src-overs into one straight-alpha src so the hardware AlphaOver reproduces
  // both: combined premul = ring·ar + fill·af·(1-ar), srcA = 1-(1-af)(1-ar).
  float af = inner * in.rgba.a * clip;
  float ar = ring  * in.bcol.a * clip;
  float srcA = 1.0 - (1.0 - af) * (1.0 - ar);
  if (srcA <= 0.0) { discard_fragment(); }
  float3 premul = in.bcol.rgb * ar + in.rgba.rgb * af * (1.0 - ar);
  return float4(premul / srcA, srcA);   // straight alpha (blend multiplies by srcA)
}

// ---- glyphs (instanced MSDF quads) ------------------------------------------
struct GlyphOut {
  float4 pos  [[position]];
  float2 auv;                 // interpolated atlas-page uv
  float2 em;                  // interpolated position in the glyph's EM plane (y-up)
  float4 rgba  [[flat]];
  float  page  [[flat]];
  float  spr   [[flat]];      // screenPxRange factor
  float  ofs   [[flat]];      // outline record offset (vec4 units); 0 = none
  float  pw    [[flat]];      // analytic-outline blend weight
  float  ppe   [[flat]];      // screen px per em for this instance
  float4 clip  [[flat]];
  float4 clipr [[flat]];
};
vertex GlyphOut glyph_vs(uint vid [[vertex_id]], uint iid [[instance_id]],
                         device const Glyph* glyphs    [[buffer(0)]],
                         constant U& u                 [[buffer(2)]],
                         device const float4* outlines [[buffer(3)]]) {
  Glyph g = glyphs[iid];
  float2 corner = quad_corner(vid);
  float gx = g.rect.x + u.origin_x, gy = g.rect.y + u.origin_y;
  float2 px = float2(gx + corner.x * g.rect.z, gy + corner.y * g.rect.w);
  GlyphOut o;
  o.pos = px_to_clip(px, u);
  o.auv = float2(mix(g.uv.x, g.uv.z, corner.x), mix(g.uv.y, g.uv.w, corner.y));
  o.rgba = g.rgba;
  o.page = g.aux.x;
  float tile_h_px = (g.uv.w - g.uv.y) * float(u.atlas_h);
  o.spr = (tile_h_px > 0.0) ? u.atlas_px_range * g.rect.w / tile_h_px : 1.0;
  // Precise path. The quad rect IS the glyph's em plane mapped to pixels, so
  // interpolating the plane corners across the quad hands every fragment its em
  // position for free — no inverse transform in the fragment shader. Record 0 is
  // the reserved empty slot, so reading it is safe and lands on pw = 0.
  uint ofs = uint(g.aux.y);
  float4 plane = outlines[ofs];
  float spanX = plane.z - plane.x;
  o.ofs = g.aux.y;
  o.pw  = (ofs > 0u && spanX > 0.0) ? g.aux.z : 0.0;
  o.ppe = (spanX > 0.0) ? g.rect.z / spanX : 0.0;
  o.em  = float2(mix(plane.x, plane.z, corner.x), mix(plane.w, plane.y, corner.y));
  o.clip = g.clip; o.clipr = g.clipr;
  return o;
}
fragment float4 glyph_fs(GlyphOut in [[stage_in]],
                         constant U& u                    [[buffer(2)]],
                         device const float4* outlines    [[buffer(3)]],
                         texture2d_array<float> atlas_arr [[texture(0)]],
                         sampler samp                     [[sampler(0)]]) {
  float4 texel = atlas_arr.sample(samp, in.auv, uint(in.page), level(0.0));
  float cov;
  if (u.atlas_kind == 0u) {                  // MSDF: median + screenPxRange AA
    float sd = te_median3(texel.r, texel.g, texel.b);
    cov = clamp(in.spr * (sd - 0.5) + 0.5, 0.0, 1.0);
  } else {                                   // alpha-coverage (stub atlas)
    cov = texel.a;
  }
  // Precise: the very same ramp, handed an exact distance instead of a sampled
  // one. pw is 0 for every glyph the engine left on the MSDF path.
  if (in.pw > 0.0) {
    float covP = te_outline_cov(outlines, uint(in.ofs), in.em, in.ppe);
    cov += (covP - cov) * in.pw;
  }
  cov = cov * clip_cov(in.pos.xy, in.clip, in.clipr, u);
  float a = cov * in.rgba.a;
  return float4(in.rgba.rgb, a);             // straight alpha
}
)MSL";
