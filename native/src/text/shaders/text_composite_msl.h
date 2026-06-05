#pragma once
// text_composite_msl.h — host-owned GPU text compositor for the Metal backend.
//
// This is the MSL port of the WGSL compositor in web/src/text-engine.ts and the
// CPU golden Engine::rasterize (native/src/text/text_engine.cpp). All three share
// ONE math definition; keeping them in lock-step is what guarantees the native
// Metal pixels match the browser/WebGPU pixels which match the CPU reference.
//
// One compute dispatch per output pixel (8×8 threadgroups). Each pixel:
//   1. samples the background,
//   2. paints the background boxes (fill + border ring + overflow:hidden clip)
//      in document order, BEHIND the text,
//   3. alpha-composites each glyph's MSDF coverage (te_median3 + screenPxRange AA).
//
// Resource bindings (Metal index spaces are per-class, unlike WGSL's unified one):
//   buffer(0)=glyphs  buffer(1)=boxes  buffer(2)=uniforms
//   texture(0)=atlas_arr (2D array, LINEAR)  texture(1)=bg  texture(2)=out (write)
//   sampler(0)=linear/clamp
//
// Record layouts are byte-identical to text_engine::GlyphQuad (96B) and
// text_engine::BoxQuad (112B), so the engine's arrays upload verbatim.

static const char* kTextCompositeMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;

// 96-byte glyph: aux.x = atlas-array page (layer). clip/clipr = overflow:hidden
// rounded rect (clip.z<=0 -> none).
struct Glyph { float4 rect; float4 uv; float4 rgba; float4 aux; float4 clip; float4 clipr; };
// 112-byte background box: rect(x,y,w,h), rgba, radius(tl,tr,br,bl), clip+clipr,
// bord(border_w,_,_,_), bcol(border rgba) -- uniform solid border ring.
struct Box { float4 rect; float4 rgba; float4 radius; float4 clip; float4 clipr; float4 bord; float4 bcol; };
struct U {
  uint  canvas_w; uint canvas_h; uint glyph_count; uint atlas_w; uint atlas_h;
  float origin_x;  float origin_y; uint atlas_kind; float atlas_px_range;
  uint  box_count; float _p1; float _p2;
};

static inline float te_median3(float a, float b, float c) {
  return max(min(a, b), min(max(a, b), c));
}

// Signed distance (px) to a rounded box; radius = (tl,tr,br,bl), selected per
// quadrant and clamped to half-extent. Mirrors the engine's CPU sdRoundBox.
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

kernel void text_composite(
    uint2 gid                                  [[thread_position_in_grid]],
    device const Glyph* glyphs                 [[buffer(0)]],
    device const Box*   boxes                  [[buffer(1)]],
    constant U&         u                      [[buffer(2)]],
    texture2d_array<float>            atlas_arr [[texture(0)]],
    texture2d<float>                  bg_tex    [[texture(1)]],
    texture2d<float, access::write>   out_tex   [[texture(2)]],
    sampler                           samp      [[sampler(0)]]) {
  if (gid.x >= u.canvas_w || gid.y >= u.canvas_h) { return; }
  float2 p = float2(float(gid.x) + 0.5, float(gid.y) + 0.5);
  float2 bg_uv = p / float2(float(u.canvas_w), float(u.canvas_h));
  float3 col = bg_tex.sample(samp, bg_uv, level(0.0)).rgb;

  // Background fills, behind the glyphs, in document order.
  for (uint b = 0u; b < u.box_count; b = b + 1u) {
    Box bq = boxes[b];
    float2 c = float2(bq.rect.x + u.origin_x + bq.rect.z * 0.5,
                      bq.rect.y + u.origin_y + bq.rect.w * 0.5);
    float sd = sd_round_box(p, c, float2(bq.rect.z * 0.5, bq.rect.w * 0.5), bq.radius);
    float clip = clip_cov(p, bq.clip, bq.clipr, u);
    float shape = clamp(0.5 - sd, 0.0, 1.0);
    // background fills the whole box; border = ring (SDF offset by border_w).
    float bw = bq.bord.x;
    float inner = (bw > 0.0) ? clamp(0.5 - (sd + bw), 0.0, 1.0) : shape;
    float ring = max(shape - inner, 0.0);
    // Fill the padding box (inner), not the full box, so the background doesn't
    // bleed a light fringe past the border at the outer AA edge.
    float af = inner * bq.rgba.a * clip;
    col = bq.rgba.rgb * af + col * (1.0 - af);
    float ar = ring * bq.bcol.a * clip;
    col = bq.bcol.rgb * ar + col * (1.0 - ar);
  }

  for (uint i = 0u; i < u.glyph_count; i = i + 1u) {
    Glyph g = glyphs[i];
    float gx = g.rect.x + u.origin_x;
    float gy = g.rect.y + u.origin_y;
    if (p.x < gx || p.y < gy || p.x >= gx + g.rect.z || p.y >= gy + g.rect.w) { continue; }
    float lu = (p.x - gx) / g.rect.z;
    float lv = (p.y - gy) / g.rect.w;
    float au = g.uv.x + lu * (g.uv.z - g.uv.x);
    float av = g.uv.y + lv * (g.uv.w - g.uv.y);
    float4 texel = atlas_arr.sample(samp, float2(au, av), uint(g.aux.x), level(0.0));
    float cov;
    if (u.atlas_kind == 0u) {                  // MSDF: median + screenPxRange AA
      float tile_h_px = (g.uv.w - g.uv.y) * float(u.atlas_h);
      float spr = (tile_h_px > 0.0) ? u.atlas_px_range * g.rect.w / tile_h_px : 1.0;
      float sd = te_median3(texel.r, texel.g, texel.b);
      cov = clamp(spr * (sd - 0.5) + 0.5, 0.0, 1.0);
    } else {                                   // alpha-coverage (stub atlas)
      cov = texel.a;
    }
    cov = cov * clip_cov(p, g.clip, g.clipr, u);
    float a = cov * g.rgba.a;
    col = g.rgba.rgb * a + col * (1.0 - a);
  }

  out_tex.write(float4(col, 1.0), gid);
}
)MSL";
