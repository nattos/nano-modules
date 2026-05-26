/*
 * gen.side_jet — JPL-style horizontal jet trail.
 *
 * Trigger spawns a jet from one canvas edge; the procedural shape is
 * a diverging cone with Mach-diamond pulsation along the axis and
 * Fbm-modulated turbulent edges. Pool of up to 16 concurrent jets,
 * each with its own centerline_y, color_seed (phase offset on
 * diamonds + turbulence), and direction (LtoR / RtoL).
 *
 * Per-pixel motion emission: pixels inside an active jet's cone get
 * the head's velocity (canvas-uv-per-sec) written into
 * render_outputs/motion, so the downstream video.motion_blur streaks
 * the head naturally without per-effect blur logic.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "side_jet_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace side_jet {

enum Direction : int { DIR_LtoR = 0, DIR_RtoL = 1, DIR_RANDOM = 2 };

static constexpr int MAX_JETS = 16;

struct CpuJet {
  bool   active;
  double start_time;          // host::time() when spawned
  float  dir;                 // +1 or -1
  float  centerline_y;
  float  color_seed;          // [0, 1)
  float  transit_seconds;
};

struct GpuJet {
  float head_x;
  float dir;
  float centerline_y;
  float transit_seconds;
  float color_seed;
  float _pp0;
  float _pp1;
  float _pp2;
};
static_assert(sizeof(GpuJet) == 32, "GpuJet layout mismatch");

struct Uniforms {
  float intensity;
  float head_width;
  float cone_tan;
  float trail_length;

  float axial_decay_curve;
  float radial_sharpness;
  float diamond_amp;
  float diamond_period;

  float shimmer_phase;
  float turb_amp;
  float turb_scale;
  float turb_phase;

  float core_r;  float core_g;  float core_b;  float _pad0;
  float edge_r;  float edge_g;  float edge_b;  float _pad1;

  uint32_t active_count;
  uint32_t debug_show_axis;
  uint32_t _pad2;
  uint32_t _pad3;
};
static_assert(sizeof(Uniforms) == 96, "Uniforms layout mismatch");

// --- GPU resources ---
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_uniform_buf;
static gpu::Buffer     s_jet_buf;
static gpu::Texture    s_motion_tex;
static gpu::Texture    s_zero_motion_tex;
static int             s_motion_w = 0;
static int             s_motion_h = 0;
static bool            s_initialized = false;

// --- Schema-mirrored params (standard) ---
static bool  s_gate                  = false;
static float s_auto_rate             = 0.2f;
static float s_transit_seconds       = 0.4f;
static int   s_direction             = DIR_RANDOM;
static float s_centerline_y          = 0.5f;
static float s_centerline_y_jitter   = 0.1f;
static float s_color_core_r          = 1.00f;
static float s_color_core_g          = 0.95f;
static float s_color_core_b          = 0.85f;
static float s_color_edge_r          = 0.40f;
static float s_color_edge_g          = 0.60f;
static float s_color_edge_b          = 1.00f;
static float s_intensity             = 1.0f;
// --- Tuning shape ---
static float s_head_width            = 0.015f;
static float s_cone_half_angle_deg   = 8.0f;
static float s_trail_length          = 0.6f;
static float s_axial_decay_curve     = 2.0f;
static float s_radial_sharpness      = 4.0f;
// --- Tuning evolution ---
static float s_diamond_amp           = 0.5f;
static float s_diamond_period        = 0.05f;
static float s_diamond_shimmer_rate_hz = 10.0f;
static float s_turbulence_amp        = 0.3f;
static float s_turbulence_scale      = 12.0f;
static float s_turbulence_rate_hz    = 8.0f;
// --- Tuning pool ---
static int   s_pool_size             = 4;
static int   s_seed                  = 0x10A11;
// --- Debug ---
static bool  s_debug_show_axis       = false;

// --- Runtime ---
static CpuJet  s_jets[MAX_JETS];
static double  s_shimmer_phase = 0.0;       // accumulator (§2.1)
static double  s_turb_phase    = 0.0;       // accumulator (§2.1)
static bool    s_gate_prev     = false;
static double  s_refractory_remaining = 0.0;
static uint32_t s_spawn_rng    = 0xB16B00B5u;
static uint32_t s_autotrigger_rng = 0xCAFEBABEu;

static constexpr double TRIGGER_REFRACTORY_S = 0.02;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u; return s;
}
static inline float lcg_unit(uint32_t& s) {
  return (lcg_next(s) >> 8) * (1.0f / (float)(1u << 24));
}
static inline float lcg_signed(uint32_t& s) {
  return lcg_unit(s) * 2.0f - 1.0f;
}

static void spawn_jet() {
  int slot = -1;
  int cap = s_pool_size;
  if (cap < 1) cap = 1;
  if (cap > MAX_JETS) cap = MAX_JETS;
  for (int i = 0; i < cap; i++) {
    if (!s_jets[i].active) { slot = i; break; }
  }
  if (slot < 0) return;        // pool full — drop the trigger

  CpuJet& j = s_jets[slot];
  j.active = true;
  j.start_time = host::time();
  // Direction.
  float dir = +1.0f;
  if (s_direction == DIR_LtoR) dir = +1.0f;
  else if (s_direction == DIR_RtoL) dir = -1.0f;
  else dir = (lcg_unit(s_spawn_rng) < 0.5f) ? +1.0f : -1.0f;
  j.dir = dir;
  // Centerline (with jitter).
  float jitter = lcg_signed(s_spawn_rng) * clampf(s_centerline_y_jitter, 0.0f, 0.5f);
  j.centerline_y = clampf(s_centerline_y + jitter, 0.0f, 1.0f);
  j.color_seed = lcg_unit(s_spawn_rng);
  j.transit_seconds = clampf(s_transit_seconds, 0.01f, 10.0f);
  s_refractory_remaining = TRIGGER_REFRACTORY_S;
}

void init() {
  s_initialized = false;
  s_gate = false; s_gate_prev = false;
  s_refractory_remaining = 0.0;
  s_shimmer_phase = 0.0; s_turb_phase = 0.0;
  s_spawn_rng = (uint32_t)s_seed ^ 0xB16B00B5u;
  s_autotrigger_rng = (uint32_t)s_seed ^ 0xCAFEBABEu;
  for (int i = 0; i < MAX_JETS; i++) {
    s_jets[i].active = false;
    s_jets[i].start_time = 0.0;
    s_jets[i].dir = 1.0f;
    s_jets[i].centerline_y = 0.5f;
    s_jets[i].color_seed = 0.0f;
    s_jets[i].transit_seconds = 0.4f;
  }
  s_motion_w = 0; s_motion_h = 0;

  state::init("gen.side_jet", {1, 0, 0},
    state::Schema()
      // --- Standard trigger surface ---
      .boolField ("gate",                false,                  state::PrimaryInput)
      .eventField("trigger",                                     state::PrimaryInput)
      .floatField("auto_rate",           0.2f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("transit_seconds",     0.4f,  0.05f, 3.0f,     state::PrimaryInput)
      .selectField("direction",          DIR_RANDOM, state::PrimaryInput,
                   {{"L to R", 0}, {"R to L", 1}, {"Random", 2}})
      .floatField("centerline_y",        0.5f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("centerline_y_jitter", 0.1f,  0.0f, 0.5f,      state::PrimaryInput)
      .rgbField  ("color_core",          1.00f, 0.95f, 0.85f,    state::PrimaryInput)
      .rgbField  ("color_edge",          0.40f, 0.60f, 1.00f,    state::PrimaryInput)
      .floatField("intensity",           1.0f,  0.0f, 2.0f,      state::PrimaryInput)
      // --- Tuning shape ---
      .floatField("head_width",          0.015f, 0.0f, 0.1f,     state::PrimaryInput)
      .floatField("cone_half_angle_deg", 8.0f,  0.0f, 30.0f,     state::PrimaryInput)
      .floatField("trail_length",        0.6f,  0.0f, 2.0f,      state::PrimaryInput)
      .floatField("axial_decay_curve",   2.0f,  0.25f, 4.0f,     state::PrimaryInput)
      .floatField("radial_sharpness",    4.0f,  1.0f, 16.0f,     state::PrimaryInput)
      // --- Tuning evolution ---
      .floatField("diamond_amp",         0.5f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("diamond_period",      0.05f, 0.005f, 0.3f,    state::PrimaryInput)
      .floatField("diamond_shimmer_rate_hz", 10.0f, 0.0f, 30.0f, state::PrimaryInput)
      .floatField("turbulence_amp",      0.3f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("turbulence_scale",    12.0f, 1.0f, 32.0f,     state::PrimaryInput)
      .floatField("turbulence_rate_hz",  8.0f,  0.0f, 30.0f,     state::PrimaryInput)
      // --- Tuning pool ---
      .intField  ("pool_size",           4, 1, MAX_JETS,         state::PrimaryInput)
      .intField  ("seed",                0x10A11, 0, 0x7FFFFFFF, state::PrimaryInput)
      // --- Debug ---
      .boolField ("debug_show_axis",     false,                  state::PrimaryInput)
      // --- I/O ---
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("side_jet_color", COLOR_SPV, COLOR_SPV_SIZE);
  state::registerShaderSPV("side_jet_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("side_jet_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("side_jet_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2)
      .storage(3));
  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)
      .uniform(2)
      .storage(3));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_jet_buf     = gpu::Device::createBuffer(sizeof(GpuJet) * MAX_JETS, gpu::BufferUsage::Storage);
  s_initialized = true;
  state::log("side_jet: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;

  if (s_refractory_remaining > 0.0) {
    s_refractory_remaining -= dt;
    if (s_refractory_remaining < 0.0) s_refractory_remaining = 0.0;
  }

  // Phase accumulators (§2.1 — never elapsed*rate).
  if (s_diamond_shimmer_rate_hz > 0.0f) {
    s_shimmer_phase += dt * (double)s_diamond_shimmer_rate_hz;
    if (s_shimmer_phase > 1024.0) s_shimmer_phase -= std::floor(s_shimmer_phase);
  }
  if (s_turbulence_rate_hz > 0.0f) {
    s_turb_phase += dt * (double)s_turbulence_rate_hz;
    if (s_turb_phase > 1024.0) s_turb_phase -= std::floor(s_turb_phase);
  }

  // Poisson auto-trigger.
  if (s_auto_rate > 0.0f) {
    float rate_hz = std::pow(60.0f, s_auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      float lambda = rate_hz * (float)dt;
      float u = lcg_unit(s_autotrigger_rng);
      if (u < 1.0f - std::exp(-lambda)) spawn_jet();
    }
  }

  // Cull jets that have cleared the opposite edge by `trail_length`.
  double now = host::time();
  int cap = s_pool_size;
  if (cap < 1) cap = 1;
  if (cap > MAX_JETS) cap = MAX_JETS;
  for (int i = 0; i < cap; i++) {
    CpuJet& j = s_jets[i];
    if (!j.active) continue;
    float elapsed = (float)(now - j.start_time);
    float progress = j.transit_seconds > 1e-3f ? elapsed / j.transit_seconds : 1.0f;
    float head_x = (j.dir > 0.0f) ? progress : (1.0f - progress);
    bool dead = (j.dir > 0.0f)
        ? (head_x > 1.0f + s_trail_length)
        : (head_x < -s_trail_length);
    if (dead) j.active = false;
  }
  for (int i = cap; i < MAX_JETS; i++) s_jets[i].active = false;
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (op == state::PatchReplace) {
      if (state::pathIs(path, plen, "gate")) {
        bool new_gate = state::patchFloat(i) != 0.0f;
        if (new_gate && !s_gate_prev) spawn_jet();
        s_gate = new_gate;
        s_gate_prev = new_gate;
      }
      else if (state::pathIs(path, plen, "auto_rate"))           s_auto_rate           = state::patchFloat(i);
      else if (state::pathIs(path, plen, "transit_seconds"))     s_transit_seconds     = state::patchFloat(i);
      else if (state::pathIs(path, plen, "direction"))           s_direction           = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "centerline_y"))        s_centerline_y        = state::patchFloat(i);
      else if (state::pathIs(path, plen, "centerline_y_jitter")) s_centerline_y_jitter = state::patchFloat(i);
      else if (state::pathIs(path, plen, "color_core")) {
        auto v = state::patchVec3(i);
        s_color_core_r = v.x; s_color_core_g = v.y; s_color_core_b = v.z;
      }
      else if (state::pathIs(path, plen, "color_edge")) {
        auto v = state::patchVec3(i);
        s_color_edge_r = v.x; s_color_edge_g = v.y; s_color_edge_b = v.z;
      }
      else if (state::pathIs(path, plen, "intensity"))           s_intensity           = state::patchFloat(i);
      else if (state::pathIs(path, plen, "head_width"))          s_head_width          = state::patchFloat(i);
      else if (state::pathIs(path, plen, "cone_half_angle_deg")) s_cone_half_angle_deg = state::patchFloat(i);
      else if (state::pathIs(path, plen, "trail_length"))        s_trail_length        = state::patchFloat(i);
      else if (state::pathIs(path, plen, "axial_decay_curve"))   s_axial_decay_curve   = state::patchFloat(i);
      else if (state::pathIs(path, plen, "radial_sharpness"))    s_radial_sharpness    = state::patchFloat(i);
      else if (state::pathIs(path, plen, "diamond_amp"))         s_diamond_amp         = state::patchFloat(i);
      else if (state::pathIs(path, plen, "diamond_period"))      s_diamond_period      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "diamond_shimmer_rate_hz")) s_diamond_shimmer_rate_hz = state::patchFloat(i);
      else if (state::pathIs(path, plen, "turbulence_amp"))      s_turbulence_amp      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "turbulence_scale"))    s_turbulence_scale    = state::patchFloat(i);
      else if (state::pathIs(path, plen, "turbulence_rate_hz"))  s_turbulence_rate_hz  = state::patchFloat(i);
      else if (state::pathIs(path, plen, "pool_size"))           s_pool_size           = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "seed")) {
        int v = (int)state::patchFloat(i);
        if (v != s_seed) {
          s_seed = v;
          s_spawn_rng = (uint32_t)v ^ 0xB16B00B5u;
          s_autotrigger_rng = (uint32_t)v ^ 0xCAFEBABEu;
        }
      }
      else if (state::pathIs(path, plen, "debug_show_axis"))     s_debug_show_axis     = state::patchFloat(i) != 0.0f;
    }

    if (state::pathIs(path, plen, "trigger") && s_refractory_remaining <= 0.0) {
      spawn_jet();
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Pack active jets, compute live head_x.
  double now = host::time();
  GpuJet gpu_jets[MAX_JETS] = {};
  int active_count = 0;
  int cap = s_pool_size;
  if (cap < 1) cap = 1;
  if (cap > MAX_JETS) cap = MAX_JETS;
  for (int i = 0; i < cap; i++) {
    const CpuJet& j = s_jets[i];
    if (!j.active) continue;
    float elapsed = (float)(now - j.start_time);
    float progress = j.transit_seconds > 1e-3f ? elapsed / j.transit_seconds : 1.0f;
    float head_x = (j.dir > 0.0f) ? progress : (1.0f - progress);
    GpuJet& g = gpu_jets[active_count++];
    g.head_x = head_x;
    g.dir = j.dir;
    g.centerline_y = j.centerline_y;
    g.transit_seconds = j.transit_seconds;
    g.color_seed = j.color_seed;
  }
  s_jet_buf.writeBytes(gpu_jets, (int)sizeof(GpuJet) * MAX_JETS);

  // Uniforms.
  float cone_rad = clampf(s_cone_half_angle_deg, 0.0f, 89.0f) * (3.14159265358979f / 180.0f);
  Uniforms u = {};
  u.intensity = clampf(s_intensity, 0.0f, 8.0f);
  u.head_width = clampf(s_head_width, 0.0f, 1.0f);
  u.cone_tan = std::tan(cone_rad);
  u.trail_length = clampf(s_trail_length, 0.001f, 4.0f);
  u.axial_decay_curve = clampf(s_axial_decay_curve, 0.05f, 8.0f);
  u.radial_sharpness = clampf(s_radial_sharpness, 0.5f, 32.0f);
  u.diamond_amp = clampf(s_diamond_amp, 0.0f, 1.0f);
  u.diamond_period = clampf(s_diamond_period, 0.001f, 1.0f);
  u.shimmer_phase = (float)(s_shimmer_phase - std::floor(s_shimmer_phase));
  u.turb_amp = clampf(s_turbulence_amp, 0.0f, 1.0f);
  u.turb_scale = clampf(s_turbulence_scale, 0.1f, 64.0f);
  u.turb_phase = (float)(s_turb_phase - std::floor(s_turb_phase));
  u.core_r = s_color_core_r; u.core_g = s_color_core_g; u.core_b = s_color_core_b;
  u.edge_r = s_color_edge_r; u.edge_g = s_color_edge_g; u.edge_b = s_color_edge_b;
  u.active_count = (uint32_t)active_count;
  u.debug_show_axis = s_debug_show_axis ? 1u : 0u;
  s_uniform_buf.writeOne(u);

  // Color pass.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.setBuffer(s_jet_buf,     3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Motion pass — skip when no downstream consumer.
  if (state::isOutputConnected("render_outputs")) {
    if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
      s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s_motion_w = vp_w;
      s_motion_h = vp_h;
      if (s_motion_tex.valid()) {
        state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
      }
    }
    if (s_motion_tex.valid()) {
      auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
      if (!upstream.valid()) {
        if (!s_zero_motion_tex.valid()) {
          s_zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
        }
        upstream = s_zero_motion_tex;
      }
      if (upstream.valid()) {
        auto cp = gpu::ComputePass::begin();
        cp.setPSO(s_pso_motion);
        cp.setTexture(upstream,     0, 0);
        cp.setTexture(s_motion_tex, 1, 1);
        cp.setBuffer(s_uniform_buf, 2);
        cp.setBuffer(s_jet_buf,     3);
        cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
        cp.end();
      }
    }
  }

  gpu::Device::submit();
}

} // namespace side_jet
