#pragma once
/*
 * tap_mod.h — Tap value transforms ("tap mods"): the range remapper + write-tap
 * summation, applied to FLOAT rail values during sketch execution.
 *
 * This is the SOLE implementation of the tap-mod math: the shared executor
 * (sketch_executor.cpp) compiles to BOTH the native barrel AND executor.wasm, so
 * the web runtime runs exactly this code — there is no separate TS port to keep
 * in sync. (There used to be a lock-step web/src/tap-mod.ts twin from when the web
 * had its own TS executor; that executor was replaced by executor.wasm and the
 * twin was removed.) Behavior is pinned by the Catch2 goldens in
 * native/tests/test_tap_mod.cpp; the `mod.remap` effect reuses this verbatim.
 *
 * Header-only and dependency-light (just <cmath>) so it compiles in both the native
 * runtime and any wasm build without dragging in GPU/STL-heavy headers.
 *
 * Read taps run applyTapMod AFTER reading the rail (before feeding the module);
 * write taps run applyTapMod BEFORE writing, then combineTap to fold the result
 * into the rail's current value for this frame.
 */

#include <cmath>

#include "envelope.h"   // header-only, dependency-light — the Envelope stage

namespace tap_mod {

enum class Curve { Linear, Quad, Circular, Power, Foldback };
enum class Combine { Replace, Mix, Add, Mul };

/// Parsed remap spec. `hasRemap` distinguishes "scale only" from "scale + remap".
/// The (optional) Envelope is a user-drawn remap curve applied FIRST, before the
/// remap+scale, sharing the mod.envelope effect's math (envelope.h). `nEnv == 0`
/// → no envelope (pass-through). This makes the WIRE config able to run the same
/// shaper transforms (envelope/remap/scale) the standalone mod.* effects do.
struct Mod {
  float scale = 1.0f;
  bool  hasRemap = false;
  float inMin = 0.0f, inMax = 1.0f;
  float outMin = 0.0f, outMax = 1.0f;
  bool  saturate = false;
  Curve curveIn = Curve::Linear;
  Curve curveOut = Curve::Linear;
  float exponent = 2.0f;
  // Envelope curve (sorted control points). Applied before remap. Empty by default.
  envelope::Point env[envelope::kMaxPoints];
  int   nEnv = 0;
};

inline float clamp01(float x) { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }

/// Reflect x into [0,1] (period-2 triangle wave) — the "foldback" range handler.
inline float fold01(float x) {
  float m = std::fmod(x, 2.0f);
  if (m < 0.0f) m += 2.0f;
  return m <= 1.0f ? m : 2.0f - m;
}

/// Base (ease-in) shaping curve. power/circular use sign/range-preserving
/// extensions so out-of-range input stays finite & deterministic; foldback
/// reflects out-of-range input into [0,1].
inline float baseCurve(float t, Curve curve, float exponent) {
  switch (curve) {
    case Curve::Quad:
      return t * t;
    case Curve::Circular: {
      float s = 1.0f - t * t;
      return 1.0f - std::sqrt(s > 0.0f ? s : 0.0f);
    }
    case Curve::Power:
      return t >= 0.0f ? std::pow(t, exponent) : -std::pow(-t, exponent);
    case Curve::Foldback:
      return fold01(t);
    case Curve::Linear:
    default:
      return t;
  }
}

/// Ease-out is the mirror of the ease-in base curve (foldback is symmetric).
inline float shapeOut(float t, Curve curve, float exponent) {
  if (curve == Curve::Foldback) return fold01(t);
  return 1.0f - baseCurve(1.0f - t, curve, exponent);
}

/// Apply a tap's shaper stages to a scalar. Pipeline: ENVELOPE (drawn curve) →
/// REMAP (normalize to [0,1] → (saturate|foldback) → curveIn → curveOut →
/// [outMin,outMax]) → SCALE. `scale` is applied LAST (in parameter-modulation
/// space, before the downstream magnitude unit-normalization) so it scales the
/// modulation output around its neutral point rather than the raw input. Envelope
/// runs FIRST so the drawn curve reshapes the raw modulation value, then remap +
/// scale operate on the result (matches the wire-config ordering Envelope→Remap→
/// Scale). All three are PURE functions of `value`, so the executor's modulation-
/// band sampler folds them for free; the temporal Delay/Smoothing stages live
/// outside this function (stateful, applied in the executor).
inline float applyTapMod(float value, const Mod& mod) {
  float v = value;
  if (mod.nEnv > 0) v = envelope::eval(mod.env, mod.nEnv, v);
  if (mod.hasRemap) {
    float denom = mod.inMax - mod.inMin;
    float t = denom != 0.0f ? (v - mod.inMin) / denom : 0.0f;

    bool foldback = mod.curveIn == Curve::Foldback || mod.curveOut == Curve::Foldback;
    if (foldback) t = fold01(t);
    else if (mod.saturate) t = clamp01(t);

    t = baseCurve(t, mod.curveIn, mod.exponent);
    t = shapeOut(t, mod.curveOut, mod.exponent);

    v = mod.outMin + t * (mod.outMax - mod.outMin);
  }
  return v * mod.scale;
}

/// Fold a write tap's (already modded) value into the rail's current frame value.
/// The first writer this frame just seeds the rail (`hasExisting == false`),
/// regardless of mode; subsequent writers combine per their own mode.
inline float combineTap(bool hasExisting, float existing, float value,
                        Combine combine, float mixFactor) {
  if (!hasExisting) return value;
  switch (combine) {
    case Combine::Add: return existing + value;
    case Combine::Mul: return existing * value;
    case Combine::Mix: return existing + (value - existing) * mixFactor;
    case Combine::Replace:
    default:           return value;
  }
}

/// Range-aware fold for a scalar wire's `magnitude` mode (the convenience
/// alternative to combineTap that maps a standard-range source value into the
/// DEST field's [min,max] per the combine mode). `input` is the value already
/// shaped by applyTapMod. `isSigned` true = bipolar −1..1 source, false =
/// unipolar 0..1. LOCK-STEP twin of web/src/tap-mod.ts applyMagnitude — keep
/// byte-identical (covered by the shared tap-mod goldens).
inline float applyMagnitude(float existing, float input, bool isSigned,
                            Combine combine, float mixFactor,
                            float minV, float maxV) {
  const float span = maxV - minV;
  const float mid = (minV + maxV) * 0.5f;
  // Where the input lands in [min,max] for a replace/mix fold.
  const float replaceVal = isSigned
      ? minV + ((input + 1.0f) * 0.5f) * span   // −1→min, 0→mid, 1→max
      : minV + input * span;                     //  0→min, 1→max
  switch (combine) {
    case Combine::Add:
      // ±1 input pushes by ±100% of the field span (same for both signs).
      return existing + input * span;
    case Combine::Mul:
      return isSigned ? mid + (existing - mid) * input    // 1=identity, 0→mid
                      : minV + (existing - minV) * input; // 1=identity, 0→min
    case Combine::Mix:
      return existing + (replaceVal - existing) * mixFactor;
    case Combine::Replace:
    default:
      return replaceVal;
  }
}

}  // namespace tap_mod
