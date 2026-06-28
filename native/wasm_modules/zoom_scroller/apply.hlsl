// warp.legacy.zoom_scroller — render pass.
//
// Two jobs in one compute shader (the original used a Transform + a Shape
// Render rectangle outline + a Video Mixer):
//   1. Pan/zoom resample of the input: sample tex_in at a window centred on
//      `pan` (cover-square coords) and zoomed by `scale`.
//   2. Gizmo overlay: an analytic rectangle OUTLINE box, centred and nudged in
//      the direction of motion (`giz_off`), composited over the result. The box
//      is the on-screen motion indicator; it only draws when `giz_show` is on.
//
// All positions are in cover-square coords (see nano_coords.hlsl): (0,0) =
// centre, ±1 along the long axis = the viewport edge. The state machine in
// main.cpp feeds the already-resolved per-frame quantities; this shader is pure.

#include "nano_coords.hlsl"

Texture2D<float4>   inputTex  : register(t0);
SamplerState        samp      : register(s2);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b3) {
  float pan_x, pan_y;        // source-window centre (cover-square)
  float scale;               // zoom factor (>1 = zoomed in)
  float aspect_x;            // cover-square aspect (ax)
  float aspect_y;            // cover-square aspect (ay)
  float giz_off_x, giz_off_y;// gizmo box centre offset (cover-square)
  float giz_hw, giz_hh;      // gizmo box half-extents (cover-square)
  float giz_thick;           // outline half-thickness (cover-square)
  float giz_show;            // 0/1
  float giz_alpha;           // overlay opacity
  float giz_r, giz_g, giz_b; // outline colour
  float _pad0, _pad1;
};

// Signed distance to an axis-aligned box of half-extents `b`, centred at origin.
float sdBox(float2 p, float2 b) {
  float2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 aspect = float2(aspect_x, aspect_y);
  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), aspect);

  // Pan/zoom: the output pixel at cover-square `sq` reads the source at a point
  // scaled toward the window centre `pan`. scale>1 magnifies (smaller window).
  float invScale = (scale > 1e-4) ? (1.0 / scale) : 1.0;
  float2 src_sq = sq * invScale + float2(pan_x, pan_y);
  float2 src_uv = nano_cover_square_to_uv(src_sq, aspect);
  float4 color = inputTex.SampleLevel(samp, src_uv, 0.0);  // ClampToEdge sampler

  // Gizmo outline box, centred at the frame centre, nudged by motion.
  if (giz_show > 0.5 && giz_alpha > 0.0) {
    float2 p = sq - float2(giz_off_x, giz_off_y);
    float d = abs(sdBox(p, float2(giz_hw, giz_hh)));   // distance to the outline
    // Anti-aliased line of half-thickness giz_thick (one texel feather).
    float aa = 1.5 * aspect_y * 2.0 / float(h);
    float edge = 1.0 - smoothstep(giz_thick, giz_thick + aa, d);
    float a = edge * giz_alpha;
    color.rgb = lerp(color.rgb, float3(giz_r, giz_g, giz_b), a);
  }

  outputTex[gid.xy] = color;
}
