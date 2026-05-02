// video.levels — Input/output remap with gamma midtone.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float in_low;
  float in_high;
  float gamma_exp;
  float out_low;
  float out_high;
  float _pad_y;
  float _pad_z;
  float _pad_w;
};

float3 apply_levels(float3 c) {
  float range = max(in_high - in_low, 1e-4);
  float3 x = saturate((c - in_low) / range);
  x = pow(x, gamma_exp);
  return lerp(out_low, out_high, x);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 rgb = apply_levels(c.rgb);
  outputTex[gid.xy] = float4(saturate(rgb), c.a);
}
