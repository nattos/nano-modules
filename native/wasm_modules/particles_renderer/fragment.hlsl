// video.particles_renderer — fragment shader.
//
// Outputs the flat per-particle tint forwarded by the vertex shader.

struct VsOut {
  float4 pos   : SV_Position;
  nointerpolation float4 color : TEXCOORD0;
};

[shader("pixel")]
float4 main(VsOut i) : SV_Target0 {
  return i.color;
}
