// generator.gradient — standalone compute wrapper for a strict-output generator.
// Per-pixel logic in pixel.hlsl.

#include "pixel.hlsl"

RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = fuse_transform(gid.xy, uint2(w, h));
}
