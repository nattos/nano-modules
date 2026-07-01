/*
 * composite.bake_alpha — Composite the input *over* a chosen background
 * colour. Practical use case: "remove alpha" by baking a transparent
 * image onto a solid colour (default opaque black). With a
 * transparent background the input's own alpha is preserved.
 *
 * Parameters:
 *   color (rgba)  — the background. Default opaque black.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "bake_alpha_shaders.h"

namespace bake_alpha {

struct FuseUniforms {
  float r, g, b, a;  // 16 bytes — natural alignment for std140.
};

// Per-instance state. One per chain entry.
struct State {
  float color[4] = { 0.0f, 0.0f, 0.0f, 1.0f };
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s->color[0], s->color[1], s->color[2], s->color[3] };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("composite.bake_alpha", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Bake Alpha\n"
        "Composites the input *over* a solid background colour — the practical way "
        "to **flatten transparency**. Feed it a transparent image and it lands on "
        "the chosen colour (default opaque black), producing an opaque result.\n\n"
        "**Try:** leave the background opaque to strip alpha before a stage that "
        "needs solid pixels; or set the background's own alpha below 1 to keep the "
        "input's transparency while still tinting the empty areas.")
      .rgbaField("color", 0.0f, 0.0f, 0.0f, 1.0f, state::PrimaryInput)
        .label("Background", "BG")
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

// Per-instance init tail: defaults + per-instance fusion registration.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->color[0] = 0.0f; s->color[1] = 0.0f; s->color[2] = 0.0f; s->color[3] = 1.0f;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "color")) {
      auto v = state::patchVec4(i);
      s->color[0] = v.x; s->color[1] = v.y; s->color[2] = v.z; s->color[3] = v.w;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace bake_alpha
