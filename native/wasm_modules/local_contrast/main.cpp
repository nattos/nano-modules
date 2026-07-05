/*
 * filter.local_contrast — "Local Contrast" (clarity).
 *
 * A large-radius unsharp mask: blur tex_in WIDE (the local average), then add
 * the difference back so mid-scale structure gains "pop". It's the missing
 * middle between filter.sharpen (a ~1px Laplacian — fine edges) and a plain
 * blur (pure low-pass). The photographic Clarity / Dehaze knob.
 *
 * Pipeline (two dispatches): fx::FastBlur(tex_in → lowpass), then a combine
 * pass that reads the original + the low-pass and writes tex_out. The combine
 * is luma-preserving by default (boost luminance contrast, scale RGB to match —
 * no chroma halos), with a midtone-protection knob and an RGB (per-channel)
 * tuning mode. See combine.hlsl.
 *
 * Blur engine: fx::FastBlur (cheap, wide, min-dim relative). `radius` quantizes
 * to its 6 integer iteration steps — a future "Precise" mode would swap in
 * fx::GaussianBlur::applyWithRadius for a smooth radius.
 *
 * Per-instance instance ABI (class-like): module_init() compiles the shared
 * combine PSO + publishes the schema once per type; each chain entry gets its
 * own State (params, uniform buffer, low-pass texture, fx::FastBlur helper).
 */

#include <gpu.h>
#include <host.h>
#include <effect_fast_blur.h>
#include "local_contrast_shaders.h"

#include <cmath>
#include <cstdint>

namespace local_contrast {

static constexpr float AMOUNT_GAIN = 3.0f;   // amount=1 → this much unsharp gain

struct Uniforms {
  float amount_gain;
  float protect_k;
  int   mode;
  float recover;
  float rolloff;              // starts the 2nd 16-byte cbuffer register
  float _pad0, _pad1, _pad2;
};
static_assert(sizeof(Uniforms) == 32, "Uniforms layout mismatch");

struct State {
  fx::FastBlur blur;                    // by value — owns its mip-pyramid scratch
  gpu::Buffer  uniform_buf;
  gpu::Texture lowpass;                 // per-instance wide low-pass (combine reads it)
  int          lp_w = 0, lp_h = 0;
  bool         initialized = false;

  // Schema-mirrored params.
  float amount  = 0.5f;
  float radius  = 0.5f;
  float protect = 0.5f;
  int   mode    = 0;    // 0 = Luma, 1 = RGB
  float recover = 0.0f; // highlight colour recovery (0 = off)
  float rolloff = 0.5f; // non-linear squash of the recovered chroma (0 = linear)
};

// Type-shared, compiled once.
static gpu::ComputePSO s_pso_combine;

void module_init() {
  state::init("filter.local_contrast", {1, 0, 2},
    state::Schema()
      .helpField("intro",
        "## Local Contrast\n"
        "A large-radius unsharp mask that boosts mid-scale **structure** — the "
        "photographic *Clarity* look. Where *Sharpen* crispens fine 1px edges, "
        "Local Contrast works on a wide neighbourhood, giving the image punch and "
        "depth without a hard, over-sharpened bite.\n\n"
        "**Try:** push *Amount* for pop, then set *Radius* to choose the scale of "
        "\"local\" (small = texture, large = broad shapes). Keep *Protect* up to "
        "hold highlights and shadows clean. Raise *Highlight Colour* to bleed the "
        "surrounding hue back into blown-out peaks (recovering rolled-off saturated "
        "colour). At *Amount* 0 with *Highlight Colour* 0 it's a pass-through.")
      .group("contrast", "Local Contrast")
        .groupHelp(
          "*Amount* is the strength of the boost; *Radius* sets how wide the "
          "\"local average\" is — the bigger the radius, the broader the "
          "structures that get enhanced (and the softer, more atmospheric the "
          "result).")
      .floatField("amount", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Amount", "Amt")
      .floatField("radius", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Radius", "Rad")
      .group("shape", "Tone")
        .groupHelp(
          "*Protect* biases the boost toward the midtones so highlights don't "
          "blow out and shadows don't crush (0 = boost everything, 1 = strong "
          "midtone bias). *Color Mode* — *Luma* preserves hue/saturation; *RGB* "
          "boosts each channel independently for a grittier, punchier feel. "
          "*Highlight Colour* re-tints blown, greyed-out peaks with the hue of the "
          "region around them (0 = off) — great for putting the saturated colour "
          "back into bright lights that clipped toward white. *Colour Roll-off* "
          "sets how hard that recovered chroma squashes: 0 is a plain linear tint, "
          "higher rolls the off-colours off non-linearly for richer, juicier "
          "\"film shoulder\" peaks.")
      .floatField("protect", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Protect", "Prot")
      .selectField("mode", 0, state::PrimaryInput, {{"Luma", 0}, {"RGB", 1}})
        .label("Color Mode", "Color")
      .floatField("recover", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Highlight Colour", "HiCol")
      .floatField("rolloff", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Colour Roll-off", "Roll")
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("local_contrast_combine", COMBINE_SPV, COMBINE_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("local_contrast_combine");
  if (!cs) return;
  s_pso_combine = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).storageTex2d(2, gpu::TextureFormat::RGBA8).uniform(3));
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  if (s->lowpass.valid()) s->lowpass.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->amount = 0.5f;
  s->radius = 0.5f;
  s->protect = 0.5f;
  s->mode = 0;
  s->recover = 0.0f;
  s->rolloff = 0.5f;
  s->initialized = false;
  if (!s_pso_combine.valid() || !s->uniform_buf.valid()) return;
  if (!s->blur.init()) return;
  s->initialized = true;
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
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "amount"))  s->amount  = state::patchFloat(i);
    else if (state::pathIs(path, plen, "radius"))  s->radius  = state::patchFloat(i);
    else if (state::pathIs(path, plen, "protect")) s->protect = state::patchFloat(i);
    else if (state::pathIs(path, plen, "mode"))    s->mode    = state::patchInt(i);
    else if (state::pathIs(path, plen, "recover")) s->recover = state::patchFloat(i);
    else if (state::pathIs(path, plen, "rolloff")) s->rolloff = state::patchFloat(i);
  }
}

void on_resolume_param(void* self, long long, double) { (void)self; }

// Pure passthrough when there's neither a contrast boost nor highlight recovery.
// Stateless (no tick accumulator), so a skipped frame can't desync anything.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return 0;
  return (s->amount <= 0.0f && s->recover <= 0.0f) ? 1 : 0;
}

static void ensureLowpass(State* s, int w, int h) {
  if (s->lowpass.valid() && s->lp_w == w && s->lp_h == h) return;
  if (s->lowpass.valid()) s->lowpass.release();
  s->lowpass = gpu::Device::createTexture(w, h);
  s->lp_w = w;
  s->lp_h = h;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  if (!s->blur.valid()) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // The wide low-pass drives both the contrast detail AND (when enabled) the
  // halo hue for highlight recovery, so compute it if either is active. When
  // neither is, bind the original at slot 1 so detail == 0 and we skip the blur
  // dispatch entirely (still writes a valid tex_out for tapped entries).
  const bool need_low = s->amount > 0.0f || s->recover > 0.0f;
  gpu::Texture low = in;
  if (need_low) {
    ensureLowpass(s, vp_w, vp_h);
    if (!s->lowpass.valid()) return;
    // radius 0..1 → 1..MAX_ITERATIONS wide-blur steps (quantized — see header).
    int iter = 1 + (int)std::lround(s->radius * (float)(fx::FastBlur::MAX_ITERATIONS - 1));
    s->blur.apply(in, s->lowpass, vp_w, vp_h, iter);
    low = s->lowpass;
  }

  Uniforms u = {};
  u.amount_gain = s->amount * AMOUNT_GAIN;
  // protect 0 → k=6 (bell flat, boost everywhere); protect 1 → k=0.4 (narrow
  // midtone bell, strong highlight/shadow protection).
  u.protect_k   = 6.0f + (0.4f - 6.0f) * s->protect;
  u.mode        = s->mode;
  u.recover     = s->recover;
  u.rolloff     = s->rolloff;
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso_combine);
  cp.setTexture(in,  0, 0);
  cp.setTexture(low, 1, 0);
  cp.setTexture(out, 2, 1);
  cp.setBuffer(s->uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace local_contrast
