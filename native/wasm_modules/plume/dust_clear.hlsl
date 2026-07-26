// source.sdf.plume — dust splat pass 0: reset the depth-resolve buffer
// to "no particle" (all ones — InterlockedMin with asuint(t) of any
// positive float beats it).

RWStructuredBuffer<uint> depthBuf : register(u0);

cbuffer DustClearUniforms : register(b1) {
  float count;   // pixel count (exact in float below 2^24)
  float _p0, _p1, _p2;
};

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= (uint)count) return;
  depthBuf[gid.x] = 0xFFFFFFFFu;
}
