/*
 * env.lfo — LFO (Low Frequency Oscillator) data module.
 *
 * Outputs a sine wave as a float value in instance state.
 * Pure data module — no GPU, no texture I/O.
 *
 * Class-like instance model: module_init() publishes the schema once per
 * type; each chain entry gets its own State (params) via create(). All
 * instance callbacks take `self`.
 *
 * Parameters:
 *   0: Rate (Standard, default 0.5) — oscillation speed (Hz * 0.1)
 *   1: Amplitude (Standard, default 1.0) — output range scaling
 *
 * Output:
 *   state.output — sine wave value normalized to [0, 1]
 */

#include <host.h>
#include <val.h>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace env_lfo {

// Per-instance state. One per chain entry.
struct State {
  float rate = 0.5f;
  float amplitude = 1.0f;
};

// Type-level setup: schema. Runs once per type.
void module_init() {
  state::init("data.lfo", {1, 0, 0},
    state::Schema()
      .floatField("rate", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("amplitude", 1.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput)
  );
  state::log("LFO: init");
}

// Per-instance construction.
void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

// Per-instance init tail: defaults.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->rate = 0.5f;
  s->amplitude = 1.0f;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  double t = host::time();
  double rate = s->rate * 10.0; // map 0-1 param to 0-10 Hz
  double phase = t * rate * 2.0 * M_PI;
  float value = static_cast<float>(std::sin(phase) * s->amplitude * 0.5 + 0.5);

  // Clamp to [0, 1]
  if (value < 0.0f) value = 0.0f;
  if (value > 1.0f) value = 1.0f;

  // Write to instance state at /output
  auto vh = val::number(value);
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
    if (state::pathIs(pb + off[i], len[i], "rate"))
      s->rate = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "amplitude"))
      s->amplitude = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self;
  (void)vp_w; (void)vp_h;
  // No rendering — pure data module
}

} // namespace env_lfo
