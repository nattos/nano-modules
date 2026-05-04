// debug.fuse_solid — standalone compute wrapper for the strict-output
// generator. The per-pixel kernel lives in pixel.hlsl; this file just
// supplies the texture bindings and fans gid through the same
// fuse_transform the runtime fuser splices in.

#include "pixel.hlsl"

RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = fuse_transform(gid.xy, uint2(w, h));
}
