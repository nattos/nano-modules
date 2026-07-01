// triangulate — present/debug pass. Chooses what lands in tex_out:
//   debug_view: 0 off (P1: show input), 1 density, 2 ridge, 3 corner, 4 importance.
//   (5 voronoi / 6 points are added with the seed pool in a later phase.)
// The mesh is composited in later phases; for now this is the terminal pass.
Texture2D<float4>   featTex : register(t0);
Texture2D<float4>   inTex   : register(t1);
RWTexture2D<float4> outTex  : register(u2);

cbuffer PresentUniforms : register(b3) {
  uint  u_debug_view;
  uint  u_bg_mode;
  float u_pad0;
  float u_pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 f = featTex[gid.xy];
  float3 c;
  if      (u_debug_view == 1u) c = f.rrr;                    // density (grey)
  else if (u_debug_view == 2u) c = float3(0.0, f.g, f.g);    // ridge (cyan)
  else if (u_debug_view == 3u) c = float3(f.b, 0.0, f.b);    // corner (magenta)
  else if (u_debug_view == 4u) c = f.aaa;                    // importance (grey)
  else                          c = inTex[gid.xy].rgb;       // off → input

  outTex[gid.xy] = float4(c, 1.0);
}
