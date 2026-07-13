/*
 * mod.shaper.flip — Flip-takeover latch.
 *
 * A unary modulation shaper with MIDI-controller "pickup" semantics. The
 * output normally follows the wired scalar input. A trigger FLIPS the output
 * away from it: if the current value reads high (>= 0.5) it snaps to exactly
 * 0.0, otherwise to exactly 1.0 — and the input is UNLATCHED. While unlatched
 * the output holds that rail; we remember which side of the rail the input
 * sat on at flip time, and the moment the input crosses to the other side (or
 * lands on the rail within an epsilon) it "takes over" and the output follows
 * the input directly again.
 *
 * The flip rail is always an exact 0.0 / 1.0, so a beat-wired trigger gives
 * hard full-off/full-on slams that then melt back to the performer's fader as
 * soon as they catch the value — the classic soft-takeover pickup.
 *
 * Wiring: `input` is PrimaryInput, so the executor's shaper auto-connect wires
 * it from the immediately-preceding modulation source. `trigger` is an event
 * field — wire any trigger/gate into it (rising edges flip).
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Inputs arrive as state
 * patches; the takeover check runs in tick() after patches landed, and the
 * output is republished every tick so a downstream wire always reads fresh.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>
#include <cmath>

namespace mod_flip {

// Pickup window: the input "matches" the held rail when it comes within this
// distance — counts as crossing sides, so takeover fires at the rail too
// (an input parked at exactly 1.0 can still catch a high flip).
constexpr float kEps = 1e-3f;

// Per-instance state. One per chain entry.
struct State {
  float input = 0.0f;
  float value = 0.0f;         // the published output
  bool  latched = true;       // true = output follows input (fresh = passthrough)
  int   side = 0;             // side of `value` the input sat on at flip time
  bool  trigger_prev = false; // rising-edge memory for the trigger event
  bool  pending_flip = false; // edge seen this transaction; flip runs in tick()
};

// Which side of the held rail `input` sits on: -1 below, +1 above, 0 within
// the pickup epsilon (touching the rail counts as a takeover crossing).
static int classify(float input, float value) {
  if (input < value - kEps) return -1;
  if (input > value + kEps) return 1;
  return 0;
}

// A rising trigger edge: flip the value to the opposite rail and unlatch.
// Runs in tick() AFTER the frame's patches landed (not directly in
// on_state_patched) so an input and a trigger arriving in the same
// transaction — notably the initial state replay — see each other: the
// low/high read reflects the followed input, whatever the patch order was.
static void flip(State* s) {
  s->value = (s->value >= 0.5f) ? 0.0f : 1.0f;
  s->latched = false;
  s->side = classify(s->input, s->value);
}

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.flip", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Flip\n"
        "A trigger-flipped latch with **pickup** takeover. The output follows "
        "*Input* — until *Trigger* fires: the output then slams to the opposite "
        "rail (an exact **0** or **1**) and parks there. When the input later "
        "catches up to the rail (or crosses it), it *takes over* and the output "
        "follows it again — the soft-takeover behavior of a MIDI fader.\n\n"
        "**Try:** wire a beat trigger in and a fader into *Input* — every beat "
        "slams the param full-on/full-off, and riding the fader up to the rail "
        "catches it back.")
      // --- Input: the followed signal + the flip trigger ---
      .group("input", "Input")
        .groupHelp(
          "*Input* is the signal the output follows (auto-wired from a preceding "
          "modulation source). *Trigger* flips the output to the opposite rail "
          "and unlatches it from the input until the input catches up.")
      // Primary input — the shaper auto-connect wires this from the preceding
      // source. Unsigned [0,1] like the sibling shapers.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input", "In")
      // Rising edges flip. Event field: momentary, rides the numeric channel.
      .eventField("trigger", state::PrimaryInput).label("Trigger", "Trig")
      // --- Output: the latched/following value ---
      .group("output", "Output")
      // Exactly 0/1 while a flip holds; the live input once taken over.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned").label("Output", "Out")
      // A unary modulation shaper: 1 modulation value in -> 1 out. Stateful
      // (the latch can't be reconstructed from a time), so seeks are
      // approximate — after a jump it just resumes from the current latch.
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
  // Patches for this frame already landed (applyReadTaps runs before doTick).
  // Follow first, then flip: a trigger reads the value the input had just
  // driven it to, so "currently low or high" means the followed signal.
  if (s->latched) s->value = s->input;
  if (s->pending_flip) {
    s->pending_flip = false;
    flip(s);
  }
  // Takeover: the input moved to the other side of the held rail (or touched
  // it) — it picks the value back up. Right after a flip, classify == side by
  // construction, so the flip always holds for at least this frame.
  if (!s->latched && classify(s->input, s->value) != s->side) s->latched = true;
  if (s->latched) s->value = s->input;

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
    } else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchFloat(i) != 0.0f;
      if (t && !s->trigger_prev) s->pending_flip = true;   // rising edge only
      s->trigger_prev = t;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_flip
