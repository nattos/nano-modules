// debug.raster_test — flat colour, with a discarded strip on the quad's right.
#include "common.hlsl"

[shader("pixel")]
float4 main(VsOut i) : SV_Target0 {
  if (i.local > discard_from) discard;
  return color;
}
