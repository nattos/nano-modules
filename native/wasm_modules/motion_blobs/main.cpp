/*
 * gen.motion_blobs — pool of traveling soft blobs that emit motion
 * vectors and/or color darkening configurably. Replaces the original
 * placeholders fx.directional_blur, fx.zoom_blur, fx.shadow_flyover —
 * same blob field drives both outputs independently via
 * `motion_strength` and `shadow_darkness`.
 *
 * Common combinations:
 *   motion_strength=1.0, shadow_darkness=0.0  → motion rain (invisible blobs)
 *   motion_strength=0.0, shadow_darkness=0.7  → shadow flyover
 *   motion_strength=0.5, shadow_darkness=0.5  → cinematic shadow with motion blur
 *
 * Blob lifecycle:
 *   - Spawn on configurable edge (top/bottom/left/right), or random
 *     edge per spawn when spawn_edge_random is on.
 *   - Velocity has traverse (perpendicular INTO canvas) + drift
 *     (parallel to edge, jittered).
 *   - Position spawns just outside the canvas at spawn_offset (negative).
 *   - Die when blob exits the OPPOSITE side; respawn only while
 *     alive_count < density * blob_count_max.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "motion_blobs_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace motion_blobs {

enum SpawnEdge : int { EDGE_TOP = 0, EDGE_BOTTOM = 1, EDGE_LEFT = 2, EDGE_RIGHT = 3 };
static constexpr int MAX_BLOBS = 32;

struct CpuBlob {
  bool   alive;
  float  x, y;
  float  vx, vy;
  float  radius;          // cover-square units
};

struct GpuBlob {
  float x; float y;
  float vx; float vy;
  float radius;
  float _pp0; float _pp1; float _pp2;
};
static_assert(sizeof(GpuBlob) == 32, "GpuBlob layout mismatch");

struct Uniforms {
  float motion_strength;
  float shadow_darkness;
  float softness_curve;
  float _pad0;

  float shadow_r; float shadow_g; float shadow_b; float _pad1;
  float aspect_x; float aspect_y; float _pad2; float _pad3;

  uint32_t active_count;
  uint32_t debug_show_blobs;
  uint32_t _pad4;
  uint32_t _pad5;
};
static_assert(sizeof(Uniforms) == 64, "Uniforms layout mismatch");

// --- GPU resources ---
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_uniform_buf;
static gpu::Buffer     s_blob_buf;
static gpu::Texture    s_motion_tex;
static gpu::Texture    s_zero_motion_tex;
static int             s_motion_w = 0;
static int             s_motion_h = 0;
static bool            s_initialized = false;

// --- Schema-mirrored params (standard) ---
static float s_density               = 0.4f;
static float s_traverse_speed        = 0.7f;
static float s_traverse_speed_jitter = 0.5f;
static float s_drift                 = 0.0f;
static float s_motion_strength       = 1.0f;
static float s_shadow_darkness       = 0.0f;
static float s_shadow_tint_r         = 0.0f;
static float s_shadow_tint_g         = 0.0f;
static float s_shadow_tint_b         = 0.0f;
static float s_blob_size             = 0.12f;
static int   s_spawn_edge            = EDGE_TOP;
// --- Tuning ---
static int   s_blob_count_max        = 8;
static float s_blob_size_jitter      = 0.3f;
static float s_drift_jitter          = 0.1f;
static float s_softness_curve        = 4.0f;
static float s_spawn_offset          = -0.05f;
static bool  s_spawn_edge_random     = false;
static int   s_seed                  = 0x82C00L;
// --- Debug ---
static bool  s_debug_show_blobs      = false;

// --- Runtime ---
static CpuBlob s_blobs[MAX_BLOBS];
static uint32_t s_spawn_rng = 0x82C00LU;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline int clampi(int v, int lo, int hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u; return s;
}
static inline float lcg_unit(uint32_t& s) {
  return (lcg_next(s) >> 8) * (1.0f / (float)(1u << 24));
}
static inline float lcg_signed(uint32_t& s) { return lcg_unit(s) * 2.0f - 1.0f; }

static void spawn_one(CpuBlob& b) {
  int edge = s_spawn_edge;
  if (s_spawn_edge_random) {
    edge = (int)(lcg_unit(s_spawn_rng) * 4.0f);
    if (edge > 3) edge = 3;
  }
  float along  = lcg_unit(s_spawn_rng);                                          // [0, 1) along the edge
  float speed  = s_traverse_speed * (1.0f + clampf(s_traverse_speed_jitter, 0.0f, 1.0f) * lcg_signed(s_spawn_rng));
  float drift  = s_drift + clampf(s_drift_jitter, 0.0f, 1.0f) * lcg_signed(s_spawn_rng);
  float size   = s_blob_size * (1.0f + clampf(s_blob_size_jitter, 0.0f, 1.0f) * lcg_signed(s_spawn_rng));
  if (size < 1e-4f) size = 1e-4f;
  float off    = clampf(s_spawn_offset, -0.5f, 0.0f);   // negative → just outside

  switch (edge) {
    case EDGE_TOP:    b.x = along; b.y = off;            b.vx = drift; b.vy = +speed; break;
    case EDGE_BOTTOM: b.x = along; b.y = 1.0f - off;     b.vx = drift; b.vy = -speed; break;
    case EDGE_LEFT:   b.x = off;          b.y = along;   b.vx = +speed; b.vy = drift; break;
    case EDGE_RIGHT:  b.x = 1.0f - off;   b.y = along;   b.vx = -speed; b.vy = drift; break;
  }
  b.radius = size;
  b.alive = true;
}

void init() {
  s_initialized = false;
  s_motion_w = 0; s_motion_h = 0;
  for (int i = 0; i < MAX_BLOBS; i++) {
    s_blobs[i].alive = false;
    s_blobs[i].x = s_blobs[i].y = 0.5f;
    s_blobs[i].vx = s_blobs[i].vy = 0.0f;
    s_blobs[i].radius = 0.0f;
  }
  s_spawn_rng = (uint32_t)s_seed ^ 0xBADBA110u;

  state::init("gen.motion_blobs", {1, 0, 0},
    state::Schema()
      // --- Standard ---
      .floatField("density",               0.4f,  0.0f, 1.0f,    state::PrimaryInput)
      .floatField("traverse_speed",        0.7f,  0.0f, 3.0f,    state::PrimaryInput)
      .floatField("traverse_speed_jitter", 0.5f,  0.0f, 1.0f,    state::PrimaryInput)
      .floatField("drift",                 0.0f, -1.0f, 1.0f,    state::PrimaryInput)
      .floatField("motion_strength",       1.0f,  0.0f, 2.0f,    state::PrimaryInput)
      .floatField("shadow_darkness",       0.0f,  0.0f, 1.0f,    state::PrimaryInput)
      .rgbField  ("shadow_tint",           0.0f,  0.0f, 0.0f,    state::PrimaryInput)
      .floatField("blob_size",             0.12f, 0.0f, 0.4f,    state::PrimaryInput)
      .selectField("spawn_edge",           EDGE_TOP, state::PrimaryInput,
                   {{"Top", 0}, {"Bottom", 1}, {"Left", 2}, {"Right", 3}})
      // --- Tuning ---
      .intField  ("blob_count_max",        8, 1, MAX_BLOBS,      state::PrimaryInput)
      .floatField("blob_size_jitter",      0.3f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("drift_jitter",          0.1f, 0.0f, 0.5f,     state::PrimaryInput)
      .floatField("softness_curve",        4.0f, 1.0f, 16.0f,    state::PrimaryInput)
      .floatField("spawn_offset",          -0.05f, -0.5f, 0.0f,  state::PrimaryInput)
      .boolField ("spawn_edge_random",     false,                state::PrimaryInput)
      .intField  ("seed",                  0x82C00, 0, 0x7FFFFFFF, state::PrimaryInput)
      // --- Debug ---
      .boolField ("debug_show_blobs",      false,                state::PrimaryInput)
      // --- I/O ---
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("motion_blobs_color", COLOR_SPV, COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_blobs_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_blobs_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_blobs_motion");
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
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms),         gpu::BufferUsage::Uniform);
  s_blob_buf    = gpu::Device::createBuffer(sizeof(GpuBlob) * MAX_BLOBS, gpu::BufferUsage::Storage);
  s_initialized = true;
  state::log("motion_blobs: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;

  int cap = clampi(s_blob_count_max, 1, MAX_BLOBS);
  int target_alive = (int)std::round(clampf(s_density, 0.0f, 1.0f) * (float)cap);
  if (target_alive < 0) target_alive = 0;

  // 1. Integrate live blobs; cull when they've crossed the opposite side.
  int alive_count = 0;
  float fdt = (float)dt;
  for (int i = 0; i < cap; i++) {
    CpuBlob& b = s_blobs[i];
    if (!b.alive) continue;
    b.x += b.vx * fdt;
    b.y += b.vy * fdt;
    // Cull when out by more than 1 + radius_uv_estimate. Use 0.5 as a
    // loose bound (cover-square radius is comparable to uv at low aspect).
    float margin = b.radius + 0.5f;
    if (b.x < -margin || b.x > 1.0f + margin
        || b.y < -margin || b.y > 1.0f + margin) {
      b.alive = false;
      continue;
    }
    alive_count++;
  }
  for (int i = cap; i < MAX_BLOBS; i++) s_blobs[i].alive = false;

  // 2. Respawn dead blobs up to target_alive.
  for (int i = 0; i < cap && alive_count < target_alive; i++) {
    CpuBlob& b = s_blobs[i];
    if (b.alive) continue;
    spawn_one(b);
    alive_count++;
  }
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];

    if      (state::pathIs(path, plen, "density"))               s_density               = state::patchFloat(i);
    else if (state::pathIs(path, plen, "traverse_speed"))        s_traverse_speed        = state::patchFloat(i);
    else if (state::pathIs(path, plen, "traverse_speed_jitter")) s_traverse_speed_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift"))                 s_drift                 = state::patchFloat(i);
    else if (state::pathIs(path, plen, "motion_strength"))       s_motion_strength       = state::patchFloat(i);
    else if (state::pathIs(path, plen, "shadow_darkness"))       s_shadow_darkness       = state::patchFloat(i);
    else if (state::pathIs(path, plen, "shadow_tint")) {
      auto v = state::patchVec3(i);
      s_shadow_tint_r = v.x; s_shadow_tint_g = v.y; s_shadow_tint_b = v.z;
    }
    else if (state::pathIs(path, plen, "blob_size"))             s_blob_size             = state::patchFloat(i);
    else if (state::pathIs(path, plen, "spawn_edge"))            s_spawn_edge            = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "blob_count_max"))        s_blob_count_max        = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "blob_size_jitter"))      s_blob_size_jitter      = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_jitter"))          s_drift_jitter          = state::patchFloat(i);
    else if (state::pathIs(path, plen, "softness_curve"))        s_softness_curve        = state::patchFloat(i);
    else if (state::pathIs(path, plen, "spawn_offset"))          s_spawn_offset          = state::patchFloat(i);
    else if (state::pathIs(path, plen, "spawn_edge_random"))     s_spawn_edge_random     = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "seed")) {
      int v = (int)state::patchFloat(i);
      if (v != s_seed) {
        s_seed = v;
        s_spawn_rng = (uint32_t)v ^ 0xBADBA110u;
      }
    }
    else if (state::pathIs(path, plen, "debug_show_blobs"))      s_debug_show_blobs      = state::patchFloat(i) != 0.0f;
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Pack blobs.
  GpuBlob gpu_blobs[MAX_BLOBS] = {};
  int active_count = 0;
  int cap = clampi(s_blob_count_max, 1, MAX_BLOBS);
  for (int i = 0; i < cap; i++) {
    const CpuBlob& b = s_blobs[i];
    if (!b.alive) continue;
    GpuBlob& g = gpu_blobs[active_count++];
    g.x = b.x; g.y = b.y;
    g.vx = b.vx; g.vy = b.vy;
    g.radius = b.radius;
  }
  s_blob_buf.writeBytes(gpu_blobs, (int)sizeof(GpuBlob) * MAX_BLOBS);

  // Uniforms (aspect-aware blob math).
  auto cs = fx::coverSquare(vp_w, vp_h);
  Uniforms u = {};
  u.motion_strength = clampf(s_motion_strength, 0.0f, 4.0f);
  u.shadow_darkness = clampf(s_shadow_darkness, 0.0f, 1.0f);
  u.softness_curve  = clampf(s_softness_curve,  0.1f, 64.0f);
  u.shadow_r = s_shadow_tint_r;
  u.shadow_g = s_shadow_tint_g;
  u.shadow_b = s_shadow_tint_b;
  u.aspect_x = cs.ax;
  u.aspect_y = cs.ay;
  u.active_count = (uint32_t)active_count;
  u.debug_show_blobs = s_debug_show_blobs ? 1u : 0u;
  s_uniform_buf.writeOne(u);

  // Color pass — always run; with shadow_darkness == 0 it produces
  // tex_in unchanged.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.setBuffer(s_blob_buf,    3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Motion pass — skip when nothing downstream is listening.
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
        cp.setBuffer(s_blob_buf,    3);
        cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
        cp.end();
      }
    }
  }

  gpu::Device::submit();
}

} // namespace motion_blobs
