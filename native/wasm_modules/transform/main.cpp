/*
 * warp.transform — 2D affine resample of the input texture.
 *
 * Standard params:
 *   scale       [-1, +1]  exponential map: -1 → 1/4, 0 → 1, +1 → 4.
 *   rotation    [-1, +1]  ±180°.
 *   translate (vec2, [-1, +1]²)  cover-square anchor displacement.
 *
 * Tuning params:
 *   pivot (vec2, [-1, +1]²)  cover-square anchor for the origin of scale/rotation.
 *   scale_aspect [-1, +1]    bias the scale toward x-only (-1) or y-only (+1).
 *                            Default 0 = uniform.
 *   wrap_mode    int         0 = clamp to edge (default), 1 = transparent outside,
 *                            2 = repeat, 3 = mirror.
 *
 * Class-like instance model: module_init() sets up the type-shared compute
 * PSO + schema once; each chain entry gets its own State (params + uniform
 * buffer + sampler) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "transform_shaders.h"

#include <cmath>

namespace transform {

// wrap_mode options — values must match the branch logic in compute.hlsl.
enum WrapMode {
  WrapClamp       = 0,  // clamp to edge
  WrapTransparent = 1,  // transparent outside the source
  WrapRepeat      = 2,  // tile
  WrapMirror      = 3,  // mirror-tile
};

struct Uniforms {
  float scale_x, scale_y;
  float cos_r, sin_r;
  float translate_x, translate_y;
  float pivot_x, pivot_y;
  float aspect_x, aspect_y;
  float wrap_mode;
  float _pad;
};

// Per-instance state. One per chain entry.
struct State {
  float scale = 0.0f;
  float scale_aspect = 0.0f;
  float rotation = 0.0f;
  float tx = 0.0f, ty = 0.0f;
  float px = 0.0f, py = 0.0f;
  float wrap_mode = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
  gpu::Sampler sampler;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("warp.transform", {1, 0, 0},
    state::Schema()
      .floatField("scale",        0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("rotation",     0.0f, -1.f, 1.f, state::PrimaryInput)
      .vec2Field("translate",     0.0f, 0.0f, state::PrimaryInput, -1.f, 1.f)
      .vec2Field("pivot",         0.0f, 0.0f, state::SecondaryInput, -1.f, 1.f)
      .floatField("scale_aspect", 0.0f, -1.f, 1.f, state::SecondaryInput)
      .selectField("wrap_mode", WrapClamp, state::SecondaryInput, {
          {"Clamp",       WrapClamp},
          {"Transparent", WrapTransparent},
          {"Repeat",      WrapRepeat},
          {"Mirror",      WrapMirror},
      })
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).sampler(2).uniform(3));
}

// Per-instance construction: allocate State + its own uniform buffer + sampler.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  // Bilinear filter, clamp-to-edge addressing. Wrap-mode logic still happens
  // in the shader before sampling so the address mode here is just a fallback.
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                          gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->sampler.release();
  delete s;
}

// Per-instance init tail: defaults + ready guard.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->scale = 0.0f;
  s->scale_aspect = 0.0f;
  s->rotation = 0.0f;
  s->tx = 0.0f; s->ty = 0.0f;
  s->px = 0.0f; s->py = 0.0f;
  s->wrap_mode = 0.0f;
  s->initialized = false;

  if (!s_pso.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
}


// Pure passthrough at neutral transform (no scale/rotate/translate).
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->scale == 0.0f && s->scale_aspect == 0.0f && s->rotation == 0.0f
          && s->tx == 0.0f && s->ty == 0.0f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off, const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "scale"))        s->scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "rotation"))     s->rotation = state::patchFloat(i);
    else if (state::pathIs(p, l, "translate"))    { auto v = state::patchVec2(i); s->tx = v.x; s->ty = v.y; }
    else if (state::pathIs(p, l, "pivot"))        { auto v = state::patchVec2(i); s->px = v.x; s->py = v.y; }
    else if (state::pathIs(p, l, "scale_aspect")) s->scale_aspect = state::patchFloat(i);
    else if (state::pathIs(p, l, "wrap_mode"))    s->wrap_mode = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  // Cover-square half-extents in viewport-uv units.
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);

  // Exponential scale: -1 → 1/4, 0 → 1, +1 → 4.
  float base_scale = std::pow(4.0f, s->scale);
  // Aspect bias: -1 = x-only, +1 = y-only, 0 = uniform.
  // Re-distribute a multiplicative factor between the two axes.
  float bias = std::pow(2.0f, s->scale_aspect);  // -1: 0.5, 0: 1, +1: 2
  float sx = base_scale * bias;
  float sy = base_scale / bias;

  // Rotation: ±180° (=±π).
  float angle = s->rotation * 3.14159265358979323846f;

  Uniforms u = {};
  u.scale_x = sx;
  u.scale_y = sy;
  u.cos_r = std::cos(angle);
  u.sin_r = std::sin(angle);
  u.translate_x = s->tx;
  u.translate_y = s->ty;
  u.pivot_x = s->px;
  u.pivot_y = s->py;
  u.aspect_x = ax;
  u.aspect_y = ay;
  u.wrap_mode = s->wrap_mode;
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setSampler(s->sampler, 2);
  cp.setBuffer(s->uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace transform
