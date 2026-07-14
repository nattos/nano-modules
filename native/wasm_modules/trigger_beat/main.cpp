/*
 * mod.trigger.beat — beat-clock TRIGGER SOURCE.
 *
 * Fires structured trigger EVENTS on a beat division of the host transport
 * (fx::BeatTick over barPhase), published as a bounded ring at state
 * `triggers`: [{seq, on, channel, velocity}, ...]. The composition executor
 * consumes the ring post-render (seq-deduped) and launches matching scenes
 * through rails — trigger events never ride the scalar wire fold.
 *
 * Each tick closes the previous event (an `off` with the same channel) and
 * opens a new `on`. Scenes ignore `off` for now (launch-only); the payload is
 * key-value extensible — consumers ignore unknown keys.
 *
 * A scalar `output` pulse (1 at the tick, exponential decay) doubles as an
 * ordinary single-channel modulation source, so the card has a visible trace
 * and the trigger can ALSO be wired like any mod output. `single_frame`
 * swaps the decay for a hard gate: exactly 1.0 on the frame a tick fires,
 * 0.0 on every other frame — a clean edge for downstream edge/trigger
 * detectors (e.g. Flip).
 *
 * Parameters:
 *   division     (enum)   — ticks per bar: 4 bars .. 1/8 (default: every beat)
 *   phase        (0..1)   — tick phase offset within the division
 *   channel      (1..16)  — the trigger channel id carried on each event
 *   velocity     (0..1)   — the velocity carried on each event (unclamped ok)
 *   single_frame (bool)   — output: one-frame 1.0 gate instead of the decay
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>
#include <effect_beat_tick.h>
#include <cmath>

namespace trigger_beat {

// Ring capacity: generous vs the consumer's per-frame read (a frame sees at
// most a few ticks), tiny vs the published-state payload.
constexpr int kRingCap = 16;

struct Ev {
  long long seq = 0;
  bool on = false;
  int channel = 1;
  float velocity = 1.0f;
};

// Division select codes → BeatTick multipliers (ticks per bar).
constexpr float kDivisionTicks[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f, 8.0f};

struct State {
  int division = 4;  // code into kDivisionTicks (default: every beat)
  float phase = 0.0f;
  float channel = 1.0f;
  float velocity = 1.0f;
  bool single_frame = false;

  fx::BeatTick tick;
  long long seq = 0;
  bool openGate = false;  // an `on` without its `off` yet
  int openChannel = 1;
  Ev ring[kRingCap];
  int ringLen = 0;
  double sinceTickSec = 1e9;  // output pulse decay clock
  // Phase-offset crossing detector over BeatTick's fractional accumulator
  // (BeatTick's own integer counter can't carry an offset).
  long lastCrossInt = 0;
  bool crossInit = false;
};

static void pushEv(State* s, bool on, int channel, float velocity) {
  Ev e;
  e.seq = ++s->seq;
  e.on = on;
  e.channel = channel;
  e.velocity = velocity;
  if (s->ringLen == kRingCap) {
    for (int i = 1; i < kRingCap; i++) s->ring[i - 1] = s->ring[i];
    s->ringLen--;
  }
  s->ring[s->ringLen++] = e;
}

static void publish(State* s, float pulse) {
  auto out = val::number(pulse);
  state::setValPath("output", out);
  val::release(out);
  auto arr = val::array();
  for (int i = 0; i < s->ringLen; i++) {
    auto e = val::object();
    val::set(e, "seq", val::number(static_cast<double>(s->ring[i].seq)));
    val::set(e, "on", val::boolean(s->ring[i].on));
    val::set(e, "channel", val::number(s->ring[i].channel));
    val::set(e, "velocity", val::number(s->ring[i].velocity));
    val::push(arr, e);
  }
  state::setValPath("triggers", arr);
  val::release(arr);
}

void module_init() {
  state::init("mod.trigger.beat", {1, 1, 0},
    state::Schema()
      .helpField("intro",
        "## Beat Trigger\n"
        "Fires a **trigger event** on a beat division of the transport — the "
        "programmatic way to launch **scenes**. Events carry a *Channel* (which "
        "scene slot they address) and a *Velocity*, and ride a return track "
        "(wire the trigger out to one) or the global trigger bus when unwired.\n\n"
        "**Try:** drop one in a clip, set *Every* to 1 bar, and give a scene "
        "track the same channel — scenes relaunch on the bar.")
      .group("clock", "Clock")
        .groupHelp(
          "*Every* sets how often the trigger fires (in bars/beats of the host "
          "transport); *Phase* shifts the tick inside that division.")
      .selectField("division", 4, state::PrimaryInput,
                   {{"4 bars", 0},
                    {"2 bars", 1},
                    {"1 bar", 2},
                    {"1/2", 3},
                    {"1/4 (beat)", 4},
                    {"1/8", 5}}).label("Every", "Every")
      .floatField("phase", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Phase", "Phase")
      .group("event", "Event")
        .groupHelp(
          "What each fired event carries. *Channel* picks which scene (or other "
          "listener) it addresses; *Velocity* rides along for consumers that "
          "read it.")
      .floatField("channel", 1.0f, 1.f, 16.f, state::PrimaryInput,
                  nullptr, 1.f).label("Channel", "Ch")
      .floatField("velocity", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Velocity", "Vel")
      .group("out", "Output")
        .groupHelp(
          "The scalar trace of the trigger. By default each tick pulses to 1 "
          "and decays over ~120 ms — a visible trace that doubles as a soft "
          "modulation pulse. *Single Frame* instead holds 1.0 for exactly one "
          "frame per tick and snaps back to 0 — a clean edge for shapers that "
          "detect triggers (e.g. Flip).")
      .boolField("single_frame", false, state::PrimaryInput)
        .label("Single Frame", "1Frm")
      // The tick pulse (1 → exponential decay, or the one-frame gate): a
      // visible trace + an ordinary unsigned modulation output.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      .capability(state::Capability::TriggerSource)
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
      .capability(state::Capability::SeekableApproximate)
  );
  state::log("trigger.beat: init");
}

void* create() { return new State(); }

void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  *s = State();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  // Advance the beat accumulator, then detect integer crossings of
  // (beats + phase) ourselves — the phase knob shifts the tick inside its
  // division without re-arming (glitch-free live edits).
  const int code = s->division < 0 ? 0 : s->division > 5 ? 5 : s->division;
  s->tick.tick(kDivisionTicks[code]);
  const double eb = s->tick.effectiveBeats() + s->phase;
  const long cur = static_cast<long>(std::floor(eb));
  int crossings = 0;
  if (!s->crossInit) {
    s->crossInit = true;  // first frame: seed, never a spurious tick
  } else if (cur > s->lastCrossInt) {
    crossings = static_cast<int>(cur - s->lastCrossInt);
  }
  s->lastCrossInt = cur;
  if (crossings > 0) {
    const int channel = static_cast<int>(s->channel + 0.5f);
    if (s->openGate) pushEv(s, /*on=*/false, s->openChannel, s->velocity);
    pushEv(s, /*on=*/true, channel, s->velocity);
    s->openGate = true;
    s->openChannel = channel;
    s->sinceTickSec = 0.0;
  } else {
    s->sinceTickSec += dt > 0 ? dt : 0;
  }
  if (s->single_frame) {
    // Hard gate: exactly 1.0 on a tick frame, 0.0 otherwise.
    publish(s, crossings > 0 ? 1.0f : 0.0f);
  } else {
    // 1 → 0 pulse with a ~120 ms tail (visible at any frame rate).
    const float pulse = static_cast<float>(std::exp(-s->sinceTickSec / 0.12));
    publish(s, pulse < 0.001f ? 0.0f : pulse);
  }
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "division"))
      s->division = static_cast<int>(state::patchFloat(i));
    else if (state::pathIs(pb + off[i], len[i], "phase"))
      s->phase = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "channel"))
      s->channel = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "velocity"))
      s->velocity = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "single_frame"))
      s->single_frame = state::patchFloat(i) != 0.0f;
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;  // pure data module
}

}  // namespace trigger_beat
