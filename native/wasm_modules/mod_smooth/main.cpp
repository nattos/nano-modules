/*
 * mod.smooth — Modulation Smooth shaper.
 *
 * A unary modulation shaper: takes one scalar modulation value on `input` and
 * republishes a LINEARLY SMOOTHED version on `output`, using the EXACT same
 * linear-ramp math as the engine's built-in `FieldOptions.smoothing` option
 * (param_smoothing::advanceSmooth, the lock-step twin of web/src/param-smoothing.ts).
 * Pure data module — no GPU, no texture I/O (same shape as data.lfo / mod.remap),
 * but STATEFUL: it carries the ramp (SmoothState) across frames.
 *
 * On a target change the timer resets, the current value becomes the ramp start,
 * and the value lerps to the new target over `duration` seconds, then holds —
 * reaching the target in finite time (no exponential tail / rubber-banding). So a
 * jumpy modulation source (a stepped sequencer, a noisy envelope) glides instead
 * of snapping. Reusing the built-in math = identical to applying `smoothing` on a
 * wire, and web/native parity is automatic (the web executor loads the same .wasm).
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Input + duration arrive as
 * state patches; we advance the ramp by `dt` and republish `output` every tick.
 */

#include <host.h>
#include <val.h>
#include <sketch/param_smoothing.h>

namespace mod_smooth {

// Per-instance state. One per chain entry.
struct State {
  float input    = 0.0f;   // latest target (the value to ramp toward)
  float duration = 0.25f;  // linear ramp time, seconds
  bool  initialized = false;
  param_smoothing::SmoothState sm;
};

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.smooth", {1, 0, 0},
    state::Schema()
      // The signal to smooth (wire target). The `magnitude` decl marks this as
      // THE modulation INPUT channel (so the executor's shaper auto-connect
      // locates it); the value is just the channel's nominal polarity.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned")
      // Linear ramp duration in seconds (the built-in smoothing's `duration`).
      // 0 ⇒ instant passthrough. Reaches the target in finite time.
      .floatField("duration", 0.25f, 0.f, 2.f, state::PrimaryInput)
      // Smoothed value. min/max is the modulation-range contract (matches the
      // input window); unipolar by default, same convention as data.lfo.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // A unary modulation shaper: 1 modulation value in -> 1 smoothed value out.
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
  // Input + duration for this frame were delivered via state patches before
  // doTick (applyReadTaps runs first). Seed settled at the first input so a
  // freshly-dropped node holds at its value instead of ramping up from 0, then
  // advance the linear ramp by dt each frame.
  if (!s->initialized) {
    s->sm = param_smoothing::initSmooth(s->input, s->duration);
    s->initialized = true;
  }
  float out = param_smoothing::advanceSmooth(s->sm, s->input, s->duration, (float)dt);
  auto vh = val::number(out);
  state::setValPath("output", vh);
  val::release(vh);
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
    if      (state::pathIs(p, l, "input"))    s->input    = state::patchFloat(i);
    else if (state::pathIs(p, l, "duration")) s->duration = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_smooth
