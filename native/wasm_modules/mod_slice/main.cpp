/*
 * mod.shaper.slice — cut one modulation signal into N windowed outputs.
 *
 * ONE input, up to 8 outputs. Each output owns a WINDOW on the input axis
 * (`start_i`..`end_i`) and a hand-drawn ENVELOPE (`curve_i`) that reshapes the
 * slice. Sweep the input from 0 to 1 and the outputs fire in sequence, each
 * with its own shape — a chase, a crossfade bank, one knob driving a whole
 * scene.
 *
 * Why a card and not wire config: a WIRE already remaps (tap_mod.h does
 * envelope -> remap -> scale -> delay -> fold -> combine), and one output can
 * feed N destinations with per-destination shaping. But a wire is strictly
 * 1 -> 1 and its window is authored per wire, so "0..0.25 goes here, 0.25..0.5
 * goes there" is not expressible, and there is nowhere to see the bands
 * together. `mod.shaper.remap` is already byte-identical to the wire remap —
 * a plain 1-in/1-out crop node would add nothing. This adds the split.
 *
 * ARITY follows mod_math / mod_switch exactly: a fixed bank of 8 lanes plus an
 * `input_count` VALUE, because module_init() takes no `self` — a schema is
 * published once per module TYPE, so arity can only ever be a value, never a
 * shape. Lanes above the count are hidden by the editor's synchronous rule
 * (web/src/state/math-nodes.ts) and skipped here.
 *
 * INPUT is the magnitude-marked PrimaryInput float, so the executor's shaper
 * auto-connect wires it from a preceding modulation source: drop this under an
 * LFO and the LFO drives the sweep. A signed source folds into [0,1] on the way
 * in (resolvePolarity), so there is no signed mode to declare.
 *
 * start/end are RAW (host.h's Schema::raw): they are literal positions compared
 * against another signal — exactly the case raw exists for. Raw suppresses only
 * the magnitude fold; a wire's own envelope/remap/scale/delay/combine still
 * apply, so a window edge stays modulatable.
 *
 * BEYOND the window, per card:
 *   Gate — 0 outside [start,end). Disjoint windows give a clean chase where one
 *          lane is live at a time.
 *   Hold — 0 before, ramp across, then STAY at the envelope's last value. This
 *          is the old curve.crop behaviour: a sweep turns lanes on one after
 *          another and leaves them on. It falls out of envelope::eval's flat
 *          clamp for free.
 *
 * Pure data module — no GPU, no texture I/O, everything in tick().
 */

#include <host.h>
#include <val.h>
#include <sketch/envelope.h>

#include <cstdio>
#include <cstring>

namespace mod_slice {

/// Schema's fixed lane ceiling. `input_count` picks how many participate.
/// Mirrors SLICE_MAX_OUTPUTS in web/src/state/math-nodes.ts.
constexpr int kMaxOutputs = 8;
/// Lanes a fresh card starts with. The schema's start/end defaults spread THIS
/// many lanes across 0..1; lanes above it rest degenerate at [1,1] until the
/// editor re-spreads them (which it does whenever the count changes).
constexpr int kDefaultOutputs = 2;
/// Per-lane curve buffer. An envelope tops out at envelope::kMaxPoints (64)
/// triples of the form "0.123,0.456,0.789," — 1KB is comfortable headroom.
constexpr int kCurveBuf = 1024;

// `beyond` selector values.
enum Beyond { kGate = 0, kHold = 1 };

// The identity line (0,0)->(1,1): a lane passes its slice through unshaped.
static const char kDefaultCurve[] = "[0,0,0,1,1,0]";

static inline float clamp01(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }

struct Lane {
  float start = 0.0f;
  float end   = 1.0f;
  char  curveJson[kCurveBuf] = {};
  envelope::Point points[envelope::kMaxPoints];
  int   nPoints = 0;

  void reparse() { nPoints = envelope::parse(curveJson, points, envelope::kMaxPoints); }
};

struct State {
  float input  = 0.0f;
  int   beyond = kGate;
  int   count  = kDefaultOutputs;
  Lane  lanes[kMaxOutputs];
};

/// Where lane `i` (0-based) rests by default when `n` lanes share 0..1.
/// The schema bakes this at n = kDefaultOutputs; the editor rewrites the fields
/// with the same rule whenever the count changes (sliceSpreadValues in
/// web/src/state/math-nodes.ts — keep the two in step).
static inline float spreadEdge(int i, int n) {
  const float e = static_cast<float>(i) / static_cast<float>(n);
  return e > 1.f ? 1.f : e;
}

/// One lane's output for input `x`. The whole effect's math, in one place so
/// the native test and the editor's preview have a single rule to mirror.
static float laneValue(const Lane& ln, float x, int beyond) {
  float s = clamp01(ln.start);
  float e = clamp01(ln.end);
  if (e < s) e = s;                       // curve.crop's ordering rule

  const float span = e - s;
  // A degenerate window is a STEP at `start`, not a divide by zero.
  const float t = span > 1e-6f ? (x - s) / span : (x >= s ? 1.f : 0.f);
  const float v = envelope::eval(ln.points, ln.nPoints, clamp01(t));

  // Half-open [s,e) so adjacent lanes never both claim a boundary — except at
  // the very top, where a sweep reaching exactly 1.0 must still land somewhere.
  const bool inside = (x >= s) && (x < e || e >= 1.0f);
  // Hold needs no branch: eval() already clamps flat outside the curve's x
  // range, so below the window it reads the first point and above it the last.
  return (beyond == kGate && !inside) ? 0.f : v;
}

void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Slice\n"
    "Cuts **one signal into several**. Each output owns a slice of the input's "
    "range and a curve of its own, so a single sweep can drive a whole bank of "
    "parameters in sequence.\n\n"
    "Drop it under a modulation source and *Input* wires up automatically. Add "
    "or remove outputs from the **gear** icon — the slices re-spread evenly "
    "each time, and you drag them from there.\n\n"
    "**Try:** four outputs onto four different effects' opacity, an LFO on the "
    "input — a chase. Then switch *Beyond Window* to **Hold** and the same "
    "sweep turns them on one after another and leaves them on, like a build.");

  schema.group("input", "Input")
        .groupHelp(
          "The signal being cut up. Its 0..1 range is the axis every slice sits "
          "on, so a source with a different range folds into 0..1 on the way in.\n\n"
          "*Beyond Window* decides what an output does once the input leaves its "
          "slice: **Gate** drops it back to 0 (one lane live at a time — a "
          "chase), **Hold** keeps it at the value it ended on (lanes accumulate "
          "as the sweep passes — a build).");
  // PRIMARY + magnitude-marked: what the executor's shaper auto-connect binds
  // from the preceding modulation source.
  schema.floatField("input", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned")
        .label("Input", "In");
  schema.selectField("beyond", kGate, state::SecondaryInput,
                     {{"Gate", kGate}, {"Hold", kHold}})
        .label("Beyond Window", "Beyond");

  schema.group("slices", "Slices")
        .groupHelp(
          "Each slice takes the part of the input between its *Start* and *End* "
          "and stretches it back out to a full 0..1 on its own output — so a "
          "narrow window makes a fast, steep move and a wide one makes a slow "
          "gentle one.\n\n"
          "The curve reshapes that stretched slice: draw a rising arc for a "
          "swell, a stepped shape to quantize, or flip it end-to-end to run the "
          "slice backwards. Windows may overlap — two lanes sharing a region "
          "crossfade rather than hand off.\n\n"
          "*Start* and *End* are wireable, so another signal can slide a "
          "window around while the input sweeps through it.");
  for (int i = 0; i < kMaxOutputs; ++i) {
    char name[16], disp[16], shortl[8];

    std::snprintf(name, sizeof(name), "start_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "Start %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "S%d", i + 1);
    schema.floatField(name, spreadEdge(i, kDefaultOutputs), 0.f, 1.f,
                      state::SecondaryInput)
          .raw().label(disp, shortl);

    std::snprintf(name, sizeof(name), "end_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "End %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "E%d", i + 1);
    schema.floatField(name, spreadEdge(i + 1, kDefaultOutputs), 0.f, 1.f,
                      state::SecondaryInput)
          .raw().label(disp, shortl);

    // The drawn curve: a flat JSON number array of (x,y,ease) triples, same
    // format mod.shaper.envelope uses. Edited by the slice inspector's graph
    // per lane, never as a raw text box.
    std::snprintf(name, sizeof(name), "curve_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "Curve %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "C%d", i + 1);
    schema.textField(name, kDefaultCurve, state::SecondaryInput)
          .label(disp, shortl);
  }

  // How many lanes take part. Named `input_count` — not `output_count` — so it
  // shares the editor's arity machinery with the math nodes and the switch; the
  // UI labels the control "Outputs". Rendered under the card's gear icon, since
  // it changes the card's SHAPE rather than a value.
  schema.intField("input_count", kDefaultOutputs, 2, kMaxOutputs, state::SecondaryInput)
        .label("Outputs", "N");

  schema.group("output", "Output");
  for (int i = 0; i < kMaxOutputs; ++i) {
    char name[16], disp[16], shortl[8];
    std::snprintf(name, sizeof(name), "out_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "Out %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "%d", i + 1);
    // Unsigned [0,1] modulation-range contract, matching the sibling shapers.
    // out_1 is the PRIMARY one (what a downstream shaper's auto-connect picks
    // up); the rest are wired by hand, which is the entire point of the card.
    schema.floatField(name, 0.0f, 0.f, 1.f,
                      i == 0 ? state::PrimaryOutput : state::SecondaryOutput,
                      "unsigned")
          .label(disp, shortl);
  }

  schema.capability(state::Capability::ModulationShaper)
        .capability(state::Capability::ModulationShaperFanout)
        .capability(state::Capability::TimeIndependent);

  state::init("mod.shaper.slice", {1, 0, 0}, schema);
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
  s->input = 0.0f;
  s->beyond = kGate;
  s->count = kDefaultOutputs;
  for (int i = 0; i < kMaxOutputs; ++i) {
    Lane& ln = s->lanes[i];
    ln.start = spreadEdge(i, kDefaultOutputs);
    ln.end   = spreadEdge(i + 1, kDefaultOutputs);
    std::strncpy(ln.curveJson, kDefaultCurve, sizeof(ln.curveJson) - 1);
    ln.curveJson[sizeof(ln.curveJson) - 1] = '\0';
    ln.reparse();
  }
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  // input / start / end / curve for this frame arrived as state patches before
  // doTick.
  const int n = (s->count < 2) ? 2 : (s->count > kMaxOutputs ? kMaxOutputs : s->count);
  const float x = s->input;

  for (int i = 0; i < kMaxOutputs; ++i) {
    char name[16];
    std::snprintf(name, sizeof(name), "out_%d", i + 1);
    // Lanes above the count publish 0, not nothing: a published value PERSISTS,
    // so a lane that simply stopped writing would hold whatever it last read
    // and keep driving anything still wired to it after the count came down.
    auto vh = val::number(i < n ? laneValue(s->lanes[i], x, s->beyond) : 0.0f);
    state::setValPath(name, vh);
    val::release(vh);
  }
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];

    if (state::pathIs(p, l, "input")) { s->input = state::patchFloat(i); continue; }
    if (state::pathIs(p, l, "beyond")) { s->beyond = state::patchInt(i); continue; }
    if (state::pathIs(p, l, "input_count")) { s->count = state::patchInt(i); continue; }

    // Per-lane fields: "start_<k>" / "end_<k>" / "curve_<k>". Matched by
    // comparing the prefix and reading the index, rather than formatting 24
    // names per patch (mod_math's approach).
    const char* digits = nullptr;
    int kind = -1;   // 0 = start, 1 = end, 2 = curve
    if (l > 6 && std::strncmp(p, "start_", 6) == 0)      { kind = 0; digits = p + 6; }
    else if (l > 4 && std::strncmp(p, "end_", 4) == 0)   { kind = 1; digits = p + 4; }
    else if (l > 6 && std::strncmp(p, "curve_", 6) == 0) { kind = 2; digits = p + 6; }
    if (kind < 0) continue;

    const int idx = digits[0] - '1';   // "start_1" -> lane 0
    if (idx < 0 || idx >= kMaxOutputs) continue;
    Lane& ln = s->lanes[idx];

    if (kind == 0) {
      ln.start = state::patchFloat(i);
    } else if (kind == 1) {
      ln.end = state::patchFloat(i);
    } else {
      // Re-parse only when the curve actually changes — native has no
      // dirty-tracking, so avoid re-parsing an identical string every frame.
      char buf[kCurveBuf];
      state::patchString(i, buf, sizeof(buf));
      if (std::strcmp(buf, ln.curveJson) != 0) {
        std::memcpy(ln.curveJson, buf, sizeof(buf));
        ln.reparse();
      }
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_slice
