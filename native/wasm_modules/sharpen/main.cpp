/*
 * filter.sharpen — Laplacian sharpen.
 *
 *   out = in + amount * (5 * center - up - down - left - right)
 *
 * The kernel is 5 taps. `amount` 0..1 maps perceptually to the Laplacian
 * gain. `radius` scales the tap spacing so heavier sharpens can pull
 * structure from larger neighbourhoods.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "sharpen_shaders.h"

namespace sharpen {

struct Uniforms {
  float amount;
  float radius_px;
  float _pad[2];
};

// Per-instance state. One per chain entry.
struct State {
  float amount = 0.4f;
  float radius = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("filter.sharpen", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Sharpen\n"
        "An unsharp-mask sharpener that boosts local contrast to make edges read "
        "crisper. *Amount* is the strength; *Radius* sets how wide the halo "
        "around each edge extends.\n\n"
        "**Try:** keep *Radius* small for detail crispening, or widen it for a "
        "punchy, high-contrast clarity look. At *Amount* 0 it's a pass-through.")
      .group("sharpen", "Sharpen")
        .groupHelp(
          "*Amount* drives the effect — push too far and edges gain bright/dark "
          "halos. *Radius* controls the scale of what counts as an edge: small = "
          "fine texture, large = broad shapes and structure.")
      .floatField("amount", 0.4f, 0.f, 1.f, state::PrimaryInput).label("Amount", "Amt")
      .floatField("radius", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Radius", "Rad")
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
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

// Per-instance init tail: defaults reset.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->amount = 0.4f;
  s->radius = 0.0f;
  s->initialized = false;
  if (!s_pso.valid()) return;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}


// Pure passthrough when amount == 0 (unsharp add contributes nothing).
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->amount == 0.0f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "amount")) s->amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius")) s->radius = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  // radius=0 → 1px (classic sharpen). radius=1 → ~2.5% of viewport min dim.
  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  float radius_px = 1.0f + s->radius * (static_cast<float>(min_dim) * 0.025f);

  Uniforms u = { s->amount, radius_px, {0, 0} };
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace sharpen
