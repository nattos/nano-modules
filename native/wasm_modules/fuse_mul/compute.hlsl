// debug.fuse_mul — standalone compute wrapper. Per-pixel math lives in
// pixel.hlsl so the runtime fuser can splice it in.

#include "pixel.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float4 c = inputTex[gid.xy];
  outputTex[gid.xy] = fuse_transform(gid.xy, c);
}
