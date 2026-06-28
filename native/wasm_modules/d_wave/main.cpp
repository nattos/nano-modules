/*
 * warp.legacy.d_wave — "D Wave" radial-ripple distortion field.
 *
 * A focused v2 port of the only block of the shipped NanoGraph "Darkburst" the
 * team actually used live: its distortion field ("D wave"). The rest of
 * Darkburst (the bursting star system, glowing core, laser-line output) is
 * dropped — per the catalogue, everything except the D wave was rarely used.
 *
 * The wave field is a polar buffer (angle × radius) built each frame from a pool
 * of N "wave particles": each particle is a thin, radially-elongated blob that
 * drifts OUTWARD (increasing radius) by forward time integration, with a
 * staggered phase and per-particle speed. When it reaches the rim it loops back
 * to the centre and respawns at a fresh angle with jittered size/strength. This
 * breaks the field up temporally — the waves are organic and desynchronised
 * rather than perfectly concentric. Each output pixel reads the field in polar
 * space and is radially displaced by the local strength. A trigger resets every
 * particle to the centre at once → a synchronised shock wave that then desyncs.
 *
 * Passes/frame:
 *   1. particles (compute) — seed / forward-integrate / loop+respawn the pool.
 *   2. blobs     (instanced render, additive) — splat the pool into the RGBA16F
 *                 polar field (cleared first; the texture is a pure function of
 *                 the current particle positions — the integration lives in the
 *                 pool, not the texture).
 *   3. warp      (compute) — polar lookup + radial UV warp + composite.
 *
 * Stateful (particle pool) but self-recycling → seekable only approximately.
 */

#include <gpu.h>
#include <host.h>
#include "d_wave_shaders.h"

#include <cmath>
#include <cstdint>

namespace d_wave {

// Polar field resolution. Independent of viewport: angle columns × radius rows.
static constexpr int   ANG = 512;
static constexpr int   RAD = 256;
static constexpr int   MAX_PARTICLES = 4096;

// Tuning constants behind the normalized sliders.
static constexpr float SPEED_SCALE = 2.0f;    // wave_speed=1 → radius units/sec
static constexpr float AW_WIDE     = 0.045f;  // density=0 → angular half-width
static constexpr float AW_THIN     = 0.004f;  // density=1 → angular half-width
static constexpr float LEN_MIN     = 0.04f;   // soften=0 → radial half-length
static constexpr float LEN_MAX     = 0.24f;   // soften=1 → radial half-length

struct ParticleUniforms {
  uint32_t count, frame, seed, pulse;
  float dt, speed, spread, _p;
};
struct BlobUniforms {
  uint32_t count;
  float ang_halfwidth, rad_halflen, decay;
  float grain, _a, _b, _c;
};
struct WarpUniforms {
  float aspect, distortion, scale, squeeze;
  float render_alpha, debug_field, center_x, center_y;
};

struct State {
  gpu::Texture field;             // polar field (RGBA16F), rebuilt each frame
  gpu::Buffer  particle_buf;      // pool of MAX_PARTICLES × float4
  gpu::Buffer  particle_uniform;
  gpu::Buffer  blob_uniform;
  gpu::Buffer  warp_uniform;
  gpu::Sampler samp_field;        // Linear + Repeat (angle wrap)
  gpu::Sampler samp_in;          // Linear + ClampToEdge
  bool initialized = false;
  bool seeded      = false;

  // CPU mirrors of schema params.
  float distortion = 0.5f;
  int   count      = 256;
  float wave_speed = 0.3f;
  float scale      = 1.0f;
  float density    = 0.3f;
  // Tuning
  float spread     = 0.5f;       // per-particle speed variation (temporal break-up)
  float wave_decay = 0.5f;       // fade toward the rim
  float soften     = 0.5f;       // radial blob length
  float grain      = 0.43f;      // per-particle strength jitter
  float squeeze    = 0.0f;
  float render_alpha = 1.0f;
  float center_x   = 0.0f;       // cover-square anchor
  float center_y   = 0.0f;
  // Debug
  float debug_field = 0.0f;

  // Trigger.
  bool  gate_prev = false;
  bool  trigger_prev = false;
  bool  pulse_pending = false;

  // Per-frame, set in tick().
  float    dt = 1.0f / 60.0f;
  uint32_t frame = 0;
};

static gpu::ComputePSO s_pso_particles;
static gpu::RenderPSO  s_pso_blob;
static gpu::ComputePSO s_pso_warp;

void module_init() {
  state::init("warp.legacy.d_wave", {1, 1, 0},
    state::Schema()
      // ---- Standard ---- (floatField: name,def,min,max,io,magnitude,step,units,description)
      .floatField("distortion",  0.5f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Radial warp magnitude.")
      .intField  ("count",       256,   1,    MAX_PARTICLES, state::PrimaryInput)
      .floatField("wave_speed",  0.3f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "How fast the waves drift outward.")
      .floatField("scale",       1.0f,  0.1f, 4.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Spatial size of the wave field.")
      .floatField("density",     0.3f,  0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f, nullptr,
                  "Angular thinness of each wave streak.")
      .boolField ("gate",        false, state::PrimaryInput,
                  "Rising edge fires a synchronised shock wave.")
      .eventField("trigger",     state::PrimaryInput)
      // ---- Tuning ----
      .floatField("spread",      0.5f,  0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Per-wave speed variation — breaks the waves up temporally.")
      .floatField("wave_decay",  0.5f,  0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "How much the waves fade as they reach the rim.")
      .floatField("soften",      0.5f,  0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Radial length of each wave streak.")
      .floatField("grain",       0.43f, 0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Per-wave strength jitter: low = even, high = sparkly.")
      .floatField("squeeze",     0.0f, -1.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Radial offset of the wave pattern.")
      .floatField("render_alpha", 1.0f, 0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Opacity of the distorted layer over the input.")
      .vec2Field ("center",      0.0f, 0.0f, state::SecondaryInput, -1.0f, 1.0f)
      // ---- Debug ----
      .floatField("debug_field",  0.0f, 0.0f, 1.0f, state::SecondaryInput, nullptr, 0.01f, nullptr,
                  "Overlay the raw wave field.")
      // ---- I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("dw_particles", PARTICLES_SPV, PARTICLES_SPV_SIZE);
  state::registerShaderSPV("dw_blob_vs",   BLOB_VS_SPV,   BLOB_VS_SPV_SIZE);
  state::registerShaderSPV("dw_blob_fs",   BLOB_FS_SPV,   BLOB_FS_SPV_SIZE);
  state::registerShaderSPV("dw_warp",      WARP_SPV,      WARP_SPV_SIZE);

  auto cs_particles = gpu::Device::createShaderModuleByName("dw_particles");
  auto vs_blob      = gpu::Device::createShaderModuleByName("dw_blob_vs");
  auto fs_blob      = gpu::Device::createShaderModuleByName("dw_blob_fs");
  auto cs_warp      = gpu::Device::createShaderModuleByName("dw_warp");
  if (!cs_particles || !vs_blob || !fs_blob || !cs_warp) return;

  s_pso_particles = gpu::Device::createComputePSO(cs_particles, "main", gpu::Bindings()
      .storageRW(0).uniform(1));
  // Blobs splat additively into the RGBA16F polar field.
  s_pso_blob = gpu::Device::createInstancedRenderPSO(
      vs_blob, "main", fs_blob, "main",
      gpu::TextureFormat::RGBA16F,
      gpu::Bindings().storage(0).uniform(1),
      gpu::Device::BlendMode::Additive);
  // warp writes the default rgba8unorm tex_out (no format override).
  s_pso_warp = gpu::Device::createComputePSO(cs_warp, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).sampler(2).sampler(3).storageTex2d(4, gpu::TextureFormat::RGBA8).uniform(5));

  state::log("d_wave: module initialized");
}

void* create() {
  auto* s = new State();
  s->field = gpu::Device::createTexture(ANG, RAD, gpu::TextureFormat::RGBA16F);
  s->particle_buf = gpu::Device::createBuffer(MAX_PARTICLES * 4 * sizeof(float), gpu::BufferUsage::Storage);
  s->particle_uniform = gpu::Device::createBuffer(sizeof(ParticleUniforms), gpu::BufferUsage::Uniform);
  s->blob_uniform = gpu::Device::createBuffer(sizeof(BlobUniforms), gpu::BufferUsage::Uniform);
  s->warp_uniform = gpu::Device::createBuffer(sizeof(WarpUniforms), gpu::BufferUsage::Uniform);
  s->samp_field = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::Repeat);
  s->samp_in    = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->field.release();
  s->particle_buf.release();
  s->particle_uniform.release();
  s->blob_uniform.release();
  s->warp_uniform.release();
  s->samp_field.release();
  s->samp_in.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_particles.valid() || !s_pso_blob.valid() || !s_pso_warp.valid()) return;
  s->seeded = false;
  s->frame = 0;
  s->pulse_pending = false;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->dt = (float)dt;
  s->frame++;
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
    else if (state::pathIs(p, l, "count"))         s->count = state::patchInt(i);
    else if (state::pathIs(p, l, "wave_speed"))    s->wave_speed = state::patchFloat(i);
    else if (state::pathIs(p, l, "scale"))         s->scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "density"))       s->density = state::patchFloat(i);
    else if (state::pathIs(p, l, "spread"))        s->spread = state::patchFloat(i);
    else if (state::pathIs(p, l, "wave_decay"))    s->wave_decay = state::patchFloat(i);
    else if (state::pathIs(p, l, "soften"))        s->soften = state::patchFloat(i);
    else if (state::pathIs(p, l, "grain"))         s->grain = state::patchFloat(i);
    else if (state::pathIs(p, l, "squeeze"))       s->squeeze = state::patchFloat(i);
    else if (state::pathIs(p, l, "render_alpha"))  s->render_alpha = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_field"))   s->debug_field = state::patchFloat(i);
    else if (state::pathIs(p, l, "center"))        { auto v = state::patchVec2(i); s->center_x = v.x; s->center_y = v.y; }
    else if (state::pathIs(p, l, "gate")) {
      bool g = state::patchBool(i);
      if (g && !s->gate_prev) s->pulse_pending = true;   // rising edge → shock wave
      s->gate_prev = g;
    }
    else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchFloat(i) != 0.0f;
      if (t && !s->trigger_prev) s->pulse_pending = true; // rising edge → shock wave
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
  if (!s->field.valid() || !s->particle_buf.valid()) return;

  int count = s->count;
  if (count < 1) count = 1;
  if (count > MAX_PARTICLES) count = MAX_PARTICLES;
  float dt = s->dt;

  // --- Pass 1: particle pool (seed once, then forward-integrate + recycle) ---
  ParticleUniforms pu = {};
  pu.count  = (uint32_t)count;
  pu.frame  = s->frame;
  pu.seed   = s->seeded ? 0u : 1u;
  pu.pulse  = s->pulse_pending ? 1u : 0u;
  pu.dt     = dt;
  pu.speed  = s->wave_speed * SPEED_SCALE;
  pu.spread = s->spread;
  s->particle_uniform.writeOne(pu);
  s->seeded = true;
  s->pulse_pending = false;
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_particles);
    cp.setBuffer(s->particle_buf, 0);
    cp.setBuffer(s->particle_uniform, 1);
    cp.dispatch((MAX_PARTICLES + 63) / 64);   // seed covers the whole pool
    cp.end();
  }

  // --- Pass 2: splat the pool as elongated blobs into the polar field ---
  BlobUniforms bu = {};
  bu.count         = (uint32_t)count;
  bu.ang_halfwidth = AW_WIDE + (AW_THIN - AW_WIDE) * s->density;
  bu.rad_halflen   = LEN_MIN + (LEN_MAX - LEN_MIN) * s->soften;
  bu.decay         = s->wave_decay;
  bu.grain         = s->grain;
  s->blob_uniform.writeOne(bu);
  gpu::Device::clear(s->field, 0.f, 0.f, 0.f, 0.f);
  {
    auto rp = gpu::RenderPass::beginLoad(s->field);
    rp.setPSO(s_pso_blob);
    rp.setBuffer(s->particle_buf, 0);
    rp.setBuffer(s->blob_uniform, 1);
    rp.draw(6, count);
    rp.end();
  }

  // --- Pass 3: warp + composite ---
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
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_warp);
    cp.setTexture(in, 0, 0);
    cp.setTexture(s->field, 1, 0);
    cp.setSampler(s->samp_in, 2);
    cp.setSampler(s->samp_field, 3);
    cp.setTexture(out, 4, 1);
    cp.setBuffer(s->warp_uniform, 5);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace d_wave
