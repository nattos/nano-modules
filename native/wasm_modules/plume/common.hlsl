// source.sdf.plume — shared constants + mappings.
//
// World space: x right, y up, z into the screen (monolith convention);
// object centered at origin. The tier-0 volume is the cube
// [-PLM_EXT0, PLM_EXT0]³; distances in the SDF volume are WORLD units
// (already Lipschitz-compressed at bake so trilinear sphere-tracing with
// a modest safety factor cannot overshoot).
//
// 3D texture sizes are compile-time constants (querying a 3D storage
// texture's dimensions is non-portable — see lut_collection).

#ifndef PLUME_COMMON_HLSL
#define PLUME_COMMON_HLSL

#include "nano_octahedral.hlsl"

static const int   PLM_VOL_RES  = 128;   // tier-0 sdf volume, per axis
static const int   PLM_GI_RES   = 64;    // tier-0 radiance volume, per axis
static const float PLM_EXT0     = 0.85;  // tier-0 half-extent, world units
static const int   PLM_SHELL_RES  = 1024; // shell_full
static const int   PLM_COARSE_RES = 256;  // shell_coarse

// World position -> tier-0 volume uvw in [0,1]³.
float3 plm_world_to_uvw(float3 p) {
  return p * (0.5 / PLM_EXT0) + 0.5;
}

// Tier-0 voxel index -> world position of the voxel center.
float3 plm_voxel_to_world(int3 v) {
  return ((float3(v) + 0.5) * (1.0 / float(PLM_VOL_RES)) - 0.5)
         * (2.0 * PLM_EXT0);
}

#endif // PLUME_COMMON_HLSL
