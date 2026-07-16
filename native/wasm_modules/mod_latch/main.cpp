/*
 * mod.shaper.latch — Sample-and-hold latch.
 *
 * A unary modulation shaper holding one floating value. *Trigger* samples the
 * live `input` into it; *Reset* drops it back to the `initial` parameter. The
 * output is just the held value — nothing moves between events, so a wired
 * trigger turns a continuously-moving source into stepped, beat-locked values.
 *
 * The un-triggered state FOLLOWS `initial` (it doesn't copy it once): the
 * latch starts on the Initial slider and returns to it on every reset, so
 * dragging the slider while the latch is resting moves the output live, and a
 * wire into `initial` makes reset mean "follow that other signal until the
 * next trigger". A trigger is a true one-shot sample: rising edge only, one
 * copy of `input`, held until the next event. If a trigger and a reset land
 * on the same frame, the reset wins.
 *
 * Wiring: `input` is PrimaryInput, so the executor's shaper auto-connect wires
 * it from the immediately-preceding modulation source. `trigger`/`reset` are
 * event fields — wire any trigger/gate into them (rising edges fire).
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Inputs arrive as state
 * patches; events resolve in tick() after patches landed, so a trigger and an
 * input arriving in the same transaction sample the fresh input regardless of
 * patch order. The output is republished every tick so a downstream wire
 * always reads fresh.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>

namespace mod_latch {

// Per-instance state. One per chain entry.
struct State {
  float input   = 0.0f;
  float initial = 0.0f;
  float value   = 0.0f;        // the published output
  bool  held    = false;       // true = holding a sampled input; false = following `initial`
  bool  trigger_prev = false;  // rising-edge memory for the trigger event
  bool  reset_prev   = false;  // rising-edge memory for the reset event
  bool  pending_trigger = false; // edge seen this transaction; sample runs in tick()
  bool  pending_reset   = false;
};

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.latch", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Latch\n"
        "A sample-and-hold. The output is one held value: *Trigger* snapshots "
        "the live *Input* into it, *Reset* drops it back to *Initial Value*. "
        "Nothing moves between events — a moving source becomes stepped, "
        "beat-locked values.\n\n"
        "While un-triggered (at start, and after every reset) the output "
        "follows *Initial Value* directly, so the slider stays live and a wire "
        "into it makes reset mean \"follow that signal until the next "
        "trigger\".\n\n"
        "**Try:** wire an LFO into *Input* and a beat trigger into *Trigger* — "
        "the output steps to a fresh random-ish level every beat and holds it "
        "rock-steady in between.")
      // --- Input: the sampled signal + the sample trigger ---
      .group("input", "Input")
        .groupHelp(
          "*Input* is the signal a trigger snapshots (auto-wired from a "
          "preceding modulation source). *Trigger* samples it into the held "
          "value on each rising edge; the value then holds until the next "
          "trigger or reset.")
      // Primary input — the shaper auto-connect wires this from the preceding
      // source. Unsigned [0,1] like the sibling shapers.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input", "In")
      // Rising edges sample `input` into the held value.
      .eventField("trigger", state::PrimaryInput).label("Trigger", "Trig")
      // --- Reset: the resting value + the reset trigger ---
      .group("reset", "Reset")
        .groupHelp(
          "*Reset* abandons the held sample and returns the output to *Initial "
          "Value* — which it then follows until the next trigger. A trigger and "
          "a reset on the same frame resolve to the reset.")
      .floatField("initial", 0.0f, 0.f, 1.f, state::SecondaryInput, "unsigned")
        .label("Initial Value", "Init")
      // Rising edges drop the value back to `initial`.
      .eventField("reset", state::SecondaryInput).label("Reset", "Rst")
      // --- Output: the held value ---
      .group("output", "Output")
      // The sampled input while held; the live `initial` otherwise.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned").label("Output", "Out")
      // A unary modulation shaper: 1 modulation value in -> 1 out. Stateful
      // (the held sample can't be reconstructed from a time), so seeks are
      // approximate — after a jump it just resumes from the current hold.
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::ModulationShaperUnary)
      .capability(state::Capability::SeekableApproximate)
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
  // Patches for this frame already landed (applyReadTaps runs before doTick),
  // so a trigger samples the input value delivered WITH it. Trigger first,
  // reset second: a same-frame pair resolves to the reset.
  if (s->pending_trigger) {
    s->pending_trigger = false;
    s->value = s->input;
    s->held = true;
  }
  if (s->pending_reset) {
    s->pending_reset = false;
    s->held = false;
  }
  // The resting state follows `initial` live (start + after reset).
  if (!s->held) s->value = s->initial;

  auto vh = val::number(s->value);
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
    if (state::pathIs(p, l, "input")) {
      s->input = state::patchFloat(i);
    } else if (state::pathIs(p, l, "initial")) {
      s->initial = state::patchFloat(i);
    } else if (state::pathIs(p, l, "trigger")) {
      const bool t = state::patchEvent(i);
      if (t && !s->trigger_prev) s->pending_trigger = true;   // rising edge only
      s->trigger_prev = t;
    } else if (state::pathIs(p, l, "reset")) {
      const bool t = state::patchEvent(i);
      if (t && !s->reset_prev) s->pending_reset = true;       // rising edge only
      s->reset_prev = t;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_latch
