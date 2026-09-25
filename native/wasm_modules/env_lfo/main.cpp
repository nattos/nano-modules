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
 *   rate      (0.01..120 Hz, def 5) — Freq mode: oscillation speed in Hz, on a
 *                                  log slider. 0 (typed in) stops the LFO. Was a
 *                                  0..1 knob over 0..10 Hz before 1.2.0; saved
 *                                  state migrates ×10 (effect_migrations.h).
 *   pacing    (enum)             — what a cycle faster than the frame rate does:
 *                                  Realtime keeps true wall-clock speed (so it
 *                                  aliases, like any sampled oscillator); Strobe
 *                                  caps it — at or past half the frame rate the
 *                                  output flips between its min and max every
 *                                  frame, overriding the phase accumulator. The
 *                                  random waveforms instead cap at one new value
 *                                  per frame.
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
 *                                  / Random FM / Random Hold
 *   spread    (0..1, default 0.5) — Random Hold only: how much each hold's length
 *                                  varies around one cycle (0 = every cycle
 *                                  exactly; 1 = a quarter to four cycles).
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
 *   Random Hold — glide: 0 jumps to each new value, 1 eases across the whole hold
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
  ShapeRandomHold = 6,  // a new random value, held for a random length
};

// What a cycle faster than the frame rate does (schema `pacing`).
enum Pacing {
  PacingRealtime = 0,  // true wall-clock speed; past Nyquist it aliases
  PacingStrobe = 1,    // capped: min/max alternate every frame
};

// Strobe engages at half the frame rate (a cycle per two frames — the fastest
// a sampled wave can show) and lets go a little below, so frame-time jitter
// right at the threshold doesn't flicker between the two behaviours.
constexpr double kStrobeEnter = 0.5;   // cycles per frame
constexpr double kStrobeExit = 0.45;

// Per-instance state. One per chain entry.
struct State {
  int mode = ModeFreq;
  int sync = SyncFree;
  float rate = 5.0f;          // Hz (Freq mode)
  int pacing = PacingRealtime;
  float period = 1.0f;        // seconds (Period mode)
  float period_beats = 4.0f;  // transport beats (Beats mode; 4 = one bar)
  float amplitude = 1.0f;
  int waveform = ShapeSine;
  float shape = 0.0f;
  bool invert = false;
  float spread = 0.5f;        // Random Hold: hold-length variation
  // Strobe pacing: engaged (with hysteresis) and which extreme this frame shows.
  bool strobing = false;
  bool strobeHigh = false;
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
  // Random Hold: the value it holds (gliding from `holdFrom`), how long this
  // hold lasts and how far into it we are — both in CYCLES of the speed, so
  // Freq / Period / Beats all set its pace.
  float holdFrom = 0.0f;
  float holdTarget = 0.0f;
  double holdLen = 1.0;
  double holdElapsed = 0.0;
  bool holdInit = false;
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

// Show only the speed knob that belongs to the active mode, and Spread only for
// Random Hold. Takes the values, not `self`, so the live path (on_state_ready,
// on_state_patched) and the static one (eval_visibility) share it.
static void apply_visibility(int mode, int waveform) {
  state::setFieldHidden("rate", mode != ModeFreq);
  state::setFieldHidden("period", mode != ModePeriod);
  state::setFieldHidden("period_beats", mode != ModeBeats);
  state::setFieldHidden("spread", waveform != ShapeRandomHold);
}

// Static (self-less) visibility evaluator — pure over state; absent fields
// take their schema defaults.
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  int mode = ModeFreq;
  int waveform = ShapeSine;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "mode")) mode = (int)state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "waveform"))
      waveform = (int)state::patchFloat(i);
  }
  apply_visibility(mode, waveform);
}

static void on_state_ready(void* self);

// Type-level setup: schema. Runs once per type.
void module_init() {
  // 1.2.0: `rate` is Hz (0.01..120, log) instead of a 0..1 knob over 0..10 Hz
  //        — saved state migrates ×10 (native/src/sketch/effect_migrations.h).
  //        Adds `pacing` and the Random Hold waveform (+ `spread`).
  state::init("mod.source.lfo", {1, 2, 0},
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
          "Choose how the cycle rate is set. **Freq** exposes a *Rate* knob in Hz "
          "(0.01–120, spaced evenly per decade); **Period** sets the cycle length directly in seconds — up to 5 "
          "minutes; **Beats** sets it in transport beats (4 = one bar), tracking "
          "BPM changes live. Only the knob for the active mode is shown. *Sync* "
          "— **Free** integrates forward only (knob edits never jump phase); "
          "**Locked** re-anchors the phase to the host clock every frame, so the "
          "cycle rides the beat/timeline exactly and scrubs track (the random "
          "waveforms keep their own free-running walks either way). *Pacing* — "
          "what a cycle faster than the frame rate does: **Realtime** keeps its "
          "true speed (sampled once a frame, so it aliases into slower "
          "patterns); **Strobe** caps it, flipping between min and max every "
          "frame once it reaches half the frame rate.")
      // Tab-bar selector: how the speed knob below is interpreted.
      .selectField("mode", ModeFreq, state::PrimaryInput,
                   {{"Freq", ModeFreq}, {"Period", ModePeriod},
                    {"Beats", ModeBeats}}).label("Mode", "Mode")
      .selectField("sync", SyncFree, state::PrimaryInput,
                   {{"Free", SyncFree}, {"Locked", SyncLocked}}).label("Sync", "Sync")
      .floatField("rate", 5.0f, 0.01f, 120.f, state::PrimaryInput,
                  nullptr, 0.f, "Hz").label("Rate", "Rate").logScale()
      // Period mode: cycle length in seconds, up to 5 min. Hidden otherwise
      // (each mode shows only its own speed knob).
      .floatField("period", 1.0f, 0.1f, 300.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Period", "Period")
      // Beats mode: cycle length in transport beats (4 = one bar).
      .floatField("period_beats", 4.0f, 0.25f, 64.f, state::PrimaryInput,
                  nullptr, 0.f, "beats").label("Period", "Period")
      .selectField("pacing", PacingRealtime, state::PrimaryInput,
                   {{"Realtime", PacingRealtime}, {"Strobe", PacingStrobe}})
        .label("Pacing", "Pace")
      // --- Waveform: the shape of the cycle + its output swing ---
      .group("waveform", "Waveform")
        .groupHelp(
          "Sets the wave shape and how far it swings. *Amplitude* scales the output "
          "toward the full [-1,1]; *Shape* morphs the active waveform (softens a "
          "sine, narrows a pulse, tilts a triangle, bows a saw, widens the random "
          "modes, glides *Random Hold*). **Try** *Random Walk* or *Random FM* for "
          "organic, non-repeating motion, or *Random Hold* for a new random value "
          "every cycle or so — *Spread* varies how long each one holds.")
      .floatField("amplitude", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Amplitude", "Amp")
      .selectField("waveform", ShapeSine, state::PrimaryInput,
                   {{"Sine", ShapeSine},
                    {"Square", ShapeSquare},
                    {"Triangle", ShapeTriangle},
                    {"Saw", ShapeSaw},
                    {"Random Walk", ShapeRandomWalk},
                    {"Random FM", ShapeRandomFM},
                    {"Random Hold", ShapeRandomHold}}, /*wrap=*/true).label("Waveform", "Wave")
      // Morphs the active waveform (see file header for the per-shape meaning).
      .floatField("shape", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Shape", "Shape")
      // Random Hold: hold-length variation around one cycle, as a power of two
      // (0 = every cycle; 1 = a quarter to four cycles). Hidden otherwise.
      .floatField("spread", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Spread", "Sprd")
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
  apply_visibility(s->mode, s->waveform);
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
  s->rate = 5.0f;
  s->pacing = PacingRealtime;
  s->spread = 0.5f;
  s->strobing = false;
  s->strobeHigh = false;
  s->holdFrom = 0.0f;
  s->holdTarget = 0.0f;
  s->holdLen = 1.0;
  s->holdElapsed = 0.0;
  s->holdInit = false;
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

// Cycles per second for the active speed mode. Freq: `rate` is Hz (≤ 0 stops
// it). Period: 1 / seconds (up to 5 min). Beats: BPM/60/beats, tracking tempo
// changes live (the random shapes tempo-sync through this too).
static double cycleRate(const State* s) {
  if (s->mode == ModeBeats) {
    const double beats = s->period_beats < 0.01f ? 0.01 : s->period_beats;
    return host::bpm() / 60.0 / beats;
  }
  if (s->mode == ModePeriod) return 1.0 / (s->period < 0.01f ? 0.01 : s->period);
  return s->rate > 0.f ? s->rate : 0.0;
}

// Strobe pacing: engage at half the frame rate, release a little below (see
// kStrobeExit). While engaged, flip extremes every frame and park the phase on
// the one shown (a quarter / three quarters — a sine's peak and trough), so
// slowing back down continues from there rather than from a stale phase.
static bool updateStrobe(State* s, double cyclesThisFrame) {
  s->strobing = cyclesThisFrame >= (s->strobing ? kStrobeExit : kStrobeEnter);
  if (!s->strobing) return false;
  s->strobeHigh = !s->strobeHigh;
  s->phase = s->strobeHigh ? 0.25 : 0.75;
  return true;
}
static float strobeValue(const State* s) { return s->strobeHigh ? 1.0f : -1.0f; }

// Random Hold's glide: how far (0..1, smoothstepped) the value has eased from
// `holdFrom` to `holdTarget` — across `shape` of the hold; 0 jumps at once.
static double holdGlide(const State* s, float shape) {
  const double span = shape * s->holdLen;
  if (span <= 0.0) return 1.0;
  double t = s->holdElapsed / span;
  if (t > 1.0) t = 1.0;
  return t * t * (3.0 - 2.0 * t);
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

  const double rate = cycleRate(s);
  double periodBeats = s->period_beats;
  if (periodBeats < 0.01) periodBeats = 0.01;  // guard div-by-zero
  float shape = s->shape;
  if (shape < 0.f) shape = 0.f;
  if (shape > 1.f) shape = 1.f;
  int wf = s->waveform;
  const bool strobePacing = s->pacing == PacingStrobe && dt > 0.0;

  float w;  // core waveform in [-1, 1]

  if (wf == ShapeRandomHold) {
    // A new random value, held for a random length of 2^(±2·spread) cycles —
    // so spread 0 changes exactly once a cycle — gliding in over `shape` of the
    // hold. At most one change per frame whatever the pacing: a hold shorter
    // than a frame just starts the next one, which IS the one-per-frame cap.
    s->holdElapsed += dt * rate;
    if (!s->holdInit || s->holdElapsed >= s->holdLen) {
      // Glide on from wherever the value has got to (mid-glide included).
      const float at = s->holdFrom +
          (s->holdTarget - s->holdFrom) * static_cast<float>(holdGlide(s, shape));
      const double leftover = s->holdInit ? s->holdElapsed - s->holdLen : 0.0;
      s->holdTarget = rand01(s) * 2.0f - 1.0f;
      s->holdFrom = s->holdInit ? at : s->holdTarget;  // the first value lands at once
      const float spread = s->spread < 0.f ? 0.f : (s->spread > 1.f ? 1.f : s->spread);
      s->holdLen = std::exp2(2.0 * spread * (rand01(s) * 2.0 - 1.0));
      // Carry the overshoot into the new hold, unless it would end this frame too.
      s->holdElapsed = leftover < s->holdLen ? leftover : 0.0;
      s->holdInit = true;
    }
    const double g = holdGlide(s, shape);
    w = s->holdFrom + (s->holdTarget - s->holdFrom) * static_cast<float>(g);
  } else if (wf == ShapeRandomFM) {
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
    // The carrier is a sine: past the frame rate it strobes like one.
    if (strobePacing && updateStrobe(s, instRate * dt)) {
      w = strobeValue(s);
    } else {
      s->phase += dt * instRate;
      s->phase -= std::floor(s->phase);
      w = static_cast<float>(std::sin(s->phase * 2.0 * M_PI));
    }
  } else if (wf == ShapeRandomWalk) {
    // Walks on its own phase at 10x the base rate (rate is a slow LFO knob, but
    // a random walk should scurry). Step to a new random target on each wrap
    // (or the very first tick) and smooth-step across it; `shape` enlarges the
    // step (walks further). The walk reflects off the [-1,1] walls so it stays
    // in range yet keeps moving. Strobe pacing caps it at a step per frame: once
    // it would take one or more, it lands on each new target outright.
    const double steps = dt * rate * 10.0;
    const bool capped = strobePacing && steps >= 1.0;
    s->rwPhase += steps;
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
    if (capped) {
      s->rwPhase = 0.0;
      w = s->rwTarget;
    } else {
      double rp = s->rwPhase;
      float f = static_cast<float>(rp * rp * (3.0 - 2.0 * rp));  // smoothstep ease
      w = s->rwPrev + (s->rwTarget - s->rwPrev) * f;
    }
  } else if (strobePacing && updateStrobe(s, dt * rate)) {
    // Faster than the frame rate can show: alternate the extremes, and hold
    // the accumulator on them so dropping back below resumes from a peak.
    w = strobeValue(s);
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
    w = deterministicWave(wf, shape, s->phase);
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
  bool vis_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "mode")) {
      int m = static_cast<int>(state::patchFloat(i));
      if (m != s->mode) { s->mode = m; vis_changed = true; }
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
    else if (state::pathIs(pb + off[i], len[i], "waveform")) {
      int wf = static_cast<int>(state::patchFloat(i));
      if (wf != s->waveform) { s->waveform = wf; vis_changed = true; }
    }
    else if (state::pathIs(pb + off[i], len[i], "pacing"))
      s->pacing = static_cast<int>(state::patchFloat(i));
    else if (state::pathIs(pb + off[i], len[i], "spread"))
      s->spread = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "shape"))
      s->shape = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "invert"))
      s->invert = state::patchFloat(i) != 0.0f;
  }
  if (vis_changed) apply_visibility(s->mode, s->waveform);
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
// then land on the same value the forward pass had at `to`. Random Walk / FM / Hold can't be
// replayed, so their walk restarts cleanly at the new time.
void seek(void* self, double /*from*/, double to) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  double ph = to * cycleRate(s);
  s->phase = ph - std::floor(ph);
  // Re-seed the bar tracker at the new time: whole bars estimated from the
  // current tempo (approximate across mid-timeline tempo changes), the
  // fraction re-seeded from the next tick's barPhase.
  s->bars = static_cast<long>(std::floor(to * host::bpm() / 60.0 / kBeatsPerBar));
  s->prev_bar_phase = -1.0;
  s->fmWalkPhase = 0.0;
  s->rwPhase = 0.0;
  s->rwInit = false;
  s->holdInit = false;
  s->strobing = false;
}

} // namespace env_lfo
