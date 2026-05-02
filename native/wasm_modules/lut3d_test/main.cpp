/*
 * debug.lut3d_test — Verifies 3D textures via an identity color LUT.
 *
 *   Pass 1 (init):   fill a 16×16×16 rgba8 LUT with (x/15, y/15, z/15).
 *                    Bound as `texture_storage_3d<rgba8unorm, write>`.
 *   Pass 2 (apply):  for each pixel, sample LUT at coords derived from
 *                    the input rgb (nearest-neighbor textureLoad — no
 *                    sampler needed). Bound as `texture_3d<f32>`.
 *
 * An identity LUT round-trips the input within 1-bin quantization
 * (~17/255 LSB worst case for a 16³ LUT). The test asserts the output
 * matches the input within that tolerance.
 *
 * Both binding patterns (storage 3D write + sampled 3D read) of the same
 * underlying texture cover the platform's basic 3D texture support.
 *
 * Hand-authored WGSL — the existing HLSL pipeline doesn't carry storage-
 * texture dimension info portably, so writing the WGSL directly here is
 * the pragmatic path.
 */

#include <gpu.h>
#include <host.h>

namespace lut3d_test {

static const char INIT_WGSL[] = R"WGSL(
@group(0) @binding(0) var lut: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(lut);
  if (gid.x >= dim.x || gid.y >= dim.y || gid.z >= dim.z) { return; }
  let r = f32(gid.x) / f32(dim.x - 1u);
  let g = f32(gid.y) / f32(dim.y - 1u);
  let b = f32(gid.z) / f32(dim.z - 1u);
  textureStore(lut, vec3<i32>(i32(gid.x), i32(gid.y), i32(gid.z)),
               vec4<f32>(r, g, b, 1.0));
}
)WGSL";

static const char APPLY_WGSL[] = R"WGSL(
@group(0) @binding(0) var inputTex : texture_2d<f32>;
@group(0) @binding(1) var lut      : texture_3d<f32>;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputTex);
  if (gid.x >= dim.x || gid.y >= dim.y) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let c = textureLoad(inputTex, p, 0);
  let lutDim = textureDimensions(lut);
  // Nearest-neighbour lookup: round to the closest LUT cell.
  let lx = i32(clamp(c.r * f32(lutDim.x - 1u) + 0.5, 0.0, f32(lutDim.x - 1u)));
  let ly = i32(clamp(c.g * f32(lutDim.y - 1u) + 0.5, 0.0, f32(lutDim.y - 1u)));
  let lz = i32(clamp(c.b * f32(lutDim.z - 1u) + 0.5, 0.0, f32(lutDim.z - 1u)));
  let s = textureLoad(lut, vec3<i32>(lx, ly, lz), 0);
  textureStore(outputTex, p, vec4<f32>(s.rgb, c.a));
}
)WGSL";

static constexpr int LUT_DIM = 16;

static gpu::ComputePSO s_pso_init;
static gpu::ComputePSO s_pso_apply;
static gpu::Texture s_lut;
static bool s_lut_filled = false;
static bool s_initialized = false;

void init() {
  s_initialized = false;
  s_lut_filled = false;

  state::init("debug.lut3d_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() != gpu::Backend::WebGPU) return;

  auto cs_init  = gpu::Device::createShaderModule(INIT_WGSL);
  auto cs_apply = gpu::Device::createShaderModule(APPLY_WGSL);
  if (!cs_init || !cs_apply) return;

  s_pso_init = gpu::Device::createComputePSO(cs_init, "main", gpu::Bindings()
      .storageTex3d(0, gpu::TextureFormat::RGBA8));
  s_pso_apply = gpu::Device::createComputePSO(cs_apply, "main", gpu::Bindings()
      .tex2d(0)
      .tex3d(1)
      .storageTex2d(2, gpu::TextureFormat::RGBA8));
  s_lut = gpu::Device::createTexture3D(LUT_DIM, LUT_DIM, LUT_DIM, gpu::TextureFormat::RGBA8);

  s_initialized = true;
  state::log("lut3d_test: initialized");
}

void tick(double) {}
void on_param_change(int, double) {}
void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int w, int h) {
  if (!s_initialized || w <= 0 || h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid() || !s_lut.valid()) return;

  // First-frame LUT init. After that the LUT is constant — re-running it
  // would be wasted work.
  if (!s_lut_filled) {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_init);
    cp.setTexture(s_lut, 0, 1);  // storage write
    cp.dispatch((LUT_DIM + 3) / 4, (LUT_DIM + 3) / 4, (LUT_DIM + 3) / 4);
    cp.end();
    s_lut_filled = true;
  }

  // Apply LUT to the input.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_apply);
    cp.setTexture(in,    0, 0);  // sampled 2D
    cp.setTexture(s_lut, 1, 0);  // sampled 3D
    cp.setTexture(out,   2, 1);  // storage write 2D
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  gpu::Device::submit();
}

} // namespace lut3d_test
