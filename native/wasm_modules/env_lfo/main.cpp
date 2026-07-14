/*
 * env.lfo — LFO (Low Frequency Oscillator) data module.
 *
 * Emits a single normalized [0,1] modulation scalar into instance state.
 * Pure data module — no GPU, no texture I/O.
 *
 * Class-like instance model: module_init() publishes the schema once per
 * type; each chain entry gets its own State (params) via create(). All
 * instance callbacks take `self`.
 *
 * Parameters:
 *   mode      (enum)             — Freq / Period / Beats. Selects how the speed
 *                                  knob is interpreted; a tab-bar selector. Freq
 *                                  exposes `rate`; Period exposes `period`; Beats
 *                                  exposes `period_beats` (see below).
 *   sync      (enum)             — Free / Locked (mod.source.time semantics).
 *                                  Free integrates dt forward-only (the classic
 *                                  LFO: knob edits never jump phase). Locked
 *                                  re-anchors phase to the host clock every frame
 *                                  — beat/scrub-exact, and two Locked instances
 *                                  always agree; knob edits rescale elapsed time
 *                                  (a phase jump — re-anchoring is the point).
 *                                  The stochastic shapes keep their own walks
 *                                  either way (they can't be replayed).
 *   rate      (0..1, default 0.5) — Freq mode: oscillation speed (maps to 0..10 Hz)
 *   period    (0.1..300s, def 1s) — Period mode: cycle length in seconds (up to
 *                                  5 min), so the LFO can run far slower than Freq
 *                                  mode's 0.1 Hz floor allows.
 *   period_beats (0.25..64, def 4) — Beats mode: cycle length in beats of the
 *                                  host transport (4 = one bar), tracking BPM
 *                                  changes live. With Locked sync the cycle is
 *                                  phase-locked to the downbeat; hosts with no
 *                                  beat info leave a Locked-Beats LFO parked.
 *   amplitude (0..1, default 1.0) — output swing around 0.5
 *   waveform  (enum)             — Sine / Square / Triangle / Saw / Random Walk
 *                                  / Random FM
 *   shape     (0..1, default 0)  — morphs the active waveform (see below)
 *   invert    (bool, default off) — flip the output (1 - value)
 *
 * `shape` per waveform:
 *   Sine        — sine → soft-clipped sine (tanh drive grows)
 *   Square      — duty cycle narrows (square → thin pulse)
 *   Triangle    — peak tilts toward the end (triangle → rising saw)
 *   Saw         — ramp bows with an exponential ease
 *   Random Walk — larger step each cycle (walks further)
 *   Random FM   — wider instantaneous-frequency spread (more FM depth)
 *
 * Output:
 *   state.output — modulation value normalized to [0, 1]
 */

#include <host.h>
#include <val.h>
#include <cmath>
#include <cstdint>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace env_lfo {

// Speed-knob interpretation (schema `mode` select field + State::mode).
enum Mode {
  ModeFreq = 0,    // `rate` knob → 0..10 Hz
  ModePeriod = 1,  // `period` knob → cycle length in seconds (0.1s..300s)
  ModeBeats = 2,   // `period_beats` knob → cycle length in transport beats
};

// Phase anchoring (schema `sync` select field + State::sync) — the same
// Free/Locked split as mod.source.time.
enum Sync {
  SyncFree = 0,    // integrate dt forward-only; never re-anchors
  SyncLocked = 1,  // re-anchor phase to the host clock every frame
};

// The repo-wide transport assumption: host_get_bar_phase spans one 4-beat bar.
constexpr double kBeatsPerBar = 4.0;

// Waveform selector values (schema `waveform` select field + State::waveform).
enum Shape {
  ShapeSine = 0,
  ShapeSquare = 1,
  ShapeTriangle = 2,
  ShapeSaw = 3,
  ShapeRandomWalk = 4,
  ShapeRandomFM = 5,
};

// Per-instance state. One per chain entry.
struct State {
  int mode = ModeFreq;
  int sync = SyncFree;
  float rate = 0.5f;
  float period = 1.0f;        // seconds (Period mode)
  float period_beats = 4.0f;  // transport beats (Beats mode; 4 = one bar)
  float amplitude = 1.0f;
  int waveform = ShapeSine;
  float shape = 0.0f;
  bool invert = false;
  // Phase accumulator in cycles [0,1). Advanced by dt*rate every tick (style
  // guide §2.1) so turning the rate knob changes only the FUTURE speed — it
  // never retro-scales elapsed time into a phase jump the way time()*rate does.
  // (Locked sync deliberately overrides this every frame with the host-anchored
  // phase — there re-anchoring IS the contract.)
  double phase = 0.0;
  // Beats-mode bar tracker (mod_time pattern): barPhase wraps every bar, so
  // count the wraps and reconstruct beats = (bars + barPhase) * 4 exactly.
  // Always advanced (cheap), so switching into Beats mode lands on the live
  // transport position instead of a stale one.
  double prev_bar_phase = -1.0;  // sentinel: -1 = unseeded
  long bars = 0;

  // Per-instance RNG for the stochastic shapes (LCG; deterministic per run).
  uint32_t rng = 0x9E3779B9u;
  // Random Walk: its own phase (advances at 10x the base rate so it scurries),
  // interpolating prev→target and re-stepping on each wrap.
  double rwPhase = 0.0;
  float rwPrev = 0.0f;
  float rwTarget = 0.0f;
  bool rwInit = false;
  // Random FM: a smoothed random walk wanders the carrier's frequency.
  double fmWalkPhase = 0.0;
  float fmMod = 0.0f;
  float fmTarget = 0.0f;
};

// LCG → uniform [0,1).
static inline float rand01(State* s) {
  s->rng = s->rng * 1664525u + 1013904223u;
  return static_cast<float>(s->rng >> 8) * (1.0f / 16777216.0f);
}

// Deterministic waveforms as f(phase) ∈ [-1,1], morphed by `shape` ∈ [0,1].
static float deterministicWave(int wf, float shape, double p) {
  const double TWO_PI = 2.0 * M_PI;
  switch (wf) {
    case ShapeSquare: {
      // Pulse wave: `shape` narrows the high portion (duty 0.5 → 0.05).
      float duty = 0.5f - 0.45f * shape;
      return (p < duty) ? 1.0f : -1.0f;
    }
    case ShapeTriangle: {
      // Tilt the peak from center (triangle) toward the end (rising saw).
      float peak = 0.5f + 0.49f * shape;  // 0.5 → 0.99
      float tri = (p < peak) ? static_cast<float>(p / peak)
                             : static_cast<float>((1.0 - p) / (1.0 - peak));
      return tri * 2.0f - 1.0f;
    }
    case ShapeSaw: {
      // Rising saw; `shape` bows the ramp with an exponential ease (1 → 8).
      float e = std::pow(2.0f, shape * 3.0f);
      return std::pow(static_cast<float>(p), e) * 2.0f - 1.0f;
    }
    case ShapeSine:
    default: {
      // Sine → soft-clipped sine: tanh drive grows with `shape`, blended in so
      // shape==0 is a pure sine.
      float sinv = static_cast<float>(std::sin(p * TWO_PI));
      float drive = 1.0f + 7.0f * shape;
      float clipped = std::tanh(drive * sinv) / std::tanh(drive);
      return sinv + (clipped - sinv) * shape;
    }
  }
}

// Show only the speed knob that belongs to the active mode. Called from
// on_state_ready (once after init + state replay) and from on_state_patched
// whenever `mode` changes — same code path either way. Touches the type-shared
// schema, so it takes the active mode value as an argument.
static void apply_mode_visibility(int mode) {
  state::setFieldHidden("rate", mode != ModeFreq);
  state::setFieldHidden("period", mode != ModePeriod);
  state::setFieldHidden("period_beats", mode != ModeBeats);
}

// Static (self-less) visibility evaluator — pure over state (see crop).
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  int mode = ModeFreq;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "mode")) mode = (int)state::patchFloat(i);
  }
  apply_mode_visibility(mode);
}

static void on_state_ready(void* self);

// Type-level setup: schema. Runs once per type.
void module_init() {
  state::init("mod.source.lfo", {1, 1, 0},
    state::Schema()
      .helpField("intro",
        "## LFO\n"
        "A low-frequency oscillator — a repeating **bipolar** [-1,1] modulation "
        "source that rests at 0, so several stacked LFOs cancel and reinforce "
        "around the unmodulated value.\n\n"
        "**Try:** pick a *Waveform* and set the *Speed*, then wire the output into "
        "any param. Bend *Shape* to morph the wave, switch to **Period** mode "
        "for very slow cycles (up to 5 minutes), or **Beats** to sync the cycle "
        "to the transport tempo.")
      // --- Speed: how fast the wave cycles — Freq, Period, or Beats terms ---
      .group("speed", "Speed")
        .groupHelp(
          "Choose how the cycle rate is set. **Freq** exposes a 0–10 Hz *Rate* "
          "knob; **Period** sets the cycle length directly in seconds — up to 5 "
          "minutes; **Beats** sets it in transport beats (4 = one bar), tracking "
          "BPM changes live. Only the knob for the active mode is shown. *Sync* "
          "— **Free** integrates forward only (knob edits never jump phase); "
          "**Locked** re-anchors the phase to the host clock every frame, so the "
          "cycle rides the beat/timeline exactly and scrubs track (the random "
          "waveforms keep their own free-running walks either way).")
      // Tab-bar selector: how the speed knob below is interpreted.
      .selectField("mode", ModeFreq, state::PrimaryInput,
                   {{"Freq", ModeFreq}, {"Period", ModePeriod},
                    {"Beats", ModeBeats}}).label("Mode", "Mode")
      .selectField("sync", SyncFree, state::PrimaryInput,
                   {{"Free", SyncFree}, {"Locked", SyncLocked}}).label("Sync", "Sync")
      .floatField("rate", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Rate", "Rate")
      // Period mode: cycle length in seconds, up to 5 min. Hidden otherwise
      // (each mode shows only its own speed knob).
      .floatField("period", 1.0f, 0.1f, 300.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Period", "Period")
      // Beats mode: cycle length in transport beats (4 = one bar).
      .floatField("period_beats", 4.0f, 0.25f, 64.f, state::PrimaryInput,
                  nullptr, 0.f, "beats").label("Period", "Period")
      // --- Waveform: the shape of the cycle + its output swing ---
      .group("waveform", "Waveform")
        .groupHelp(
          "Sets the wave shape and how far it swings. *Amplitude* scales the output "
          "toward the full [-1,1]; *Shape* morphs the active waveform (softens a "
          "sine, narrows a pulse, tilts a triangle, bows a saw, widens the random "
          "modes). **Try** *Random Walk* or *Random FM* for organic, non-repeating "
          "motion.")
      .floatField("amplitude", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Amplitude", "Amp")
      .selectField("waveform", ShapeSine, state::PrimaryInput,
                   {{"Sine", ShapeSine},
                    {"Square", ShapeSquare},
                    {"Triangle", ShapeTriangle},
                    {"Saw", ShapeSaw},
                    {"Random Walk", ShapeRandomWalk},
                    {"Random FM", ShapeRandomFM}}, /*wrap=*/true).label("Waveform", "Wave")
      // Morphs the active waveform (see file header for the per-shape meaning).
      .floatField("shape", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Shape", "Shape")
      // Flip the output: negate (stays in [-1,1]).
      .boolField("invert", false, state::PrimaryInput).label("Invert", "Inv")
      // BIPOLAR [-1,1] output — declared so a wire's "Auto" magnitude maps it as
      // signed (rest at 0). min/max is the modulation-range contract: the UI band
      // samples this declared range, NOT the live amplitude-scaled swing (intentional).
      .floatField("output", 0.0f, -1.f, 1.f, state::PrimaryOutput, "signed")
      // A single-channel modulation source: one canonical scalar output.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
      .capability(state::Capability::SeekableApproximate)
  );
  state::setOnStateReady(&on_state_ready);
  state::log("LFO: init");
}

// Fired after init + initial state replay. Hide the inactive mode's speed knob
// so the IDE never paints both at once.
static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_mode_visibility(s->mode);
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
  s->mode = ModeFreq;
  s->sync = SyncFree;
  s->rate = 0.5f;
  s->period = 1.0f;
  s->period_beats = 4.0f;
  s->amplitude = 1.0f;
  s->waveform = ShapeSine;
  s->shape = 0.0f;
  s->invert = false;
  s->phase = 0.0;
  s->rng = 0x9E3779B9u;
  s->rwPhase = 0.0;
  s->rwPrev = 0.0f;
  s->rwTarget = 0.0f;
  s->rwInit = false;
  s->fmWalkPhase = 0.0;
  s->fmMod = 0.0f;
  s->fmTarget = 0.0f;
  s->prev_bar_phase = -1.0;
  s->bars = 0;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  // Bar tracker: advanced every frame regardless of mode (trivially cheap), so
  // switching into Beats mode lands on the live transport position.
  {
    const double bp = host::barPhase();
    if (s->prev_bar_phase < 0.0) {
      s->prev_bar_phase = bp;              // first frame: seed, bars stays 0
    } else {
      if (bp < s->prev_bar_phase - 0.5) s->bars++;   // bar wrap
      s->prev_bar_phase = bp;
    }
  }

  // Cycles per second. Freq mode: 0..10 Hz. Period mode: the period knob is the
  // cycle length in seconds directly (up to 5 min), so freq = 1/seconds. Beats
  // mode: the period is in transport beats, so freq = BPM/60/beats — tracking
  // tempo changes live (the random shapes tempo-sync through this too).
  double periodBeats = s->period_beats;
  if (periodBeats < 0.01) periodBeats = 0.01;  // guard div-by-zero
  double rate;
  if (s->mode == ModeBeats) {
    rate = host::bpm() / 60.0 / periodBeats;
  } else if (s->mode == ModePeriod) {
    double seconds = s->period;
    if (seconds < 0.01) seconds = 0.01;  // guard div-by-zero
    rate = 1.0 / seconds;
  } else {
    rate = s->rate * 10.0;  // map 0-1 param to 0-10 Hz
  }
  float shape = s->shape;
  if (shape < 0.f) shape = 0.f;
  if (shape > 1.f) shape = 1.f;
  int wf = s->waveform;

  float w;  // core waveform in [-1, 1]

  if (wf == ShapeRandomFM) {
    // Random FM: a smoothed random walk wanders the carrier's instantaneous
    // frequency; `shape` widens the frequency spread (FM depth). A new target
    // is drawn each base cycle and approached with a frame-rate-independent
    // one-pole, so the carrier breathes between rate*(1±depth).
    s->fmWalkPhase += dt * rate;
    if (s->fmWalkPhase >= 1.0) {
      s->fmWalkPhase -= std::floor(s->fmWalkPhase);
      s->fmTarget = rand01(s) * 2.0f - 1.0f;
    }
    float k = static_cast<float>(1.0 - std::exp(-dt / 0.08));
    s->fmMod += (s->fmTarget - s->fmMod) * k;
    float depth = shape * 0.9f;  // depth ≤ 0.9 keeps the multiplier > 0
    double instRate = rate * (1.0 + depth * s->fmMod);
    s->phase += dt * instRate;
    s->phase -= std::floor(s->phase);
    w = static_cast<float>(std::sin(s->phase * 2.0 * M_PI));
  } else {
    // Every other shape advances phase at the base rate. Locked sync instead
    // re-anchors the phase to the host clock every frame (mod.source.time
    // semantics): Beats uses the bar-locked beat count over the period, the
    // time-based modes use host time × rate. Knob edits rescale elapsed time
    // (a phase jump) and backward scrubs run the phase backwards — locked
    // follows the host; only Free is forward-only.
    if (s->sync == SyncLocked) {
      double t;
      if (s->mode == ModeBeats) {
        const double beats =
            (static_cast<double>(s->bars) + s->prev_bar_phase) * kBeatsPerBar;
        t = beats / periodBeats;
      } else {
        t = host::time() * rate;
      }
      s->phase = t - std::floor(t);
    } else {
      s->phase += dt * rate;
      s->phase -= std::floor(s->phase);
    }
    double p = s->phase;

    if (wf == ShapeRandomWalk) {
      // Walks on its own phase at 10x the base rate (rate is a slow LFO knob, but
      // a random walk should scurry). Step to a new random target on each wrap
      // (or the very first tick) and smooth-step across it; `shape` enlarges the
      // step (walks further). The walk reflects off the [-1,1] walls so it stays
      // in range yet keeps moving.
      s->rwPhase += dt * rate * 10.0;
      bool step = !s->rwInit || s->rwPhase >= 1.0;
      s->rwPhase -= std::floor(s->rwPhase);
      if (step) {
        s->rwInit = true;
        s->rwPrev = s->rwTarget;
        float stepSize = 0.15f + 0.85f * shape;
        float t = s->rwTarget + (rand01(s) * 2.0f - 1.0f) * stepSize;
        if (t > 1.0f) t = 2.0f - t;
        if (t < -1.0f) t = -2.0f - t;
        if (t > 1.0f) t = 1.0f;
        if (t < -1.0f) t = -1.0f;
        s->rwTarget = t;
      }
      double rp = s->rwPhase;
      float f = static_cast<float>(rp * rp * (3.0 - 2.0 * rp));  // smoothstep ease
      w = s->rwPrev + (s->rwTarget - s->rwPrev) * f;
    } else {
      w = deterministicWave(wf, shape, p);
    }
  }

  // Bipolar [-1,1] output: a signed modulation source rests at 0, so stacking several
  // (combine='add') cancels/reinforces around the unmodulated value instead of all
  // pushing one direction. Wires normalize it into a param's range via the source's
  // declared polarity (a direct wire's "Auto" magnitude reads "signed").
  float value = w * s->amplitude;
  if (value < -1.0f) value = -1.0f;
  if (value > 1.0f) value = 1.0f;
  if (s->invert) value = -value;  // flip in [-1,1]

  // Write to instance state at /output
  auto vh = val::number(value);
  state::setValPath("output", vh);
  val::release(vh);
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  bool mode_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "mode")) {
      int m = static_cast<int>(state::patchFloat(i));
      if (m != s->mode) { s->mode = m; mode_changed = true; }
    }
    else if (state::pathIs(pb + off[i], len[i], "sync"))
      s->sync = static_cast<int>(state::patchFloat(i));
    else if (state::pathIs(pb + off[i], len[i], "rate"))
      s->rate = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "period"))
      s->period = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "period_beats"))
      s->period_beats = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "amplitude"))
      s->amplitude = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "waveform"))
      s->waveform = static_cast<int>(state::patchFloat(i));
    else if (state::pathIs(pb + off[i], len[i], "shape"))
      s->shape = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "invert"))
      s->invert = state::patchFloat(i) != 0.0f;
  }
  if (mode_changed) apply_mode_visibility(s->mode);
}

void render(void* self, int vp_w, int vp_h) {
  (void)self;
  (void)vp_w; (void)vp_h;
  // No rendering — pure data module
}

// Seek to an absolute time `to` (seconds) without ticking every intervening frame —
// the host calls this on a discontinuity (notably a BACKWARD scrub, where a clamped
// dt would otherwise freeze the phase). For the deterministic waveforms the output is
// a pure function of phase, so we recompute phase = to·freq exactly; backward seeks
// then land on the same value the forward pass had at `to`. Random Walk / FM can't be
// replayed, so their walk restarts cleanly at the new time.
void seek(void* self, double /*from*/, double to) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  const double periodBeats = s->period_beats < 0.01f ? 0.01 : s->period_beats;
  double rate;
  if (s->mode == ModeBeats)       rate = host::bpm() / 60.0 / periodBeats;
  else if (s->mode == ModePeriod) rate = 1.0 / (s->period < 0.01 ? 0.01 : s->period);
  else                            rate = s->rate * 10.0;
  double ph = to * rate;
  s->phase = ph - std::floor(ph);
  // Re-seed the bar tracker at the new time: whole bars estimated from the
  // current tempo (approximate across mid-timeline tempo changes), the
  // fraction re-seeded from the next tick's barPhase.
  s->bars = static_cast<long>(std::floor(to * host::bpm() / 60.0 / kBeatsPerBar));
  s->prev_bar_phase = -1.0;
  s->fmWalkPhase = 0.0;
  s->rwPhase = 0.0;
  s->rwInit = false;
}

} // namespace env_lfo
