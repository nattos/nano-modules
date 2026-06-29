// filter.legacy.subtle_blur — chromatic-offset pass.
//
// Reads the (already blurred) image and splits the colour channels along a
// SINGLE fixed slanted axis: red shifts one way, blue the other, green stays
// put — a chromatic dispersion along the slant (the axis angle is `hue`). The
// split WIDTH (`spread`) is animated in main.cpp by a sawtooth: it ramps up
// then HARD-RESETS periodically (intentional), amplitude set by `movement`.
//
// `off` is aspect-corrected (× min(W,H)/dim per axis) so the slant looks the
// same on any aspect ratio.

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float aspect_x;   // min(W,H)/W
  float aspect_y;   // min(W,H)/H
  float axis_x;     // slant unit direction
  float axis_y;
  float spread;     // chroma half-spread along the axis (uv); can ramp/reset
  float _p0, _p1, _p2;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv  = (float2(gid.xy) + 0.5) / float2(W, H);
  float2 off = float2(axis_x, axis_y) * spread * float2(aspect_x, aspect_y);

  float r = inputTex.SampleLevel(linearSampler, uv + off, 0.0).r;
  float g = inputTex.SampleLevel(linearSampler, uv,       0.0).g;
  float b = inputTex.SampleLevel(linearSampler, uv - off, 0.0).b;
  float a = inputTex.SampleLevel(linearSampler, uv,       0.0).a;

  outputTex[gid.xy] = float4(r, g, b, a);
}
