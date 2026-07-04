/*
 * filter.sim.propagate — "Propagate": a real wave-propagation engine.
 *
 * The spiritual successor to the old "Simulant" family. Simulant faked
 * propagation with a zoom-feedback hack (delay → zoom-out → blur → edge →
 * posterize → levels → composite): features DRIFTED toward one zoom centre, the
 * speed was welded to the zoom amount, and the result was mushy. We were never
 * happy with it. This builds the propagation as a REAL damped 2D wave field:
 *
 *   • CHANGE DETECTION — each frame we diff the input luma against last frame's
 *     (the previous luma is folded into the field's .b channel, so no separate
 *     history texture). Pixels that change kick the wave field with a velocity
 *     impulse — ripples are born wherever the image moves.
 *   • FLICKER INDUCEMENT — a built-in flicker (Poisson auto-rate + a manual,
 *     replay-safe `trigger`) injects a grainy global impulse so even a STATIC
 *     image radiates. (Simulant "flickered the image" to force change; same
 *     idea, folded straight into the seed.)
 *   • PROPAGATION — a genuine damped wave equation (velocity/displacement form)
 *     on a reduced-resolution ping-pong RGBA16F field. Ripples travel outward at
 *     a controlled speed, INTERFERE between sources, and decay. dt is baked into
 *     the timestep (style guide §2.1) and the wave speed is CFL-clamped on the
 *     CPU so the explicit scheme stays stable; u/v are NaN-sanitized + magnitude
 *     clamped per the persistent-sim gotcha.
 *   • LINES OVER INPUT — the composite pass thresholds the wave crests into
 *     clean anti-aliased contour bands (the |u| = level isoline, which expands
 *     outward as the ripple travels) and paints them over the dimmable input.
 *
 * Two compute passes/frame over a persistent field (modelled on d_wave):
 *   simulate (sim-res)  → composite (viewport-res).
 * Stateful feedback sim: NO is_identity, NO temporal capability tag.
 */

#include <gpu.h>
#include <host.h>
#include "propagate_shaders.h"

#include <cmath>
#include <cstdint>

namespace propagate {

// --- Field / sim tuning constants (all dt-baked; see style guide §2.1) ---
static constexpr int   SIM_MIN = 96;    // sim_scale=0 → chunky, big waves
static constexpr int   SIM_MAX = 512;   // sim_scale=1 → fine
static constexpr float C_MAX   = 45.0f; // speed=1 → wave phase speed (cells/sec)
static constexpr float CFL     = 0.7f;  // explicit-scheme stability: c*dt ≤ CFL
static constexpr float B_MIN   = 0.3f;  // damping floor (1/s) — waves still die
static constexpr float B_MAX   = 8.0f;  // damping=1 (1/s)
static constexpr float K_MAX   = 120.0f;// stiffness=1 → restoring rate (1/s²)
static constexpr float FLICK_TAU  = 0.12f; // flicker pulse half-life (s)
static constexpr float U_CLAMP = 4.0f;     // displacement magnitude clamp
static constexpr float V_CLAMP = 300.0f;   // velocity magnitude clamp

// Pass 1 — diff / inject / wave integrate.
struct SimUniforms {
  float dt, c2, damp, stiffness;                                   // integrate
  float change_threshold, change_soft, seed_gain, _s0;            // frame-diff seed
  float flicker_pulse, flicker_detail, u_clamp, v_clamp;          // flicker + stability
  uint32_t have_history, frame, _p0, _p1;
};

// Pass 2 — threshold crests → lines over input.
struct CompUniforms {
  float level, thickness, aa, input_mix;
  float line_r, line_g, line_b, field_gain;
  uint32_t line_count, debug_show_field, _p0, _p1;
};

struct State {
  // Persistent ping-pong wave field (RGBA16F): .r=u (displacement),
  // .g=v (velocity), .b=luma (this frame's input luma → next frame's diff).
  gpu::Texture field[2];
  int   cur = 0;                 // rd = cur, wr = cur ^ 1
  int   sim_w = 0, sim_h = 0;    // current field resolution (viewport-derived)
  bool  cleared = false;
  bool  have_history = false;    // first-frame guard (no ghost global seed)

  gpu::Buffer  sim_uniform;
  gpu::Buffer  comp_uniform;
  gpu::Sampler samp_lin;         // Linear + ClampToEdge (input + field upscale)
  bool initialized = false;

  // --- Params (mirror the schema field names) ---
  float change_threshold = 0.08f;
  float change_gain      = 0.6f;
  float flicker          = 0.15f;
  float flicker_rate     = 0.35f;
  float flicker_detail   = 0.5f;
  float speed            = 0.4f;
  float damping          = 0.35f;
  float stiffness        = 0.06f;
  float sim_scale        = 0.35f;
  float level            = 0.16f;
  float thickness        = 0.06f;
  int   line_count       = 1;
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
        "A real **wave-propagation engine** — the successor to *Simulant*, done "
        "properly. Instead of faking growth with zoom-feedback, it runs a genuine "
        "damped wave field: wherever the image **changes**, a ripple is born and "
        "travels **outward**, interfering with its neighbours, and the wave crests "
        "are thresholded into **clean lines drawn over your input**.\n\n"
        "**Try:** feed video and sweep *Speed* / *Damping* to tune how far ripples "
        "run. On a **static** image, crank *Flicker* (or tap *Trigger*) to force it "
        "to radiate. Dial *Level* / *Thickness* for the line look, and flip "
        "*Show Field* to watch the raw waves while you tune.")

      // ---- Change: what seeds a wave ----
      .group("change", "Change")
        .groupHelp("Waves are born on **changing pixels** — the per-pixel "
                   "difference from the previous frame. *Threshold* sets how much "
                   "a pixel must change to fire; *Strength* sets how hard the "
                   "change kicks the wave.")
      .floatField("change_threshold", 0.08f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.005f, nullptr,
                  "How much a pixel must change (vs last frame) to seed a ripple.")
        .label("Change Threshold", "Thresh")
      .floatField("change_gain", 0.6f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How strongly a detected change kicks the wave.")
        .label("Change Strength", "Gain")

      // ---- Flicker: induce change on a static image ----
      .group("flicker", "Flicker")
        .groupHelp("Make even a **static** image ripple. A flicker fires a grainy "
                   "global impulse — periodically (Poisson *Rate*) or on demand "
                   "(*Trigger*). *Amount* 0 turns it off (waves then come only from "
                   "real motion).")
      .floatField("flicker", 0.15f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Strength of the induced flicker impulse (0 = off).")
        .label("Flicker Amount", "Flick")
      .floatField("flicker_rate", 0.35f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How often flicker pulses fire (Poisson; exponential → Hz).")
        .label("Flicker Rate", "Rate")
      .eventField("trigger", state::PrimaryInput)
      .floatField("flicker_detail", 0.5f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "How much the flicker keys off bright image regions vs a uniform grain.")
        .label("Flicker Detail", "Detail")

      // ---- Propagation: the engine ----
      .group("propagation", "Propagation")
        .groupHelp("The wave medium. *Speed* is how fast ripples travel (CFL-"
                   "clamped so it stays stable); *Damping* is how quickly they die "
                   "(short = tight rings, long = deep trails). *Stiffness* adds a "
                   "restoring force (shorter wavelength / more shimmer). *Scale* is "
                   "the sim grid — coarse = bigger, chunkier waves and cheaper.")
      .floatField("speed", 0.4f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How fast the ripples travel outward.")
        .label("Speed", "Speed")
      .floatField("damping", 0.35f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How quickly ripples fade as they travel.")
        .label("Damping", "Damp")
      .floatField("stiffness", 0.06f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Restoring force — higher = shorter wavelength / more shimmer.")
        .label("Stiffness", "Stiff")
      .floatField("sim_scale", 0.35f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Sim grid resolution — low = chunky big waves (cheaper), high = fine.")
        .label("Wave Scale", "Scale")

      // ---- Line: threshold crests to clean lines ----
      .group("line", "Line")
        .groupHelp("The wave crests become lines. A line is drawn where the wave "
                   "amplitude equals *Level* — that contour expands outward as the "
                   "ripple travels. *Thickness* is the line width; *Count* stacks "
                   "concentric contours; *Sensitivity* scales the wave into range.")
      .floatField("level", 0.16f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.005f, nullptr,
                  "Wave amplitude that becomes a line (the moving contour).")
        .label("Line Level", "Level")
      .floatField("thickness", 0.06f, 0.f, 0.5f, state::PrimaryInput, nullptr, 0.005f, nullptr,
                  "Line width (half-band around the level).")
        .label("Line Thickness", "Thick")
      .intField("line_count", 1, 1, 4, state::SecondaryInput)
        .label("Line Count", "Count")
      .floatField("aa", 0.02f, 0.001f, 0.2f, state::SecondaryInput, nullptr, 0.001f, nullptr,
                  "Edge softness of the line band (anti-alias).")
        .label("Line Softness", "AA")
      .floatField("sensitivity", 0.5f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Display gain on the wave field (brings faint ripples into range).")
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
                 "Show the raw wave field (red/blue) instead of the lines.")
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
  // exponential curve; a fired event sets the pulse to the flicker amount.
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
    else if (state::pathIs(p, l, "flicker_detail"))   s->flicker_detail   = state::patchFloat(i);
    else if (state::pathIs(p, l, "speed"))            s->speed            = state::patchFloat(i);
    else if (state::pathIs(p, l, "damping"))          s->damping          = state::patchFloat(i);
    else if (state::pathIs(p, l, "stiffness"))        s->stiffness        = state::patchFloat(i);
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

  // --- Pass 1: diff → inject → wave integrate (sim-res) ---
  // Wave speed → cells/sec, CFL-clamped so the explicit scheme stays stable.
  float c = s->speed * C_MAX;
  float c_max = CFL / dt;             // c*dt ≤ CFL
  if (c > c_max) c = c_max;
  float damp = B_MIN + (B_MAX - B_MIN) * s->damping;

  SimUniforms su = {};
  su.dt               = dt;
  su.c2               = c * c;
  su.damp             = damp;
  su.stiffness        = s->stiffness * K_MAX;
  su.change_threshold = s->change_threshold;
  su.change_soft      = 0.05f;        // fixed soft knee on the diff threshold
  su.seed_gain        = s->change_gain;   // shader applies CHANGE_INJECT
  su.flicker_pulse    = s->flicker_env;
  su.flicker_detail   = s->flicker_detail;
  su.u_clamp          = U_CLAMP;
  su.v_clamp          = V_CLAMP;
  su.have_history     = s->have_history ? 1u : 0u;
  su.frame            = s->frame;
  s->sim_uniform.writeOne(su);
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_sim);
    cp.setTexture(s->field[rd], 0, 0);   // prev field (Load for laplacian)
    cp.setTexture(in, 1, 0);             // current input (sampled at sim-res)
    cp.setSampler(s->samp_lin, 2);
    cp.setTexture(s->field[wr], 3, 1);   // new field (storage write)
    cp.setBuffer(s->sim_uniform, 4);
    cp.dispatch((s->sim_w + 7) / 8, (s->sim_h + 7) / 8);
    cp.end();
  }

  // --- Pass 2: threshold crests → lines over input (viewport-res) ---
  int lc = s->line_count; if (lc < 1) lc = 1; if (lc > 4) lc = 4;
  CompUniforms cu = {};
  cu.level      = s->level;
  cu.thickness  = s->thickness;
  cu.aa         = s->aa;
  cu.input_mix  = s->input_mix;
  cu.line_r     = s->line_r;
  cu.line_g     = s->line_g;
  cu.line_b     = s->line_b;
  cu.field_gain = 0.5f + s->sensitivity * 5.5f;   // wave amp → display range
  cu.line_count = (uint32_t)lc;
  cu.debug_show_field = s->debug_show_field > 0.5f ? 1u : 0u;
  s->comp_uniform.writeOne(cu);
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_comp);
    cp.setTexture(in, 0, 0);             // input (full res)
    cp.setTexture(s->field[wr], 1, 0);   // wave field (sampled, upscaled)
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
