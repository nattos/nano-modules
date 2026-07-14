/*
 * mod.source.bpm — Transport tempo modulation source.
 *
 * Publishes the host's tempo every frame as two channels: the raw BPM, and
 * the duration of one beat in seconds (60 / BPM). No clock state, no
 * accumulators — a pure per-frame read of the host transport, so a time jump
 * always yields the correct frame (TimeIndependent).
 *
 * Note the wire fold consumes RAW output values (an output's declared
 * [min,max] is the UI-band contract, not a normalizer), so the BPM channel
 * saturates most destinations — it's meant for displays, math shapers, and
 * period-style inputs. Beat Length stays in a directly usable range at
 * ordinary tempos (0.5 s at 120 BPM).
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>

namespace mod_bpm {

// Per-instance state. Nothing to carry — the module is a stateless host read;
// the struct exists only to satisfy the instance ABI.
struct State {};

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.source.bpm", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## BPM\n"
        "The host tempo as modulation: the raw **BPM**, and **Beat Length** — "
        "the duration of one beat in seconds (60 / BPM, 0.5 s at 120 BPM).\n\n"
        "Wires fold raw values, so the BPM channel pegs most destinations — "
        "run it through a math shaper first, or wire *Beat Length* where a "
        "small seconds value is wanted (delays, periods, envelopes).\n\n"
        "**Try:** wire *Beat Length* into a delay time for a tempo-synced "
        "echo that follows the host BPM live.")
      // --- Outputs ---
      .group("output", "Output")
      // The canonical channel: the host tempo, verbatim. The declared [0,300]
      // is the UI-band contract — the wire fold still consumes the raw BPM.
      .floatField("bpm", 120.0f, 0.f, 300.f, state::PrimaryOutput, "unsigned",
                  0.f, "BPM")
        .label("BPM", "BPM")
      // Seconds per beat = 60 / BPM. [0,4] spans down to 15 BPM.
      .floatField("beat_seconds", 0.5f, 0.f, 4.f, state::SecondaryOutput, "unsigned",
                  0.f, "s")
        .label("Beat Length", "Beat")
      // Two channels, BPM canonical. Stateless per-frame host read — time
      // jumps land on the correct value by construction.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
      .capability(state::Capability::TimeIndependent)
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
  (void)self; (void)dt;
  const double bpm = host::bpm();
  const double beat_seconds = bpm > 1e-6 ? 60.0 / bpm : 0.0;

  auto bh = val::number(bpm);
  state::setValPath("bpm", bh);
  val::release(bh);
  auto sh = val::number(beat_seconds);
  state::setValPath("beat_seconds", sh);
  val::release(sh);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  (void)self; (void)n; (void)pb; (void)off; (void)len; (void)ops;
  // No inputs — nothing to mirror.
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_bpm
