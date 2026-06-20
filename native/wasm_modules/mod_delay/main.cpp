/*
 * mod.delay — Modulation Delay shaper.
 *
 * A unary modulation shaper: delays the `input` modulation signal by `delay`
 * seconds and republishes it on `output`. Pure data module — no GPU, no texture
 * I/O (same shape as data.lfo / mod.remap / mod.smooth), but STATEFUL: it keeps a
 * time-stamped ring-buffer DELAY LINE (delay_line.h) across frames.
 *
 * Each tick it advances a time accumulator by `dt` (style guide §2.1 — accumulate,
 * don't `time * rate`), pushes the current input onto the delay line, and reads
 * back the value from `delay` seconds ago (linearly interpolated between the two
 * bracketing samples, so the output stays smooth as `delay`/`dt` vary). Use it to
 * offset one copy of a modulation source against another (echoes, call-and-
 * response, phase spreads across channels).
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Input + delay arrive as state
 * patches; we push + read + republish `output` every tick.
 */

#include <host.h>
#include <val.h>
#include <sketch/delay_line.h>

namespace mod_delay {

// Holds ~512 frames of history — at 60fps that's >8s, comfortably covering the
// 2s max delay even at high frame rates (a longer delay underruns gracefully).
static constexpr int kDelayCap = 512;

struct State {
  float  input = 0.0f;
  float  delay = 0.25f;   // seconds
  double clock = 0.0;     // accumulated time
  delay_line::DelayLine<kDelayCap> line;
};

void module_init() {
  state::init("mod.delay", {1, 0, 0},
    state::Schema()
      // The signal to delay (wire target). The `magnitude` decl marks this as
      // THE modulation INPUT channel (so the executor's shaper auto-connect
      // locates it); the value is just the channel's nominal polarity.
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned")
      // Delay time in seconds. 0 ⇒ passthrough. Bounded by the ring-buffer span.
      .floatField("delay", 0.25f, 0.f, 2.f, state::PrimaryInput)
      // Delayed value. min/max is the modulation-range contract (matches the
      // input window); unipolar by default, same convention as data.lfo.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // A unary modulation shaper: 1 modulation value in -> 1 delayed value out.
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
  // Input + delay for this frame were delivered via state patches before doTick
  // (applyReadTaps runs first). Advance the clock, record the current sample,
  // and read back the value from `delay` seconds ago. Before enough history has
  // accumulated, the read clamps to the oldest sample (== the start value), so a
  // freshly-dropped node holds at its input rather than emitting 0.
  s->clock += dt;
  s->line.push(s->clock, s->input);
  const float out = s->line.read(s->clock - (s->delay > 0.f ? s->delay : 0.f));
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
    if      (state::pathIs(p, l, "input")) s->input = state::patchFloat(i);
    else if (state::pathIs(p, l, "delay")) s->delay = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_delay
