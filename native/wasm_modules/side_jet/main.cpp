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
 *
 * Class-like instance model: module_init() compiles the two shared
 * compute PSOs + publishes the schema once per type; each chain entry
 * gets its own State (params, jet pool, per-instance buffers/textures)
 * via create(). All instance callbacks take `self`.
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

// Per-instance state. One per chain entry.
struct State {
  // --- GPU resources (per-instance) ---
  gpu::Buffer     uniform_buf;
  gpu::Buffer     jet_buf;
  gpu::Texture    motion_tex;
  gpu::Texture    zero_motion_tex;
  int             motion_w = 0;
  int             motion_h = 0;
  bool            initialized = false;

  // --- Schema-mirrored params (standard) ---
  bool  gate                  = false;
  float auto_rate             = 0.2f;
  float transit_seconds       = 0.4f;
  int   direction             = DIR_RANDOM;
  float centerline_y          = 0.5f;
  float centerline_y_jitter   = 0.1f;
  float color_core_r          = 1.00f;
  float color_core_g          = 0.95f;
  float color_core_b          = 0.85f;
  float color_edge_r          = 0.40f;
  float color_edge_g          = 0.60f;
  float color_edge_b          = 1.00f;
  float intensity             = 1.0f;
  // --- Tuning shape ---
  float head_width            = 0.015f;
  float cone_half_angle_deg   = 8.0f;
  float trail_length          = 0.6f;
  float axial_decay_curve     = 2.0f;
  float radial_sharpness      = 4.0f;
  // --- Tuning evolution ---
  float diamond_amp           = 0.5f;
  float diamond_period        = 0.05f;
  float diamond_shimmer_rate_hz = 10.0f;
  float turbulence_amp        = 0.3f;
  float turbulence_scale      = 12.0f;
  float turbulence_rate_hz    = 8.0f;
  // --- Tuning pool ---
  int   pool_size             = 4;
  int   seed                  = 0x10A11;
  // --- Debug ---
  bool  debug_show_axis       = false;

  // --- Runtime ---
  CpuJet  jets[MAX_JETS];
  double  shimmer_phase = 0.0;       // accumulator (§2.1)
  double  turb_phase    = 0.0;       // accumulator (§2.1)
  // gate (bool) and trigger (event) are momentary in the IDE — value is 1
  // while held, 0 on release, replayed every frame (style guide §8.2). Both
  // spawn only on a 0→1 rising edge; firing on patch presence would spawn a
  // jet every frame and saturate the pool.
  bool    gate_prev     = false;
  float   trigger_prev  = 0.0f;
  uint32_t spawn_rng    = 0xB16B00B5u;
  uint32_t autotrigger_rng = 0xCAFEBABEu;
};

// --- Type-shared GPU resources: compiled once in module_init(). ---
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;

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

static void spawn_jet(State& s) {
  int slot = -1;
  int cap = s.pool_size;
  if (cap < 1) cap = 1;
  if (cap > MAX_JETS) cap = MAX_JETS;
  for (int i = 0; i < cap; i++) {
    if (!s.jets[i].active) { slot = i; break; }
  }
  if (slot < 0) return;        // pool full — drop the trigger

  CpuJet& j = s.jets[slot];
  j.active = true;
  j.start_time = host::time();
  // Direction.
  float dir = +1.0f;
  if (s.direction == DIR_LtoR) dir = +1.0f;
  else if (s.direction == DIR_RtoL) dir = -1.0f;
  else dir = (lcg_unit(s.spawn_rng) < 0.5f) ? +1.0f : -1.0f;
  j.dir = dir;
  // Centerline (with jitter).
  float jitter = lcg_signed(s.spawn_rng) * clampf(s.centerline_y_jitter, 0.0f, 0.5f);
  j.centerline_y = clampf(s.centerline_y + jitter, 0.0f, 1.0f);
  j.color_seed = lcg_unit(s.spawn_rng);
  j.transit_seconds = clampf(s.transit_seconds, 0.01f, 10.0f);
}

// Type-level setup: schema + the two shared compute PSOs. Once per type.
void module_init() {
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

  state::log("side_jet: module initialized");
}

// Per-instance construction: allocate State + its own GPU buffers.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->jet_buf     = gpu::Device::createBuffer(sizeof(GpuJet) * MAX_JETS, gpu::BufferUsage::Storage);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->jet_buf.release();
  s->motion_tex.release();
  s->zero_motion_tex.release();
  delete s;
}

// Per-instance init tail: reset runtime state + mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  s->gate = false; s->gate_prev = false;
  s->trigger_prev = 0.0f;
  s->shimmer_phase = 0.0; s->turb_phase = 0.0;
  s->spawn_rng = (uint32_t)s->seed ^ 0xB16B00B5u;
  s->autotrigger_rng = (uint32_t)s->seed ^ 0xCAFEBABEu;
  for (int i = 0; i < MAX_JETS; i++) {
    s->jets[i].active = false;
    s->jets[i].start_time = 0.0;
    s->jets[i].dir = 1.0f;
    s->jets[i].centerline_y = 0.5f;
    s->jets[i].color_seed = 0.0f;
    s->jets[i].transit_seconds = 0.4f;
  }
  s->motion_w = 0; s->motion_h = 0;

  if (!s_pso_color.valid() || !s_pso_motion.valid()) return;
  s->initialized = true;
  state::log("side_jet: initialized");
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized) return;

  // Phase accumulators (§2.1 — never elapsed*rate).
  if (s->diamond_shimmer_rate_hz > 0.0f) {
    s->shimmer_phase += dt * (double)s->diamond_shimmer_rate_hz;
    if (s->shimmer_phase > 1024.0) s->shimmer_phase -= std::floor(s->shimmer_phase);
  }
  if (s->turbulence_rate_hz > 0.0f) {
    s->turb_phase += dt * (double)s->turbulence_rate_hz;
    if (s->turb_phase > 1024.0) s->turb_phase -= std::floor(s->turb_phase);
  }

  // Poisson auto-trigger.
  if (s->auto_rate > 0.0f) {
    float rate_hz = std::pow(60.0f, s->auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      float lambda = rate_hz * (float)dt;
      float u = lcg_unit(s->autotrigger_rng);
      if (u < 1.0f - std::exp(-lambda)) spawn_jet(*s);
    }
  }

  // Cull jets that have cleared the opposite edge by `trail_length`.
  double now = host::time();
  int cap = s->pool_size;
  if (cap < 1) cap = 1;
  if (cap > MAX_JETS) cap = MAX_JETS;
  for (int i = 0; i < cap; i++) {
    CpuJet& j = s->jets[i];
    if (!j.active) continue;
    float elapsed = (float)(now - j.start_time);
    float progress = j.transit_seconds > 1e-3f ? elapsed / j.transit_seconds : 1.0f;
    float head_x = (j.dir > 0.0f) ? progress : (1.0f - progress);
    bool dead = (j.dir > 0.0f)
        ? (head_x > 1.0f + s->trail_length)
        : (head_x < -s->trail_length);
    if (dead) j.active = false;
  }
  for (int i = cap; i < MAX_JETS; i++) s->jets[i].active = false;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (op == state::PatchReplace) {
      if (state::pathIs(path, plen, "gate")) {
        bool new_gate = state::patchFloat(i) != 0.0f;
        if (new_gate && !s->gate_prev) spawn_jet(*s);
        s->gate = new_gate;
        s->gate_prev = new_gate;
      }
      else if (state::pathIs(path, plen, "trigger")) {
        // Momentary event value (1 held / 0 released), replayed every
        // frame — spawn only on the 0→1 rising edge, exactly like gate.
        float v = state::patchFloat(i);
        if (v != 0.0f && s->trigger_prev == 0.0f) spawn_jet(*s);
        s->trigger_prev = v;
      }
      else if (state::pathIs(path, plen, "auto_rate"))           s->auto_rate           = state::patchFloat(i);
      else if (state::pathIs(path, plen, "transit_seconds"))     s->transit_seconds     = state::patchFloat(i);
      else if (state::pathIs(path, plen, "direction"))           s->direction           = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "centerline_y"))        s->centerline_y        = state::patchFloat(i);
      else if (state::pathIs(path, plen, "centerline_y_jitter")) s->centerline_y_jitter = state::patchFloat(i);
      else if (state::pathIs(path, plen, "color_core")) {
        auto v = state::patchVec3(i);
        s->color_core_r = v.x; s->color_core_g = v.y; s->color_core_b = v.z;
      }
      else if (state::pathIs(path, plen, "color_edge")) {
        auto v = state::patchVec3(i);
        s->color_edge_r = v.x; s->color_edge_g = v.y; s->color_edge_b = v.z;
      }
      else if (state::pathIs(path, plen, "intensity"))           s->intensity           = state::patchFloat(i);
      else if (state::pathIs(path, plen, "head_width"))          s->head_width          = state::patchFloat(i);
      else if (state::pathIs(path, plen, "cone_half_angle_deg")) s->cone_half_angle_deg = state::patchFloat(i);
      else if (state::pathIs(path, plen, "trail_length"))        s->trail_length        = state::patchFloat(i);
      else if (state::pathIs(path, plen, "axial_decay_curve"))   s->axial_decay_curve   = state::patchFloat(i);
      else if (state::pathIs(path, plen, "radial_sharpness"))    s->radial_sharpness    = state::patchFloat(i);
      else if (state::pathIs(path, plen, "diamond_amp"))         s->diamond_amp         = state::patchFloat(i);
      else if (state::pathIs(path, plen, "diamond_period"))      s->diamond_period      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "diamond_shimmer_rate_hz")) s->diamond_shimmer_rate_hz = state::patchFloat(i);
      else if (state::pathIs(path, plen, "turbulence_amp"))      s->turbulence_amp      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "turbulence_scale"))    s->turbulence_scale    = state::patchFloat(i);
      else if (state::pathIs(path, plen, "turbulence_rate_hz"))  s->turbulence_rate_hz  = state::patchFloat(i);
      else if (state::pathIs(path, plen, "pool_size"))           s->pool_size           = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "seed")) {
        int v = (int)state::patchFloat(i);
        if (v != s->seed) {
          s->seed = v;
          s->spawn_rng = (uint32_t)v ^ 0xB16B00B5u;
          s->autotrigger_rng = (uint32_t)v ^ 0xCAFEBABEu;
        }
      }
      else if (state::pathIs(path, plen, "debug_show_axis"))     s->debug_show_axis     = state::patchFloat(i) != 0.0f;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Pack active jets, compute live head_x.
  double now = host::time();
  GpuJet gpu_jets[MAX_JETS] = {};
  int active_count = 0;
  int cap = s->pool_size;
  if (cap < 1) cap = 1;
  if (cap > MAX_JETS) cap = MAX_JETS;
  for (int i = 0; i < cap; i++) {
    const CpuJet& j = s->jets[i];
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
  s->jet_buf.writeBytes(gpu_jets, (int)sizeof(GpuJet) * MAX_JETS);

  // Uniforms.
  float cone_rad = clampf(s->cone_half_angle_deg, 0.0f, 89.0f) * (3.14159265358979f / 180.0f);
  Uniforms u = {};
  u.intensity = clampf(s->intensity, 0.0f, 8.0f);
  u.head_width = clampf(s->head_width, 0.0f, 1.0f);
  u.cone_tan = std::tan(cone_rad);
  u.trail_length = clampf(s->trail_length, 0.001f, 4.0f);
  u.axial_decay_curve = clampf(s->axial_decay_curve, 0.05f, 8.0f);
  u.radial_sharpness = clampf(s->radial_sharpness, 0.5f, 32.0f);
  u.diamond_amp = clampf(s->diamond_amp, 0.0f, 1.0f);
  u.diamond_period = clampf(s->diamond_period, 0.001f, 1.0f);
  u.shimmer_phase = (float)(s->shimmer_phase - std::floor(s->shimmer_phase));
  u.turb_amp = clampf(s->turbulence_amp, 0.0f, 1.0f);
  u.turb_scale = clampf(s->turbulence_scale, 0.1f, 64.0f);
  u.turb_phase = (float)(s->turb_phase - std::floor(s->turb_phase));
  u.core_r = s->color_core_r; u.core_g = s->color_core_g; u.core_b = s->color_core_b;
  u.edge_r = s->color_edge_r; u.edge_g = s->color_edge_g; u.edge_b = s->color_edge_b;
  u.active_count = (uint32_t)active_count;
  u.debug_show_axis = s->debug_show_axis ? 1u : 0u;
  s->uniform_buf.writeOne(u);

  // Color pass.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->uniform_buf, 2);
    cp.setBuffer(s->jet_buf,     3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Motion pass — skip when no downstream consumer.
  if (state::isOutputConnected("render_outputs")) {
    if (!s->motion_tex.valid() || s->motion_w != vp_w || s->motion_h != vp_h) {
      s->motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s->motion_w = vp_w;
      s->motion_h = vp_h;
      if (s->motion_tex.valid()) {
        state::setGpuTexture("render_outputs/motion", s->motion_tex.id);
      }
    }
    if (s->motion_tex.valid()) {
      auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
      if (!upstream.valid()) {
        if (!s->zero_motion_tex.valid()) {
          s->zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
        }
        upstream = s->zero_motion_tex;
      }
      if (upstream.valid()) {
        auto cp = gpu::ComputePass::begin();
        cp.setPSO(s_pso_motion);
        cp.setTexture(upstream,     0, 0);
        cp.setTexture(s->motion_tex, 1, 1);
        cp.setBuffer(s->uniform_buf, 2);
        cp.setBuffer(s->jet_buf,     3);
        cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
        cp.end();
      }
    }
  }

  gpu::Device::submit();
}

void on_resolume_param(void* self, long long param_id, double value) {}

} // namespace side_jet
