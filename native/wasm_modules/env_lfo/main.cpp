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
 *   rate      (0..1, default 0.5) — oscillation speed (maps to 0..10 Hz)
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
  float rate = 0.5f;
  float amplitude = 1.0f;
  int waveform = ShapeSine;
  float shape = 0.0f;
  bool invert = false;
  // Phase accumulator in cycles [0,1). Advanced by dt*rate every tick (style
  // guide §2.1) so turning the rate knob changes only the FUTURE speed — it
  // never retro-scales elapsed time into a phase jump the way time()*rate does.
  double phase = 0.0;

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

// Type-level setup: schema. Runs once per type.
void module_init() {
  state::init("mod.source.lfo", {1, 0, 0},
    state::Schema()
      .floatField("rate", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("amplitude", 1.0f, 0.f, 1.f, state::PrimaryInput)
      .selectField("waveform", ShapeSine, state::PrimaryInput,
                   {{"Sine", ShapeSine},
                    {"Square", ShapeSquare},
                    {"Triangle", ShapeTriangle},
                    {"Saw", ShapeSaw},
                    {"Random Walk", ShapeRandomWalk},
                    {"Random FM", ShapeRandomFM}})
      // Morphs the active waveform (see file header for the per-shape meaning).
      .floatField("shape", 0.0f, 0.f, 1.f, state::PrimaryInput)
      // Flip the output: 1 - value (stays in [0,1]).
      .boolField("invert", false, state::PrimaryInput)
      // Unipolar [0,1] output — declared so a wire's "Auto" magnitude maps it as
      // unsigned. min/max is the modulation-range contract: the UI band samples
      // this declared range, NOT the live amplitude-scaled swing (intentional).
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // A single-channel modulation source: one canonical scalar output.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
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
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  double rate = s->rate * 10.0;  // map 0-1 param to 0-10 Hz
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
    // Every other shape advances phase at the base rate.
    s->phase += dt * rate;
    bool wrapped = s->phase >= 1.0;
    s->phase -= std::floor(s->phase);
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

  float value = w * s->amplitude * 0.5f + 0.5f;
  if (value < 0.0f) value = 0.0f;
  if (value > 1.0f) value = 1.0f;
  if (s->invert) value = 1.0f - value;  // flip in [0,1]

  // Write to instance state at /output
  auto vh = val::number(value);
  state::setValPath("output", vh);
  val::release(vh);
}


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
    else if (state::pathIs(pb + off[i], len[i], "waveform"))
      s->waveform = static_cast<int>(state::patchFloat(i));
    else if (state::pathIs(pb + off[i], len[i], "shape"))
      s->shape = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "invert"))
      s->invert = state::patchFloat(i) != 0.0f;
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self;
  (void)vp_w; (void)vp_h;
  // No rendering — pure data module
}

} // namespace env_lfo
