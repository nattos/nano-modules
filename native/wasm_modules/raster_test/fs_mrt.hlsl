// debug.raster_test cases 2/3 — the same flat colour into two attachments, so
// each target's blend equation shows in its own result.
#include "common.hlsl"

struct MrtOut {
  float4 c0 : SV_Target0;
  float4 c1 : SV_Target1;
};

[shader("pixel")]
MrtOut main(VsOut i) {
  if (i.local > discard_from) discard;
  MrtOut o;
  o.c0 = color;
  o.c1 = color;
  return o;
}
