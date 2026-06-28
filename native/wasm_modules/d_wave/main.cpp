/*
 * warp.legacy.d_wave — "D Wave" radial-ripple distortion field.
 *
 * A focused v2 port of the only block of the shipped NanoGraph "Darkburst" the
 * team actually used live: its distortion field ("D wave"). The rest of
 * Darkburst (the bursting star system, glowing core, laser-line output) is
 * dropped — per the catalogue, everything except the D wave was rarely used.
 *
 * Mechanism (see field.hlsl / warp.hlsl): a persistent polar buffer
 * (angle × radius) in which ripples are stochastically spawned at the centre,
 * march outward in radius over time, and decay. Each output pixel reads the
 * buffer in polar space and is radially displaced by the local strength,
 * giving concentric expanding distortion arcs. A trigger fires a full-circle
 * shock ripple (the original drove rate/speed from an audio envelope).
 *
 * Two passes/frame, both compute:
 *   1. field  (ping-pong) — propagate + decay the previous buffer, spawn fresh
 *               ripples. Writes an RGBA16F polar buffer (.r only).
 *   2. warp   — polar lookup + radial UV warp + composite over the input.
 *
 * Stateful (feedback buffer) but self-clearing as ripples expire → seekable
 * only approximately.
 */

#include <gpu.h>
#include <host.h>
#include "d_wave_shaders.h"

#include <cmath>
#include <cstdint>

namespace d_wave {

// Polar buffer resolution. Independent of viewport: angle columns × radius rows.
static constexpr int   ANG = 512;
static constexpr int   RAD = 256;
static constexpr float PI  = 3.14159265358979323846f;

// Tuning constants behind the normalized sliders.
static constexpr float SPEED_ROWS_PER_SEC = 600.0f;  // wave_speed=1 → rows/sec
static constexpr float DECAY_MAX          = 4.0f;    // wave_decay=1 → e-folds/sec
static constexpr float SHARP_MIN          = 3.0f;    // soften=1 → wide ring
static constexpr float SHARP_MAX          = 60.0f;   // soften=0 → tight ring
static constexpr float MAX_CELLS          = 47.0f;   // density=1 → 48 noise cells
static constexpr float BURST_TAU          = 0.18f;   // trigger-burst envelope half-life (s)

struct FieldUniforms {
  float y_shift, decay, rate, sharp;
  float ang_cells, noise_power, burst;
  uint32_t frame;
};
struct WarpUniforms {
  float aspect, distortion, scale, squeeze;
  float render_alpha, debug_field, center_x, center_y;
};

struct State {
  gpu::Texture field[2];          // ping-pong polar buffers (RGBA16F)
  int   cur = 0;                  // index of the buffer holding the latest field
  bool  cleared = false;

  gpu::Buffer  field_uniform;
  gpu::Buffer  warp_uniform;
  gpu::Sampler samp_field;        // Linear + Repeat (angle wrap)
  gpu::Sampler samp_in;          // Linear + ClampToEdge
  bool initialized = false;

  // CPU mirrors of schema params.
  float distortion = 0.5f;
  float rate       = 0.5f;
  float wave_speed = 0.3f;
  float scale      = 1.0f;
  float density    = 0.3f;
  // Tuning
  float wave_decay = 0.5f;
  float soften     = 0.5f;
  float grain      = 0.43f;      // grain contrast (→ noise power curve)
  float squeeze    = 0.0f;
  float render_alpha = 1.0f;
  float center_x   = 0.0f;       // cover-square anchor
  float center_y   = 0.0f;
  // Trigger
  float burst_strength = 1.0f;
  bool  gate_prev = false;
  bool  trigger_prev = false;
  // Debug
  float debug_field = 0.0f;

  // Per-frame, set in tick().
  float    dt = 1.0f / 60.0f;
  uint32_t frame = 0;
  float    burst_env = 0.0f;     // decaying trigger envelope → tapering pulse train
};

static gpu::ComputePSO s_pso_field;
static gpu::ComputePSO s_pso_warp;

void module_init() {
  state::init("warp.legacy.d_wave", {1, 0, 4},
    state::Schema()
      // ---- Standard ---- (floatField: name,def,min,max,io,magnitude,step,units,description)
      .floatField("distortion",  0.5f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Radial warp magnitude.")
      .floatField("rate",        0.5f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Noise density: fraction of angles emitting grain.")
      .floatField("wave_speed",  0.3f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How fast the grain streaks outward.")
      .floatField("scale",       1.0f,  0.1f, 4.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Spatial size of the ripple field.")
      .floatField("density",     0.3f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Grain frequency around the circle.")
      .boolField ("gate",        false, state::PrimaryInput,
                  "Rising edge fires a full-circle shock ripple.")
      .eventField("trigger",     state::PrimaryInput)
      // ---- Tuning ----
      .floatField("wave_decay",  0.5f,  0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "How fast ripples fade as they travel.")
      .floatField("soften",      0.5f,  0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Radial thickness/softness of each ring.")
      .floatField("grain",       0.43f, 0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Grain contrast: low = soft dense haze, high = sparse sparkle.")
      .floatField("squeeze",     0.0f, -1.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Radial offset of the ring pattern.")
      .floatField("render_alpha", 1.0f, 0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Opacity of the distorted layer over the input.")
      .floatField("burst_strength", 1.0f, 0.0f, 4.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Amplitude of a triggered shock ripple.")
      .vec2Field ("center",      0.0f, 0.0f, state::SecondaryInput, -1.0f, 1.0f)
      // ---- Debug ----
      .floatField("debug_field",  0.0f, 0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Overlay the raw ripple field.")
      // ---- I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // The field pass writes an RGBA16F storage texture → override naga's default
  // rgba32float (warp writes the default rgba8unorm tex_out, no override).
  state::registerShaderSPV("dw_field", FIELD_SPV, FIELD_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("dw_warp",  WARP_SPV,  WARP_SPV_SIZE);

  auto cs_field = gpu::Device::createShaderModuleByName("dw_field");
  auto cs_warp  = gpu::Device::createShaderModuleByName("dw_warp");
  if (!cs_field || !cs_warp) return;

  s_pso_field = gpu::Device::createComputePSO(cs_field, "main", gpu::Bindings()
      .tex2d(0).sampler(1).storageTex2d(2, gpu::TextureFormat::RGBA16F).uniform(3));
  s_pso_warp = gpu::Device::createComputePSO(cs_warp, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).sampler(2).sampler(3).storageTex2d(4, gpu::TextureFormat::RGBA8).uniform(5));

  state::log("d_wave: module initialized");
}

void* create() {
  auto* s = new State();
  s->field[0] = gpu::Device::createTexture(ANG, RAD, gpu::TextureFormat::RGBA16F);
  s->field[1] = gpu::Device::createTexture(ANG, RAD, gpu::TextureFormat::RGBA16F);
  s->field_uniform = gpu::Device::createBuffer(sizeof(FieldUniforms), gpu::BufferUsage::Uniform);
  s->warp_uniform  = gpu::Device::createBuffer(sizeof(WarpUniforms), gpu::BufferUsage::Uniform);
  s->samp_field = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::Repeat);
  s->samp_in    = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->field[0].release();
  s->field[1].release();
  s->field_uniform.release();
  s->warp_uniform.release();
  s->samp_field.release();
  s->samp_in.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_field.valid() || !s_pso_warp.valid()) return;
  s->cleared = false;
  s->cur = 0;
  s->frame = 0;
  s->burst_env = 0.0f;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->dt = (float)dt;
  s->frame++;
  // Decay the trigger burst → a tapering train of pulses. wave_decay then fades
  // each emitted ring further as it travels outward (so a higher wave_decay
  // tails off faster, as observed).
  s->burst_env *= std::exp(-(float)dt / BURST_TAU);
  if (s->burst_env < 1e-3f) s->burst_env = 0.0f;
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
    if      (state::pathIs(p, l, "distortion"))    s->distortion = state::patchFloat(i);
    else if (state::pathIs(p, l, "rate"))          s->rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "wave_speed"))    s->wave_speed = state::patchFloat(i);
    else if (state::pathIs(p, l, "scale"))         s->scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "density"))       s->density = state::patchFloat(i);
    else if (state::pathIs(p, l, "wave_decay"))    s->wave_decay = state::patchFloat(i);
    else if (state::pathIs(p, l, "soften"))        s->soften = state::patchFloat(i);
    else if (state::pathIs(p, l, "grain"))         s->grain = state::patchFloat(i);
    else if (state::pathIs(p, l, "squeeze"))       s->squeeze = state::patchFloat(i);
    else if (state::pathIs(p, l, "render_alpha"))  s->render_alpha = state::patchFloat(i);
    else if (state::pathIs(p, l, "burst_strength")) s->burst_strength = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_field"))   s->debug_field = state::patchFloat(i);
    else if (state::pathIs(p, l, "center"))        { auto v = state::patchVec2(i); s->center_x = v.x; s->center_y = v.y; }
    else if (state::pathIs(p, l, "gate")) {
      bool g = state::patchBool(i);
      if (g && !s->gate_prev) s->burst_env = 1.0f;   // rising edge → fire burst
      s->gate_prev = g;
    }
    else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchFloat(i) != 0.0f;
      if (t && !s->trigger_prev) s->burst_env = 1.0f; // rising edge → fire burst
      s->trigger_prev = t;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  if (!s->field[0].valid() || !s->field[1].valid()) return;

  // Clear both polar buffers once (createTexture isn't zero-guaranteed).
  if (!s->cleared) {
    gpu::Device::clear(s->field[0], 0.f, 0.f, 0.f, 0.f);
    gpu::Device::clear(s->field[1], 0.f, 0.f, 0.f, 0.f);
    s->cleared = true;
  }

  float dt = s->dt;

  // --- Field uniforms (dt-baked → frame-rate independent) ---
  FieldUniforms fu = {};
  fu.y_shift   = (s->wave_speed * SPEED_ROWS_PER_SEC * dt) / float(RAD);
  fu.decay     = std::exp(-s->wave_decay * DECAY_MAX * dt);
  fu.rate      = s->rate;     // direct threshold: fraction of angular cells injecting
  fu.sharp     = SHARP_MAX + (SHARP_MIN - SHARP_MAX) * s->soften;
  fu.ang_cells   = std::round(1.0f + s->density * MAX_CELLS);
  fu.noise_power = 0.5f + s->grain * 3.5f;   // grain 0→soft(0.5)  1→sparse(4.0)
  fu.burst       = s->burst_env * s->burst_strength;
  fu.frame     = s->frame;
  s->field_uniform.writeOne(fu);

  int rd = s->cur, wr = s->cur ^ 1;

  // Pass 1 — field update (prev → cur).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_field);
    cp.setTexture(s->field[rd], 0, 0);
    cp.setSampler(s->samp_field, 1);
    cp.setTexture(s->field[wr], 2, 1);
    cp.setBuffer(s->field_uniform, 3);
    cp.dispatch((ANG + 7) / 8, (RAD + 7) / 8);
    cp.end();
  }

  // --- Warp uniforms ---
  // Cover-square anchor → uv offset (half-extent = 0.5 · maxDim / dim).
  float maxDim = float(vp_w > vp_h ? vp_w : vp_h);
  WarpUniforms wu = {};
  wu.aspect       = float(vp_w) / float(vp_h);
  wu.distortion   = s->distortion;
  wu.scale        = s->scale;
  wu.squeeze      = s->squeeze;
  wu.render_alpha = s->render_alpha;
  wu.debug_field  = s->debug_field;
  wu.center_x     = s->center_x * (0.5f * maxDim / float(vp_w));
  wu.center_y     = s->center_y * (0.5f * maxDim / float(vp_h));
  s->warp_uniform.writeOne(wu);

  // Pass 2 — warp + composite (reads the freshly written buffer).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_warp);
    cp.setTexture(in, 0, 0);
    cp.setTexture(s->field[wr], 1, 1);
    cp.setSampler(s->samp_in, 2);
    cp.setSampler(s->samp_field, 3);
    cp.setTexture(out, 4, 1);
    cp.setBuffer(s->warp_uniform, 5);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  s->cur = wr;   // cur now holds the latest field
  gpu::Device::submit();
}

} // namespace d_wave
