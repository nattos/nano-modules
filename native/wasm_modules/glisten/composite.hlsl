// filter.legacy.glisten — final composite.
//
// out = input × input_alpha + blurredSparkles × tint  (the original's Add
// mix). The sparkle layer is half-res, linearly upsampled here; its rgb may
// be negative, digging colour out of the input.

Texture2D<float4>   inputTex : register(t0);
Texture2D<float4>   sparkTex : register(t1);
SamplerState        samp     : register(s2);
RWTexture2D<float4> outTex   : register(u3);

cbuffer U : register(b4) {
  float input_alpha;
  float tint_r, tint_g, tint_b;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base  = inputTex[gid.xy] * input_alpha;
  float4 spark = sparkTex.SampleLevel(samp, uv, 0);
  spark.rgb *= float3(tint_r, tint_g, tint_b);
  outTex[gid.xy] = base + spark;
}
