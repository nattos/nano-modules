/*
 * source.sdf.plume_field — the plume sculptor as a standalone SDF
 * provider.
 *
 * Contains exactly the generator half of source.sdf.plume (shared
 * single-source via plume/field_gen.h): the Shape params author a
 * ridged, morphing displacement field on an octahedral shell map,
 * baked into a 128³ SDF volume — and instead of rendering it, this
 * effect publishes it on the `sdf_field` rail (effect_sdf_field.h)
 * for any SDF renderer downstream. First proof of the "SDFs should be
 * able to be anything / providable by other effects" direction: the
 * geometry now travels separately from the camera/light/atmosphere.
 *
 * Video is untouched: tex_in passes through to tex_out (clear when
 * unwired), and the field is only sculpted while something actually
 * consumes the rail.
 */

#include <gpu.h>
#include <host.h>
#include <effect_sdf_field.h>

#include "../plume/field_gen.h"
#include "plume_field_shaders.h"

namespace plume_field {

static gpu::ComputePSO s_pso_prefill;

struct State {
  bool initialized = false;
  plume_gen::Sculptor gen;
  fx::sdf_field::Publisher rail_pub;
};

void module_init() {
  auto schema = state::Schema()
      .helpField("intro",
        "## Plume Field\n"
        "The plume sculptor on its own: the same ridged, wind-swept, "
        "morphing displaced sphere — but instead of rendering it, this "
        "effect publishes the geometry on the `sdf_field` rail. Wire it "
        "into an SDF renderer downstream (e.g. **Plume**, whose own "
        "Shape group goes inert) to split the shape from the look: one "
        "effect sculpts, another lights and renders.\n\n"
        "The video input passes through untouched.");
  plume_gen::Sculptor::declareSchema(schema,
        "*Radius* is the body; *Ridge Depth/Scale* shape the displacement "
        "riding on it. *Sharpness* carves the field into terraced plates — "
        "at 0 the surface stays a smooth rolling heightfield. *Feathering* "
        "smears the pattern along the flow into wind-swept shingles. "
        "*Morph* drifts the field along a closed loop — it breathes "
        "forever without ever jumping. *Variation* picks a different "
        "pattern. The result leaves on `sdf_field`, not on the video "
        "output.")
      // --- I/O ---
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput);
  fx::sdf_field::declare(schema, state::SecondaryOutput);
  schema.capability(state::Capability::Generator);
  state::init("source.sdf.plume_field", {1, 0, 0}, schema);

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Generator shaders (shell/bake) register with the shared sculptor.
  plume_gen::moduleInit();
  state::registerShaderSPV("plume_field_prefill", PLUME_FIELD_PREFILL_SPV,
                           PLUME_FIELD_PREFILL_SPV_SIZE);
  auto cs_prefill = gpu::Device::createShaderModuleByName("plume_field_prefill");
  if (!cs_prefill) return;
  s_pso_prefill = gpu::Device::createComputePSO(cs_prefill, "main",
      gpu::Bindings()
          .tex2d(0)
          .storageTex2d(1));

  state::log("plume_field: module initialized");
}

void* create() {
  auto* s = new State();
  s->gen.createBuffers();
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->gen.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->gen.resetPhase();
  s->initialized = s->gen.valid() && s_pso_prefill.valid();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!(dt > 0.0)) dt = 0.0;
  if (dt > 0.050) dt = 0.050;
  s->gen.tick(dt);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    s->gen.patch(pb + off[i], len[i], i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  // Sculpt + publish only while something consumes the rail.
  if (state::isOutputConnected("sdf_field")) {
    fx::sdf_field::Desc field;
    gpu::Texture grid, shell;
    if (s->gen.run(field, grid, shell))
      s->rail_pub.publish(field, grid.id, shell.id);
  }

  // Video passthrough (clear when unwired — the field is the output).
  if (in.valid()) {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill);
    cp.setTexture(in, 0, 0);
    cp.setTexture(out, 1, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  } else {
    gpu::Device::clear(out, 0.0f, 0.0f, 0.0f, 0.0f);
  }
  gpu::Device::submit();
}

void on_resolume_param(void* self, long long param_id, double value) {
  (void)self; (void)param_id; (void)value;
}

} // namespace plume_field
