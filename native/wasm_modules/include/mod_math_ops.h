/*
 * mod_math_ops.h — the shared binary-op table behind the modulation math nodes.
 *
 * ONE guarded op table, used by two families of effect:
 *   - `mod.shaper.combine` (mod_combine/) — the barrel node: two inputs and a
 *     selectable op, plus gains and post scale/bias.
 *   - `mod.shaper.{add,subtract,...}` (mod_math/) — the split-out nodes: one op
 *     each, no selector, N inputs folded left-to-right.
 *
 * They share this header so a fix to (say) the divide-by-zero guard lands in
 * both at once. Everything here is a pure function of its arguments — no state,
 * no host calls — so it is equally usable from a schema builder and a tick.
 */

#pragma once

#include <cmath>

namespace mod_math_ops {

// Binary op selector.
//
// !! The enum ORDER is a SERIALIZATION CONTRACT !!  These values are what
// `mod.shaper.combine`'s `op` select field persists into saved sketches. Append
// new ops at the END and never renumber, or every stored Combine silently
// changes operation. (The contract lives here now rather than beside the select
// field, so the warning travels with the values.)
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

// Run the binary op on two (already gained, where applicable) inputs. Divide /
// modulo / power / hypot are guarded so no NaN/Inf can leak into the downstream
// wire fold; callers also isfinite-sanitize the final value as a backstop.
inline float applyOp(int op, float a, float b) {
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

// Where an UNWIRED input should rest, per op.
//
// Combine rests every input at 0, which is right for Add but makes Multiply
// publish 0 until every input is wired — a freshly-dropped node that outputs
// nothing reads as broken. The split-out nodes rest each input where the op is
// a no-op instead, so raising the input count never disturbs the running value
// until you actually wire the new input up.
//
// Identities assume the [0,1] modulation range the shapers declare:
//   Min rests at 1 (the top of the range) and Modulo at 1 (a mod 1 == a for
//   a < 1). Quantize rests at 0 because a zero step is its documented
//   pass-through guard, not because 0 is a multiplicative identity.
//
// Three ops have NO identity element and simply rest somewhere defensible:
// Average (an extra input always pulls the mean), Greater and Less (a
// comparison against a constant, not a fold that can be neutral).
inline constexpr float restingInput(int op) {
  switch (op) {
    case OpMultiply:
    case OpDivide:
    case OpMin:
    case OpPower:
    case OpModulo:
    case OpLess:
      return 1.0f;
    default:
      return 0.0f;
  }
}

}  // namespace mod_math_ops
