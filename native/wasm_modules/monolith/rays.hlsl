// source.mesh.monolith — god rays (light shafts from the surface above).
//
// For each pixel, march toward the sun's screen position accumulating a
// SYNTHETIC radiance — a sun-centered glow standing in for light entering
// through the water surface — gated by (1 - occlusion) from the composite
// alpha, with exponential decay per tap. The composite's COLOR is never
// gathered: scattering the 2D input radially reads as a camera-facing
// billboard being smeared, not a volume. Taps that leave the frame count
// as unoccluded (open water), so shafts don't truncate at the edges. The
// black slab carves dark shafts; the top-anchored caustic field (below)
// does the surface modulation. Output is an additive RGBA16F layer.

#include "caustics.hlsl"

Texture2D<float4>   compTex : register(t0);
RWTexture2D<float4> raysTex : register(u1);
SamplerState        clampS  : register(s2);

cbuffer Uniforms : register(b3) {
  float4 sun_screen;   // sun px, py, water_t, gain (rays * fade * sun)
  float4 march;        // taps, decay, max_step_px, caustics amount
  float4 glow;         // inv glow radius (px^-1), 0, 0, 0
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  raysTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 p = float2(gid.xy) + 0.5;
  float2 inv_dims = float2(1.0 / float(W), 1.0 / float(H));
  float2 delta = sun_screen.xy - p;
  int taps = (int)march.x;
  float2 step_px = delta / march.x;
  float sl = length(step_px);
  if (sl > march.z) step_px *= march.z / sl;

  // Per-pixel march jitter kills the stair-step banding a fixed-phase
  // radial march leaves around the silhouette (stable per pixel — no
  // temporal shimmer).
  float jitter = nano_hash21(float2(gid.xy));

  float accum = 0.0;
  float wsum = 0.0;
  float w = 1.0;
  for (int i = 1; i <= taps; i++) {
    float2 sp_px = p + step_px * (float(i) - 1.0 + jitter);
    float2 sp = sp_px * inv_dims;
    float occ_t = 0.0;
    if (sp.x >= 0.0 && sp.x <= 1.0 && sp.y >= 0.0 && sp.y <= 1.0) {
      occ_t = compTex.SampleLevel(clampS, sp, 0).a;
    }
    // Synthetic surface light: the WHOLE surface emits (floor), brightest
    // toward the sun point — an off-screen sun must not extinguish the
    // shafts, only bias them.
    float d = length(sp_px - sun_screen.xy) * glow.x;
    float g = 0.30 + 0.70 / (1.0 + d * d);
    accum += (1.0 - saturate(occ_t)) * g * w;
    wsum += w;
    w *= march.y;
  }
  float3 r = ((wsum > 1e-4 ? accum / wsum : 0.0) * sun_screen.w).xxx;

  // Water caustics: approximate shimmer IN the volume. The water surface
  // is conceptually UP — not sun-anchored (the sun may sit "underwater"),
  // so the rays aren't truly projected through the caustic layer. Instead
  // the gathered light is modulated by a screen-space field with
  // vertically stretched features drifting slowly down the frame: light
  // columns falling from a surface above. Rebalanced ~1.
  float ca = march.w;
  if (ca > 0.0) {
    float2 cp = float2(p.x, p.y * 0.3) * (3.5 / float(W));
    cp.y -= sun_screen.z * 0.22;   // surface motion sinks through the frame
    cp.x += sun_screen.z * 0.05;
    float c = nano_caustic2(cp, sun_screen.z);
    r *= max(1.0 + ca * (c * 2.8 - 0.6), 0.0);
  }
  raysTex[gid.xy] = float4(r, 0.0);
}
