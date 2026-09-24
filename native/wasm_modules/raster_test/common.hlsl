// debug.raster_test — the per-draw quad record, shared by vs/fs.
//
// One quad per draw (blend case), or `columns` side-by-side quads picked by
// SV_InstanceID (indirect case). Rects are in uv (0,0 top-left .. 1,1).
cbuffer Quad : register(b0) {
  float4 rect;          // x0, y0, x1, y1 (uv)
  float4 color;         // straight (non-premultiplied) rgba
  float  columns;       // > 0: ignore rect, instance i fills column i of N
  float  discard_from;  // fragments whose quad-local x exceeds this discard
  float  _pad0;
  float  _pad1;
};

struct VsOut {
  float4 pos   : SV_Position;
  float  local : TEXCOORD0;  // quad-local x in [0, 1]
};
