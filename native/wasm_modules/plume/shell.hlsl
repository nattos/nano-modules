// source.sdf.plume — shell update: author the displacement field on the
// octahedral S² map.
//
// One shader, dispatched TWICE per frame: once at PLM_SHELL_RES writing
// shell_full (all octaves), once at PLM_COARSE_RES writing shell_coarse
// (octave count capped to what the 128³ bake grid can carry without
// aliasing). Both evaluate the SAME field — the march's detail tier
// reconstructs the residual as full − coarse, so the two tiers can never
// disagree about where the surface is.
//
// Channels: .r = radial displacement h (world units, ≥ 0),
//           .g = crest emphasis (drives material/emission later),
//           .ba = reserved for shell sim state (v1: zero).

#include "common.hlsl"
#include "nano_noise3.hlsl"

RWTexture2D<float4> shellTex : register(u0);

cbuffer ShellUniforms : register(b1) {
  float res;         // target resolution (PLM_SHELL_RES or PLM_COARSE_RES)
  float octaves;     // octave cap for this target
  float ridge_scale; // base spatial frequency on the sphere
  float ridge_amp;   // displacement amplitude, world units
  float ridge_sharp; // 0 round bumps .. 1 knife ridges
  float morph;       // domain-shift accumulator (wrapped CPU-side)
  float seed;        // variation offset
  float _pad0;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  int R = int(res);
  if (gid.x >= (uint)R || gid.y >= (uint)R) return;

  float2 uv = (float2(gid.xy) + 0.5) / res;
  float3 dir = nano_oct_decode(uv);

  // Milestone-1 field: isotropic ridged fbm on the sphere, morphing by a
  // slow domain drift. Anisotropic swirl stretching lands with the
  // surface-look milestone.
  float3 p = dir * ridge_scale + float3(seed * 37.7, morph, seed * 11.3);
  float h = nano_ridge3(p, int(octaves), 0.55, ridge_sharp);

  shellTex[gid.xy] = float4(h * ridge_amp, h, 0.0, 0.0);
}
