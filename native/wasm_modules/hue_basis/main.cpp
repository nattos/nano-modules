/*
 * video.hue_basis — Channel-mix into a basis defined by three hues.
 *
 * Each of the three hue parameters identifies a fully-saturated RGB
 * basis vector (HSV at S=V=1). The basis is normalized per-vector
 * so each component-sum equals 1, which guarantees the FORWARD pass
 * (M^T · in) maps white to white — handy for "tinted channel mixer"
 * effects where you want to project the image into a new
 * non-orthogonal basis without crushing the highlights.
 *
 * Direction:
 *   Forward (default) — out = M^T · in. Per-channel sums of M's
 *                       columns are 1, so white survives intact.
 *   Reverse           — out = M · in. The "inverse" without ever
 *                       computing M^-1: exact for an orthogonal
 *                       basis, otherwise lossy but NaN-free.
 *
 * With the default basis (red, green, blue at hues 0, 1/3, 2/3) M
 * is the identity matrix and both directions are pass-through.
 */

#include <gpu.h>
#include <host.h>
#include "hue_basis_shaders.h"

#include <algorithm>
#include <cmath>

namespace hue_basis {

enum Direction : int { DirForward = 0, DirReverse = 1 };

struct Uniforms {
  float c0[4];   // b'_0 in [0..2], pad in [3]
  float c1[4];
  float c2[4];
  int direction;
  int _pad0, _pad1, _pad2;
};

static int   s_direction = DirForward;
static float s_hue[3] = { 0.0f, 1.0f / 3.0f, 2.0f / 3.0f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_direction = DirForward;
  s_hue[0] = 0.0f;
  s_hue[1] = 1.0f / 3.0f;
  s_hue[2] = 2.0f / 3.0f;
  s_initialized = false;

  state::init("video.hue_basis", {1, 0, 0},
    state::Schema()
      .selectField("direction", DirForward, state::PrimaryInput, {
          {"Forward", DirForward},
          {"Reverse", DirReverse},
      })
      .floatField("hue_a", 0.0f,         0.f, 1.f, state::PrimaryInput)
      .floatField("hue_b", 1.0f / 3.0f,  0.f, 1.f, state::PrimaryInput)
      .floatField("hue_c", 2.0f / 3.0f,  0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double) {}
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "direction")) s_direction = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "hue_a"))     s_hue[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "hue_b"))     s_hue[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "hue_c"))     s_hue[2] = state::patchFloat(i);
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

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Build the normalized basis. Each b_i is a fully-saturated RGB
  // colour; normalize so its three components sum to 1.
  float bv[3][3];
  for (int i = 0; i < 3; i++) {
    hue_to_rgb(s_hue[i], bv[i][0], bv[i][1], bv[i][2]);
    float s = bv[i][0] + bv[i][1] + bv[i][2];
    if (s <= 1e-6f) s = 1e-6f;       // pathological; avoid div-by-0
    float inv = 1.0f / s;
    bv[i][0] *= inv; bv[i][1] *= inv; bv[i][2] *= inv;
  }

  Uniforms u = {};
  u.c0[0] = bv[0][0]; u.c0[1] = bv[0][1]; u.c0[2] = bv[0][2];
  u.c1[0] = bv[1][0]; u.c1[1] = bv[1][1]; u.c1[2] = bv[1][2];
  u.c2[0] = bv[2][0]; u.c2[1] = bv[2][1]; u.c2[2] = bv[2][2];
  u.direction = s_direction;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace hue_basis
