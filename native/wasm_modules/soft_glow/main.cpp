/*
 * gen.soft_glow — Continuous warm-blob atmosphere bed (v1 scaffold).
 *
 * A pool of soft Gaussian blobs drifting at constant velocity (toroidal
 * wrap). Per pixel sums blob contributions, looks up a hue-shifting
 * ramp, additively blends over input.
 *
 * Deferred for later iteration: random-walk LFO drift, divergence
 * (per-bar hue offset on a threshold), HDR-then-tone-map output,
 * blob lifetime/respawn.
 */

#include <effect_utils.h>
#include <gpu.h>
#include <host.h>
#include "soft_glow_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace soft_glow {

static constexpr int   MAX_BLOBS = 32;
static constexpr float TAU       = 6.28318530717958647692f;

struct GpuBlob {
  // .xyz = (x, y, radius); .w = per-blob amplitude (1.0 = nominal).
  // Both color and motion shaders multiply their per-blob contribution
  // by this so a dimmed blob also drives less motion (visible footprint
  // ↔ motion footprint stay coupled).
  float pos_size[4];
  // .x = hue_offset (color shader only); .yz = (vx, vy) — velocity
  // in canvas-uv / sec, consumed by the motion shader; .w = pad.
  float jitters[4];
};
static_assert(sizeof(GpuBlob) == 32, "Blob layout mismatch");

struct Uniforms {
  uint32_t blob_count;
  float    intensity;
  float    ramp_curve;
  float    white_point;

  float    hue;            // hue at max amplitude
  float    hue_shift;      // hue offset added as amp → 0; |shift|>1 bands
  float    saturation;
  float    aspect_x;

  float    aspect_y;
  float    intensity_skew; // 0=isotropic, 1=wavefront-only contribution
  float    hue_curve;      // power on (1-ramp_t) — shapes where hue transition lives
  float    overflow_band;  // 0=soft-clip hue at peak; >0 keeps rotating → banding

  float    color_strength; // final multiplier on emitted glow rgb (no effect on motion)
  float    _pad_a;
  float    _pad_b;
  float    _pad_c;
};
static_assert(sizeof(Uniforms) == 64, "Uniforms layout mismatch");

struct MotionUniforms {
  uint32_t blob_count;
  float    motion_strength;
  float    motion_skew;
  float    aspect_x;

  float    aspect_y;
  float    motion_curl;     // signed [-1,+1] → rotation by curl·π radians
  float    intensity;       // scales coverage mask AND velocity magnitude
  float    _pad_2;
};
static_assert(sizeof(MotionUniforms) == 32, "MotionUniforms layout mismatch");

struct BlobState {
  // Position is derived each tick from the elliptical orbit:
  //   x = cx + wobble_rx * cos(wobble_phase)
  //   y = cy + wobble_ry * sin(wobble_phase)
  // rx > ry makes the orbit elliptical → tangential velocity is
  // minimum near the long-axis apexes, so the blob naturally
  // "weights" the tightest curvature points.
  float cx, cy;          // wobble center; drifts with drift_x/y_bias
  float wobble_rx;       // ellipse semi-axis x (cover-square units)
  float wobble_ry;       // ellipse semi-axis y; rx > ry → corners
  float wobble_phase;    // orbit phase accumulator
  float wobble_omega;    // per-blob angular-rate jitter in [0.5, 1.5]

  float x, y;            // derived this tick — read by render
  float vx, vy;          // instantaneous velocity (orbit + bias) for motion

  float size_jit;        // signed [-1,+1] — radius is recomputed each tick
                         // from (s_blob_size, s_blob_size_jitter, size_jit)
                         // so size changes don't need a reseed
  float hue_offset;
  // Two-octave amplitude oscillator. phase_a fast (breathing); phase_b
  // slow (drift envelope). freq_jit decorrelates blob-to-blob.
  float phase_a, phase_b;
  float freq_jit;
  float amp;

  // Fade state — current_alive smoothly tracks target_alive at rate
  // 1/fade_time. amp is multiplied by current_alive at pack time, so
  // a slot's full contribution to BOTH color and motion ramps with
  // its visibility. target_alive is derived each tick from
  // (i < s_blob_count) AND the `wants_respawn` override.
  float target_alive;    // 0 or 1
  float current_alive;   // [0, 1]
  // Set when the orbit has drifted fully off-screen — forces target to
  // 0 until current_alive reaches 0, then triggers respawn at a fresh
  // location. Lets bias-driven drift wander off-screen cleanly via the
  // fade machinery (no wrap teleport).
  bool  wants_respawn;
};

static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_uniform_buf;
static gpu::Buffer     s_motion_uniform_buf;
static gpu::Buffer     s_blob_buf;
static gpu::Texture    s_motion_tex;
static gpu::Texture    s_zero_motion_tex;   // 1x1 rgba16f fallback (no upstream)
static int             s_motion_w = 0;
static int             s_motion_h = 0;
static BlobState       s_blobs[MAX_BLOBS];
static bool s_initialized   = false;

// Schema-mirrored params
static int   s_blob_count        = 12;
static float s_blob_size         = 0.4f;
static float s_blob_size_jitter  = 0.3f;
static float s_drift_rate        = 0.2f;
static float s_drift_x_bias      = 0.0f;
static float s_drift_y_bias      = 0.0f;
static float s_hue               = 0.05f;  // hue at peak amplitude
static float s_hue_shift         = 0.30f;  // amount added as amp → 0
static float s_hue_curve         = 0.0f;   // signed [-1..+1] → exp via signedSliderToExp(2.0)
static float s_saturation        = 0.95f;
static float s_intensity_skew    = 0.0f;
static float s_overflow_band     = 0.0f;  // 0 = soft-clip hue at peak; >0 → banding
static float s_color_strength    = 1.0f;  // final multiplier on emitted glow (color only)
static float s_ramp_curve        = 0.0f;   // signed [-1..+1] → exp via signedSliderToExp(2.0)
static float s_white_point       = 1.5f;
static float s_intensity         = 1.0f;
static float s_intensity_mod     = 0.0f;
static float s_motion_strength   = 1.0f;  // boost — blobs drift slowly
static float s_motion_skew       = 0.0f;  // 0=isotropic, 1=wavefront-only
static float s_motion_curl       = 0.0f;  // signed [-1,+1] → rotate local motion by curl·π
static float s_pulse_depth       = 0.4f;
static float s_pulse_rate        = 0.6f;   // Hz, fast breathing rate
static float s_amp_drift_depth   = 0.9f;   // depth of slow envelope (multiplicative)
static float s_amp_drift_rate    = 0.08f;  // Hz, slow drift rate (~12s period)
static float s_fade_time         = 3.0f;   // sec — blob_count fade in/out
static uint32_t s_seed           = 0xA17F2B91u;

// RNG stream used for *respawn* of revived slots. Advances on each
// respawn so toggling count up and down yields fresh positions on
// every spawn (rather than re-drawing the deterministic seed_all
// sequence). Reset from s_seed whenever the user changes seed.
static uint32_t s_spawn_rng      = 0xDEADBEEFu;

// Init flag — populated once after init() finishes
static bool s_blobs_seeded = false;

static uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u;
  return s;
}
static float lcg_unit(uint32_t& s) {
  return (lcg_next(s) >> 8) * (1.0f / float(1u << 24));
}
static float lcg_signed(uint32_t& s) { return lcg_unit(s) * 2.0f - 1.0f; }

static void seed_blob(int i, uint32_t& rng) {
  BlobState& b = s_blobs[i];
  // Wobble center anywhere in uv-space.
  b.cx = lcg_unit(rng);
  b.cy = lcg_unit(rng);
  // Ellipse semi-axes. rx is the long axis; ry is shorter so the orbit
  // is definitively elliptical → tangential speed slows near the
  // long-axis apexes ("weight at the tightest corners").
  b.wobble_rx = 0.10f + lcg_unit(rng) * 0.25f;          // [0.10, 0.35]
  b.wobble_ry = b.wobble_rx * (0.25f + lcg_unit(rng) * 0.45f); // [0.25, 0.70] of rx
  // Rotate the ellipse to a random orientation by phase-shifting:
  // start phase = random ∈ [0, TAU).
  b.wobble_phase = lcg_unit(rng) * TAU;
  b.wobble_omega = 0.5f + lcg_unit(rng);                 // [0.5, 1.5]
  // Initial position derived from wobble.
  b.x = b.cx + b.wobble_rx * std::cos(b.wobble_phase);
  b.y = b.cy + b.wobble_ry * std::sin(b.wobble_phase);
  b.vx = 0.0f;
  b.vy = 0.0f;
  b.size_jit   = lcg_signed(rng);
  b.hue_offset = lcg_signed(rng) * 0.05f;  // small per-blob hue jitter
  // Amplitude oscillator seeds. Phases get a full TAU spread so blobs
  // start out of sync; freq_jit decorrelates pulse rates blob-to-blob
  // so the bed doesn't pump as one.
  b.phase_a  = lcg_unit(rng) * TAU;
  b.phase_b  = lcg_unit(rng) * TAU;
  b.freq_jit = 0.5f + lcg_unit(rng);            // [0.5, 1.5]
  b.amp      = 1.0f;
  b.wants_respawn = false;
}

static void respawn_blob(int i) {
  seed_blob(i, s_spawn_rng);
  BlobState& b = s_blobs[i];
  // If a drift bias is set, respawn upwind (just off the trailing
  // edge) so blobs sweep across the viewport like wind-blown clouds
  // instead of clustering at the leading edge. With no bias, the
  // seed_blob random position in [0, 1) stands.
  if (s_drift_x_bias > 0.0f) {
    b.cx = -b.wobble_rx - 0.05f - lcg_unit(s_spawn_rng) * 0.15f;
  } else if (s_drift_x_bias < 0.0f) {
    b.cx = 1.0f + b.wobble_rx + 0.05f + lcg_unit(s_spawn_rng) * 0.15f;
  }
  if (s_drift_y_bias > 0.0f) {
    b.cy = -b.wobble_ry - 0.05f - lcg_unit(s_spawn_rng) * 0.15f;
  } else if (s_drift_y_bias < 0.0f) {
    b.cy = 1.0f + b.wobble_ry + 0.05f + lcg_unit(s_spawn_rng) * 0.15f;
  }
  // Recompute initial position from (possibly relocated) center.
  b.x = b.cx + b.wobble_rx * std::cos(b.wobble_phase);
  b.y = b.cy + b.wobble_ry * std::sin(b.wobble_phase);
  // New blobs fade IN from invisible — current_alive will rise to
  // target_alive at fade rate in tick().
  b.target_alive  = 1.0f;
  b.current_alive = 0.0f;
}

static void seed_all() {
  uint32_t rng = s_seed;
  for (int i = 0; i < MAX_BLOBS; i++) {
    seed_blob(i, rng);
    bool alive = (i < s_blob_count);
    // Initial state: blobs within count start fully alive (no fade-in
    // on first frame), blobs beyond count start fully dead.
    s_blobs[i].target_alive  = alive ? 1.0f : 0.0f;
    s_blobs[i].current_alive = alive ? 1.0f : 0.0f;
  }
  // Continue the spawn-rng stream from wherever seed_all left off, so
  // subsequent respawns get fresh randomness rather than re-drawing
  // the initial sequence.
  s_spawn_rng = rng;
  s_blobs_seeded = true;
}

void init() {
  s_blobs_seeded = false;

  state::init("gen.soft_glow", {1, 0, 0},
    state::Schema()
      .floatField("intensity",        1.0f, 0.0f, 2.0f, state::PrimaryInput)
      .floatField("intensity_mod",    0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .intField  ("blob_count",       12,   0,    MAX_BLOBS, state::PrimaryInput)
      .floatField("fade_time",        3.0f, 0.05f, 10.0f, state::PrimaryInput)
      .floatField("blob_size",        0.4f, 0.05f, 1.0f, state::PrimaryInput)
      .floatField("blob_size_jitter", 0.3f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_rate",       0.2f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_x_bias",     0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_y_bias",     0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .floatField("hue",              0.05f, 0.0f, 1.0f,  state::PrimaryInput)
      .floatField("hue_shift",        0.30f, -3.0f, 3.0f, state::PrimaryInput)
      .floatField("hue_curve",        0.0f,  -1.0f, 1.0f, state::PrimaryInput)
      .floatField("overflow_band",    0.0f,  0.0f,  3.0f, state::PrimaryInput)
      .floatField("color_strength",   1.0f,  0.0f,  4.0f, state::PrimaryInput)
      .floatField("saturation",       0.95f, 0.0f, 1.0f,  state::PrimaryInput)
      .floatField("intensity_skew",   0.0f,  0.0f, 1.0f,  state::PrimaryInput)
      .floatField("ramp_curve",       0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .floatField("white_point",      1.5f, 0.5f, 3.0f, state::PrimaryInput)
      .floatField("pulse_depth",      0.4f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("pulse_rate",       0.6f, 0.0f, 3.0f, state::PrimaryInput)
      .floatField("amp_drift_depth",  0.9f,  0.0f, 1.0f, state::PrimaryInput)
      .floatField("amp_drift_rate",   0.08f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("motion_strength",  1.0f,  0.0f, 8.0f,  state::PrimaryInput)
      .floatField("motion_skew",      0.0f,  0.0f, 1.0f,  state::PrimaryInput)
      .floatField("motion_curl",      0.0f, -1.0f, 1.0f,  state::PrimaryInput)
      .intField  ("seed",             0,    0,    65535, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      // Upstream auxiliary inputs (e.g. motion) — when wired the motion
      // pass lerps our local contribution on top of the upstream field.
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("soft_glow_color", COLOR_SPV, COLOR_SPV_SIZE);
  state::registerShaderSPV("soft_glow_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("soft_glow_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("soft_glow_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .storage(0)
      .tex2d(1)
      .storageTex2d(2, gpu::TextureFormat::RGBA8)
      .uniform(3));

  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .storage(0)                                       // blobs (with velocity)
      .tex2d(1)                                         // upstream motion
      .storageTex2d(2, gpu::TextureFormat::RGBA16F)     // motionTex
      .uniform(3));                                     // MotionUniforms

  s_blob_buf = gpu::Device::createBuffer(
      sizeof(GpuBlob) * MAX_BLOBS, gpu::BufferUsage::Storage);
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_motion_uniform_buf = gpu::Device::createBuffer(
      sizeof(MotionUniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  seed_all();
  state::log("soft_glow: initialized");
}

void tick(double dt) {
  if (!s_initialized || !s_blobs_seeded) return;
  float fdt = (float)dt;

  // Per-second fade rate (current_alive moves at this rate toward
  // target_alive). fade_time → 0 means instantaneous.
  float fade_t = s_fade_time > 0.001f ? s_fade_time : 0.001f;
  float fade_rate = 1.0f / fade_t;

  float omega_fast = s_pulse_rate * TAU;
  float omega_slow = s_amp_drift_rate * TAU;

  for (int i = 0; i < MAX_BLOBS; i++) {
    BlobState& b = s_blobs[i];

    // ---- Fade machine ----
    // Priority order: wants_respawn (off-screen drift) → count-derived
    // target. wants_respawn forces fade-out; once current_alive hits
    // 0 we respawn at a fresh location and clear the flag.
    float count_target = (i < s_blob_count) ? 1.0f : 0.0f;
    if (b.wants_respawn) {
      if (b.current_alive == 0.0f) {
        respawn_blob(i);
        b.wants_respawn = false;
        // respawn_blob set target=1, current=0 — fade-in proceeds.
      } else {
        b.target_alive = 0.0f;
      }
    } else {
      bool fresh_spawn = (count_target > 0.0f
                          && b.target_alive == 0.0f
                          && b.current_alive == 0.0f);
      if (fresh_spawn) {
        respawn_blob(i);
      } else {
        b.target_alive = count_target;
      }
    }

    // Advance current_alive toward target_alive at fade_rate, clamped.
    float diff = b.target_alive - b.current_alive;
    if (diff != 0.0f) {
      float step = (diff > 0.0f ? fade_rate : -fade_rate) * fdt;
      if ((step >= 0.0f && step >= diff) ||
          (step <  0.0f && step <= diff)) {
        b.current_alive = b.target_alive;
      } else {
        b.current_alive += step;
      }
    }

    // ---- Orbit: position derived from elliptical parameterization.
    // drift_x/y_bias drifts the orbit *center*; the blob still wobbles
    // around it. No wrap — a wrap on cx/cy would teleport the visible
    // position by ~1 unit (popping). Instead, we detect "fully off-
    // screen" below and route the blob through the fade-out + respawn
    // path, which is invisible to the viewer since the blob is already
    // off-screen.
    b.cx += s_drift_x_bias * fdt;
    b.cy += s_drift_y_bias * fdt;

    float omega_eff = s_drift_rate * b.wobble_omega;
    b.wobble_phase += omega_eff * fdt;

    float c = std::cos(b.wobble_phase);
    float sn = std::sin(b.wobble_phase);
    b.x = b.cx + b.wobble_rx * c;
    b.y = b.cy + b.wobble_ry * sn;
    // Instantaneous orbital velocity (analytic derivative of position).
    // With rx ≠ ry, |v| varies around the orbit and is smallest near
    // the long-axis apexes — exactly the "weight at corners" feel.
    b.vx = -b.wobble_rx * sn * omega_eff + s_drift_x_bias;
    b.vy =  b.wobble_ry * c  * omega_eff + s_drift_y_bias;

    // Per-blob off-screen check: only check the *leading* edge along
    // each axis (the edge the drift bias is carrying the blob toward).
    // Checking the trailing edge would immediately re-flag the
    // freshly-respawned upwind blob for another fade-out — it would
    // never get to actually enter the viewport. With bias=0, both
    // edges are checked; without drift the blob never reaches an
    // edge anyway (initial cx ∈ [0, 1)).
    if (!b.wants_respawn) {
      bool oob = false;
      if (s_drift_x_bias >= 0.0f && b.cx - b.wobble_rx > 1.0f) oob = true;
      if (s_drift_x_bias <= 0.0f && b.cx + b.wobble_rx < 0.0f) oob = true;
      if (s_drift_y_bias >= 0.0f && b.cy - b.wobble_ry > 1.0f) oob = true;
      if (s_drift_y_bias <= 0.0f && b.cy + b.wobble_ry < 0.0f) oob = true;
      if (oob) b.wants_respawn = true;
    }

    // ---- Amplitude oscillator (unchanged) ----
    b.phase_a += omega_fast * b.freq_jit * fdt;
    b.phase_b += omega_slow * b.freq_jit * fdt;
    float slow_unit = 0.5f + 0.5f * std::sin(b.phase_b);
    float slow_env  = (1.0f - s_amp_drift_depth) + s_amp_drift_depth * slow_unit;
    float breath    = 1.0f + s_pulse_depth * std::sin(b.phase_a);
    float amp       = slow_env * breath;
    b.amp = amp > 0.0f ? amp : 0.0f;
  }
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  // Only `seed` change triggers a reseed now — blob_size, blob_size_jitter,
  // drift_rate, drift_x/y_bias all take effect per-tick via the derived
  // wobble physics and radius packing. State-replay defense (§8.2) lives
  // on the `seed` field's change-detect.
  bool seed_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "intensity"))        s_intensity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "intensity_mod"))    s_intensity_mod = state::patchFloat(i);
    else if (state::pathIs(path, plen, "blob_count"))       s_blob_count = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "fade_time"))        s_fade_time = state::patchFloat(i);
    else if (state::pathIs(path, plen, "blob_size"))        s_blob_size = state::patchFloat(i);
    else if (state::pathIs(path, plen, "blob_size_jitter")) s_blob_size_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_rate"))       s_drift_rate = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_x_bias"))     s_drift_x_bias = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_y_bias"))     s_drift_y_bias = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hue"))              s_hue = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hue_shift"))        s_hue_shift = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hue_curve"))        s_hue_curve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "overflow_band"))    s_overflow_band = state::patchFloat(i);
    else if (state::pathIs(path, plen, "color_strength"))   s_color_strength = state::patchFloat(i);
    else if (state::pathIs(path, plen, "saturation"))       s_saturation = state::patchFloat(i);
    else if (state::pathIs(path, plen, "intensity_skew"))   s_intensity_skew = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ramp_curve"))       s_ramp_curve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "white_point"))      s_white_point = state::patchFloat(i);
    else if (state::pathIs(path, plen, "motion_strength"))  s_motion_strength = state::patchFloat(i);
    else if (state::pathIs(path, plen, "motion_skew"))      s_motion_skew = state::patchFloat(i);
    else if (state::pathIs(path, plen, "motion_curl"))      s_motion_curl = state::patchFloat(i);
    else if (state::pathIs(path, plen, "pulse_depth"))      s_pulse_depth = state::patchFloat(i);
    else if (state::pathIs(path, plen, "pulse_rate"))       s_pulse_rate = state::patchFloat(i);
    else if (state::pathIs(path, plen, "amp_drift_depth"))  s_amp_drift_depth = state::patchFloat(i);
    else if (state::pathIs(path, plen, "amp_drift_rate"))   s_amp_drift_rate = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed")) {
      uint32_t new_seed = (uint32_t)((int)state::patchFloat(i)) ^ 0xA17F2B91u;
      if (new_seed != s_seed) {
        s_seed = new_seed;
        seed_changed = true;
      }
    }
  }
  // Full re-seed on seed change — fresh deterministic positions/orbits
  // for all slots. The spawn-rng stream is also rebound to the new
  // seed so subsequent respawn-on-revival hits new sequences.
  if (seed_changed && s_initialized) {
    seed_all();
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Cover-square aspect so the blobs are isotropic.
  float min_dim = (float)(vp_w < vp_h ? vp_w : vp_h);
  float aspect_x = min_dim / (float)vp_w;
  float aspect_y = min_dim / (float)vp_h;

  // Pack every slot. Slots fading in/out (current_alive < 1) and
  // slots outside the active count (current_alive = 0) all flow
  // through the same path — amp * current_alive gates their
  // contribution. Cost is negligible at MAX_BLOBS = 32.
  GpuBlob gpu_blobs[MAX_BLOBS];
  std::memset(gpu_blobs, 0, sizeof(gpu_blobs));
  for (int i = 0; i < MAX_BLOBS; i++) {
    const BlobState& b = s_blobs[i];
    // Radius is derived each tick from base + per-blob jitter factor,
    // so blob_size / blob_size_jitter changes take effect without a
    // reseed.
    float radius = s_blob_size * (1.0f + b.size_jit * s_blob_size_jitter);
    if (radius < 0.02f) radius = 0.02f;
    // Smoothstep on the linear fade — zero slope at both endpoints so
    // the contribution easily eases away from 0 and into 1 instead of
    // crossing the boundary with a step in derivative. Human vision is
    // ~logarithmic, so a linear brightness ramp feels like a pop at
    // exactly the moments it touches off/on; smoothstep removes those.
    float ca = b.current_alive;
    float fade_eased = ca * ca * (3.0f - 2.0f * ca);
    gpu_blobs[i].pos_size[0] = b.x;
    gpu_blobs[i].pos_size[1] = b.y;
    gpu_blobs[i].pos_size[2] = radius;
    gpu_blobs[i].pos_size[3] = b.amp * fade_eased;       // fade rolls into amp
    gpu_blobs[i].jitters[0]  = b.hue_offset;
    gpu_blobs[i].jitters[1]  = b.vx;
    gpu_blobs[i].jitters[2]  = b.vy;
  }
  s_blob_buf.writeBytes(gpu_blobs, sizeof(GpuBlob) * MAX_BLOBS);
  uint32_t cnt = (uint32_t)MAX_BLOBS;

  float intensity = s_intensity + s_intensity_mod;
  if (intensity < 0.0f) intensity = 0.0f;

  Uniforms u = {};
  u.blob_count     = cnt;
  u.intensity      = intensity;
  // Signed slider [-1,+1] → exp in [1/4, 4] via the canonical helper,
  // matching hue_curve. 0 = linear; +1 = fast initial response (peak
  // saturates early); -1 = slow initial response (peak takes more
  // accum to reach).
  u.ramp_curve     = fx::signedSliderToExp(s_ramp_curve, 2.0f);
  u.white_point    = s_white_point;
  u.hue       = s_hue;
  u.hue_shift      = s_hue_shift;
  u.saturation     = s_saturation;
  u.aspect_x       = aspect_x;
  u.aspect_y       = aspect_y;
  u.intensity_skew = s_intensity_skew;
  // Signed slider [-1,+1] mapped to an exponent in [1/4, 4] via the
  // canonical curve helper (style guide §8.3 / §1.3). 0 = linear; +1 =
  // contrast at the peak (fast initial shift); -1 = contrast at the rim
  // (clings to peak, then races at low amp).
  u.hue_curve      = fx::signedSliderToExp(s_hue_curve, 2.0f);
  u.overflow_band  = s_overflow_band;
  u.color_strength = s_color_strength;
  s_uniform_buf.writeOne(u);

  // Pass 1 — color.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setBuffer(s_blob_buf, 0);
    cp.setTexture(in,  1, 0);
    cp.setTexture(out, 2, 1);
    cp.setBuffer(s_uniform_buf, 3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Pass 2 — motion. Skip when no downstream consumer.
  if (!state::isOutputConnected("render_outputs")) {
    gpu::Device::submit();
    return;
  }

  if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
    s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    s_motion_w = vp_w;
    s_motion_h = vp_h;
    if (s_motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
    }
  }
  if (!s_motion_tex.valid()) {
    gpu::Device::submit();
    return;
  }

  // Resolve upstream motion; bind a 1x1 zero fallback when no upstream
  // is wired so the shader's unconditional sample is safe.
  auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
  if (!upstream.valid()) {
    if (!s_zero_motion_tex.valid()) {
      s_zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
    }
    upstream = s_zero_motion_tex;
  }

  MotionUniforms mu = {};
  mu.blob_count      = cnt;
  mu.motion_strength = s_motion_strength;
  mu.motion_skew     = s_motion_skew;
  mu.aspect_x        = aspect_x;
  mu.aspect_y        = aspect_y;
  mu.motion_curl     = s_motion_curl;
  mu.intensity       = intensity;        // ties motion to the visible blob's brightness
  s_motion_uniform_buf.writeOne(mu);

  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setBuffer(s_blob_buf, 0);
    cp.setTexture(upstream, 1, 0);
    cp.setTexture(s_motion_tex, 2, 1);
    cp.setBuffer(s_motion_uniform_buf, 3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace soft_glow
