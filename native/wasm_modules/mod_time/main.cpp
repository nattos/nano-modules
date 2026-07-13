/*
 * mod.source.time — Transport time / beat-phase modulation source.
 *
 * Publishes the host's clock as modulation: a looping phase fraction plus the
 * raw beats/seconds value. Two axes of modes:
 *
 *   Domain — Beats: the unit is beats (4 per bar, from the host transport's
 *            bar phase + BPM). Time: the unit is seconds.
 *   Sync   — Locked: tracks the host exactly. In Beats that's the actual
 *            beat/bar phase (period 4 + loop == the bar phase precisely); in
 *            Time it's the host-reported time, which can jump BACKWARD on a
 *            scrub. Free: integrates forward only — Beats advances at the BPM
 *            but with an arbitrary phase offset (it never re-anchors), Time
 *            just accumulates dt. Free never goes backwards.
 *
 * Loop: `output` is always the cycling fraction fract(t / period) — the loop
 * toggle switches only `value`, between the wrapped position within the loop
 * (in beats/seconds, e.g. 0.5 = halfway into the loop's first beat/second)
 * and the absolute unwrapped beats/seconds.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>
#include <cmath>

namespace mod_time {

enum Domain : int {
  DomainTime = 0,
  DomainBeats = 1,
};

enum Sync : int {
  SyncFree = 0,
  SyncLocked = 1,
};

// The repo-wide transport assumption: host_get_bar_phase spans one 4-beat bar.
constexpr double kBeatsPerBar = 4.0;

// Per-instance state. One per chain entry.
struct State {
  int   domain = DomainBeats;
  int   sync = SyncLocked;
  bool  loop = true;
  float period_beats = 4.0f;
  float period_seconds = 5.0f;

  // Free-running accumulators (forward-only by construction).
  double time_free = 0.0;
  double beats_free = 0.0;
  // Beats+Locked bar tracker: barPhase wraps every bar, so count the wraps and
  // reconstruct t = (bars + barPhase) * 4 exactly — drift-free and phase-locked
  // to the host (fx::BeatTick isn't usable here: it seeds its accumulator at 0,
  // giving an offset clock, and we need the bar-aligned one).
  double prev_bar_phase = -1.0;  // sentinel: -1 = unseeded
  long   bars = 0;
};

// Show only the period knob whose unit matches the active domain. Touches the
// type-shared schema, so it takes the domain value (env_lfo pattern) — called
// from on_state_ready, from `domain` patches, and from eval_visibility.
static void apply_domain_visibility(int domain) {
  bool beats = (domain == DomainBeats);
  state::setFieldHidden("period_beats", !beats);
  state::setFieldHidden("period_seconds", beats);
}

// Static (self-less) visibility evaluator — pure over state.
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  int domain = DomainBeats;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "domain")) domain = (int)state::patchFloat(i);
  }
  apply_domain_visibility(domain);
}

static void on_state_ready(void* self);

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.source.time", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Time\n"
        "The transport as a modulation source: a looping **phase** (0..1 over "
        "the loop period) plus the raw **value** in beats or seconds.\n\n"
        "**Beats + Locked** is the host's actual beat/bar phase — period 4 with "
        "*Loop* on rides the bar exactly. **Free** cycles at the same speed but "
        "with its own offset, never running backwards. **Time** counts seconds "
        "instead — *Locked* follows the host clock (scrubs and all), *Free* "
        "just accumulates.\n\n"
        "**Try:** wire *Phase* through an Envelope shaper for a custom "
        "beat-locked LFO of any shape.")
      // --- Clock: what advances, and whether it re-anchors to the host ---
      .group("clock", "Clock")
        .groupHelp(
          "*Domain* picks the unit — musical **Beats** (4 per bar, from the "
          "host transport) or wall-clock **Time** in seconds. *Sync* — "
          "**Locked** tracks the host exactly (beat-accurate; time can jump "
          "backward on a scrub), **Free** integrates forward only, cycling at "
          "the right speed but with an arbitrary offset.")
      .selectField("domain", DomainBeats, state::PrimaryInput,
                   {{"Time", DomainTime}, {"Beats", DomainBeats}}).label("Domain", "Dom")
      .selectField("sync", SyncLocked, state::PrimaryInput,
                   {{"Free", SyncFree}, {"Locked", SyncLocked}}).label("Sync", "Sync")
      // --- Loop: the cycle length + wrapped-vs-absolute value ---
      .group("loop", "Loop")
        .groupHelp(
          "*Period* sets the phase cycle length — in beats (default 4 = one "
          "bar) or seconds, per the active domain. *Loop* switches the *Value* "
          "output between the wrapped position within the loop and the "
          "absolute unwrapped beats/seconds; *Phase* always cycles.")
      .boolField("loop", true, state::PrimaryInput).label("Loop", "Loop")
      .floatField("period_beats", 4.0f, 0.25f, 64.f, state::PrimaryInput,
                  nullptr, 0.f, "beats").label("Period", "Per")
      // Time-domain period, in seconds. Hidden in Beats (and vice versa).
      .floatField("period_seconds", 5.0f, 0.05f, 300.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Period", "Per")
      // --- Outputs ---
      .group("output", "Output")
      // The canonical channel: position within the period as a 0..1 sawtooth.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
        .label("Phase", "Ph")
      // Raw beats/seconds: wrapped into the loop when Loop is on, absolute
      // otherwise. The declared [0,16] is the static modulation-range contract
      // (a 16-beat/16-second span at full depth); longer values clip in the
      // wire fold.
      .floatField("value", 0.0f, 0.f, 16.f, state::SecondaryOutput, "unsigned")
        .label("Value", "Val")
      // A single-channel modulation source (Phase is the canonical output;
      // Value rides along as a secondary channel). Locked modes re-read the
      // host every frame and Free modes deliberately never rewind, so a seek
      // simply resumes — approximate by design.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
      .capability(state::Capability::SeekableApproximate)
  );
  state::setOnStateReady(&on_state_ready);
}

// Fired after init + initial state replay: hide the inactive domain's period.
static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_domain_visibility(s->domain);
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
  const double fwd_dt = dt > 0.0 ? dt : 0.0;

  // Advance every clock every frame (all trivially cheap), so switching modes
  // live lands on a sensible running value instead of a stale one.
  s->time_free += fwd_dt;
  s->beats_free += fwd_dt * host::bpm() / 60.0;
  {
    const double bp = host::barPhase();
    if (s->prev_bar_phase < 0.0) {
      s->prev_bar_phase = bp;              // first frame: seed, bars stays 0
    } else {
      if (bp < s->prev_bar_phase - 0.5) s->bars++;   // bar wrap
      s->prev_bar_phase = bp;
    }
  }

  // Pick the active clock. Beats+Locked reconstructs bar-aligned beats, so
  // small backward barPhase moves DO run it backwards — locked follows the
  // host; only Free is forward-only.
  double t;
  if (s->domain == DomainBeats) {
    t = (s->sync == SyncLocked)
        ? (static_cast<double>(s->bars) + s->prev_bar_phase) * kBeatsPerBar
        : s->beats_free;
  } else {
    t = (s->sync == SyncLocked) ? host::time() : s->time_free;
  }

  const double period = std::fmax(
      static_cast<double>(s->domain == DomainBeats ? s->period_beats : s->period_seconds),
      1e-4);
  // floor-based fract so a negative t (backward-scrubbed host time) still
  // wraps into [0,1).
  const double cycles = t / period;
  const double phase = cycles - std::floor(cycles);
  const double value = s->loop ? phase * period : t;

  auto ph = val::number(phase);
  state::setValPath("output", ph);
  val::release(ph);
  auto vh = val::number(value);
  state::setValPath("value", vh);
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
    if (state::pathIs(p, l, "domain")) {
      int d = state::patchInt(i);
      if (d != s->domain) {
        s->domain = d;
        apply_domain_visibility(d);
      }
    }
    else if (state::pathIs(p, l, "sync"))           s->sync = state::patchInt(i);
    else if (state::pathIs(p, l, "loop"))           s->loop = state::patchBool(i);
    else if (state::pathIs(p, l, "period_beats"))   s->period_beats = state::patchFloat(i);
    else if (state::pathIs(p, l, "period_seconds")) s->period_seconds = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_time
