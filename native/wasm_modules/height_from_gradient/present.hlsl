// video.height_from_gradient — present / visualization pass.
//
// Turns the reconstructed full-res height into the output image. Three modes:
//   Hillshade (default) — Lambertian-shade the surface normal (built from the
//                         height's local slope) against an adjustable light.
//                         DC-invariant, so the Poisson null-space (height is
//                         defined up to a constant) doesn't matter here.
//   Grayscale           — raw height as brightness, scaled/offset by the user
//                         (DC is ambiguous → user-dialed for now).
//   Normals             — RG-encoded surface normal (data/producer view).
// `mix_amount` cross-fades the visualization back toward the input image.
// `debug_show_gradient` overrides everything with the source gradient field.

#include "common.hlsl"

Texture2D<float4>   heightTex : register(t0);   // reconstructed height (R)
Texture2D<float4>   gradTex   : register(t1);   // source gradient (RG) — debug
Texture2D<float4>   inputTex  : register(t2);   // original input (mix)
RWTexture2D<float4> outTex    : register(u3);   // rgba8 output

cbuffer Uniforms : register(b4) { HFG_UNIFORMS };

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  int2 hi = int2(int(w) - 1, int(h) - 1);
  int2 p  = int2(gid.xy);

  float hC = heightTex[gid.xy].x;
  float hL = heightTex[uint2(clamp(p + int2(-1, 0), int2(0, 0), hi))].x;
  float hR = heightTex[uint2(clamp(p + int2( 1, 0), int2(0, 0), hi))].x;
  float hD = heightTex[uint2(clamp(p + int2(0, -1), int2(0, 0), hi))].x;
  float hU = heightTex[uint2(clamp(p + int2(0,  1), int2(0, 0), hi))].x;

  // Raw per-pixel slope from central differences (used by the normal AND the
  // contour spacing); relief_scale (0..1) steepens the normal. Typical
  // reconstructed-height slopes are small, so map through a gain.
  float2 rawSlope = float2((hR - hL) * 0.5, (hU - hD) * 0.5);
  float s = relief_scale * 16.0;
  float3 n = normalize(float3(-rawSlope.x * s, -rawSlope.y * s, 1.0));

  float3 rgb;
  if (present_mode > 2.5) {
    // Contours — iso-lines of OUR reconstructed height. A constant-width line
    // wherever h crosses a level. We have no fragment derivatives in a compute
    // pass, so the per-pixel rate of change is the manual height gradient:
    // levels-per-pixel = |grad h| * density. Distance (in levels) to the
    // nearest level / levels-per-pixel = distance in pixels → a crisp line.
    float density = contour_density * 64.0;
    float hs = hC * density;
    float f = frac(hs);
    float dist = min(f, 1.0 - f);                       // 0 at a level line
    float lpp = max(length(rawSlope) * density, 1e-6);  // levels per pixel
    float dist_px = dist / lpp;
    float lw = max(line_width * 4.0, 0.5);
    float lineMask = 1.0 - smoothstep(lw, lw + 1.0, dist_px);
    rgb = lineMask * float3(tint_r, tint_g, tint_b);
  } else if (present_mode > 1.5) {
    // Normals
    rgb = n * 0.5 + 0.5;
  } else if (present_mode > 0.5) {
    // Grayscale height (DC user-dialed)
    float v = saturate(hC * height_scale + height_offset);
    rgb = v * float3(tint_r, tint_g, tint_b);
  } else {
    // Hillshade relief (default)
    float3 light = float3(light_x, light_y, light_z);
    float shade = saturate(dot(n, light) * light_gain + ambient);
    rgb = shade * float3(tint_r, tint_g, tint_b);
  }

  rgb = lerp(rgb, inputTex[gid.xy].rgb, saturate(mix_amount));

  if (debug_show_gradient > 0.5) {
    float2 g = gradTex[gid.xy].xy;
    rgb = float3(g * 2.0 + 0.5, 0.5);
  }

  outTex[gid.xy] = float4(saturate(rgb), 1.0);
}
