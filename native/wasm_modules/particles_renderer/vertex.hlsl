// debug.particles_renderer — instanced quad vertex shader.
//
// Six vertices per instance form one screen-aligned quad centered on the
// particle's clip-space position. Particle positions live in a GPU storage
// buffer (the producer's `particles_out/positions` rail leaf) bound at
// register(t1); vertex/instance ids drive corner + particle selection.
// Positions are interleaved x,y floats already in clip space.
//
// Authored once as HLSL → SPV → {MSL native, WGSL web}. The NDC-convention
// difference between Vulkan (y-down, DXC's `-spirv` target) and the
// runtime backends is handled by the SPV→{naga,SPIRV-Cross} translation,
// exactly as in flash_particles/vs.hlsl — no manual y-flip here.

StructuredBuffer<float> positions : register(t1);

cbuffer Uniforms : register(b0) {
  float2 size;   // half-extent of each quad in clip space
  float2 _pad;
  float4 tint;   // RGBA modulation, forwarded flat to the fragment shader
};

struct VsOut {
  float4 pos   : SV_Position;
  nointerpolation float4 color : TEXCOORD0;
};

[shader("vertex")]
VsOut main(uint vid : SV_VertexID, uint iid : SV_InstanceID) {
  // 6-vertex triangle list covering the [-1,+1]^2 quad.
  static const float2 corners[6] = {
    float2(-1.0, -1.0), float2( 1.0, -1.0), float2(-1.0,  1.0),
    float2( 1.0, -1.0), float2( 1.0,  1.0), float2(-1.0,  1.0),
  };
  float2 c = corners[vid % 6u];

  float px = positions[iid * 2u + 0u];
  float py = positions[iid * 2u + 1u];
  float2 world = float2(px, py) + c * size;

  VsOut o;
  o.pos   = float4(world, 0.0, 1.0);
  o.color = tint;
  return o;
}
