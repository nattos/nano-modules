/*
 * filter.sim.propagate — "Propagate": an outward-propagation engine.
 *
 * The spiritual successor to the old "Simulant" family. Simulant faked
 * propagation with a zoom-feedback hack (delay → zoom-out → blur → edge →
 * posterize → levels → composite): features DRIFTED toward one zoom centre and
 * the speed was welded to the zoom amount. We were never happy with it.
 *
 * This propagates the input's own structure OUTWARD as a real feedback field —
 * NOT a physical wave equation (that is CFL-capped to ~1 cell/frame, far too
 * slow, and keeps high-frequency detail that thresholds into mud). Instead:
 *
 *   • SEED FROM STRUCTURE — the seed is the input's luma, not random noise. A
 *     frame-difference seeds where the image changes (waves on changing pixels);
 *     a built-in FLICKER (Poisson auto-rate + a manual, replay-safe `trigger`)
 *     re-injects the whole input each pulse — "flickering the image" — so even a
 *     STATIC image radiates.
 *   • ADVECT OUTWARD — each frame the field is advected along its own smoothed
 *     gradient so every bright feature spreads AWAY from itself (a ring dilates
 *     into an expanding ring). The step is a free parameter (no CFL limit), so
 *     at max speed a front crosses the screen in ~3 frames.
 *   • DIFFUSE + DECAY — features blur out as they propagate (retaining the gross
 *     structure), and trailing fronts fade; re-seeding keeps a train of echoes.
 *   • LINES OVER INPUT — the composite pass thresholds the field into clean
 *     anti-aliased contour bands (the F = level isoline, which expands outward as
 *     each echo travels) over the dimmable input.
 *
 * Two compute passes/frame over a persistent ping-pong RGBA16F field:
 *   simulate (sim-res) → composite (viewport-res).
 * Stateful feedback sim: NO is_identity, NO temporal capability tag.
 */

#include <gpu.h>
#include <host.h>
#include "propagate_shaders.h"

#include <cmath>
#include <cstdint>

namespace propagate {

// --- Field / sim tuning constants ---
static constexpr int   SIM_MIN = 96;    // sim_scale=0 → chunky (loses detail)
static constexpr int   SIM_MAX = 640;   // sim_scale=1 → fine (retains detail)
static constexpr float MAX_STEP_DIV = 3.0f; // speed=1 → cross the field in 3 frames
static constexpr float RETAIN_HI = 0.985f;  // damping=0 → long trails
static constexpr float RETAIN_LO = 0.55f;   // damping=1 → fast fade
static constexpr float FEED_SCALE = 0.4f;   // continuous structure feed
static constexpr float FLICK_TAU  = 0.08f;  // flicker pulse half-life (s)
static constexpr float F_CLAMP    = 4.0f;   // field magnitude clamp

// Pass 1 — seed / advect / diffuse / decay.
struct SimUniforms {
  float dt, step, decay, diffuse;
  float change_threshold, change_soft, change_gain, flicker_seed;
  float feed, f_clamp, _p0, _p1;
  uint32_t have_history, frame, _u0, _u1;
};

// Pass 2 — threshold field → lines over input.
struct CompUniforms {
  float level, thickness, aa, input_mix;
  float line_r, line_g, line_b, field_gain;
  uint32_t line_count, debug_show_field, _p0, _p1;
};

struct State {
  // Persistent ping-pong field (RGBA16F): .r=F (intensity), .b=luma (this
  // frame's input luma → next frame's frame-diff).
  gpu::Texture field[2];
  int   cur = 0;                 // rd = cur, wr = cur ^ 1
  int   sim_w = 0, sim_h = 0;    // current field resolution (viewport-derived)
  bool  cleared = false;
  bool  have_history = false;    // first-frame guard (no ghost global seed)

  gpu::Buffer  sim_uniform;
  gpu::Buffer  comp_uniform;
  gpu::Sampler samp_lin;         // Linear + ClampToEdge (input + field advect)
  bool initialized = false;

  // --- Params (mirror the schema field names) ---
  float change_threshold = 0.06f;
  float change_gain      = 0.8f;
  float flicker          = 0.15f;
  float flicker_rate     = 0.4f;
  float speed            = 0.5f;
  float damping          = 0.3f;    // field decay / trail length
  float diffuse          = 0.18f;   // softening as it propagates
  float feed             = 0.0f;    // continuous structure re-injection
  float sim_scale        = 0.5f;
  float level            = 0.25f;
  float thickness        = 0.04f;
  int   line_count       = 3;
  float aa               = 0.02f;
  float sensitivity      = 0.5f;
  float line_r = 1.0f, line_g = 1.0f, line_b = 1.0f;
  float input_mix        = 0.5f;
  float debug_show_field = 0.0f;

  // --- Trigger / flicker envelope ---
  bool     trigger_prev = false;
  float    flicker_env  = 0.0f;      // decaying flicker pulse strength
  uint32_t flicker_rng  = 0xA53CF00Du;

  // --- Per-frame ---
  float    dt = 1.0f / 60.0f;
  uint32_t frame = 0;
};

static gpu::ComputePSO s_pso_sim;
static gpu::ComputePSO s_pso_comp;

void module_init() {
  state::init("filter.sim.propagate", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Propagate\n"
        "An outward-**propagation engine** — the successor to *Simulant*, done "
        "properly. It takes your input's **structure** and pushes it outward as a "
        "feedback field: features spread away from themselves, **blurring** as they "
        "travel (so the gross shape survives while detail softens), and the fronts "
        "are thresholded into **clean lines over your input**.\n\n"
        "**Try:** feed video and sweep *Speed* (a front can cross the screen in ~3 "
        "frames) and *Damping* (trail length). On a **static** image, crank "
        "*Flicker* (or tap *Trigger*) to re-inject the image and send out expanding "
        "echoes. *Diffuse* controls how fast features blur out; *Level* / "
        "*Thickness* shape the lines. Flip *Show Field* to watch the raw field.")

      // ---- Change: what seeds a wave ----
      .group("change", "Change")
        .groupHelp("Waves are born on **changing pixels** — the per-pixel "
                   "difference from the previous frame — seeded from the input's "
                   "own brightness. *Threshold* sets how much a pixel must change "
                   "to fire; *Strength* sets how hard it seeds.")
      .floatField("change_threshold", 0.06f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.005f, nullptr,
                  "How much a pixel must change (vs last frame) to seed a front.")
        .label("Change Threshold", "Thresh")
      .floatField("change_gain", 0.8f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How strongly a detected change seeds the field.")
        .label("Change Strength", "Gain")

      // ---- Flicker: induce propagation on a static image ----
      .group("flicker", "Flicker")
        .groupHelp("Make even a **static** image radiate. A flicker re-injects the "
                   "whole input (flickering the image) — periodically (Poisson "
                   "*Rate*) or on demand (*Trigger*) — sending out an expanding echo "
                   "of the structure. *Amount* 0 turns it off.")
      .floatField("flicker", 0.15f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Strength of the induced flicker re-injection (0 = off).")
        .label("Flicker Amount", "Flick")
      .floatField("flicker_rate", 0.4f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How often flicker pulses fire (Poisson; exponential → Hz).")
        .label("Flicker Rate", "Rate")
      .eventField("trigger", state::PrimaryInput)

      // ---- Propagation: the engine ----
      .group("propagation", "Propagation")
        .groupHelp("How the structure travels. *Speed* is how far a front moves per "
                   "frame (at max it crosses the screen in ~3 frames — no wave "
                   "limit). *Damping* fades trailing fronts (short = tight echoes, "
                   "long = deep trails). *Diffuse* is how fast features blur out as "
                   "they go. *Feed* continuously re-injects the input (a steady "
                   "standing pattern). *Scale* is the sim grid — high retains "
                   "detail, low is chunkier + cheaper.")
      .floatField("speed", 0.5f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How far the fronts advance each frame (max ≈ screen / 3 frames).")
        .label("Speed", "Speed")
      .floatField("damping", 0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How quickly trailing fronts fade (0 = long trails).")
        .label("Damping", "Damp")
      .floatField("diffuse", 0.18f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How fast features blur out as they propagate.")
        .label("Diffuse", "Diff")
      .floatField("feed", 0.0f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Continuously re-inject the input structure (steady standing pattern).")
        .label("Feed", "Feed")
      .floatField("sim_scale", 0.5f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Sim grid resolution — high retains detail, low is chunky + cheap.")
        .label("Detail Scale", "Scale")

      // ---- Line: threshold the field to clean lines ----
      .group("line", "Line")
        .groupHelp("The fronts become lines. A line is drawn where the field equals "
                   "*Level* — that contour expands outward as the front travels. "
                   "*Thickness* is the width; *Count* stacks concentric contours; "
                   "*Sensitivity* scales the field into range.")
      .floatField("level", 0.25f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.005f, nullptr,
                  "Contour spacing — where the tone-mapped field crosses a line.")
        .label("Line Level", "Level")
      .floatField("thickness", 0.04f, 0.f, 0.5f, state::PrimaryInput, nullptr, 0.005f, nullptr,
                  "Line width (half-band around each contour).")
        .label("Line Thickness", "Thick")
      .intField("line_count", 3, 1, 6, state::SecondaryInput)
        .label("Line Count", "Count")
      .floatField("aa", 0.02f, 0.001f, 0.2f, state::SecondaryInput, nullptr, 0.001f, nullptr,
                  "Edge softness of the line band (anti-alias).")
        .label("Line Softness", "AA")
      .floatField("sensitivity", 0.5f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Display gain on the field (brings faint fronts into range).")
        .label("Sensitivity", "Sens")

      // ---- Look: composite over input ----
      .group("look", "Look")
      .rgbField("line_color", 1.f, 1.f, 1.f, state::PrimaryInput)
        .label("Line Colour", "Colour")
      .floatField("input_mix", 0.5f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How much of the input image shows through under the lines.")
        .label("Input Mix", "Input")

      // ---- Debug ----
      .group("debug", "Debug")
      .boolField("debug_show_field", false, state::SecondaryInput,
                 "Show the raw propagation field instead of the lines.")
        .label("Show Field", "Field")

      // ---- I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      // Stateful feedback sim → no temporal capability tag (real history).
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // The simulate pass writes an RGBA16F storage field → override naga's default
  // rgba32float. The composite pass writes the default rgba8unorm tex_out.
  state::registerShaderSPV("propagate_simulate",  SIMULATE_SPV,  SIMULATE_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("propagate_composite", COMPOSITE_SPV, COMPOSITE_SPV_SIZE);

  auto cs_sim  = gpu::Device::createShaderModuleByName("propagate_simulate");
  auto cs_comp = gpu::Device::createShaderModuleByName("propagate_composite");
  if (!cs_sim || !cs_comp) return;

  s_pso_sim = gpu::Device::createComputePSO(cs_sim, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).sampler(2).storageTex2d(3, gpu::TextureFormat::RGBA16F).uniform(4));
  s_pso_comp = gpu::Device::createComputePSO(cs_comp, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).sampler(2).storageTex2d(3, gpu::TextureFormat::RGBA8).uniform(4));

  state::log("propagate: module initialized");
}

void* create() {
  auto* s = new State();
  s->sim_uniform  = gpu::Device::createBuffer(sizeof(SimUniforms),  gpu::BufferUsage::Uniform);
  s->comp_uniform = gpu::Device::createBuffer(sizeof(CompUniforms), gpu::BufferUsage::Uniform);
  s->samp_lin     = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->field[0].release();
  s->field[1].release();
  s->sim_uniform.release();
  s->comp_uniform.release();
  s->samp_lin.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_sim.valid() || !s_pso_comp.valid()) return;
  s->cur = 0;
  s->cleared = false;
  s->have_history = false;
  s->frame = 0;
  s->flicker_env = 0.0f;
  s->flicker_rng = 0xA53CF00Du;
  s->trigger_prev = false;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->dt = (float)dt;
  s->frame++;

  // Flicker Poisson auto-fire (style guide §4.1). rate slider → Hz on an
  // exponential curve; a fired event re-injects the input at the flicker amount.
  if (s->flicker > 0.0f && s->flicker_rate > 0.0f) {
    float rate_hz = std::pow(60.0f, s->flicker_rate) - 1.0f;
    float lambda  = rate_hz * (float)dt;
    s->flicker_rng = s->flicker_rng * 1664525u + 1013904223u;
    float u = (s->flicker_rng >> 8) * (1.0f / 16777216.0f);
    if (u < 1.0f - std::exp(-lambda)) s->flicker_env = s->flicker;
  }
  // Decay the flicker pulse.
  s->flicker_env *= std::exp(-(float)dt / FLICK_TAU);
  if (s->flicker_env < 1e-4f) s->flicker_env = 0.0f;
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "change_threshold")) s->change_threshold = state::patchFloat(i);
    else if (state::pathIs(p, l, "change_gain"))      s->change_gain      = state::patchFloat(i);
    else if (state::pathIs(p, l, "flicker"))          s->flicker          = state::patchFloat(i);
    else if (state::pathIs(p, l, "flicker_rate"))     s->flicker_rate     = state::patchFloat(i);
    else if (state::pathIs(p, l, "speed"))            s->speed            = state::patchFloat(i);
    else if (state::pathIs(p, l, "damping"))          s->damping          = state::patchFloat(i);
    else if (state::pathIs(p, l, "diffuse"))          s->diffuse          = state::patchFloat(i);
    else if (state::pathIs(p, l, "feed"))             s->feed             = state::patchFloat(i);
    else if (state::pathIs(p, l, "sim_scale"))        s->sim_scale        = state::patchFloat(i);
    else if (state::pathIs(p, l, "level"))            s->level            = state::patchFloat(i);
    else if (state::pathIs(p, l, "thickness"))        s->thickness        = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_count"))       s->line_count       = state::patchInt(i);
    else if (state::pathIs(p, l, "aa"))               s->aa               = state::patchFloat(i);
    else if (state::pathIs(p, l, "sensitivity"))      s->sensitivity      = state::patchFloat(i);
    else if (state::pathIs(p, l, "input_mix"))        s->input_mix        = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_show_field")) s->debug_show_field = state::patchBool(i) ? 1.0f : 0.0f;
    else if (state::pathIs(p, l, "line_color")) {
      auto v = state::patchVec3(i); s->line_r = v.x; s->line_g = v.y; s->line_b = v.z;
    }
    else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchFloat(i) != 0.0f;
      if (t && !s->trigger_prev) s->flicker_env = 1.0f;   // rising edge → full pulse
      s->trigger_prev = t;
    }
  }
}

// Field resolution follows the viewport aspect, longest side set by sim_scale.
// (Re)allocate + re-prime the ping-pong pair only when the target size changes.
static bool ensure_field(State* s, int vp_w, int vp_h) {
  float t = s->sim_scale; if (t < 0.f) t = 0.f; if (t > 1.f) t = 1.f;
  int longSide = (int)std::lround(SIM_MIN + (SIM_MAX - SIM_MIN) * t);
  if (longSide < 16) longSide = 16;
  int sw, sh;
  if (vp_w >= vp_h) { sw = longSide; sh = (int)std::lround((float)longSide * vp_h / (float)vp_w); }
  else              { sh = longSide; sw = (int)std::lround((float)longSide * vp_w / (float)vp_h); }
  if (sw < 8) sw = 8; if (sh < 8) sh = 8;

  if (s->field[0].valid() && s->field[1].valid() && s->sim_w == sw && s->sim_h == sh)
    return true;

  s->field[0].release();
  s->field[1].release();
  s->field[0] = gpu::Device::createTexture(sw, sh, gpu::TextureFormat::RGBA16F);
  s->field[1] = gpu::Device::createTexture(sw, sh, gpu::TextureFormat::RGBA16F);
  s->sim_w = sw; s->sim_h = sh;
  s->cur = 0;
  s->cleared = false;         // re-clear on first render at the new size
  s->have_history = false;    // re-prime the frame-diff (no ghost seed)
  return s->field[0].valid() && s->field[1].valid();
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  if (!ensure_field(s, vp_w, vp_h)) return;

  if (!s->cleared) {
    gpu::Device::clear(s->field[0], 0.f, 0.f, 0.f, 0.f);
    gpu::Device::clear(s->field[1], 0.f, 0.f, 0.f, 0.f);
    s->cleared = true;
  }

  float dt = s->dt;
  if (dt <= 0.f) dt = 1.0f / 60.0f;
  int rd = s->cur, wr = s->cur ^ 1;

  // --- Pass 1: seed → advect outward → diffuse → decay (sim-res) ---
  // Advection step in cells: at speed=1 a front crosses the field's longest side
  // in MAX_STEP_DIV frames. No CFL limit — it's a lookup, not a wave stencil.
  float longSide = (float)(s->sim_w > s->sim_h ? s->sim_w : s->sim_h);
  SimUniforms su = {};
  su.dt               = dt;
  su.step             = s->speed * (longSide / MAX_STEP_DIV);
  su.decay            = RETAIN_HI + (RETAIN_LO - RETAIN_HI) * s->damping;
  su.diffuse          = s->diffuse * 0.9f;            // keep some of the advected value
  su.change_threshold = s->change_threshold;
  su.change_soft      = 0.05f;
  su.change_gain      = s->change_gain;
  su.flicker_seed     = s->flicker_env;
  su.feed             = s->feed * FEED_SCALE;
  su.f_clamp          = F_CLAMP;
  su.have_history     = s->have_history ? 1u : 0u;
  su.frame            = s->frame;
  s->sim_uniform.writeOne(su);
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_sim);
    cp.setTexture(s->field[rd], 0, 0);   // prev field (Load + Sample)
    cp.setTexture(in, 1, 0);             // current input (structure seed)
    cp.setSampler(s->samp_lin, 2);
    cp.setTexture(s->field[wr], 3, 1);   // new field (storage write)
    cp.setBuffer(s->sim_uniform, 4);
    cp.dispatch((s->sim_w + 7) / 8, (s->sim_h + 7) / 8);
    cp.end();
  }

  // --- Pass 2: threshold field → lines over input (viewport-res) ---
  int lc = s->line_count; if (lc < 1) lc = 1; if (lc > 6) lc = 6;
  CompUniforms cu = {};
  cu.level      = s->level;
  cu.thickness  = s->thickness;
  cu.aa         = s->aa;
  cu.input_mix  = s->input_mix;
  cu.line_r     = s->line_r;
  cu.line_g     = s->line_g;
  cu.line_b     = s->line_b;
  cu.field_gain = 1.5f + s->sensitivity * 10.5f;   // tone-map steepness (1 - e^-F*gain)
  cu.line_count = (uint32_t)lc;
  cu.debug_show_field = s->debug_show_field > 0.5f ? 1u : 0u;
  s->comp_uniform.writeOne(cu);
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_comp);
    cp.setTexture(in, 0, 0);             // input (full res)
    cp.setTexture(s->field[wr], 1, 0);   // field (sampled, upscaled)
    cp.setSampler(s->samp_lin, 2);
    cp.setTexture(out, 3, 1);
    cp.setBuffer(s->comp_uniform, 4);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  s->cur = wr;
  s->have_history = true;   // after this frame the field's .b holds a valid luma
  gpu::Device::submit();
}

} // namespace propagate
