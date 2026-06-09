// gen.tingle_top — prefill pass. Copies tex_in into tex_out so the instanced
// sparkle quads (next pass) blend ADDITIVELY over the input. Also draws the
// optional debug region line at region_y_max.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  uint  debug_region;
  float region_y_max;
  float _pad0;
  float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float4 c = inputTex[gid.xy];
  if (debug_region != 0u) {
    float uy = (float(gid.y) + 0.5) / float(H);
    if (abs(uy - region_y_max) < (1.5 / float(H))) c.rgb = saturate(c.rgb + float3(0.0, 0.25, 0.25));
  }
  outputTex[gid.xy] = c;
}
