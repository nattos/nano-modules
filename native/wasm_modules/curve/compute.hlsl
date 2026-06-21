// color.tone.curve — standalone compute wrapper. Per-pixel logic in pixel.hlsl.

#include "pixel.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = fuse_transform(gid.xy, inputTex[gid.xy]);
}
