/*
 * debug.raw_probe — test fixture for the `raw` input contract. TEST-ONLY.
 *
 * Two float inputs that are identical in every respect EXCEPT that one is
 * marked `raw` (host.h's Schema::raw()). Both declare the same non-unit range
 * [-1,1], which is what makes the difference observable: a wire into the plain
 * input folds the source's 0..1 into that range (unsigned magnitude → 0.5 lands
 * at 0.0), while the raw one receives 0.5 verbatim. A [0,1] destination could
 * not tell the two apart — the fold is the identity there — which is exactly
 * why this fixture declares its own range instead of reusing a shipping effect.
 *
 * Each input is republished as its own output so the pair is readable both from
 * the executor's modulation telemetry (native tests) and through a downstream
 * wire (web engine tests).
 *
 * Deliberately NOT a shipping effect: whether a given product field wants raw
 * semantics is a per-field judgement, and this exists to pin the host contract
 * rather than to pre-empt any of those.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>

namespace raw_probe {

struct State {
  float plain = 0.0f;
  float rawv  = 0.0f;
};

void module_init() {
  state::init("debug.raw_probe", {1, 0, 0},
    state::Schema()
      .group("input", "Input")
      // The control: an ordinary modulation input. A wire's magnitude fold maps
      // the source into this declared [-1,1].
      .floatField("plain", 0.0f, -1.f, 1.f, state::PrimaryInput, "unsigned")
        .label("Plain", "Pln")
      // The subject: same type, same range, same polarity — raw. The executor's
      // lowering (destIsRaw in sketch_executor.cpp) drops the magnitude fold for
      // this one, so the wire's shaped value arrives unmapped.
      .floatField("rawv", 0.0f, -1.f, 1.f, state::SecondaryInput, "unsigned")
        .raw()
        .label("Raw", "Raw")
      .group("output", "Output")
      .floatField("plain_out", 0.0f, -1.f, 1.f, state::PrimaryOutput, "signed")
        .label("Plain Out", "POut")
      .floatField("raw_out", 0.0f, -1.f, 1.f, state::SecondaryOutput, "signed")
        .label("Raw Out", "ROut")
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
  // Patches landed before doTick (applyReadTaps runs first); republish every
  // tick so a downstream wire always reads a current value.
  auto a = val::number(s->plain);
  state::setValPath("plain_out", a);
  val::release(a);
  auto b = val::number(s->rawv);
  state::setValPath("raw_out", b);
  val::release(b);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if (state::pathIs(p, l, "plain"))     s->plain = state::patchFloat(i);
    else if (state::pathIs(p, l, "rawv")) s->rawv  = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;   // pure data module
}

}  // namespace raw_probe
