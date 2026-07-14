/*
 * mod.shaper.motion — Motion shaper: how fast is the input moving?
 *
 * A unary modulation shaper that reports the input's SPEED, not its position —
 * a normalized differentiator with performance dynamics on top:
 *
 *   Rate     — per-tick displacement over dt, one-pole smoothed (`smooth`) so
 *              stepped/jittery input reads as continuous motion, normalized by
 *              `sense` (the full-scale rate, input ranges per second) and
 *              clamped to [-1, 1].
 *   Momentum — catch fast, coast slow: rising |v| is caught instantly (zero
 *              attack lag), but when the motion stops the velocity coasts down
 *              exponentially over a momentum-scaled time (~0..2 s) — flick the
 *              knob and the reading lingers, the "throw".
 *   Integrate (optional) — accumulate the motion instead of reporting it raw.
 *              Activity: |v| charges a meter that drains over `decay` — a
 *              "how alive is this knob" envelope. Throw: signed v is flung
 *              into a position resting at 0.5 that leaks back over `return_time`
 *              — a throwable fader.
 *
 * Outputs: `output` is the unsigned speed (or the integrator level when
 * Integrate is on); `velocity` is always the live post-momentum SIGNED
 * velocity (input moving down reads negative).
 *
 * Velocity is displacement-based (net input delta per tick), so two patches
 * that wiggle up-then-down WITHIN one frame cancel to zero — correct for
 * velocity, a slight undercount for Activity. Accepted at ~60 fps tick rates.
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). Params arrive as state
 * patches; ALL time-domain math runs in tick() (patches for a frame land
 * first), and both outputs republish every tick.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>
#include <cmath>

namespace mod_motion {

enum Mode : int {
  ModeActivity = 0,
  ModeThrow = 1,
};

// Activity fill rate at |v| = 1, in meter-units/second: steady pegged motion
// crosses 1.0 in ~1/3 s and saturates at charge*decay (clamped) — full feels
// reachable without an asymptotic crawl.
constexpr float kActivityCharge = 3.0f;
// Throw displacement per (velocity * second): a brisk flick (~0.2-0.35 v*s of
// clamped velocity + coast) lands ~0.3-0.5 of the range away from rest.
constexpr float kThrowGain = 1.5f;
// Sign-flip catch threshold: a genuine reversal blows past 2% of full scale in
// a frame or two; zero-crossing jitter from quantized input never does.
constexpr float kReverseGate = 0.02f;

// Per-instance state. One per chain entry.
struct State {
  // Param mirrors (patched).
  float input = 0.0f;
  float sense = 1.0f;        // full-scale rate, input ranges / second
  float smooth = 0.08f;      // rate one-pole tau, seconds
  float momentum = 0.2f;     // 0..1 -> coast tau = 2 * m^2 seconds
  bool  integrate = false;
  int   mode = ModeActivity;
  float decay = 0.5f;        // Activity drain tau, seconds
  float return_time = 1.5f;  // Throw leak-to-rest tau, seconds

  // Dynamics.
  bool  initialized = false; // first tick seeds prev_input — no ghost spike
  bool  reset_acc = false;   // integrate/mode changed this transaction
  float prev_input = 0.0f;   // input as of the previous tick
  float v_smooth = 0.0f;     // smoothed raw rate, ranges/second (unclamped)
  float v_hold = 0.0f;       // post-clamp post-momentum velocity, [-1, 1]
  float acc = 0.0f;          // integrator: Activity level or Throw position
};

static float accRest(int mode) {
  return (mode == ModeThrow) ? 0.5f : 0.0f;
}

// Integrator fields only apply when Integrate is on, and decay/return swap
// with the mode. Touches the type-shared schema, so it takes the values
// (env_lfo pattern) — called from on_state_ready, from integrate/mode patches,
// and from eval_visibility.
static void apply_visibility(bool integrate, int mode) {
  state::setFieldHidden("mode", !integrate);
  state::setFieldHidden("decay", !(integrate && mode == ModeActivity));
  state::setFieldHidden("return_time", !(integrate && mode == ModeThrow));
}

// Static (self-less) visibility evaluator — pure over state.
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  bool integrate = false;
  int mode = ModeActivity;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "integrate")) integrate = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(pb + off[i], len[i], "mode")) mode = (int)state::patchFloat(i);
  }
  apply_visibility(integrate, mode);
}

static void on_state_ready(void* self);

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.motion", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Motion\n"
        "Reports how fast its input is **moving**, not where it is. At the "
        "*Full Scale* rate (one full input range per second by default) the "
        "output pegs at 1. *Momentum* catches rising speed instantly but lets "
        "it coast down when the motion stops — flick the knob and the reading "
        "lingers.\n\n"
        "Turn on *Integrate* for two more flavors — **Activity**: motion "
        "charges a meter that drains over *Decay* (a \"how alive is this "
        "knob\" envelope); **Throw**: flicks fling a value away from center "
        "and it leaks back over *Return* — a throwable fader.\n\n"
        "**Try:** link *Input* to a knob you perform on and wire *Output* into "
        "an effect amount — the effect blooms while you move and settles when "
        "you rest.")
      // --- Input: the watched signal ---
      .group("input", "Input")
        .groupHelp(
          "*Input* is the watched signal (auto-wired from a preceding "
          "modulation source, or link it to any knob). Only its motion "
          "matters — a resting input reads as zero.")
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input", "In")
      // --- Response: normalization, smoothing, coast ---
      .group("response", "Response")
        .groupHelp(
          "*Full Scale* sets the speed that pegs the meter, in input ranges "
          "per second — at 1.0 a one-second full sweep reads 1. *Smoothing* "
          "steadies stepped or jittery input. *Momentum* lets speed coast "
          "down after the motion stops (up to ~2 s) instead of cutting off; "
          "rising speed is always caught instantly.")
      .floatField("sense", 1.0f, 0.1f, 8.f, state::PrimaryInput,
                  nullptr, 0.f, "/s").label("Full Scale", "Scale")
      .floatField("smooth", 0.08f, 0.f, 0.5f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Smoothing", "Smth")
      .floatField("momentum", 0.2f, 0.f, 1.f, state::PrimaryInput).label("Momentum", "Mom")
      // --- Integrate: accumulate the motion ---
      .group("integrate", "Integrate")
        .groupHelp(
          "Accumulates the motion instead of reporting it raw. **Activity** "
          "charges toward 1 while the input moves and drains over *Decay*. "
          "**Throw** integrates signed velocity into a flingable position "
          "resting at 0.5 — flicks displace it, *Return* pulls it home.")
      .boolField("integrate", false, state::PrimaryInput).label("Integrate", "Int")
      .selectField("mode", ModeActivity, state::PrimaryInput,
                   {{"Activity", ModeActivity}, {"Throw", ModeThrow}}).label("Mode", "Mode")
      .floatField("decay", 0.5f, 0.05f, 5.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Decay", "Dec")
      // Throw-mode leak time. Hidden in Activity (and vice versa).
      .floatField("return_time", 1.5f, 0.1f, 10.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Return", "Ret")
      // --- Outputs ---
      .group("output", "Output")
      // Unsigned speed — or the integrator level when Integrate is on.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned").label("Output", "Out")
      // Always the live post-momentum signed velocity; rest is 0 (mid).
      .floatField("velocity", 0.0f, -1.f, 1.f, state::SecondaryOutput, "signed").label("Velocity", "Vel")
      // A unary modulation shaper: 1 modulation value in -> its motion out.
      // Stateful (rate pole, coast, accumulator), so seeks are approximate —
      // init() re-seeds and the meter simply resumes from rest.
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::ModulationShaperUnary)
      .capability(state::Capability::SeekableApproximate)
  );
  state::setOnStateReady(&on_state_ready);
}

// Fired after init + initial state replay: apply the integrator visibility.
static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_visibility(s->integrate, s->mode);
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
  if (!s->initialized) {
    // The initial state replay delivered the sketch params as REAL patches
    // before this tick (default 0 -> e.g. 0.7). Fold all of it into the seed
    // and zero the dynamics — a freshly-dropped node reads as at-rest, never
    // as a ghost velocity spike.
    s->prev_input = s->input;
    s->v_smooth = 0.0f;
    s->v_hold = 0.0f;
    s->acc = accRest(s->mode);
    s->reset_acc = false;
    s->initialized = true;
  }
  if (s->reset_acc) {
    // Integrate toggled / mode switched this transaction: re-seed the
    // accumulator at the NEW mode's rest (deferred here, mod_flip style, so a
    // transaction patching both fields resolves with the final values).
    s->reset_acc = false;
    s->acc = accRest(s->mode);
  }
  if (dt > 0.0 && std::isfinite(dt)) {
    // --- Rate estimate (input ranges / second). Patches land before doTick,
    // so input - prev_input is exactly the net delta this frame.
    float delta = s->input - s->prev_input;
    s->prev_input = s->input;
    if (!std::isfinite(delta)) delta = 0.0f;  // a NaN patch must not poison the pole
    const float inst = delta / (float)dt;
    const float a = (s->smooth > 1e-3f) ? 1.0f - std::exp(-(float)dt / s->smooth) : 1.0f;
    s->v_smooth += (inst - s->v_smooth) * a;
    if (std::fabs(s->v_smooth) < 1e-6f) s->v_smooth = 0.0f;  // flush: exact rest

    // --- Normalize + clamp BEFORE momentum: a one-frame full-range jump reads
    // ~ 1/smooth (>>1) — coasting the unclamped value would peg for seconds.
    float v = s->v_smooth / std::fmax(s->sense, 1e-4f);
    v = std::fmax(-1.0f, std::fmin(1.0f, v));

    // --- Momentum: catch fast, coast slow. A genuine reversal also catches
    // (gated so zero-crossing jitter can't kill a coast).
    if (s->momentum <= 1e-3f) {
      s->v_hold = v;
    } else {
      const bool flip = (v > 0.0f) != (s->v_hold > 0.0f);
      if (std::fabs(v) >= std::fabs(s->v_hold) ||
          (flip && std::fabs(v) > kReverseGate)) {
        s->v_hold = v;  // catch: zero attack lag
      } else {
        const float tau = 2.0f * s->momentum * s->momentum;
        s->v_hold *= std::exp(-(float)dt / tau);
        if (std::fabs(s->v_hold) < 1e-4f) s->v_hold = 0.0f;  // flush
      }
    }

    // --- Optional integrator.
    if (s->integrate) {
      if (s->mode == ModeActivity) {
        s->acc *= std::exp(-(float)dt / std::fmax(s->decay, 1e-3f));
        s->acc += std::fabs(s->v_hold) * (float)dt * kActivityCharge;
      } else {
        s->acc += s->v_hold * (float)dt * kThrowGain;
        s->acc += (0.5f - s->acc) *
                  (1.0f - std::exp(-(float)dt / std::fmax(s->return_time, 1e-3f)));
      }
      s->acc = std::fmax(0.0f, std::fmin(1.0f, s->acc));
    }
  }

  // Publish both channels every tick (a downstream wire always reads fresh).
  const float out = s->integrate ? s->acc : std::fabs(s->v_hold);
  auto oh = val::number(out);
  state::setValPath("output", oh);
  val::release(oh);
  auto vh = val::number(s->v_hold);
  state::setValPath("velocity", vh);
  val::release(vh);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "input"))       s->input = state::patchFloat(i);
    else if (state::pathIs(p, l, "sense"))       s->sense = state::patchFloat(i);
    else if (state::pathIs(p, l, "smooth"))      s->smooth = state::patchFloat(i);
    else if (state::pathIs(p, l, "momentum"))    s->momentum = state::patchFloat(i);
    else if (state::pathIs(p, l, "decay"))       s->decay = state::patchFloat(i);
    else if (state::pathIs(p, l, "return_time")) s->return_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "integrate")) {
      bool v = state::patchBool(i);
      if (v != s->integrate) {
        s->integrate = v;
        s->reset_acc = true;
        apply_visibility(s->integrate, s->mode);
      }
    }
    else if (state::pathIs(p, l, "mode")) {
      int m = state::patchInt(i);
      if (m != s->mode) {
        s->mode = m;
        s->reset_acc = true;
        apply_visibility(s->integrate, s->mode);
      }
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_motion
