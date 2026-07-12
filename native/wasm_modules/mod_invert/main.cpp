/*
 * mod.shaper.invert — Invert shaper.
 *
 * A unary modulation shaper that flips a signal upside down: `output` is
 * 1 - `input` when inversion is on, and the untouched `input` when it isn't.
 *
 * Two controls decide "on", and they XOR:
 *   invert  (bool)  — the parameter. Automatable, wireable, saved with the patch.
 *   trigger (event) — toggles an INTERNAL latch on each rising edge.
 * The latch is the stateful half: a trigger flips it and it stays flipped. XOR-ing
 * the two means either control can invert on its own, and either can UN-invert
 * what the other did — so a momentary trigger stays a momentary trigger even when
 * the patch was saved with `invert` already on, instead of being a dead switch.
 *
 *   invert  latch   output
 *   ------  -----   ------
 *   off     off     input          (both agree: pass through)
 *   on      off     1 - input
 *   off     on      1 - input
 *   on      on      input          (two inversions cancel)
 *
 * Inversion is around the input's declared [0,1] modulation range — the same
 * contract every other shaper folds a wired source into — so a bipolar source
 * arrives already folded into [0,1] and 1-x is its mirror image.
 *
 * STATEFUL: the latch survives across frames, so this module does NOT declare
 * TimeIndependent (its output isn't a pure function of its params) — same reason
 * mod.shaper.threshold doesn't.
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Input + params arrive as
 * state patches before doTick; we recompute + republish `output` every tick so a
 * downstream wire always reads a current value.
 */

#include <host.h>
#include <val.h>

namespace mod_invert {

// Per-instance state. One per chain entry.
struct State {
  float input  = 0.0f;   // latest modulation value
  bool  invert = false;  // the `invert` parameter
  bool  latch  = false;  // internal toggle, flipped by each `trigger` rising edge
  bool  trigger_prev = false;  // edge detector — a HELD trigger toggles once, not every frame
};

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.invert", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Invert\n"
        "Flips a modulation signal upside down — what was at the top of its range "
        "comes out at the bottom. Off, it passes the signal straight through.\n\n"
        "There are two ways to turn it on and they **combine**: the *Invert* switch, "
        "and *Trigger*, which flips a hidden latch each time it fires. Either one "
        "inverts on its own, and either one cancels the other — so a trigger keeps "
        "working as a momentary flip even in a patch saved with *Invert* already on.\n\n"
        "**Try:** wire an LFO in and a footswitch or MIDI note into *Trigger* to flip "
        "the whole modulation's polarity mid-performance, without touching the "
        "source.")
      .group("invert", "Invert")
      // The signal to flip (wire target). The `magnitude` decl marks this as THE
      // modulation INPUT channel — that's how the executor's shaper auto-connect
      // finds it. Declared [0,1]: a wired source folds into this range like any
      // consumer input, and the inversion mirrors it about the range's midpoint.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input", "In")
      // The parameter half of the XOR. Wireable/automatable like any bool.
      .boolField("invert", false, state::PrimaryInput).label("Invert", "Inv")
      // The stateful half: each rising edge toggles an internal latch.
      .eventField("trigger", state::PrimaryInput).label("Trigger", "Trig")
      // The shaped value. Unipolar [0,1] — inverting a signal doesn't change the
      // range it lives in, so the output's contract matches the input's.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // A unary modulation shaper: 1 modulation value in -> 1 shaped value out.
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::ModulationShaperUnary)
  );
}

void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  *s = State{};
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  // Input + params for this frame were delivered via state patches before doTick
  // (applyReadTaps runs first). XOR the parameter against the latch: on ⇒ mirror
  // the value about the middle of its declared [0,1] range.
  const bool flip = (s->invert != s->latch);
  const float out = flip ? (1.0f - s->input) : s->input;
  auto vh = val::number(out);
  state::setValPath("output", vh);
  val::release(vh);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "input"))  s->input  = state::patchFloat(i);
    else if (state::pathIs(p, l, "invert")) s->invert = state::patchFloat(i) >= 0.5f;
    else if (state::pathIs(p, l, "trigger")) {
      // Rising edge only: a trigger sitting high must toggle the latch ONCE, not
      // once per delivery. The executor already patches a field only when its
      // value CHANGES, so a held trigger arrives just once in practice — the edge
      // check makes the module correct on its own terms instead of leaning on
      // that, and it's the same idiom env_adsr uses for its trigger.
      const bool t = state::patchEvent(i);
      if (t && !s->trigger_prev) s->latch = !s->latch;
      s->trigger_prev = t;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_invert
