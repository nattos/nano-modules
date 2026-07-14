/*
 * mod.shaper.motion — Motion shaper: how fast is the input moving?
 *
 * A unary modulation shaper that reports the input's SPEED, not its position —
 * a normalized differentiator with performance dynamics on top:
 *
 *   Direction — which way counts: Both (default), Up (rising input only) or
 *              Down (falling only). Rejected-direction motion is zeroed BEFORE
 *              momentum, so nothing coasts, charges or throws off it.
 *   Rate     — displacement over the last `smooth` seconds (a boxcar window,
 *              NOT a one-pole): rate = (x_now - x_then) / span. Accurate for
 *              stepped/quantized input (a dragged knob's per-frame patch steps
 *              read as the true drag speed, not as huge instantaneous spikes),
 *              bounded at Δ/window, and it returns to EXACT zero one window
 *              after the motion stops — no exponential tail, so tight decays
 *              actually feel tight. Window 0 falls back to raw per-frame Δ/dt.
 *              Normalized by `sense` (the full-scale rate, input ranges per
 *              second), clamped to [-1, 1], then shaped by `curve` (a gamma:
 *              <1 lifts slow motion into visibility — delicate; >1 gates it).
 *   Momentum — catch fast, coast slow: rising |v| is caught instantly (zero
 *              attack lag), but when the motion stops the velocity coasts down
 *              exponentially over a momentum-scaled time (~0..2 s) — flick the
 *              knob and the reading lingers, the "throw".
 *   Integrate (optional) — envelope the motion instead of reporting it raw.
 *              Activity: an instant-attack speed envelope — the meter snaps to
 *              |v| and drains over `decay`. Full 0..1 range at ANY decay (the
 *              level is the peak speed, not charge*decay — a fixed charge rate
 *              would cap a 60 ms decay at ~0.2 of the range). Throw: BALLISTIC
 *              — the output is a thrown ball's height. Motion thrusts it
 *              upward; when the motion stops the ball keeps its momentum,
 *              decelerates under gravity, parabolas over, and falls back to
 *              rest at 0. `return_time` is the gravity scale (a fall from the
 *              top takes about that long). Thrust scales WITH gravity
 *              (a = g*(kThrowRatio*|v| - 1)), so a tight Return gives snappy
 *              punchy throws instead of an unliftable ball — and motion slower
 *              than 1/kThrowRatio of full scale can't loft it at all (you
 *              can't throw a ball by nudging it).
 *
 * Outputs: `output` is the unsigned speed (or the integrator level when
 * Integrate is on); `velocity` is always the live post-momentum SIGNED
 * velocity (input moving down reads negative). Both pass through an output
 * stage: `sharpen` (a temporal unsharp mask — the signal's departure from its
 * own ~80 ms average is boosted, so transitions overshoot and edges harden),
 * then an overall `scale` gain, then `rolloff` — a soft ceiling that starts
 * compressing at 1-rolloff and approaches 1 asymptotically (0 = hard clamp).
 * Scale + rolloff together are drive-into-saturation: boost weak readings
 * while fast ones (and sharpen overshoots) roll into the top instead of
 * flat-topping.
 *
 * Defaults are a tuned live preset: a tight, driven Activity meter (integrate
 * ON, 20 ms decay, curve 1.4, scale 2.4 into rolloff 0.85).
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

enum Direction : int {
  DirBoth = 0,
  DirUp = 1,
  DirDown = 2,
};

// Throw thrust-to-gravity ratio: upward acceleration is g*(ratio*|v| - 1), so
// full-speed motion accelerates the ball at 3 g and the lift threshold is a
// fixed 1/ratio of full scale regardless of `return_time`. A 0.3 s pegged
// flick at the 1.5 s default Return apexes around half height; tighter Returns
// throw proportionally harder (the whole trajectory time-scales with Return).
constexpr float kThrowRatio = 4.0f;
// Sign-flip catch threshold: a genuine reversal blows past 2% of full scale in
// a frame or two; zero-crossing jitter from quantized input never does.
constexpr float kReverseGate = 0.02f;
// Boxcar ring capacity: max window (0.5 s) at ~2 ms headless-fast frames is
// ~250 samples; when full the oldest drops and the window shrinks gracefully.
constexpr int kRingCap = 512;
// Sharpen reference lowpass tau: the overshoot a transition gets lasts about
// this long — the "temporal unsharp mask" radius.
constexpr float kSharpenTau = 0.08f;

// Per-instance state. One per chain entry.
struct State {
  // Param mirrors (patched). Defaults MATCH the schema defaults (the tuned
  // live-performance preset: a tight, driven Activity meter).
  float input = 0.0f;
  float sense = 3.0f;        // full-scale rate, input ranges / second
  float smooth = 0.12f;      // rate measurement window, seconds (0 = per-frame)
  float curve = 1.4f;        // response gamma on the normalized speed
  float momentum = 0.0f;     // 0..1 -> coast tau = 2 * m^2 seconds
  int   direction = DirBoth; // which motion counts: both / rising / falling
  bool  integrate = true;
  int   mode = ModeActivity;
  float decay = 0.02f;       // Activity release tau, seconds
  float return_time = 0.12f; // Throw gravity scale (fall-from-top time), seconds
  float sharpen = 0.0f;      // temporal unsharp amount (0 = off)
  float scale = 2.4f;        // overall output gain
  float rolloff = 0.85f;     // soft ceiling: knee at 1 - rolloff (0 = hard clamp)

  // Dynamics.
  bool  initialized = false; // first tick seeds the window — no ghost spike
  bool  reset_acc = false;   // integrate/mode changed this transaction
  float prev_input = 0.0f;   // input as of the previous tick
  float v_hold = 0.0f;       // post-curve post-momentum velocity, [-1, 1]
  float acc = 0.0f;          // integrator: Activity level or Throw ball height
  float u = 0.0f;            // Throw ball's vertical velocity, height-units/s
  float lp_out = 0.0f;       // sharpen reference lowpass, output channel
  float lp_vel = 0.0f;       // sharpen reference lowpass, velocity channel

  // Boxcar window: (t, x) samples of the input, newest at (head - 1). `clock`
  // is a private accumulated-seconds timeline (only spans matter).
  double clock = 0.0;
  float ring_t[kRingCap];
  float ring_x[kRingCap];
  int   ring_head = 0;   // next write slot
  int   ring_count = 0;
};

// Output stage: overall gain, then a soft ceiling. Magnitudes below the knee
// (1 - rolloff) pass straight through; above it they compress along a tanh
// that approaches 1 asymptotically. rolloff 0 is a plain hard clamp. Sign is
// preserved (the signed velocity output saturates symmetrically).
static float shapeOut(float x, float scale, float rolloff) {
  float m = std::fabs(x) * scale;
  const float k = 1.0f - std::fmin(std::fmax(rolloff, 0.0f), 1.0f);
  if (m > k) {
    const float soft = 1.0f - k;
    m = (soft > 1e-4f) ? k + soft * std::tanh((m - k) / soft) : k;
  }
  m = std::fmin(m, 1.0f);
  return (x < 0.0f) ? -m : m;
}

// Displacement over the ring window ending at (now, x_now): evict samples
// older than `window` (always keeping one so the span covers the full window),
// read the rate against the oldest survivor, then push the new sample.
static float windowRate(State* s, float window, float x_now) {
  const float now = (float)s->clock;
  int oldest = (s->ring_head - s->ring_count + kRingCap) % kRingCap;
  while (s->ring_count >= 2) {
    const int next = (oldest + 1) % kRingCap;
    if (s->ring_t[next] > now - window) break;   // next would under-span: keep oldest
    oldest = next;
    s->ring_count--;
  }
  float rate = 0.0f;
  if (s->ring_count >= 1) {
    const float span = now - s->ring_t[oldest];
    if (span > 1e-6f) rate = (x_now - s->ring_x[oldest]) / span;
  }
  if (s->ring_count >= kRingCap) {   // full: drop the oldest, shrink the window
    s->ring_count--;
  }
  s->ring_t[s->ring_head] = now;
  s->ring_x[s->ring_head] = x_now;
  s->ring_head = (s->ring_head + 1) % kRingCap;
  s->ring_count++;
  return rate;
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

// Static (self-less) visibility evaluator — pure over state. Initial values
// MUST mirror the schema defaults (integrate defaults ON in the tuned preset).
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  bool integrate = true;
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
  state::init("mod.shaper.motion", {1, 5, 0},
    state::Schema()
      .helpField("intro",
        "## Motion\n"
        "Reports how fast its input is **moving**, not where it is. Speed is "
        "measured as displacement over the *Window* — accurate for a dragged "
        "knob and back to an exact zero one window after the motion stops. At "
        "the *Full Scale* rate (one full input range per second by default) "
        "the output pegs at 1; *Curve* below 1 lifts slow, delicate motion "
        "into visibility. *Momentum* catches rising speed instantly but lets "
        "it coast down when the motion stops — flick the knob and the reading "
        "lingers.\n\n"
        "Turn on *Integrate* for two more flavors — **Activity**: the meter "
        "snaps to the speed and drains over *Decay* (a \"how alive is this "
        "knob\" envelope, full range at any decay); **Throw**: the output is a "
        "thrown ball's height — motion thrusts it up, and when you stop it "
        "coasts on its momentum, arcs over, and falls back to rest. *Return* "
        "sets the gravity (a fall from the top takes about that long).\n\n"
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
          "per second — at 1.0 a one-second full sweep reads 1. *Curve* "
          "shapes the response: below 1 spreads slow motion across the range "
          "(delicate), above 1 gates it out. *Window* is the span speed is "
          "measured over — longer steadies stepped or jittery input, shorter "
          "is tighter. *Momentum* lets speed coast down after the motion "
          "stops (up to ~2 s) instead of cutting off; rising speed is always "
          "caught instantly. *Direction* filters which way counts — Up reacts "
          "only to a rising input, Down only to a falling one; motion the "
          "other way reads as rest.")
      .floatField("sense", 3.0f, 0.1f, 8.f, state::PrimaryInput,
                  nullptr, 0.f, "/s").label("Full Scale", "Scale")
      .floatField("curve", 1.4f, 0.25f, 4.f, state::PrimaryInput).label("Curve", "Crv")
      .floatField("smooth", 0.12f, 0.f, 0.5f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Window", "Win")
      .floatField("momentum", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Momentum", "Mom")
      .selectField("direction", DirBoth, state::PrimaryInput,
                   {{"Both", DirBoth}, {"Up", DirUp}, {"Down", DirDown}}).label("Direction", "Dir")
      // --- Integrate: accumulate the motion ---
      .group("integrate", "Integrate")
        .groupHelp(
          "Envelopes the motion instead of reporting it raw. **Activity** "
          "snaps to the speed while the input moves and drains over *Decay* "
          "— full range at any decay. **Throw** is ballistic: motion thrusts "
          "a ball upward, and when the motion stops it coasts, arcs over, and "
          "falls home to 0. *Return* sets the gravity — a fall from the top "
          "takes about that long, and tighter Returns throw punchier. Gentle "
          "motion (below a quarter of full scale) won't loft it.")
      .boolField("integrate", true, state::PrimaryInput).label("Integrate", "Int")
      .selectField("mode", ModeActivity, state::PrimaryInput,
                   {{"Activity", ModeActivity}, {"Throw", ModeThrow}}).label("Mode", "Mode")
      // Tight is the sweet spot — the range lives down in the tens of ms.
      .floatField("decay", 0.02f, 0.005f, 2.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Decay", "Dec")
      // Throw-mode gravity scale. Hidden in Activity (and vice versa).
      .floatField("return_time", 0.12f, 0.02f, 3.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Return", "Ret")
      // --- Output stage + outputs ---
      .group("output", "Output")
        .groupHelp(
          "*Sharpen* temporally hardens the signal — an unsharp mask in time "
          "that overshoots transitions, making attacks and releases snap. "
          "*Scale* is an overall gain on the outputs. *Rolloff* softens the "
          "ceiling: 0 clamps hard at 1, higher values start compressing at "
          "1−rolloff and ease into the top asymptotically. Together they "
          "drive-and-saturate — boost weak readings with *Scale* and let "
          "fast ones (and Sharpen's overshoots) roll into the ceiling "
          "instead of flat-topping.")
      .floatField("sharpen", 0.0f, 0.f, 3.f, state::PrimaryInput).label("Sharpen", "Shrp")
      .floatField("scale", 2.4f, 0.f, 4.f, state::PrimaryInput).label("Scale", "Scl")
      .floatField("rolloff", 0.85f, 0.f, 1.f, state::PrimaryInput).label("Rolloff", "Roll")
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
    s->v_hold = 0.0f;
    s->acc = 0.0f;
    s->u = 0.0f;
    s->lp_out = 0.0f;
    s->lp_vel = 0.0f;
    s->reset_acc = false;
    s->clock = 0.0;
    s->ring_head = 0;
    s->ring_count = 0;
    s->ring_t[0] = 0.0f;
    s->ring_x[0] = s->input;
    s->ring_head = 1;
    s->ring_count = 1;
    s->initialized = true;
  }
  if (s->reset_acc) {
    // Integrate toggled / mode switched this transaction: re-seed the
    // accumulator at rest (deferred here, mod_flip style, so a transaction
    // patching both fields resolves with the final values).
    s->reset_acc = false;
    s->acc = 0.0f;
    s->u = 0.0f;
  }
  if (dt > 0.0 && std::isfinite(dt)) {
    s->clock += dt;
    // --- Rate estimate (input ranges / second). Patches land before doTick.
    // A NaN patch must not enter the window (the rate would poison v_hold) —
    // sanitize to the previous sample.
    float x = s->input;
    if (!std::isfinite(x)) x = s->prev_input;
    s->prev_input = x;
    float rate;
    if (s->smooth > 1e-3f) {
      rate = windowRate(s, s->smooth, x);   // boxcar: bounded, exact-zero release
    } else {
      // Window 0: raw per-frame differencing (still push the sample so a live
      // window change resumes with history).
      const int prev = (s->ring_head - 1 + kRingCap) % kRingCap;
      const float x_prev = s->ring_count >= 1 ? s->ring_x[prev] : x;
      rate = (x - x_prev) / (float)dt;
      windowRate(s, 1e-3f, x);
    }
    if (!std::isfinite(rate)) rate = 0.0f;

    // --- Normalize + clamp BEFORE momentum (an unclamped spike would coast
    // pegged for seconds), then the response curve: a gamma on the speed —
    // curve < 1 lifts slow motion into visibility, > 1 gates it out.
    float v = rate / std::fmax(s->sense, 1e-4f);
    // Direction filter: rejected-direction motion reads as rest. Ahead of
    // momentum so it can't coast, and of the integrators so it can't charge
    // the meter or loft the ball.
    if ((s->direction == DirUp   && v < 0.0f) ||
        (s->direction == DirDown && v > 0.0f)) v = 0.0f;
    v = std::fmax(-1.0f, std::fmin(1.0f, v));
    if (s->curve != 1.0f && v != 0.0f) {
      const float mag = std::pow(std::fabs(v), s->curve);
      v = (v < 0.0f) ? -mag : mag;
    }

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
        // Instant-attack speed envelope: snap to |v|, release over `decay`.
        // The level IS the speed (full 0..1 range at any decay) — a fixed
        // charge rate would cap the level at charge*decay, squashing tight
        // decays into the bottom of the range.
        s->acc = std::fmax(std::fabs(s->v_hold),
                           s->acc * std::exp(-(float)dt / std::fmax(s->decay, 1e-3f)));
      } else {
        // Ballistic throw: acc is a ball's height, u its vertical velocity.
        // Gravity g falls the full height in ~return_time (1 = g*T^2/2);
        // motion thrusts upward at g*ratio*|v|, so the net acceleration is
        // g*(ratio*|v| - 1). When the motion stops the ball coasts on its
        // momentum, parabolas over, and falls home to 0.
        const float rt = std::fmax(s->return_time, 1e-2f);
        const float g = 2.0f / (rt * rt);
        s->u += g * (kThrowRatio * std::fabs(s->v_hold) - 1.0f) * (float)dt;
        s->acc += s->u * (float)dt;
        if (s->acc <= 0.0f) {
          s->acc = 0.0f;
          if (s->u < 0.0f) s->u = 0.0f;   // resting on the floor
        } else if (s->acc >= 1.0f) {
          s->acc = 1.0f;
          if (s->u > 0.0f) s->u = 0.0f;   // ceiling: falls as soon as thrust stops
        }
      }
      s->acc = std::fmax(0.0f, std::fmin(1.0f, s->acc));
    }
  }

  // Publish both channels every tick (a downstream wire always reads fresh),
  // through the output stage: temporal sharpen, then scale + rolloff.
  float rawOut = s->integrate ? s->acc : std::fabs(s->v_hold);
  float rawVel = s->v_hold;
  if (dt > 0.0 && std::isfinite(dt)) {
    // Sharpen reference lowpass advances even at sharpen 0, so dialing the
    // param up mid-performance doesn't fire a stale-reference transient.
    const float a = 1.0f - std::exp(-(float)dt / kSharpenTau);
    s->lp_out += (rawOut - s->lp_out) * a;
    s->lp_vel += (rawVel - s->lp_vel) * a;
  }
  if (s->sharpen > 0.0f) {
    // Temporal unsharp mask: boost the signal's departure from its own recent
    // average — transitions overshoot, edges harden. Rolloff downstream tames
    // the overshoot into the soft ceiling.
    rawOut = std::fmax(0.0f, rawOut + s->sharpen * (rawOut - s->lp_out));
    rawVel = rawVel + s->sharpen * (rawVel - s->lp_vel);
  }
  auto oh = val::number(shapeOut(rawOut, s->scale, s->rolloff));
  state::setValPath("output", oh);
  val::release(oh);
  auto vh = val::number(shapeOut(rawVel, s->scale, s->rolloff));
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
    else if (state::pathIs(p, l, "curve"))       s->curve = state::patchFloat(i);
    else if (state::pathIs(p, l, "smooth"))      s->smooth = state::patchFloat(i);
    else if (state::pathIs(p, l, "momentum"))    s->momentum = state::patchFloat(i);
    else if (state::pathIs(p, l, "direction"))   s->direction = state::patchInt(i);
    else if (state::pathIs(p, l, "decay"))       s->decay = state::patchFloat(i);
    else if (state::pathIs(p, l, "return_time")) s->return_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "sharpen"))     s->sharpen = state::patchFloat(i);
    else if (state::pathIs(p, l, "scale"))       s->scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "rolloff"))     s->rolloff = state::patchFloat(i);
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
