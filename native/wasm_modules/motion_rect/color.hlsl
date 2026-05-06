// debug.motion_rect — color pass.
//
// Reads tex_in, alpha-blends a colored rectangle on top whose center
// moves from (cx_prev, cy_prev) to (cx, cy) each frame. Pixels outside
// the rect receive the input verbatim; pixels inside are mixed with
// the rect color according to `opacity` (0 = invisible rect, 1 = fully
// opaque rect). Output alpha is the input alpha — opacity is purely a
// compositing-strength control on the RGB blend.
//
// The motion pass writes velocity at full strength regardless of
// opacity, so a mostly-transparent rect still drives the downstream
// motion-blur exactly the same way as an opaque one. That separation
// is the whole point: the test harness can observe how the underlying
// background texture is affected by motion blur without the rect
// itself dominating the output.
//
// Coordinates are in normalized [0, 1] uv space.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float cx;
  float cy;
  float cx_prev;
  float cy_prev;
  float half_w;     // half-width in uv space
  float half_h;     // half-height in uv space
  float _pad0;
  float _pad1;
  float color_r;
  float color_g;
  float color_b;
  float opacity;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base = inputTex[gid.xy];

  bool inside = (uv.x >= cx - half_w) && (uv.x <= cx + half_w)
             && (uv.y >= cy - half_h) && (uv.y <= cy + half_h);
  float3 rect_rgb = float3(color_r, color_g, color_b);
  float3 blended = lerp(base.rgb, rect_rgb, saturate(opacity));
  float3 rgb = inside ? blended : base.rgb;
  outputTex[gid.xy] = float4(rgb, base.a);
}
