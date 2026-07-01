/*
 * filter.mesh.triangulate — "Triangulate".
 *
 * Renders a Delaunay triangulation that FOLLOWS THE TOPOLOGY of an input's
 * density: ridgelines first, then corners, then filling voids. Built entirely
 * on the GPU.
 *
 * Pipeline (assembled over several phases — see the effect plan):
 *   1. Feature maps   — Gaussian blur the input's luma, then take spatial
 *                       derivatives to build ridge (neg-Laplacian), corner
 *                       (Hessian-det) and density maps, blended into one
 *                       importance field W.
 *   2. JFA Voronoi    — a persistent seed pool is partitioned by a Jump-Flood
 *                       nearest-seed pass.
 *   3. Stochastic     — seeds are LOCKED in place and only TELEPORT when a
 *      takeover         candidate is confidently a better match (Metropolis /
 *                       importance-resample, never continuous drift → no swim).
 *   4. Delaunay mesh  — Voronoi triple-points (where 3 cells meet) are the
 *                       Delaunay circumcenters; the 3 connecting edges are
 *                       emitted and drawn as instanced line quads.
 *
 * P0 status: scaffold only. Schema + State + a passthrough (tex_in → tex_out).
 * Subsequent phases fill in the passes above.
 */

#include <gpu.h>
#include <host.h>
#include "triangulate_shaders.h"

#include <cstdint>

namespace triangulate {

// ---- Schema-mirrored params (defaults match the schema) --------------------
struct State {
  gpu::Buffer  uniform_buf;    // reserved for later passes
  bool         initialized = false;

  // Standard
  float density      = 0.3f;   // mesh density → seed count
  float ridge_weight = 0.6f;
  float corner_weight= 0.3f;
  float void_weight  = 0.2f;
  float churn        = 0.3f;    // stochastic-takeover rate
  float line_width   = 0.3f;
  float line_r = 1.f, line_g = 1.f, line_b = 1.f;

  // Tuning
  float feature_scale = 0.4f;   // pre-derivative blur radius
  float confidence    = 0.4f;   // takeover deadband / margin
  int   scoring_mode  = 0;      // 0 cell-residual, 1 feature-weight, 2 blue-noise
  int   bg_mode       = 1;      // 0 input, 1 dark, 2 feature
  float fill_opacity  = 0.0f;
  float quality       = 0.3f;   // blur sample density

  // Debug
  int   debug_view    = 0;      // 0 off, 1 density, 2 ridge, 3 corner, 4 importance, 5 voronoi, 6 points
};

// Type-shared, compiled once.
static gpu::ComputePSO s_pso_passthrough;

void module_init() {
  state::init("filter.mesh.triangulate", {1, 0, 0},
    state::Schema()
      // Standard — the live performer reaches for these
      .floatField("density",      0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Mesh density — how many seed points populate the triangulation.")
      .floatField("ridge_weight", 0.6f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "How strongly seeds are pulled onto ridgelines.")
      .floatField("corner_weight",0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "How strongly seeds are pulled onto corners / maxima.")
      .floatField("void_weight",  0.2f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Baseline coverage of low-feature voids (uniform fill).")
      .floatField("churn",        0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Stochastic-takeover rate — how eagerly mismatched vertices jump (0 = frozen).")
      .floatField("line_width",   0.3f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Triangulation edge thickness.")
      .rgbField  ("line_color",   1.f, 1.f, 1.f, state::PrimaryInput)

      // Tuning — patch designer
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

      // Debug — last
      .selectField("debug_view", 0, state::SecondaryInput,
                   {{"Off", 0}, {"Density", 1}, {"Ridge", 2}, {"Corner", 3},
                    {"Importance", 4}, {"Voronoi", 5}, {"Points", 6}},
                   true, "Visualize an internal stage instead of the mesh.")

      .capability(state::Capability::SeekableApproximate)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("passthrough", PASSTHROUGH_SPV, PASSTHROUGH_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("passthrough");
  if (!cs) return;
  s_pso_passthrough = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8));

  state::log("triangulate: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(16, gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (s->uniform_buf.valid()) s->uniform_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_passthrough.valid()) return;
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

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // P0: passthrough. Later phases replace this with the full pipeline.
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso_passthrough);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace triangulate
