/*
 * source.particles.sweep_chamber — swept-luma capture/release particle+line sim.
 *
 * Successor to source.legacy.double_chamber, rebuilt on flow_swarm's modern
 * structure. A built-in luma SWEEP (band-pass window over the input's luma)
 * "captures" one level of the image at a time; a coarse per-frame field
 * texture pair carries everything the sim needs:
 *   field_a — swept luma L' (mean + max + intra-cell peak offset)
 *   field_b — curl-noise background velocity + swept-image gradient
 * Particles and line tracers sample the field with single bilinear taps —
 * no full-res convolutions in any per-particle/per-step loop (the old
 * effect's cost). At either end of the sweep the window captures nothing,
 * the image reads as black, and everything free-flows on the noise field;
 * mid-sweep, particles and lines catch onto the captured band, then get
 * flung on release.
 *
 * Pipeline (grows by milestone; currently M1 skeleton):
 *   1. field_b (compute) — curl-noise velocity + ∇L' from field_a.
 *   2. p_update (compute) — substepped advection / age / respawn.
 *   3. prefill (compute) — tex_in × input_alpha → tex_out (or clear).
 *   4. raster  (instanced) — 6 verts × count quads, additive/alpha-over.
 */

#include <gpu.h>
#include <host.h>
#include "sweep_chamber_shaders.h"

#include <cstdint>
#include <cstring>

namespace sweep_chamber {

// 1M particles × 32 bytes = 32 MB. Pool pre-sized so `count` dials freely.
static constexpr int MAX_PARTICLES = 1000000;

// Quadratic size mapping (flow_swarm parity): schema `size` is a [0,1]
// slider; on-GPU size = SIZE_SCALE · slider².
static constexpr float SIZE_SCALE = 0.035f;
// Point shape draws a fixed quad this many pixels across.
static constexpr float POINT_PX = 1.5f;

// Coarse field resolution — an abstract square sim field, unrelated to the
// viewport (like the interaction density buffer).
static constexpr int FIELD_RES = 256;

// 2 vec4 = 32 bytes. Mirror of `Particle` in common.hlsl.
struct GpuParticle {
  float a[4];   // a.xy=pos, a.z=life_remain, a.w=life_total
  float b[4];   // b.xy=vel, b.z=size, b.w=asfloat(packed rgbz)
};
static_assert(sizeof(GpuParticle) == 32, "Particle GPU struct must be 32 bytes");

struct FieldUniforms {
  uint32_t field_res;
  float    aspect_x;
  float    aspect_y;
  float    noise_speed;

  float    noise_curl;
  float    eddy_scale;
  float    eddy_detail;
  float    spin_phase;

  float    drift_phase;
  float    drift_dir;
  float    image_smoothing;
  float    _pad0;
};
static_assert(sizeof(FieldUniforms) == 48, "FieldUniforms layout mismatch");

struct UpdateUniforms {
  uint32_t count;
  uint32_t frame_index;
  float    dt;
  float    speed;

  float    momentum;
  float    jitter;
  float    drag;
  float    life;

  float    life_jitter;
  float    size;
  float    size_jitter;
  uint32_t seed;

  uint32_t mode;
  float    weight;
  float    pull;
  float    to_image;

  float    to_image_curl;
  float    undertow_skew;
  float    undertow_squash;
  float    aspect_x;

  float    aspect_y;
  uint32_t substeps;
  float    boundary;
  float    boundary_size;

  float    boundary_stiffness;
  float    boundary_death;
  float    spawn_size;
  float    _pad0;
};
static_assert(sizeof(UpdateUniforms) == 112, "UpdateUniforms layout mismatch");

struct PrefillUniforms { float scale_r, scale_g, scale_b, scale_a; };
static_assert(sizeof(PrefillUniforms) == 16, "PrefillUniforms layout mismatch");

struct VsUniforms {
  float aspect_x, aspect_y, point_size, shape_kind;
};
static_assert(sizeof(VsUniforms) == 16, "VsUniforms layout mismatch");

struct ColorUniforms {
  float    color_blend;
  float    solid_r;
  float    solid_g;
  float    solid_b;

  float    tint_by_flow;
  float    opacity;
  float    alpha_curve;
  float    shape_param;

  uint32_t shape_kind;
  float    exposure;
  float    _pad0;
  float    _pad1;
};
static_assert(sizeof(ColorUniforms) == 48, "ColorUniforms layout mismatch");

enum BlendMode : int { BLEND_ALPHA = 0, BLEND_ADD = 1 };
enum ShapeKind : int { SHAPE_POINT = 0, SHAPE_GAUSSIAN = 1, SHAPE_CIRCLE = 2, SHAPE_SOLID = 3 };
enum Mode      : int { MODE_VELOCITY = 0, MODE_FORCE = 1 };

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_field_b;
static gpu::ComputePSO s_pso_update;
static gpu::ComputePSO s_pso_prefill;
static gpu::RenderPSO  s_pso_render_alpha;
static gpu::RenderPSO  s_pso_render_add;

struct State {
  gpu::Buffer  particle_buf;
  gpu::Buffer  field_uniforms;
  gpu::Buffer  update_uniforms;
  gpu::Buffer  prefill_uniforms;
  gpu::Buffer  vs_uniforms;
  gpu::Buffer  color_uniforms;
  gpu::Sampler sampler;
  gpu::Texture field_b_tex;     // FIELD_RES² velocity field (lazy)
  gpu::Texture zero_field_a;    // 1×1 stand-in until the sweep pass lands (M2)
  gpu::Texture black_tex;       // 1×1 opaque black — generator fallback input

  bool initialized = false;

  // CPU mirrors of schema params.
  int   count        = 150000;
  int   mode         = MODE_VELOCITY;
  float speed        = 1.0f;
  float momentum     = 0.6f;
  float weight       = 1.0f;
  int   substeps     = 1;
  float pull         = 0.0f;
  float jitter       = 0.05f;
  float drag         = 0.1f;
  float life         = 4.0f;
  float life_jitter  = 0.4f;
  float size         = 0.3f;
  float size_jitter  = 0.5f;
  // Sweep.
  float sweep_center    = 0.5f;
  float sweep_width     = 0.25f;
  float sweep_soft      = 0.3f;
  float image_smoothing = 0.25f;
  // Field.
  float to_image        = 1.2f;
  float to_image_curl   = 1.0f;
  float undertow_skew   = 0.5f;
  float undertow_squash = 1.0f;
  float noise_speed     = 0.25f;
  float noise_curl      = 1.0f;
  float eddy_scale      = 0.4f;
  float eddy_detail     = 0.5f;
  float eddy_evolve     = 0.6f;
  float eddy_drift      = 0.05f;
  float eddy_drift_dir  = 0.0f;
  // Containment.
  float boundary           = 0.4f;
  float boundary_size      = 0.62f;
  float boundary_stiffness = 4.0f;
  float boundary_death     = 0.25f;
  float spawn_size         = 0.6f;
  // Render.
  float color_blend  = 0.5f;
  float solid_r      = 1.0f;
  float solid_g      = 1.0f;
  float solid_b      = 1.0f;
  float tint_by_flow = 0.0f;
  float opacity      = 0.25f;
  float alpha_curve  = 0.6f;
  float exposure     = 1.0f;
  int   shape_kind   = SHAPE_POINT;
  float shape_param  = 0.5f;
  int   blend_mode   = BLEND_ADD;
  float input_alpha  = 1.0f;
  int   seed         = 0;

  // Bookkeeping.
  int      inited_count = 0;
  uint32_t frame_index  = 0;
  uint32_t init_lcg     = 0x51EEB0CDu;
  // Noise phases, CPU-accumulated so rate-param changes stay smooth (and the
  // drift phase stays bounded — raw time × rate would degrade after hours).
  float spin_phase  = 0.0f;
  float drift_phase = 0.0f;
};

static inline uint32_t lcg_next(uint32_t& s) { s = s * 1664525u + 1013904223u; return s; }
static inline float    lcg_unit(uint32_t& s) { return (lcg_next(s) >> 8) * (1.0f / float(1u << 24)); }

// Pack white rgb + an 8-bit z phase into the particle's color slot (matches
// swc_pack_rgbz in common.hlsl). Only bit-reinterpreted, never float math.
static inline float pack_white_z(float z) {
  uint32_t d = (uint32_t)(z * 255.0f + 0.5f);
  if (d > 255u) d = 255u;
  uint32_t packed = 0xFFFFFFu | (d << 24);
  float f;
  std::memcpy(&f, &packed, sizeof(f));
  return f;
}

// Chunked seeding so a 1M pool doesn't blow the wasm stack (256 × 32 B = 8 KB).
static constexpr int INIT_CHUNK = 256;

static void seed_initial_slots(State& s, int from, int to) {
  if (!s.initialized || from >= to) return;
  GpuParticle entries[INIT_CHUNK];
  float size_uv = SIZE_SCALE * s.size * s.size;
  for (int chunk_start = from; chunk_start < to; chunk_start += INIT_CHUNK) {
    int chunk_end = chunk_start + INIT_CHUNK;
    if (chunk_end > to) chunk_end = to;
    int n = chunk_end - chunk_start;
    for (int i = 0; i < n; i++) {
      GpuParticle& p = entries[i];
      float ux = lcg_unit(s.init_lcg);
      float uy = lcg_unit(s.init_lcg);
      float life_remain = lcg_unit(s.init_lcg) * s.life;   // staggered start
      float z = lcg_unit(s.init_lcg);
      p.a[0] = ux; p.a[1] = uy; p.a[2] = life_remain; p.a[3] = s.life;
      p.b[0] = 0.0f; p.b[1] = 0.0f; p.b[2] = size_uv; p.b[3] = pack_white_z(z);
    }
    s.particle_buf.writeBytes(entries, int(sizeof(GpuParticle)) * n,
                              int(sizeof(GpuParticle)) * chunk_start);
  }
}

static void apply_count_change(State& s) {
  if (s.count > MAX_PARTICLES) s.count = MAX_PARTICLES;
  if (s.count < 1)             s.count = 1;
  if (s.count > s.inited_count) {
    seed_initial_slots(s, s.inited_count, s.count);
    s.inited_count = s.count;
  }
}

static void apply_mode_visibility(int mode) {
  state::setFieldHidden("momentum", mode != MODE_VELOCITY);
  state::setFieldHidden("weight",   mode != MODE_FORCE);
}

// Static (self-less) visibility evaluator — pure over state.
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  int mode = MODE_VELOCITY;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i]; int l = len[i];
    if (state::pathIs(p, l, "mode")) mode = (int)state::patchFloat(i);
  }
  apply_mode_visibility(mode);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) apply_mode_visibility(s->mode);
}

void module_init() {
  state::init("source.particles.sweep_chamber", {0, 1, 0},
    state::Schema()
      .helpField("intro",
        "## Sweep Chamber\n"
        "A particle + line sim with a **built-in luma sweep**. The *Sweep* "
        "window captures one band of the input's brightness at a time: "
        "particles catch onto the captured detail, bunch up along its ridges, "
        "then get **flung** when the sweep releases them. At either end of "
        "the sweep nothing is captured and everything free-flows on a smooth "
        "curl-noise eddy field.\n\n"
        "**Try:** wire a video in, slowly sweep *Center* from 0 to 1, and "
        "watch the swarm catch and release each brightness layer.")
      // ---- Sweep ----
      .group("sweep", "Sweep")
        .groupHelp(
          "The band-pass window over the input's luma. *Center* travels the "
          "window across the brightness range — 0 and 1 are always fully OFF "
          "either end (the image reads as black and the sim free-flows). "
          "*Width*/*Softness* shape the captured band; *Smoothing* widens the "
          "gradient read for broader, calmer attraction.")
      .floatField("sweep_center",    0.5f,  0.0f, 1.0f, state::PrimaryInput).label("Sweep Center", "Sweep")
      .floatField("sweep_width",     0.25f, 0.02f, 1.0f, state::PrimaryInput).label("Sweep Width", "Width")
      .floatField("sweep_soft",      0.3f,  0.0f, 1.0f, state::PrimaryInput).label("Sweep Softness", "Soft")
      .floatField("image_smoothing", 0.25f, 0.0f, 1.0f, state::PrimaryInput).label("Image Smoothing", "Smooth")
      // ---- Field ----
      .group("field", "Field")
        .groupHelp(
          "The forces. *To Image* pulls along the swept-luma gradient (toward "
          "the captured band's edges); *Image Curl* pushes perpendicular, "
          "scaled per particle by its hidden z phase (*Skew*/*Squash* shape "
          "that variation). The background is a smooth curl-noise eddy field: "
          "*Curl* blends gradient-flow → divergence-free eddies, *Eddy Scale/"
          "Detail* set their size and roughness, *Evolve* churns them and "
          "*Drift* advects them across the frame.")
      .floatField("to_image",        1.2f, -4.0f, 4.0f, state::PrimaryInput).label("To Image", "ToImg")
      .floatField("to_image_curl",   1.0f, -4.0f, 4.0f, state::PrimaryInput).label("Image Curl", "ImgCurl")
      .floatField("undertow_skew",   0.5f,  0.0f, 1.0f, state::PrimaryInput).label("Undertow Skew", "USkew")
      .floatField("undertow_squash", 1.0f, -2.0f, 2.0f, state::PrimaryInput).label("Undertow Squash", "USquash")
      .floatField("noise_speed",     0.25f, 0.0f, 2.0f, state::PrimaryInput).label("Noise Speed", "NSpd")
      .floatField("noise_curl",      1.0f, -1.0f, 1.0f, state::PrimaryInput).label("Noise Curl", "NCurl")
      .floatField("eddy_scale",      0.4f,  0.0f, 1.0f, state::PrimaryInput).label("Eddy Scale", "EddySc")
      .floatField("eddy_detail",     0.5f,  0.0f, 1.0f, state::PrimaryInput).label("Eddy Detail", "EddyDt")
      .floatField("eddy_evolve",     0.6f,  0.0f, 4.0f, state::PrimaryInput).label("Eddy Evolve", "Evolve")
      .floatField("eddy_drift",      0.05f, 0.0f, 0.5f, state::PrimaryInput).label("Eddy Drift", "Drift")
      .floatField("eddy_drift_dir",  0.0f,  0.0f, 1.0f, state::PrimaryInput).label("Drift Direction", "DriftDir")
      // ---- Pool / advection ----
      .group("advection", "Pool & Advection")
      .intField  ("count",     150000, 1, MAX_PARTICLES, state::PrimaryInput).label("Count", "Count")
      .selectField("mode",     MODE_VELOCITY, state::PrimaryInput, {
        {"Velocity", MODE_VELOCITY},
        {"Force",    MODE_FORCE},
      }).label("Mode", "Mode")
      .floatField("speed",     1.0f,  0.0f,  8.0f,  state::PrimaryInput).label("Speed", "Spd")
      .floatField("momentum",  0.6f,  0.0f,  0.99f, state::PrimaryInput).label("Momentum", "Mom")
      .floatField("weight",    1.0f,  0.05f, 8.0f,  state::PrimaryInput).label("Weight", "Wt")
      .intField  ("substeps",  1,     1,     16,    state::PrimaryInput).label("Substeps", "Sub")
      .floatField("pull",      0.0f,  0.0f,  1.0f,  state::PrimaryInput).label("Settle", "Pull")
      .floatField("jitter",    0.05f, 0.0f,  1.0f,  state::PrimaryInput).label("Jitter", "Jit")
      .floatField("drag",      0.1f,  0.0f,  4.0f,  state::PrimaryInput).label("Drag", "Drag")
      // ---- Geometry / lifetime / containment ----
      .group("geometry", "Geometry & Lifetime")
      .floatField("size",         0.3f, 0.0f, 1.0f,  state::PrimaryInput).label("Size", "Size")
      .floatField("size_jitter",  0.5f, 0.0f, 1.0f,  state::PrimaryInput).label("Size Jitter", "SzJit")
      .floatField("life",         4.0f, 0.1f, 30.0f, state::PrimaryInput).label("Lifetime", "Life")
      .floatField("life_jitter",  0.4f, 0.0f, 1.0f,  state::PrimaryInput).label("Life Jitter", "LfJit")
      .floatField("spawn_size",   0.6f, 0.0f, 1.2f,  state::PrimaryInput).label("Spawn Size", "Spawn")
      .floatField("boundary",           0.4f,  0.0f, 1.0f,  state::PrimaryInput).label("Boundary", "Bound")
      .floatField("boundary_size",      0.62f, 0.1f, 1.2f,  state::PrimaryInput).label("Boundary Size", "BSize")
      .floatField("boundary_stiffness", 4.0f,  0.5f, 16.0f, state::PrimaryInput).label("Boundary Stiffness", "BStiff")
      .floatField("boundary_death",     0.25f, 0.0f, 1.0f,  state::PrimaryInput).label("Boundary Death", "BDeath")
      // ---- Color ----
      .group("color", "Colour")
      .floatField("color_blend",  0.5f, 0.0f, 1.0f, state::PrimaryInput).label("Colour Blend", "Blend")
      .rgbField  ("solid_color",  1.0f, 1.0f, 1.0f, state::PrimaryInput).label("Solid Colour", "Colour")
      .floatField("tint_by_flow", 0.0f, 0.0f, 1.0f, state::PrimaryInput).label("Tint By Flow", "Tint")
      // ---- Composite ----
      .group("composite", "Composite")
      .selectField("blend_mode",  BLEND_ADD, state::PrimaryInput, {
        {"Add",   BLEND_ADD},
        {"Alpha", BLEND_ALPHA},
      }).label("Blend Mode", "Blend")
      .floatField("opacity",      0.25f, 0.0f, 1.0f, state::PrimaryInput).label("Opacity", "Opac")
      .floatField("input_alpha",  1.0f,  0.0f, 1.0f, state::PrimaryInput).label("Input Alpha", "InAlph")
      // ---- Tuning / shape ----
      .group("shape", "Shape & Tuning")
      .selectField("shape_kind",  SHAPE_POINT, state::PrimaryInput, {
        {"Point",    SHAPE_POINT},
        {"Gaussian", SHAPE_GAUSSIAN},
        {"Circle",   SHAPE_CIRCLE},
        {"Solid",    SHAPE_SOLID},
      }).label("Shape", "Shape")
      .floatField("shape_param",  0.5f, 0.0f,  1.0f, state::PrimaryInput).label("Shape Param", "Param")
      .floatField("alpha_curve",  0.6f, 0.25f, 4.0f, state::PrimaryInput).label("Alpha Curve", "Curve")
      .floatField("exposure",     1.0f, 0.0f,  8.0f, state::PrimaryInput).label("Exposure", "Exp")
      .intField  ("seed",         0,    0,     65535, state::PrimaryInput).label("Seed", "Seed")
      // ---- I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::Generator)
    );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("sweep_chamber_field_b",  FIELD_B_SPV,  FIELD_B_SPV_SIZE,
                           "rgba16float", "write");
  state::registerShaderSPV("sweep_chamber_p_update", P_UPDATE_SPV, P_UPDATE_SPV_SIZE);
  state::registerShaderSPV("sweep_chamber_prefill",  PREFILL_SPV,  PREFILL_SPV_SIZE);
  state::registerShaderSPV("sweep_chamber_vs",       VS_SPV,       VS_SPV_SIZE);
  state::registerShaderSPV("sweep_chamber_fs",       FS_SPV,       FS_SPV_SIZE);

  auto cs_field_b = gpu::Device::createShaderModuleByName("sweep_chamber_field_b");
  auto cs_update  = gpu::Device::createShaderModuleByName("sweep_chamber_p_update");
  auto cs_prefill = gpu::Device::createShaderModuleByName("sweep_chamber_prefill");
  auto vs_module  = gpu::Device::createShaderModuleByName("sweep_chamber_vs");
  auto fs_module  = gpu::Device::createShaderModuleByName("sweep_chamber_fs");
  if (!cs_field_b || !cs_update || !cs_prefill || !vs_module || !fs_module) return;

  s_pso_field_b = gpu::Device::createComputePSO(cs_field_b, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)   // field_b out
      .tex2d(1)                                       // field_a (swept luma)
      .sampler(2)
      .uniform(3));

  s_pso_update = gpu::Device::createComputePSO(cs_update, "main", gpu::Bindings()
      .storageRW(0)   // particles[]
      .tex2d(1)       // field_b
      .tex2d(2)       // input (color capture)
      .sampler(3)
      .uniform(4));

  s_pso_prefill = gpu::Device::createComputePSO(cs_prefill, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1)
      .uniform(2));

  s_pso_render_alpha = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_module, "main", gpu::TextureFormat::Surface,
      gpu::Bindings().storage(0).uniform(1).uniform(2),
      gpu::Device::BlendMode::AlphaOver);
  s_pso_render_add = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_module, "main", gpu::TextureFormat::Surface,
      gpu::Bindings().storage(0).uniform(1).uniform(2),
      gpu::Device::BlendMode::Additive);

  state::log("sweep_chamber: module initialized");
}

void* create() {
  auto* s = new State();
  s->particle_buf = gpu::Device::createBuffer(
      sizeof(GpuParticle) * MAX_PARTICLES, gpu::BufferUsage::Storage);
  s->field_uniforms   = gpu::Device::createBuffer(sizeof(FieldUniforms),   gpu::BufferUsage::Uniform);
  s->update_uniforms  = gpu::Device::createBuffer(sizeof(UpdateUniforms),  gpu::BufferUsage::Uniform);
  s->prefill_uniforms = gpu::Device::createBuffer(sizeof(PrefillUniforms), gpu::BufferUsage::Uniform);
  s->vs_uniforms      = gpu::Device::createBuffer(sizeof(VsUniforms),      gpu::BufferUsage::Uniform);
  s->color_uniforms   = gpu::Device::createBuffer(sizeof(ColorUniforms),   gpu::BufferUsage::Uniform);
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->particle_buf.release();
  s->field_uniforms.release();
  s->update_uniforms.release();
  s->prefill_uniforms.release();
  s->vs_uniforms.release();
  s->color_uniforms.release();
  s->sampler.release();
  s->field_b_tex.release();
  s->zero_field_a.release();
  s->black_tex.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_field_b.valid() || !s_pso_update.valid() || !s_pso_prefill.valid() ||
      !s_pso_render_alpha.valid() || !s_pso_render_add.valid()) return;
  if (!s->particle_buf.valid()) return;

  s->inited_count = 0;
  s->frame_index  = 0;
  s->init_lcg     = 0x51EEB0CDu;
  s->initialized  = true;
  apply_count_change(*s);   // seed the initial pool
  state::setOnStateReady(&on_state_ready);
}

void tick(void* self, double dt) { (void)self; (void)dt; }   // timing is GPU-side via dt uniform

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "count"))        { s->count = (int)state::patchFloat(i); apply_count_change(*s); }
    else if (state::pathIs(path, plen, "mode"))         { int v = (int)state::patchFloat(i); if (v != s->mode) { s->mode = v; apply_mode_visibility(s->mode); } }
    else if (state::pathIs(path, plen, "speed"))        s->speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "momentum"))     s->momentum = state::patchFloat(i);
    else if (state::pathIs(path, plen, "weight"))       s->weight = state::patchFloat(i);
    else if (state::pathIs(path, plen, "substeps"))     s->substeps = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "pull"))         s->pull = state::patchFloat(i);
    else if (state::pathIs(path, plen, "jitter"))       s->jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drag"))         s->drag = state::patchFloat(i);
    else if (state::pathIs(path, plen, "size"))         s->size = state::patchFloat(i);
    else if (state::pathIs(path, plen, "size_jitter"))  s->size_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "life"))         s->life = state::patchFloat(i);
    else if (state::pathIs(path, plen, "life_jitter"))  s->life_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sweep_center"))    s->sweep_center = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sweep_width"))     s->sweep_width = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sweep_soft"))      s->sweep_soft = state::patchFloat(i);
    else if (state::pathIs(path, plen, "image_smoothing")) s->image_smoothing = state::patchFloat(i);
    else if (state::pathIs(path, plen, "to_image"))        s->to_image = state::patchFloat(i);
    else if (state::pathIs(path, plen, "to_image_curl"))   s->to_image_curl = state::patchFloat(i);
    else if (state::pathIs(path, plen, "undertow_skew"))   s->undertow_skew = state::patchFloat(i);
    else if (state::pathIs(path, plen, "undertow_squash")) s->undertow_squash = state::patchFloat(i);
    else if (state::pathIs(path, plen, "noise_speed"))     s->noise_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "noise_curl"))      s->noise_curl = state::patchFloat(i);
    else if (state::pathIs(path, plen, "eddy_scale"))      s->eddy_scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "eddy_detail"))     s->eddy_detail = state::patchFloat(i);
    else if (state::pathIs(path, plen, "eddy_evolve"))     s->eddy_evolve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "eddy_drift"))      s->eddy_drift = state::patchFloat(i);
    else if (state::pathIs(path, plen, "eddy_drift_dir"))  s->eddy_drift_dir = state::patchFloat(i);
    else if (state::pathIs(path, plen, "boundary"))           s->boundary = state::patchFloat(i);
    else if (state::pathIs(path, plen, "boundary_size"))      s->boundary_size = state::patchFloat(i);
    else if (state::pathIs(path, plen, "boundary_stiffness")) s->boundary_stiffness = state::patchFloat(i);
    else if (state::pathIs(path, plen, "boundary_death"))     s->boundary_death = state::patchFloat(i);
    else if (state::pathIs(path, plen, "spawn_size"))         s->spawn_size = state::patchFloat(i);
    else if (state::pathIs(path, plen, "color_blend"))  s->color_blend = state::patchFloat(i);
    else if (state::pathIs(path, plen, "solid_color")) {
      auto v = state::patchVec3(i);
      s->solid_r = v.x; s->solid_g = v.y; s->solid_b = v.z;
    }
    else if (state::pathIs(path, plen, "tint_by_flow")) s->tint_by_flow = state::patchFloat(i);
    else if (state::pathIs(path, plen, "blend_mode"))   s->blend_mode = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "opacity"))      s->opacity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "input_alpha"))  s->input_alpha = state::patchFloat(i);
    else if (state::pathIs(path, plen, "shape_kind"))   s->shape_kind = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "shape_param"))  s->shape_param = state::patchFloat(i);
    else if (state::pathIs(path, plen, "alpha_curve"))  s->alpha_curve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "exposure"))     s->exposure = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed"))         s->seed = (int)state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  // Generator fallback: with no input wired, capture from 1×1 black (the sim
  // then free-flows on the noise field alone) and clear the base instead of
  // pre-filling.
  bool has_in = in.valid();
  if (!has_in) {
    if (!s->black_tex.valid()) {
      s->black_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA8);
      gpu::Device::clear(s->black_tex, 0.0f, 0.0f, 0.0f, 1.0f);
    }
    in = s->black_tex;
  }

  // Lazy field textures. field_a is a 1×1 zero until the sweep pass (M2).
  if (!s->field_b_tex.valid()) {
    s->field_b_tex = gpu::Device::createTexture(FIELD_RES, FIELD_RES,
                                                gpu::TextureFormat::RGBA16F);
    gpu::Device::clear(s->field_b_tex, 0.0f, 0.0f, 0.0f, 0.0f);
  }
  if (!s->zero_field_a.valid()) {
    s->zero_field_a = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
    gpu::Device::clear(s->zero_field_a, 0.0f, 0.0f, 0.0f, 0.0f);
  }
  if (!s->field_b_tex.valid()) return;

  s->frame_index++;
  float dt = (float)host::deltaTime();

  // Isotropic-uv aspect (1 unit = min(W,H) px) — shared by every pass.
  float min_dim = float(vp_w < vp_h ? vp_w : vp_h);
  float aspect_x = min_dim / float(vp_w);
  float aspect_y = min_dim / float(vp_h);

  // Noise phases: accumulate at the CURRENT rates so rate edits are smooth.
  // Drift wraps far out (one lattice-hash period is irrelevant at 4096) to
  // stay in float-precision range after hours of runtime.
  s->spin_phase  += s->eddy_evolve * dt;
  s->drift_phase += s->eddy_drift * dt;
  if (s->spin_phase  > 4096.0f) s->spin_phase  -= 4096.0f;
  if (s->drift_phase > 4096.0f) s->drift_phase -= 4096.0f;

  FieldUniforms fu = {};
  fu.field_res       = (uint32_t)FIELD_RES;
  fu.aspect_x        = aspect_x;
  fu.aspect_y        = aspect_y;
  fu.noise_speed     = s->noise_speed;
  fu.noise_curl      = s->noise_curl;
  fu.eddy_scale      = s->eddy_scale;
  fu.eddy_detail     = s->eddy_detail;
  fu.spin_phase      = s->spin_phase;
  fu.drift_phase     = s->drift_phase;
  fu.drift_dir       = s->eddy_drift_dir;
  fu.image_smoothing = s->image_smoothing;
  s->field_uniforms.writeOne(fu);

  float size_uv = SIZE_SCALE * s->size * s->size;

  UpdateUniforms uu = {};
  uu.count              = (uint32_t)s->count;
  uu.frame_index        = s->frame_index;
  uu.dt                 = dt;
  uu.speed              = s->speed;
  uu.momentum           = s->momentum;
  uu.jitter             = s->jitter;
  uu.drag               = s->drag;
  uu.life               = s->life;
  uu.life_jitter        = s->life_jitter;
  uu.size               = size_uv;
  uu.size_jitter        = s->size_jitter;
  uu.seed               = (uint32_t)s->seed;
  uu.mode               = (uint32_t)s->mode;
  uu.weight             = s->weight;
  uu.pull               = s->pull;
  uu.to_image           = s->to_image;
  uu.to_image_curl      = s->to_image_curl;
  uu.undertow_skew      = s->undertow_skew;
  uu.undertow_squash    = s->undertow_squash;
  uu.aspect_x           = aspect_x;
  uu.aspect_y           = aspect_y;
  uu.substeps           = (uint32_t)(s->substeps < 1 ? 1 : (s->substeps > 16 ? 16 : s->substeps));
  uu.boundary           = s->boundary;
  uu.boundary_size      = s->boundary_size;
  uu.boundary_stiffness = s->boundary_stiffness;
  uu.boundary_death     = s->boundary_death;
  uu.spawn_size         = s->spawn_size;
  s->update_uniforms.writeOne(uu);

  PrefillUniforms pu = { s->input_alpha, s->input_alpha, s->input_alpha, 1.0f };
  s->prefill_uniforms.writeOne(pu);

  VsUniforms vu = {};
  vu.aspect_x   = aspect_x;
  vu.aspect_y   = aspect_y;
  vu.point_size = POINT_PX / min_dim;
  vu.shape_kind = (float)s->shape_kind;
  s->vs_uniforms.writeOne(vu);

  ColorUniforms cu = {};
  cu.color_blend  = s->color_blend;
  cu.solid_r      = s->solid_r;
  cu.solid_g      = s->solid_g;
  cu.solid_b      = s->solid_b;
  cu.tint_by_flow = s->tint_by_flow;
  cu.opacity      = s->opacity;
  cu.alpha_curve  = s->alpha_curve;
  cu.shape_param  = s->shape_param;
  cu.shape_kind   = (uint32_t)s->shape_kind;
  cu.exposure     = s->exposure;
  s->color_uniforms.writeOne(cu);

  // ---- Pass 1: build the velocity field ----
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_field_b);
    cp.setTexture(s->field_b_tex, 0, 1);
    cp.setTexture(s->zero_field_a, 1, 0);
    cp.setSampler(s->sampler, 2);
    cp.setBuffer(s->field_uniforms, 3);
    cp.dispatch((FIELD_RES + 7) / 8, (FIELD_RES + 7) / 8);
    cp.end();
  }

  // ---- Pass 2: update particles ----
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_update);
    cp.setBuffer(s->particle_buf, 0);
    cp.setTexture(s->field_b_tex, 1, 0);
    cp.setTexture(in, 2, 0);
    cp.setSampler(s->sampler, 3);
    cp.setBuffer(s->update_uniforms, 4);
    int groups = (s->count + 63) / 64;
    cp.dispatch(groups, 1, 1);
    cp.end();
  }

  // ---- Pass 3: base (pre-fill from input, or clear when generating) ----
  if (has_in) {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->prefill_uniforms, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  } else {
    gpu::Device::clear(out, 0.0f, 0.0f, 0.0f, 1.0f);
  }

  // ---- Pass 4: instanced particle raster ----
  if (s->opacity > 0.0f) {
    auto rp = gpu::RenderPass::beginLoad(out);
    auto pso = (s->blend_mode == BLEND_ADD) ? s_pso_render_add : s_pso_render_alpha;
    rp.setPSO(pso);
    rp.setBuffer(s->particle_buf, 0);
    rp.setBuffer(s->vs_uniforms,  1);
    rp.setBuffer(s->color_uniforms, 2);
    rp.draw(6, s->count);
    rp.end();
  }

  gpu::Device::submit();
}

} // namespace sweep_chamber
