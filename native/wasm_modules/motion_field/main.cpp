/*
 * video.motion_field — Image-driven motion vector generator.
 *
 * Activation: per-pixel luma soft-thresholded against `threshold` ±
 * `softness`. Pixels below threshold emit zero motion; above, full
 * motion; in between, a smoothstep ramp.
 *
 * Magnitude: `magnitude` × (1 ± mag_jitter * value-noise). The noise
 * is locally smooth (Perlin-style, controlled by mag_noise_scale)
 * so neighbouring pixels share similar magnitude — patches breathe
 * coherently rather than flickering.
 *
 * Direction: weighted sum of three components, each independently
 * weighted, sum then normalised:
 *   - Static rotation       — a fixed angle (`rotation`).
 *   - Radial outward        — from `radial_anchor` (uv coord).
 *   - Luma gradient + bias  — central-difference gradient of the
 *                             input luma, rotated by `gradient_bias`
 *                             (0 = uphill, ±90° = along iso-luma
 *                             contours, useful for edge-flow looks).
 * Plus a per-pixel angular jitter on top, again locally smooth so
 * the field swirls coherently instead of becoming salt-and-pepper.
 *
 * Output: tex_in passes through to tex_out unchanged. The motion
 * texture (`render_outputs/motion`) carries the computed velocity
 * field. Set `vis_opacity > 0` to overlay an HSV-polar visualization
 * of the motion vectors on top of the input — useful while tuning,
 * leave at 0 in production.
 */

#include <gpu.h>
#include <host.h>
#include "motion_field_shaders.h"

#include <cmath>
#include <cstdint>

namespace motion_field {

// 5 float4-rows = 80 bytes total. std140-style alignment so each
// row sits at a 16-byte boundary; the WGSL `cbuffer` layout matches.
struct Uniforms {
  // row 0: activation
  float threshold;
  float softness;
  float magnitude;
  float mag_jitter;

  // row 1: noise scales + static rotation
  float mag_noise_scale;
  float rotation_rad;
  float rotation_weight;
  float radial_weight;

  // row 2: radial anchor + gradient
  float radial_anchor_x;
  float radial_anchor_y;
  float gradient_weight;
  float gradient_bias_rad;

  // row 3: angle jitter + viz
  float angle_jitter;
  float angle_noise_scale;
  float vis_opacity;
  float vis_scale;

  // row 4: seeds
  uint32_t seed_mag;
  uint32_t seed_angle;
  uint32_t _pad0;
  uint32_t _pad1;
};
static_assert(sizeof(Uniforms) == 80, "Uniforms layout mismatch");

static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_uniform_buf;
static gpu::Texture    s_motion_tex;
static int  s_motion_w = 0;
static int  s_motion_h = 0;
static bool s_initialized = false;

// --- Schema-mirrored state ---
static float s_threshold      = 0.5f;
static float s_softness       = 0.05f;
static float s_magnitude      = 0.005f;
static float s_mag_jitter     = 0.5f;
static float s_mag_noise_scale = 16.0f;

static float s_rotation_deg     = 0.0f;
static float s_rotation_weight  = 1.0f;
static float s_radial_weight    = 0.0f;
static float s_radial_anchor_x  = 0.5f;
static float s_radial_anchor_y  = 0.5f;
static float s_gradient_weight  = 0.0f;
static float s_gradient_bias_deg = 90.0f;

static float s_angle_jitter     = 0.0f;
static float s_angle_noise_scale = 16.0f;
static int   s_seed             = 0;
static float s_vis_opacity      = 0.0f;
static float s_vis_scale        = 100.0f;

static constexpr float DEG2RAD = 3.14159265358979323846f / 180.0f;

void init() {
  s_initialized = false;

  state::init("video.motion_field", {1, 0, 0},
    state::Schema()
      // Activation
      .floatField("threshold",         0.5f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("softness",          0.05f, 0.0f,  0.5f,  state::PrimaryInput)
      // Magnitude
      .floatField("magnitude",         0.005f, 0.0f, 0.05f, state::PrimaryInput)
      .floatField("mag_jitter",        0.5f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("mag_noise_scale",   16.0f, 1.0f,  100.0f, state::PrimaryInput)
      // Direction — static
      .floatField("rotation",          0.0f,  -360.f, 360.f, state::PrimaryInput)
      .floatField("rotation_weight",   1.0f,  0.0f,  1.0f,  state::PrimaryInput)
      // Direction — radial
      .floatField("radial_weight",     0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      .vec2Field ("radial_anchor",     0.5f,  0.5f,         state::PrimaryInput,
                  0.0f, 1.0f)
      // Direction — luma gradient
      .floatField("gradient_weight",   0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("gradient_bias",     90.0f, -180.f, 180.f, state::PrimaryInput)
      // Per-pixel angular jitter
      .floatField("angle_jitter",      0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("angle_noise_scale", 16.0f, 1.0f,  100.0f, state::PrimaryInput)
      .intField  ("seed",              0,     0,     1000,  state::PrimaryInput)
      // Visualization (off by default — production effects are
      // expected to pass through tex_in unchanged).
      .floatField("vis_opacity",       0.0f,  0.0f,  1.0f,  state::PrimaryInput)
      .floatField("vis_scale",         100.0f, 1.0f, 500.0f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("motion_field_color",  COLOR_SPV,  COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_field_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_field_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_field_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));

  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .tex2d(0)                                       // input texture (sampled
                                                      // for both luma + gradient)
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)
      .uniform(2));

  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("motion_field: initialized");
}

void tick(double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "threshold"))         s_threshold = state::patchFloat(i);
    else if (state::pathIs(path, plen, "softness"))          s_softness = state::patchFloat(i);
    else if (state::pathIs(path, plen, "magnitude"))         s_magnitude = state::patchFloat(i);
    else if (state::pathIs(path, plen, "mag_jitter"))        s_mag_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "mag_noise_scale"))   s_mag_noise_scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "rotation"))          s_rotation_deg = state::patchFloat(i);
    else if (state::pathIs(path, plen, "rotation_weight"))   s_rotation_weight = state::patchFloat(i);
    else if (state::pathIs(path, plen, "radial_weight"))     s_radial_weight = state::patchFloat(i);
    else if (state::pathIs(path, plen, "radial_anchor")) {
      auto v = state::patchVec2(i);
      s_radial_anchor_x = v.x;
      s_radial_anchor_y = v.y;
    }
    else if (state::pathIs(path, plen, "gradient_weight"))   s_gradient_weight = state::patchFloat(i);
    else if (state::pathIs(path, plen, "gradient_bias"))     s_gradient_bias_deg = state::patchFloat(i);
    else if (state::pathIs(path, plen, "angle_jitter"))      s_angle_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "angle_noise_scale")) s_angle_noise_scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed"))              s_seed = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "vis_opacity"))       s_vis_opacity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vis_scale"))         s_vis_scale = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // (Re)allocate the motion texture for the current viewport. Publish
  // the handle once per allocation; matches the convention in
  // motion_rect / motion_swarm / motion_static.
  if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
    s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    s_motion_w = vp_w;
    s_motion_h = vp_h;
    if (s_motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
    }
  }
  if (!s_motion_tex.valid()) return;

  // Derive shader-side seeds from the schema seed. The two noise
  // fields (magnitude + angle) are independent draws so we offset
  // by arbitrary primes.
  uint32_t base_seed = (uint32_t)s_seed;
  Uniforms u = {
    s_threshold,
    s_softness,
    s_magnitude,
    s_mag_jitter,

    s_mag_noise_scale,
    s_rotation_deg * DEG2RAD,
    s_rotation_weight,
    s_radial_weight,

    s_radial_anchor_x,
    s_radial_anchor_y,
    s_gradient_weight,
    s_gradient_bias_deg * DEG2RAD,

    s_angle_jitter,
    s_angle_noise_scale,
    s_vis_opacity,
    s_vis_scale,

    base_seed * 1664525u + 1013904223u,
    base_seed * 22695477u + 1u,
    0u, 0u,
  };
  s_uniform_buf.writeOne(u);

  // Pass 1 — color (identity copy + optional viz overlay).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }
  // Pass 2 — motion vectors.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(in,           0, 0);
    cp.setTexture(s_motion_tex, 1, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_field
