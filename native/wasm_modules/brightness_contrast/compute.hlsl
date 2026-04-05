// Brightness/Contrast — Compute Shader
//
// Reads input texture, applies brightness and contrast adjustments,
// writes to output texture.
//
// Brightness: 0-1 param, 0.5 = neutral. Adds [-1, +1] to RGB.
// Contrast:   0-1 param, 0.5 = neutral (1x). 0 = pure black. 1 = 2x.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float brightness;
  float contrast;
  float2 _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 rgb = c.rgb;
  rgb += (brightness - 0.5) * 2.0;  // brightness: shift RGB by [-1, +1]
  rgb *= contrast * 2.0;            // contrast: scale from black (0=black, 0.5=identity, 1=2x)
  outputTex[gid.xy] = float4(saturate(rgb), c.a);
}
