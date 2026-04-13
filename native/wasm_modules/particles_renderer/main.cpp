/*
 * particles_renderer — consumes a struct rail of GPU-resident particle
 * positions and renders one quad per particle via instanced draw.
 *
 * Schema:
 *   particle_size : float — half-extent of each quad in clip space
 *   tint          : float4 — RGBA modulation
 *   particles_in  : object (Input, Primary)
 *     count       : int           (number of particles to draw)
 *     positions   : array<float> (gpu)  — interleaved x,y per particle
 *     velocities  : array<float> (gpu)  — (read by other consumers; not used here)
 *   tex_out       : texture (Output, Primary)
 *
 * The vertex shader reads positions[instance_index] from the bound
 * storage buffer and emits a screen-aligned quad. No vertex buffer is
 * bound — vertex_index drives quad-corner selection.
 */

#include <gpu.h>
#include <host.h>
#include <cstdint>

namespace particles_renderer {

static const char VERTEX_WGSL[] =
"struct Uniforms {\n"
"  size: vec2<f32>,\n"
"  tint: vec4<f32>,\n"
"};\n"
"@group(0) @binding(0) var<uniform> u: Uniforms;\n"
"@group(0) @binding(1) var<storage, read> positions: array<f32>;\n"
"\n"
"struct VsOut {\n"
"  @builtin(position) pos: vec4<f32>,\n"
"  @location(0) color: vec4<f32>,\n"
"};\n"
"\n"
"@vertex\n"
"fn main(@builtin(vertex_index) vid: u32,\n"
"        @builtin(instance_index) iid: u32) -> VsOut {\n"
"  // Quad corners — two triangles, vid in [0,6).\n"
"  var corners = array<vec2<f32>, 6>(\n"
"    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0, 1.0),\n"
"    vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0, 1.0)\n"
"  );\n"
"  let corner = corners[vid];\n"
"  let px = positions[iid * 2u + 0u];\n"
"  let py = positions[iid * 2u + 1u];\n"
"  let world = vec2<f32>(px, py) + corner * u.size;\n"
"  var out: VsOut;\n"
"  out.pos = vec4<f32>(world, 0.0, 1.0);\n"
"  out.color = u.tint;\n"
"  return out;\n"
"}\n";

static const char FRAGMENT_WGSL[] =
"struct VsOut {\n"
"  @builtin(position) pos: vec4<f32>,\n"
"  @location(0) color: vec4<f32>,\n"
"};\n"
"@fragment\n"
"fn main(in: VsOut) -> @location(0) vec4<f32> {\n"
"  return in.color;\n"
"}\n";

// WGSL std140-ish layout: vec2 occupies 8B but the following vec4
// must start at a 16B boundary, so we pad 8 bytes between them.
struct Uniforms {
  float size_x, size_y;
  float _pad0, _pad1;
  float tint_r, tint_g, tint_b, tint_a;
};

static gpu::RenderPSO s_render_pso;
static gpu::Buffer s_uniform_buf;
static int s_count = 0;
static float s_particle_size = 0.02f;
static float s_tint[4] = {1.0f, 0.7f, 0.2f, 1.0f};
static bool s_dirty = true;
static bool s_initialized = false;

void init() {
  s_initialized = false;

  state::init("video.particles_renderer", {1, 0, 0},
    state::Schema()
      .floatField("particle_size", 0.02f, 0.001f, 0.2f, state::PrimaryInput)
      .vec4Field("tint", 1.0f, 0.7f, 0.2f, 1.0f, state::PrimaryInput)
      .beginObject("particles_in", state::PrimaryInput)
        .intField("count", 0, 0, 100000, state::None)
        .gpuArrayField("positions",  "float", state::None)
        .gpuArrayField("velocities", "float", state::None)
      .endObject()
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  auto vs_mod = gpu::Device::createShaderModule(VERTEX_WGSL);
  auto fs_mod = gpu::Device::createShaderModule(FRAGMENT_WGSL);
  if (!vs_mod || !fs_mod) return;

  s_render_pso = gpu::Device::createInstancedRenderPSO(
      vs_mod, "main", fs_mod, "main", gpu::TextureFormat::Surface);
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("particles_renderer: initialized");
}

void tick(double dt) { (void)dt; }

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (state::pathIs(path, plen, "particle_size")) {
      s_particle_size = state::patchFloat(i);
      s_dirty = true;
    } else if (state::pathIs(path, plen, "tint")) {
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      if (val::typeOf(v.h) == val::Array && val::length(v.h) >= 4) {
        for (int k = 0; k < 4; k++) {
          auto comp = val::Value(val::getIndex(v.h, k));
          s_tint[k] = float(val::asNumber(comp.h));
        }
        s_dirty = true;
      }
    } else if (state::pathIs(path, plen, "particles_in/count")) {
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      s_count = int(val::asNumber(v.h));
    } else if (op == 5 /* dirty */
               && plen >= (int)sizeof("particles_in") - 1
               && state::pathIs(path, (int)sizeof("particles_in") - 1, "particles_in")) {
      // Producer announced a fresh particle frame — nothing eager to do
      // here, the next render() will resolve the buffer and draw.
    }
  }
}

void render(int vp_w, int vp_h) {
  (void)vp_w; (void)vp_h;
  if (!s_initialized) return;

  if (s_dirty) {
    Uniforms u = {
      s_particle_size, s_particle_size,
      0.0f, 0.0f,
      s_tint[0], s_tint[1], s_tint[2], s_tint[3],
    };
    s_uniform_buf.writeOne(u);
    s_dirty = false;
  }

  // Resolve the producer's positions buffer through the rail-installed
  // field path. May be 0 on the first frame before the producer has
  // published — in that case skip rendering and just clear.
  auto positions = gpu::Device::bufferForField("particles_in/positions");

  auto rp = gpu::RenderPass::begin(gpu::Device::renderTarget(),
                                    0.02f, 0.02f, 0.04f, 1.0f);
  if (positions && s_count > 0) {
    rp.setPSO(s_render_pso);
    rp.setBuffer(s_uniform_buf, 0);
    rp.setBuffer(positions, 1);
    rp.draw(6, s_count);
  }
  rp.end();

  gpu::Device::submit();
}

} // namespace particles_renderer
