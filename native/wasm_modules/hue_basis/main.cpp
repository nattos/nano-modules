/*
 * color.hue_basis — Channel-mix into a basis defined by three hues.
 *
 * Each hue identifies a fully-saturated RGB basis vector (HSV at
 * S=V=1), normalized per-vector so its three components sum to 1.
 * The matrix M with these vectors as COLUMNS has the property that
 * its column-sums equal 1, so M^T · (1,1,1) = (1,1,1) — i.e., the
 * Forward direction always preserves white.
 *
 * Direction:
 *   Forward (default) — uploads M's columns. Shader computes
 *                       M^T · in (dot products of the three basis
 *                       vectors with the input).
 *   Reverse           — uploads M^-1's columns (closed-form 3×3
 *                       inverse). Shader still does the same
 *                       dot-products, so the result is M^-T · in,
 *                       which is the EXACT inverse of Forward.
 *                       Round-tripping Forward → Reverse with the
 *                       same hues is identity for any non-singular
 *                       basis.
 *
 *                       For singular bases (all hues collapsed to
 *                       the same value, det≈0) we fall back to
 *                       uploading M's columns again, so the round-
 *                       trip gracefully collapses without producing
 *                       NaNs.
 *
 * Default basis is (R, G, B) at hues 0, 1/3, 2/3 → M = identity.
 * Both directions pass through unchanged.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "hue_basis_shaders.h"

#include <algorithm>
#include <cmath>

namespace hue_basis {

enum Direction : int { DirForward = 0, DirReverse = 1 };

struct FuseUniforms {
  float c0[4];   // matrix column 0 in [0..2], pad in [3]
  float c1[4];
  float c2[4];
};

// Per-instance state. One per chain entry.
struct State {
  int   direction = DirForward;
  float hue[3] = { 0.0f, 1.0f / 3.0f, 2.0f / 3.0f };
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Forward decl — body after init() since prepare() uses hue_to_rgb
// (defined later as a static helper).
void prepare(void* self, int vp_w, int vp_h);

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.hue_basis", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Hue Basis\n"
        "Channel-mixes the image into a custom basis defined by **three hues**. Each "
        "hue picks a fully-saturated colour axis; *Forward* projects the input onto "
        "them, *Reverse* is the exact inverse. The default (0, ⅓, ⅔ = R, G, B) is "
        "identity and passes through unchanged.\n\n"
        "**Try:** rotate the three hues together for a stylised colour cast, then "
        "place a second copy set to *Reverse* with the same hues later in the chain "
        "to undo it — everything between the two is graded in your custom space. "
        "Forward always preserves white.")
      .group("basis", "Hue Basis")
        .groupHelp(
          "The three hues become the axes the image is decomposed onto. Spread them "
          "far apart for a wild channel-swap, or nudge them slightly for a subtle "
          "tint. *Direction* flips between the projection and its exact inverse.")
      .selectField("direction", DirForward, state::PrimaryInput, {
          {"Forward", DirForward},
          {"Reverse", DirReverse},
      }).label("Direction", "Dir")
      .floatField("hue_a", 0.0f,         0.f, 1.f, state::PrimaryInput).label("Hue A", "Hue A")
      .floatField("hue_b", 1.0f / 3.0f,  0.f, 1.f, state::PrimaryInput).label("Hue B", "Hue B")
      .floatField("hue_c", 2.0f / 3.0f,  0.f, 1.f, state::PrimaryInput).label("Hue C", "Hue C")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1)
      .uniform(2));
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

// Per-instance init tail: defaults + per-instance fusion registration.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->direction = DirForward;
  s->hue[0] = 0.0f;
  s->hue[1] = 1.0f / 3.0f;
  s->hue[2] = 2.0f / 3.0f;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "direction")) s->direction = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "hue_a"))     s->hue[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "hue_b"))     s->hue[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "hue_c"))     s->hue[2] = state::patchFloat(i);
  }
}

/// HSV → RGB at saturation=1, value=1, given hue in [0, 1).
static void hue_to_rgb(float h, float& r, float& g, float& b) {
  float k = h - std::floor(h);   // wrap into [0, 1)
  k *= 6.0f;                      // → [0, 6)
  if      (k < 1.f) { r = 1.f;       g = k;          b = 0.f; }
  else if (k < 2.f) { r = 2.f - k;   g = 1.f;        b = 0.f; }
  else if (k < 3.f) { r = 0.f;       g = 1.f;        b = k - 2.f; }
  else if (k < 4.f) { r = 0.f;       g = 4.f - k;    b = 1.f; }
  else if (k < 5.f) { r = k - 4.f;   g = 0.f;        b = 1.f; }
  else              { r = 1.f;       g = 0.f;        b = 6.f - k; }
}

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  // Build M with columns b'_i. Each b'_i is a fully-saturated RGB
  // colour with components summing to 1.
  float bv[3][3];
  for (int i = 0; i < 3; i++) {
    hue_to_rgb(s->hue[i], bv[i][0], bv[i][1], bv[i][2]);
    float sum = bv[i][0] + bv[i][1] + bv[i][2];
    if (sum <= 1e-6f) sum = 1e-6f;
    float inv = 1.0f / sum;
    bv[i][0] *= inv; bv[i][1] *= inv; bv[i][2] *= inv;
  }

  // Pick M for Forward, M^-1 for Reverse (closed-form 3×3 inverse).
  // Falls back to M if M is singular — collapses cleanly without NaN.
  float upload[3][3];
  if (s->direction == DirForward) {
    upload[0][0] = bv[0][0]; upload[0][1] = bv[0][1]; upload[0][2] = bv[0][2];
    upload[1][0] = bv[1][0]; upload[1][1] = bv[1][1]; upload[1][2] = bv[1][2];
    upload[2][0] = bv[2][0]; upload[2][1] = bv[2][1]; upload[2][2] = bv[2][2];
  } else {
    float r0[3] = {
      bv[1][1] * bv[2][2] - bv[1][2] * bv[2][1],
      bv[1][2] * bv[2][0] - bv[1][0] * bv[2][2],
      bv[1][0] * bv[2][1] - bv[1][1] * bv[2][0],
    };
    float r1[3] = {
      bv[2][1] * bv[0][2] - bv[2][2] * bv[0][1],
      bv[2][2] * bv[0][0] - bv[2][0] * bv[0][2],
      bv[2][0] * bv[0][1] - bv[2][1] * bv[0][0],
    };
    float r2[3] = {
      bv[0][1] * bv[1][2] - bv[0][2] * bv[1][1],
      bv[0][2] * bv[1][0] - bv[0][0] * bv[1][2],
      bv[0][0] * bv[1][1] - bv[0][1] * bv[1][0],
    };
    float det = bv[0][0] * r0[0] + bv[0][1] * r0[1] + bv[0][2] * r0[2];

    if (std::fabs(det) > 1e-4f) {
      float inv_det = 1.0f / det;
      upload[0][0] = r0[0] * inv_det;
      upload[0][1] = r1[0] * inv_det;
      upload[0][2] = r2[0] * inv_det;
      upload[1][0] = r0[1] * inv_det;
      upload[1][1] = r1[1] * inv_det;
      upload[1][2] = r2[1] * inv_det;
      upload[2][0] = r0[2] * inv_det;
      upload[2][1] = r1[2] * inv_det;
      upload[2][2] = r2[2] * inv_det;
    } else {
      upload[0][0] = bv[0][0]; upload[0][1] = bv[0][1]; upload[0][2] = bv[0][2];
      upload[1][0] = bv[1][0]; upload[1][1] = bv[1][1]; upload[1][2] = bv[1][2];
      upload[2][0] = bv[2][0]; upload[2][1] = bv[2][1]; upload[2][2] = bv[2][2];
    }
  }

  FuseUniforms u = {};
  u.c0[0] = upload[0][0]; u.c0[1] = upload[0][1]; u.c0[2] = upload[0][2];
  u.c1[0] = upload[1][0]; u.c1[1] = upload[1][1]; u.c1[2] = upload[1][2];
  u.c2[0] = upload[2][0]; u.c2[1] = upload[2][1]; u.c2[2] = upload[2][2];
  s->uniform_buf.writeOne(u);
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace hue_basis
