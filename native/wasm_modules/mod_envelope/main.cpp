/*
 * mod.shaper.envelope — Envelope shaper.
 *
 * A unary modulation shaper: remaps the `input` modulation value through an
 * arbitrary user-drawn ENVELOPE curve and republishes it on `output`. Pure data
 * module — no GPU, no texture I/O (same shape as the other mod.* shapers).
 *
 * The curve is a sorted list of (x, y, ease) control points with per-segment
 * exponential easing (envelope.h). The inspector's envelope graph editor
 * (web/src/editors/envelope-inspector.ts) lets you double-click to add/remove
 * nodes and drag segments to bend their easing, serializing the result to the
 * `curve` string field as a flat JSON number array "[x0,y0,e0, ...]". We parse
 * that (only when it changes) and evaluate it on `input` each tick.
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). input + curve arrive as
 * state patches; we evaluate + republish `output` every tick.
 */

#include <host.h>
#include <val.h>
#include <sketch/envelope.h>

#include <cstring>

namespace mod_envelope {

// Default curve: the identity line (0,0)->(1,1), linear → passthrough.
static const char kDefaultCurve[] = "[0,0,0,1,1,0]";

struct State {
  float input = 0.0f;
  char  curveJson[2048] = {};
  envelope::Point points[envelope::kMaxPoints];
  int   nPoints = 0;

  void reparse() {
    nPoints = envelope::parse(curveJson, points, envelope::kMaxPoints);
  }
};

void module_init() {
  state::init("mod.shaper.envelope", {1, 0, 0},
    state::Schema()
      // The signal to remap (wire target). The `magnitude` decl marks this as
      // THE modulation INPUT channel (so the executor's shaper auto-connect
      // locates it); the value is just the channel's nominal polarity.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned")
      // The drawn curve: a flat JSON number array of (x,y,ease) triples. Edited
      // by the custom envelope graph inspector (not a raw text box).
      .textField("curve", kDefaultCurve, state::SecondaryInput)
      // Remapped value. min/max is the modulation-range contract (the curve's y
      // window); unipolar by default, same convention as mod.source.lfo.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // A unary modulation shaper: 1 modulation value in -> 1 remapped value out.
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
  s->input = 0.0f;
  std::strncpy(s->curveJson, kDefaultCurve, sizeof(s->curveJson) - 1);
  s->curveJson[sizeof(s->curveJson) - 1] = '\0';
  s->reparse();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  // input + curve for this frame were delivered via state patches before doTick.
  const float out = envelope::eval(s->points, s->nPoints, s->input);
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
    if (state::pathIs(p, l, "input")) {
      s->input = state::patchFloat(i);
    } else if (state::pathIs(p, l, "curve")) {
      // Re-parse only when the curve actually changes (config edits are rare —
      // native has no dirty-tracking, so avoid re-parsing an identical string).
      char buf[sizeof(State::curveJson)];
      state::patchString(i, buf, sizeof(buf));
      if (std::strcmp(buf, s->curveJson) != 0) {
        std::memcpy(s->curveJson, buf, sizeof(buf));
        s->reparse();
      }
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_envelope
