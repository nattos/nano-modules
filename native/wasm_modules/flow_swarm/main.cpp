/*
 * video.flow_swarm — flow-field-driven GPU particle swarm.
 *
 * Consumes a `flow_field` rail (the canonical velocity texture produced by
 * phase_fold or any flow generator/modifier) and advects a GPU-resident pool
 * of up to 1,000,000 particles along it. Each particle chases the sampled
 * field velocity with momentum (inertia), captures the input color where it
 * spawns, and respawns at a fresh random uv when its lifetime expires or it
 * drifts off-field — keeping visual density steady.
 *
 * The split this enables: field GENERATION (phase_fold) is separate from
 * field RENDERING (this swarm), and flow→flow modifiers can sit between.
 *
 * Pipeline (style guide §3.5 — rasterize geometry, don't loop per pixel):
 *   1. update   (compute)  — advect / age / respawn the pool.
 *   2. prefill  (compute)  — tex_in × input_alpha → tex_out.
 *   3. raster   (instanced)— 6 verts × count quads, additive/alpha-over,
 *                            dead particles collapse to a degenerate triangle.
 *
 * Class-like instance ABI: module_init() compiles shared PSOs + publishes the
 * schema once; each chain entry gets its own State (params + pool buffer).
 */

#include <gpu.h>
#include <host.h>
#include "flow_swarm_shaders.h"

#include <cstdint>
#include <cstring>

namespace flow_swarm {

// 1M particles × 32 bytes = 32 MB. The pool is sized for the max so `count`
// can be dialed up at runtime without reallocating; only fresh slots seed.
static constexpr int MAX_PARTICLES = 1000000;

// Quadratic size mapping: the schema `size` is a [0,1] slider (the IDE clips
// floats to 2 decimals, so a small linear range is unusable); the on-GPU size
// is SIZE_SCALE · slider² — fine control at the small end where the swarm
// usually lives. Slider 1 → SIZE_SCALE uv; default ~0.3 → ~0.003 uv.
static constexpr float SIZE_SCALE = 0.035f;
// Point shape draws a fixed quad this many pixels across (size slider ignored).
static constexpr float POINT_PX = 1.5f;

// 2 vec4 = 32 bytes. Mirror of `Particle` in common.hlsl.
struct GpuParticle {
  float a[4];   // a.xy=pos, a.z=life_remain, a.w=life_total
  float b[4];   // b.xy=vel, b.z=size, b.w=asfloat(packed rgba8 color)
};
static_assert(sizeof(GpuParticle) == 32, "Particle GPU struct must be 32 bytes");

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
  float    undertow_split;
  float    undertow_polarity;

  float    undertow_curl;
  float    _pad0;
  float    _pad1;
  float    _pad2;
};
static_assert(sizeof(UpdateUniforms) == 80, "UpdateUniforms layout mismatch");

struct PrefillUniforms { float scale_r, scale_g, scale_b, scale_a; };
static_assert(sizeof(PrefillUniforms) == 16, "PrefillUniforms layout mismatch");

struct VsUniforms {
  float aspect_x, aspect_y, point_size, shape_kind;
  float undertow_split, _pad0, _pad1, _pad2;
};
static_assert(sizeof(VsUniforms) == 32, "VsUniforms layout mismatch");

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
  float    undertow_alpha;
  float    _pad0;

  float    undertow_tint_r;
  float    undertow_tint_g;
  float    undertow_tint_b;
  float    _pad1;
};
static_assert(sizeof(ColorUniforms) == 64, "ColorUniforms layout mismatch");

enum BlendMode : int { BLEND_ALPHA = 0, BLEND_ADD = 1 };
enum ShapeKind : int { SHAPE_POINT = 0, SHAPE_GAUSSIAN = 1, SHAPE_CIRCLE = 2, SHAPE_SOLID = 3 };
enum Mode      : int { MODE_VELOCITY = 0, MODE_FORCE = 1 };

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_update;
static gpu::ComputePSO s_pso_prefill;
static gpu::RenderPSO  s_pso_render_alpha;
static gpu::RenderPSO  s_pso_render_add;

struct State {
  gpu::Buffer  particle_buf;
  gpu::Buffer  update_uniforms;
  gpu::Buffer  prefill_uniforms;
  gpu::Buffer  vs_uniforms;
  gpu::Buffer  color_uniforms;
  gpu::Sampler sampler;
  gpu::Texture zero_flow_tex;   // 1×1 fallback when no flow upstream

  bool initialized = false;

  // CPU mirrors of schema params.
  int   count        = 150000;
  int   mode         = MODE_VELOCITY;
  float speed        = 1.5f;
  float momentum     = 0.0f;    // velocity mode: 0 = clean sim of the field
  float weight       = 1.0f;    // force mode: particle mass
  float life         = 4.0f;
  float life_jitter  = 0.4f;
  float size         = 0.3f;    // [0,1] slider, quadratic → uv (SIZE_SCALE·size²)
  float size_jitter  = 0.5f;
  float jitter       = 0.0f;
  float drag         = 0.1f;
  float color_blend  = 0.3f;
  float solid_r      = 1.0f;
  float solid_g      = 1.0f;
  float solid_b      = 1.0f;
  float tint_by_flow = 0.0f;
  // Undertow: a depth-gated secondary flow behaviour.
  float undertow_split    = 0.0f;   // 0 = none undertow, 1 = all
  float undertow_polarity = 1.0f;   // 1 normal, -1 reverse, 2 = 2× speed
  float undertow_curl     = 0.0f;   // -1 turn 90° left, +1 right
  float undertow_alpha    = 1.0f;
  float undertow_tint_r   = 0.2f;
  float undertow_tint_g   = 0.45f;
  float undertow_tint_b   = 1.0f;
  float opacity      = 1.0f;
  float alpha_curve  = 0.6f;
  float exposure     = 1.0f;
  int   shape_kind   = SHAPE_POINT;
  float shape_param  = 0.5f;
  int   blend_mode   = BLEND_ADD;
  float input_alpha  = 1.0f;
  int   seed         = 0;

  // Seed/accumulator bookkeeping.
  int      inited_count = 0;
  uint32_t frame_index  = 0;
  uint32_t init_lcg     = 0x12345678u;
};

static inline uint32_t lcg_next(uint32_t& s) { s = s * 1664525u + 1013904223u; return s; }
static inline float    lcg_unit(uint32_t& s) { return (lcg_next(s) >> 8) * (1.0f / float(1u << 24)); }

// Pack white rgb + an 8-bit depth into the particle's color slot (matches
// fsw_pack_rgbd in common.hlsl). Only bit-reinterpreted, never float math.
static inline float pack_white_depth(float depth) {
  uint32_t d = (uint32_t)(depth * 255.0f + 0.5f);
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
  float size_uv = SIZE_SCALE * s.size * s.size;   // quadratic mapping
  for (int chunk_start = from; chunk_start < to; chunk_start += INIT_CHUNK) {
    int chunk_end = chunk_start + INIT_CHUNK;
    if (chunk_end > to) chunk_end = to;
    int n = chunk_end - chunk_start;
    for (int i = 0; i < n; i++) {
      GpuParticle& p = entries[i];
      float ux = lcg_unit(s.init_lcg);
      float uy = lcg_unit(s.init_lcg);
      float life_remain = lcg_unit(s.init_lcg) * s.life;   // staggered start
      float depth = lcg_unit(s.init_lcg);
      p.a[0] = ux; p.a[1] = uy; p.a[2] = life_remain; p.a[3] = s.life;
      p.b[0] = 0.0f; p.b[1] = 0.0f; p.b[2] = size_uv; p.b[3] = pack_white_depth(depth);
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

// Hide the param the inactive acceleration mode doesn't use (style guide §0).
static void apply_mode_visibility(const State& s) {
  state::setFieldHidden("momentum", s.mode != MODE_VELOCITY);
  state::setFieldHidden("weight",   s.mode != MODE_FORCE);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) apply_mode_visibility(*s);
}

void module_init() {
  state::init("video.flow_swarm", {1, 0, 0},
    state::Schema()
      // ---- Pool / advection (the live controls) ----
      .intField  ("count",        150000, 1, MAX_PARTICLES, state::PrimaryInput)
      // Acceleration mode: Velocity treats the field as a velocity (momentum
      // blends inertia in); Force treats it as a force/acceleration on a mass
      // (weight), so the field becomes a hint and overshoot emerges.
      .selectField("mode",        MODE_VELOCITY, state::PrimaryInput, {
        {"Velocity", MODE_VELOCITY},
        {"Force",    MODE_FORCE},
      })
      .floatField("speed",        1.5f,  0.0f,  8.0f,  state::PrimaryInput)
      // Velocity mode only: 0 = clean sim of the field, →1 = heavy inertia.
      .floatField("momentum",     0.0f,  0.0f,  0.99f, state::PrimaryInput)
      // Force mode only: particle mass (accel = field / weight).
      .floatField("weight",       1.0f,  0.05f, 8.0f,  state::PrimaryInput)
      .floatField("jitter",       0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("drag",         0.1f,  0.0f,  4.0f,  state::PrimaryInput)
      // ---- Geometry / lifetime ----
      // size is a [0,1] slider mapped quadratically to a (small) uv size — the
      // IDE clips to 2 decimals so a raw uv range was too coarse at the bottom.
      .floatField("size",         0.3f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("size_jitter",  0.5f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("life",         4.0f,  0.1f,  30.0f, state::PrimaryInput)
      .floatField("life_jitter",  0.4f,  0.0f,  1.0f,  state::PrimaryInput)
      // ---- Color ----
      .floatField("color_blend",  0.3f,  0.0f,  1.0f,  state::PrimaryInput)
      .rgbField  ("solid_color",  1.0f, 1.0f, 1.0f,    state::PrimaryInput)
      .floatField("tint_by_flow", 0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      // ---- Undertow: a depth-gated secondary flow ----
      // Each particle gets a hidden depth ∈[0,1] at spawn. `split` softly
      // selects which depths join the undertow stream (0 none → 1 all).
      .floatField("undertow_split",    0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      // Members travel at `polarity` × the field (1 normal, -1 reverse, 2 = 2×).
      .floatField("undertow_polarity", 1.0f, -2.0f,  2.0f,  state::PrimaryInput)
      // Curl rotates the undertow direction: -1 = 90° left, +1 = 90° right.
      .floatField("undertow_curl",     0.0f, -1.0f,  1.0f,  state::PrimaryInput)
      // Members blend toward this tint by membership, with this alpha multiplier.
      .rgbField  ("undertow_tint",     0.2f, 0.45f, 1.0f,   state::PrimaryInput)
      .floatField("undertow_alpha",    1.0f,  0.0f,  2.0f,  state::PrimaryInput)
      // ---- Composite ----
      .selectField("blend_mode",  BLEND_ADD, state::PrimaryInput, {
        {"Add",   BLEND_ADD},
        {"Alpha", BLEND_ALPHA},
      })
      .floatField("opacity",      1.0f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("input_alpha",  1.0f,  0.0f,  1.0f,  state::PrimaryInput)
      // ---- Tuning / shape ----
      .selectField("shape_kind",  SHAPE_POINT, state::PrimaryInput, {
        {"Point",    SHAPE_POINT},
        {"Gaussian", SHAPE_GAUSSIAN},
        {"Circle",   SHAPE_CIRCLE},
        {"Solid",    SHAPE_SOLID},
      })
      .floatField("shape_param",  0.5f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("alpha_curve",  0.6f,  0.25f, 4.0f,  state::PrimaryInput)
      .floatField("exposure",     1.0f,  0.0f,  8.0f,  state::PrimaryInput)
      .intField  ("seed",         0,     0,     65535, state::PrimaryInput)
      // ---- I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      .flowField(state::PrimaryInput, "flow_field_in")
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("flow_swarm_update",  UPDATE_SPV,  UPDATE_SPV_SIZE);
  state::registerShaderSPV("flow_swarm_prefill", PREFILL_SPV, PREFILL_SPV_SIZE);
  state::registerShaderSPV("flow_swarm_vs",      VS_SPV,      VS_SPV_SIZE);
  state::registerShaderSPV("flow_swarm_fs",      FS_SPV,      FS_SPV_SIZE);

  auto cs_update  = gpu::Device::createShaderModuleByName("flow_swarm_update");
  auto cs_prefill = gpu::Device::createShaderModuleByName("flow_swarm_prefill");
  auto vs_module  = gpu::Device::createShaderModuleByName("flow_swarm_vs");
  auto fs_module  = gpu::Device::createShaderModuleByName("flow_swarm_fs");
  if (!cs_update || !cs_prefill || !vs_module || !fs_module) return;

  s_pso_update = gpu::Device::createComputePSO(cs_update, "main", gpu::Bindings()
      .storageRW(0)   // particles[]
      .tex2d(1)       // flow velocity
      .tex2d(2)       // input (color capture)
      .sampler(3)
      .uniform(4));

  s_pso_prefill = gpu::Device::createComputePSO(cs_prefill, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));

  s_pso_render_alpha = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_module, "main", gpu::TextureFormat::Surface,
      gpu::Bindings().storage(0).uniform(1).uniform(2),
      gpu::Device::BlendMode::AlphaOver);
  s_pso_render_add = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_module, "main", gpu::TextureFormat::Surface,
      gpu::Bindings().storage(0).uniform(1).uniform(2),
      gpu::Device::BlendMode::Additive);

  state::log("flow_swarm: module initialized");
}

void* create() {
  auto* s = new State();
  s->particle_buf = gpu::Device::createBuffer(
      sizeof(GpuParticle) * MAX_PARTICLES, gpu::BufferUsage::Storage);
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
  s->update_uniforms.release();
  s->prefill_uniforms.release();
  s->vs_uniforms.release();
  s->color_uniforms.release();
  s->sampler.release();
  s->zero_flow_tex.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_update.valid() || !s_pso_prefill.valid() ||
      !s_pso_render_alpha.valid() || !s_pso_render_add.valid()) return;
  if (!s->particle_buf.valid()) return;

  s->inited_count = 0;
  s->frame_index  = 0;
  s->init_lcg     = 0x12345678u;
  s->initialized  = true;
  apply_count_change(*s);   // seed the initial pool
  state::setOnStateReady(&on_state_ready);
}

void tick(void* self, double dt) { (void)self; (void)dt; }   // timing is GPU-side via dt uniform
void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "count"))        { s->count = (int)state::patchFloat(i); apply_count_change(*s); }
    else if (state::pathIs(path, plen, "mode"))         { int v = (int)state::patchFloat(i); if (v != s->mode) { s->mode = v; apply_mode_visibility(*s); } }
    else if (state::pathIs(path, plen, "speed"))        s->speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "momentum"))     s->momentum = state::patchFloat(i);
    else if (state::pathIs(path, plen, "weight"))       s->weight = state::patchFloat(i);
    else if (state::pathIs(path, plen, "jitter"))       s->jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drag"))         s->drag = state::patchFloat(i);
    else if (state::pathIs(path, plen, "size"))         s->size = state::patchFloat(i);
    else if (state::pathIs(path, plen, "size_jitter"))  s->size_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "life"))         s->life = state::patchFloat(i);
    else if (state::pathIs(path, plen, "life_jitter"))  s->life_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "color_blend"))  s->color_blend = state::patchFloat(i);
    else if (state::pathIs(path, plen, "solid_color")) {
      auto v = state::patchVec3(i);
      s->solid_r = v.x; s->solid_g = v.y; s->solid_b = v.z;
    }
    else if (state::pathIs(path, plen, "tint_by_flow"))      s->tint_by_flow = state::patchFloat(i);
    else if (state::pathIs(path, plen, "undertow_split"))    s->undertow_split = state::patchFloat(i);
    else if (state::pathIs(path, plen, "undertow_polarity")) s->undertow_polarity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "undertow_curl"))     s->undertow_curl = state::patchFloat(i);
    else if (state::pathIs(path, plen, "undertow_tint")) {
      auto v = state::patchVec3(i);
      s->undertow_tint_r = v.x; s->undertow_tint_g = v.y; s->undertow_tint_b = v.z;
    }
    else if (state::pathIs(path, plen, "undertow_alpha"))    s->undertow_alpha = state::patchFloat(i);
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
  if (!in.valid() || !out.valid()) return;

  // Flow field input. Fall back to a 1×1 zero (still) field when unwired —
  // particles then drift only by jitter and still render.
  auto flow = gpu::Device::textureForField("flow_field_in/velocity");
  if (!flow.valid()) {
    if (!s->zero_flow_tex.valid()) {
      s->zero_flow_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
      gpu::Device::clear(s->zero_flow_tex, 0.0f, 0.0f, 0.0f, 0.0f);
    }
    flow = s->zero_flow_tex;
  }

  s->frame_index++;

  float size_uv = SIZE_SCALE * s->size * s->size;   // quadratic mapping

  UpdateUniforms uu = {};
  uu.count             = (uint32_t)s->count;
  uu.frame_index       = s->frame_index;
  uu.dt                = (float)host::deltaTime();
  uu.speed             = s->speed;
  uu.momentum          = s->momentum;
  uu.jitter            = s->jitter;
  uu.drag              = s->drag;
  uu.life              = s->life;
  uu.life_jitter       = s->life_jitter;
  uu.size              = size_uv;
  uu.size_jitter       = s->size_jitter;
  uu.seed              = (uint32_t)s->seed;
  uu.mode              = (uint32_t)s->mode;
  uu.weight            = s->weight;
  uu.undertow_split    = s->undertow_split;
  uu.undertow_polarity = s->undertow_polarity;
  uu.undertow_curl     = s->undertow_curl;
  s->update_uniforms.writeOne(uu);

  PrefillUniforms pu = { s->input_alpha, s->input_alpha, s->input_alpha, 1.0f };
  s->prefill_uniforms.writeOne(pu);

  float min_dim = float(vp_w < vp_h ? vp_w : vp_h);
  VsUniforms vu = {};
  vu.aspect_x        = min_dim / float(vp_w);
  vu.aspect_y        = min_dim / float(vp_h);
  vu.point_size      = POINT_PX / min_dim;          // ~1.5px in isotropic uv
  vu.shape_kind      = (float)s->shape_kind;
  vu.undertow_split  = s->undertow_split;
  s->vs_uniforms.writeOne(vu);

  ColorUniforms cu = {};
  cu.color_blend     = s->color_blend;
  cu.solid_r         = s->solid_r;
  cu.solid_g         = s->solid_g;
  cu.solid_b         = s->solid_b;
  cu.tint_by_flow    = s->tint_by_flow;
  cu.opacity         = s->opacity;
  cu.alpha_curve     = s->alpha_curve;
  cu.shape_param     = s->shape_param;
  cu.shape_kind      = (uint32_t)s->shape_kind;
  cu.exposure        = s->exposure;
  cu.undertow_alpha  = s->undertow_alpha;
  cu.undertow_tint_r = s->undertow_tint_r;
  cu.undertow_tint_g = s->undertow_tint_g;
  cu.undertow_tint_b = s->undertow_tint_b;
  s->color_uniforms.writeOne(cu);

  // ---- Pass 1: update particles ----
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_update);
    cp.setBuffer(s->particle_buf, 0);
    cp.setTexture(flow, 1, 0);
    cp.setTexture(in,   2, 0);
    cp.setSampler(s->sampler, 3);
    cp.setBuffer(s->update_uniforms, 4);
    int groups = (s->count + 63) / 64;
    cp.dispatch(groups, 1, 1);
    cp.end();
  }

  // ---- Pass 2: pre-fill (tex_in × input_alpha → tex_out) ----
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->prefill_uniforms, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // ---- Pass 3: instanced raster (blend over pre-filled tex_out) ----
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

} // namespace flow_swarm
