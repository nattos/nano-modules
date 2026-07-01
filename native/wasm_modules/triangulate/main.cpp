/*
 * filter.mesh.triangulate — "Triangulate".
 *
 * Renders a Delaunay triangulation that FOLLOWS THE TOPOLOGY of an input's
 * density: ridgelines first, then corners, then filling voids. Built entirely
 * on the GPU.
 *
 * Pipeline (per frame, all at an internal proc resolution except present):
 *   downsample → blur → feature (importance field W)
 *   → JFA Voronoi (init, splat, log2 steps)
 *   → score (per-cell mass / centroid / argmax-importance candidate)
 *   → present (input / debug map / mesh) — reads this frame's consistent state
 *   → takeover (stochastic confidence-gated teleport — updates seeds for NEXT
 *               frame; seeds are LOCKED and only jump when a candidate is
 *               confidently a better match → no continuous drift, no swim).
 *
 * P2 status: feature maps + JFA Voronoi + stochastic-takeover seed dynamics.
 * The Delaunay mesh (triple-point edges → instanced lines) lands in P3; for now
 * `present` shows the input, a debug map, the Voronoi cells, or the seed points.
 */

#include <gpu.h>
#include <host.h>
#include <effect_blur.h>
#include "triangulate_shaders.h"

#include <cstdint>
#include <cmath>

namespace triangulate {

// ---- constants -------------------------------------------------------------
static constexpr int   MAX_SEEDS         = 4096;   // pool ceiling (10-bit-packed proc coords)
static constexpr int   PROC_MAX          = 640;    // internal long-edge cap (< 1024)
static constexpr int   MAX_JFA_STEPS     = 12;
static constexpr float FEATURE_BLUR_SCALE= 0.6f;
static constexpr float STENCIL_MAX_PX    = 7.0f;
static constexpr float RIDGE_GAIN        = 40.0f;
static constexpr float CORNER_GAIN       = 4000.0f;
static constexpr float POINT_RADIUS_UV   = 0.006f;

// ---- uniform layouts (must match the HLSL cbuffers) ------------------------
struct FeatureUniforms {
  float ridge_w, corner_w, void_w, stencil;
  float ridge_gain, corner_gain, _p0, _p1;
};
struct SplatUniforms { uint32_t count, w, h, _p; };
struct StepUniforms  { int32_t step; uint32_t w, h; float aspect; };
struct ClearUniforms { uint32_t count, _p0, _p1, _p2; };
struct ScoreUniforms { uint32_t w, h; float _p0, _p1; };
struct TakeoverUniforms {
  uint32_t count, w, h, frame;
  float dt, churn, confidence, aspect;
  uint32_t mode, _p0, _p1, _p2;
};
struct PresentUniforms {
  uint32_t debug_view, bg_mode, proc_w, proc_h;
  float aspect, point_r; uint32_t count, _p0;
};

// ---- per-instance state ----------------------------------------------------
struct State {
  // GPU-resident pool + accumulators.
  gpu::Buffer seed_buf;      // Seed[MAX_SEEDS]
  gpu::Buffer accum_buf;     // uint[MAX_SEEDS * 4]

  // Uniform buffers (one write per pass, per frame).
  gpu::Buffer feature_buf, splat_buf, clear_buf, score_buf, takeover_buf, present_buf;
  gpu::Buffer step_buf[MAX_JFA_STEPS];

  // Textures (proc-res unless noted).
  gpu::Texture small_tex;    // RGBA8 downsampled input
  gpu::Texture blur_tex;     // RGBA8 blurred
  gpu::Texture feat_tex;     // RGBA16F feature/importance field
  gpu::Texture jfa_a, jfa_b; // R32F seed-id ping-pong
  gpu::Sampler sampler;
  int proc_w = 0, proc_h = 0;

  uint32_t frame = 0;
  bool initialized = false;
  bool seeded = false;

  // Schema-mirrored params.
  float density = 0.3f, ridge_weight = 0.6f, corner_weight = 0.3f, void_weight = 0.2f;
  float churn = 0.3f, line_width = 0.3f;
  float line_r = 1.f, line_g = 1.f, line_b = 1.f;
  float feature_scale = 0.4f, confidence = 0.4f;
  int   scoring_mode = 0, bg_mode = 1;
  float fill_opacity = 0.0f, quality = 0.3f;
  int   debug_view = 0;
};

// ---- type-shared PSOs ------------------------------------------------------
static gpu::ComputePSO s_pso_downsample, s_pso_feature, s_pso_jfa_init,
                       s_pso_jfa_splat, s_pso_jfa_step, s_pso_score_clear,
                       s_pso_score, s_pso_takeover, s_pso_present;
static fx::GaussianBlur s_blur;

void module_init() {
  state::init("filter.mesh.triangulate", {1, 0, 0},
    state::Schema()
      .floatField("density",      0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Mesh density — how many seed points populate the triangulation.")
      .floatField("ridge_weight", 0.6f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "How strongly seeds are pulled onto ridgelines.")
      .floatField("corner_weight",0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "How strongly seeds are pulled onto corners / maxima.")
      .floatField("void_weight",  0.2f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Baseline coverage of low-feature density (general fill).")
      .floatField("churn",        0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Stochastic-takeover rate — how eagerly mismatched vertices jump (0 = frozen).")
      .floatField("line_width",   0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Triangulation edge thickness.")
      .rgbField  ("line_color",   1.f, 1.f, 1.f, state::PrimaryInput)

      .floatField("feature_scale",0.4f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Smoothing radius applied before derivatives (larger = coarser features).")
      .floatField("confidence",   0.4f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Takeover margin — a candidate must beat the incumbent by this much to displace it (higher = crisper/stiller).")
      .selectField("scoring_mode", 0, state::SecondaryInput,
                   {{"Cell Residual", 0}, {"Feature Weight", 1}, {"Weight + Blue-noise", 2}},
                   false, "What defines 'a better match' for a takeover candidate.")
      .selectField("bg_mode", 1, state::SecondaryInput,
                   {{"Input", 0}, {"Dark", 1}, {"Feature", 2}},
                   false, "Backdrop the mesh is drawn over.")
      .floatField("fill_opacity", 0.0f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Opacity of solid triangle fills (0 = wireframe only).")
      .floatField("quality",      0.3f, 0.05f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Blur sample density for the feature pass (tuning).")

      .selectField("debug_view", 0, state::SecondaryInput,
                   {{"Off", 0}, {"Density", 1}, {"Ridge", 2}, {"Corner", 3},
                    {"Importance", 4}, {"Voronoi", 5}, {"Points", 6}},
                   true, "Visualize an internal stage instead of the mesh.")

      .capability(state::Capability::SeekableApproximate)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("triangulate_downsample", DOWNSAMPLE_SPV, DOWNSAMPLE_SPV_SIZE, "rgba8unorm", "write");
  state::registerShaderSPV("triangulate_feature",    FEATURE_SPV,    FEATURE_SPV_SIZE,    "rgba16float", "write");
  state::registerShaderSPV("triangulate_jfa_init",   JFA_INIT_SPV,   JFA_INIT_SPV_SIZE,   "r32float", "write");
  state::registerShaderSPV("triangulate_jfa_splat",  JFA_SPLAT_SPV,  JFA_SPLAT_SPV_SIZE,  "r32float", "write");
  state::registerShaderSPV("triangulate_jfa_step",   JFA_STEP_SPV,   JFA_STEP_SPV_SIZE,   "r32float", "write");
  state::registerShaderSPV("triangulate_score_clear",SCORE_CLEAR_SPV,SCORE_CLEAR_SPV_SIZE);
  state::registerShaderSPV("triangulate_score",      SCORE_SPV,      SCORE_SPV_SIZE);
  state::registerShaderSPV("triangulate_takeover",   TAKEOVER_SPV,   TAKEOVER_SPV_SIZE);
  state::registerShaderSPV("triangulate_present",    PRESENT_SPV,    PRESENT_SPV_SIZE);

  auto cs_ds  = gpu::Device::createShaderModuleByName("triangulate_downsample");
  auto cs_ft  = gpu::Device::createShaderModuleByName("triangulate_feature");
  auto cs_ji  = gpu::Device::createShaderModuleByName("triangulate_jfa_init");
  auto cs_jp  = gpu::Device::createShaderModuleByName("triangulate_jfa_splat");
  auto cs_js  = gpu::Device::createShaderModuleByName("triangulate_jfa_step");
  auto cs_sc  = gpu::Device::createShaderModuleByName("triangulate_score_clear");
  auto cs_s   = gpu::Device::createShaderModuleByName("triangulate_score");
  auto cs_tk  = gpu::Device::createShaderModuleByName("triangulate_takeover");
  auto cs_pr  = gpu::Device::createShaderModuleByName("triangulate_present");
  if (!cs_ds || !cs_ft || !cs_ji || !cs_jp || !cs_js || !cs_sc || !cs_s || !cs_tk || !cs_pr) return;

  s_pso_downsample = gpu::Device::createComputePSO(cs_ds, "main", gpu::Bindings()
      .tex2d(0).sampler(1).storageTex2d(2, gpu::TextureFormat::RGBA8));
  s_pso_feature = gpu::Device::createComputePSO(cs_ft, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA16F).uniform(2));
  s_pso_jfa_init = gpu::Device::createComputePSO(cs_ji, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::R32F));
  s_pso_jfa_splat = gpu::Device::createComputePSO(cs_jp, "main", gpu::Bindings()
      .storage(0).storageTex2d(1, gpu::TextureFormat::R32F).uniform(2));
  s_pso_jfa_step = gpu::Device::createComputePSO(cs_js, "main", gpu::Bindings()
      .tex2d(0).storage(1).storageTex2d(2, gpu::TextureFormat::R32F).uniform(3));
  s_pso_score_clear = gpu::Device::createComputePSO(cs_sc, "main", gpu::Bindings()
      .storageRW(0).uniform(1));
  s_pso_score = gpu::Device::createComputePSO(cs_s, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).storageRW(2).uniform(3));
  s_pso_takeover = gpu::Device::createComputePSO(cs_tk, "main", gpu::Bindings()
      .storage(0).tex2d(1).storageRW(2).uniform(3));
  s_pso_present = gpu::Device::createComputePSO(cs_pr, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).tex2d(2).storage(3).storageTex2d(4, gpu::TextureFormat::RGBA8).uniform(5));
  s_blur.init();

  state::log("triangulate: module initialized");
}

void* create() {
  auto* s = new State();
  s->seed_buf  = gpu::Device::createBuffer(sizeof(float) * 4 * MAX_SEEDS, gpu::BufferUsage::Storage);
  s->accum_buf = gpu::Device::createBuffer(sizeof(uint32_t) * 4 * MAX_SEEDS, gpu::BufferUsage::Storage);
  s->feature_buf  = gpu::Device::createBuffer(sizeof(FeatureUniforms),  gpu::BufferUsage::Uniform);
  s->splat_buf    = gpu::Device::createBuffer(sizeof(SplatUniforms),    gpu::BufferUsage::Uniform);
  s->clear_buf    = gpu::Device::createBuffer(sizeof(ClearUniforms),    gpu::BufferUsage::Uniform);
  s->score_buf    = gpu::Device::createBuffer(sizeof(ScoreUniforms),    gpu::BufferUsage::Uniform);
  s->takeover_buf = gpu::Device::createBuffer(sizeof(TakeoverUniforms), gpu::BufferUsage::Uniform);
  s->present_buf  = gpu::Device::createBuffer(sizeof(PresentUniforms),  gpu::BufferUsage::Uniform);
  for (int i = 0; i < MAX_JFA_STEPS; i++)
    s->step_buf[i] = gpu::Device::createBuffer(sizeof(StepUniforms), gpu::BufferUsage::Uniform);
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->seed_buf.release(); s->accum_buf.release();
  s->feature_buf.release(); s->splat_buf.release(); s->clear_buf.release();
  s->score_buf.release(); s->takeover_buf.release(); s->present_buf.release();
  for (int i = 0; i < MAX_JFA_STEPS; i++) s->step_buf[i].release();
  if (s->small_tex.valid()) s->small_tex.release();
  if (s->blur_tex.valid())  s->blur_tex.release();
  if (s->feat_tex.valid())  s->feat_tex.release();
  if (s->jfa_a.valid())     s->jfa_a.release();
  if (s->jfa_b.valid())     s->jfa_b.release();
  s->sampler.release();
  delete s;
}

// Seed the pool with random positions (CPU, chunked to bound the wasm stack).
static void seed_pool(State* s) {
  if (!s->seed_buf.valid()) return;
  constexpr int CHUNK = 256;
  float buf[CHUNK * 4];
  uint32_t rng = 0x1234567u;
  auto next = [&]() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return (rng & 0xFFFFFF) / 16777216.0f; };
  for (int base = 0; base < MAX_SEEDS; base += CHUNK) {
    int n = (base + CHUNK <= MAX_SEEDS) ? CHUNK : (MAX_SEEDS - base);
    for (int j = 0; j < n; j++) {
      buf[j * 4 + 0] = next();  // pos.x
      buf[j * 4 + 1] = next();  // pos.y
      buf[j * 4 + 2] = 0.0f;    // score
      buf[j * 4 + 3] = 0.0f;    // flags
    }
    s->seed_buf.writeBytes(buf, sizeof(float) * 4 * n, sizeof(float) * 4 * base);
  }
  s->seeded = true;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_present.valid()) return;
  s->frame = 0;
  seed_pool(s);
  s->initialized = true;
}

void tick(void* self, double dt) { (void)self; (void)dt; }

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "density"))       s->density       = state::patchFloat(i);
    else if (state::pathIs(p, l, "ridge_weight"))  s->ridge_weight  = state::patchFloat(i);
    else if (state::pathIs(p, l, "corner_weight")) s->corner_weight = state::patchFloat(i);
    else if (state::pathIs(p, l, "void_weight"))   s->void_weight   = state::patchFloat(i);
    else if (state::pathIs(p, l, "churn"))         s->churn         = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_width"))    s->line_width    = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_color"))  { auto v = state::patchVec3(i); s->line_r=v.x; s->line_g=v.y; s->line_b=v.z; }
    else if (state::pathIs(p, l, "feature_scale")) s->feature_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "confidence"))    s->confidence    = state::patchFloat(i);
    else if (state::pathIs(p, l, "scoring_mode"))  s->scoring_mode  = state::patchInt(i);
    else if (state::pathIs(p, l, "bg_mode"))       s->bg_mode       = state::patchInt(i);
    else if (state::pathIs(p, l, "fill_opacity"))  s->fill_opacity  = state::patchFloat(i);
    else if (state::pathIs(p, l, "quality"))       s->quality       = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_view"))    s->debug_view    = state::patchInt(i);
  }
}

static void ensureTextures(State* s, int vp_w, int vp_h) {
  // Proc resolution: cap the long edge at PROC_MAX, keep aspect.
  int longest = vp_w > vp_h ? vp_w : vp_h;
  float k = longest > PROC_MAX ? (float)PROC_MAX / (float)longest : 1.0f;
  int pw = (int)(vp_w * k); if (pw < 1) pw = 1;
  int ph = (int)(vp_h * k); if (ph < 1) ph = 1;
  if (s->small_tex.valid() && s->proc_w == pw && s->proc_h == ph) return;
  if (s->small_tex.valid()) s->small_tex.release();
  if (s->blur_tex.valid())  s->blur_tex.release();
  if (s->feat_tex.valid())  s->feat_tex.release();
  if (s->jfa_a.valid())     s->jfa_a.release();
  if (s->jfa_b.valid())     s->jfa_b.release();
  s->small_tex = gpu::Device::createTexture(pw, ph, gpu::TextureFormat::RGBA8);
  s->blur_tex  = gpu::Device::createTexture(pw, ph, gpu::TextureFormat::RGBA8);
  s->feat_tex  = gpu::Device::createTexture(pw, ph, gpu::TextureFormat::RGBA16F);
  s->jfa_a     = gpu::Device::createTexture(pw, ph, gpu::TextureFormat::R32F);
  s->jfa_b     = gpu::Device::createTexture(pw, ph, gpu::TextureFormat::R32F);
  s->proc_w = pw; s->proc_h = ph;
}

static inline int seed_count(const State* s) {
  int c = (int)lroundf(128.0f + s->density * (float)(MAX_SEEDS - 128));
  if (c < 16) c = 16;
  if (c > MAX_SEEDS) c = MAX_SEEDS;
  return c;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  ensureTextures(s, vp_w, vp_h);
  if (!s->feat_tex.valid()) return;

  const int pw = s->proc_w, ph = s->proc_h;
  const int pgx = (pw + 7) / 8, pgy = (ph + 7) / 8;
  const int count = seed_count(s);
  const int sgx = (count + 63) / 64;
  const float aspect = (float)pw / (float)ph;
  const float dt = (float)host::deltaTime();

  // 1. Downsample the input to proc resolution.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_downsample);
    cp.setTexture(in, 0, 0);
    cp.setSampler(s->sampler, 1);
    cp.setTexture(s->small_tex, 2, 1);
    cp.dispatch(pgx, pgy);
    cp.end();
  }

  // 2. Blur + feature maps → importance field.
  s_blur.applyWithRadius(s->small_tex, s->blur_tex, pw, ph,
                         s->feature_scale * FEATURE_BLUR_SCALE, s->quality);
  {
    FeatureUniforms fu = {};
    fu.ridge_w = s->ridge_weight; fu.corner_w = s->corner_weight; fu.void_w = s->void_weight;
    fu.stencil = 1.0f + s->feature_scale * STENCIL_MAX_PX;
    fu.ridge_gain = RIDGE_GAIN; fu.corner_gain = CORNER_GAIN;
    s->feature_buf.writeOne(fu);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_feature);
    cp.setTexture(s->blur_tex, 0, 0);
    cp.setTexture(s->feat_tex, 1, 1);
    cp.setBuffer(s->feature_buf, 2);
    cp.dispatch(pgx, pgy);
    cp.end();
  }

  // 3. JFA Voronoi over the seed pool. init(jfa_a) → splat(jfa_a) → ping-pong.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_jfa_init);
    cp.setTexture(s->jfa_a, 0, 1);
    cp.dispatch(pgx, pgy);
    cp.end();
  }
  {
    SplatUniforms su = { (uint32_t)count, (uint32_t)pw, (uint32_t)ph, 0 };
    s->splat_buf.writeOne(su);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_jfa_splat);
    cp.setBuffer(s->seed_buf, 0);
    cp.setTexture(s->jfa_a, 1, 1);
    cp.setBuffer(s->splat_buf, 2);
    cp.dispatch(sgx, 1);
    cp.end();
  }
  gpu::Texture* src = &s->jfa_a;
  gpu::Texture* dst = &s->jfa_b;
  int longest = pw > ph ? pw : ph;
  int step0 = 1; while (step0 * 2 < longest) step0 *= 2;
  int sidx = 0;
  for (int step = step0; step >= 1 && sidx < MAX_JFA_STEPS; step >>= 1, ++sidx) {
    StepUniforms st = { step, (uint32_t)pw, (uint32_t)ph, aspect };
    s->step_buf[sidx].writeOne(st);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_jfa_step);
    cp.setTexture(*src, 0, 0);
    cp.setBuffer(s->seed_buf, 1);
    cp.setTexture(*dst, 2, 1);
    cp.setBuffer(s->step_buf[sidx], 3);
    cp.dispatch(pgx, pgy);
    cp.end();
    gpu::Texture* t = src; src = dst; dst = t;
  }
  gpu::Texture* id_tex = src;  // final nearest-seed id texture

  // 4. Score: clear accumulators, then scatter per-cell mass/centroid/candidate.
  {
    ClearUniforms cu = { (uint32_t)count, 0, 0, 0 };
    s->clear_buf.writeOne(cu);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_score_clear);
    cp.setBuffer(s->accum_buf, 0);
    cp.setBuffer(s->clear_buf, 1);
    cp.dispatch(sgx, 1);
    cp.end();
  }
  {
    ScoreUniforms scu = { (uint32_t)pw, (uint32_t)ph, 0.f, 0.f };
    s->score_buf.writeOne(scu);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_score);
    cp.setTexture(*id_tex, 0, 0);
    cp.setTexture(s->feat_tex, 1, 0);
    cp.setBuffer(s->accum_buf, 2);
    cp.setBuffer(s->score_buf, 3);
    cp.dispatch(pgx, pgy);
    cp.end();
  }

  // 5. Present (uses this frame's consistent pre-takeover state).
  {
    PresentUniforms pu = {};
    pu.debug_view = (uint32_t)s->debug_view;
    pu.bg_mode = (uint32_t)s->bg_mode;
    pu.proc_w = (uint32_t)pw; pu.proc_h = (uint32_t)ph;
    pu.aspect = aspect; pu.point_r = POINT_RADIUS_UV;
    pu.count = (uint32_t)count;
    s->present_buf.writeOne(pu);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_present);
    cp.setTexture(s->feat_tex, 0, 0);
    cp.setTexture(in, 1, 0);
    cp.setTexture(*id_tex, 2, 0);
    cp.setBuffer(s->seed_buf, 3);
    cp.setTexture(out, 4, 1);
    cp.setBuffer(s->present_buf, 5);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // 6. Takeover: stochastic teleport of mismatched seeds — updates NEXT frame.
  {
    TakeoverUniforms tu = {};
    tu.count = (uint32_t)count; tu.w = (uint32_t)pw; tu.h = (uint32_t)ph; tu.frame = s->frame;
    tu.dt = dt; tu.churn = s->churn; tu.confidence = s->confidence;
    tu.aspect = aspect; tu.mode = (uint32_t)s->scoring_mode;
    s->takeover_buf.writeOne(tu);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_takeover);
    cp.setBuffer(s->accum_buf, 0);
    cp.setTexture(s->feat_tex, 1, 0);
    cp.setBuffer(s->seed_buf, 2);
    cp.setBuffer(s->takeover_buf, 3);
    cp.dispatch(sgx, 1);
    cp.end();
  }

  gpu::Device::submit();
  s->frame++;
}

} // namespace triangulate
