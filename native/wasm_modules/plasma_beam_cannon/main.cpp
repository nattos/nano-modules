/*
 * gen.plasma_beam_cannon — 90s-anime power-up beam.
 *
 * Per-bar vertical beam driven by a linked-across-bars ADSR clock:
 *   - Attack: small seed at `seed_y`, height = `seed_height`.
 *   - Decay:  beam grows from `seed_height` → 1.0.
 *   - Sustain: full bar lit.
 *   - Release: beam stays at full height; per-bar break particles
 *              "eat" the beam, growing/shrinking under a length-target
 *              controller. Near the end, a flicker tail kicks in
 *              (duty cycle decays from `flicker_duty_start` →
 *              `flicker_duty_end`).
 *
 * Triggered by `gate` (rising-edge synthesizes a one-shot pulse) or
 * `trigger` event (also one-shot, only fires when IDLE to defend
 * against state-replay re-arming).
 *
 * Hard-edge rendering throughout — no alpha, no fades. Break cells
 * either fully eat the beam (revert to input passthrough at that
 * pixel) or don't.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "plasma_beam_cannon_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace plasma_beam_cannon {

enum Phase : int {
  PHASE_IDLE    = 0,
  PHASE_ATTACK  = 1,
  PHASE_DECAY   = 2,
  PHASE_SUSTAIN = 3,
  PHASE_RELEASE = 4,
};

enum BreakType : int {
  BREAK_SOLID_ATTRACTOR = 0,
  BREAK_SOLID_REPELLOR  = 1,
  BREAK_SPACER          = 2,  // invisible, only contributes repulsion
};

static constexpr int BARS               = 4;
static constexpr int MAX_BREAKS_PER_BAR = 32;
static constexpr int MAX_BREAKS_TOTAL   = BARS * MAX_BREAKS_PER_BAR;

struct Uniforms {
  // row 0
  float    beam_y_min;
  float    beam_y_max;
  float    intensity;
  uint32_t active;

  // row 1
  float    color_r;
  float    color_g;
  float    color_b;
  uint32_t bar_target_all;

  // row 2
  uint32_t bar_target;
  uint32_t particles_per_bar;
  uint32_t breaks_active;     // 1 during RELEASE; 0 otherwise
  uint32_t flicker_active;    // 1 once release_t ≥ flicker_start_t

  // row 3
  uint32_t flicker_on;        // current on/off state when flicker_active
  uint32_t _pad_0;
  uint32_t _pad_1;
  uint32_t _pad_2;
};
static_assert(sizeof(Uniforms) == 64, "Uniforms layout mismatch");

// GPU layout per break particle: 1 vec4 = 16 bytes.
//   .x = y (uv-space, position along bar height)
//   .y = size (uv-space, full height of the break)
//   .z = type (as float — 0 attractor, 1 repellor, 2 spacer)
//   .w = padding / reserved
struct GpuBreak {
  float y;
  float size;
  float type_f;
  float _pad;
};
static_assert(sizeof(GpuBreak) == 16, "GpuBreak layout mismatch");

struct CpuBreak {
  float y;
  float vy;
  float size;
  int   type;
  // Stagger threshold in release_t ∈ [0, 1]. The break is INACTIVE
  // (invisible, no physics, doesn't contribute forces) until release
  // progress passes this value. Set per-break at reset time from a
  // uniform random draw shaped by `activation_curve` and
  // `activation_min` so breaks don't all pop in simultaneously.
  float threshold;
  // Per-break upper bound on `size`. Drawn at reset from a strongly
  // bimodal distribution — most breaks get either `min_break_size`
  // (stay small forever) or `max_break_size` (free to grow); the
  // population split is controlled by `growth_fraction`. This is what
  // gives release-phase breaks two distinct visual classes instead of
  // every break growing at the same rate under the length controller.
  float personal_max_size;
};

static gpu::ComputePSO s_pso;
static gpu::Buffer     s_uniform_buf;
static gpu::Buffer     s_break_buf;
static bool s_initialized = false;

// --- Schema-mirrored params (standard) ---
static bool  s_gate            = false;
static float s_attack_s        = 0.15f;
static float s_decay_s         = 0.10f;
static float s_sustain_s       = 0.40f;
static float s_release_s       = 1.50f;
// Per-phase shape curves. Each is a signed slider [-1, +1] mapped via
// `fx::signedSliderToExp` to a power exponent applied to that phase's
// normalized t ∈ [0, 1]. Convention from the style guide §1.3:
//   -1 → exp 8   → curve crushes toward 0 (slow start, fast finish)
//    0 → exp 1   → linear
//   +1 → exp 1/8 → curve lifts toward 1 (fast start, slow finish)
//
// Attack: shapes the seed grow from 0 → seed_height.
// Decay:  shapes the lerp from seed_height → full bar height.
// Release: warps release_t globally — all release-phase time-dependent
//          machinery (length target, activation thresholds, flicker
//          onset) sees the warped time. Lets you make a 1.5s release
//          "feel faster" or "feel slower" without changing release_s.
static float s_attack_curve    = 0.0f;
static float s_decay_curve     = 0.0f;
static float s_release_curve   = 0.0f;
static float s_seed_y          = 0.50f;
static float s_seed_height     = 0.06f;
static float s_color_r         = 1.00f;
static float s_color_g         = 0.95f;
static float s_color_b         = 0.80f;
static float s_intensity       = 1.0f;
static int   s_bar_target      = 0;
static bool  s_bar_target_all  = true;
static float s_auto_rate       = 0.2f;

// --- Break-particle tuning params ---
static int   s_break_count           = 12;
static float s_attractor_fraction    = 0.25f;
static float s_spacer_fraction       = 0.25f;
static float s_min_break_size        = 0.015f;
static float s_max_break_size        = 0.12f;
static float s_force_strength        = 0.4f;
// Multiplier on forces emitted by SPACER particles. Spacers are
// repulsion-only "stay apart" markers; with the same magnitude as
// attractors/repellors they easily dominate (every other particle
// sees their push and rockets to the bar edges). Default 0.3 keeps
// their nudge gentle; crank to 1.0 to match solid-particle strength.
static float s_spacer_strength       = 0.3f;
// Plummer-style softening for the 1/r² pair force: the effective
// distance used in the denominator is sqrt(dy² + softening²), so
// even particles seeded essentially on top of each other only see
// a bounded max force of `force_strength / softening²`. WITHOUT
// this (or with a tiny softening), close pairs produce arbitrarily
// large velocity changes and the whole simulation slingshots to the
// poles — even when `force_strength` is dialed near zero. Default
// 0.05 in uv-space ≈ 5% of bar height, bounding max force at
// `force_strength * 400`.
static float s_force_softening       = 0.05f;
static float s_damping_per_s         = 4.0f;
static float s_interaction_radius    = 0.3f;
// Per-break teleport rate — small breaks have a higher chance per
// frame of jumping to a new random y. Mapping is the §4.1 Poisson
// rate (rate_hz = pow(60, slider) - 1) scaled by `(1 - size_norm)`,
// so the smallest breaks teleport at the full rate while max-sized
// breaks never teleport. Keeps the active break field churning
// during release instead of settling into static positions.
static float s_teleport_rate         = 0.2f;
static float s_length_target_start   = 0.1f;
static float s_length_target_end     = 0.7f;
static float s_length_target_curve   = 1.0f;
static float s_grow_response         = 1.0f;
// Break activation stagger — controls WHEN each break can become
// active during the release cycle. Each break gets a uniform random
// draw u ∈ [0, 1]; its activation threshold = min + (1 - min) * u^exp,
// where exp = fx::signedSliderToExp(activation_curve) per the style
// guide §1.3 power-curve convention.
//   activation_curve = -1 → exp 8   → thresholds crush toward 0 → EARLY
//   activation_curve =  0 → exp 1   → uniform across [min, 1]
//   activation_curve = +1 → exp 1/8 → thresholds lift toward 1 → LATE
static float s_activation_curve      = 0.0f;
static float s_activation_min        = 0.0f;
// Strongly-bimodal break-size population. Each break draws once:
//   `wants_to_grow = u < growth_fraction`
//   personal_max_size = wants_to_grow ? max_break_size : min_break_size
// So the population splits cleanly into "stays at min" and "grows to
// max", with no per-break in-between max. The length controller then
// drives every active break toward its personal cap.
static float s_growth_fraction       = 0.4f;
static float s_flicker_start_t       = 0.7f;
static float s_flicker_duty_start    = 0.8f;
static float s_flicker_duty_end      = 0.05f;
static float s_flicker_freq_hz       = 24.0f;
static int   s_break_seed            = 0x12345;
// When true, an internal counter increments every time release begins,
// and that counter is folded into the effective seed used to draw
// break positions / types / thresholds / personal max sizes. So each
// trigger gets a fresh, deterministic break pattern instead of (when
// `break_seed` is fixed) replaying the same arrangement every cycle.
static bool  s_cycle_seed            = true;
static int   s_seed_cycle_count      = 0;

// --- State machine runtime state ---
static Phase  s_phase          = PHASE_IDLE;
static double s_time_in_phase  = 0.0;
static bool   s_gate_prev      = false;
static bool   s_trigger_pulse  = false;
static double s_trigger_hold_remaining = 0.0;
static uint32_t s_rng_state    = 0xCAFEBABEu;
// Separate RNG stream for per-frame break operations (teleport draws,
// etc). Kept independent of `s_rng_state` so toggling auto_rate or
// the trigger-pulse RNG doesn't shift teleport timing in subtle ways.
static uint32_t s_break_op_rng = 0xBADDCAFEu;

// --- Break-particle runtime state ---
static CpuBreak s_breaks[BARS][MAX_BREAKS_PER_BAR];
static double   s_flicker_phase = 0.0;
static bool     s_flicker_on    = true;
static bool     s_breaks_seeded = false;

static inline float lerpf(float a, float b, float t) {
  return a + (b - a) * t;
}
static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u;
  return s;
}
static inline float lcg_unit(uint32_t& s) {
  return (lcg_next(s) >> 8) * (1.0f / float(1u << 24));
}
static inline float lcg_signed(uint32_t& s) { return lcg_unit(s) * 2.0f - 1.0f; }

static void enter_phase(Phase p);

// Re-init every break particle for a fresh release cycle.
static void reset_breaks() {
  // Effective seed combines the user-set seed with the per-trigger
  // cycle counter (when `cycle_seed` is on). Pure deterministic
  // mapping: (break_seed, cycle_count) → break pattern. No drift
  // from elapsed time / auto-trigger Poisson sampling.
  uint32_t effective_seed = (uint32_t)s_break_seed
    + (s_cycle_seed ? (uint32_t)s_seed_cycle_count : 0u);
  uint32_t rng = effective_seed ^ 0xDEAFBEEFu;
  // Mix once so the first lcg_unit() doesn't hand out a near-zero
  // pattern for small seeds.
  lcg_next(rng);

  int per_bar = s_break_count;
  if (per_bar < 1) per_bar = 1;
  if (per_bar > MAX_BREAKS_PER_BAR) per_bar = MAX_BREAKS_PER_BAR;

  // Activation curve via the style-guide power-curve helper. Slider
  // [-1, +1] → exponent [8, 1, 1/8]; we then raise the uniform draw to
  // that exponent to skew thresholds toward 0 (early) or 1 (late).
  float curve_exp = fx::signedSliderToExp(clampf(s_activation_curve, -1.0f, 1.0f));
  float min_t = clampf(s_activation_min, 0.0f, 1.0f);
  float min_span = 1.0f - min_t;

  float growth_fraction = clampf(s_growth_fraction, 0.0f, 1.0f);

  for (int bar = 0; bar < BARS; bar++) {
    for (int i = 0; i < MAX_BREAKS_PER_BAR; i++) {
      CpuBreak& b = s_breaks[bar][i];
      if (i >= per_bar) {
        // Inactive slot — make sure it doesn't get rendered.
        b.y = 0.5f;
        b.vy = 0.0f;
        b.size = 0.0f;
        b.type = BREAK_SPACER;
        b.threshold = 2.0f;          // > 1.0 so it never activates
        b.personal_max_size = s_min_break_size;
        continue;
      }
      b.y = lcg_unit(rng);            // uniformly across [0, 1]
      b.vy = 0.0f;
      // Size starts at 0 — break is "inactive" until release passes
      // its threshold. On first activation we pop it to min size.
      b.size = 0.0f;
      // Type by stochastic draw. Order doesn't matter (no overlap rules).
      float u = lcg_unit(rng);
      if (u < s_attractor_fraction) {
        b.type = BREAK_SOLID_ATTRACTOR;
      } else if (u < s_attractor_fraction + s_spacer_fraction) {
        b.type = BREAK_SPACER;
      } else {
        b.type = BREAK_SOLID_REPELLOR;
      }
      // Activation threshold ∈ [activation_min, 1.0], shaped.
      float thresh_u = lcg_unit(rng);
      float curved = std::pow(thresh_u, curve_exp);
      b.threshold = min_t + min_span * curved;
      // Bimodal personal max: binary growth class. No continuous
      // distribution — either capped at min (stays small) or at max
      // (free to grow under length-controller drive).
      bool wants_to_grow = lcg_unit(rng) < growth_fraction;
      b.personal_max_size = wants_to_grow ? s_max_break_size : s_min_break_size;
    }
  }
  s_breaks_seeded = true;
}

static void enter_phase(Phase p) {
  s_phase = p;
  s_time_in_phase = 0.0;
  if (p == PHASE_RELEASE) {
    // Bump the cycle counter BEFORE reset_breaks reads it, so the
    // first release after init uses cycle=1 (a non-default seed
    // offset) and each subsequent release advances by one.
    if (s_cycle_seed) s_seed_cycle_count++;
    reset_breaks();
    s_flicker_phase = 0.0;
    s_flicker_on = true;
  }
}

// Pairwise 1D N-body step. Solid (attractor) particles pull others
// toward them; solid repellors and spacers push others away. Spacers
// don't paint but their force is felt — they keep solid breaks from
// piling into one big void.
static void update_breaks(double dt) {
  if (!s_breaks_seeded || s_phase != PHASE_RELEASE) return;
  float fdt = (float)dt;

  int per_bar = s_break_count;
  if (per_bar < 1) per_bar = 1;
  if (per_bar > MAX_BREAKS_PER_BAR) per_bar = MAX_BREAKS_PER_BAR;

  // release_curve warps release_t globally — length target, break
  // activation, flicker onset all see the warped time. Per-system
  // curves (length_target_curve etc.) compose on top.
  float release_t_raw = (s_release_s > 0.0f)
    ? clampf((float)(s_time_in_phase / (double)s_release_s), 0.0f, 1.0f)
    : 1.0f;
  float release_t = std::pow(release_t_raw, fx::signedSliderToExp(s_release_curve));
  float exponent = s_length_target_curve > 0.01f ? s_length_target_curve : 0.01f;
  float target_curve_t = std::pow(release_t, exponent);
  float target_length = lerpf(s_length_target_start, s_length_target_end, target_curve_t);

  for (int bar = 0; bar < BARS; bar++) {
    CpuBreak* bp = s_breaks[bar];

    // Resolve active flags from per-break activation thresholds.
    // Inactive breaks are entirely absent from the simulation this
    // tick — they don't paint, don't exert force, and aren't moved.
    bool is_active[MAX_BREAKS_PER_BAR];
    for (int i = 0; i < per_bar; i++) {
      is_active[i] = (release_t >= bp[i].threshold);
    }

    // Length controller — sum only ACTIVE solid sizes.
    float current_length = 0.0f;
    for (int i = 0; i < per_bar; i++) {
      if (!is_active[i]) continue;
      if (bp[i].type != BREAK_SPACER) current_length += bp[i].size;
    }
    float error = target_length - current_length;

    // Per-pair forces — both endpoints must be active.
    float force[MAX_BREAKS_PER_BAR];
    for (int i = 0; i < per_bar; i++) force[i] = 0.0f;
    float soft_sq = s_force_softening * s_force_softening;
    if (soft_sq < 1e-6f) soft_sq = 1e-6f;     // guard against zero
    for (int i = 0; i < per_bar; i++) {
      if (!is_active[i]) continue;
      for (int j = 0; j < per_bar; j++) {
        if (i == j) continue;
        if (!is_active[j]) continue;
        float dy = bp[j].y - bp[i].y;
        float abs_dy = dy < 0.0f ? -dy : dy;
        if (abs_dy > s_interaction_radius) continue;
        // Plummer-style softened distance: never produces unbounded
        // forces no matter how close two particles seed.
        float d_sq = abs_dy * abs_dy + soft_sq;
        // Attractor: force points TOWARD j → +sign(dy).
        // Repellor / spacer: force points AWAY from j → -sign(dy).
        float dir = (dy > 0.0f) ? 1.0f : -1.0f;
        bool j_is_attractor = (bp[j].type == BREAK_SOLID_ATTRACTOR);
        bool j_is_spacer    = (bp[j].type == BREAK_SPACER);
        float sign_term = j_is_attractor ? dir : -dir;
        // Spacers get their own strength multiplier so they can be
        // dialed down without weakening solid attraction/repulsion.
        float mag = s_force_strength * (j_is_spacer ? s_spacer_strength : 1.0f);
        force[i] += sign_term * mag / d_sq;
      }
    }

    // Integrate (active only).
    float damp = std::exp(-s_damping_per_s * fdt);
    for (int i = 0; i < per_bar; i++) {
      if (!is_active[i]) continue;
      bp[i].vy = bp[i].vy * damp + force[i] * fdt;
      bp[i].y += bp[i].vy * fdt;
      if (bp[i].y < 0.0f) { bp[i].y = 0.0f; bp[i].vy = 0.0f; }
      if (bp[i].y > 1.0f) { bp[i].y = 1.0f; bp[i].vy = 0.0f; }

      // First-frame-of-activation: pop size to min so the break is
      // immediately visible instead of being invisible until the
      // length controller has had a few ticks to grow it from 0.
      if (bp[i].size == 0.0f && bp[i].type != BREAK_SPACER) {
        bp[i].size = s_min_break_size;
      }

      // Length controller — adjust size toward target. Clamp to the
      // per-break personal max so the bimodal split holds: "stays
      // small" breaks never grow beyond min_break_size regardless of
      // how positive the error gets.
      if (bp[i].type != BREAK_SPACER) {
        bp[i].size += error * s_grow_response * fdt;
        bp[i].size = clampf(bp[i].size, s_min_break_size, bp[i].personal_max_size);
      }

      // Per-frame teleport draw. Smaller breaks have higher chance.
      //   size_norm  ∈ [0, 1] from current size in [min, max].
      //   size_factor = 1 - size_norm  → small=1, large=0.
      //   actual_rate = teleport_rate_hz * size_factor.
      // Then standard Poisson per-frame fire: u < 1 - exp(-rate * dt).
      // On fire, pick a fresh random y and reset velocity.
      if (s_teleport_rate > 0.0f) {
        float teleport_rate_hz = std::pow(60.0f, s_teleport_rate) - 1.0f;
        if (teleport_rate_hz > 0.0f) {
          float size_range = s_max_break_size - s_min_break_size;
          float size_norm = (size_range > 1e-4f)
            ? clampf((bp[i].size - s_min_break_size) / size_range, 0.0f, 1.0f)
            : 0.0f;
          float size_factor = 1.0f - size_norm;
          float lambda = teleport_rate_hz * size_factor * fdt;
          float u_fire = lcg_unit(s_break_op_rng);
          if (u_fire < 1.0f - std::exp(-lambda)) {
            bp[i].y  = lcg_unit(s_break_op_rng);
            bp[i].vy = 0.0f;
          }
        }
      }
    }
  }

  // Flicker tail. flicker_t maps 0..1 across the post-flicker_start_t
  // portion of release. Hard-step duty cycle — overrides everything
  // to black during off periods.
  if (release_t >= s_flicker_start_t && s_flicker_start_t < 1.0f) {
    float flicker_t = (release_t - s_flicker_start_t) / (1.0f - s_flicker_start_t);
    flicker_t = clampf(flicker_t, 0.0f, 1.0f);
    float duty = lerpf(s_flicker_duty_start, s_flicker_duty_end, flicker_t);
    s_flicker_phase += dt * (double)s_flicker_freq_hz;
    if (s_flicker_phase >= 1.0) s_flicker_phase -= std::floor(s_flicker_phase);
    s_flicker_on = (float)s_flicker_phase < duty;
  } else {
    s_flicker_on = true;
  }
}

void init() {
  s_phase = PHASE_IDLE;
  s_time_in_phase = 0.0;
  s_gate_prev = false;
  s_trigger_pulse = false;
  s_trigger_hold_remaining = 0.0;
  s_breaks_seeded = false;
  s_flicker_phase = 0.0;
  s_flicker_on = true;
  s_seed_cycle_count = 0;
  s_initialized = false;
  std::memset(s_breaks, 0, sizeof(s_breaks));

  state::init("gen.plasma_beam_cannon", {1, 0, 0},
    state::Schema()
      // --- Standard ---
      .boolField ("gate",            false,                        state::PrimaryInput)
      .eventField("trigger",                                       state::PrimaryInput)
      .floatField("seed_y",          0.5f, 0.0f, 1.0f,             state::PrimaryInput)
      .floatField("seed_height",     0.06f, 0.0f, 0.5f,            state::PrimaryInput)
      .floatField("attack_s",        0.15f, 0.0f, 1.0f,            state::PrimaryInput)
      .floatField("decay_s",         0.10f, 0.0f, 0.5f,            state::PrimaryInput)
      .floatField("sustain_s",       0.40f, 0.0f, 4.0f,            state::PrimaryInput)
      .floatField("release_s",       1.50f, 0.1f, 5.0f,            state::PrimaryInput)
      // Per-phase shape curves (signed sliders; style guide §1.3).
      //   -1 → exp 8   → slow start, fast finish
      //    0 → linear
      //   +1 → exp 1/8 → fast start, slow finish
      // Attack curves the seed grow-in. Decay curves the seed → full
      // bar lerp. Release warps release_t globally — all release-
      // phase time-dependent machinery (length target, activation
      // thresholds, flicker onset) sees the warped time.
      .floatField("attack_curve",    0.0f, -1.0f, 1.0f,            state::PrimaryInput)
      .floatField("decay_curve",     0.0f, -1.0f, 1.0f,            state::PrimaryInput)
      .floatField("release_curve",   0.0f, -1.0f, 1.0f,            state::PrimaryInput)
      .rgbField  ("beam_color",      1.0f, 0.95f, 0.8f,            state::PrimaryInput)
      .floatField("intensity",       1.0f, 0.0f, 2.0f,             state::PrimaryInput)
      .intField  ("bar_target",      0, 0, 3,                      state::PrimaryInput)
      .boolField ("bar_target_all",  true,                         state::PrimaryInput)
      .floatField("auto_rate",       0.2f, 0.0f, 1.0f,             state::PrimaryInput)

      // --- Break particles (tuning) ---
      .intField  ("break_count_per_bar",   12,    1, MAX_BREAKS_PER_BAR, state::PrimaryInput)
      .floatField("attractor_fraction",    0.25f, 0.0f, 1.0f,             state::PrimaryInput)
      .floatField("spacer_fraction",       0.25f, 0.0f, 1.0f,             state::PrimaryInput)
      .floatField("min_break_size",        0.015f, 0.001f, 0.2f,          state::PrimaryInput)
      .floatField("max_break_size",        0.12f,  0.01f, 0.5f,           state::PrimaryInput)
      .floatField("force_strength",        0.4f,  0.0f, 2.0f,             state::PrimaryInput)
      // Multiplier on spacer-only force magnitude (relative to
      // `force_strength`). Spacers are repulsion-only "stay apart"
      // markers; at 1.0 they easily dominate and fling solids to the
      // poles. Default 0.3 keeps them a gentle nudge.
      .floatField("spacer_strength",       0.3f,  0.0f, 1.0f,             state::PrimaryInput)
      // Plummer softening for the 1/r² pair force — bounds the max
      // close-range force. Without this (i.e. tiny softening) any
      // two particles that seed near each other slingshot themselves
      // and everything around them to the bar edges, even with
      // force_strength near zero. Keep at the 0.05 default unless you
      // explicitly want sharper short-range physics.
      .floatField("force_softening",       0.05f, 0.005f, 0.5f,           state::PrimaryInput)
      .floatField("damping_per_s",         4.0f,  0.1f, 10.0f,            state::PrimaryInput)
      .floatField("interaction_radius",    0.3f,  0.05f, 1.0f,            state::PrimaryInput)
      // Per-break teleport: each active break has a per-frame Poisson
      // chance to jump to a new random y. Rate is biased by current
      // size — smallest breaks teleport at full rate, largest never.
      // Slider [0, 1] maps to rate via §4.1: pow(60, slider) - 1 Hz.
      .floatField("teleport_rate",         0.2f,  0.0f, 1.0f,             state::PrimaryInput)
      .floatField("length_target_start",   0.1f,  0.0f, 1.0f,             state::PrimaryInput)
      .floatField("length_target_end",     0.7f,  0.0f, 1.0f,             state::PrimaryInput)
      .floatField("length_target_curve",   1.0f,  0.25f, 4.0f,            state::PrimaryInput)
      .floatField("grow_response",         1.0f,  0.0f, 4.0f,             state::PrimaryInput)
      // Activation stagger — each break gets a random threshold in
      // release_t ∈ [activation_min, 1.0]. It's invisible (and doesn't
      // exert force) until release passes that threshold. Slider [-1,+1]
      // maps via the style-guide power-curve helper:
      //   -1 → exponent 8   → thresholds cluster near 0 → EARLY
      //    0 → exponent 1   → uniform across [min, 1]
      //   +1 → exponent 1/8 → thresholds cluster near 1 → LATE
      .floatField("activation_curve",      0.0f, -1.0f, 1.0f,             state::PrimaryInput)
      .floatField("activation_min",        0.0f,  0.0f, 1.0f,             state::PrimaryInput)
      // Bimodal break-size population. Each break is binary-classed
      // into "stays at min_break_size" or "free to grow to
      // max_break_size" with probability = growth_fraction. The
      // length-target controller then pushes each break toward its
      // personal cap — small breaks hit theirs immediately and stop,
      // large breaks keep growing.
      .floatField("growth_fraction",       0.4f,  0.0f, 1.0f,             state::PrimaryInput)
      .intField  ("break_seed",            0x12345, 0, 0x7FFFFFFF,        state::PrimaryInput)
      // When on (default), an internal counter increments per trigger
      // and is folded into the effective seed — every cycle gets a
      // fresh, deterministic break arrangement. Turn off to lock the
      // exact same arrangement every time (useful when staging cues).
      .boolField ("cycle_seed",            true,                          state::PrimaryInput)

      // --- Flicker tail (tuning) ---
      .floatField("flicker_start_t",       0.7f,  0.0f, 1.0f,             state::PrimaryInput)
      .floatField("flicker_duty_start",    0.8f,  0.0f, 1.0f,             state::PrimaryInput)
      .floatField("flicker_duty_end",      0.05f, 0.0f, 1.0f,             state::PrimaryInput)
      .floatField("flicker_freq_hz",       24.0f, 1.0f, 60.0f,            state::PrimaryInput)

      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("plasma_beam_cannon_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("plasma_beam_cannon_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2)
      .storage(3));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_break_buf   = gpu::Device::createBuffer(sizeof(GpuBreak) * MAX_BREAKS_TOTAL,
                                            gpu::BufferUsage::Storage);

  s_initialized = true;
  state::log("plasma_beam_cannon: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;
  s_time_in_phase += dt;

  // Poisson auto-trigger.
  if (s_auto_rate > 0.0f && !s_trigger_pulse) {
    float rate_hz = std::pow(60.0f, s_auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      float lambda = rate_hz * (float)dt;
      s_rng_state = s_rng_state * 1664525u + 1013904223u;
      float u = (s_rng_state >> 8) * (1.0f / float(1u << 24));
      if (u < 1.0f - std::exp(-lambda)) {
        s_trigger_pulse = true;
        s_trigger_hold_remaining = (double)(s_attack_s + s_decay_s + s_sustain_s);
      }
    }
  }

  // Trigger pulse decay.
  if (s_trigger_pulse) {
    s_trigger_hold_remaining -= dt;
    if (s_trigger_hold_remaining <= 0.0) s_trigger_pulse = false;
  }
  bool effective_gate = s_trigger_pulse;

  // Phase transitions.
  switch (s_phase) {
    case PHASE_IDLE:
      if (effective_gate) enter_phase(PHASE_ATTACK);
      break;
    case PHASE_ATTACK:
      if (!effective_gate) { enter_phase(PHASE_RELEASE); break; }
      if (s_time_in_phase >= (double)s_attack_s) enter_phase(PHASE_DECAY);
      break;
    case PHASE_DECAY:
      if (!effective_gate) { enter_phase(PHASE_RELEASE); break; }
      if (s_time_in_phase >= (double)s_decay_s) enter_phase(PHASE_SUSTAIN);
      break;
    case PHASE_SUSTAIN:
      if (!effective_gate) enter_phase(PHASE_RELEASE);
      break;
    case PHASE_RELEASE:
      if (effective_gate) { enter_phase(PHASE_ATTACK); break; }
      if (s_time_in_phase >= (double)s_release_s) enter_phase(PHASE_IDLE);
      break;
  }

  // Update break particle simulation (only during release).
  update_breaks(dt);
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (op == state::PatchReplace) {
      if      (state::pathIs(path, plen, "gate")) {
        bool new_gate = state::patchFloat(i) != 0.0f;
        if (new_gate && !s_gate_prev) {
          s_trigger_pulse = true;
          s_trigger_hold_remaining = (double)(s_attack_s + s_decay_s + s_sustain_s);
        }
        s_gate = new_gate;
        s_gate_prev = new_gate;
      }
      else if (state::pathIs(path, plen, "seed_y"))               s_seed_y = state::patchFloat(i);
      else if (state::pathIs(path, plen, "seed_height"))          s_seed_height = state::patchFloat(i);
      else if (state::pathIs(path, plen, "attack_s"))             s_attack_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "decay_s"))              s_decay_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "sustain_s"))            s_sustain_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "release_s"))            s_release_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "attack_curve"))         s_attack_curve = state::patchFloat(i);
      else if (state::pathIs(path, plen, "decay_curve"))          s_decay_curve = state::patchFloat(i);
      else if (state::pathIs(path, plen, "release_curve"))        s_release_curve = state::patchFloat(i);
      else if (state::pathIs(path, plen, "intensity"))            s_intensity = state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_target"))           s_bar_target = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_target_all"))       s_bar_target_all = state::patchFloat(i) != 0.0f;
      else if (state::pathIs(path, plen, "auto_rate"))            s_auto_rate = state::patchFloat(i);
      else if (state::pathIs(path, plen, "beam_color")) {
        auto v = state::patchVec3(i);
        s_color_r = v.x; s_color_g = v.y; s_color_b = v.z;
      }

      // Break-particle params.
      else if (state::pathIs(path, plen, "break_count_per_bar"))  s_break_count = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "attractor_fraction"))   s_attractor_fraction = state::patchFloat(i);
      else if (state::pathIs(path, plen, "spacer_fraction"))      s_spacer_fraction = state::patchFloat(i);
      else if (state::pathIs(path, plen, "min_break_size"))       s_min_break_size = state::patchFloat(i);
      else if (state::pathIs(path, plen, "max_break_size"))       s_max_break_size = state::patchFloat(i);
      else if (state::pathIs(path, plen, "force_strength"))       s_force_strength = state::patchFloat(i);
      else if (state::pathIs(path, plen, "spacer_strength"))      s_spacer_strength = state::patchFloat(i);
      else if (state::pathIs(path, plen, "force_softening"))      s_force_softening = state::patchFloat(i);
      else if (state::pathIs(path, plen, "damping_per_s"))        s_damping_per_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "interaction_radius"))   s_interaction_radius = state::patchFloat(i);
      else if (state::pathIs(path, plen, "teleport_rate"))        s_teleport_rate = state::patchFloat(i);
      else if (state::pathIs(path, plen, "length_target_start"))  s_length_target_start = state::patchFloat(i);
      else if (state::pathIs(path, plen, "length_target_end"))    s_length_target_end = state::patchFloat(i);
      else if (state::pathIs(path, plen, "length_target_curve"))  s_length_target_curve = state::patchFloat(i);
      else if (state::pathIs(path, plen, "grow_response"))        s_grow_response = state::patchFloat(i);
      else if (state::pathIs(path, plen, "activation_curve"))     s_activation_curve = state::patchFloat(i);
      else if (state::pathIs(path, plen, "activation_min"))       s_activation_min = state::patchFloat(i);
      else if (state::pathIs(path, plen, "growth_fraction"))      s_growth_fraction = state::patchFloat(i);
      else if (state::pathIs(path, plen, "break_seed"))           s_break_seed = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "cycle_seed"))           s_cycle_seed = state::patchFloat(i) != 0.0f;

      // Flicker tail.
      else if (state::pathIs(path, plen, "flicker_start_t"))      s_flicker_start_t = state::patchFloat(i);
      else if (state::pathIs(path, plen, "flicker_duty_start"))   s_flicker_duty_start = state::patchFloat(i);
      else if (state::pathIs(path, plen, "flicker_duty_end"))     s_flicker_duty_end = state::patchFloat(i);
      else if (state::pathIs(path, plen, "flicker_freq_hz"))      s_flicker_freq_hz = state::patchFloat(i);
    }

    // Event field — only fire when IDLE to defend against state-replay
    // re-arming (the "stuck on" bug).
    if (state::pathIs(path, plen, "trigger") && s_phase == PHASE_IDLE) {
      s_trigger_pulse = true;
      s_trigger_hold_remaining = (double)(s_attack_s + s_decay_s + s_sustain_s);
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Beam half-height based on current phase. Release stays at full
  // height — break particles do the visual decay instead.
  float half_height = 0.0f;
  bool active = false;
  switch (s_phase) {
    case PHASE_IDLE:
      half_height = 0.0f;
      break;
    case PHASE_ATTACK: {
      // Seed grows from 0 → seed_height across the attack phase,
      // shaped by attack_curve. Default linear (curve = 0 slider).
      float t = (s_attack_s > 0.0f) ? (float)(s_time_in_phase / (double)s_attack_s) : 1.0f;
      if (t > 1.0f) t = 1.0f;
      float t_curved = std::pow(t, fx::signedSliderToExp(s_attack_curve));
      half_height = s_seed_height * 0.5f * t_curved;
      active = (half_height > 0.0f);
    } break;
    case PHASE_DECAY: {
      float t = (s_decay_s > 0.0f) ? (float)(s_time_in_phase / (double)s_decay_s) : 1.0f;
      if (t > 1.0f) t = 1.0f;
      float t_curved = std::pow(t, fx::signedSliderToExp(s_decay_curve));
      half_height = lerpf(s_seed_height * 0.5f, 0.5f, t_curved);
      active = true;
    } break;
    case PHASE_SUSTAIN:
      half_height = 0.5f;
      active = true;
      break;
    case PHASE_RELEASE:
      // Beam stays full-height; breaks eat it away. Flicker tail
      // can mask everything to black periodically.
      half_height = 0.5f;
      active = true;
      break;
  }

  float y_min = s_seed_y - half_height;
  float y_max = s_seed_y + half_height;
  if (y_min < 0.0f) y_min = 0.0f;
  if (y_max > 1.0f) y_max = 1.0f;

  // Pack the per-bar break buffer (only meaningful during release; we
  // pack regardless because the shader's `breaks_active` flag gates
  // whether to consult them).
  GpuBreak gpu_breaks[MAX_BREAKS_TOTAL];
  std::memset(gpu_breaks, 0, sizeof(gpu_breaks));
  int per_bar = s_break_count;
  if (per_bar < 1) per_bar = 1;
  if (per_bar > MAX_BREAKS_PER_BAR) per_bar = MAX_BREAKS_PER_BAR;
  for (int bar = 0; bar < BARS; bar++) {
    for (int i = 0; i < per_bar; i++) {
      const CpuBreak& src = s_breaks[bar][i];
      GpuBreak& dst = gpu_breaks[bar * per_bar + i];
      dst.y      = src.y;
      dst.size   = src.size;
      dst.type_f = (float)src.type;
      dst._pad   = 0.0f;
    }
  }
  s_break_buf.writeBytes(gpu_breaks, (int)sizeof(GpuBreak) * BARS * per_bar);

  // Flicker is only visible at the tail end of release. Use the
  // release_curve-warped time so a non-zero release_curve shifts
  // flicker onset to match the perceived pace.
  bool flicker_active = (s_phase == PHASE_RELEASE);
  if (flicker_active && s_release_s > 0.0f) {
    float release_t_raw = clampf((float)(s_time_in_phase / (double)s_release_s), 0.0f, 1.0f);
    float release_t = std::pow(release_t_raw, fx::signedSliderToExp(s_release_curve));
    flicker_active = (release_t >= s_flicker_start_t);
  }

  Uniforms u = {};
  u.beam_y_min        = y_min;
  u.beam_y_max        = y_max;
  u.intensity         = s_intensity;
  u.active            = active ? 1u : 0u;
  u.color_r           = s_color_r;
  u.color_g           = s_color_g;
  u.color_b           = s_color_b;
  u.bar_target        = (uint32_t)s_bar_target;
  u.bar_target_all    = s_bar_target_all ? 1u : 0u;
  u.particles_per_bar = (uint32_t)per_bar;
  u.breaks_active     = (s_phase == PHASE_RELEASE) ? 1u : 0u;
  u.flicker_active    = flicker_active ? 1u : 0u;
  u.flicker_on        = s_flicker_on ? 1u : 0u;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.setBuffer(s_break_buf,   3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace plasma_beam_cannon
