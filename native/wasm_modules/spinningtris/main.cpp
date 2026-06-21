/*
 * Spinning Triangles — GPU compute + render demo.
 *
 * Uses HLSL-authored shaders (compiled to WGSL/MSL at build time).
 * Compute shader generates vertices, render pipeline draws them.
 *
 * Class-like instance model: module_init() registers shaders + creates
 * the type-shared compute/render PSOs and publishes the schema once;
 * each chain entry gets its own State (params, time accumulator, and its
 * own uniform/seed/vertex buffers) via create(). All instance callbacks
 * take `self`.
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

// --- Per-instance state. One per chain entry. ---

struct State {
  float elapsed = 0;
  int tri_count = 100;
  float speed = 1.0f;
  bool initialized = false;

  gpu::Buffer uniform_buf;
  gpu::Buffer seed_buf;
  gpu::Buffer vertex_buf;

  // Simple LCG PRNG — per-instance so each instance seeds independently.
  unsigned rng_state = 12345;
};

// --- Type-shared: compiled once in module_init(), reused by every instance. ---

static gpu::ComputePSO s_compute_pso;
static gpu::RenderPSO s_render_pso;

static float randf(State& s) {
  s.rng_state = s.rng_state * 1103515245u + 12345u;
  return float((s.rng_state >> 16) & 0x7FFF) / 32767.0f;
}

// Type-level setup: schema + shared compute/render PSOs. Runs once per type.
void module_init() {
  state::init("debug.spinningtris", {1, 0, 0},
    state::Schema()
      .floatField("triangles", 0.1f, 0.f, 1.f, state::PrimaryInput)
      .floatField("speed", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::Generator)
  );
  state::log("SpinningTris: init");

  if (gpu::Device::backend() == gpu::Backend::None) {
    state::log(state::LogLevel::Error, "SpinningTris: no GPU backend");
    return;
  }

  state::registerShaderSPV("compute",  COMPUTE_SPV,  COMPUTE_SPV_SIZE);
  state::registerShaderSPV("vertex",   VERTEX_SPV,   VERTEX_SPV_SIZE);
  state::registerShaderSPV("fragment", FRAGMENT_SPV, FRAGMENT_SPV_SIZE);

  auto cs_mod = gpu::Device::createShaderModuleByName("compute");
  auto vs_mod = gpu::Device::createShaderModuleByName("vertex");
  auto fs_mod = gpu::Device::createShaderModuleByName("fragment");
  if (!cs_mod || !vs_mod || !fs_mod) {
    state::log(state::LogLevel::Error, "SpinningTris: shader compile failed");
    return;
  }

  s_compute_pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)        // seeds (read)
      .storageRW(2));    // verts (write — generated each frame)
  // Render uses the standard vertex-buffer (float2 pos + float4 color)
  // and reads no bind group resources.
  s_render_pso = gpu::Device::createRenderPSO(
      vs_mod, "main", fs_mod, "main", gpu::TextureFormat::Surface, gpu::Bindings());

  state::log("SpinningTris: module initialized");
}

// Per-instance construction: allocate State + its own GPU buffers, then
// generate this instance's random seeds into its seed buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->seed_buf = gpu::Device::createBuffer(MAX_TRIANGLES * sizeof(TriSeed), gpu::BufferUsage::Storage);
  s->vertex_buf = gpu::Device::createBuffer(MAX_TRIANGLES * 3 * sizeof(Vertex), gpu::BufferUsage::Storage);

  // Generate random seeds (static to avoid 32KB stack allocation)
  static TriSeed seeds[MAX_TRIANGLES];
  for (int i = 0; i < MAX_TRIANGLES; i++) {
    seeds[i] = {
      randf(*s) * 2.0f - 1.0f, randf(*s) * 2.0f - 1.0f,
      0.02f + randf(*s) * 0.13f, randf(*s) * 6.28318f,
      0.3f + randf(*s) * 0.7f, 0.3f + randf(*s) * 0.7f, 0.3f + randf(*s) * 0.7f,
      0.5f + randf(*s) * 2.0f,
    };
  }
  if (s->seed_buf.valid()) {
    s->seed_buf.write<TriSeed>(seeds, MAX_TRIANGLES);
  }
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->seed_buf.release();
  s->vertex_buf.release();
  delete s;
}

// Per-instance init tail: reset accumulators/params + mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->elapsed = 0;
  s->tri_count = 100;
  s->speed = 1.0f;
  s->initialized = false;

  if (!s_compute_pso.valid() || !s_render_pso.valid()) return;
  if (!s->uniform_buf.valid() || !s->seed_buf.valid() || !s->vertex_buf.valid()) return;

  s->initialized = true;
  state::log("SpinningTris: GPU initialized");
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->elapsed += float(dt);
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "triangles")) {
      float v = state::patchFloat(i);
      s->tri_count = 1 + int(v * 999.0f);
      if (s->tri_count > MAX_TRIANGLES) s->tri_count = MAX_TRIANGLES;
      if (s->tri_count < 1) s->tri_count = 1;
    } else if (state::pathIs(pb + off[i], len[i], "speed")) {
      s->speed = state::patchFloat(i) * 4.0f;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized) return;

  float aspect = (vp_w > 0 && vp_h > 0) ? float(vp_w) / float(vp_h) : 1.0f;
  Uniforms u = { s->elapsed, float(s->tri_count), aspect, s->speed };
  s->uniform_buf.writeOne(u);

  // Compute pass: generate vertices
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_compute_pso);
  cp.setBuffer(s->uniform_buf, 0);
  cp.setBuffer(s->seed_buf, 1);
  cp.setBuffer(s->vertex_buf, 2);
  cp.dispatch((s->tri_count + 63) / 64);
  cp.end();

  // Render pass: draw triangles
  auto rp = gpu::RenderPass::begin(gpu::Device::renderTarget(), 0.05f, 0.05f, 0.08f);
  rp.setPSO(s_render_pso);
  rp.setVertexBuffer(s->vertex_buf);
  rp.draw(s->tri_count * 3);
  rp.end();

  gpu::Device::submit();
}

} // namespace spinningtris
