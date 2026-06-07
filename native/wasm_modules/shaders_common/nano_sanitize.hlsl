// nano_sanitize.hlsl — portable NaN/Inf hygiene for compute shaders.
//
// Do NOT use the isnan / isinf intrinsics: they compile to SPIR-V but make
// the downstream PSO build fail (the effect then never initializes -> blank
// output, with no build error). The build gate in wasm_build_env.sh rejects
// them. Instead:
//
//   `x != x`   is true ONLY for NaN (portable, no intrinsic).
//   clamp()    folds +/-Inf (and wild-but-finite garbage) back into range.
//
// Persistent-state sims (a GPU buffer carried across frames) MUST sanitize on
// load — a single NaN otherwise sticks forever and freezes the field (see the
// side_jet "live nozzle, dead tail" failure mode).

#ifndef NANO_SANITIZE_HLSL
#define NANO_SANITIZE_HLSL

// True only for NaN.
bool nano_is_nan(float x) { return x != x; }

// NaN -> fallback; otherwise unchanged (no range clamp).
float nano_denan(float x, float fallback) { return (x != x) ? fallback : x; }

// NaN -> fallback; otherwise clamp(x, lo, hi) (also maps +/-Inf to the
// bounds). The one-stop "make this persistent value safe to use" call.
float nano_sanitize(float x, float fallback, float lo, float hi) {
  return (x != x) ? fallback : clamp(x, lo, hi);
}

#endif // NANO_SANITIZE_HLSL
