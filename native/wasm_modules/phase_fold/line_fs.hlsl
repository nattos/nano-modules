// video.phase_fold — line raster fragment shader.
//
// Soft anti-aliased line: fade by the across-position to the rim, colour by the
// segment's code (port of the prototype's LINE_WGSL fs thresholds):
//   code > 0.80 → gold limit-cycle / marker
//   code > 0.58 → bright moving arrowhead
//   else        → streamline, speed-graded blue (faint)
// Straight (non-premultiplied) output; the alpha-over render PSO does
// src.rgb*src.a + dst*(1-src.a).

#include "common.hlsl"

struct VsOut {
  float4 pos    : SV_Position;
  float2 local  : TEXCOORD0;
  nointerpolation float2 meta : TEXCOORD1;  // code, alpha
};

[shader("pixel")]
float4 main(VsOut i) : SV_Target0 {
  float edge = smoothstep(1.0, 0.35, abs(i.local.y));   // soft rim falloff
  float code = i.meta.x;
  float alpha = i.meta.y * edge;
  if (alpha <= 0.0) discard;

  float3 col;
  if (code > 0.80) {
    col = float3(1.0, 0.92, 0.38);                      // gold
  } else if (code > 0.58) {
    col = float3(0.80, 0.92, 1.0);                      // bright arrow
  } else {
    float t = saturate(code / 0.55);                    // speed → colour
    col = lerp(float3(0.22, 0.40, 0.78), float3(0.78, 0.88, 1.0), t);
  }
  return float4(col, alpha);
}
