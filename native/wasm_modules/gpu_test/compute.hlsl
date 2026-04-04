// GPU Test — Compute Shader
// Fills a vertex buffer with a full-screen quad in a known color.
// The color is controlled by a uniform: rgb from uniform, alpha=1.

cbuffer Uniforms : register(b0) {
  float r;
  float g;
  float b;
  float _pad;
};

struct Vertex {
  float x, y, cr, cg, cb, ca;
};

RWStructuredBuffer<Vertex> verts : register(u1);

[numthreads(1, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  // Full-screen quad as two triangles (6 vertices)
  // Triangle 1: (-1,-1) (1,-1) (-1,1)
  // Triangle 2: (1,-1) (1,1) (-1,1)
  float2 positions[6] = {
    float2(-1, -1), float2(1, -1), float2(-1, 1),
    float2(1, -1),  float2(1, 1),  float2(-1, 1)
  };

  for (uint i = 0; i < 6; i++) {
    Vertex v;
    v.x = positions[i].x;
    v.y = positions[i].y;
    v.cr = r;
    v.cg = g;
    v.cb = b;
    v.ca = 1.0;
    verts[i] = v;
  }
}
