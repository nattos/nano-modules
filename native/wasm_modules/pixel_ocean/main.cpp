/*
 * source.pixel.ocean — pixel-art ocean generator.
 *
 * A rotatable coarse pixel grid painted a flat ocean blue, sprinkled with
 * sparse tiny wave sprites (dot-line / omega / unrolling wind-curl) that
 * animate and drift forward in discrete steps — Monster-Hunter-world-map
 * style. Fully procedural: the shader derives every wave from integer hashes
 * over a stratified spawn-cell lattice plus two global step clocks, so there
 * is no particle pool and the only cross-frame state is two accumulators.
 *
 * The two clocks (shape animation, forward drift) advance as accumulators
 * (style guide §2.1) and are passed to the shader as integer steps + fraction.
 * Per-wave jitter params stagger each clock per cell: 0 = the whole sea ticks
 * in lock step, 1 = fully staggered. See compute.hlsl for the lattice model.
 *
 * Per-instance ABI (§0): mutable state in State; the compute PSO + 1x1 black
 * input fallback are type-shared file statics built once in module_init.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "pixel_ocean_shaders.h"

#include <cmath>
#include <cstdint>

namespace pixel_ocean {

enum Composite { CompOcean = 0, CompTransparent = 1, CompCustom = 2, CompInput = 3 };

static const int PO_CYCLE_LEN = 16;   // anim steps per life cycle (matches compute.hlsl)

// Uniform layout — MUST match compute.hlsl's cbuffer byte-for-byte.
struct Uniforms {
  float aspect_x, aspect_y;   // u_aspect
  float cos_r, sin_r;         // u_cos, u_sin
  float ocean[4];             // u_ocean
  float wave[4];              // u_wave
  float bg[4];                // u_bg
  float cell_px;              // u_cell_px
  uint32_t spawn_size;        // u_spawn
  uint32_t composite;         // u_composite
  uint32_t seed;              // u_seed
  uint32_t cyc_index;         // u_cyc_index
  float cyc_frac;             // u_cyc_frac
  uint32_t drift_steps;       // u_drift_steps
  float drift_frac;           // u_drift_frac
  uint32_t forward_steps;     // u_forward_steps
  float forward_frac;         // u_forward_frac
  uint32_t debug_cells;       // u_debug
  float anim_jitter;          // u_anim_jitter
  float dens_cur, dens_prev;  // u_dens_cur / u_dens_prev
  float back_cur, back_prev;  // u_back_cur / u_back_prev
  float djit_cur, djit_prev;  // u_djit_cur / u_djit_prev
  float fjit_cur, fjit_prev;  // u_fjit_cur / u_fjit_prev
};
static_assert(sizeof(Uniforms) == 144, "cbuffer mirror drifted from compute.hlsl");

struct State {
  // Pixel grid.
  float pixel_size = 0.40f;
  float rotation = 0.06f;
  // Look.
  float ocean_color[3] = { 0.10f, 0.32f, 0.55f };
  float wave_color[3]  = { 0.0f, 0.0f, 0.0f };
  float density = 0.35f;
  int composite = CompOcean;
  float bg_color[4] = { 0.0f, 0.0f, 0.0f, 1.0f };
  // Motion.
  float anim_rate = 0.50f;
  float anim_jitter = 1.0f;
  float drift_rate = 0.40f;       // X-axis (sideways) drift
  float drift_jitter = 1.0f;
  float forward_rate = 0.30f;     // Y-axis (forward) drift
  float forward_jitter = 1.0f;
  float backwards = 0.10f;
  // Tuning.
  int spawn_size = 12;
  float seed = 0.0f;
  bool debug_cells = false;

  // Step-clock accumulators (§2.1 — never time*rate).
  double drift_acc = 0.0;     // X-axis (live)
  double forward_acc = 0.0;   // Y-axis (live)

  // Anim PHASE clock (capture-on-spawn). cyc_phase counts whole cycles; it
  // advances at the anim rate CAPTURED when the current cycle began, so a live
  // anim-rate change never re-speeds a wave already alive — it lands at the next
  // respawn. Existence/shape params are latched the same way: we keep the
  // snapshot for the current cycle and the previous one (every visible wave is
  // in one of those two), captured at each cycle boundary.
  double cyc_phase = 0.0;
  uint64_t cyc_index = 0;             // = floor(cyc_phase)
  double captured_anim_rate = 0.0;    // steps/sec latched at current cycle start
  bool clock_init = false;
  float dens_cur = 0.35f, dens_prev = 0.35f;
  float back_cur = 0.10f, back_prev = 0.10f;
  float djit_cur = 1.0f,  djit_prev = 1.0f;
  float fjit_cur = 1.0f,  fjit_prev = 1.0f;

  bool initialized = false;
  gpu::Buffer uniform_buf;
};

static gpu::ComputePSO s_pso;   // type-shared
static gpu::Texture s_black;    // type-shared 1x1 fallback for the "input"
                                // composite when nothing is wired upstream.

// Rate sliders → steps/sec. Exponential-with-zero-at-zero (§1.3 family):
// equal slider distance ≈ equal tempo change, and 0 freezes the clock.
// anim: 0 → 0, 0.5 → 2, 1 → 12 steps/s.  drift: 0.4 → ~0.53, 1 → 4 steps/s.
static inline double animStepsPerSec(float p) {
  if (p < 0.0f) p = 0.0f;
  if (p > 1.0f) p = 1.0f;
  return (std::pow(25.0, (double)p) - 1.0) * 0.5;
}
static inline double driftStepsPerSec(float p) {
  if (p < 0.0f) p = 0.0f;
  if (p > 1.0f) p = 1.0f;
  return (std::pow(17.0, (double)p) - 1.0) * 0.25;
}
// Forward (Y) drift shares the drift curve — same feel on both axes.
static inline double forwardStepsPerSec(float p) { return driftStepsPerSec(p); }

void module_init() {
  state::init("source.pixel.ocean", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Pixel Ocean\n"
        "A pixel-art sea, world-map style: a chunky rotatable pixel grid of "
        "flat blue, dotted with sparse little black waves — flecks, omega "
        "crests, and wind-curls that unroll — each animating and drifting in "
        "hard discrete steps.\n\n"
        "**Try:** drop *Anim Jitter* and *Drift Jitter* to 0 so the whole sea "
        "ticks in lock step like a game boot screen; raise *Density* for a "
        "busier crossing; nudge *Backwards* for cross-chop; set *Composite → "
        "Input* to scatter waves over the layer below.")
      // --- Pixel grid: resolution + orientation ---
      .group("grid", "Pixel Grid")
        .groupHelp(
          "*Pixel Size* sets how chunky the grid is (exponential: left = fine "
          "~256 columns, right = huge ~16). *Rotation* turns the whole ocean — "
          "grid, waves, and travel direction together (waves always swim along "
          "the grid's own axis, ±half a turn).")
      .floatField("pixel_size", 0.40f, 0.f, 1.f, state::PrimaryInput).label("Pixel Size", "Px")
      .floatField("rotation", 0.06f, -1.f, 1.f, state::PrimaryInput).label("Rotation", "Rot")
      // --- Look: colors + how many waves ---
      .group("look", "Ocean")
        .groupHelp(
          "*Ocean* and *Wave* are the two flat colours. *Density* is the chance "
          "each spawn slot hosts a wave. It's LATCHED at spawn: raising it never "
          "pops a wave in mid-animation and lowering it never culls one — the "
          "change simply decides which cells do or don't respawn as they reach "
          "their next cycle, so it rolls in cleanly over about one cycle. "
          "**Composite** picks the backdrop: Ocean / Transparent / Custom / the "
          "Input image, with waves drawn on top.")
      .rgbField("ocean_color", 0.10f, 0.32f, 0.55f, state::PrimaryInput).label("Ocean Colour", "Ocean")
      .rgbField("wave_color", 0.0f, 0.0f, 0.0f, state::PrimaryInput).label("Wave Colour", "Wave")
      .floatField("density", 0.35f, 0.f, 1.f, state::PrimaryInput).label("Density", "Dens")
      .selectField("composite", CompOcean, state::PrimaryInput,
                   {{"Ocean", CompOcean}, {"Transparent", CompTransparent},
                    {"Custom", CompCustom}, {"Input", CompInput}}).label("Composite", "Comp")
      .rgbaField("bg_color", 0.0f, 0.0f, 0.0f, 1.0f, state::SecondaryInput).label("Background", "BG")
      // --- Motion: the two step clocks + their stagger ---
      .group("motion", "Motion")
        .groupHelp(
          "Independent step clocks, each marching waves in whole-pixel steps "
          "along the grid's own axes: *Anim Rate* ticks each wave through its "
          "shape frames; *Drift* slides them sideways (the grid ±X axis); "
          "*Forward* carries them along the grid's Y axis. Give both a rate and "
          "waves swim diagonally. The *Jitter* knob beside each clock sets the "
          "stagger — 0 = every wave steps in the same instant (lock step), 1 = "
          "fully scattered phases. *Backwards* is the chance a wave runs against "
          "the current — it reverses BOTH the drift and the forward direction. "
          "**Anim Rate, the jitters and Backwards latch at spawn** (like "
          "Density): changing one never re-speeds or redirects a wave already "
          "alive — it takes hold at each wave's next respawn. Drift/Forward "
          "SPEED stays live, so all waves glide together and speed changes read "
          "smoothly rather than as a jolt.")
      .floatField("anim_rate", 0.50f, 0.f, 1.f, state::PrimaryInput).label("Anim Rate", "Anim")
      .floatField("anim_jitter", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Anim Jitter", "AJit")
      .floatField("drift_rate", 0.40f, 0.f, 1.f, state::PrimaryInput).label("Drift Rate (X)", "Drift")
      .floatField("drift_jitter", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Drift Jitter", "DJit")
      .floatField("forward_rate", 0.30f, 0.f, 1.f, state::PrimaryInput).label("Forward Rate (Y)", "Fwd")
      .floatField("forward_jitter", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Forward Jitter", "FJit")
      .floatField("backwards", 0.10f, 0.f, 1.f, state::PrimaryInput).label("Backwards", "Back")
      // --- Tuning + debug ---
      .group("tuning", "Tuning")
        .groupHelp(
          "*Spawn Cell* is the stratified lattice pitch in grid pixels — each "
          "cell hosts at most one wave, which is what keeps the spread so even. "
          "Smaller cells = a denser ceiling. *Seed* re-deals the whole sea. "
          "*Show Cells* overlays the lattice (borders + a tint on live cells).")
      .intField("spawn_size", 12, 8, 24, state::SecondaryInput).label("Spawn Cell", "Cell")
      .floatField("seed", 0.0f, 0.f, 1.f, state::SecondaryInput).label("Seed", "Seed")
      .boolField("debug_cells", false, state::SecondaryInput).label("Show Cells", "Cells")
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::Generator)
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;
  state::registerShaderSPV("pixel_ocean_compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("pixel_ocean_compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main",
    gpu::Bindings().tex2d(0).storageTex2d(1).uniform(2));

  // 1x1 black bound at the input slot when this generator starts a chain
  // (no upstream tex_in) — "Input" composite then falls back to black.
  s_black = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA8);
  if (s_black.valid()) gpu::Device::clear(s_black, 0.f, 0.f, 0.f, 1.f);
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
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  gpu::Buffer buf = s->uniform_buf;   // preserve the allocated buffer across reset
  *s = State();
  s->uniform_buf = buf;
  s->initialized = buf.valid();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  // Cycle 0 begins on the first tick: latch the current params + rate as its
  // captured snapshot so the opening cycle already reflects the live settings.
  if (!s->clock_init) {
    s->dens_cur = s->dens_prev = s->density;
    s->back_cur = s->back_prev = s->backwards;
    s->djit_cur = s->djit_prev = s->drift_jitter;
    s->fjit_cur = s->fjit_prev = s->forward_jitter;
    s->captured_anim_rate = animStepsPerSec(s->anim_rate);
    s->clock_init = true;
  }

  // Advance the phase clock at the rate captured for the current cycle. If that
  // cycle was captured frozen (rate 0), follow the live rate instead so raising
  // the slider from 0 unfreezes rather than latching us out forever.
  double rate = s->captured_anim_rate > 0.0 ? s->captured_anim_rate
                                            : animStepsPerSec(s->anim_rate);
  s->cyc_phase += dt * rate / (double)PO_CYCLE_LEN;

  // Each cycle boundary: shift current snapshot → previous and re-capture the
  // live params + rate as the new cycle's latched values. This is the only place
  // param changes take hold, which is what makes them "capture on spawn".
  while (std::floor(s->cyc_phase) > (double)s->cyc_index) {
    s->cyc_index++;
    s->dens_prev = s->dens_cur; s->dens_cur = s->density;
    s->back_prev = s->back_cur; s->back_cur = s->backwards;
    s->djit_prev = s->djit_cur; s->djit_cur = s->drift_jitter;
    s->fjit_prev = s->fjit_cur; s->fjit_cur = s->forward_jitter;
    s->captured_anim_rate = animStepsPerSec(s->anim_rate);
  }

  // Drift / forward speed stay LIVE (the rigid co-moving lattice needs every
  // wave in a lattice to share one translation).
  s->drift_acc   += dt * driftStepsPerSec(s->drift_rate);
  s->forward_acc += dt * forwardStepsPerSec(s->forward_rate);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if      (state::pathIs(p, l, "pixel_size"))   s->pixel_size = state::patchFloat(i);
    else if (state::pathIs(p, l, "rotation"))     s->rotation = state::patchFloat(i);
    else if (state::pathIs(p, l, "ocean_color")) {
      auto v = state::patchVec3(i);
      s->ocean_color[0] = v.x; s->ocean_color[1] = v.y; s->ocean_color[2] = v.z;
    }
    else if (state::pathIs(p, l, "wave_color")) {
      auto v = state::patchVec3(i);
      s->wave_color[0] = v.x; s->wave_color[1] = v.y; s->wave_color[2] = v.z;
    }
    else if (state::pathIs(p, l, "density"))      s->density = state::patchFloat(i);
    else if (state::pathIs(p, l, "composite"))    s->composite = state::patchInt(i);
    else if (state::pathIs(p, l, "bg_color")) {
      auto v = state::patchVec4(i);
      s->bg_color[0] = v.x; s->bg_color[1] = v.y; s->bg_color[2] = v.z; s->bg_color[3] = v.w;
    }
    else if (state::pathIs(p, l, "anim_rate"))    s->anim_rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "anim_jitter"))  s->anim_jitter = state::patchFloat(i);
    else if (state::pathIs(p, l, "drift_rate"))   s->drift_rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "drift_jitter")) s->drift_jitter = state::patchFloat(i);
    else if (state::pathIs(p, l, "forward_rate"))   s->forward_rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "forward_jitter")) s->forward_jitter = state::patchFloat(i);
    else if (state::pathIs(p, l, "backwards"))    s->backwards = state::patchFloat(i);
    else if (state::pathIs(p, l, "spawn_size"))   s->spawn_size = state::patchInt(i);
    else if (state::pathIs(p, l, "seed"))         s->seed = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_cells"))  s->debug_cells = state::patchBool(i);
  }
}

void on_resolume_param(void*, long long, double) {}

static void fillUniforms(State* s, int vp_w, int vp_h, Uniforms& u) {
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  u.aspect_x = ax; u.aspect_y = ay;
  const float angle = s->rotation * 3.14159265f;
  u.cos_r = std::cos(angle);
  u.sin_r = std::sin(angle);
  for (int i = 0; i < 3; i++) {
    u.ocean[i] = s->ocean_color[i];
    u.wave[i] = s->wave_color[i];
  }
  u.ocean[3] = 1.0f; u.wave[3] = 1.0f;
  for (int i = 0; i < 4; i++) u.bg[i] = s->bg_color[i];

  // pixel_size → grid columns across the cover square, exponential 256 → 16.
  float cols = 256.0f * std::pow(16.0f / 256.0f, s->pixel_size);
  u.cell_px = 2.0f / cols;

  int S = s->spawn_size;
  if (S < 8) S = 8;      // < 8 would break the shader's candidate-cell bounds
  if (S > 24) S = 24;
  u.spawn_size = (uint32_t)S;
  u.composite = (uint32_t)s->composite;
  u.seed = (uint32_t)(s->seed * 65535.0f);

  // Anim PHASE clock: integer cycle index + fractional position, so the shader's
  // per-cell cycle math stays exact. Drift/forward stay as live step + fraction.
  u.cyc_index = (uint32_t)s->cyc_index;
  u.cyc_frac  = (float)(s->cyc_phase - (double)s->cyc_index);
  u.drift_steps = (uint32_t)(uint64_t)s->drift_acc;
  u.drift_frac  = (float)(s->drift_acc - std::floor(s->drift_acc));
  u.forward_steps = (uint32_t)(uint64_t)s->forward_acc;
  u.forward_frac  = (float)(s->forward_acc - std::floor(s->forward_acc));

  u.debug_cells = s->debug_cells ? 1u : 0u;
  u.anim_jitter = s->anim_jitter;   // live: the per-cell phase spread
  // Captured per-cycle snapshots (current + previous).
  u.dens_cur = s->dens_cur; u.dens_prev = s->dens_prev;
  u.back_cur = s->back_cur; u.back_prev = s->back_prev;
  u.djit_cur = s->djit_cur; u.djit_prev = s->djit_prev;
  u.fjit_cur = s->fjit_cur; u.fjit_prev = s->fjit_prev;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;
  if (!in.valid()) in = s_black;   // chain-start: no upstream input
  if (!in.valid()) return;

  Uniforms u = {};
  fillUniforms(s, vp_w, vp_h, u);
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();
  gpu::Device::submit();
}

} // namespace pixel_ocean
