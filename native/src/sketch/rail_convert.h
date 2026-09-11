#pragma once
/*
 * rail_convert.h — Fitting a wire's value to the WIDTH of the field it lands on.
 *
 * A vector field (float2/float3/float4) is ONE field with a width. A wire may
 * drive the whole field or a single LANE (component) of it, and the producer's
 * width need not match the consumer's. This header owns that width arithmetic
 * and nothing else: the magnitude/combine fold stays in the executor (it needs
 * tap_mod.h plus the stateful delay + band stages), and runs PER LANE on what
 * comes out of here.
 *
 * A conversion NEVER refuses. Every (source width, dest width, mode, lane)
 * combination produces a defined result — an out-of-range lane is ignored
 * rather than dropped — because the editor lets any two endpoints be connected
 * and settles the ambiguity with a per-wire option, exactly like `combine` and
 * `magnitude`.
 *
 * `laneMask` is the output that matters: it says which dest lanes this wire
 * actually drives. Lanes outside the mask keep whatever the consumer already
 * had (the authored value, or a previous wire's fold), which is what lets two
 * wires drive lane 0 and lane 1 of one field independently and what stops a
 * narrow source from resetting the lanes it has nothing to say about.
 *
 * Like tap_mod.h this is header-only and dependency-light so it compiles into
 * both the native barrel and executor.wasm. Behaviour is pinned by
 * native/tests/test_rail_convert.cpp against the shared fixture
 * web/test/fixtures/rail-convert-cases.json.
 *
 * KNOWN GAP (pre-existing, not addressed here): there is no `delayedRailVecs_`
 * in the executor — only delayedRailFloats_ / delayedRailTextures_ — so a vec
 * wire in a delayed (feedback) position is dormant on frame 0 and reads the
 * current frame's rail thereafter. Per-lane wires make that much easier to hit.
 */

#include <cstdint>
#include <string>

namespace rail_convert {

/// Vector fields top out at float4.
constexpr int kMaxComps = 4;

/**
 * How a source of width S is fitted to a destination of width D.
 *
 * - `Auto`    — S == 1 broadcasts to every lane; otherwise elementwise for the
 *               lanes both sides have, leaving any dest lane past S UNDRIVEN
 *               (an rgb source into an rgba field leaves your authored alpha
 *               alone rather than resetting it to the schema default).
 * - `Broadcast` — every dest lane takes source component 0. The override for
 *               "I have several components but want one of them to drive the
 *               whole field uniformly".
 * - `Truncate`  — elementwise for min(S,D) lanes, the rest undriven. Differs
 *               from Auto only at S == 1, where it drives lane 0 ALONE instead
 *               of broadcasting.
 * - `Pad`       — elementwise for min(S,D) lanes, and every remaining dest lane
 *               is driven from the destination field's declared per-component
 *               default. The override for "drive the whole field even though I
 *               am narrower than it".
 */
enum class Convert { Auto, Broadcast, Truncate, Pad };

/// Parse the wire's `convert` option. Unknown / empty → Auto.
inline Convert parseConvert(const std::string& s) {
  if (s == "broadcast") return Convert::Broadcast;
  if (s == "truncate")  return Convert::Truncate;
  if (s == "pad")       return Convert::Pad;
  return Convert::Auto;
}

inline const char* convertName(Convert c) {
  switch (c) {
    case Convert::Broadcast: return "broadcast";
    case Convert::Truncate:  return "truncate";
    case Convert::Pad:       return "pad";
    case Convert::Auto:
    default:                 return "auto";
  }
}

/// A wire's lane addressing. -1 = the whole field on that end.
struct Lanes {
  int src = -1;
  int dest = -1;
  Convert convert = Convert::Auto;
};

/**
 * The fitted result. `comps[i]` is meaningful only where bit i of `laneMask`
 * is set — every other lane is untouched by this wire and the caller must keep
 * whatever it already had there.
 */
struct Fit {
  float comps[kMaxComps] = {0, 0, 0, 0};
  int n = 0;              ///< destination width
  uint32_t laneMask = 0;  ///< which dest lanes this wire drives
};

/// Take one component of a source. Out-of-range (or lane < 0) copies through
/// unchanged — a lane address that doesn't apply is ignored, never fatal.
/// Returns the resulting component count; writes at most kMaxComps into `out`.
inline int selectLane(const float* in, int nIn, int lane, float* out) {
  if (nIn > kMaxComps) nIn = kMaxComps;
  if (lane >= 0 && lane < nIn) {
    out[0] = in[lane];
    return 1;
  }
  for (int i = 0; i < nIn; ++i) out[i] = in[i];
  return nIn < 0 ? 0 : nIn;
}

/// Fit a source of width `nIn` onto a destination of width `destWidth`.
/// `destDefaults` is the dest field's declared per-component default array;
/// when it is short (or absent) the missing entries read 0.
inline Fit fitWidth(const float* in, int nIn, int destWidth, Convert mode,
                    const float* destDefaults, int nDefaults) {
  Fit f;
  if (destWidth < 1) destWidth = 1;
  if (destWidth > kMaxComps) destWidth = kMaxComps;
  f.n = destWidth;
  if (nIn <= 0) return f;   // dormant rail — nothing driven
  if (nIn > kMaxComps) nIn = kMaxComps;

  // Auto resolves to a concrete rule up front so the rest is one code path.
  if (mode == Convert::Auto) {
    mode = (nIn == 1) ? Convert::Broadcast : Convert::Truncate;
  }

  if (mode == Convert::Broadcast) {
    for (int i = 0; i < destWidth; ++i) f.comps[i] = in[0];
    f.laneMask = (destWidth >= 32) ? ~0u : ((1u << destWidth) - 1u);
    return f;
  }

  const int shared = nIn < destWidth ? nIn : destWidth;
  for (int i = 0; i < shared; ++i) f.comps[i] = in[i];
  f.laneMask = (1u << shared) - 1u;

  if (mode == Convert::Pad) {
    for (int i = shared; i < destWidth; ++i) {
      f.comps[i] = (destDefaults && i < nDefaults) ? destDefaults[i] : 0.0f;
      f.laneMask |= (1u << i);
    }
  }
  return f;
}

/**
 * The whole width pipeline for one read tap: source lane selection, then the
 * width fit, then destination lane addressing.
 *
 * A `dest` lane narrows the result to that single component — and reduces a
 * still-wide source to its component 0, the same rule a vec source landing on
 * a scalar field follows. That is what makes an N→1 connection need no refusal
 * and no special case.
 */
inline Fit apply(const float* rail, int nRail, const Lanes& lanes, int destWidth,
                 const float* destDefaults, int nDefaults) {
  float src[kMaxComps] = {0, 0, 0, 0};
  const int nSrc = selectLane(rail, nRail, lanes.src, src);

  if (destWidth < 1) destWidth = 1;
  if (destWidth > kMaxComps) destWidth = kMaxComps;

  if (lanes.dest >= 0 && lanes.dest < destWidth) {
    Fit f;
    f.n = destWidth;
    if (nSrc <= 0) return f;              // dormant rail — nothing driven
    f.comps[lanes.dest] = src[0];
    f.laneMask = 1u << lanes.dest;
    return f;
  }
  return fitWidth(src, nSrc, destWidth, lanes.convert, destDefaults, nDefaults);
}

}  // namespace rail_convert
