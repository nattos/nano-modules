// debug.lut3d_test — pass 1: fill a 16^3 identity color LUT.
//
// Authored as HLSL → SPV → {MSL native, WGSL web}. The storage format is
// rgba8unorm, substituted into the WGSL `texture_storage_3d<...,write>` at
// registerShaderSPV time (DXC emits an unannotated rgba32float storage image;
// the naga bridge rewrites it on web, and Metal takes the format from the
// bound LUT texture). Each cell (x,y,z) gets (x/(N-1), y/(N-1), z/(N-1), 1).
RWTexture3D<float4> lut : register(u0);

// 16³ LUT. The dispatch covers exactly N³ threads, and querying the
// dimensions of a write-access storage texture isn't portable across
// SPIRV-Cross/Metal, so the dimension is a compile-time constant here.
static const uint N = 16u;

[numthreads(4, 4, 4)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= N || gid.y >= N || gid.z >= N) return;
  float inv = 1.0 / float(N - 1u);
  lut[gid] = float4(float(gid.x) * inv, float(gid.y) * inv, float(gid.z) * inv, 1.0);
}
