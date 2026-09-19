// output_blit.hlsl — the executor's resample + format-convert output blit.
//
// ONE authored source for all three backends: DXC bakes this to SPIR-V at
// build time (build_shaders.sh) and the host translates it at PSO-build time
// to MSL / HLSL / WGSL, exactly as effect shaders already do. See
// host_output_blit.h for the pass itself.
//
// Register numbers ARE the binding slots the host passes to
// gpu_compute_set_texture / gpu_compute_set_buffer: t0 src, u1 out, b2 uniform.
// Textures first, uniform after — WebGPU's auto-layout shares one @binding
// namespace per group, so a uniform at 0 would collide with a texture at 0.

Texture2D<float4>   src_tex : register(t0);
RWTexture2D<float4> out_tex : register(u1);

cbuffer U : register(b2) {
  uint dw;  // destination width
  uint dh;  // destination height
  uint sw;  // source width
  uint sh;  // source height
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= dw || gid.y >= dh) return;
  // Bilinear by 4 manual taps — the exec ABI has no sampler imports.
  float2 srcPos = (float2(gid.xy) + 0.5) * float2(sw, sh) / float2(dw, dh) - 0.5;
  float2 f = frac(srcPos);
  int2 p0 = int2(floor(srcPos));
  int2 p1 = min(p0 + 1, int2(sw - 1, sh - 1));
  p0 = max(p0, int2(0, 0));
  float4 c00 = src_tex.Load(int3(p0, 0));
  float4 c10 = src_tex.Load(int3(p1.x, p0.y, 0));
  float4 c01 = src_tex.Load(int3(p0.x, p1.y, 0));
  float4 c11 = src_tex.Load(int3(p1, 0));
  out_tex[gid.xy] = lerp(lerp(c00, c10, f.x), lerp(c01, c11, f.x), f.y);
}
