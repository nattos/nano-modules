/*
 * composite.blend — an A/B CROSSFADER with a blend-mode transition flavor
 * (Resolume-crossfader semantics; see compute.hlsl for the exact fold).
 *
 *   opacity 0 → A as-is;  opacity 1 → B as-is (alpha included).
 *   In between, A and B fade by their shaped curve weights and the blend
 *   math shows in the curves' OVERLAP.
 *
 * NOT a layer compositor: the fader always lands on pure B, so e.g.
 * Multiply-at-1.0 is B, not A×B. (The executor's per-effect wet/dry blend,
 * host_blend.h, keeps compositor semantics — the two intentionally diverged.)
 *
 * Parameters:
 *   mode    (select, default Normal) — see the BlendMode enum / shader switch
 *   opacity (Standard, default 0.5) — the crossfader position, A → B
 *   shape   (Standard, default 0.5) — fade curve + blend presence
 *           (xfade::weightA/weightB, sketch/xfade_shape.h, computed CPU-side):
 *           0 = hard linear crossfade, NO overlap — the mode is inert;
 *           0.5 = equal-power fade, the blend flavors the middle;
 *           1 = full three-anchor transition A → blend(A,B) → B.
 *
 * Texture I/O:
 *   Input 0: Texture A
 *   Input 1: Texture B
 *   Output 0: Crossfade result
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <sketch/xfade_shape.h>
#include "video_blend_shaders.h"

namespace video_blend {

// Keep in lock-step with the switch in compute.hlsl and the selectField list.
enum BlendMode {
  Normal = 0, Add, Multiply, Screen, Overlay, Darken, Lighten,
  ColorDodge, ColorBurn, HardLight, SoftLight, Difference, Exclusion,
  Subtract, Divide, LinearBurn,
};

struct Uniforms {
  float w_a;   // A-side fade weight = xfade::weightA(opacity, shape)
  float w_b;   // B-side fade weight = xfade::weightB(opacity, shape)
  int mode;
  float _pad1;
};

// Per-instance state. One per chain entry.
struct State {
  float opacity = 0.5f;
  float shape = 0.5f;
  int mode = Normal;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("composite.blend", {2, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Blend\n"
        "An A/B **crossfader** with a blend-mode transition flavor: *Opacity* 0 "
        "shows A as-is, 1 shows B as-is, and in between the fade passes "
        "*through* the chosen Photoshop-style blend of the two.\n\n"
        "**Try:** *Add* or *Screen* for a light-stacking transition, *Multiply* "
        "for a darkening one, *Difference* for psychedelic edges mid-fade. "
        "Modulate *Opacity* from a wire to run the crossfade.")
      .group("blend", "Blend")
        .groupHelp(
          "*Mode* picks the blend math the fade passes through. *Opacity* is "
          "the crossfader — 0 is pure A, 1 is pure B at every shape. "
          "*Crossfade Shape* sets the fade curves and how much the blend shows: "
          "0 is a hard linear crossfade (no blend at all), 0.5 an equal-power "
          "fade with the blend flavoring the middle, 1 a full transition — "
          "A into the full-strength blend by mid-fade, then out to B.")
      .selectField("mode", Normal, state::PrimaryInput, {
        {"Normal", Normal}, {"Add", Add}, {"Multiply", Multiply},
        {"Screen", Screen}, {"Overlay", Overlay}, {"Darken", Darken},
        {"Lighten", Lighten}, {"Dodge", ColorDodge}, {"Burn", ColorBurn},
        {"Hard Light", HardLight}, {"Soft Light", SoftLight},
        {"Difference", Difference}, {"Exclusion", Exclusion},
        {"Subtract", Subtract}, {"Divide", Divide}, {"Linear Burn", LinearBurn},
      }, /*wrap=*/true, /*description=*/"Photoshop-style blend math the crossfade passes through")
        .label("Blend Mode", "Mode")
      .floatField("opacity", 0.5f, 0.f, 1.f, state::PrimaryInput,
                  /*magnitude=*/nullptr, /*step=*/0.01f, /*units=*/nullptr,
                  /*description=*/"Crossfader: A as-is (0) → B as-is (1)")
        .label("Opacity", "Opac")
      .floatField("shape", 0.5f, 0.f, 1.f, state::PrimaryInput,
                  /*magnitude=*/nullptr, /*step=*/0.01f, /*units=*/nullptr,
                  /*description=*/
                  "Fade curve + blend presence: linear/no blend (0) → equal-power (0.5) → full transition (1)")
        .label("Crossfade Shape", "Shape")
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_a", state::PrimaryInput)
      .textureField("tex_b", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);

  auto mod = gpu::Device::createShaderModuleByName("compute");
  if (!mod) return;

  s_pso = gpu::Device::createComputePSO(mod, "main", gpu::Bindings().tex2d(0).tex2d(1).storageTex2d(2).uniform(3));
  state::log("blend: module initialized");
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

// Per-instance init tail: defaults + ready guard.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->opacity = 0.5f;
  s->shape = 0.5f;
  s->mode = Normal;
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
  state::log("blend: init");
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
    if (state::pathIs(pb + off[i], len[i], "opacity"))
      s->opacity = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "shape"))
      s->shape = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "mode"))
      s->mode = state::patchInt(i);  // typed select/int reader
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto inputA = gpu::Device::inputTexture(0);
  auto inputB = gpu::Device::inputTexture(1);
  auto output = gpu::Device::renderTarget();

  if (!inputA.valid() || !inputB.valid()) return;

  Uniforms u = { xfade::weightA(s->opacity, s->shape),
                 xfade::weightB(s->opacity, s->shape), s->mode, 0 };
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(inputA, 0, 0);  // slot 0, read
  cp.setTexture(inputB, 1, 0);  // slot 1, read
  cp.setTexture(output, 2, 1);  // slot 2, write
  cp.setBuffer(s->uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace video_blend
