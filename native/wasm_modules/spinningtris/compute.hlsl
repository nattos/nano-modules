// Spinning Triangles — Compute Shader
// Generates vertices for N spinning triangles from seed data.

cbuffer Uniforms : register(b0) {
  float time;
  float count;
  float aspect;
  float speed;
};

struct Seed {
  float px, py, size, rot, r, g, b, spd;
};

struct Vertex {
  float x, y, r, g, b, a;
};

StructuredBuffer<Seed> seeds : register(t1);
RWStructuredBuffer<Vertex> verts : register(u2);

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint idx = gid.x;
  if (idx >= (uint)count) return;

  Seed s = seeds[idx];
  float angle = s.rot + time * s.spd * speed;
  uint base = idx * 3;

  for (uint i = 0; i < 3; i++) {
    float a = angle + (float)i * 2.0943951;
    Vertex v;
    v.x = s.px + cos(a) * s.size / aspect;
    v.y = s.py + sin(a) * s.size;
    v.r = s.r;
    v.g = s.g;
    v.b = s.b;
    v.a = 0.7;
    verts[base + i] = v;
  }
}
