// source.mesh.monolith — vertex-pull passthrough.
//
// The CPU does the ENTIRE 3D pipeline (rotate, project, backface
// classify, flat-shade, painter's back-to-front sort) and writes
// final clip-space positions + per-vertex straight-alpha colors into
// the storage buffer at register(t0). This shader only pulls.
//
// NDC note (same contract as flash_particles/vs.hlsl): DXC's `-spirv`
// target emits Vulkan NDC (y-down) and naga inserts an automatic
// y-negation when translating to WebGPU NDC (y-up). The CPU emits
// Vulkan-NDC clip coords (its single y-flip lives in the projection,
// main.cpp); adding another flip here would double-flip the output.

struct Vtx {
  float4 pos;     // clip-space xyzw (z = 0.5 cosmetic — no depth test exists)
  float4 color;   // straight-alpha rgba; identical at all 3 verts of a tri
};

StructuredBuffer<Vtx> verts : register(t0);

struct VsOut {
  float4 pos   : SV_Position;
  float4 color : TEXCOORD0;
};

[shader("vertex")]
VsOut main(uint vid : SV_VertexID) {
  Vtx v = verts[vid];
  VsOut o;
  o.pos = v.pos;
  o.color = v.color;
  return o;
}
