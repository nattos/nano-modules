/*
 * mod.shaper.{add,subtract,multiply,...} — the split-out modulation math nodes.
 *
 * One node per operation, where `mod.shaper.combine` is one node with an op
 * selector. A card labelled "Add" says what it does; a card labelled "Combine"
 * makes you open it. These are what you reach for on the sidecar canvas.
 *
 * DELIBERATELY SIMPLER than combine: no op selector, no per-input gains, no
 * output scale/bias, no saturate. Every one of those is already available — and
 * better placed — on the WIRE feeding or leaving the node, where it applies in
 * modulation space (see tap_mod.h). Duplicating them here just gives the same
 * value two places to be shaped.
 *
 * WHAT THEY ADD instead is a variable INPUT COUNT: 2..8 inputs, folded
 * LEFT-TO-RIGHT, so Subtract with four inputs is ((in1 - in2) - in3) - in4 and
 * Add is a plain sum. The count is an ordinary `input_count` state field the
 * editor exposes under the card's gear icon; inputs above it are hidden in the
 * UI (a per-instance overlay — see web/src/state/field-visibility.ts) and
 * skipped by the fold here. The schema itself is FIXED at 8 inputs, because a
 * schema is published once per module TYPE (module_init takes no `self`), so
 * arity can only ever be a value, never a shape.
 *
 * The op table itself lives in include/mod_math_ops.h, shared verbatim with
 * mod_combine so the two can never disagree about what "divide by zero" means.
 *
 * Pure data modules — no GPU, no texture I/O. Inputs arrive as state patches
 * (a wire delivers its value via setParamFloat); we refold and republish
 * `output` every tick so a downstream wire always reads a current value.
 */

#include <host.h>
#include <val.h>
#include <mod_math_ops.h>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace mod_math {

using namespace mod_math_ops;

// The schema's fixed input ceiling. `input_count` selects how many of these
// actually participate; the rest keep their values and are hidden in the editor.
constexpr int kMaxInputs = 8;

// Per-instance state. One per chain entry. `op` is baked in at create() — it's
// the one thing that distinguishes these effects from each other, and unlike
// combine's it is NOT user-settable.
struct State {
  int   op;
  int   count = 2;
  float in[kMaxInputs];

  explicit State(int o) : op(o) { reset(); }

  void reset() {
    count = 2;
    for (int i = 0; i < kMaxInputs; ++i) in[i] = restingInput(op);
  }
};

// Fold the active inputs and publish `output`.
static void recompute(State& s) {
  const int n = (s.count < 2) ? 2 : (s.count > kMaxInputs ? kMaxInputs : s.count);

  float r;
  if (s.op == OpAverage) {
    // The ONE op that can't be left-folded: a fold of pairwise means is not the
    // mean. avg(avg(1,2),3) is 1.75, not 2 — the earlier inputs get weighted
    // more the further left they sit. Take the real mean instead.
    float sum = 0.0f;
    for (int i = 0; i < n; ++i) sum += s.in[i];
    r = sum / static_cast<float>(n);
  } else {
    r = s.in[0];
    for (int i = 1; i < n; ++i) r = applyOp(s.op, r, s.in[i]);
  }

  if (!std::isfinite(r)) r = 0.0f;  // backstop against div/mod/pow blowups

  auto vh = val::number(r);
  state::setValPath("output", vh);
  val::release(vh);
}

// Type-level setup: the schema, identical in shape for every op — only the id,
// the help text, and where the inputs REST differ.
static void buildSchema(const char* id, int op, const char* intro,
                        const char* inputsHelp) {
  state::Schema schema;
  schema.helpField("intro", intro);

  schema.group("inputs", "Inputs").groupHelp(inputsHelp);

  const float rest = restingInput(op);
  for (int i = 0; i < kMaxInputs; ++i) {
    char name[16], disp[16], shortl[8];
    std::snprintf(name, sizeof(name), "input_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "Input %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "%d", i + 1);
    // Every input is a modulation CHANNEL (that's what `magnitude` marks), but
    // input_1 is the only PRIMARY one — which is what makes the executor's
    // shaper auto-connect pick it up from the preceding modulation source
    // (modChannel in sketch_executor.cpp). That's the role input_a plays in
    // combine. The rest are Secondary: never auto-picked, wired by hand or left
    // on their slider.
    schema.floatField(name, rest, 0.f, 1.f,
                      i == 0 ? state::PrimaryInput : state::SecondaryInput,
                      "unsigned")
          .label(disp, shortl);
  }

  // How many of the inputs above take part. Rendered by the editor under the
  // card's gear icon rather than as a body row (the UI hides it there), because
  // it changes the card's SHAPE rather than its value.
  schema.intField("input_count", 2, 2, kMaxInputs, state::SecondaryInput)
        .label("Inputs", "N");

  schema.group("output", "Output");
  // Unsigned [0,1] modulation-range contract, matching the sibling shapers so
  // the result maps directly onto a downstream param.
  schema.floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
        .label("Output", "Out");

  schema.capability(state::Capability::ModulationShaper)
        // No ModulationShaperNary exists; Binary is the codebase's "more than
        // one modulation input" marker and is what the arity-aware UI reads.
        .capability(state::Capability::ModulationShaperBinary)
        .capability(state::Capability::TimeIndependent);

  state::init(id, {1, 0, 0}, schema);
}

static void patch(void* self, int n, const char* pb, const int* off,
                  const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if (state::pathIs(p, l, "input_count")) { s->count = state::patchInt(i); continue; }
    // "input_<k>", k in 1..kMaxInputs — matched directly rather than by
    // formatting 8 candidate names per patch entry.
    if (l == 7 && std::memcmp(p, "input_", 6) == 0) {
      const int k = p[6] - '1';
      if (k >= 0 && k < kMaxInputs) s->in[k] = state::patchFloat(i);
    }
  }
}

static void tickImpl(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  // Inputs + params for this frame have already been delivered via state patches
  // (applyReadTaps runs before doTick). Republish so downstream reads are fresh.
  recompute(*s);
}

}  // namespace mod_math

/*
 * One effect namespace per op. Each needs its own seven entry points because
 * NANO_DECLARE_INSTANCE_EFFECT / NANO_INSTANCE_LIFECYCLE resolve them per
 * namespace, but they are all thin forwarders onto the shared implementation
 * above — the op is the only thing that varies, and it rides in State.
 */
#define NANO_MATH_EFFECT(ns, ID, OP, INTRO, INPUTS_HELP)                       \
  namespace ns {                                                               \
    void  module_init() { mod_math::buildSchema(ID, OP, INTRO, INPUTS_HELP); }  \
    void* create() { return new mod_math::State(OP); }                          \
    void  destroy(void* self) { delete static_cast<mod_math::State*>(self); }   \
    void  init(void* self) {                                                    \
      auto* s = static_cast<mod_math::State*>(self);                            \
      if (s) s->reset();                                                        \
    }                                                                           \
    void  tick(void* self, double dt) { (void)dt; mod_math::tickImpl(self); }   \
    void  render(void* self, int w, int h) { (void)self; (void)w; (void)h; }    \
    void  on_state_patched(void* self, int n, const char* pb, const int* off,   \
                           const int* len, const int* ops) {                    \
      mod_math::patch(self, n, pb, off, len, ops);                              \
    }                                                                           \
  }

#define NANO_MATH_INPUTS_HELP(verb)                                            \
  "The signals to " verb ". *Input 1* is the primary input — dropped right "   \
  "after a modulation source, it auto-wires to it. The rest are wired by hand " \
  "(or left on their sliders). Use the gear icon to change how many inputs "    \
  "this node has."

NANO_MATH_EFFECT(mod_add, "mod.shaper.add", mod_math_ops::OpAdd,
  "## Add\n"
  "Sums its inputs. The workhorse of modulation math: layer a slow LFO under a "
  "fast one for drift-plus-flutter, or add an envelope to a steady offset.\n\n"
  "Add more inputs from the **gear** icon — they fold in left to right, so the "
  "result is `in1 + in2 + in3 + ...`. Unwired inputs rest at 0 and change nothing.",
  NANO_MATH_INPUTS_HELP("add together"));

NANO_MATH_EFFECT(mod_subtract, "mod.shaper.subtract", mod_math_ops::OpSubtract,
  "## Subtract\n"
  "Takes each input away from the running result, left to right: "
  "`in1 - in2 - in3 - ...`. Use it to carve one signal out of another — an "
  "envelope that ducks whenever a second source rises.\n\n"
  "Unwired inputs rest at 0 and subtract nothing.",
  NANO_MATH_INPUTS_HELP("subtract"));

NANO_MATH_EFFECT(mod_multiply, "mod.shaper.multiply", mod_math_ops::OpMultiply,
  "## Multiply\n"
  "Multiplies its inputs together — ring-mod-style flicker from two LFOs, or "
  "one signal gating another. Because everything rests at 1, an unwired input "
  "leaves the product untouched.\n\n"
  "**Try:** multiply an LFO by an envelope so the wobble only happens while the "
  "envelope is open.",
  NANO_MATH_INPUTS_HELP("multiply"));

NANO_MATH_EFFECT(mod_divide, "mod.shaper.divide", mod_math_ops::OpDivide,
  "## Divide\n"
  "Divides the running result by each input in turn: `in1 / in2 / in3 / ...`. "
  "Guarded — a zero divisor can never produce NaN. Unwired inputs rest at 1 and "
  "divide by nothing.",
  NANO_MATH_INPUTS_HELP("divide by"));

NANO_MATH_EFFECT(mod_min, "mod.shaper.min", mod_math_ops::OpMin,
  "## Min\n"
  "Takes whichever input is **smallest** — a signal is only as loud as its "
  "quietest contributor. Handy as a soft gate: the result can't rise until "
  "every input does.\n\n"
  "Unwired inputs rest at 1 (the top of the range) so they never win.",
  NANO_MATH_INPUTS_HELP("take the smallest of"));

NANO_MATH_EFFECT(mod_max, "mod.shaper.max", mod_math_ops::OpMax,
  "## Max\n"
  "Takes whichever input is **largest** — whichever source is loudest wins. The "
  "natural way to merge several triggers into one signal without them summing "
  "past the top of the range.\n\n"
  "Unwired inputs rest at 0 so they never win.",
  NANO_MATH_INPUTS_HELP("take the largest of"));

NANO_MATH_EFFECT(mod_average, "mod.shaper.average", mod_math_ops::OpAverage,
  "## Average\n"
  "The mean of every active input — a smoother blend than Add, since the result "
  "stays inside the range no matter how many inputs you add.\n\n"
  "Note that an unwired input still counts: it rests at 0 and pulls the mean "
  "down. Raise the input count only as you wire them.",
  NANO_MATH_INPUTS_HELP("average"));

NANO_MATH_EFFECT(mod_difference, "mod.shaper.difference", mod_math_ops::OpDifference,
  "## Difference\n"
  "The absolute distance between the inputs, folded left to right. Two LFOs at "
  "slightly different rates produce a slow **beat** as they drift in and out of "
  "phase — a classic source of long-form movement.",
  NANO_MATH_INPUTS_HELP("take the difference of"));

NANO_MATH_EFFECT(mod_screen, "mod.shaper.screen", mod_math_ops::OpScreen,
  "## Screen\n"
  "Inverse-multiply: `1 - (1-a)(1-b)`. Combines signals the way screen blending "
  "combines light — they accumulate toward 1 but never overshoot it. A gentler "
  "Add for values that are already near the top of the range.",
  NANO_MATH_INPUTS_HELP("screen together"));

NANO_MATH_EFFECT(mod_power, "mod.shaper.power", mod_math_ops::OpPower,
  "## Power\n"
  "Raises the running result to each input in turn. With a value below 1 as the "
  "exponent this eases the signal upward; above 1 it holds it low then snaps. "
  "The simplest way to bend a linear source into a curve.\n\n"
  "Unwired inputs rest at 1 (raising to the first power changes nothing).",
  NANO_MATH_INPUTS_HELP("raise to the power of"));

NANO_MATH_EFFECT(mod_modulo, "mod.shaper.modulo", mod_math_ops::OpModulo,
  "## Modulo\n"
  "The remainder after dividing by each input — wraps a rising signal back to 0 "
  "every time it passes the divisor. Turns a slow ramp into a repeating sawtooth "
  "at whatever rate you choose.",
  NANO_MATH_INPUTS_HELP("wrap by"));

NANO_MATH_EFFECT(mod_greater, "mod.shaper.greater", mod_math_ops::OpGreater,
  "## Greater Than\n"
  "Emits a hard **1** when the running result is above the next input, otherwise "
  "0. A comparison gate: use it to switch something on only while one source "
  "outruns another.\n\n"
  "The output is a hard 0/1 edge — follow it with a *Smooth* shaper if you want "
  "the transition eased.",
  NANO_MATH_INPUTS_HELP("compare"));

NANO_MATH_EFFECT(mod_less, "mod.shaper.less", mod_math_ops::OpLess,
  "## Less Than\n"
  "Emits a hard **1** when the running result is below the next input, otherwise "
  "0 — the mirror of *Greater Than*, for gating on a signal falling away.\n\n"
  "The output is a hard 0/1 edge; follow it with a *Smooth* shaper to ease it.",
  NANO_MATH_INPUTS_HELP("compare"));

NANO_MATH_EFFECT(mod_hypot, "mod.shaper.hypot", mod_math_ops::OpHypot,
  "## Hypot\n"
  "The length of the vector formed by the inputs — `sqrt(a² + b² + ...)`. Reads "
  "as the combined *magnitude* of several sources, rising faster than Max but "
  "more smoothly than Add.",
  NANO_MATH_INPUTS_HELP("take the magnitude of"));

NANO_MATH_EFFECT(mod_quantize, "mod.shaper.quantize", mod_math_ops::OpQuantize,
  "## Quantize\n"
  "Snaps the running result to the nearest multiple of each input — a smooth LFO "
  "becomes a staircase. Small steps read as bit-crushed motion; large ones turn "
  "a sweep into a handful of discrete positions.\n\n"
  "Unwired inputs rest at 0, which is the documented pass-through: a step size "
  "of nothing means infinite resolution, so the signal is left alone.",
  NANO_MATH_INPUTS_HELP("quantize by"));
