/*
 * color.saturate — Per-channel tanh waveshaper that scales from
 * black.
 *
 *   y = x * prescale                          (scales from 0; prescale=0 → pure black)
 *   y <= deadzone   → out = y                 (linear pass)
 *   y >  deadzone   → out = dz + (1 - dz) * tanh((y - dz) / (1 - dz) * 2^asymm)
 *
 * `prescale` is the only multiplier on the input. `linear_deadzone`
 * carves out a flat pass-through region from 0 up to dz so darks /
 * mids stay untouched, with the tanh kicking in only above. `asymm`
 * shapes the tanh shoulder (positive → sharper limit; negative →
 * gentler / more linear past the deadzone). Alpha is untouched.
 *
 * Slopes are continuous at the deadzone boundary so there's no
 * visible knee artifact when sweeping `linear_deadzone`.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "saturate_shaders.h"

namespace saturate {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl. Field order
// and sizes are part of the cbuffer ABI; pixel.hlsl is the single
// source of truth for the per-pixel kernel and this struct mirrors
// its uniform block.
struct FuseUniforms {
  float prescale;
  float asymm;
  float linear_deadzone;
  float _pad;
};

// Per-instance state. One per chain entry.
struct State {
  float prescale = 1.0f;
  float asymm    = 0.0f;
  float deadzone = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Update the uniform buffer for the current frame. Called from
// render() (standalone path) and from the engine via the fusion
// prepare callback (fused path) — both share the same uniform write
// so output is identical.
void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s->prescale, s->asymm, s->deadzone, 0.f };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.saturate", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Saturate\n"
        "A per-channel tanh waveshaper that gently rolls highlights toward a soft "
        "ceiling instead of hard-clipping. *Prescale* is the input gain (0 = black), "
        "*Deadzone* keeps darks and mids linear, and *Shoulder* shapes how hard the "
        "limiter bites above the deadzone. Alpha is untouched.\n\n"
        "**Try:** push *Prescale* past 1 for a hot, filmic roll-off, then raise "
        "*Deadzone* to protect the shadows.")
      .group("shape", "Waveshaper")
        .groupHelp(
          "Signal is scaled by *Prescale*, passed straight through up to the "
          "*Deadzone*, then folded by a tanh above it. The slopes match at the "
          "boundary so sweeping *Deadzone* never pops. Positive *Shoulder* = a "
          "sharper limit; negative = a softer, more linear knee.")
      .floatField("prescale",        1.0f, 0.f, 4.f, state::PrimaryInput).label("Prescale", "Pre")
      .floatField("asymm",           0.0f, -1.f, 1.f, state::PrimaryInput).label("Shoulder", "Shldr")
      .floatField("linear_deadzone", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Deadzone", "Dead")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Register SPIR-V blobs by name. Host translates SPV → platform
  // shader source (WGSL/MSL) on demand via naga; effects don't carry
  // per-platform text anymore.
  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  // Entry point name is always "main" now — naga's WGSL output
  // preserves it; MSL gets renamed to "main_" by the host on Metal
  // backends if we ever wire that path.
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1)
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
  s->prescale = 1.0f;
  s->asymm    = 0.0f;
  s->deadzone = 0.0f;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  // PerPixelMapper fusion: the dispatcher splices fuse_transform
  // from the registered "pixel" SPV into composed shaders. The
  // name-based variant defers SPV → WGSL → strip until the dispatcher
  // first composes a shader that needs it.
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
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "prescale"))        s->prescale = state::patchFloat(i);
    else if (state::pathIs(p, l, "asymm"))           s->asymm    = state::patchFloat(i);
    else if (state::pathIs(p, l, "linear_deadzone")) s->deadzone = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace saturate
