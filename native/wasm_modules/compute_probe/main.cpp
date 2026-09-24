/*
 * debug.compute_probe — compute-side ABI paths no other test-only effect
 * reaches, one per `case`, each reported as a solid colour so the ordinary
 * pixel harness checks it on every backend.
 *
 *   0  workgroup memory: groupshared + barriers + InterlockedOr, in a 32x4
 *      group (not 8x8) → all green.
 *   1  sampler address modes: a 16x1 ramp sampled outside 0..1 through
 *      Repeat | Mirror | ClampToEdge samplers → R = 4/15 | 11/15 | 1.
 *   2  texture formats: an RGBA32F texel holding 70000, an RGBA8_SRGB target
 *      cleared to linear 0.5, and the format queries → (1, 0.5, 1).
 *   3  host frame values: deltaTime in (0, 1), viewportWidth/Height equal to
 *      the render size → (1, 1, 1).
 *   4  async readback: the input's centre pixel goes GPU → buffer → CPU
 *      (requestReadback / pollReadback) and comes back as (b, r, g) — a
 *      rotation, so a passthrough can't pass. Black until a snapshot lands.
 */

#include <gpu.h>
#include <host.h>
#include "compute_probe_shaders.h"

namespace compute_probe {

struct Float4 { float v[4]; };

struct State {
  int mode = 0;
  gpu::Texture ramp, big, srgb;
  gpu::Buffer fill_uniforms, flags_uniforms, captured;
  bool have_snapshot = false;
  uint32_t snapshot[4] = {0, 0, 0, 0};
  bool initialized = false;
};

static gpu::ComputePSO s_groupshared, s_ramp, s_sample, s_big, s_formats,
                       s_fill, s_capture;
static gpu::Sampler s_repeat, s_mirror, s_clamp;

void module_init() {
  state::init("debug.compute_probe", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .intField("case", 0, 0, 4)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Outputs are tex_out-shaped (rgba8, write) on web; the ramp and the f32
  // texture are overridden to their own formats. Native takes the format from
  // the bound texture.
  state::registerShaderSPV("compute_probe_groupshared", GROUPSHARED_SPV, GROUPSHARED_SPV_SIZE,
                           "rgba8unorm", "write");
  state::registerShaderSPV("compute_probe_ramp", RAMP_SPV, RAMP_SPV_SIZE,
                           "rgba16float", "write");
  state::registerShaderSPV("compute_probe_sample", SAMPLE_SPV, SAMPLE_SPV_SIZE,
                           "rgba8unorm", "write");
  state::registerShaderSPV("compute_probe_big", BIG_SPV, BIG_SPV_SIZE,
                           "rgba32float", "write");
  state::registerShaderSPV("compute_probe_formats", FORMATS_SPV, FORMATS_SPV_SIZE,
                           "rgba8unorm", "write");
  state::registerShaderSPV("compute_probe_fill", FILL_SPV, FILL_SPV_SIZE,
                           "rgba8unorm", "write");
  state::registerShaderSPV("compute_probe_capture", CAPTURE_SPV, CAPTURE_SPV_SIZE);

  auto mod = [](const char* n) { return gpu::Device::createShaderModuleByName(n); };
  auto gs = mod("compute_probe_groupshared");
  auto rp = mod("compute_probe_ramp");
  auto sp = mod("compute_probe_sample");
  auto bg = mod("compute_probe_big");
  auto fm = mod("compute_probe_formats");
  auto fl = mod("compute_probe_fill");
  auto cp = mod("compute_probe_capture");
  if (!gs || !rp || !sp || !bg || !fm || !fl || !cp) return;

  s_groupshared = gpu::Device::createComputePSO(gs, "main",
      gpu::Bindings().storageTex2d(0));
  s_ramp = gpu::Device::createComputePSO(rp, "main",
      gpu::Bindings().storageTex2d(0, gpu::TextureFormat::RGBA16F));
  s_sample = gpu::Device::createComputePSO(sp, "main", gpu::Bindings()
      .tex2d(0, gpu::TextureFormat::RGBA16F)
      .sampler(1).sampler(2).sampler(3)
      .storageTex2d(4));
  s_big = gpu::Device::createComputePSO(bg, "main",
      gpu::Bindings().storageTex2d(0, gpu::TextureFormat::RGBA32F));
  s_formats = gpu::Device::createComputePSO(fm, "main", gpu::Bindings()
      .tex2d(0, gpu::TextureFormat::RGBA32F)
      .tex2d(1)
      .uniform(2)
      .storageTex2d(3));
  s_fill = gpu::Device::createComputePSO(fl, "main",
      gpu::Bindings().uniform(0).storageTex2d(1));
  s_capture = gpu::Device::createComputePSO(cp, "main",
      gpu::Bindings().tex2d(0).storageRW(1));

  gpu::SamplerDesc d;
  d.min_filter = d.mag_filter = d.mip_filter = gpu::FilterMode::Nearest;
  d.address_u = d.address_v = d.address_w = gpu::AddressMode::Repeat;
  s_repeat = gpu::Device::createSampler(d);
  d.address_u = d.address_v = d.address_w = gpu::AddressMode::Mirror;
  s_mirror = gpu::Device::createSampler(d);
  d.address_u = d.address_v = d.address_w = gpu::AddressMode::ClampToEdge;
  s_clamp = gpu::Device::createSampler(d);
}

void* create() { return new State(); }

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->ramp.release(); s->big.release(); s->srgb.release();
  s->fill_uniforms.release(); s->flags_uniforms.release(); s->captured.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_groupshared.valid() || !s_ramp.valid() || !s_sample.valid() ||
      !s_big.valid() || !s_formats.valid() || !s_fill.valid() ||
      !s_capture.valid() || !s_repeat.valid() || !s_mirror.valid() ||
      !s_clamp.valid())
    return;
  s->ramp = gpu::Device::createTexture(16, 1, gpu::TextureFormat::RGBA16F);
  s->big  = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA32F);
  s->srgb = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA8_SRGB);
  s->fill_uniforms  = gpu::Device::createBuffer(sizeof(Float4), gpu::BufferUsage::Uniform);
  s->flags_uniforms = gpu::Device::createBuffer(sizeof(Float4), gpu::BufferUsage::Uniform);
  s->captured = gpu::Device::createBuffer(sizeof(uint32_t) * 4, gpu::BufferUsage::Storage);
  s->initialized = s->ramp.valid() && s->big.valid() && s->srgb.valid() &&
                   s->fill_uniforms.valid() && s->flags_uniforms.valid() &&
                   s->captured.valid();
  if (s->initialized) state::log("compute_probe: initialized");
}

void tick(void*, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "case")) s->mode = state::patchInt(i);
  }
}

static void fill(State* s, gpu::Texture out, int w, int h,
                 float r, float g, float b, float a) {
  Float4 c = {{r, g, b, a}};
  s->fill_uniforms.writeOne(c);
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_fill);
  cp.setBuffer(s->fill_uniforms, 0);
  cp.setTexture(out, 1, gpu::TextureAccess::Write);
  cp.dispatch((w + 7) / 8, (h + 7) / 8);
  cp.end();
}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  switch (s->mode) {
    case 0: {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(s_groupshared);
      cp.setTexture(out, 0, gpu::TextureAccess::Write);
      cp.dispatch((w + 31) / 32, (h + 3) / 4);
      cp.end();
      break;
    }
    case 1: {
      auto a = gpu::ComputePass::begin();
      a.setPSO(s_ramp);
      a.setTexture(s->ramp, 0, gpu::TextureAccess::Write);
      a.dispatch(1);
      a.end();
      auto b = gpu::ComputePass::begin();
      b.setPSO(s_sample);
      b.setTexture(s->ramp, 0);
      b.setSampler(s_repeat, 1);
      b.setSampler(s_mirror, 2);
      b.setSampler(s_clamp, 3);
      b.setTexture(out, 4, gpu::TextureAccess::Write);
      b.dispatch((w + 7) / 8, (h + 7) / 8);
      b.end();
      break;
    }
    case 2: {
      const gpu::TextureFormat def = gpu::Device::defaultTextureFormat();
      const bool def_ok = def == gpu::TextureFormat::RGBA8 ||
                          def == gpu::TextureFormat::BGRA8 ||
                          def == gpu::TextureFormat::RGBA16F;
      const bool srgb_ok =
          gpu::Device::textureFormat(s->srgb) == gpu::TextureFormat::RGBA8_SRGB &&
          gpu::Device::textureFormat(s->big) == gpu::TextureFormat::RGBA32F;
      Float4 flags = {{def_ok && srgb_ok ? 1.0f : 0.0f, 0, 0, 0}};
      s->flags_uniforms.writeOne(flags);

      auto a = gpu::ComputePass::begin();
      a.setPSO(s_big);
      a.setTexture(s->big, 0, gpu::TextureAccess::Write);
      a.dispatch(1);
      a.end();
      auto clear = gpu::RenderPass::begin(s->srgb, 0.5f, 0.5f, 0.5f, 1.0f);
      clear.end();
      auto b = gpu::ComputePass::begin();
      b.setPSO(s_formats);
      b.setTexture(s->big, 0);
      b.setTexture(s->srgb, 1);
      b.setBuffer(s->flags_uniforms, 2);
      b.setTexture(out, 3, gpu::TextureAccess::Write);
      b.dispatch((w + 7) / 8, (h + 7) / 8);
      b.end();
      break;
    }
    case 3: {
      const double dt = host::deltaTime();
      fill(s, out, w, h,
           dt > 0.0 && dt < 1.0 ? 1.0f : 0.0f,
           host::viewportWidth() == w ? 1.0f : 0.0f,
           host::viewportHeight() == h ? 1.0f : 0.0f,
           1.0f);
      break;
    }
    case 4: {
      uint32_t got[4] = {0, 0, 0, 0};
      if (s->captured.pollReadback(got, sizeof(got)) == (int)sizeof(got) &&
          got[3] == 1234567u) {
        for (int i = 0; i < 4; i++) s->snapshot[i] = got[i];
        s->have_snapshot = true;
      }
      auto in = gpu::Device::textureForField("tex_in");
      if (in.valid()) {
        auto cp = gpu::ComputePass::begin();
        cp.setPSO(s_capture);
        cp.setTexture(in, 0);
        cp.setBuffer(s->captured, 1);
        cp.dispatch(1);
        cp.end();
        s->captured.requestReadback(sizeof(uint32_t) * 4);
      }
      if (s->have_snapshot) {
        fill(s, out, w, h, s->snapshot[2] / 255.0f, s->snapshot[0] / 255.0f,
             s->snapshot[1] / 255.0f, 1.0f);
      } else {
        fill(s, out, w, h, 0.0f, 0.0f, 0.0f, 1.0f);
      }
      break;
    }
    default:
      fill(s, out, w, h, 1.0f, 0.0f, 1.0f, 1.0f);
      break;
  }
  gpu::Device::submit();
}

}  // namespace compute_probe
