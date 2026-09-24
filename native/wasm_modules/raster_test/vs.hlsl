// debug.raster_test — instanced quad vertex shader (6 verts per quad).
#include "common.hlsl"

[shader("vertex")]
VsOut main(uint vid : SV_VertexID, uint iid : SV_InstanceID) {
  static const float2 corners[6] = {
    float2(0.0, 0.0), float2(1.0, 0.0), float2(0.0, 1.0),
    float2(1.0, 0.0), float2(1.0, 1.0), float2(0.0, 1.0),
  };
  float2 c = corners[vid % 6u];
  float4 r = rect;
  if (columns > 0.0) {
    float i = float(iid);
    r = float4(i / columns, 0.0, (i + 1.0) / columns, 1.0);
  }
  float2 uv = lerp(r.xy, r.zw, c);
  VsOut o;
  o.pos = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.local = c.x;
  return o;
}
