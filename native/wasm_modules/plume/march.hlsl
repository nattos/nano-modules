// source.sdf.plume — primary march (milestone-1 form).
//
// Full-res compute: per pixel, build the camera ray (inverse of the
// monolith projection), intersect the tier-0 volume cube, sphere-trace the
// trilinear SDF, shade hits with a simple sun lambert + fresnel rim, and
// composite over the input. The G-buffer split, detail-tier refinement,
// GI ambient and volumetrics replace the tail of this shader in later
// milestones — the ray/trace core stays.

#include "common.hlsl"

Texture3D<float4>   sdfVol     : register(t0);
Texture2D<float4>   bgTex      : register(t1);
SamplerState        linearSamp : register(s2);
RWTexture2D<float4> outTex     : register(u3);

cbuffer MarchUniforms : register(b4) {
  float4 cam_row0;    // world = R * view: row 0, w = cam_pos.x
  float4 cam_row1;    // row 1, w = cam_pos.y
  float4 cam_row2;    // row 2, w = cam_pos.z
  float4 cam_p;       // focal, cover_ax, cover_ay, has_bg
  float4 sun_p;       // sun dir (world, toward light), w = intensity
  float4 albedo;      // rgb, w = opacity
  float4 vp;          // w, h, 1/w, 1/h
};

// Ray / axis-aligned cube [-PLM_EXT0, PLM_EXT0]³ intersection.
bool plm_box(float3 ro, float3 rd, out float t0, out float t1) {
  float3 inv = 1.0 / rd;   // inf on axis-parallel components is fine here
  float3 ta = (-PLM_EXT0 - ro) * inv;
  float3 tb = ( PLM_EXT0 - ro) * inv;
  float3 tmin = min(ta, tb), tmax = max(ta, tb);
  t0 = max(max(tmin.x, tmin.y), tmin.z);
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  return t1 > max(t0, 0.0);
}

float plm_sdf(float3 p) {
  return sdfVol.SampleLevel(linearSamp, plm_world_to_uvw(p), 0).r;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W = (uint)vp.x, H = (uint)vp.y;
  if (gid.x >= W || gid.y >= H) return;

  float4 bg = cam_p.w > 0.5 ? bgTex.Load(int3(int(gid.x), int(gid.y), 0))
                            : float4(0.0, 0.0, 0.0, 0.0);

  // Pixel -> y-up NDC -> view ray -> world ray (monolith projection inverse).
  float2 uv = (float2(gid.xy) + 0.5) * vp.zw;
  float2 ndc = float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  float3 V = normalize(float3(ndc.x / (2.0 * cam_p.y * cam_p.x),
                              ndc.y / (2.0 * cam_p.z * cam_p.x), 1.0));
  float3 rd = normalize(cam_row0.xyz * V.x + cam_row1.xyz * V.y +
                        cam_row2.xyz * V.z);
  float3 ro = float3(cam_row0.w, cam_row1.w, cam_row2.w);

  float t0, t1;
  if (!plm_box(ro, rd, t0, t1)) {
    outTex[gid.xy] = bg;
    return;
  }

  const float voxel = 2.0 * PLM_EXT0 / float(PLM_VOL_RES);
  const float eps = 0.35 * voxel;
  float t = max(t0, 0.0) + 0.5 * voxel;
  bool hit = false;
  float d = 1e5;
  [loop] for (int i = 0; i < 160; i++) {
    if (t > t1) break;
    d = plm_sdf(ro + rd * t);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.9, 0.3 * voxel);
  }

  if (!hit) {
    outTex[gid.xy] = bg;
    return;
  }

  float3 hp = ro + rd * t;
  float e = voxel;
  float3 N = normalize(float3(
      plm_sdf(hp + float3(e, 0, 0)) - plm_sdf(hp - float3(e, 0, 0)),
      plm_sdf(hp + float3(0, e, 0)) - plm_sdf(hp - float3(0, e, 0)),
      plm_sdf(hp + float3(0, 0, e)) - plm_sdf(hp - float3(0, 0, e))));

  // Milestone-1 shade: sun lambert + wrapped fill + fresnel rim.
  float lam = saturate(dot(N, sun_p.xyz));
  float wrap = 0.5 + 0.5 * dot(N, sun_p.xyz);
  float ndv = saturate(dot(N, -rd));
  float rim = pow(1.0 - ndv, 3.0);
  float crest = sdfVol.SampleLevel(linearSamp, plm_world_to_uvw(hp), 0).b;

  float3 c = albedo.rgb * sun_p.w *
             (0.12 + 0.68 * lam + 0.20 * wrap * wrap) *
             (0.75 + 0.25 * crest);
  c += rim * 0.10 * sun_p.w;

  float w = albedo.w;
  outTex[gid.xy] = float4(lerp(bg.rgb, c, w), max(bg.a, w));
}
