/*
 * composite.layer — Lays texture B over texture A with a selectable blend
 * mode: a LAYER COMPOSITOR (opacity scales the top's coverage; opacity 1
 * shows the FULL-strength blend, e.g. Multiply-at-1 = A×B).
 *
 * This is the compositor counterpart of `composite.blend`, which became a
 * pure A/B CROSSFADER (its fader always lands on B as-is). The two split so
 * each keeps clean semantics; the arrangement's comp builder
 * (native/src/sketch/comp/sketch_build.h) synthesizes THIS effect for its
 * per-layer compositing, and the executor's per-effect wet/dry pass
 * (host_blend.h) folds the same coverage math.
 *
 *   blended = mode(A.rgb, B.rgb)    (per the chosen Photoshop-style mode)
 *   output  = (blended) OVER A, by B.alpha × weightB(opacity, shape)
 *
 * ALPHA IS PRESERVED — a transparent B reveals A and the composite carries
 * real transparency downstream. For opaque inputs this reduces to
 * lerp(A, blended, opacity) with alpha 1 at shape 0.
 *
 * Parameters:
 *   mode    (select, default Normal) — see the BlendMode enum / shader switch
 *   opacity (Standard, default 1) — the top layer's coverage
 *   shape   (Standard, default 0) — bends the opacity fade curve
 *           (xfade::weightB, sketch/xfade_shape.h, computed CPU-side):
 *           0 = linear, 0.5 = equal-power, 1 = full coverage by mid-fade.
 *
 * Texture I/O:
 *   Input 0: Texture A (base)
 *   Input 1: Texture B (top layer)
 *   Output 0: Composited result
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <sketch/xfade_shape.h>
#include "video_layer_shaders.h"

namespace video_layer {

// Keep in lock-step with the switch in compute.hlsl and the selectField list
// (and video_blend's — the mode vocabulary is shared).
enum BlendMode {
  Normal = 0, Add, Multiply, Screen, Overlay, Darken, Lighten,
  ColorDodge, ColorBurn, HardLight, SoftLight, Difference, Exclusion,
  Subtract, Divide, LinearBurn,
};

struct Uniforms {
  float w_b;   // top coverage weight = xfade::weightB(opacity, shape)
  int mode;
  float _pad1, _pad2;
};

// Per-instance state. One per chain entry.
struct State {
  float opacity = 1.0f;
  float shape = 0.0f;
  int mode = Normal;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("composite.layer", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Layer\n"
        "Lays input B over input A with a selectable **blend mode** — a layer "
        "compositor: at full *Opacity* you see the full-strength blend "
        "(*Multiply* at 1 is A×B). B's alpha scales its coverage, so a "
        "transparent B reveals A and the result stays composable downstream.\n\n"
        "**Try:** *Add* or *Screen* for glow and light stacking, *Multiply* for "
        "shadows and tint. For an A→B crossfade that lands on pure B, use the "
        "*Blend* effect instead.")
      .group("blend", "Blend")
        .groupHelp(
          "*Mode* picks the blend math applied to B before it's laid over A. "
          "*Opacity* scales the top layer's coverage — 0 shows A untouched, 1 "
          "the fully blended result. *Fade Shape* bends that curve: 0 linear, "
          "0.5 equal-power, 1 full coverage by mid-fade.")
      .selectField("mode", Normal, state::PrimaryInput, {
        {"Normal", Normal}, {"Add", Add}, {"Multiply", Multiply},
        {"Screen", Screen}, {"Overlay", Overlay}, {"Darken", Darken},
        {"Lighten", Lighten}, {"Dodge", ColorDodge}, {"Burn", ColorBurn},
        {"Hard Light", HardLight}, {"Soft Light", SoftLight},
        {"Difference", Difference}, {"Exclusion", Exclusion},
        {"Subtract", Subtract}, {"Divide", Divide}, {"Linear Burn", LinearBurn},
      }, /*wrap=*/true, /*description=*/"Photoshop-style blend math applied before opacity")
        .label("Blend Mode", "Mode")
      .floatField("opacity", 1.0f, 0.f, 1.f, state::PrimaryInput,
                  /*magnitude=*/nullptr, /*step=*/0.01f, /*units=*/nullptr,
                  /*description=*/"Top-layer coverage: A untouched (0) → fully blended result (1)")
        .label("Opacity", "Opac")
      .floatField("shape", 0.f, 0.f, 1.f, state::PrimaryInput,
                  /*magnitude=*/nullptr, /*step=*/0.01f, /*units=*/nullptr,
                  /*description=*/
                  "Fade curve: linear (0) → equal-power (0.5) → full coverage by mid-fade (1)")
        .label("Fade Shape", "Shape")
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
  state::log("layer: module initialized");
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
  s->opacity = 1.0f;
  s->shape = 0.0f;
  s->mode = Normal;
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
  state::log("layer: init");
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

  Uniforms u = { xfade::weightB(s->opacity, s->shape), s->mode, 0, 0 };
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

} // namespace video_layer
