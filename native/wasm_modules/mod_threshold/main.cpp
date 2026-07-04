/*
 * mod.shaper.threshold — Threshold shaper.
 *
 * A unary modulation shaper: compares the `input` modulation value against a
 * `threshold` and republishes a gate / edge-trigger on `output`. Pure data
 * module — no GPU, no texture I/O (same shape as mod.shaper.smooth / .delay),
 * but STATEFUL in the edge modes: it remembers whether the previous frame was
 * above the threshold so it can detect crossings.
 *
 * `mode` selects what "above threshold" produces:
 *   Hold      — a sustained gate: 1 while input > threshold, else 0.
 *   Up Edge   — a one-frame pulse the frame input crosses UP past threshold.
 *   Down Edge — a one-frame pulse the frame input crosses DOWN past threshold.
 *   Any Edge  — a one-frame pulse on EITHER crossing.
 * `equals` picks which side an input exactly AT the threshold falls on: Below
 * uses strict-greater (at-threshold is off — the default), Above uses
 * greater-or-equal (at-threshold is on). It only changes the boundary sample.
 *
 * To avoid a ghost pulse the frame the node is dropped, the "was above" state is
 * seeded from the first sample (initialized flag) — the edge modes emit 0 on the
 * first frame no matter where the input starts.
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Input + params arrive as
 * state patches; we recompute + republish `output` every tick.
 */

#include <host.h>
#include <val.h>

namespace mod_threshold {

// Per-instance state. One per chain entry.
struct State {
  float input     = 0.0f;   // latest modulation value
  float threshold = 0.5f;   // comparison level
  int   mode      = 0;      // 0 Hold, 1 Up Edge, 2 Down Edge, 3 Any Edge
  int   equals    = 0;      // at-threshold side: 0 Below (strict >), 1 Above (>=)
  bool  prev_above  = false;// was input above threshold last frame? (edge modes)
  bool  initialized = false;// seed prev_above from the first sample, no ghost edge
};

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.threshold", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Threshold\n"
        "Turns a continuous modulation signal into a **gate or trigger** by "
        "comparing it against a level. In *Hold* it stays high the whole time the "
        "input is above the threshold; the *Edge* modes emit a single-frame pulse "
        "the instant the input crosses.\n\n"
        "**Try:** feed an LFO or envelope in and set *Mode* to *Up Edge* to fire a "
        "clean trigger each cycle — wire that into an ADSR or scene launcher. Use "
        "*Hold* instead when you want a sustained on/off gate. *At Threshold* picks "
        "whether a value sitting exactly on the level counts as above or below.")
      .group("threshold", "Threshold")
      // The signal to threshold (wire target). The `magnitude` decl marks this as
      // THE modulation INPUT channel (so the executor's shaper auto-connect
      // locates it); the value is just the channel's nominal polarity.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input", "In")
      // Comparison level. Input strictly above this reads as "on". A signed source
      // folds into [0,1] on the input like any consumer, so 0.5 is the midpoint.
      .floatField("threshold", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Threshold", "Thr")
      // What "above threshold" produces: a sustained gate or an edge pulse.
      .selectField("mode", 0, state::PrimaryInput,
                   {{"Hold", 0}, {"Up Edge", 1}, {"Down Edge", 2}, {"Any Edge", 3}},
                   /*wrap=*/true).label("Mode", "Mode")
      // Which side an input exactly AT the threshold counts as. Below = strict
      // greater (at-threshold is off, the default); Above = greater-or-equal.
      .selectField("equals", 0, state::PrimaryInput,
                   {{"Below", 0}, {"Above", 1}}, /*wrap=*/true).label("At Threshold", "Eq")
      // Gate / trigger value. Always unipolar [0,1] (1 = on/pulse, 0 = off)
      // regardless of the input's polarity — a threshold makes a boolean, so the
      // output is its own contract rather than inheriting the input's range.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // A unary modulation shaper: 1 modulation value in -> 1 gate/trigger out.
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
  // (applyReadTaps runs first). `equals` picks the boundary: Below → strict
  // greater (at-threshold off), Above → greater-or-equal (at-threshold on).
  const bool above = s->equals == 1 ? (s->input >= s->threshold)
                                    : (s->input > s->threshold);
  // Seed the previous state from the first sample so the edge modes don't emit a
  // spurious pulse the frame the node is dropped.
  if (!s->initialized) {
    s->prev_above = above;
    s->initialized = true;
  }
  float out = 0.0f;
  switch (s->mode) {
    case 1:  out = (!s->prev_above && above) ? 1.0f : 0.0f; break;  // up edge
    case 2:  out = (s->prev_above && !above) ? 1.0f : 0.0f; break;  // down edge
    case 3:  out = (s->prev_above != above)  ? 1.0f : 0.0f; break;  // any edge
    case 0:
    default: out = above ? 1.0f : 0.0f; break;                     // hold (gate)
  }
  s->prev_above = above;
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
    if      (state::pathIs(p, l, "input"))     s->input     = state::patchFloat(i);
    else if (state::pathIs(p, l, "threshold")) s->threshold = state::patchFloat(i);
    else if (state::pathIs(p, l, "mode"))      s->mode      = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "equals"))    s->equals    = (int)state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_threshold
