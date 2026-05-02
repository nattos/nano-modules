// debug.hdr_test — Round-trip an HDR intermediate.
//
// Same source compiled twice with different output storage formats:
//   COMPUTE_OUT16F_*  — outputs to rgba16float (HDR scratch)
//   COMPUTE_OUT8_*    — outputs to rgba8unorm  (final visible target)
//
// The shader simply scales the input by `gain` and writes it. With a
// gain >1.0 going into an 8-bit output the values clip; with a gain >1.0
// going into rgba16float they survive, and a second pass with gain=1/gain
// recovers the original. So the test is:
//
//   pass 1: gain=4.0 into rgba16float scratch
//   pass 2: gain=0.25 into rgba8unorm output
//
// If the platform really gives us float16: input(0.5) → scratch(2.0) →
// output(0.5). If it silently downgraded to 8-bit: input(0.5) → scratch
// clips to 1.0 → output(0.25). The pixel-level diff makes the test trivial.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float gain;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float4 c = inputTex[gid.xy];
  outputTex[gid.xy] = float4(c.rgb * gain, c.a);
}
