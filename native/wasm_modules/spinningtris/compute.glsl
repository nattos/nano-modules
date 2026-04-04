#version 450

layout(local_size_x = 64) in;

layout(set = 0, binding = 0) uniform Uniforms {
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

layout(std430, set = 0, binding = 1) readonly buffer Seeds {
  Seed seeds[];
};

layout(std430, set = 0, binding = 2) buffer Vertices {
  Vertex verts[];
};

void main() {
  uint idx = gl_GlobalInvocationID.x;
  if (idx >= uint(count)) return;

  Seed s = seeds[idx];
  float angle = s.rot + time * s.spd * speed;
  uint base = idx * 3u;

  for (uint i = 0u; i < 3u; i++) {
    float a = angle + float(i) * 2.0943951;
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
