#pragma once
/*
 * envelope.h — Piecewise envelope curve: parse + evaluate.
 *
 * An envelope is a sorted list of (x, y, ease) control points defining a remap
 * curve over [x0, xn]: between consecutive points it interpolates y, shaping the
 * parametric t with a per-segment EXPONENTIAL ease (ease 0 = linear; ease > 0
 * bulges the rise up, ease < 0 bulges it down). Outside [x0, xn] it clamps flat.
 *
 * Backs the `mod.envelope` shaper effect — the user draws the curve in the
 * inspector (web/src/editors/envelope-inspector.ts), which serializes it to a
 * flat JSON number array "[x0,y0,e0, x1,y1,e1, ...]" stored in a string field;
 * the effect parses that and evaluates it on the modulation input. The widget
 * mirrors `applyEase`/`eval` in TS to DRAW the same curve (a live use, kept
 * conceptually identical). Behavior is pinned by native/tests/test_envelope.cpp.
 *
 * Header-only and dependency-light so it compiles in the native runtime and any
 * wasm effect bundle.
 */

#include <cmath>
#include <cstdlib>

namespace envelope {

struct Point {
  float x = 0.0f;
  float y = 0.0f;
  float ease = 0.0f;   // easing of the segment FROM this point to the next
};

constexpr int kMaxPoints = 64;

// Shape the parametric t ∈ [0,1] of a segment by its `ease` ∈ [-1,1].
// exponent = pow(2, -3*ease): ease 0 → 1 (linear), +1 → 1/8 (bulge up / fast
// rise), -1 → 8 (bulge down / slow rise). Endpoints are exact (0→0, 1→1).
inline float applyEase(float t, float ease) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  if (ease == 0.0f) return t;
  const float e = std::pow(2.0f, -3.0f * ease);
  return std::pow(t, e);
}

// Evaluate the envelope (n points, sorted by x ascending) at `x`. Clamps flat
// outside [x0, xn]. Returns 0 when empty.
inline float eval(const Point* pts, int n, float x) {
  if (n <= 0) return 0.0f;
  if (n == 1 || x <= pts[0].x) return pts[0].y;
  if (x >= pts[n - 1].x) return pts[n - 1].y;
  for (int i = 0; i < n - 1; ++i) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const float span = pts[i + 1].x - pts[i].x;
      const float t = span > 0.0f ? (x - pts[i].x) / span : 0.0f;
      const float et = applyEase(t, pts[i].ease);
      return pts[i].y + et * (pts[i + 1].y - pts[i].y);
    }
  }
  return pts[n - 1].y;
}

// Parse a flat JSON-style number list "[x0,y0,e0, x1,y1,e1, ...]" (NUL-terminated
// `s`) into points, scanning floats in triples and ignoring all non-numeric
// punctuation. Tolerant of whitespace / a trailing partial triple. Returns the
// point count (capped at maxN). Does NOT sort — the editor keeps points sorted.
inline int parse(const char* s, Point* out, int maxN) {
  if (!s) return 0;
  float nums[kMaxPoints * 3];
  int count = 0;
  const int cap = kMaxPoints * 3;
  const char* p = s;
  while (*p && count < cap) {
    const char c = *p;
    const bool numStart =
        (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.';
    if (numStart) {
      char* np = nullptr;
      const double val = std::strtod(p, &np);
      if (np == p) { ++p; continue; }   // no progress (e.g. lone '+') → skip
      nums[count++] = (float)val;
      p = np;
    } else {
      ++p;
    }
  }
  int np = count / 3;
  if (np > maxN) np = maxN;
  for (int k = 0; k < np; ++k) {
    out[k].x = nums[k * 3 + 0];
    out[k].y = nums[k * 3 + 1];
    out[k].ease = nums[k * 3 + 2];
  }
  return np;
}

}  // namespace envelope
