// triangulate — P0 passthrough. Copies tex_in -> tex_out so the effect is a
// no-op stage while the rest of the pipeline is built up phase by phase.
Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = inputTex[gid.xy];
}
