#pragma once
/*
 * field_gen.h — the plume SCULPTOR: the shell-map heightfield generator
 * (shape params → shell ×2 → SDF bake) shared, single-source, by
 *   - source.sdf.plume        (self mode: sculpts the field it renders)
 *   - source.sdf.plume_field  (standalone provider: sculpts + publishes)
 *
 * Both effects must produce the IDENTICAL field for identical params —
 * that's the whole point of the standalone provider — so every piece of
 * shape math lives here, not in either effect. The shaders (shell.hlsl,
 * bake.hlsl) are compiled once by the bundle build and land in
 * plume_gen_shaders.h; moduleInit() below registers them and builds the
 * module-shared PSOs (inline variables — one copy per bundle, whichever
 * effect's module_init runs first wins, later calls are no-ops).
 */

#include <gpu.h>
#include <host.h>
#include <effect_sdf_field.h>

#include <cmath>

#include "plume_gen_shaders.h"

namespace plume_gen {

constexpr float kPi = 3.14159265358979323846f;
constexpr float kTau = 2.0f * kPi;

// Mirrors common.hlsl — keep in lockstep.
constexpr int kVolRes = 128;
constexpr float kExt0 = 0.85f;
constexpr int kShellRes = 1024;
constexpr int kCoarseRes = 256;

// The generator's grid conventions ARE the rail's — a sculpted field is
// declarable on `sdf_field` without translation.
static_assert(kVolRes == fx::sdf_field::kGridRes, "grid res contract");
static_assert(kExt0 == fx::sdf_field::kGridExt, "grid extent contract");

// GPU uniform structs (16-byte rows, lockstep with the .hlsl cbuffers).
struct ShellUniforms {
  float res, octaves, ridge_scale, ridge_amp;
  float ridge_sharp, morph_x, seed, morph_z;
  float aniso, swirl, wobble, bl_nyq;
};
static_assert(sizeof(ShellUniforms) == 48, "ShellUniforms layout mismatch");

struct BakeUniforms { float radius, lipschitz, dens_soft, _pad0; };
static_assert(sizeof(BakeUniforms) == 16, "BakeUniforms layout mismatch");

// Module-shared PSOs (see header comment).
inline gpu::ComputePSO g_pso_shell;
inline gpu::ComputePSO g_pso_bake;

// Register the generator shaders + build the PSOs. Idempotent; call from
// each including effect's module_init AFTER the backend check.
inline void moduleInit() {
  if (g_pso_shell.valid() && g_pso_bake.valid()) return;
  state::registerShaderSPV("plume_shell", PLUME_GEN_SHELL_SPV,
                           PLUME_GEN_SHELL_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("plume_bake", PLUME_GEN_BAKE_SPV,
                           PLUME_GEN_BAKE_SPV_SIZE, "rgba16float", "write");
  auto cs_shell = gpu::Device::createShaderModuleByName("plume_shell");
  auto cs_bake = gpu::Device::createShaderModuleByName("plume_bake");
  if (!cs_shell || !cs_bake) return;
  g_pso_shell = gpu::Device::createComputePSO(cs_shell, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)
      .uniform(1));
  g_pso_bake = gpu::Device::createComputePSO(cs_bake, "main", gpu::Bindings()
      .tex2d(0)
      .sampler(1)
      .storageTex3d(2, gpu::TextureFormat::RGBA16F)
      .uniform(3));
}

inline double wrap01(double v) { return v - std::floor(v); }

// Knob -> cycles/sec, exponential (§1.3); 0 is fully stopped.
inline double rateHz(float k, double mid) {
  if (k <= 0.001f) return 0.0;
  return mid * std::pow(2.0, ((double)k - 0.5) * 5.0);
}

// Per-instance sculptor: Shape param mirrors + morph accumulator + the
// generator resources and passes.
struct Sculptor {
  gpu::Buffer ub_shell_full, ub_shell_coarse, ub_bake;
  gpu::Texture shell_full, shell_coarse;   // 2D RGBA16F, fixed sizes (lazy)
  gpu::Texture sdf_vol;                    // 3D RGBA16F 128³ (lazy)
  gpu::Sampler samp_clamp;                 // linear/clamp (bake shell reads)

  // Param mirrors (Shape group).
  float radius = 0.5f;
  float ridge_scale = 0.5f;
  float ridge_depth = 0.5f;
  float ridge_sharp = 0.5f;
  float ridge_aniso = 0.6f;
  float swirl = 0.15f;
  float morph = 0.4f;
  float variation = 0.0f;

  // Accumulator (§2.1), cycles in [0,1).
  double morph_phase = 0.0;

  // The canonical Shape group. Help text differs per effect (plume's
  // notes the sdf_field_in override) so it's a parameter, but the FIELDS
  // must match — patch() below mirrors exactly these paths.
  static state::Schema& declareSchema(state::Schema& s, const char* group_help) {
    return s.group("shape", "Shape")
        .groupHelp(group_help)
        .floatField("radius", 0.5f, 0.f, 1.f, state::PrimaryInput)
            .label("Radius", "Rad")
        .floatField("ridge_depth", 0.5f, 0.f, 1.f, state::PrimaryInput)
            .label("Ridge Depth", "Depth")
        .floatField("ridge_scale", 0.5f, 0.f, 1.f, state::PrimaryInput)
            .label("Ridge Scale", "Scale")
        .floatField("ridge_sharp", 0.5f, 0.f, 1.f, state::PrimaryInput)
            .label("Ridge Sharpness", "Sharp")
        .floatField("ridge_aniso", 0.6f, 0.f, 1.f, state::PrimaryInput)
            .label("Feathering", "Feath")
        .floatField("swirl", 0.15f, 0.f, 1.f, state::PrimaryInput)
            .label("Flow Direction", "Flow")
        .floatField("morph", 0.4f, 0.f, 1.f, state::PrimaryInput)
            .label("Morph", "Morph")
        .floatField("variation", 0.0f, 0.f, 1.f, state::PrimaryInput)
            .label("Variation", "Var");
  }

  void createBuffers() {
    ub_shell_full = gpu::Device::createBuffer(sizeof(ShellUniforms),
                                              gpu::BufferUsage::Uniform);
    ub_shell_coarse = gpu::Device::createBuffer(sizeof(ShellUniforms),
                                                gpu::BufferUsage::Uniform);
    ub_bake = gpu::Device::createBuffer(sizeof(BakeUniforms),
                                        gpu::BufferUsage::Uniform);
    samp_clamp = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                            gpu::AddressMode::ClampToEdge);
  }

  void release() {
    ub_shell_full.release();
    ub_shell_coarse.release();
    ub_bake.release();
    shell_full.release();
    shell_coarse.release();
    sdf_vol.release();
    samp_clamp.release();
  }

  bool valid() const {
    return ub_shell_full.valid() && ub_shell_coarse.valid() &&
           ub_bake.valid() && g_pso_shell.valid() && g_pso_bake.valid();
  }

  void resetPhase() { morph_phase = 0.0; }

  void tick(double dt) {
    morph_phase = wrap01(morph_phase + dt * rateHz(morph, 0.02));
  }

  // Mirror one state patch; true if it was a Shape param.
  bool patch(const char* p, int l, int i) {
    if      (state::pathIs(p, l, "radius"))      radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "ridge_depth")) ridge_depth = state::patchFloat(i);
    else if (state::pathIs(p, l, "ridge_scale")) ridge_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "ridge_sharp")) ridge_sharp = state::patchFloat(i);
    else if (state::pathIs(p, l, "ridge_aniso")) ridge_aniso = state::patchFloat(i);
    else if (state::pathIs(p, l, "swirl"))       swirl = state::patchFloat(i);
    else if (state::pathIs(p, l, "morph"))       morph = state::patchFloat(i);
    else if (state::pathIs(p, l, "variation"))   variation = state::patchFloat(i);
    else return false;
    return true;
  }

  // Sculpt the field: shell update (full + coarse) + SDF bake. Fills the
  // rail Desc and hands back the grid + shell textures. False when GPU
  // resources are unavailable (caller skips the frame).
  bool run(fx::sdf_field::Desc& desc, gpu::Texture& grid_out,
           gpu::Texture& shell_out) {
    if (!valid()) return false;
    if (!shell_full.valid())
      shell_full = gpu::Device::createTexture(kShellRes, kShellRes,
                                              gpu::TextureFormat::RGBA16F);
    if (!shell_coarse.valid())
      shell_coarse = gpu::Device::createTexture(kCoarseRes, kCoarseRes,
                                                gpu::TextureFormat::RGBA16F);
    if (!sdf_vol.valid())
      sdf_vol = gpu::Device::createTexture3D(kVolRes, kVolRes, kVolRes,
                                             gpu::TextureFormat::RGBA16F);
    if (!shell_full.valid() || !shell_coarse.valid() || !sdf_vol.valid())
      return false;

    // --- Shape params -> world quantities ---
    // Body + flakes must stay inside the volume's inscribed sphere (kExt0).
    const float R = 0.28f + 0.27f * radius;
    float amp = 0.5f * R * ridge_depth;
    if (R + amp > 0.82f) amp = 0.82f - R;
    const float freq = 4.0f * std::pow(2.0f, (ridge_scale - 0.5f) * 4.0f);
    // Radial-displacement Lipschitz compression: slope ~ amp * freq (noise
    // gradient ~1.5/unit folded into the constant), conservative. Terrace
    // cliffs steepen the field well past the smooth-fbm bound; feathering's
    // along-flow smear only ever smooths, so it needs no margin.
    const float steep = 1.0f + 2.0f * ridge_sharp;
    const float lip_true =
        1.0f / (1.0f + 3.0f * amp * freq * steep / std::fmax(R, 0.1f));
    // Floor keeps coarse marching from crawling, but a floored grid stores
    // distances LONGER than the true bound — the march widens its fine-tier
    // handoff band by lip/lip_true (capped) to absorb the overshoot.
    float lip = std::fmax(lip_true, 0.15f);

    desc.field_class = fx::sdf_field::SphericalHeightmap;
    desc.radius = R;
    desc.lip = lip;
    desc.lip_true = lip_true;
    desc.crest_amp = amp;
    // Crest shading emphasis only exists when there are ridges to crest.
    desc.crest_gain = std::fmin(1.0f, 10.0f * ridge_depth);
    desc.grid_ext = fx::sdf_field::kGridExt;
    desc.shell_res = (float)kShellRes;
    desc.has_grid = desc.has_shell = true;
    grid_out = sdf_vol;
    shell_out = shell_full;

    // Morph walks a closed circle in the noise domain — seamless, no drift.
    const float mx = 5.0f * std::cos(kTau * (float)morph_phase);
    const float mz = 5.0f * std::sin(kTau * (float)morph_phase);

    // --- Pass 0: shell update (full + coarse) ---
    ShellUniforms su = {};
    su.ridge_scale = freq;
    su.ridge_amp = amp;
    su.ridge_sharp = ridge_sharp;
    su.morph_x = mx;
    su.morph_z = mz;
    su.seed = variation * 10.0f;
    su.aniso = ridge_aniso;
    su.swirl = swirl;
    su.wobble = 0.35f;
    // Band-limit octaves at the FULL map's Nyquist (cycles/rad) for BOTH
    // map resolutions — same fade => same field => terrace parity holds.
    su.bl_nyq = (float)kShellRes / 6.2831853f;

    // Both maps evaluate the SAME field (same octaves): the terrace cut is a
    // hard nonlinearity, so differing octave counts could land on different
    // terrace levels — a whole plate step of surface divergence, enough for
    // the coarse march to tunnel through a protruding plate. The coarse map
    // differs only by resolution (sub-voxel error the band handoff absorbs).
    su.res = (float)kShellRes;
    su.octaves = 4.0f;
    ub_shell_full.writeOne(su);
    su.res = (float)kCoarseRes;
    su.octaves = 4.0f;
    ub_shell_coarse.writeOne(su);

    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(g_pso_shell);
      cp.setTexture(shell_full, 0, 1);
      cp.setBuffer(ub_shell_full, 1);
      cp.dispatch(kShellRes / 8, kShellRes / 8);
      cp.end();
    }
    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(g_pso_shell);
      cp.setTexture(shell_coarse, 0, 1);
      cp.setBuffer(ub_shell_coarse, 1);
      cp.dispatch(kCoarseRes / 8, kCoarseRes / 8);
      cp.end();
    }

    // --- Pass 1: bake shell -> SDF volume ---
    BakeUniforms bu = { R, lip, 3.0f * (2.0f * kExt0 / (float)kVolRes), 0.f };
    ub_bake.writeOne(bu);
    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(g_pso_bake);
      cp.setTexture(shell_coarse, 0, 0);
      cp.setSampler(samp_clamp, 1);
      cp.setTexture(sdf_vol, 2, 1);
      cp.setBuffer(ub_bake, 3);
      cp.dispatch(kVolRes / 4, kVolRes / 4, kVolRes / 4);
      cp.end();
    }
    return true;
  }
};

}  // namespace plume_gen
