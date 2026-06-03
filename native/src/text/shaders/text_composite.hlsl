// text_composite.hlsl — host-owned GPU text compositor (compute).
//
// The `text.render` easy path runs this: it composites the engine's positioned
// glyph quads over a background into the target texture. Compute (not a render
// PSO) is used deliberately — the base GPU abstraction's compute path
// (storage buffers + sampler + storage-texture output) is fully supported on
// BOTH the native Metal backend and WebGPU, whereas render-pass resource
// binding is not yet wired on Metal. One dispatch per output pixel; each pixel
// loops the glyph list and alpha-composites coverage.
//
// Parity target: this must match Engine::rasterize (the CPU golden reference)
// for the stub alpha-coverage atlas. Phase 1 swaps the coverage fetch for an
// MSDF median + screenPxRange when atlas_kind == 0.

struct Glyph {
  float4 rect;   // x, y, w, h  (layout-box-relative, px)
  float4 uv;     // u0, v0, u1, v1 (normalized atlas-page coords)
  float4 rgba;   // run color (linear)
  float4 aux;    // aux.x = atlas-array page (layer); rest reserved
};

// Binding slots are globally unique across resource classes (project
// convention: register number == Vulkan binding number, no per-class reuse).
StructuredBuffer<Glyph>      glyphs    : register(t0);
Texture2DArray<float4>       atlas_arr : register(t1);  // MSDF atlas pages; sampled LINEAR
Texture2D<float4>            bg_tex    : register(t2);
SamplerState            samp      : register(s3);  // linear filtering
RWTexture2D<float4>     out_tex   : register(u4);

cbuffer CompositeUniforms : register(b5) {
  uint  canvas_w;
  uint  canvas_h;
  uint  glyph_count;
  uint  atlas_w;
  uint  atlas_h;
  float origin_x;
  float origin_y;
  uint  atlas_kind;      // 0 = MSDF, 1 = alpha coverage (stub)
  float atlas_px_range;  // MSDF distance range in atlas px
  float _pad0; float _pad1; float _pad2;
};

float median3(float a, float b, float c) { return max(min(a, b), min(max(a, b), c)); }

// LINEAR-filtered sample of the glyph's atlas PAGE (array layer) — bilinear
// distance-field interpolation = smooth, corner-sharp MSDF at any magnification.
float4 atlas_texel(float u, float v, float page) {
  return atlas_arr.SampleLevel(samp, float3(u, v, page), 0.0);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= canvas_w || gid.y >= canvas_h) return;

  float2 p = float2((float)gid.x + 0.5, (float)gid.y + 0.5);
  float2 bg_uv = p / float2((float)canvas_w, (float)canvas_h);
  float3 col = bg_tex.SampleLevel(samp, bg_uv, 0).rgb;

  for (uint i = 0u; i < glyph_count; i++) {
    Glyph g = glyphs[i];
    float gx = g.rect.x + origin_x;
    float gy = g.rect.y + origin_y;
    if (p.x < gx || p.y < gy || p.x >= gx + g.rect.z || p.y >= gy + g.rect.w) continue;

    float lu = (p.x - gx) / g.rect.z;
    float lv = (p.y - gy) / g.rect.w;
    float au = g.uv.x + lu * (g.uv.z - g.uv.x);
    float av = g.uv.y + lv * (g.uv.w - g.uv.y);

    float4 texel = atlas_texel(au, av, g.aux.x);
    float cov;
    if (atlas_kind == 0u) {                       // MSDF: median + screenPxRange AA
      float tile_h_px = (g.uv.w - g.uv.y) * (float)atlas_h;
      float screen_px_range = tile_h_px > 0.0 ? atlas_px_range * g.rect.w / tile_h_px : 1.0;
      float sd = median3(texel.r, texel.g, texel.b);
      cov = clamp(screen_px_range * (sd - 0.5) + 0.5, 0.0, 1.0);
    } else {                                      // alpha-coverage (stub atlas)
      cov = texel.a;
    }
    float a = cov * g.rgba.a;
    col = g.rgba.rgb * a + col * (1.0 - a);
  }

  out_tex[gid.xy] = float4(col, 1.0);
}
