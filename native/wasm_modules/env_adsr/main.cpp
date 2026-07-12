/*
 * env.adsr — ADSR envelope generator (modulation source).
 *
 * Emits a single normalized [0,1] modulation scalar driven by an attack / decay
 * / sustain / release phase machine. Pure data module — no GPU, no texture I/O.
 *
 * Trigger surface (style guide §8.1):
 *   gate      (bool)  — rising edge fires; held keeps SUSTAIN; falling releases
 *   trigger   (event) — momentary one-shot (rising-edge detected, §8.2)
 *   auto_mode (select)— the shared self-fire block (effect_auto_trigger.h):
 *                       Off (default — an envelope is explicitly triggered) /
 *                       Random (Poisson) / Beats (locked to the host transport).
 *
 * Shape:
 *   mode    (select) — which phases are active (see Mode). Default "Decay": an
 *                      instant attack falling value — most of the time what you
 *                      want from a triggered envelope (mirrors nano-repatch
 *                      gen.adsr's default 'D').
 *   attack / decay / release — phase TIMES (0..1 → seconds, quadratic).
 *   sustain                  — sustain LEVEL (held while gated, ADS/ADSR).
 *   attack_curve / decay_curve / release_curve — per-phase slope (ease ∈ [-1,1],
 *                      shared with envelope.h so the inspector draws it exactly).
 *
 * Polyphony:
 *   voices    (1..16, default 1) — max simultaneous envelopes (output = the max).
 *   retrigger (select)          — Reset (mono restart) / Legato (mono re-gate
 *                      without re-attack) / Poly (allocate a fresh voice).
 *
 * Momentary triggers (trigger/auto-fire, and gate's rising edge) hold the voice
 * for attack+decay then release — so they play an A-D-R "pluck". A HELD gate
 * bool instead sustains at the sustain level until it falls.
 *
 * Output:
 *   state.output — envelope value in [0, 1] (max across active voices).
 */

#include <host.h>
#include <val.h>
#include <effect_auto_trigger.h>  // fx::AutoTrigger — the shared Off/Random/Beats self-fire
#include "sketch/envelope.h"   // envelope::applyEase — shared with mod.shaper.envelope
#include <cmath>
#include <cstdint>

namespace env_adsr {

enum Mode {
  ModeD = 0,     // instant attack, decay→0, release mirrors decay (default)
  ModeAD = 1,    // attack, decay→0 (no sustain)
  ModeADS = 2,   // attack, decay→sustain, hold; release mirrors decay
  ModeADSR = 3,  // full, independent release
};

enum Retrigger {
  RetrigReset = 0,
  RetrigLegato = 1,
  RetrigPoly = 2,
};

enum Phase {
  PH_IDLE = 0,
  PH_ATTACK = 1,
  PH_DECAY = 2,
  PH_SUSTAIN = 3,
  PH_RELEASE = 4,
};

constexpr int kMaxVoices = 16;

struct Voice {
  int phase = PH_IDLE;
  double time = 0.0;            // time in the current phase
  bool held = false;            // gate-equivalent for this voice
  double hold_remaining = -1.0; // >0 momentary countdown; <0 held by a gate
  float value = 0.0f;           // current output level
  float rel_from = 0.0f;        // value when RELEASE began (for early release)
  float start_from = 0.0f;      // value when ATTACK began (legato)
  uint64_t age = 0;             // trigger order, for poly voice-stealing
  bool active = false;          // anything but IDLE
};

struct State {
  // Shape params.
  float attack = 0.05f, decay = 0.30f, sustain = 0.50f, release = 0.30f;
  float attack_curve = 0.0f, decay_curve = 0.0f, release_curve = 0.0f;
  int mode = ModeD;
  // Polyphony.
  int voices = 1;
  int retrigger = RetrigReset;
  // Triggers.
  fx::AutoTrigger auto_trig;    // Off / Random (Poisson) / Beats — see effect_auto_trigger.h
  bool gate_prev = false;
  bool trigger_prev = false;
  int gate_voice = -1;          // voice the held gate currently drives, or -1

  uint64_t trig_counter = 0;    // monotonic, stamps Voice::age
  Voice v[kMaxVoices];
};

// Param 0..1 → seconds. Quadratic: fine control at the short end, ~4s ceiling.
static inline double seconds(float p) {
  if (p < 0.0f) p = 0.0f;
  if (p > 1.0f) p = 1.0f;
  return 0.003 + (double)p * (double)p * 4.0;
}

// Derived per-phase shape from the mode (kept in one place).
struct Shape {
  double attack_s, decay_s, release_s;
  float sustain_lv;
};
static Shape shapeFor(const State* s) {
  const bool hasAttack = s->mode != ModeD;
  const bool hasSustain = (s->mode == ModeADS || s->mode == ModeADSR);
  const bool hasRelease = (s->mode == ModeADSR);
  Shape sh;
  sh.attack_s = hasAttack ? seconds(s->attack) : 0.0;
  sh.decay_s = seconds(s->decay);
  sh.sustain_lv = hasSustain ? s->sustain : 0.0f;
  sh.release_s = hasRelease ? seconds(s->release) : sh.decay_s;
  return sh;
}

static void enterPhase(Voice& v, int phase) {
  v.phase = phase;
  v.time = 0.0;
  if (phase == PH_RELEASE) v.rel_from = v.value;
  if (phase == PH_IDLE) { v.active = false; v.value = 0.0f; }
}

static void startAttack(State* s, int vi, float from) {
  Voice& v = s->v[vi];
  v.active = true;
  v.phase = PH_ATTACK;
  v.time = 0.0;
  v.start_from = from;
  v.value = from;
  v.age = ++s->trig_counter;
}

// Pick a voice for a poly trigger: a free one if any, else steal the oldest.
static int pickVoice(State* s) {
  int n = s->voices;
  if (n < 1) n = 1;
  if (n > kMaxVoices) n = kMaxVoices;
  for (int i = 0; i < n; i++)
    if (!s->v[i].active) return i;
  int best = 0;
  uint64_t bestAge = s->v[0].age;
  for (int i = 1; i < n; i++)
    if (s->v[i].age < bestAge) { bestAge = s->v[i].age; best = i; }
  return best;
}

// Apply the retrigger policy and arm the chosen voice. `momentary` triggers
// (event/auto_rate/gate-rising) auto-release after attack+decay; a held gate
// passes momentary=false so the gate controls the release. Returns the voice.
static int triggerVoice(State* s, bool momentary, const Shape& sh) {
  int vi;
  if (s->retrigger == RetrigPoly) {
    vi = pickVoice(s);
    startAttack(s, vi, 0.0f);
  } else if (s->retrigger == RetrigLegato) {
    vi = 0;
    Voice& v = s->v[0];
    if (!v.active || v.phase == PH_RELEASE) {
      startAttack(s, 0, v.active ? v.value : 0.0f);  // re-attack from current
    } else {
      v.age = ++s->trig_counter;                     // already on → just re-hold
    }
  } else {  // RetrigReset
    vi = 0;
    startAttack(s, 0, 0.0f);
  }
  Voice& v = s->v[vi];
  v.held = true;
  v.hold_remaining = momentary ? (sh.attack_s + sh.decay_s) : -1.0;
  return vi;
}

// Static (self-less) visibility evaluator — pure over state. The auto-trigger
// block owns every mode-dependent knob here, so it's the whole evaluator.
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  fx::AutoTrigger::evalVisibility(n, pb, off, len, ops);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) fx::AutoTrigger::applyVisibility(s->auto_trig.mode, s->auto_trig.div);
}

void module_init() {
  // Built statement-wise (not one fluent chain) so the shared auto-trigger
  // block can splice its fields into the Trigger group. Field order is the
  // call order either way.
  state::Schema sc;
  sc.helpField("intro",
      "## ADSR Envelope\n"
      "A triggered [0,1] modulation source: each trigger fires an attack / decay "
      "/ sustain / release contour you wire into any param for plucks, swells, "
      "and gated shapes.\n\n"
      "**Try:** the default *Decay* mode is an instant-attack fall — great for "
      "percussive hits. Feed a *Gate* to hold at the sustain level, or set *Auto "
      "Mode* to **Beats** to fire it on the transport. Switch to **ADSR** mode "
      "for full independent control.")
    // --- Shape: which phases run, their times, and per-phase slope ---
    .group("shape", "Shape")
      .groupHelp(
        "Sets the envelope contour. *Mode* chooses which phases are active — "
        "*Decay* is an instant fall, *ADSR* is the full four-stage shape. "
        "*Attack* / *Decay* / *Release* are phase TIMES and *Sustain* is the "
        "held LEVEL; the three *Curve* knobs bend each phase's slope (positive = "
        "snappier). **Try** a long attack for a slow swell.")
    .selectField("mode", ModeD, state::PrimaryInput,
                 {{"Decay", ModeD},
                  {"Attack-Decay", ModeAD},
                  {"Attack-Decay-Sustain", ModeADS},
                  {"ADSR", ModeADSR}}, /*wrap=*/true).label("Mode", "Mode")
    .floatField("attack", 0.05f, 0.f, 1.f, state::PrimaryInput).label("Attack", "Atk")
    .floatField("decay", 0.30f, 0.f, 1.f, state::PrimaryInput).label("Decay", "Dec")
    .floatField("sustain", 0.50f, 0.f, 1.f, state::PrimaryInput).label("Sustain", "Sus")
    .floatField("release", 0.30f, 0.f, 1.f, state::PrimaryInput).label("Release", "Rel")
    // Per-phase slope: ease ∈ [-1,1] (envelope.h convention; >0 snappier).
    .floatField("attack_curve", 0.0f, -1.f, 1.f, state::PrimaryInput).label("Attack Curve", "AtkCrv")
    .floatField("decay_curve", 0.0f, -1.f, 1.f, state::PrimaryInput).label("Decay Curve", "DecCrv")
    .floatField("release_curve", 0.0f, -1.f, 1.f, state::PrimaryInput).label("Release Curve", "RelCrv")
    // --- Polyphony: how many envelopes run at once + retrigger policy ---
    .group("polyphony", "Polyphony")
      .groupHelp(
        "Controls overlapping triggers. *Voices* sets how many envelopes can run "
        "simultaneously (the output is their max). *Retrigger* decides what a new "
        "trigger does: **Reset** restarts a single voice, **Legato** re-gates "
        "without re-attacking, **Poly** allocates a fresh voice each time.")
    .intField("voices", 1, 1, kMaxVoices, state::PrimaryInput).label("Voices", "Voices")
    .selectField("retrigger", RetrigReset, state::PrimaryInput,
                 {{"Reset", RetrigReset},
                  {"Legato", RetrigLegato},
                  {"Poly", RetrigPoly}}).label("Retrigger", "Retrig")
    // --- Trigger: what fires the envelope ---
    .group("trigger", "Trigger")
      .groupHelp(
        "Fires the envelope. An envelope is normally triggered explicitly, so "
        "*Auto Mode* is **Off** by default: wire a *Gate* (its rising edge fires "
        "and, while held, keeps the sustain level until it falls), or a *Trigger* "
        "for a momentary attack-decay-release pluck. To self-fire, set *Auto Mode* "
        "to **Random** (Poisson, at *Auto Rate*) or **Beats** (locked to the host "
        "transport on a beat division).");
  fx::AutoTrigger::fields(sc);   // auto_mode + auto_rate + auto_beats + custom
  sc.boolField("gate", false, state::PrimaryInput).label("Gate", "Gate")
    .eventField("trigger", state::PrimaryInput).label("Trigger", "Trig")
    // Unipolar [0,1] envelope — declared unsigned (the modulation-range
    // contract; the UI band samples this declared range).
    .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
    .capability(state::Capability::ModulationSource)
    .capability(state::Capability::ModulationSourceSingle);
  state::init("mod.source.adsr", {1, 0, 1}, sc);
  state::setOnStateReady(&on_state_ready);
  state::log("ADSR: init");
}

void* create() { return new State(); }

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  *s = State();  // reset everything (params + all voices) to defaults
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  const Shape sh = shapeFor(s);

  // Self-fire (Off / Random / Beats — effect_auto_trigger.h). Loop the count:
  // in Beats a long frame stall can cross several divisions at once.
  for (int i = 0, n = s->auto_trig.fires(dt); i < n; i++)
    triggerVoice(s, /*momentary=*/true, sh);

  float out = 0.0f;
  for (int i = 0; i < kMaxVoices; i++) {
    Voice& v = s->v[i];
    if (!v.active) continue;
    v.time += dt;

    switch (v.phase) {
      case PH_ATTACK: {
        if (!v.held) { enterPhase(v, PH_RELEASE); break; }
        if (sh.attack_s <= 0.0) { v.value = 1.0f; enterPhase(v, PH_DECAY); break; }
        float t = (float)(v.time / sh.attack_s);
        if (t >= 1.0f) { v.value = 1.0f; enterPhase(v, PH_DECAY); break; }
        v.value = v.start_from +
                  (1.0f - v.start_from) * envelope::applyEase(t, s->attack_curve);
      } break;
      case PH_DECAY: {
        if (!v.held) { enterPhase(v, PH_RELEASE); break; }
        if (sh.decay_s <= 0.0) { v.value = sh.sustain_lv; enterPhase(v, PH_SUSTAIN); break; }
        float t = (float)(v.time / sh.decay_s);
        if (t >= 1.0f) { v.value = sh.sustain_lv; enterPhase(v, PH_SUSTAIN); break; }
        v.value = 1.0f + (sh.sustain_lv - 1.0f) * envelope::applyEase(t, s->decay_curve);
      } break;
      case PH_SUSTAIN: {
        v.value = sh.sustain_lv;
        if (!v.held) enterPhase(v, PH_RELEASE);
      } break;
      case PH_RELEASE: {
        if (sh.release_s <= 0.0) { enterPhase(v, PH_IDLE); break; }
        float t = (float)(v.time / sh.release_s);
        if (t >= 1.0f) { enterPhase(v, PH_IDLE); break; }
        v.value = v.rel_from * (1.0f - envelope::applyEase(t, s->release_curve));
      } break;
      default: break;
    }

    // Momentary hold countdown → drops `held`, which the phases above release on.
    if (v.hold_remaining > 0.0) {
      v.hold_remaining -= dt;
      if (v.hold_remaining <= 0.0) { v.held = false; v.hold_remaining = -1.0; }
    }

    if (v.active && v.value > out) out = v.value;
  }

  if (out < 0.0f) out = 0.0f;
  if (out > 1.0f) out = 1.0f;
  auto vh = val::number(out);
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
    const char* p = pb + off[i];
    const int l = len[i];
    if (s->auto_trig.patch(p, l, i, &vis_changed)) continue;
    if      (state::pathIs(p, l, "attack"))        s->attack = state::patchFloat(i);
    else if (state::pathIs(p, l, "decay"))         s->decay = state::patchFloat(i);
    else if (state::pathIs(p, l, "sustain"))       s->sustain = state::patchFloat(i);
    else if (state::pathIs(p, l, "release"))       s->release = state::patchFloat(i);
    else if (state::pathIs(p, l, "attack_curve"))  s->attack_curve = state::patchFloat(i);
    else if (state::pathIs(p, l, "decay_curve"))   s->decay_curve = state::patchFloat(i);
    else if (state::pathIs(p, l, "release_curve")) s->release_curve = state::patchFloat(i);
    else if (state::pathIs(p, l, "mode"))          s->mode = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "voices"))        s->voices = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "retrigger"))     s->retrigger = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "gate")) {
      bool g = state::patchFloat(i) != 0.0f;
      if (g && !s->gate_prev) {                    // rising edge → fire (held)
        s->gate_voice = triggerVoice(s, false, shapeFor(s));
      } else if (!g && s->gate_prev) {             // falling edge → release
        if (s->gate_voice >= 0 && s->gate_voice < kMaxVoices)
          s->v[s->gate_voice].held = false;
        s->gate_voice = -1;
      }
      s->gate_prev = g;
    } else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchFloat(i) != 0.0f;
      if (t && !s->trigger_prev) triggerVoice(s, true, shapeFor(s));  // momentary
      s->trigger_prev = t;
    }
  }
  if (vis_changed)
    fx::AutoTrigger::applyVisibility(s->auto_trig.mode, s->auto_trig.div);
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
}

} // namespace env_adsr
