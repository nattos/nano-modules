/*
 * video.crop — Rectangular crop with two parameterizations.
 *
 * mode = Span (default):
 *   `center` (vec2, cover-square coords) + `width`/`height` (half-extents
 *   in cover-square units). Identical to the original behaviour — the
 *   crop rect stays consistent across viewport aspect ratios.
 *
 * mode = Inset:
 *   `inset_left`, `inset_right`, `inset_top`, `inset_bottom` — fractions
 *   of the viewport's width/height (NOT the 1:1 fit box) to chop off
 *   each edge. inset_left=0.1 means "remove the leftmost 10% of the
 *   image".
 *
 * Common:
 *   `feather` — soft-edge width. 0 → pixel-perfect staircase.
 *   `fill`    — colour for the masked-out region. Default transparent.
 *
 * Demonstrates the schema-edit pattern: every parameter is registered
 * in init(); on_state_ready (fired after init + state replay) hides the
 * inactive mode's fields. Switching mode at runtime re-runs the same
 * visibility logic from on_state_patched.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "crop_shaders.h"

namespace crop {

enum CropMode : int { ModeSpan = 0, ModeInset = 1 };

// Layout matches the HLSL cbuffer below, packed at vec4 boundaries
// (5 × 16 bytes = 80). Individual `_pad*` scalars are used instead of
// an array because WGSL uniform-array-stride alignment is 16 per
// element, which would silently change the buffer size if we used
// `float _pad[N]`.
struct Uniforms {
  float center_x, center_y, half_w, half_h;
  float feather, aspect_x, aspect_y, _pad0;
  float fill_r, fill_g, fill_b, fill_a;
  float inset_l, inset_r, inset_t, inset_b;
  int   mode;
  float _pad1, _pad2, _pad3;
};

static int   s_mode = ModeSpan;
static float s_cx = 0.0f, s_cy = 0.0f;
static float s_w = 1.0f, s_h = 1.0f;
static float s_feather = 0.0f;
static float s_fill[4] = { 0.0f, 0.0f, 0.0f, 0.0f };
static float s_inset[4] = { 0.0f, 0.0f, 0.0f, 0.0f }; // l, r, t, b
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

/// Show only the fields that belong to the active mode. Called from
/// on_state_ready (once after init + state replay) and from
/// on_state_patched whenever `mode` changes — same code path either way.
static void apply_mode_visibility() {
  bool inset = (s_mode == ModeInset);
  // Span-only fields
  state::setFieldHidden("center",  inset);
  state::setFieldHidden("width",   inset);
  state::setFieldHidden("height",  inset);
  // Inset-only fields
  state::setFieldHidden("inset_left",   !inset);
  state::setFieldHidden("inset_right",  !inset);
  state::setFieldHidden("inset_top",    !inset);
  state::setFieldHidden("inset_bottom", !inset);
}

static void on_state_ready();

void init() {
  s_mode = ModeSpan;
  s_cx = 0.0f; s_cy = 0.0f;
  s_w = 1.0f; s_h = 1.0f;
  s_feather = 0.0f;
  s_fill[0] = s_fill[1] = s_fill[2] = s_fill[3] = 0.0f;
  s_inset[0] = s_inset[1] = s_inset[2] = s_inset[3] = 0.0f;
  s_initialized = false;

  state::init("video.crop", {1, 0, 0},
    state::Schema()
      // Mode selector — drives which downstream fields are visible.
      .selectField("mode", ModeSpan, state::PrimaryInput, {
          {"Span", ModeSpan},
          {"Inset", ModeInset},
      })
      // Span-mode parameters.
      .vec2Field("center",  0.0f, 0.0f, state::PrimaryInput, -1.f, 1.f)
      .floatField("width",   1.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("height",  1.0f, 0.f, 1.f, state::PrimaryInput)
      // Inset-mode parameters.
      .floatField("inset_left",   0.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("inset_right",  0.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("inset_top",    0.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("inset_bottom", 0.0f, 0.f, 1.f, state::PrimaryInput)
      // Common parameters.
      .floatField("feather", 0.0f, 0.f, 1.f, state::PrimaryInput)
      .rgbaField("fill", 0.0f, 0.0f, 0.0f, 0.0f, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );
  state::setOnStateReady(&on_state_ready);

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

static void on_state_ready() {
  // Fired after init + initial state replay. Whatever the mode landed
  // at, hide the inactive mode's fields so the IDE never paints the
  // intermediate "all fields visible" state.
  apply_mode_visibility();
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  bool mode_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "mode"))     { int m = (int)state::patchFloat(i); if (m != s_mode) { s_mode = m; mode_changed = true; } }
    else if (state::pathIs(p, l, "center"))   { auto v = state::patchVec2(i); s_cx = v.x; s_cy = v.y; }
    else if (state::pathIs(p, l, "width"))    s_w = state::patchFloat(i);
    else if (state::pathIs(p, l, "height"))   s_h = state::patchFloat(i);
    else if (state::pathIs(p, l, "inset_left"))   s_inset[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "inset_right"))  s_inset[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "inset_top"))    s_inset[2] = state::patchFloat(i);
    else if (state::pathIs(p, l, "inset_bottom")) s_inset[3] = state::patchFloat(i);
    else if (state::pathIs(p, l, "feather"))  s_feather = state::patchFloat(i);
    else if (state::pathIs(p, l, "fill")) {
      auto v = state::patchVec4(i);
      s_fill[0] = v.x; s_fill[1] = v.y; s_fill[2] = v.z; s_fill[3] = v.w;
    }
  }
  if (mode_changed) apply_mode_visibility();
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);

  Uniforms u = {};
  u.center_x = s_cx; u.center_y = s_cy;
  u.half_w = s_w; u.half_h = s_h;
  u.feather = s_feather;
  u.aspect_x = ax; u.aspect_y = ay;
  u.fill_r = s_fill[0]; u.fill_g = s_fill[1]; u.fill_b = s_fill[2]; u.fill_a = s_fill[3];
  u.inset_l = s_inset[0]; u.inset_r = s_inset[1];
  u.inset_t = s_inset[2]; u.inset_b = s_inset[3];
  u.mode = s_mode;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace crop
