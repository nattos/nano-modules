/*
 * mod.shaper.remap — Remap shaper.
 *
 * A unary modulation shaper: takes one scalar modulation value on `input`,
 * runs it through the EXACT same range-remapper the wire-options "remap" uses,
 * and republishes the shaped value on `output`. Pure data module — no GPU, no
 * texture I/O (same shape as mod.source.lfo).
 *
 * The remap math is `tap_mod::applyTapMod` (native/src/sketch/tap_mod.h), the
 * lock-step twin of web/src/tap-mod.ts. By reusing it verbatim, this effect's
 * output is byte-identical to driving the same remap directly on a wire — and
 * web/native parity is automatic (the web executor loads the same .wasm).
 *
 * Pipeline (see applyTapMod): normalize input to [0,1] over [in_min,in_max] →
 * (saturate | foldback) → curve_in (ease-in) → curve_out (ease-out) →
 * [out_min,out_max] → * scale (applied LAST, in modulation space).
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). All instance callbacks take
 * `self`. Input arrives as a state patch on `input` (the wire delivers it via
 * setParamFloat); we recompute + republish `output` every tick so a downstream
 * wire always sees a fresh value.
 */

#include <host.h>
#include <val.h>
#include <sketch/tap_mod.h>

namespace mod_remap {

// Per-instance state. One per chain entry. Mirrors the schema field-for-field.
struct State {
  float input    = 0.0f;
  float in_min   = 0.0f;
  float in_max   = 1.0f;
  float out_min  = 0.0f;
  float out_max  = 1.0f;
  int   curve_in  = 0;   // tap_mod::Curve order: 0 linear,1 quad,2 circular,3 power,4 foldback
  int   curve_out = 0;
  float exponent = 2.0f;
  bool  saturate = false;
  float scale    = 1.0f;
};

static tap_mod::Curve toCurve(int c) {
  switch (c) {
    case 1:  return tap_mod::Curve::Quad;
    case 2:  return tap_mod::Curve::Circular;
    case 3:  return tap_mod::Curve::Power;
    case 4:  return tap_mod::Curve::Foldback;
    case 0:
    default: return tap_mod::Curve::Linear;
  }
}

// Shape the input through the wire-identical remapper and publish `output`.
static void recompute(State& s) {
  tap_mod::Mod m;
  m.scale    = s.scale;
  m.hasRemap = true;            // explicit remapper — always apply the curves
  m.inMin    = s.in_min;
  m.inMax    = s.in_max;
  m.outMin   = s.out_min;
  m.outMax   = s.out_max;
  m.saturate = s.saturate;
  m.curveIn  = toCurve(s.curve_in);
  m.curveOut = toCurve(s.curve_out);
  m.exponent = s.exponent;

  float out = tap_mod::applyTapMod(s.input, m);
  auto vh = val::number(out);
  state::setValPath("output", vh);
  val::release(vh);
}

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.remap", {1, 0, 0},
    state::Schema()
      // The signal to shape (wire target). Declared [0,1] so an unsigned source
      // passes straight through the default identity window; a signed source's
      // wire folds into this range like any consumer input (set in_min<0 to
      // reshape a bipolar signal). The `magnitude` decl marks this as THE
      // modulation INPUT channel (the symmetric twin of a source's magnitude'd
      // output) — that's how the executor's shaper auto-connect locates it among
      // the tuning float params (in_min/out_max/...). The value ("unsigned") is
      // just the channel's nominal polarity; it doesn't constrain wired sources.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned")
      // Input window mapped to [0,1] before the curves.
      .floatField("in_min", 0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("in_max", 1.0f, -1.f, 1.f, state::PrimaryInput)
      // Output window the shaped [0,1] is mapped onto.
      .floatField("out_min", 0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("out_max", 1.0f, -1.f, 1.f, state::PrimaryInput)
      // Ease-in / ease-out shaping curves (same set as the wire remap).
      .selectField("curve_in", 0, state::PrimaryInput,
                   {{"Linear", 0}, {"Quad", 1}, {"Circular", 2},
                    {"Power", 3}, {"Foldback", 4}})
      .selectField("curve_out", 0, state::PrimaryInput,
                   {{"Linear", 0}, {"Quad", 1}, {"Circular", 2},
                    {"Power", 3}, {"Foldback", 4}})
      // Tuning: exponent for the Power curve, hard clip, post-scale.
      .floatField("exponent", 2.0f, 0.25f, 8.f, state::SecondaryInput)
      .boolField("saturate", false, state::SecondaryInput)
      .floatField("scale", 1.0f, -2.f, 2.f, state::SecondaryInput)
      // Shaped value. min/max is the modulation-range contract (the UI band
      // samples this declared range, matching the default out window). Unipolar
      // by default; set out_min<0 for a bipolar reshape (the contract stays
      // [0,1] — schema range is static, same convention as mod.source.lfo).
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
  // Input + params for this frame have already been delivered via state patches
  // (applyReadTaps runs before doTick). Republish the shaped output so the
  // downstream wire reads a current value.
  recompute(*s);
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "input"))     s->input    = state::patchFloat(i);
    else if (state::pathIs(p, l, "in_min"))    s->in_min   = state::patchFloat(i);
    else if (state::pathIs(p, l, "in_max"))    s->in_max   = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_min"))   s->out_min  = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_max"))   s->out_max  = state::patchFloat(i);
    else if (state::pathIs(p, l, "curve_in"))  s->curve_in  = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "curve_out")) s->curve_out = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "exponent"))  s->exponent = state::patchFloat(i);
    else if (state::pathIs(p, l, "saturate"))  s->saturate = state::patchFloat(i) >= 0.5f;
    else if (state::pathIs(p, l, "scale"))     s->scale    = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_remap
