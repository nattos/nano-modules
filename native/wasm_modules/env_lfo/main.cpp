/*
 * env.lfo — LFO (Low Frequency Oscillator) data module.
 *
 * Outputs a sine wave as a float value in instance state.
 * Pure data module — no GPU, no texture I/O.
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

static float s_rate = 0.5f;
static float s_amplitude = 1.0f;

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_rate = 0.5f;
  s_amplitude = 1.0f;

  state::init("com.nattos.env_lfo", {1, 0, 0},
    state::Schema()
      .floatField("rate", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("amplitude", 1.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput)
  );
  state::log("LFO: init");
}

__attribute__((export_name("tick")))
void tick(double dt) {
  (void)dt;
  double t = host::time();
  double rate = s_rate * 10.0; // map 0-1 param to 0-10 Hz
  double phase = t * rate * 2.0 * M_PI;
  float value = static_cast<float>(std::sin(phase) * s_amplitude * 0.5 + 0.5);

  // Clamp to [0, 1]
  if (value < 0.0f) value = 0.0f;
  if (value > 1.0f) value = 1.0f;

  // Write to instance state at /output
  auto vh = val::number(value);
  state::setValPath("output", vh);
  val::release(vh);
}

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == 0) s_rate = static_cast<float>(value);
  else if (index == 1) s_amplitude = static_cast<float>(value);
}


__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  (void)vp_w; (void)vp_h;
  // No rendering — pure data module
}

} // extern "C"
