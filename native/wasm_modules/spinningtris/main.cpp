/*
 * Spinning Triangles — GPU compute + render demo.
 *
 * Uses HLSL-authored shaders (compiled to WGSL/MSL at build time).
 * Compute shader generates vertices, render pipeline draws them.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "spinningtris_shaders.h"

#include <cmath>

namespace spinningtris {

// --- Data types ---

struct TriSeed {
  float px, py, size, rot, r, g, b, spd;
};

struct Vertex {
  float x, y, r, g, b, a;
};

struct Uniforms {
  float time, count, aspect, speed;
};

// --- Constants ---

static constexpr int MAX_TRIANGLES = 1000;

// --- State ---

static float elapsed = 0;
static int tri_count = 100;
static float speed = 1.0f;
static bool initialized = false;

static gpu::ComputePSO compute_pso;
static gpu::RenderPSO render_pso;
static gpu::Buffer uniform_buf;
static gpu::Buffer seed_buf;
static gpu::Buffer vertex_buf;

// Simple LCG PRNG
static unsigned rng_state = 12345;
static float randf() {
  rng_state = rng_state * 1103515245u + 12345u;
  return float((rng_state >> 16) & 0x7FFF) / 32767.0f;
}

void init() {
  elapsed = 0;
  tri_count = 100;
  speed = 1.0f;
  initialized = false;

  state::init("com.nattos.spinningtris", {1, 0, 0},
    state::Schema()
      .floatField("triangles", 0.1f, 0.f, 1.f, state::PrimaryInput)
      .floatField("speed", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );
  state::log("SpinningTris: init");

  if (gpu::Device::backend() == gpu::Backend::None) {
    state::log(state::LogLevel::Error, "SpinningTris: no GPU backend");
    return;
  }

  // Select shader source based on backend
  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  const char* cs = metal ? COMPUTE_MSL : COMPUTE_WGSL;
  const char* vs = metal ? VERTEX_MSL : VERTEX_WGSL;
  const char* fs = metal ? FRAGMENT_MSL : FRAGMENT_WGSL;
  const char* entry = metal ? "main_" : "main";

  auto cs_mod = gpu::Device::createShaderModule(cs);
  auto vs_mod = gpu::Device::createShaderModule(vs);
  auto fs_mod = gpu::Device::createShaderModule(fs);
  if (!cs_mod || !vs_mod || !fs_mod) {
    state::log(state::LogLevel::Error, "SpinningTris: shader compile failed");
    return;
  }

  compute_pso = gpu::Device::createComputePSO(cs_mod, entry);
  render_pso = gpu::Device::createRenderPSO(vs_mod, entry, fs_mod, entry);

  uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  seed_buf = gpu::Device::createBuffer(MAX_TRIANGLES * sizeof(TriSeed), gpu::BufferUsage::Storage);
  vertex_buf = gpu::Device::createBuffer(MAX_TRIANGLES * 3 * sizeof(Vertex), gpu::BufferUsage::Storage);

  // Generate random seeds (static to avoid 32KB stack allocation)
  static TriSeed seeds[MAX_TRIANGLES];
  for (int i = 0; i < MAX_TRIANGLES; i++) {
    seeds[i] = {
      randf() * 2.0f - 1.0f, randf() * 2.0f - 1.0f,
      0.02f + randf() * 0.13f, randf() * 6.28318f,
      0.3f + randf() * 0.7f, 0.3f + randf() * 0.7f, 0.3f + randf() * 0.7f,
      0.5f + randf() * 2.0f,
    };
  }
  seed_buf.write<TriSeed>(seeds, MAX_TRIANGLES);

  initialized = true;
  state::log("SpinningTris: GPU initialized");
}

void tick(double dt) {
  elapsed += float(dt);
}

void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "triangles")) {
      float v = state::patchFloat(i);
      tri_count = 1 + int(v * 999.0f);
      if (tri_count > MAX_TRIANGLES) tri_count = MAX_TRIANGLES;
      if (tri_count < 1) tri_count = 1;
    } else if (state::pathIs(pb + off[i], len[i], "speed")) {
      speed = state::patchFloat(i) * 4.0f;
    }
  }
}


void render(int vp_w, int vp_h) {
  if (!initialized) return;

  float aspect = (vp_w > 0 && vp_h > 0) ? float(vp_w) / float(vp_h) : 1.0f;
  Uniforms u = { elapsed, float(tri_count), aspect, speed };
  uniform_buf.writeOne(u);

  // Compute pass: generate vertices
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(compute_pso);
  cp.setBuffer(uniform_buf, 0);
  cp.setBuffer(seed_buf, 1);
  cp.setBuffer(vertex_buf, 2);
  cp.dispatch((tri_count + 63) / 64);
  cp.end();

  // Render pass: draw triangles
  auto rp = gpu::RenderPass::begin(gpu::Device::renderTarget(), 0.05f, 0.05f, 0.08f);
  rp.setPSO(render_pso);
  rp.setVertexBuffer(vertex_buf);
  rp.draw(tri_count * 3);
  rp.end();

  gpu::Device::submit();
}

} // namespace spinningtris
