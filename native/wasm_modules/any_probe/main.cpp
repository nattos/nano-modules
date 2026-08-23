/*
 * debug.any_probe — test fixture for POLYMORPHIC (`any`) ports. TEST-ONLY.
 *
 * Two `any` inputs and one `any` output. What it does is report what it was
 * handed: `saw_float` republishes the number patched into `in_a`, `saw_texture`
 * goes to 1 when a texture handle is bound there instead. That is the direct
 * evidence that the executor's lowering resolved the wire to the right RAIL
 * kind — a float rail delivers a state patch, a texture rail a bound handle,
 * and the two arrive through completely different channels.
 *
 * `in_b` exists so the tie-break has something to disagree with: wiring
 * different classes to the two inputs must resolve to in_a's, since it is
 * declared first (see wire_types.h).
 *
 * The output aliases whatever came in — for textures that is a handle copy, not
 * a blit, which is the whole reason a polymorphic switch is cheap. Note this
 * effect declares no `texture` output, so hasTextureOutput is false and it never
 * renders: it ticks, publishes, and passes the image chain through. That is the
 * intended shape for a polymorphic router, and captureWriteTaps still picks up
 * the aliased handle.
 *
 * Pure data module — no GPU work, no texture I/O of its own.
 */

#include <host.h>
#include <gpu.h>
#include <val.h>

namespace any_probe {

struct State {
  float in_a = 0.0f;      // last float patched into in_a (if it resolved to float)
};

void module_init() {
  state::init("debug.any_probe", {1, 0, 0},
    state::Schema()
      .group("input", "Input")
      // Declared FIRST — the tie-break winner when both inputs are wired to
      // different classes.
      .anyField("in_a", state::SecondaryInput).label("In A", "A")
      .anyField("in_b", state::SecondaryInput).label("In B", "B")
      .group("output", "Output")
      .anyField("out", state::PrimaryOutput).label("Out", "Out")
      // Telemetry: which channel the value actually arrived on.
      .floatField("saw_float", 0.0f, -1.f, 1.f, state::SecondaryOutput, "signed")
        .label("Saw Float", "SawF")
      .floatField("saw_texture", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Saw Texture", "SawT")
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::TimeIndependent)
  );
}

void* create() { return new State(); }

void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) *s = State{};
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  // Read taps land before doTick, so both channels are already populated.
  // textureForField is a plain state lookup with no render context, which is
  // what lets a never-rendering node discriminate here rather than in render().
  auto tex = gpu::Device::textureForField("in_a");
  const bool isTex = tex.valid();

  auto sf = val::number(s->in_a);
  state::setValPath("saw_float", sf);
  val::release(sf);
  auto st = val::number(isTex ? 1.0f : 0.0f);
  state::setValPath("saw_texture", st);
  val::release(st);

  // Alias the input onto the output, on whichever channel it arrived.
  if (isTex) {
    state::setGpuTexture("out", tex.id);
  } else {
    auto o = val::number(s->in_a);
    state::setValPath("out", o);
    val::release(o);
  }
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "in_a")) s->in_a = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;   // pure data module
}

}  // namespace any_probe
