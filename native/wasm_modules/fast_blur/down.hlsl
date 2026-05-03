// 13-tap downsample (Jorge Jimenez, "Next Generation Post Processing in
// Call of Duty: Advanced Warfare", SIGGRAPH 2014).
//
// Reads from `srcTex` at LOD `src_mip`, writes to a smaller storage
// target. Sample positions use the source's texel size (`src_texel`).
//
// 9 outer taps in a 3×3 grid at ±2 source-texel offsets, plus 4 inner
// taps at ±1. Combined with bilinear sampling each tap is the average
// of a 2×2 source-texel block, so the kernel covers a 5×5 source area
// with smooth weights and no banding.

Texture2D<float4>   srcTex   : register(t0);
RWTexture2D<float4> dstTex   : register(u1);
SamplerState        samp     : register(s2);

cbuffer Uniforms : register(b3) {
  // src_texel_x/y = 1.0 / source-mip dimensions. The source binding
  // is always a single-mip view (via setTextureMip on the host), so
  // the shader samples at LOD 0 of that view regardless of which
  // texture mip it's actually pointed at.
  float src_texel_x;
  float src_texel_y;
  float _pad0;
  float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint dw, dh;
  dstTex.GetDimensions(dw, dh);
  if (gid.x >= dw || gid.y >= dh) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(dw, dh);
  float2 t = float2(src_texel_x, src_texel_y);
  float lod = 0.0;  // single-mip view → always level 0

  // Outer 3×3 grid (±2 source texels)
  float4 a = srcTex.SampleLevel(samp, uv + t * float2(-2,  2), lod);
  float4 b = srcTex.SampleLevel(samp, uv + t * float2( 0,  2), lod);
  float4 c = srcTex.SampleLevel(samp, uv + t * float2( 2,  2), lod);
  float4 d = srcTex.SampleLevel(samp, uv + t * float2(-2,  0), lod);
  float4 e = srcTex.SampleLevel(samp, uv,                       lod);
  float4 f = srcTex.SampleLevel(samp, uv + t * float2( 2,  0), lod);
  float4 g = srcTex.SampleLevel(samp, uv + t * float2(-2, -2), lod);
  float4 h = srcTex.SampleLevel(samp, uv + t * float2( 0, -2), lod);
  float4 i = srcTex.SampleLevel(samp, uv + t * float2( 2, -2), lod);
  // Inner 2×2 (±1 source texel)
  float4 j = srcTex.SampleLevel(samp, uv + t * float2(-1,  1), lod);
  float4 k = srcTex.SampleLevel(samp, uv + t * float2( 1,  1), lod);
  float4 l = srcTex.SampleLevel(samp, uv + t * float2(-1, -1), lod);
  float4 m = srcTex.SampleLevel(samp, uv + t * float2( 1, -1), lod);

  // Weights from overlapping 2×2 box averages:
  //   - inner block (j,k,l,m) → 0.5 total = 0.125 each
  //   - center tap e         → present in all 4 outer 2×2 blocks (0.125)
  //   - edge taps b,d,f,h    → 2 outer blocks each   (0.0625)
  //   - corner taps a,c,g,i  → 1 outer block each    (0.03125)
  // Sum = 1.0.
  float4 result = (j + k + l + m) * 0.125
                + e * 0.125
                + (b + d + f + h) * 0.0625
                + (a + c + g + i) * 0.03125;
  dstTex[gid.xy] = result;
}
