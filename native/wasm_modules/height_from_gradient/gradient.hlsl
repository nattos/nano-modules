// video.height_from_gradient — gradient generation pass.
//
// Synthesizes the source gradient field g(p) from the input. v1 source =
// Radial: the gradient points radially outward from an adjustable center
// (cover-square anchor), with magnitude equal to the input luma. The `source`
// switch is the seam where future gradient generators (arbitrary topologies)
// plug in without touching the solver or the presenter.
//
// Output: RG = g (gx, gy) at full res, in height-per-pixel grid units. The
// field is generally NON-conservative (curl != 0), so the Poisson solve is a
// least-squares "best try" — there's usually no exact height for it.

#include "common.hlsl"

Texture2D<float4>   inputTex : register(t0);   // full-res input
RWTexture2D<float4> gradOut  : register(u1);   // full-res gradient (RG)

cbuffer Uniforms : register(b2) { HFG_UNIFORMS };

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  gradOut.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float luma = nano_luminance(inputTex[gid.xy].rgb);

  float2 g = float2(0.0, 0.0);
  // source 0 = Radial (the only mode today). Direction = outward from the
  // cover-square center; magnitude = luma. Cover-square keeps the center
  // aspect-correct (§1.5).
  {
    float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h),
                                           float2(aspect_x, aspect_y));
    float2 d = sq - float2(center_x, center_y);
    float r = length(d);
    float2 dir = hfg_normalize2(d);

    // Core smoothing — kill the 1/r divergence singularity at the anchor.
    // normalize(d) is undefined at the center and its divergence blows up, so
    // we ramp the field MAGNITUDE smoothly from zero across `core_radius`. The
    // field then grows ~linearly out of the anchor (smooth, finite divergence)
    // instead of snapping to a unit vector in a discontinuous direction.
    // `core_softness` raises the ramp to a falloff exponent so the suppressed
    // region feathers wider. At core_radius≈0 this is a no-op (original field).
    float radius = max(core_radius, 1e-5);
    float ramp = smoothstep(0.0, radius, r);
    ramp = pow(ramp, 1.0 + core_softness * 4.0);

    g = dir * luma * grad_gain * ramp;
  }

  gradOut[gid.xy] = float4(g, 0.0, 1.0);
}
