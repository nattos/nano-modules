// debug.motion_rect — color pass.
//
// Reads tex_in, overlays a colored rectangle whose center moves from
// (cx_prev, cy_prev) to (cx, cy) each frame. Pixels outside the rect
// receive the input verbatim; pixels inside are alpha-blended with the
// rect color. Coordinates are in normalized [0, 1] uv space.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float cx;
  float cy;
  float cx_prev;
  float cy_prev;
  float half_w;     // half-width in uv space
  float half_h;     // half-height in uv space
  float color_r;
  float color_g;
  float color_b;
  float _pad0;
  float _pad1;
  float _pad2;
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
  float3 rgb = inside ? float3(color_r, color_g, color_b) : base.rgb;
  outputTex[gid.xy] = float4(rgb, base.a);
}
