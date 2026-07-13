/*
 * mod.shaper.combine — Binary modulation combiner.
 *
 * A BINARY modulation shaper: takes TWO scalar modulation values (input_a,
 * input_b), each with its own pre-gain, runs them through a selectable binary
 * math op (add / multiply / min / max / ...), applies a post scale + bias +
 * optional clamp, and republishes the result on `output`. The two-input sibling
 * of the unary shapers (mod.shaper.remap et al.). Pure data module — no GPU, no
 * texture I/O (same shape as mod.shaper.remap).
 *
 * Wiring: `input_a` is PrimaryInput, so the executor's shaper auto-connect wires
 * it from the immediately-preceding modulation source. `input_b` is
 * SecondaryInput — never auto-picked — so the user draws its wire (or leaves it
 * at its slider value). With the default op = Add and input_b resting at 0, a
 * freshly-dropped node just passes input_a through until it's configured.
 *
 * Class-like instance model: module_init() publishes the schema once per type;
 * each chain entry gets its own State via create(). All instance callbacks take
 * `self`. Inputs arrive as state patches on input_a/input_b (a wire delivers the
 * value via setParamFloat); we recompute + republish `output` every tick so a
 * downstream wire always sees a fresh value.
 */

#include <host.h>
#include <val.h>
#include <cmath>

namespace mod_combine {

// Binary op selector — enum order IS the serialized select value; append new
// ops at the end (never renumber) to keep it a PATCH-level change.
enum Op : int {
  OpAdd = 0,
  OpSubtract,
  OpMultiply,
  OpDivide,
  OpMin,
  OpMax,
  OpAverage,
  OpDifference,
  OpScreen,
  OpPower,
  OpModulo,
  OpGreater,
  OpLess,
  OpHypot,
  OpQuantize,
};

// Per-instance state. One per chain entry. Mirrors the schema field-for-field.
struct State {
  float input_a = 0.0f;
  float input_b = 0.0f;
  float gain_a  = 1.0f;
  float gain_b  = 1.0f;
  int   op      = OpAdd;
  float bias    = 0.0f;
  float scale   = 1.0f;
  bool  saturate = false;
};

// Run the binary op on the pre-gained inputs. Divide / modulo / power / hypot
// are guarded so no NaN/Inf can leak into the downstream wire fold; the caller
// also isfinite-sanitizes the final value as a backstop.
static float applyOp(int op, float a, float b) {
  const float eps = 1e-6f;
  switch (op) {
    case OpAdd:        return a + b;
    case OpSubtract:   return a - b;
    case OpMultiply:   return a * b;
    case OpDivide:     return a / ((std::fabs(b) < eps) ? (b >= 0.0f ? eps : -eps) : b);
    case OpMin:        return std::fmin(a, b);
    case OpMax:        return std::fmax(a, b);
    case OpAverage:    return 0.5f * (a + b);
    case OpDifference: return std::fabs(a - b);
    case OpScreen:     return 1.0f - (1.0f - a) * (1.0f - b);
    case OpPower:      return std::pow(std::fmax(a, 0.0f), b);
    case OpModulo:     return (std::fabs(b) < eps) ? 0.0f : (a - b * std::floor(a / b));
    case OpGreater:    return a > b ? 1.0f : 0.0f;
    case OpLess:       return a < b ? 1.0f : 0.0f;
    case OpHypot:      return std::sqrt(a * a + b * b);
    // Snap A to the nearest multiple of B ("steps"). A vanishing step size
    // means infinite resolution — pass A through rather than divide by ~0.
    case OpQuantize:   return (std::fabs(b) < eps) ? a : b * std::floor(a / b + 0.5f);
    default:           return a + b;
  }
}

// Combine the two inputs and publish `output`.
static void recompute(State& s) {
  float a = s.input_a * s.gain_a;
  float b = s.input_b * s.gain_b;
  float r = applyOp(s.op, a, b);
  r = r * s.scale + s.bias;                 // post: scale then bias
  if (s.saturate) r = std::fmin(std::fmax(r, 0.0f), 1.0f);
  if (!std::isfinite(r)) r = 0.0f;          // backstop against div/mod/pow blowups

  auto vh = val::number(r);
  state::setValPath("output", vh);
  val::release(vh);
}

// Type-level setup: schema. Runs once per type. No GPU work.
void module_init() {
  state::init("mod.shaper.combine", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Combine\n"
        "Merges **two** modulation signals with a binary math op — the two-input "
        "sibling of the other shapers. *Input A* auto-wires from whatever "
        "modulation source sits right before it; wire *Input B* from a second "
        "source (or just leave it on its slider for an A-vs-constant blend).\n\n"
        "**Try:** *Multiply* two LFOs for ring-mod-style flicker, *Max* to take "
        "whichever source is louder, *Difference* for a beat between two rates, "
        "*Greater Than* to gate one signal on another, or *Quantize* to snap a "
        "smooth LFO into staircase steps of size B. Use *Gain A/B* to invert or "
        "scale each input first, and *Scale*/*Bias* to place the result.")
      // --- Inputs: the two signals + their pre-gains ---
      .group("inputs", "Inputs")
        .groupHelp(
          "The two signals to combine. *Input A* is the primary input — dropped "
          "right after a modulation source, it auto-wires to it. *Input B* is "
          "wired by hand (or set on its slider). Each input is multiplied by its "
          "*Gain* before the op, so a negative gain inverts that side.")
      // Primary input — the shaper auto-connect wires this from the preceding
      // source (it's the sole PrimaryInput magnitude'd float). Unsigned [0,1]
      // like the sibling remap so a combined value maps DIRECTLY onto a
      // downstream unsigned param (a signed contract would remap 0.5→0.75). Use
      // Gain (signed) / Bias to reach bipolar territory.
      .floatField("input_a", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned").label("Input A", "A")
      // Secondary input — never auto-picked; user-wired or slider-driven.
      .floatField("input_b", 0.0f, 0.f, 1.f, state::SecondaryInput, "unsigned").label("Input B", "B")
      // Per-input pre-gain (negative inverts).
      .floatField("gain_a", 1.0f, -2.f, 2.f, state::SecondaryInput).label("Gain A", "GnA")
      .floatField("gain_b", 1.0f, -2.f, 2.f, state::SecondaryInput).label("Gain B", "GnB")
      // --- Operation: the binary op applied to (A*gainA, B*gainB) ---
      .group("operation", "Operation")
        .groupHelp(
          "The binary op applied to the two gained inputs. Arithmetic (*Add*, "
          "*Subtract*, *Multiply*, *Divide*), selection (*Min*, *Max*, *Average*, "
          "*Difference*), blend (*Screen*, *Power*), comparison (*Greater "
          "Than*, *Less Than*) — comparisons emit a hard 0/1 gate — and "
          "*Quantize*, which snaps A to the nearest multiple of B for stepped "
          "\"bit-crushed\" motion. *Divide*, *Modulo*, *Power*, and *Quantize* "
          "are guarded so a zero or negative operand can never produce NaN "
          "(a zero step passes A through unquantized).")
      .selectField("op", OpAdd, state::PrimaryInput,
                   {{"Add", OpAdd}, {"Subtract", OpSubtract}, {"Multiply", OpMultiply},
                    {"Divide", OpDivide}, {"Min", OpMin}, {"Max", OpMax},
                    {"Average", OpAverage}, {"Difference", OpDifference},
                    {"Screen", OpScreen}, {"Power", OpPower}, {"Modulo", OpModulo},
                    {"Greater Than", OpGreater}, {"Less Than", OpLess},
                    {"Hypot", OpHypot}, {"Quantize", OpQuantize}},
                   /*wrap=*/true).label("Operation", "Op")
      // --- Output: post scale / bias / clamp, then the published channel ---
      .group("output", "Output")
      // Post-processing applied to the op result: out = op * scale + bias.
      .floatField("scale", 1.0f, -2.f, 2.f, state::SecondaryInput).label("Scale", "Scale")
      .floatField("bias", 0.0f, -1.f, 1.f, state::SecondaryInput).label("Bias", "Bias")
      // Hard-clamp the result to [-1,1].
      .boolField("saturate", false, state::SecondaryInput).label("Saturate", "Sat")
      // Combined value. Unsigned [0,1] modulation-range contract (matches the
      // sibling shapers so the result maps directly onto downstream params;
      // negative op results just clamp toward 0 on an unsigned target).
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned").label("Output", "Out")
      // A binary modulation shaper: 2 modulation values in -> 1 combined out.
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::ModulationShaperBinary)
      .capability(state::Capability::TimeIndependent)
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
  *s = State{};
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  // Inputs + params for this frame have already been delivered via state patches
  // (applyReadTaps runs before doTick). Republish the combined output so the
  // downstream wire reads a current value.
  recompute(*s);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "input_a"))  s->input_a  = state::patchFloat(i);
    else if (state::pathIs(p, l, "input_b"))  s->input_b  = state::patchFloat(i);
    else if (state::pathIs(p, l, "gain_a"))   s->gain_a   = state::patchFloat(i);
    else if (state::pathIs(p, l, "gain_b"))   s->gain_b   = state::patchFloat(i);
    else if (state::pathIs(p, l, "op"))       s->op       = state::patchInt(i);
    else if (state::pathIs(p, l, "scale"))    s->scale    = state::patchFloat(i);
    else if (state::pathIs(p, l, "bias"))     s->bias     = state::patchFloat(i);
    else if (state::pathIs(p, l, "saturate")) s->saturate = state::patchBool(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // No rendering — pure data module.
}

} // namespace mod_combine
