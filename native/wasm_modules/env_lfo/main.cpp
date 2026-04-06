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
#include <io.h>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static float s_rate = 0.5f;
static float s_amplitude = 1.0f;

// Scratch buffer for JSON output
static char s_json_buf[64];

static int float_to_json(char* buf, int max_len, float value) {
  // Simple float-to-string for JSON (limited precision but avoids snprintf)
  int neg = value < 0;
  if (neg) value = -value;
  int whole = static_cast<int>(value);
  int frac = static_cast<int>((value - whole) * 10000 + 0.5f);
  int len = 0;
  if (neg && len < max_len) buf[len++] = '-';
  // whole part
  if (whole == 0 && len < max_len) {
    buf[len++] = '0';
  } else {
    char tmp[16]; int tl = 0;
    while (whole > 0 && tl < 16) { tmp[tl++] = '0' + (whole % 10); whole /= 10; }
    for (int i = tl - 1; i >= 0 && len < max_len; i--) buf[len++] = tmp[i];
  }
  if (len < max_len) buf[len++] = '.';
  // 4 decimal digits
  char fd[4] = {
    static_cast<char>('0' + (frac / 1000) % 10),
    static_cast<char>('0' + (frac / 100) % 10),
    static_cast<char>('0' + (frac / 10) % 10),
    static_cast<char>('0' + frac % 10),
  };
  for (int i = 0; i < 4 && len < max_len; i++) buf[len++] = fd[i];
  return len;
}

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_rate = 0.5f;
  s_amplitude = 1.0f;

  state::setMetadata("com.nattos.env_lfo", {1, 0, 0});
  state::declareParam(0, "Rate", state::ParamType::Standard, 0.5f);
  state::declareParam(1, "Amplitude", state::ParamType::Standard, 1.0f);
  io::declareDataOutput(0, "Output", io::Role::Primary);
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
  int len = float_to_json(s_json_buf, sizeof(s_json_buf), value);
  state_set("output", 6, s_json_buf, len);
}

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == 0) s_rate = static_cast<float>(value);
  else if (index == 1) s_amplitude = static_cast<float>(value);
}

__attribute__((export_name("on_state_changed")))
void on_state_changed() {}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  (void)vp_w; (void)vp_h;
  // No rendering — pure data module
}

} // extern "C"
