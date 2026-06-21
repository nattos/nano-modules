/*
 * particles_renderer — consumes a struct rail of GPU-resident particle
 * positions and renders one quad per particle via instanced draw.
 *
 * Schema:
 *   particle_size : float — half-extent of each quad in clip space
 *   tint          : float4 — RGBA modulation
 *   particles_in  : object (Input, Primary)
 *     count       : int           (number of particles to draw)
 *     positions   : array<float> (gpu)  — interleaved x,y per particle
 *     velocities  : array<float> (gpu)  — (read by other consumers; not used here)
 *   tex_out       : texture (Output, Primary)
 *
 * The vertex shader reads positions[instance_index] from the bound
 * storage buffer and emits a screen-aligned quad. No vertex buffer is
 * bound — vertex_index drives quad-corner selection.
 *
 * Class-like instance model: module_init() compiles the type-shared
 * render PSO + publishes the schema once per type; each chain entry gets
 * its own State (params + uniform buffer) via create(). All instance
 * callbacks take `self`. The producer's positions buffer is resolved
 * through the rail per-frame in render() and is NOT owned here.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "particles_renderer_shaders.h"
#include <cstdint>

namespace particles_renderer {

// std140-ish layout: vec2 occupies 8B but the following vec4
// must start at a 16B boundary, so we pad 8 bytes between them.
struct Uniforms {
  float size_x, size_y;
  float _pad0, _pad1;
  float tint_r, tint_g, tint_b, tint_a;
};

// Per-instance state. One per chain entry. Holds every schema-mirrored
// param, the per-instance uniform buffer, and the dirty/initialized
// flags. The producer's rail-resolved positions buffer is NOT stored
// here — it is resolved per-frame in render() and never owned.
struct State {
  gpu::Buffer uniform_buf;
  int   count         = 0;
  float particle_size = 0.02f;
  float tint[4]       = {1.0f, 0.7f, 0.2f, 1.0f};
  bool  dirty         = true;
  bool  initialized   = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::RenderPSO s_render_pso;

// Type-level setup: schema + shared render PSO. Runs once per type.
void module_init() {
  state::init("debug.particles_renderer", {1, 0, 0},
    state::Schema()
      .floatField("particle_size", 0.02f, 0.001f, 0.2f, state::PrimaryInput)
      .rgbaField("tint", 1.0f, 0.7f, 0.2f, 1.0f, state::PrimaryInput)
      .beginObject("particles_in", state::PrimaryInput)
        .intField("count", 0, 0, 100000, state::None)
        .gpuArrayField("positions",  "float", state::None)
        .gpuArrayField("velocities", "float", state::None)
      .endObject()
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("particles_renderer_vs", VERTEX_SPV, VERTEX_SPV_SIZE);
  state::registerShaderSPV("particles_renderer_fs", FRAGMENT_SPV, FRAGMENT_SPV_SIZE);

  auto vs_mod = gpu::Device::createShaderModuleByName("particles_renderer_vs");
  auto fs_mod = gpu::Device::createShaderModuleByName("particles_renderer_fs");
  if (!vs_mod || !fs_mod) return;

  s_render_pso = gpu::Device::createInstancedRenderPSO(
      vs_mod, "main", fs_mod, "main", gpu::TextureFormat::Surface, gpu::Bindings()
          .uniform(0)
          .storage(1));  // particle positions (read)

  state::log("particles_renderer: module initialized");
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

// Per-instance init tail: defaults + readiness guard.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->count = 0;
  s->particle_size = 0.02f;
  s->tint[0] = 1.0f;
  s->tint[1] = 0.7f;
  s->tint[2] = 0.2f;
  s->tint[3] = 1.0f;
  s->dirty = true;
  if (!s_render_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
  state::log("particles_renderer: initialized");
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (state::pathIs(path, plen, "particle_size")) {
      s->particle_size = state::patchFloat(i);
      s->dirty = true;
    } else if (state::pathIs(path, plen, "tint")) {
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      if (val::typeOf(v.h) == val::Array && val::length(v.h) >= 4) {
        for (int k = 0; k < 4; k++) {
          auto comp = val::Value(val::getIndex(v.h, k));
          s->tint[k] = float(val::asNumber(comp.h));
        }
        s->dirty = true;
      }
    } else if (state::pathIs(path, plen, "particles_in/count")) {
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      s->count = int(val::asNumber(v.h));
    } else if (op == 5 /* dirty */
               && plen >= (int)sizeof("particles_in") - 1
               && state::pathIs(path, (int)sizeof("particles_in") - 1, "particles_in")) {
      // Producer announced a fresh particle frame — nothing eager to do
      // here, the next render() will resolve the buffer and draw.
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)vp_w; (void)vp_h;
  if (!s->initialized) return;

  if (s->dirty) {
    Uniforms u = {
      s->particle_size, s->particle_size,
      0.0f, 0.0f,
      s->tint[0], s->tint[1], s->tint[2], s->tint[3],
    };
    s->uniform_buf.writeOne(u);
    s->dirty = false;
  }

  // Resolve the producer's positions buffer through the rail-installed
  // field path. May be 0 on the first frame before the producer has
  // published — in that case skip rendering and just clear. Not owned.
  auto positions = gpu::Device::bufferForField("particles_in/positions");

  auto rp = gpu::RenderPass::begin(gpu::Device::renderTarget(),
                                    0.02f, 0.02f, 0.04f, 1.0f);
  if (positions && s->count > 0) {
    rp.setPSO(s_render_pso);
    rp.setBuffer(s->uniform_buf, 0);
    rp.setBuffer(positions, 1);
    rp.draw(6, s->count);
  }
  rp.end();

  gpu::Device::submit();
}

} // namespace particles_renderer
