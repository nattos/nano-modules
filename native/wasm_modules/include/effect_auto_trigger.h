#pragma once
/*
 * effect_auto_trigger.h — the shared auto-fire block for TRIGGERED effects.
 *
 * A triggered effect (env_adsr, shape_burst, chroma_wave, ...) is driven by an
 * explicit trigger surface — a `gate` bool and a `trigger` event. This header
 * adds the OPTIONAL self-fire on top, and owns the whole pipeline: the state,
 * the schema fields, the knob visibility, and the patch decoding.
 *
 * Three modes (schema field `auto_mode`):
 *
 *   Off     — default. Nothing self-fires; the gate/trigger is the only source.
 *   Random  — Poisson self-fire (style guide §4.1): rate_hz = pow(60, rate) - 1,
 *             then a per-frame u < 1 - exp(-rate_hz * dt).
 *   Beats   — locked to the host transport via fx::BeatTick: fires on a musical
 *             division of the bar (4 bars .. 1/16), or a Custom ticks-per-bar
 *             multiplier.
 *
 * Usage — four touch points in the effect:
 *
 *   struct State { ...; fx::AutoTrigger auto_trig; };
 *
 *   // module_init(): the group is sticky, so the fields land inside it.
 *   state::Schema sc;
 *   sc.group("trigger", "Trigger").groupHelp(...);
 *   fx::AutoTrigger::fields(sc);
 *   sc.boolField("gate", ...).eventField("trigger", ...);
 *   state::init("my.effect", {1,0,1}, sc);
 *
 *   // tick(): loop the count — a Beats stall can cross several divisions.
 *   for (int i = 0, n = s->auto_trig.fires(dt); i < n; i++) fireMyVoice(s);
 *
 *   // on_state_patched(): delegate, and re-hide knobs when the mode moves.
 *   bool vis = false;
 *   if (s->auto_trig.patch(p, l, i, &vis)) {
 *     if (vis) fx::AutoTrigger::applyVisibility(s->auto_trig.mode, s->auto_trig.div);
 *     continue;
 *   }
 *
 *   // eval_visibility() / on_state_ready(): see applyVisibility below.
 */

#include <host.h>
#include <effect_beat_tick.h>
#include <cmath>
#include <cstdint>

namespace fx {

/// `auto_mode` values. Off is the default: these effects are naturally
/// triggered, so a fresh drop stays quiet until you wire something in.
enum AutoMode {
  AutoOff = 0,
  AutoRandom = 1,
  AutoBeats = 2,
};

/// `auto_beats` values — a beat division, i.e. a BeatTick ticks-per-bar
/// multiplier. DivCustom instead reads the `auto_beats_custom` knob.
enum AutoDiv {
  Div4Bars = 0,
  Div2Bars = 1,
  Div1Bar = 2,
  DivHalf = 3,
  DivBeat = 4,
  DivEighth = 5,
  DivSixteenth = 6,
  DivCustom = 7,
};

/// Ticks per bar for Div4Bars..DivSixteenth (DivCustom is not in the table).
constexpr float kAutoDivTicks[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f, 8.0f, 16.0f};
constexpr int kAutoDivTableLen = (int)(sizeof(kAutoDivTicks) / sizeof(kAutoDivTicks[0]));

struct AutoTrigger {
  int mode = AutoOff;
  float rate = 0.2f;      // Random: 0..1 → pow(60, rate) - 1 Hz
  int div = DivBeat;      // Beats: an AutoDiv
  float custom = 1.0f;    // Beats + DivCustom: ticks per bar

  uint32_t rng = 0x5EED5EEDu;  // Poisson stream
  BeatTick tick;

  /// Ticks per bar for the active division. 0 disables BeatTick.
  float beatMultiplier() const {
    if (div == DivCustom) return custom > 0.0f ? custom : 0.0f;
    int i = div < 0 ? 0 : (div >= kAutoDivTableLen ? kAutoDivTableLen - 1 : div);
    return kAutoDivTicks[i];
  }

  /// Call once per frame. Returns how many auto-fires happened: 0 in Off,
  /// 0 or 1 in Random, and 0..n in Beats (BeatTick reports every integer
  /// crossing, so a long frame stall can cross several divisions at once).
  int fires(double dt) {
    if (mode == AutoRandom) {
      if (rate <= 0.0f) return 0;
      const float rate_hz = std::pow(60.0f, rate) - 1.0f;
      if (rate_hz <= 0.0f) return 0;
      const float lambda = rate_hz * (float)dt;
      rng = rng * 1664525u + 1013904223u;
      const float u = (rng >> 8) * (1.0f / 16777216.0f);
      return u < 1.0f - std::exp(-lambda) ? 1 : 0;
    }
    if (mode == AutoBeats) return tick.tick(beatMultiplier());
    return 0;
  }

  /// Declare `auto_mode` / `auto_rate` / `auto_beats` / `auto_beats_custom`,
  /// in that order. The caller's sticky group() tags them.
  ///
  /// Returns the Schema so it can WRAP an existing fluent chain in place —
  /// the chain must already have made one call (a prvalue `Schema()` won't
  /// bind to `Schema&`, but `Schema().helpField(...)` is an lvalue):
  ///
  ///   state::init(id, ver,
  ///     fx::AutoTrigger::fields(
  ///       state::Schema().helpField(...).group("trigger", "Trigger")
  ///     ).boolField("gate", ...).eventField("trigger", ...));
  static state::Schema& fields(state::Schema& sc) {
    sc.selectField("auto_mode", AutoOff, state::PrimaryInput,
                   {{"Off", AutoOff},
                    {"Random", AutoRandom},
                    {"Beats", AutoBeats}},
                   /*wrap=*/false,
                   "How the effect self-fires. Off = only the gate/trigger fires it. "
                   "Random = Poisson self-fire at Auto Rate. Beats = locked to the "
                   "host transport on a beat division.")
      .label("Auto Mode", "Auto");
    sc.floatField("auto_rate", 0.2f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.f, nullptr,
                  "Random mode: how often it self-fires (Poisson).")
      .label("Auto Rate", "Rate");
    sc.selectField("auto_beats", DivBeat, state::PrimaryInput,
                   {{"4 bars", Div4Bars},
                    {"2 bars", Div2Bars},
                    {"1 bar", Div1Bar},
                    {"1/2", DivHalf},
                    {"1/4 (beat)", DivBeat},
                    {"1/8", DivEighth},
                    {"1/16", DivSixteenth},
                    {"Custom", DivCustom}}, /*wrap=*/true,
                   "Beats mode: the transport division it fires on.")
      .label("Every", "Every");
    sc.floatField("auto_beats_custom", 1.0f, 0.01f, 64.f, state::PrimaryInput,
                  nullptr, 0.f, "x/bar",
                  "Beats + Custom: fires this many times per bar.")
      .label("Custom Rate", "Mult");
    return sc;
  }

  /// Show only the knobs the active mode uses (the env_lfo setFieldHidden
  /// pattern). Touches the type-shared schema, so it takes the values rather
  /// than a `self` — call it from both `eval_visibility` (static, pure over
  /// the patch list) and `on_state_ready` (after the initial state replay).
  static void applyVisibility(int mode, int div) {
    state::setFieldHidden("auto_rate", mode != AutoRandom);
    state::setFieldHidden("auto_beats", mode != AutoBeats);
    state::setFieldHidden("auto_beats_custom", !(mode == AutoBeats && div == DivCustom));
  }

  /// Decode the auto-trigger keys out of a patch entry. Returns true if this
  /// entry belonged to us (the caller should then `continue`). Sets
  /// `*visibility_changed` when a knob-swapping field moved.
  bool patch(const char* p, int l, int i, bool* visibility_changed = nullptr) {
    if (state::pathIs(p, l, "auto_mode")) {
      const int m = (int)state::patchFloat(i);
      if (m != mode) {
        mode = m;
        // Re-arm the beat clock so switching INTO Beats seeds from the current
        // bar phase instead of firing off a stale accumulator.
        if (mode == AutoBeats) tick.reset();
        if (visibility_changed) *visibility_changed = true;
      }
      return true;
    }
    if (state::pathIs(p, l, "auto_rate")) {
      rate = state::patchFloat(i);
      return true;
    }
    if (state::pathIs(p, l, "auto_beats")) {
      const int d = (int)state::patchFloat(i);
      if (d != div) {
        div = d;
        if (visibility_changed) *visibility_changed = true;
      }
      return true;
    }
    if (state::pathIs(p, l, "auto_beats_custom")) {
      custom = state::patchFloat(i);
      return true;
    }
    return false;
  }

  /// Read the auto-trigger fields straight out of a patch list, for a static
  /// `eval_visibility` (which has no `self`). Mirrors the schema defaults for
  /// any key the patch list doesn't carry.
  static void evalVisibility(int n, const char* pb, const int* off, const int* len,
                             const int* ops) {
    int mode = AutoOff;
    int div = DivBeat;
    for (int i = 0; i < n; i++) {
      if (ops[i] != state::PatchReplace) continue;
      const char* p = pb + off[i];
      const int l = len[i];
      if (state::pathIs(p, l, "auto_mode")) mode = (int)state::patchFloat(i);
      else if (state::pathIs(p, l, "auto_beats")) div = (int)state::patchFloat(i);
    }
    applyVisibility(mode, div);
  }
};

} // namespace fx
