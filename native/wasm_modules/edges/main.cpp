/*
 * filter.edges — Sobel edge detection over the luminance of the input.
 *
 * Standard params:
 *   threshold   [0, 1]  gradient magnitude below this is discarded.
 *
 * Tuning params:
 *   line_color_r/g/b    drawn over detected edges. Default white.
 *   bg_color_r/g/b      filled where no edge is found. Default black.
 *   keep_input  [0, 1]  multiplied with line/bg result so non-edge pixels can
 *                       optionally fade back to the source image instead of bg.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "edges_shaders.h"

namespace edges {

struct Uniforms {
  float threshold;
  float keep_input;
  float radius_px;
  float line_r, line_g, line_b;
  float bg_r;
  float bg_g, bg_b;
  float _pad[3];
};

// Per-instance state. One per chain entry.
struct State {
  float threshold = 0.1f;
  float keep_input = 0.0f;
  float radius = 0.0f;
  float line[3] = { 1.0f, 1.0f, 1.0f };
  float bg[3]   = { 0.0f, 0.0f, 0.0f };
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("filter.edges", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Edges\n"
        "A Sobel edge detector that traces the outlines in the image and paints "
        "them over a flat background. Tune *Threshold* and *Radius* to control "
        "which edges survive, then restyle the result with the colours below.\n\n"
        "**Try:** a low *Threshold* for delicate line art, or raise it to keep "
        "only the boldest contours. Dial up *Keep Input* to blend the outlines "
        "back over the original footage instead of a solid fill.")
      .group("detect", "Detection")
        .groupHelp(
          "*Threshold* sets how strong a gradient must be to register as an edge — "
          "low finds fine detail, high keeps only hard contours. *Radius* widens "
          "the sampling so lines come out thicker and softer.")
      .floatField("threshold",  0.1f, 0.f, 1.f, state::PrimaryInput).label("Threshold", "Thr")
      .floatField("radius",     0.0f, 0.f, 1.f, state::PrimaryInput).label("Radius", "Rad")
      .group("look", "Appearance")
        .groupHelp(
          "Recolour the result: *Line* is the edge colour, *Background* fills "
          "everywhere else. *Keep Input* blends the original image back in behind "
          "the lines, from a solid fill (0) to full footage (1).")
      .floatField("keep_input", 0.0f, 0.f, 1.f, state::SecondaryInput).label("Keep Input", "Keep")
      .rgbField("line", 1.0f, 1.0f, 1.0f, state::SecondaryInput).label("Line Colour", "Line")
      .rgbField("bg",   0.0f, 0.0f, 0.0f, state::SecondaryInput).label("Background", "BG")
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

// Per-instance init tail: defaults + mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->threshold = 0.1f;
  s->keep_input = 0.0f;
  s->radius = 0.0f;
  s->line[0] = s->line[1] = s->line[2] = 1.0f;
  s->bg[0] = s->bg[1] = s->bg[2] = 0.0f;
  s->initialized = false;

  if (!s_pso.valid()) return;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) { (void)self; (void)dt; }


void on_state_patched(void* self, int n, const char* pb, const int* off, const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "threshold"))  s->threshold = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius"))     s->radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "keep_input")) s->keep_input = state::patchFloat(i);
    else if (state::pathIs(p, l, "line")) {
      auto v = state::patchVec3(i); s->line[0] = v.x; s->line[1] = v.y; s->line[2] = v.z;
    }
    else if (state::pathIs(p, l, "bg")) {
      auto v = state::patchVec3(i); s->bg[0] = v.x; s->bg[1] = v.y; s->bg[2] = v.z;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  float radius_px = 1.0f + s->radius * (static_cast<float>(min_dim) * 0.025f);

  Uniforms u = {};
  u.threshold = s->threshold;
  u.keep_input = s->keep_input;
  u.radius_px = radius_px;
  u.line_r = s->line[0]; u.line_g = s->line[1]; u.line_b = s->line[2];
  u.bg_r   = s->bg[0];   u.bg_g   = s->bg[1];   u.bg_b   = s->bg[2];
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace edges
