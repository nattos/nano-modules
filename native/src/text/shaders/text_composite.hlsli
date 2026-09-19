// text_composite.hlsli — everything the six text-compositor stages share.
//
// Each stage is its own tiny .hlsl next to this one, with an entry point named
// `main`, because that is the convention the whole tree runs on: DXC bakes one
// SPIR-V blob per entry, spirv-cross emits HLSL whose function is ALWAYS called
// `main` whatever the SPIR-V entry was named, and the host maps "main" →
// "main0" for Metal (gpu_impls.cpp's mapEntryName). Six entry points in one
// blob would have to be six differently-named ones, and the HLSL leg would
// collapse them all onto `main` and find none of them.
//
// Authored ONCE here and translated per backend by the host (spv_to_msl /
// spv_to_hlsl / naga), the way effect shaders already are. It used to be a
// hand-written MSL string (text_composite_quad_msl.h) that the Metal backend
// compiled verbatim, which meant D3DCompile got "#include <metal_stdlib>" and
// every text vertex stage failed to build on Windows.
//
// Pixel-exact with the CPU golden Engine::rasterize (and therefore the WebGPU
// path): the math is reproduced, and two ordering facts are relied on —
//   1. SV_Position.xy IS the pixel center (gid + 0.5), so the per-fragment math
//      is identical to the old compute kernel's per-pixel math;
//   2. instanced primitives blend in instance order, and the host draws
//      bg → boxes → glyphs in document order, so the alpha-over accumulation
//      matches the golden's loop order.
//
// One render pass onto the target (cleared transparent), three pipelines (all
// straight-alpha alpha-over, src.rgb*src.a + dst*(1-src.a)):
//   bg_vs/bg_fs       — fullscreen triangle sampling the input; alpha=1, so
//                       alpha-over == replace.
//   box_vs/box_fs     — instanced rounded-box fill + border ring, collapsed
//                       into ONE straight-alpha output (the golden does two
//                       sequential composites per box; they fold algebraically
//                       into a single src-over — see box_fs).
//   glyph_vs/glyph_fs — instanced glyph quad, coverage × run alpha. Coverage is
//                       the MSDF sample, the analytic outline, or a blend of
//                       the two (per-glyph aux.z) — see te_outline_cov.
//
// BINDINGS. Register numbers are the host's slot numbers (host_impls_text.cpp),
// and they live in ONE namespace here — MSL gave buffers, textures and samplers
// their own index spaces, so the old numbering had buffer(0..3) colliding with
// texture(0..1) and sampler(0). Anything that moves here moves there.
//
// NO EXPLICIT Y FLIP. px_to_clip writes SPIR-V's y-down NDC and the translator
// flips it (spv_to_msl.cpp / spv_to_hlsl.cpp, flip_vert_y) — the same
// convention every effect shader is authored in. The old MSL flipped by hand
// because nothing translated it; doing both would mirror the text.
//
// Record layouts are byte-identical to text_engine::GlyphQuad (96B),
// text_engine::BoxQuad (112B), and the UBO in host_impls_text.cpp.

struct Glyph { float4 rect; float4 uv; float4 rgba; float4 aux; float4 clip; float4 clipr; };
struct Box   { float4 rect; float4 rgba; float4 radius; float4 clip; float4 clipr; float4 bord; float4 bcol; };

StructuredBuffer<Glyph>  glyphs   : register(t0);
StructuredBuffer<Box>    boxes    : register(t1);
StructuredBuffer<float4> outlines : register(t3);

cbuffer U : register(b2) {
  uint  canvas_w; uint canvas_h; uint glyph_count; uint atlas_w; uint atlas_h;
  float origin_x; float origin_y; uint atlas_kind; float atlas_px_range;
  uint  box_count; float _p1; float _p2;
};

Texture2DArray<float4> atlas_arr : register(t4);
Texture2D<float4>      bg_tex    : register(t5);
SamplerState           samp      : register(s6);

float te_median3(float a, float b, float c) {
  return max(min(a, b), min(max(a, b), c));
}

// Analytic outline coverage (the Precise path). `ofs` is the glyph's record in
// the outline arena (vec4 units), `e` the sample point in the glyph's EM space
// (y-up), `ppe` its screen pixels per em. The record layout is documented in
// text_engine.h.
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
float te_outline_cov(uint ofs, float2 e, float ppe) {
  float4 plane = outlines[ofs];
  float4 hdr   = outlines[ofs + 1u];
  int   bandCount = int(hdr.x);
  float bandDy    = hdr.y;
  if (bandCount <= 0 || bandDy <= 0.0 || ppe <= 0.0) { return 0.0; }
  float planeT = plane.w;

  int b = clamp(int(floor((planeT - e.y) / bandDy)), 0, bandCount - 1);
  float4 band = outlines[ofs + 2u + uint(b)];
  int runOfs = int(band.x), runCount = int(band.y);

  const float kFar = 1e30;
  float innerNear = kFar, innerDeep = -kFar;   // w>0, d>=0 : containing filled contours
  float outerNear = kFar, outerDeep =  kFar;   // w<0, d<=0 : containing holes
  float crossPos  = kFar;                      // w<0, d>=0 : hole edge on the filled side
  float crossNeg  = -kFar;                     // w>0, d<=0 : filled edge on the empty side
  float shapeSigned = 0.0, shapeNear = kFar;   // plain nearest edge, sign and all

  for (int r = 0; r < runCount; r++) {
    float4 run = outlines[ofs + uint(runOfs + r)];
    uint  segOfs   = ofs + uint(run.x);
    int   segCount = int(run.y);
    float winding  = run.z;
    if (segCount <= 0) { continue; }

    float best = kFar;
    int   cross = 0;
    for (int i = 0; i < segCount; i++) {
      float4 sg = outlines[segOfs + uint(i)];
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
float sd_round_box(float2 p, float2 c, float2 h, float4 rad) {
  float2 d = p - c;
  bool top = d.y < 0.0;
  float r = (d.x > 0.0) ? (top ? rad.y : rad.z) : (top ? rad.x : rad.w);
  r = clamp(r, 0.0, min(h.x, h.y));
  float2 q = abs(d) - h + float2(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, float2(0.0, 0.0))) - r;
}

// overflow:hidden coverage mask for pixel p; clip.z<=0 -> unclipped.
float clip_cov(float2 p, float4 clip, float4 clipr) {
  if (clip.z <= 0.0 || clip.w <= 0.0) { return 1.0; }
  float2 c = float2(clip.x + origin_x + clip.z * 0.5,
                    clip.y + origin_y + clip.w * 0.5);
  float sd = sd_round_box(p, c, float2(clip.z * 0.5, clip.w * 0.5), clipr);
  return clamp(0.5 - sd, 0.0, 1.0);
}

// Unit-quad corner for a 6-vertex (two-triangle) quad.
float2 quad_corner(uint vid) {
  float x = (vid == 1u || vid == 3u || vid == 4u) ? 1.0 : 0.0;
  float y = (vid == 2u || vid == 4u || vid == 5u) ? 1.0 : 0.0;
  return float2(x, y);
}

// pixel-space (x,y) → clip space, in SPIR-V's y-DOWN NDC. The translator's
// flip_vert_y turns it y-up for Metal / D3D / WebGPU; see the header note.
float4 px_to_clip(float2 px) {
  return float4(px.x / float(canvas_w) * 2.0 - 1.0,
                px.y / float(canvas_h) * 2.0 - 1.0, 0.0, 1.0);
}

// ---- background (fullscreen) ------------------------------------------------
struct BgOut { float4 pos : SV_Position; };

BgOut bg_vs_impl(uint vid) {
  // Single oversized triangle covering the [-1,1] viewport (either winding —
  // the backends rasterize with culling off).
  float2 p = float2((vid == 2u) ? 3.0 : -1.0, (vid == 1u) ? 3.0 : -1.0);
  BgOut o; o.pos = float4(p, 0.0, 1.0); return o;
}

float4 bg_fs_impl(BgOut inp) {
  // SV_Position.xy is the pixel center (X+0.5, Y+0.5) — same as the old compute
  // kernel's bg_uv = (gid+0.5)/canvas. alpha=1 → alpha-over replaces the clear.
  float2 uv = inp.pos.xy / float2(float(canvas_w), float(canvas_h));
  return float4(bg_tex.SampleLevel(samp, uv, 0.0).rgb, 1.0);
}

// ---- boxes (instanced rounded-rect fill + border) ---------------------------
struct BoxOut {
  float4 pos : SV_Position;
  nointerpolation float4 rect   : TEXCOORD0;
  nointerpolation float4 rgba   : TEXCOORD1;
  nointerpolation float4 radius : TEXCOORD2;
  nointerpolation float4 clip   : TEXCOORD3;
  nointerpolation float4 clipr  : TEXCOORD4;
  nointerpolation float4 bord   : TEXCOORD5;
  nointerpolation float4 bcol   : TEXCOORD6;
};

BoxOut box_vs_impl(uint vid, uint iid) {
  Box b = boxes[iid];
  float2 corner = quad_corner(vid);
  // Expand the quad 1px on every side so the SDF anti-aliased edge (coverage
  // non-zero only within 0.5px of the box) is fully captured.
  float ox = b.rect.x + origin_x - 1.0, oy = b.rect.y + origin_y - 1.0;
  float w  = b.rect.z + 2.0,            h  = b.rect.w + 2.0;
  float2 px = float2(ox + corner.x * w, oy + corner.y * h);
  BoxOut o;
  o.pos = px_to_clip(px);
  o.rect = b.rect; o.rgba = b.rgba; o.radius = b.radius;
  o.clip = b.clip; o.clipr = b.clipr; o.bord = b.bord; o.bcol = b.bcol;
  return o;
}

float4 box_fs_impl(BoxOut inp) {
  float2 p = inp.pos.xy;
  float2 c = float2(inp.rect.x + origin_x + inp.rect.z * 0.5,
                    inp.rect.y + origin_y + inp.rect.w * 0.5);
  float sd = sd_round_box(p, c, float2(inp.rect.z * 0.5, inp.rect.w * 0.5), inp.radius);
  float clip = clip_cov(p, inp.clip, inp.clipr);
  float shape = clamp(0.5 - sd, 0.0, 1.0);
  float bw = inp.bord.x;
  float inner = (bw > 0.0) ? clamp(0.5 - (sd + bw), 0.0, 1.0) : shape;
  float ring = max(shape - inner, 0.0);
  // Golden does: col = fill over col; col = ring over col. Fold the two
  // src-overs into one straight-alpha src so the hardware alpha-over reproduces
  // both: combined premul = ring·ar + fill·af·(1-ar), srcA = 1-(1-af)(1-ar).
  float af = inner * inp.rgba.a * clip;
  float ar = ring  * inp.bcol.a * clip;
  float srcA = 1.0 - (1.0 - af) * (1.0 - ar);
  if (srcA <= 0.0) { discard; }
  float3 premul = inp.bcol.rgb * ar + inp.rgba.rgb * af * (1.0 - ar);
  return float4(premul / srcA, srcA);   // straight alpha (blend multiplies by srcA)
}

// ---- glyphs (instanced MSDF quads) ------------------------------------------
struct GlyphOut {
  float4 pos : SV_Position;
  float2 auv : TEXCOORD0;                 // interpolated atlas-page uv
  float2 em  : TEXCOORD1;                 // position in the glyph's EM plane (y-up)
  nointerpolation float4 rgba  : TEXCOORD2;
  nointerpolation float  page  : TEXCOORD3;
  nointerpolation float  spr   : TEXCOORD4;   // screenPxRange factor
  nointerpolation float  ofs   : TEXCOORD5;   // outline record offset (vec4 units); 0 = none
  nointerpolation float  pw    : TEXCOORD6;   // analytic-outline blend weight
  nointerpolation float  ppe   : TEXCOORD7;   // screen px per em for this instance
  nointerpolation float4 clip  : TEXCOORD8;
  nointerpolation float4 clipr : TEXCOORD9;
};

GlyphOut glyph_vs_impl(uint vid, uint iid) {
  Glyph g = glyphs[iid];
  float2 corner = quad_corner(vid);
  float gx = g.rect.x + origin_x, gy = g.rect.y + origin_y;
  float2 px = float2(gx + corner.x * g.rect.z, gy + corner.y * g.rect.w);
  GlyphOut o;
  o.pos = px_to_clip(px);
  o.auv = float2(lerp(g.uv.x, g.uv.z, corner.x), lerp(g.uv.y, g.uv.w, corner.y));
  o.rgba = g.rgba;
  o.page = g.aux.x;
  float tile_h_px = (g.uv.w - g.uv.y) * float(atlas_h);
  o.spr = (tile_h_px > 0.0) ? atlas_px_range * g.rect.w / tile_h_px : 1.0;
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
  o.em  = float2(lerp(plane.x, plane.z, corner.x), lerp(plane.w, plane.y, corner.y));
  o.clip = g.clip; o.clipr = g.clipr;
  return o;
}

float4 glyph_fs_impl(GlyphOut inp) {
  float4 texel = atlas_arr.SampleLevel(samp, float3(inp.auv, inp.page), 0.0);
  float cov;
  if (atlas_kind == 0u) {                    // MSDF: median + screenPxRange AA
    float sd = te_median3(texel.r, texel.g, texel.b);
    cov = clamp(inp.spr * (sd - 0.5) + 0.5, 0.0, 1.0);
  } else {                                   // alpha-coverage (stub atlas)
    cov = texel.a;
  }
  // Precise: the very same ramp, handed an exact distance instead of a sampled
  // one. pw is 0 for every glyph the engine left on the MSDF path.
  if (inp.pw > 0.0) {
    float covP = te_outline_cov(uint(inp.ofs), inp.em, inp.ppe);
    cov += (covP - cov) * inp.pw;
  }
  cov = cov * clip_cov(inp.pos.xy, inp.clip, inp.clipr);
  float a = cov * inp.rgba.a;
  return float4(inp.rgba.rgb, a);            // straight alpha
}
