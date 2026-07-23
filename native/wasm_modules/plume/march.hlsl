// source.sdf.plume — primary march (milestone 2: two-tier + lit).
//
// Full-res compute: camera ray → tier-0 volume cube → COARSE sphere-trace
// on the trilinear SDF grid → inside a narrow band, FINE stepping against
// the exact shell-map surface (radial distance from shell_full — the same
// data the grid was baked from, so the tiers can't disagree) → shade with
// sun key (soft-shadow marched through the grid), grid AO, hemispheric
// fill, fresnel rim → gentle shoulder tonemap → composite over the input.
//
// The fine distance is a TRUE radial distance, not a Euclidean bound, so
// the fine phase never takes d-sized steps — it creeps in fixed fractions
// of a voxel and finishes with a short bisection. Fine evals cost one 2D
// texture sample, cheaper than a grid tap chain.

#include "common.hlsl"

Texture3D<float4>   sdfVol     : register(t0);
Texture2D<float4>   bgTex      : register(t1);
Texture2D<float4>   shellFull  : register(t2);
SamplerState        linearSamp : register(s3);
RWTexture2D<float4> outTex     : register(u4);

cbuffer MarchUniforms : register(b5) {
  float4 cam_row0;    // view right (world), w = cam_pos.x
  float4 cam_row1;    // view up (world),    w = cam_pos.y
  float4 cam_row2;    // view fwd (world),   w = cam_pos.z
  float4 cam_p;       // focal, cover_ax, cover_ay, has_bg
  float4 sun_p;       // sun dir (world, toward light), w = intensity
  float4 albedo;      // rgb, w = opacity
  float4 vp;          // w, h, 1/w, 1/h
  float4 shade_p;     // shadow, ao, ambient, rim
  float4 fine_p;      // R (base radius), px_world (per unit t), inv_lip, 0
};

bool plm_box(float3 ro, float3 rd, out float t0, out float t1) {
  float3 inv = 1.0 / rd;
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

// Exact radial distance to the full-band shell surface (star-shaped).
float plm_fine(float3 p) {
  float r = length(p);
  float3 dir = p / max(r, 1e-5);
  float h = shellFull.SampleLevel(linearSamp, nano_oct_encode(dir), 0).r;
  return r - fine_p.x - h;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W = (uint)vp.x, H = (uint)vp.y;
  if (gid.x >= W || gid.y >= H) return;

  float4 bg = cam_p.w > 0.5 ? bgTex.Load(int3(int(gid.x), int(gid.y), 0))
                            : float4(0.0, 0.0, 0.0, 0.0);

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
  const float band = 1.6 * voxel;    // coarse->fine handoff distance
  float t = max(t0, 0.0) + 0.5 * voxel;
  bool hit = false;
  float t_prev = t;
  float df_prev = 1e5;
  [loop] for (int i = 0; i < 220; i++) {
    if (t > t1) break;
    float3 p = ro + rd * t;
    float d = plm_sdf(p);
    if (d < band) {
      // Fine tier: exact shell surface. Hit on sign change, refined below.
      float df = plm_fine(p);
      float eps = max(0.20 * voxel, 0.9 * fine_p.y * t);
      if (df < eps) { hit = true; break; }
      t_prev = t; df_prev = df;
      t += clamp(df * 0.55, 0.18 * voxel, band);
    } else {
      t_prev = t; df_prev = 1e5;
      t += d * 0.9;
    }
  }

  if (!hit) {
    outTex[gid.xy] = bg;
    return;
  }

  // Bisection polish between the last outside sample and the hit.
  if (df_prev < 1e4) {
    float ta = t_prev, tb = t;
    [unroll] for (int j = 0; j < 4; j++) {
      float tm = 0.5 * (ta + tb);
      if (plm_fine(ro + rd * tm) < 0.0) tb = tm; else ta = tm;
    }
    t = tb;
  }
  float3 hp = ro + rd * t;

  // Normal: tetrahedron taps on the fine surface, screen-adaptive epsilon
  // (small up close for crisp flakes, wider far away to kill shimmer).
  float e = clamp(0.8 * fine_p.y * t, 0.0012, 0.02);
  float2 k = float2(1.0, -1.0);
  float3 N = normalize(
      k.xyy * plm_fine(hp + k.xyy * e) + k.yyx * plm_fine(hp + k.yyx * e) +
      k.yxy * plm_fine(hp + k.yxy * e) + k.xxx * plm_fine(hp + k.xxx * e));

  // The grid stores Lipschitz-COMPRESSED distances (safe stepping);
  // penumbra and AO interpret distance as free space, so decompress first.
  float inv_lip = fine_p.z;

  // Soft shadow: march the coarse grid toward the sun.
  float sh = 1.0;
  if (shade_p.x > 0.001) {
    float st = 2.5 * voxel;
    [loop] for (int m = 0; m < 20; m++) {
      float3 sp = hp + sun_p.xyz * st;
      if (abs(sp.x) > PLM_EXT0 || abs(sp.y) > PLM_EXT0 ||
          abs(sp.z) > PLM_EXT0) break;
      float d = plm_sdf(sp) * inv_lip;
      sh = min(sh, 5.0 * d / st);
      if (sh < 0.02) break;
      st += clamp(d, 0.6 * voxel, 4.0 * voxel);
    }
    sh = lerp(1.0, saturate(sh), shade_p.x);
  }

  // AO: how much the SDF falls short of free space along the normal.
  float ao = 1.0;
  if (shade_p.y > 0.001) {
    float occ = 0.0;
    float w = 0.5;
    [unroll] for (int a = 1; a <= 4; a++) {
      float hstep = float(a) * 1.1 * voxel;
      float d = plm_sdf(hp + N * hstep) * inv_lip;
      occ += w * (hstep - clamp(d, 0.0, hstep)) / hstep;
      w *= 0.65;
    }
    ao = saturate(1.0 - shade_p.y * 1.15 * occ);
  }

  float crest = sdfVol.SampleLevel(linearSamp, plm_world_to_uvw(hp), 0).b;
  float lam = saturate(dot(N, sun_p.xyz));
  float ndv = saturate(dot(N, -rd));
  float rim = pow(1.0 - ndv, 3.0);

  // Studio-matte combine: the porcelain look is FORM-shaded — white tops
  // rolling to gray sides (straight lambert key), a restrained AO'd fill,
  // and near-black gaps between plates.
  float key = sun_p.w * (0.06 + 0.94 * lam) * sh;
  float sky = 0.55 + 0.45 * saturate(N.y * 0.8 + 0.5);
  float fill = shade_p.z * 0.4 * sky * (0.15 + 0.85 * ao);
  float3 c = albedo.rgb * (key + fill) * (0.90 + 0.10 * crest);
  c += shade_p.w * rim * ao * 0.25 * sun_p.w;

  // Gentle shoulder: keeps the key from clipping chalky.
  c = c / (1.0 + 0.18 * c);

  float w_op = albedo.w;
  outTex[gid.xy] = float4(lerp(bg.rgb, c, w_op), max(bg.a, w_op));
}
