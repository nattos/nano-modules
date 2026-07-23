// source.sdf.plume — shell update: author the displacement field on the
// octahedral S² map.
//
// One shader, dispatched TWICE per frame: once at PLM_SHELL_RES writing
// shell_full (all octaves), once at PLM_COARSE_RES writing shell_coarse
// (octave count capped to what the 128³ bake grid can carry without
// aliasing). Both evaluate the SAME field — the march's detail tier uses
// the full map directly, so the two tiers can never disagree about where
// the surface is.
//
// The feather/shingle anisotropy: ridges are stretched along a FLOW
// direction tangent to the sphere — a swirl field around a tilted axis,
// bent per-point by a low-frequency wobble so the flow lines meander like
// wind. Implemented as domain compression: the noise-domain component
// along the flow tangent is divided by (1 + aniso), so features elongate
// along the flow.
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
  float morph_x;     // closed-circle domain drift (x component)
  float seed;        // variation offset
  float morph_z;     // closed-circle domain drift (z component)
  float aniso;       // flow-direction stretch factor (0 = isotropic)
  float swirl;       // flow direction angle around the local normal
  float wobble;      // low-freq flow meander amount
  float _pad0;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  int R = int(res);
  if (gid.x >= (uint)R || gid.y >= (uint)R) return;

  float2 uv = (float2(gid.xy) + 0.5) / res;
  float3 dir = nano_oct_decode(uv);

  // Flow tangent: swirl around the (tilted) y axis, rotated in the tangent
  // plane by `swirl` + a low-frequency wobble. Poles of the swirl axis
  // fall back smoothly to an arbitrary tangent.
  float3 axis = normalize(float3(0.25, 1.0, 0.1));
  float3 t1 = cross(axis, dir);
  float t1l = length(t1);
  float3 alt = cross(float3(1.0, 0.0, 0.0), dir);
  t1 = t1l > 0.05 ? t1 / t1l : normalize(alt);
  float3 t2 = cross(dir, t1);

  float ang = swirl * 3.14159265
            + wobble * 2.2 * nano_gnoise3(dir * 2.3 + float3(seed * 7.3, morph_x * 0.2, morph_z * 0.2));
  float ca = cos(ang), sa = sin(ang);
  float3 flow = t1 * ca + t2 * sa;         // elongate ALONG this
  float3 perp = -t1 * sa + t2 * ca;        // ...compress across this

  // Noise domain: stretch ALONG the flow (divide that component's
  // frequency) and squeeze ACROSS it (multiply), so features elongate
  // into wind-swept shingles. Elongation ratio ~ (1 + 2.5·aniso)².
  float3 p = dir * ridge_scale + float3(seed * 37.7, 0.0, seed * 11.3)
           + float3(morph_x, 0.0, morph_z);
  float along = 1.0 + 2.5 * aniso;
  float across = 1.0 + 2.5 * aniso;
  float3 q = p - flow * dot(p, flow) * (1.0 - 1.0 / along)
               + perp * dot(p, perp) * (across - 1.0);

  // The plate/petal look: a SMOOTH low-octave field cut into terraces —
  // broad smooth lobes separated by sharp cliff edges (the overlapping
  // plate rims of the reference look), NOT many-octave fur. `ridge_sharp`
  // steepens the cliffs; a faint ridged top-layer keeps the plates from
  // reading plastic.
  float n = 0.5 + 0.5 * nano_gfbm3(q, int(octaves), 0.5);
  float levels = 4.0;
  float tn = n * levels;
  float f = frac(tn);
  // Smooth plateau -> cliff profile: stays flat, then commits.
  float cliff = lerp(3.0, 14.0, ridge_sharp);
  float step_s = f * f * (3.0 - 2.0 * f);
  step_s = pow(step_s, cliff * 0.5) /
           (pow(step_s, cliff * 0.5) + pow(1.0 - step_s, cliff * 0.5));
  float h = (floor(tn) + step_s) / levels;
  h += 0.04 * (1.0 - abs(nano_gnoise3(q * 2.2 + 5.0)));   // faint top texture
  h = saturate(h * 0.96);

  shellTex[gid.xy] = float4(h * ridge_amp, h, 0.0, 0.0);
}
