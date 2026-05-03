// video.color_space — Convert RGB between encodings.
//
// in_space and out_space are independent: 0 = sRGB, 1 = Linear.
// The shader always routes input → linear (canonical) → output, so
// any combination including identity (in == out) works without
// special-casing. Alpha is passed through untouched.

Texture2D<float4> inputTex   : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  int in_space;
  int out_space;
  int _pad0;
  int _pad1;
};

// IEC 61966-2-1 sRGB EOTF (display → linear). Per-channel.
float3 srgb_to_linear(float3 c) {
  c = saturate(c);
  float3 lo = c / 12.92;
  float3 hi = pow((c + 0.055) / 1.055, 2.4);
  return lerp(lo, hi, step(0.04045, c));
}

// IEC 61966-2-1 sRGB inverse EOTF (linear → display).
float3 linear_to_srgb(float3 c) {
  c = saturate(c);
  float3 lo = c * 12.92;
  float3 hi = 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  return lerp(lo, hi, step(0.0031308, c));
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  float3 rgb = c.rgb;

  // Decode to linear (the canonical intermediate).
  if (in_space == 0) rgb = srgb_to_linear(rgb);

  // Encode to the requested output space.
  if (out_space == 0) rgb = linear_to_srgb(rgb);

  outputTex[gid.xy] = float4(rgb, c.a);
}
