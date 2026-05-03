// 9-tap tent upsample (Jorge Jimenez SIGGRAPH 2014).
//
// 3×3 sample pattern centered on the destination pixel, in source-uv
// space, with offsets equal to one source texel. Bilinear sampling
// blends the smaller mip's neighbouring texels; the 1/2/4 tent
// weights smooth the upscale and prevent the boxy artifacts of a
// straight bilinear stretch.

Texture2D<float4>   srcTex   : register(t0);
RWTexture2D<float4> dstTex   : register(u1);
SamplerState        samp     : register(s2);

cbuffer Uniforms : register(b3) {
  // See down.hlsl — source binding is single-mip, so always sample
  // at view-level 0.
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

  float4 t0 = srcTex.SampleLevel(samp, uv + t * float2(-1,  1), lod);
  float4 t1 = srcTex.SampleLevel(samp, uv + t * float2( 0,  1), lod);
  float4 t2 = srcTex.SampleLevel(samp, uv + t * float2( 1,  1), lod);
  float4 t3 = srcTex.SampleLevel(samp, uv + t * float2(-1,  0), lod);
  float4 t4 = srcTex.SampleLevel(samp, uv,                       lod);
  float4 t5 = srcTex.SampleLevel(samp, uv + t * float2( 1,  0), lod);
  float4 t6 = srcTex.SampleLevel(samp, uv + t * float2(-1, -1), lod);
  float4 t7 = srcTex.SampleLevel(samp, uv + t * float2( 0, -1), lod);
  float4 t8 = srcTex.SampleLevel(samp, uv + t * float2( 1, -1), lod);

  // Tent: corners 1/16, edges 2/16, center 4/16. Sum = 1.
  float4 result = (t0 + t2 + t6 + t8) * (1.0 / 16.0)
                + (t1 + t3 + t5 + t7) * (2.0 / 16.0)
                + t4 * (4.0 / 16.0);
  dstTex[gid.xy] = result;
}
