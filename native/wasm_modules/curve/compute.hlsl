// video.curve — Power curve applied to RGB and alpha.
//
// The host pre-computes the exponents (rgb_exp, alpha_exp) so the slider's
// signed range maps to a symmetric, continuous response: -1 → exp 8 (squash
// down), 0 → exp 1 (identity), +1 → exp 1/8 (squash up).

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float rgb_exp;
  float alpha_exp;
  float2 _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  // pow() of negative inputs is undefined; clamp to [0, 1] before exponentiating.
  float3 rgb = pow(saturate(c.rgb), rgb_exp);
  float a   = pow(saturate(c.a),   alpha_exp);
  outputTex[gid.xy] = float4(rgb, a);
}
