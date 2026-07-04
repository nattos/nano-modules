// shape_burst/motion.hlsl — motion-vector pass (render_outputs/motion rail).
//
// Writes per-pixel velocity along each expanding ring. A ring scales uniformly
// about the center, so a boundary point at cover-square offset p moves radially
// by p * (speed / scale) per frame (speed = radius change/frame). Direction is
// therefore radial-from-center (correct for every shape — corners, being
// farther out, move faster). Magnitude is redistributed across the stroke band
// by `tilt`: inner edge stronger / outer weaker (tilt > 0) or vice versa.
//
// Encoding (rail convention): .xy = velocity in viewport-uv space per frame,
// +x right / +y down; .zw reserved = 0. Uncovered pixels inherit the upstream
// motion so this composites cleanly mid-chain.

#include "common.hlsl"

Texture2D<float4>   upstreamTex : register(t0);   // render_outputs_in/motion (or 1x1 zero)
RWTexture2D<float4> motionTex   : register(u1);   // render_outputs/motion (rgba16f)

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 upstream = upstreamTex.Load(int3(gid.xy, 0)).xy;

  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), u_aspect);
  float2 p  = sq - u_center;

  const float half_t = max(u_thickness * 0.5, 1e-5);
  const float aa     = max(u_px, 1e-5);

  float  best_cov = 0.0;
  float2 best_vel = float2(0.0, 0.0);

  for (uint i = 0u; i < u_count; ++i) {
    float s = u_scales[i / 4u][i % 4u];
    if (s <= 0.0) continue;
    float spd = u_speeds[i / 4u][i % 4u];
    float2 pr = sb_unrotate(p, u_rotations[i / 4u][i % 4u]);
    float d   = sd_shape(pr / s, u_shape_kind) * s;
    float cov = smoothstep(half_t + aa, half_t - aa, abs(d));
    if (cov <= best_cov) continue;                 // keep the nearest/strongest ring

    // Signed position across the stroke: -1 inner edge, +1 outer edge.
    float band  = clamp(d / half_t, -1.0, 1.0);
    float tiltf = max(1.0 - u_tilt * band, 0.0);   // tilt>0 → inner stronger

    // Radial velocity of the scaling boundary, in cover-square units/frame,
    // then mapped into uv (duv = dsq * aspect).
    float2 v_cs = p * (spd / max(s, 1e-4)) * tiltf * u_motion_strength;
    float2 v_uv = v_cs * u_aspect;

    best_cov = cov;
    best_vel = v_uv;
  }

  float2 outv = lerp(upstream, best_vel, best_cov);
  motionTex[gid.xy] = float4(outv, 0.0, 0.0);
}
