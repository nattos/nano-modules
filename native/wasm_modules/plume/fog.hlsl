// source.sdf.plume — volumetric atmosphere (half-res ray march).
//
// Marches the fog domain (a sphere of world air around the object, out to
// PLM_FOG_EXT) front-to-back, stopping at the surface depth the march
// pass recorded. Two density terms:
//   shell haze — exp(−d/σ) hugging the displaced surface. Inside the
//     tier-0 box d comes from the SDF grid (detailed); outside, the
//     displacement is irrelevant at haze scales, so d = |p| − R
//     analytically — the "tier-1" density needs no baked volume.
//   room floor — a thin constant medium for depth.
// Lighting per step: ambient + the wave-GI radiance field (the fog is
// GI-lit for free — light bleeds from the shape into the haze, and at
// high resonance the haze RINGS) + direct sun with a Henyey-Greenstein
// phase and a cheap 2-tap occlusion toward the sun (soft shaft hints).
// Output: (in-scattered light, transmittance) — composited full-res by
// composite.hlsl with a bilinear (fog is soft) upsample.

#include "common.hlsl"
#include "nano_hash.hlsl"

static const float PLM_FOG_EXT = 3.2;   // fog domain radius, world units

Texture3D<float4>   sdfVol     : register(t0);
Texture3D<float4>   radVol     : register(t1);
Texture2D<float4>   sceneTex   : register(t2);   // .a = hit distance
SamplerState        linearSamp : register(s3);
RWTexture2D<float4> fogTex     : register(u4);

cbuffer FogUniforms : register(b5) {
  float4 cam_row0;    // view right (world), w = cam_pos.x
  float4 cam_row1;    // view up (world),    w = cam_pos.y
  float4 cam_row2;    // view fwd (world),   w = cam_pos.z
  float4 cam_p;       // focal, cover_ax, cover_ay, R (base radius)
  float4 sun_p;       // sun dir (world, toward light), w = intensity
  float4 fog_p;       // shell gain, inv_soft, room gain, phase g
  float4 misc;        // inv_lip, ambient, bounce, 0
  float4 vp;          // half W, half H, 1/(half W), 1/(half H)
};

bool plm_sphere(float3 ro, float3 rd, float rad, out float t0, out float t1) {
  t0 = 0.0;
  t1 = 0.0;
  float b = dot(ro, rd);
  float cc = dot(ro, ro) - rad * rad;
  float disc = b * b - cc;
  if (disc < 0.0) return false;
  float sq = sqrt(disc);
  t0 = -b - sq;
  t1 = -b + sq;
  return t1 > 0.0;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W = (uint)vp.x, H = (uint)vp.y;
  if (gid.x >= W || gid.y >= H) return;

  float2 uv = (float2(gid.xy) + 0.5) * vp.zw;
  float2 ndc = float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  float3 V = normalize(float3(ndc.x / (2.0 * cam_p.y * cam_p.x),
                              ndc.y / (2.0 * cam_p.z * cam_p.x), 1.0));
  float3 rd = normalize(cam_row0.xyz * V.x + cam_row1.xyz * V.y +
                        cam_row2.xyz * V.z);
  float3 ro = float3(cam_row0.w, cam_row1.w, cam_row2.w);

  // Surface depth from the (full-res) scene buffer.
  float depth = sceneTex.Load(int3(int(gid.x) * 2, int(gid.y) * 2, 0)).a;

  float t0, t1;
  if (!plm_sphere(ro, rd, PLM_FOG_EXT, t0, t1)) {
    fogTex[gid.xy] = float4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  t0 = max(t0, 0.0);
  t1 = min(t1, depth);
  if (t1 <= t0) {
    fogTex[gid.xy] = float4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  const int STEPS = 36;
  float dt = (t1 - t0) / float(STEPS);
  float jitter = nano_hash21(float2(gid.xy));
  float t = t0 + dt * jitter;

  // Henyey-Greenstein phase for the direct term.
  float g = fog_p.w;
  float cosv = dot(rd, sun_p.xyz);
  float hg = (1.0 - g * g) /
             max(pow(1.0 + g * g - 2.0 * g * cosv, 1.5), 1e-3) * 0.25;

  float3 acc = float3(0.0, 0.0, 0.0);
  float trans = 1.0;
  [loop] for (int i = 0; i < STEPS; i++) {
    float3 p = ro + rd * t;

    // Shell-hug distance: grid inside the tier-0 box, analytic outside.
    float d;
    bool in0 = abs(p.x) < PLM_EXT0 && abs(p.y) < PLM_EXT0 && abs(p.z) < PLM_EXT0;
    if (in0) d = sdfVol.SampleLevel(linearSamp, plm_world_to_uvw(p), 0).r * misc.x;
    else     d = length(p) - cam_p.w;

    float sigma = fog_p.x * exp2(-max(d, 0.0) * fog_p.y)
                + fog_p.z * 0.22;
    if (sigma > 1e-4) {
      // Direct sun with a 2-tap occlusion through the shape.
      float occ = 1.0;
      float3 s1 = p + sun_p.xyz * 0.22;
      float3 s2 = p + sun_p.xyz * 0.55;
      if (abs(s1.x) < PLM_EXT0 && abs(s1.y) < PLM_EXT0 && abs(s1.z) < PLM_EXT0)
        occ *= saturate(sdfVol.SampleLevel(linearSamp, plm_world_to_uvw(s1), 0).r
                        * misc.x * 14.0 + 0.5);
      if (abs(s2.x) < PLM_EXT0 && abs(s2.y) < PLM_EXT0 && abs(s2.z) < PLM_EXT0)
        occ *= saturate(sdfVol.SampleLevel(linearSamp, plm_world_to_uvw(s2), 0).r
                        * misc.x * 14.0 + 0.5);

      float3 gi = float3(0.0, 0.0, 0.0);
      if (misc.z > 0.001 && in0)
        gi = radVol.SampleLevel(linearSamp, plm_world_to_uvw(p), 0).rgb * misc.z;

      float3 light = misc.y.xxx * 0.35
                   + gi
                   + (sun_p.w * hg * occ).xxx;
      float a = 1.0 - exp2(-sigma * dt * 1.4427);   // 1 - e^(-sigma dt)
      acc += trans * a * light;
      trans *= 1.0 - a;
      if (trans < 0.01) break;
    }
    t += dt;
  }

  fogTex[gid.xy] = float4(acc, trans);
}
