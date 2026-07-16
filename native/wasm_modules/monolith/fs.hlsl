// source.mesh.monolith — flat-color fragment.
//
// Straight (non-premultiplied) alpha out; the PSO's AlphaOver blend
// (src*src.a + dst*(1-src.a)) composites the painter-sorted triangles
// over the prefilled input.

struct VsOut {
  float4 pos   : SV_Position;
  float4 color : TEXCOORD0;
};

[shader("pixel")]
float4 main(VsOut i) : SV_Target {
  return i.color;
}
