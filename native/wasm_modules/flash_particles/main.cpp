/*
 * video.flash_particles — Mask-driven particle compositor.
 *
 * Maintains a GPU-resident pool of up to MAX_PARTICLES particles. On
 * spawn, a compute shader random-samples the (optional) mask texture
 * for the brightest of K candidates, captures the input color at that
 * uv, and re-rolls per-particle geometry / color / alpha jitters from
 * the current uniforms. While alive, particles render as oriented
 * quads via vertex/fragment instanced draw — one storage-buffered
 * particle per quad, the VS reads it, the FS shapes it (solid /
 * squircle / gaussian) and outputs color * alpha.
 *
 * Composition modes (alpha-over vs additive) are TWO PSOs against the
 * SAME fragment shader, picked at dispatch time by the user's
 * blend_mode param. The render pass loads the pre-filled framebuffer
 * (`tex_in × input_alpha`) so the blend equation does the right thing
 * on top of the dimmed input.
 *
 * Motion vectors share the same VS but a different FS that emits
 * `(velocity, 0, mask)`. Pre-filled with upstream render_outputs/motion
 * (or zero when no upstream is wired); the alpha-over blend then acts
 * as a mask-controlled lerp — covered pixels get the particle's motion,
 * uncovered keep upstream.
 *
 * Aspect: width/height are stored in "isotropic uv" — one unit
 * corresponds to min(W, H) pixels. So size.x == size.y always renders
 * as a real pixel square, regardless of viewport aspect.
 */

#include <gpu.h>
#include <host.h>
#include "flash_particles_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace flash_particles {

// Hard cap. The GPU buffer is sized for the maximum so the user can
// dial `count` up at runtime without us reallocating; only fresh
// (count - prev_count) slots are seeded.
static constexpr int   MAX_PARTICLES   = 100000;
static constexpr float DEG2RAD         = 3.14159265358979323846f / 180.0f;

// 5 vec4 = 80 bytes per particle. Mirror of `Particle` in common.hlsl.
struct GpuParticle {
  float pos_size[4];
  float captured[4];
  float state[4];
  float jitters[4];
  float meta[4];
};
static_assert(sizeof(GpuParticle) == 80, "Particle GPU struct must be 80 bytes");

struct UpdateUniforms {
  // row 0
  uint32_t count;
  uint32_t frame_index;
  float    dt;
  float    mask_temperature;  // 0 = argmax (greedy); higher = softmax(luma / T)

  // row 1 — lifetime
  float    life;
  float    respawn_delay;
  float    life_jitter;
  float    _pad_l0;

  // row 2 — geometry
  float    width;
  float    height;
  float    global_scale;
  float    width_jitter;

  // row 3 — geometry cont.
  float    height_jitter;
  float    rotation_rad;
  float    rotation_jitter_rad;
  float    _pad_g0;

  // row 4 — color jitters
  float    hue_jitter;
  float    brightness_jitter;
  float    saturation_jitter;
  float    alpha_jitter;
};
static_assert(sizeof(UpdateUniforms) == 80, "UpdateUniforms layout mismatch");

struct PrefillUniforms {
  // Per-channel scale applied to the source tex during the copy. For
  // the color pass we use (input_alpha, input_alpha, input_alpha, 1);
  // for the motion pass (1, 1, 1, 1).
  float scale_r;
  float scale_g;
  float scale_b;
  float scale_a;
};
static_assert(sizeof(PrefillUniforms) == 16, "PrefillUniforms layout mismatch");

struct VsUniforms {
  // Aspect conversion factors: isotropic-uv → true-uv on each axis.
  // For W==H both are 1; otherwise the longer axis gets compressed
  // so a particle with size.x == size.y renders as a pixel square.
  float aspect_x;
  float aspect_y;
  float _pad0;
  float _pad1;
};
static_assert(sizeof(VsUniforms) == 16, "VsUniforms layout mismatch");

struct ColorUniforms {
  // row 0 — composite + color blend
  float    input_alpha;
  float    color_blend;
  float    global_color_r;
  float    global_color_g;

  // row 1 — color cont. + curve
  float    global_color_b;
  float    alpha_curve;
  float    frame_alpha_jitter;
  uint32_t frame_index;

  // row 2 — shape + exposure/color-alpha gate
  uint32_t shape_kind;
  float    shape_param;
  float    exposure;     // RGB multiplier (alpha untouched; clips to white)
  float    color_alpha;  // global multiplier on final color alpha
};
static_assert(sizeof(ColorUniforms) == 48, "ColorUniforms layout mismatch");

struct MotionUniforms {
  float    motion_strength;
  uint32_t shape_kind;
  float    shape_param;
  float    alpha_curve;  // mirrors ColorUniforms.alpha_curve — applied to motion magnitude
};
static_assert(sizeof(MotionUniforms) == 16, "MotionUniforms layout mismatch");

enum BlendMode : int { BLEND_ALPHA = 0, BLEND_ADD = 1 };
enum ShapeKind : int { SHAPE_SOLID = 0, SHAPE_CIRCLE = 1, SHAPE_GAUSSIAN = 2 };

static gpu::ComputePSO s_pso_update;
static gpu::ComputePSO s_pso_prefill_color;
static gpu::ComputePSO s_pso_prefill_motion;
static gpu::RenderPSO  s_pso_render_alpha;   // color, alpha-over blend
static gpu::RenderPSO  s_pso_render_add;     // color, additive blend
static gpu::RenderPSO  s_pso_render_motion;  // motion, alpha-over (mask-as-blend-alpha)
static gpu::Buffer     s_particle_buf;
static gpu::Buffer     s_update_uniforms;
static gpu::Buffer     s_prefill_color_uniforms;
static gpu::Buffer     s_prefill_motion_uniforms;
static gpu::Buffer     s_vs_uniforms;
static gpu::Buffer     s_color_uniforms;
static gpu::Buffer     s_motion_uniforms;
static gpu::Sampler    s_sampler;
static gpu::Texture    s_motion_tex;
static gpu::Texture    s_zero_motion_tex;  // 1×1 fallback when no upstream
static int  s_motion_w = 0;
static int  s_motion_h = 0;
static bool s_initialized = false;

// CPU mirrors of all schema params.
static int   s_count               = 64;
static float s_life                = 1.5f;
static float s_respawn_delay       = 0.3f;
static float s_life_jitter         = 0.3f;
static float s_width               = 0.05f;
static float s_height              = 0.05f;
static float s_width_jitter        = 0.3f;
static float s_height_jitter       = 0.3f;
static float s_global_scale        = 1.0f;
static float s_rotation_deg        = 0.0f;
static float s_rotation_jitter_deg = 30.0f;
static int   s_shape_kind          = SHAPE_GAUSSIAN;
static float s_shape_param         = 0.5f;
static float s_alpha_curve         = 1.5f;
static float s_frame_alpha_jitter  = 0.0f;
static float s_global_color_r      = 1.0f;
static float s_global_color_g      = 1.0f;
static float s_global_color_b      = 1.0f;
static float s_color_blend         = 0.5f;
static float s_hue_jitter          = 0.1f;
static float s_brightness_jitter   = 0.1f;
static float s_saturation_jitter   = 0.1f;
static float s_alpha_jitter        = 0.1f;
static int   s_blend_mode          = BLEND_ALPHA;
static float s_input_alpha         = 1.0f;
static float s_motion_strength     = 0.5f;
static float s_exposure            = 1.0f;
static float s_color_alpha         = 1.0f;
static float s_mask_temperature    = 0.0f;

static int      s_inited_count = 0;
static uint32_t s_frame_index  = 0;
static uint32_t s_init_lcg     = 0x12345678u;

static inline uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u;
  return s;
}
static inline float lcg_unit(uint32_t& s) {
  return (lcg_next(s) >> 8) * (1.0f / float(1u << 24));
}

// We chunk seed_initial_slots into INIT_CHUNK-sized writes so a 100k-
// particle pool doesn't blow the wasm stack with an 80*100000 = 8 MB
// local array. 256 entries × 80 bytes = 20 KB per chunk fits well
// under any reasonable stack budget.
static constexpr int INIT_CHUNK = 256;

// Seed slots [from, to) with a "ready to respawn" state, randomised
// across [0, life + respawn] so the pool spawns staggered rather than
// in lockstep on the first frame.
static void seed_initial_slots(int from, int to) {
  if (s_initialized == false) return;
  if (from >= to) return;
  GpuParticle entries[INIT_CHUNK];
  float cycle = s_life + s_respawn_delay;
  for (int chunk_start = from; chunk_start < to; chunk_start += INIT_CHUNK) {
    int chunk_end = chunk_start + INIT_CHUNK;
    if (chunk_end > to) chunk_end = to;
    int n = chunk_end - chunk_start;
    for (int i = 0; i < n; i++) {
      GpuParticle& p = entries[i];
      std::memset(&p, 0, sizeof(p));
      p.pos_size[2] = 1e-3f;        // tiny size avoids div-by-zero before first respawn
      p.pos_size[3] = 1e-3f;
      p.state[2]    = 1.0f;          // life_total placeholder
      p.state[1]    = 0.0f;          // life_remain (start invisible)
      p.state[3]    = lcg_unit(s_init_lcg) * cycle;  // staggered respawn
    }
    s_particle_buf.writeBytes(
        entries, int(sizeof(GpuParticle)) * n,
        int(sizeof(GpuParticle)) * chunk_start);
  }
}

static void apply_count_change() {
  if (s_count > MAX_PARTICLES) s_count = MAX_PARTICLES;
  if (s_count < 1)             s_count = 1;
  if (s_count > s_inited_count) {
    seed_initial_slots(s_inited_count, s_count);
    s_inited_count = s_count;
  }
}

void init() {
  s_initialized = false;
  s_inited_count = 0;
  s_frame_index  = 0;
  s_init_lcg     = 0x12345678u;

  state::init("video.flash_particles", {1, 0, 0},
    state::Schema()
      // ---- Pool ----
      .intField  ("count",            64,    1,    MAX_PARTICLES, state::PrimaryInput)
      // ---- Lifetime ----
      .floatField("life",             1.5f,  0.05f, 10.0f,        state::PrimaryInput)
      .floatField("respawn_delay",    0.3f,  0.0f,  10.0f,        state::PrimaryInput)
      .floatField("life_jitter",      0.3f,  0.0f,  1.0f,         state::PrimaryInput)
      // Temperature on the mask-sample softmax. 0 = greedy / argmax
      // (always pick the brightest of K candidates — sharpest
      // adherence to the mask). Increasing it spreads the spawn
      // probability across darker candidates too; very large values
      // → uniform random.
      .floatField("mask_temperature", 0.0f,  0.0f,  4.0f,         state::PrimaryInput)
      // ---- Geometry (isotropic uv — equal w/h is a pixel square) ----
      .floatField("width",            0.05f, 0.001f, 1.0f,        state::PrimaryInput)
      .floatField("height",           0.05f, 0.001f, 1.0f,        state::PrimaryInput)
      .floatField("width_jitter",     0.3f,  0.0f,  1.0f,         state::PrimaryInput)
      .floatField("height_jitter",    0.3f,  0.0f,  1.0f,         state::PrimaryInput)
      .floatField("global_scale",     1.0f,  0.01f, 4.0f,         state::PrimaryInput)
      .floatField("rotation",         0.0f,  -360.0f, 360.0f,     state::PrimaryInput)
      .floatField("rotation_jitter",  30.0f, 0.0f,  360.0f,       state::PrimaryInput)
      // ---- Mask shape ----
      .selectField("shape_kind",      SHAPE_GAUSSIAN,             state::PrimaryInput, {
        {"Solid",    SHAPE_SOLID},
        {"Circle",   SHAPE_CIRCLE},
        {"Gaussian", SHAPE_GAUSSIAN},
      })
      .floatField("shape_param",      0.5f,  0.0f,  1.0f,         state::PrimaryInput)
      // ---- Alpha decay + frame jitter ----
      .floatField("alpha_curve",      1.5f,  0.25f, 4.0f,         state::PrimaryInput)
      .floatField("frame_alpha_jitter", 0.0f, 0.0f, 1.0f,         state::PrimaryInput)
      // ---- Color ----
      .rgbField  ("global_color",     1.0f, 1.0f, 1.0f,           state::PrimaryInput)
      .floatField("color_blend",      0.5f,  0.0f,  1.0f,         state::PrimaryInput)
      .floatField("hue_jitter",       0.1f,  0.0f,  1.0f,         state::PrimaryInput)
      .floatField("brightness_jitter", 0.1f, 0.0f,  1.0f,         state::PrimaryInput)
      .floatField("saturation_jitter", 0.1f, 0.0f,  1.0f,         state::PrimaryInput)
      .floatField("alpha_jitter",     0.1f,  0.0f,  1.0f,         state::PrimaryInput)
      // ---- Composite ----
      .selectField("blend_mode",      BLEND_ALPHA,                state::PrimaryInput, {
        {"Alpha", BLEND_ALPHA},
        {"Add",   BLEND_ADD},
      })
      .floatField("input_alpha",      1.0f,  0.0f,  1.0f,         state::PrimaryInput)
      // RGB multiplier applied per-fragment after the captured/global
      // color blend. Alpha is untouched, so a >1 value boosts intensity
      // and naturally clips to white in the rgba8 surface format.
      .floatField("exposure",         1.0f,  0.0f,  8.0f,         state::PrimaryInput)
      // Global multiplier on the color render's output alpha. At 0 the
      // color raster pass is skipped entirely (motion vectors still
      // emit), letting the user fade particles out without losing the
      // motion-vector channel a downstream effect may consume.
      .floatField("color_alpha",      1.0f,  0.0f,  1.0f,         state::PrimaryInput)
      // ---- Motion ----
      .floatField("motion_strength",  0.5f,  0.0f,  1.0f,         state::PrimaryInput)
      // ---- Standard I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      // Optional secondary mask. Falls back to tex_in C++-side when
      // no tap is wired.
      .textureField("mask_in", state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      // Upstream render-outputs (auxiliary input). Same chaining
      // contract as the other motion writers — pixels not covered by
      // any particle inherit upstream motion.
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // ---- Compute shaders ----
  state::registerShaderSPV("flash_particles_update", UPDATE_SPV, UPDATE_SPV_SIZE);
  // Same prefill SPV registered twice with different storage formats —
  // the naga-bridge substitutes the format per registration, so each
  // PSO gets the right `texture_storage_2d<...>` declaration.
  state::registerShaderSPV("flash_particles_prefill_color",  PREFILL_SPV, PREFILL_SPV_SIZE);
  state::registerShaderSPV("flash_particles_prefill_motion", PREFILL_SPV, PREFILL_SPV_SIZE,
                            "rgba16float", "write");

  // ---- Vertex / fragment shaders ----
  state::registerShaderSPV("flash_particles_vs",        VS_SPV,        VS_SPV_SIZE);
  state::registerShaderSPV("flash_particles_fs_color",  FS_COLOR_SPV,  FS_COLOR_SPV_SIZE);
  state::registerShaderSPV("flash_particles_fs_motion", FS_MOTION_SPV, FS_MOTION_SPV_SIZE);

  auto cs_update         = gpu::Device::createShaderModuleByName("flash_particles_update");
  auto cs_prefill_color  = gpu::Device::createShaderModuleByName("flash_particles_prefill_color");
  auto cs_prefill_motion = gpu::Device::createShaderModuleByName("flash_particles_prefill_motion");
  auto vs_module         = gpu::Device::createShaderModuleByName("flash_particles_vs");
  auto fs_color          = gpu::Device::createShaderModuleByName("flash_particles_fs_color");
  auto fs_motion         = gpu::Device::createShaderModuleByName("flash_particles_fs_motion");
  if (!cs_update || !cs_prefill_color || !cs_prefill_motion
      || !vs_module || !fs_color || !fs_motion) return;

  s_pso_update = gpu::Device::createComputePSO(cs_update, "main", gpu::Bindings()
      .storageRW(0)         // particles[] (read+write)
      .tex2d(1)             // maskTex
      .tex2d(2)             // inputTex
      .sampler(3)           // linear sampler
      .uniform(4));         // UpdateUniforms

  // Both prefill PSOs share the same binding shape; only the storage-
  // tex format substitution differs.
  s_pso_prefill_color = gpu::Device::createComputePSO(cs_prefill_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_pso_prefill_motion = gpu::Device::createComputePSO(cs_prefill_motion, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)
      .uniform(2));

  // ---- Color render PSOs (alpha + additive variants of same shader) ----
  s_pso_render_alpha = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_color, "main",
      gpu::TextureFormat::Surface,
      gpu::Bindings()
          .storage(0)       // particles[] (vertex stage reads)
          .uniform(1)       // VsUniforms (vertex)
          .uniform(2),      // ColorUniforms (fragment)
      gpu::Device::BlendMode::AlphaOver);
  s_pso_render_add = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_color, "main",
      gpu::TextureFormat::Surface,
      gpu::Bindings()
          .storage(0)
          .uniform(1)
          .uniform(2),
      gpu::Device::BlendMode::Additive);

  // ---- Motion render PSO (alpha-over acts as mask-controlled overwrite) ----
  s_pso_render_motion = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_motion, "main",
      gpu::TextureFormat::RGBA16F,
      gpu::Bindings()
          .storage(0)
          .uniform(1)       // VsUniforms (vertex)
          .uniform(2),      // MotionUniforms (fragment)
      gpu::Device::BlendMode::AlphaOver);

  // ---- Buffers ----
  s_particle_buf = gpu::Device::createBuffer(
      sizeof(GpuParticle) * MAX_PARTICLES, gpu::BufferUsage::Storage);
  s_update_uniforms = gpu::Device::createBuffer(
      sizeof(UpdateUniforms), gpu::BufferUsage::Uniform);
  s_prefill_color_uniforms = gpu::Device::createBuffer(
      sizeof(PrefillUniforms), gpu::BufferUsage::Uniform);
  s_prefill_motion_uniforms = gpu::Device::createBuffer(
      sizeof(PrefillUniforms), gpu::BufferUsage::Uniform);
  s_vs_uniforms = gpu::Device::createBuffer(
      sizeof(VsUniforms), gpu::BufferUsage::Uniform);
  s_color_uniforms = gpu::Device::createBuffer(
      sizeof(ColorUniforms), gpu::BufferUsage::Uniform);
  s_motion_uniforms = gpu::Device::createBuffer(
      sizeof(MotionUniforms), gpu::BufferUsage::Uniform);
  s_sampler = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                          gpu::AddressMode::ClampToEdge);

  s_initialized = true;
  apply_count_change();   // seed the initial pool
  state::log("flash_particles: initialized");
}

void tick(double dt) { (void)dt; }  // all timing is GPU-side via dt uniform

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "count"))            { s_count = (int)state::patchFloat(i); apply_count_change(); }
    else if (state::pathIs(path, plen, "life"))             s_life = state::patchFloat(i);
    else if (state::pathIs(path, plen, "respawn_delay"))    s_respawn_delay = state::patchFloat(i);
    else if (state::pathIs(path, plen, "life_jitter"))      s_life_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "mask_temperature")) s_mask_temperature = state::patchFloat(i);
    else if (state::pathIs(path, plen, "width"))            s_width = state::patchFloat(i);
    else if (state::pathIs(path, plen, "height"))           s_height = state::patchFloat(i);
    else if (state::pathIs(path, plen, "width_jitter"))     s_width_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "height_jitter"))    s_height_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "global_scale"))     s_global_scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "rotation"))         s_rotation_deg = state::patchFloat(i);
    else if (state::pathIs(path, plen, "rotation_jitter"))  s_rotation_jitter_deg = state::patchFloat(i);
    else if (state::pathIs(path, plen, "shape_kind"))       s_shape_kind = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "shape_param"))      s_shape_param = state::patchFloat(i);
    else if (state::pathIs(path, plen, "alpha_curve"))      s_alpha_curve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "frame_alpha_jitter")) s_frame_alpha_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "global_color")) {
      auto v = state::patchVec3(i);
      s_global_color_r = v.x; s_global_color_g = v.y; s_global_color_b = v.z;
    }
    else if (state::pathIs(path, plen, "color_blend"))        s_color_blend = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hue_jitter"))         s_hue_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "brightness_jitter"))  s_brightness_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "saturation_jitter"))  s_saturation_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "alpha_jitter"))       s_alpha_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "blend_mode"))         s_blend_mode = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "input_alpha"))        s_input_alpha = state::patchFloat(i);
    else if (state::pathIs(path, plen, "exposure"))           s_exposure = state::patchFloat(i);
    else if (state::pathIs(path, plen, "color_alpha"))        s_color_alpha = state::patchFloat(i);
    else if (state::pathIs(path, plen, "motion_strength"))    s_motion_strength = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Mask falls back to the color input when no secondary mask is wired.
  auto mask = gpu::Device::textureForField("mask_in");
  if (!mask.valid()) mask = in;

  bool emit_motion = state::isOutputConnected("render_outputs");
  if (emit_motion) {
    if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
      s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s_motion_w = vp_w;
      s_motion_h = vp_h;
      if (s_motion_tex.valid()) {
        state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
      }
    }
    if (!s_motion_tex.valid()) emit_motion = false;
  }

  auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
  if (!upstream.valid()) {
    if (!s_zero_motion_tex.valid()) {
      s_zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
    }
    upstream = s_zero_motion_tex;
  }

  s_frame_index++;

  // ---- Update uniforms ----
  UpdateUniforms uu = {};
  uu.count               = (uint32_t)s_count;
  uu.frame_index         = s_frame_index;
  uu.dt                  = (float)host::deltaTime();
  uu.mask_temperature    = s_mask_temperature;
  uu.life                = s_life;
  uu.respawn_delay       = s_respawn_delay;
  uu.life_jitter         = s_life_jitter;
  uu.width               = s_width;
  uu.height              = s_height;
  uu.global_scale        = s_global_scale;
  uu.width_jitter        = s_width_jitter;
  uu.height_jitter       = s_height_jitter;
  uu.rotation_rad        = s_rotation_deg * DEG2RAD;
  uu.rotation_jitter_rad = s_rotation_jitter_deg * DEG2RAD;
  uu.hue_jitter          = s_hue_jitter;
  uu.brightness_jitter   = s_brightness_jitter;
  uu.saturation_jitter   = s_saturation_jitter;
  uu.alpha_jitter        = s_alpha_jitter;
  s_update_uniforms.writeOne(uu);

  PrefillUniforms pu_color  = { s_input_alpha, s_input_alpha, s_input_alpha, 1.0f };
  PrefillUniforms pu_motion = { 1.0f, 1.0f, 1.0f, 1.0f };
  s_prefill_color_uniforms.writeOne(pu_color);
  s_prefill_motion_uniforms.writeOne(pu_motion);

  // Aspect normalization for "isotropic uv" rendering.
  float min_dim = float(vp_w < vp_h ? vp_w : vp_h);
  VsUniforms vu = { min_dim / float(vp_w), min_dim / float(vp_h), 0.f, 0.f };
  s_vs_uniforms.writeOne(vu);

  ColorUniforms cu = {};
  cu.input_alpha        = s_input_alpha;
  cu.color_blend        = s_color_blend;
  cu.global_color_r     = s_global_color_r;
  cu.global_color_g     = s_global_color_g;
  cu.global_color_b     = s_global_color_b;
  cu.alpha_curve        = s_alpha_curve;
  cu.frame_alpha_jitter = s_frame_alpha_jitter;
  cu.frame_index        = s_frame_index;
  cu.shape_kind         = (uint32_t)s_shape_kind;
  cu.shape_param        = s_shape_param;
  cu.exposure           = s_exposure;
  cu.color_alpha        = s_color_alpha;
  s_color_uniforms.writeOne(cu);

  MotionUniforms mu = {};
  mu.motion_strength = s_motion_strength;
  mu.shape_kind      = (uint32_t)s_shape_kind;
  mu.shape_param     = s_shape_param;
  mu.alpha_curve     = s_alpha_curve;
  s_motion_uniforms.writeOne(mu);

  // ---- Pass 1: update particles ----
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_update);
    cp.setBuffer(s_particle_buf, 0);
    cp.setTexture(mask, 1, 0);
    cp.setTexture(in,   2, 0);
    cp.setSampler(s_sampler, 3);
    cp.setBuffer(s_update_uniforms, 4);
    int groups = (s_count + 63) / 64;
    cp.dispatch(groups, 1, 1);
    cp.end();
  }

  // ---- Pass 2: pre-fill color (tex_in × input_alpha → tex_out) ----
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_prefill_color_uniforms, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // ---- Pass 3: pre-fill motion (upstream → motionTex) ----
  if (emit_motion) {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill_motion);
    cp.setTexture(upstream,    0, 0);
    cp.setTexture(s_motion_tex, 1, 1);
    cp.setBuffer(s_prefill_motion_uniforms, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // ---- Pass 4: color raster (instanced quads, blend over pre-filled tex_out) ----
  // Skipped at color_alpha=0 — every fragment would output alpha=0 and
  // contribute nothing under either blend mode, so save the draw.
  // tex_out keeps the pre-filled `tex_in × input_alpha` content.
  if (s_color_alpha > 0.0f) {
    auto rp = gpu::RenderPass::beginLoad(out);
    auto pso = (s_blend_mode == BLEND_ADD) ? s_pso_render_add : s_pso_render_alpha;
    rp.setPSO(pso);
    rp.setBuffer(s_particle_buf, 0);
    rp.setBuffer(s_vs_uniforms,  1);
    rp.setBuffer(s_color_uniforms, 2);
    rp.draw(6, s_count);
    rp.end();
  }

  // ---- Pass 5: motion raster (only when downstream consumes the rail) ----
  if (emit_motion) {
    auto rp = gpu::RenderPass::beginLoad(s_motion_tex);
    rp.setPSO(s_pso_render_motion);
    rp.setBuffer(s_particle_buf,   0);
    rp.setBuffer(s_vs_uniforms,    1);
    rp.setBuffer(s_motion_uniforms, 2);
    rp.draw(6, s_count);
    rp.end();
  }

  gpu::Device::submit();
}

} // namespace flash_particles
