/*
 * debug.rw_storage_test — Verifies read-write storage textures.
 *
 * Uses an r32float scratch texture bound as `texture_storage_2d<r32float,
 * read_write>`. The single shader writes a known value, reads it back,
 * adds 0.5, writes back, then reads again — proving the binding really
 * supports both reads and writes within a dispatch.
 *
 * The shader is hand-authored WGSL because the project's HLSL pipeline
 * currently squashes all storage textures to rgba8unorm-write via sed.
 * It's only a few lines, so this is the path of least resistance.
 */

#include <gpu.h>
#include <host.h>

namespace rw_storage_test {

// Single shader: scratch[xy] = 0.25; scratch[xy] += 0.5; out = scratch[xy].
// scratch is r32float read_write storage; out is rgba8unorm write storage.
static const char COMPUTE_WGSL[] = R"WGSL(
@group(0) @binding(0) var scratch  : texture_storage_2d<r32float, read_write>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(outputTex);
  if (gid.x >= dim.x || gid.y >= dim.y) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  textureStore(scratch, p, vec4<f32>(0.25, 0.0, 0.0, 0.0));
  let r0 = textureLoad(scratch, p).r;
  textureStore(scratch, p, vec4<f32>(r0 + 0.5, 0.0, 0.0, 0.0));
  let r1 = textureLoad(scratch, p).r;
  textureStore(outputTex, p, vec4<f32>(r1, r1, r1, 1.0));
}
)WGSL";

static gpu::ComputePSO s_pso;
static gpu::Texture s_scratch;
static int s_scratch_w = 0;
static int s_scratch_h = 0;
static bool s_initialized = false;

void init() {
  s_initialized = false;

  state::init("debug.rw_storage_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;
  // WebGPU only — Metal would need MSL, but tests run in browser.
  if (gpu::Device::backend() != gpu::Backend::WebGPU) return;

  auto cs = gpu::Device::createShaderModule(COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .storageTex2dRW(0, gpu::TextureFormat::R32F)
      .storageTex2d(1,   gpu::TextureFormat::RGBA8));

  s_initialized = true;
  state::log("rw_storage_test: initialized");
}

void tick(double) {}
void on_param_change(int, double) {}
void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int w, int h) {
  if (!s_initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  if (!s_scratch.valid() || s_scratch_w != w || s_scratch_h != h) {
    s_scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::R32F);
    s_scratch_w = w;
    s_scratch_h = h;
  }
  if (!s_scratch.valid()) return;

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(s_scratch, 0, 2);  // access=2 (read_write) — host stores it but
                                    // the actual access is encoded in the shader.
  cp.setTexture(out,       1, 1);
  cp.dispatch((w + 7) / 8, (h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace rw_storage_test
