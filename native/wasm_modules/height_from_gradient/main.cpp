/*
 * video.height_from_gradient — GPU gradient-domain height reconstruction.
 *
 * Synthesizes a 2D gradient field from the input, takes its divergence, and
 * solves the Poisson equation laplacian(h) = div(g) for the least-squares
 * height whose gradient best matches g — then visualizes the reconstructed
 * surface as shaded 3D relief. v1 gradient source: Radial (outward from an
 * adjustable center, magnitude = luma). That field is generally non-
 * conservative (curl != 0), so there's usually no exact height; the Poisson
 * solve is the "best try."
 *
 * Solver: coarse-to-fine multigrid cascade (FMG-lite). Build a pre-scaled
 * divergence pyramid, Jacobi-solve the coarsest level from zero, prolong
 * (upsample) the result as the initial guess for the next finer level, and
 * repeat to full res. The pre-scaling (restrict = SUM of 2x2, see
 * common.hlsl) keeps the Jacobi stencil spacing-agnostic so one PSO serves
 * every level — and avoids per-level uniform changes, which WebGPU can't
 * honor between dispatches in a single submit.
 *
 * Pass pipeline (shared common.hlsl):
 *   gradient   — input → RG gradient field g (radial × luma).
 *   divergence — g → F_0 = div(g) (central differences, level-0 spacing).
 *   restrict   — F_k → F_{k+1} (2x2 sum; builds the pre-scaled pyramid).
 *   jacobi     — one relaxation sweep h' = (hL+hR+hD+hU - F)/4 (reused/level).
 *   prolong    — coarse h → fine initial guess (bilinear upsample).
 *   present    — height → hillshade / grayscale / normals (rgba8).
 *
 * Deterministic per-frame (no cross-frame state) → NO is_identity.
 * Freeform (multi-pass, pyramid, neighbor reads) → NO fusion.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "height_from_gradient_shaders.h"

#include <cmath>
#include <utility>

namespace height_from_gradient {

// 24 floats = 6 std140 rows = 96 bytes. Mirrors HFG_UNIFORMS in common.hlsl;
// only the gradient + present passes bind it.
struct Uniforms {
  float grad_gain;    float source;        float center_x;     float center_y;
  float aspect_x;     float aspect_y;      float present_mode; float relief_scale;
  float light_x;      float light_y;       float light_z;      float light_gain;
  float ambient;      float mix_amount;    float height_scale; float height_offset;
  float tint_r;       float tint_g;        float tint_b;       float debug_show_gradient;
  float core_radius;  float core_softness; float _pad0;        float _pad1;
};
static_assert(sizeof(Uniforms) == 96, "Uniforms layout mismatch");

// full / half / quarter / eighth. More levels = the low-frequency shape
// propagates globally in fewer fine-level iterations.
static constexpr int NUM_LEVELS = 4;

static constexpr float kPi = 3.14159265358979323846f;

struct State {
  gpu::Buffer  uniform_buf;
  gpu::Texture grad_tex;               // full-res gradient (RG)
  gpu::Texture div[NUM_LEVELS];        // pre-scaled divergence pyramid (R)
  gpu::Texture h_a[NUM_LEVELS];        // height ping-pong A (R)
  gpu::Texture h_b[NUM_LEVELS];        // height ping-pong B (R)
  int  tex_w = 0, tex_h = 0;
  bool initialized = false;

  // --- Schema-mirrored params ---
  int   source          = 0;       // 0 = Radial (only mode today)
  float center_x        = 0.0f;    // cover-square anchor
  float center_y        = 0.0f;
  float grad_gain       = 1.0f;
  float core_radius     = 0.12f;   // smoothed-core size around the anchor
  float core_softness   = 0.5f;    // transition feather of the core
  int   present_mode    = 0;        // 0 Hillshade, 1 Grayscale, 2 Normals
  float light_angle     = 0.375f;   // azimuth 0..1 → 0..2π (default ≈135° NW)
  float light_elevation = 0.5f;     // 0..1 → 0..π/2
  float relief_scale    = 0.4f;
  float mix_amount      = 0.0f;
  int   iterations      = 16;       // Jacobi sweeps per level
  float light_gain      = 1.0f;
  float ambient         = 0.15f;
  float tint_r          = 1.0f, tint_g = 1.0f, tint_b = 1.0f;
  float height_scale    = 1.0f;     // grayscale mode
  float height_offset   = 0.5f;
  bool  debug_show_gradient = false;
};

// Type-shared, compiled once in module_init().
static gpu::ComputePSO s_pso_gradient;
static gpu::ComputePSO s_pso_divergence;
static gpu::ComputePSO s_pso_restrict;
static gpu::ComputePSO s_pso_jacobi;
static gpu::ComputePSO s_pso_prolong;
static gpu::ComputePSO s_pso_present;

void module_init() {
  state::init("video.height_from_gradient", {1, 0, 0},
    state::Schema()
      // --- Standard (live) ---
      // Gradient source. v1: Radial — outward from `center`, magnitude = luma.
      // The switch is the seam for future arbitrary-topology generators.
      .selectField("source", 0, state::PrimaryInput, {{"Radial", 0}})
      // Radial center (cover-square anchor, aspect-correct; (0,0)=viewport
      // center, §1.5).
      .vec2Field("center", 0.0f, 0.0f, state::PrimaryInput, -1.0f, 1.0f)
      // Gradient magnitude scale (× luma).
      .floatField("grad_gain", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      // Core smoothing — tames the 1/r divergence singularity at the radial
      // anchor. `core_radius` sets the size of the flattened core (in cover-
      // square units); the field magnitude ramps from zero across it, turning
      // the spike into a smooth dome. 0 = off (raw spiky field).
      .floatField("core_radius", 0.12f, 0.0f, 1.0f, state::PrimaryInput)
      // How gradually the core's suppression feathers out (higher = wider,
      // softer transition).
      .floatField("core_softness", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // How to visualize the reconstructed height.
      .selectField("present_mode", 0, state::PrimaryInput,
                   {{"Hillshade", 0}, {"Grayscale", 1}, {"Normals", 2}})
      // Hillshade light azimuth (0..1 → full circle) and elevation
      // (0..1 → horizon→overhead).
      .floatField("light_angle", 0.375f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("light_elevation", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // Relief steepness — scales the surface slope used to build the normal.
      .floatField("relief_scale", 0.4f, 0.0f, 1.0f, state::PrimaryInput)
      // Cross-fade the visualization back toward the input image.
      .floatField("mix", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      // --- Tuning ---
      // Jacobi relaxation sweeps per pyramid level. More = closer to the true
      // least-squares solution (smoother, more global), at linear cost.
      .intField("iterations", 16, 1, 200, state::PrimaryInput)
      .floatField("light_gain", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("ambient", 0.15f, 0.0f, 1.0f, state::PrimaryInput)
      .rgbField("tint", 1.0f, 1.0f, 1.0f, state::PrimaryInput)
      // Grayscale-mode brightness mapping (height is defined up to a constant,
      // so its DC is user-dialed here).
      .floatField("height_scale", 1.0f, 0.0f, 8.0f, state::PrimaryInput)
      .floatField("height_offset", 0.5f, -1.0f, 1.0f, state::PrimaryInput)
      // --- Debug (last) ---
      .boolField("debug_show_gradient", false, state::PrimaryInput)
      // --- I/O ---
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Solver intermediates are RGBA16F (scalars in R — R32F can't be sampled as
  // Float on WebGPU); present writes rgba8 (default, no hint).
  state::registerShaderSPV("height_from_gradient_gradient",   GRADIENT_SPV,   GRADIENT_SPV_SIZE,   "rgba16float", "write");
  state::registerShaderSPV("height_from_gradient_divergence", DIVERGENCE_SPV, DIVERGENCE_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("height_from_gradient_restrict",   RESTRICT_SPV,   RESTRICT_SPV_SIZE,   "rgba16float", "write");
  state::registerShaderSPV("height_from_gradient_jacobi",     JACOBI_SPV,     JACOBI_SPV_SIZE,     "rgba16float", "write");
  state::registerShaderSPV("height_from_gradient_prolong",    PROLONG_SPV,    PROLONG_SPV_SIZE,    "rgba16float", "write");
  state::registerShaderSPV("height_from_gradient_present",    PRESENT_SPV,    PRESENT_SPV_SIZE);

  auto cs_gradient   = gpu::Device::createShaderModuleByName("height_from_gradient_gradient");
  auto cs_divergence = gpu::Device::createShaderModuleByName("height_from_gradient_divergence");
  auto cs_restrict   = gpu::Device::createShaderModuleByName("height_from_gradient_restrict");
  auto cs_jacobi     = gpu::Device::createShaderModuleByName("height_from_gradient_jacobi");
  auto cs_prolong    = gpu::Device::createShaderModuleByName("height_from_gradient_prolong");
  auto cs_present    = gpu::Device::createShaderModuleByName("height_from_gradient_present");
  if (!cs_gradient || !cs_divergence || !cs_restrict || !cs_jacobi ||
      !cs_prolong || !cs_present) return;

  s_pso_gradient = gpu::Device::createComputePSO(cs_gradient, "main", gpu::Bindings()
      .tex2d(0)                                       // input
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)   // gradient (RG)
      .uniform(2));

  s_pso_divergence = gpu::Device::createComputePSO(cs_divergence, "main", gpu::Bindings()
      .tex2d(0)                                       // gradient
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)); // divergence F_0

  s_pso_restrict = gpu::Device::createComputePSO(cs_restrict, "main", gpu::Bindings()
      .tex2d(0)                                       // finer F_k
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)); // coarser F_{k+1}

  s_pso_jacobi = gpu::Device::createComputePSO(cs_jacobi, "main", gpu::Bindings()
      .tex2d(0)                                       // current height
      .tex2d(1)                                       // pre-scaled divergence F
      .storageTex2d(2, gpu::TextureFormat::RGBA16F)); // next height

  s_pso_prolong = gpu::Device::createComputePSO(cs_prolong, "main", gpu::Bindings()
      .tex2d(0)                                       // coarse height
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)); // fine initial guess

  s_pso_present = gpu::Device::createComputePSO(cs_present, "main", gpu::Bindings()
      .tex2d(0)                                       // height (level 0)
      .tex2d(1)                                       // gradient (debug)
      .tex2d(2)                                       // input (mix)
      .storageTex2d(3, gpu::TextureFormat::RGBA8)     // tex_out
      .uniform(4));

  state::log("height_from_gradient: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->grad_tex.release();
  for (int l = 0; l < NUM_LEVELS; l++) {
    s->div[l].release();
    s->h_a[l].release();
    s->h_b[l].release();
  }
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  s->tex_w = 0;
  s->tex_h = 0;
  if (!s_pso_gradient.valid() || !s_pso_divergence.valid() ||
      !s_pso_restrict.valid() || !s_pso_jacobi.valid() ||
      !s_pso_prolong.valid() || !s_pso_present.valid()) return;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) { (void)self; (void)dt; }

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "source"))        s->source = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "center")) {
      auto v = state::patchVec2(i);
      s->center_x = v.x;
      s->center_y = v.y;
    }
    else if (state::pathIs(path, plen, "grad_gain"))     s->grad_gain = state::patchFloat(i);
    else if (state::pathIs(path, plen, "core_radius"))   s->core_radius = state::patchFloat(i);
    else if (state::pathIs(path, plen, "core_softness")) s->core_softness = state::patchFloat(i);
    else if (state::pathIs(path, plen, "present_mode"))  s->present_mode = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "light_angle"))   s->light_angle = state::patchFloat(i);
    else if (state::pathIs(path, plen, "light_elevation")) s->light_elevation = state::patchFloat(i);
    else if (state::pathIs(path, plen, "relief_scale"))  s->relief_scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "mix"))           s->mix_amount = state::patchFloat(i);
    else if (state::pathIs(path, plen, "iterations"))    s->iterations = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "light_gain"))    s->light_gain = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ambient"))       s->ambient = state::patchFloat(i);
    else if (state::pathIs(path, plen, "tint")) {
      auto v = state::patchVec3(i);
      s->tint_r = v.x;
      s->tint_g = v.y;
      s->tint_b = v.z;
    }
    else if (state::pathIs(path, plen, "height_scale"))  s->height_scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "height_offset")) s->height_offset = state::patchFloat(i);
    else if (state::pathIs(path, plen, "debug_show_gradient")) s->debug_show_gradient = state::patchFloat(i) != 0.0f;
  }
}

static inline int half_up(int x) { return (x + 1) / 2; }

// (Re)allocate the pyramid working set on viewport change. Every texture is
// fully written each frame before it's read (divergence → restrict → cleared
// coarse seed → prolong), so no clears are needed here.
static bool ensure_textures(State* s, int vp_w, int vp_h) {
  if (s->tex_w == vp_w && s->tex_h == vp_h && s->grad_tex.valid() &&
      s->div[0].valid() && s->h_a[0].valid() && s->h_b[0].valid())
    return true;

  s->grad_tex.release();
  for (int l = 0; l < NUM_LEVELS; l++) {
    s->div[l].release();
    s->h_a[l].release();
    s->h_b[l].release();
  }

  s->grad_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
  if (!s->grad_tex.valid()) return false;

  int lw = vp_w, lh = vp_h;
  for (int l = 0; l < NUM_LEVELS; l++) {
    s->div[l] = gpu::Device::createTexture(lw, lh, gpu::TextureFormat::RGBA16F);
    s->h_a[l] = gpu::Device::createTexture(lw, lh, gpu::TextureFormat::RGBA16F);
    s->h_b[l] = gpu::Device::createTexture(lw, lh, gpu::TextureFormat::RGBA16F);
    if (!s->div[l].valid() || !s->h_a[l].valid() || !s->h_b[l].valid()) return false;
    lw = half_up(lw);
    lh = half_up(lh);
  }

  s->tex_w = vp_w;
  s->tex_h = vp_h;
  return true;
}

// Mirror of local_delay's dispatch helper: up to 4 textures (slot = arg order,
// access 0=read/1=write) + an optional uniform buffer.
static inline void disp(const gpu::ComputePSO& pso, int w, int h,
                        const gpu::Texture* t0, int a0,
                        const gpu::Texture* t1, int a1,
                        const gpu::Texture* t2, int a2,
                        const gpu::Texture* t3, int a3,
                        const gpu::Buffer* ub, int ubslot) {
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(pso);
  if (t0) cp.setTexture(*t0, 0, a0);
  if (t1) cp.setTexture(*t1, 1, a1);
  if (t2) cp.setTexture(*t2, 2, a2);
  if (t3) cp.setTexture(*t3, 3, a3);
  if (ub) cp.setBuffer(*ub, ubslot);
  cp.dispatch((w + 7) / 8, (h + 7) / 8);
  cp.end();
}

// Run `iters` Jacobi sweeps at one pyramid level, ping-ponging h_a/h_b. The
// initial guess must already be in h_a[level]. Returns the texture holding the
// final estimate (parity depends on iters).
static gpu::Texture solve_level(State* s, int level, int w, int h, int iters) {
  gpu::Texture* cur = &s->h_a[level];
  gpu::Texture* nxt = &s->h_b[level];
  for (int i = 0; i < iters; i++) {
    disp(s_pso_jacobi, w, h, cur, 0, &s->div[level], 0, nxt, 1, nullptr, 0, nullptr, 0);
    std::swap(cur, nxt);
  }
  return *cur;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  if (!ensure_textures(s, vp_w, vp_h)) return;

  auto cs = fx::coverSquare(vp_w, vp_h);

  // Hillshade light direction from azimuth + elevation.
  float az = s->light_angle * 2.0f * kPi;
  float el = s->light_elevation * (kPi * 0.5f);
  float ce = std::cos(el);
  float lx = ce * std::cos(az);
  float ly = ce * std::sin(az);
  float lz = std::sin(el);

  Uniforms u = {
    s->grad_gain, (float)s->source, s->center_x, s->center_y,
    cs.ax, cs.ay, (float)s->present_mode, s->relief_scale,
    lx, ly, lz, s->light_gain,
    s->ambient, s->mix_amount, s->height_scale, s->height_offset,
    s->tint_r, s->tint_g, s->tint_b, s->debug_show_gradient ? 1.0f : 0.0f,
    s->core_radius, s->core_softness, 0.0f, 0.0f,
  };
  s->uniform_buf.writeOne(u);

  int iters = s->iterations;
  if (iters < 1) iters = 1;
  if (iters > 200) iters = 200;

  // Per-level dimensions (half_up cascade).
  int lw[NUM_LEVELS], lh[NUM_LEVELS];
  lw[0] = vp_w; lh[0] = vp_h;
  for (int l = 1; l < NUM_LEVELS; l++) {
    lw[l] = half_up(lw[l - 1]);
    lh[l] = half_up(lh[l - 1]);
  }

  // 1 — gradient: input → RG gradient field.
  disp(s_pso_gradient, vp_w, vp_h, &in, 0, &s->grad_tex, 1,
       nullptr, 0, nullptr, 0, &s->uniform_buf, 2);

  // 2 — divergence: g → F_0 (finest level).
  disp(s_pso_divergence, vp_w, vp_h, &s->grad_tex, 0, &s->div[0], 1,
       nullptr, 0, nullptr, 0, nullptr, 0);

  // 3 — restrict: build the pre-scaled divergence pyramid (2x2 sum).
  for (int k = 0; k < NUM_LEVELS - 1; k++) {
    disp(s_pso_restrict, lw[k + 1], lh[k + 1], &s->div[k], 0, &s->div[k + 1], 1,
         nullptr, 0, nullptr, 0, nullptr, 0);
  }

  // 4 — coarsest solve from a zero initial guess.
  int L = NUM_LEVELS - 1;
  gpu::Device::clear(s->h_a[L], 0.0f, 0.0f, 0.0f, 0.0f);
  gpu::Texture coarse = solve_level(s, L, lw[L], lh[L], iters);

  // 5 — cascade: prolong the coarse solution as the finer level's initial
  //     guess, then relax there. Repeat to full res.
  for (int k = L - 1; k >= 0; k--) {
    disp(s_pso_prolong, lw[k], lh[k], &coarse, 0, &s->h_a[k], 1,
         nullptr, 0, nullptr, 0, nullptr, 0);
    coarse = solve_level(s, k, lw[k], lh[k], iters);
  }

  // 6 — present: visualize the reconstructed height.
  disp(s_pso_present, vp_w, vp_h, &coarse, 0, &s->grad_tex, 1, &in, 2,
       &out, 3, &s->uniform_buf, 4);

  gpu::Device::submit();
}

} // namespace height_from_gradient
