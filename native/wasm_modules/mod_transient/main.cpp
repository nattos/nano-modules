/*
 * mod.shaper.transient_shaper — Adaptive beat-grid transient sharpener.
 *
 * Sharpens the attack of a laggy, pre-smoothed band level (Resolume's FFT
 * bass) by LEARNING where onsets repeat on the beat grid and enhancing those.
 * Detection-first: a boost only fires on a real detected rise — the learned
 * per-slot confidence scales the boost (ease-in over bars of hits, ease-out
 * on misses) and lowers the detection threshold inside confident windows so
 * expected kicks trigger on the first hint of a rise. A second `pluck`
 * output renders the same transient as a short percussive AD envelope, and
 * `confidence` exposes the current slot's learned confidence live.
 *
 * The entire algorithm lives in sketch/transient_shaper.h (pure, host-free —
 * pinned by native/tests/test_transient_shaper.cpp with a synthetic kick
 * generator; see the header for the full story). This wrapper is only
 * schema + param patching + host reads + output publishing.
 *
 * Class-like instance model: module_init() publishes the schema once per
 * type; each chain entry gets its own State via create(). Params arrive as
 * state patches; ALL time-domain math runs in tick() (patches for a frame
 * land first), and all three outputs republish every tick.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>
#include <cmath>

#include "sketch/transient_shaper.h"

namespace mod_transient {

// Per-instance state. One per chain entry.
struct State {
  float input = 0.0f;
  transient_shaper::Params params;
  transient_shaper::Shaper core;
};

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.transient_shaper", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Transient Shaper\n"
        "Sharpens the attack of a smoothed audio band — wire in a laggy FFT "
        "bass level and get the kick's **impact** back. It watches the beat "
        "grid and learns, over a few bars, which grid slots carry a real "
        "onset; once a slot has earned confidence, its onsets trigger "
        "earlier and snap up toward the learned peak with a fast synthetic "
        "attack. A boost only ever fires on a rise that actually happened — "
        "prediction sharpens reality, it never invents a hit — and slots "
        "that stop hitting fade back out within a few bars.\n\n"
        "*Pluck* is a second output: the same detected transient as a short "
        "percussive envelope (fast attack, *Release* decay) without the bass "
        "tail — a \"pluck\" where the main output is the \"woof\". "
        "*Confidence* exposes how learned the most recent onset's slot is — "
        "it climbs as the pattern locks in and decays through a breakdown.\n\n"
        "**Try:** turn Resolume's FFT smoothing (\"Fall\") down as far as "
        "tolerable, wire the bass band in, and wire *Output* into a size or "
        "brightness — kicks land harder; wire *Pluck* into something snappy.")
      // --- Input: the watched band level ---
      .group("input", "Input")
        .groupHelp(
          "*Input* is the smoothed band level to sharpen (auto-wired from a "
          "preceding modulation source). *Sensitivity* sets how small a rise "
          "counts as an onset — raise it if kicks are missed, lower it if "
          "wobble between kicks fires false hits.")
      .floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input", "In")
      .floatField("sensitivity", 0.5f, 0.f, 1.f, state::PrimaryInput).label("Sensitivity", "Sens")
      // --- Grid: the learned pattern ---
      .group("grid", "Grid")
        .groupHelp(
          "The bar is split into *Grid* slots (assumes 4/4; needs the host "
          "clock). Each slot learns its own onset confidence, timing and "
          "peak. *Adapt* is how many bars a change takes to learn — new "
          "patterns ease in over ~Adapt bars, and a dropped pattern (a "
          "breakdown) eases back out a little faster.")
      .selectField("grid", 16, state::PrimaryInput,
                   {{"8th", 8}, {"16th", 16}}).label("Grid", "Grid")
      .floatField("adapt", 4.0f, 1.f, 16.f, state::PrimaryInput,
                  nullptr, 1.f, "bars").label("Adapt", "Adpt")
      // --- Enhance: the sharpened output ---
      .group("enhance", "Enhance")
        .groupHelp(
          "*Amount* is the dry/wet of the sharpened attack: 0 passes the "
          "input through untouched, 1 is the full synthetic snap toward the "
          "learned peak. The boost strength itself always scales with the "
          "slot's learned confidence — unexpected rises pass through "
          "unboosted no matter the Amount.")
      .floatField("amount", 0.75f, 0.f, 1.f, state::PrimaryInput).label("Amount", "Amt")
      // --- Pluck: the percussive secondary ---
      .group("pluck", "Pluck")
        .groupHelp(
          "*Release* is the pluck output's decay — the detected transient "
          "as a fast-attack percussive envelope that falls away in about "
          "this long, instead of following the bass tail.")
      .floatField("pluck_release", 0.18f, 0.05f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, "s").label("Release", "Rel")
      // --- Outputs ---
      .group("output", "Output")
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned").label("Output", "Out")
      .floatField("pluck", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned").label("Pluck", "Plk")
      .floatField("confidence", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned").label("Confidence", "Conf")
      // A unary modulation shaper: 1 band level in -> its sharpened self out.
      // Stateful (followers, learned grid), so seeks are approximate — the
      // runtime layer reseeds on a jump and the learned grid persists.
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::ModulationShaperUnary)
      .capability(state::Capability::SeekableApproximate)
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
  s->input = 0.0f;
  s->params = transient_shaper::Params{};
  s->core.reset();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  const auto r = s->core.tick(s->input, host::barPhase(), host::bpm(), dt, s->params);
  auto oh = val::number(r.output);
  state::setValPath("output", oh);
  val::release(oh);
  auto ph = val::number(r.pluck);
  state::setValPath("pluck", ph);
  val::release(ph);
  auto ch = val::number(r.confidence);
  state::setValPath("confidence", ch);
  val::release(ch);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "input"))         s->input = state::patchFloat(i);
    else if (state::pathIs(p, l, "sensitivity"))   s->params.sensitivity = state::patchFloat(i);
    else if (state::pathIs(p, l, "grid"))          s->params.slots = state::patchInt(i);
    else if (state::pathIs(p, l, "adapt"))         s->params.adapt_bars = state::patchFloat(i);
    else if (state::pathIs(p, l, "amount"))        s->params.amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "pluck_release")) s->params.pluck_release = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_transient
