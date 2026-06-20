// test_tap_mod.cpp — native half of the LOCK-STEP tap-mod contract.
//
// These goldens MUST match web/src/tap-mod.test.ts exactly: the web simulator
// shapes tap values with the same math so it reproduces native pixels. If a
// formula changes, change both files and keep these numbers in sync.

#include "sketch/tap_mod.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>

using Catch::Matchers::WithinAbs;
using namespace tap_mod;

namespace {
Mod scaleOnly(float s) { Mod m; m.scale = s; return m; }
Mod remap(float inMin, float inMax, float outMin, float outMax) {
  Mod m; m.hasRemap = true;
  m.inMin = inMin; m.inMax = inMax; m.outMin = outMin; m.outMax = outMax;
  return m;
}
Mod withEnvelope(std::initializer_list<envelope::Point> pts) {
  Mod m; int i = 0;
  for (const auto& p : pts) if (i < envelope::kMaxPoints) m.env[i++] = p;
  m.nEnv = i;
  return m;
}
}  // namespace

TEST_CASE("applyTapMod scales from 0", "[tap_mod]") {
  REQUIRE_THAT(applyTapMod(0.5f, scaleOnly(2.0f)), WithinAbs(1.0, 1e-5));
  REQUIRE_THAT(applyTapMod(4.0f, scaleOnly(0.25f)), WithinAbs(1.0, 1e-5));
}

TEST_CASE("applyTapMod remaps a linear range", "[tap_mod]") {
  Mod m = remap(0, 10, 0, 1);
  REQUIRE_THAT(applyTapMod(5.0f, m), WithinAbs(0.5, 1e-5));
  REQUIRE_THAT(applyTapMod(0.0f, m), WithinAbs(0.0, 1e-5));
  REQUIRE_THAT(applyTapMod(10.0f, m), WithinAbs(1.0, 1e-5));
}

TEST_CASE("applyTapMod remaps across non-zero output bounds", "[tap_mod]") {
  Mod m = remap(-1, 1, 100, 200);
  REQUIRE_THAT(applyTapMod(0.0f, m), WithinAbs(150.0, 1e-4));
  REQUIRE_THAT(applyTapMod(-1.0f, m), WithinAbs(100.0, 1e-4));
}

TEST_CASE("applyTapMod saturates when requested", "[tap_mod]") {
  Mod m = remap(0, 10, 0, 1); m.saturate = true;
  REQUIRE_THAT(applyTapMod(15.0f, m), WithinAbs(1.0, 1e-5));
  REQUIRE_THAT(applyTapMod(-5.0f, m), WithinAbs(0.0, 1e-5));
}

TEST_CASE("applyTapMod extrapolates when saturate is off", "[tap_mod]") {
  Mod m = remap(0, 10, 0, 1);
  REQUIRE_THAT(applyTapMod(15.0f, m), WithinAbs(1.5, 1e-5));
}

TEST_CASE("applyTapMod quad ease-in", "[tap_mod]") {
  Mod m = remap(0, 10, 0, 100); m.curveIn = Curve::Quad;
  REQUIRE_THAT(applyTapMod(5.0f, m), WithinAbs(25.0, 1e-4));
}

TEST_CASE("applyTapMod circular ease-in", "[tap_mod]") {
  Mod m = remap(0, 1, 0, 1); m.curveIn = Curve::Circular;
  REQUIRE_THAT(applyTapMod(0.5f, m), WithinAbs(1.0 - std::sqrt(0.75), 1e-5));
}

TEST_CASE("applyTapMod power curve with exponent", "[tap_mod]") {
  Mod m = remap(0, 1, 0, 1); m.curveIn = Curve::Power; m.exponent = 3.0f;
  REQUIRE_THAT(applyTapMod(0.5f, m), WithinAbs(0.125, 1e-5));
}

TEST_CASE("applyTapMod ease-out mirrors the base curve", "[tap_mod]") {
  Mod m = remap(0, 1, 0, 1); m.curveOut = Curve::Quad;  // 1-(1-t)^2 at .5 = .75
  REQUIRE_THAT(applyTapMod(0.5f, m), WithinAbs(0.75, 1e-5));
}

TEST_CASE("applyTapMod foldback reflects out-of-range input", "[tap_mod]") {
  Mod m = remap(0, 10, 0, 1); m.curveIn = Curve::Foldback;
  REQUIRE_THAT(applyTapMod(12.0f, m), WithinAbs(0.8, 1e-5));  // 1.2 -> 0.8
  REQUIRE_THAT(applyTapMod(8.0f, m), WithinAbs(0.8, 1e-5));   // in range, identity
}

TEST_CASE("applyTapMod maps to outMin when inMin == inMax", "[tap_mod]") {
  Mod m = remap(5, 5, 7, 9);
  REQUIRE_THAT(applyTapMod(5.0f, m), WithinAbs(7.0, 1e-5));
}

TEST_CASE("applyTapMod applies scale AFTER remap", "[tap_mod]") {
  // Non-zero outMin makes the order observable: remap(5)=150, then *2 = 300.
  // (Old scale-first would be remap(5*2=10)=200.)
  Mod m = remap(0, 10, 100, 200); m.scale = 2.0f;
  REQUIRE_THAT(applyTapMod(5.0f, m), WithinAbs(300.0, 1e-4));
}

TEST_CASE("applyTapMod evaluates the envelope curve", "[tap_mod]") {
  // Curve (0,0)->(0.5,0.8)->(1,1), linear segments.
  Mod m = withEnvelope({{0, 0, 0}, {0.5f, 0.8f, 0}, {1, 1, 0}});
  REQUIRE_THAT(applyTapMod(0.0f, m), WithinAbs(0.0, 1e-5));
  REQUIRE_THAT(applyTapMod(0.25f, m), WithinAbs(0.4, 1e-5));   // half up the 0->0.8 leg
  REQUIRE_THAT(applyTapMod(0.5f, m), WithinAbs(0.8, 1e-5));
  REQUIRE_THAT(applyTapMod(1.0f, m), WithinAbs(1.0, 1e-5));
}

TEST_CASE("applyTapMod applies the envelope BEFORE remap and scale", "[tap_mod]") {
  // Order is observable: envelope maps 0.5 -> 0.8, then remap(0,1 -> 0,10) = 8,
  // then scale 2 = 16. (Any other order yields a different number.)
  Mod m = withEnvelope({{0, 0, 0}, {0.5f, 0.8f, 0}, {1, 1, 0}});
  m.hasRemap = true; m.inMin = 0; m.inMax = 1; m.outMin = 0; m.outMax = 10;
  m.scale = 2.0f;
  REQUIRE_THAT(applyTapMod(0.5f, m), WithinAbs(16.0, 1e-4));
}

TEST_CASE("applyTapMod with no envelope is unchanged (nEnv == 0)", "[tap_mod]") {
  REQUIRE_THAT(applyTapMod(0.5f, scaleOnly(2.0f)), WithinAbs(1.0, 1e-5));
}

TEST_CASE("combineTap seeds the rail when there is no existing value", "[tap_mod]") {
  REQUIRE_THAT(combineTap(false, 0, 3, Combine::Add, 0.5f), WithinAbs(3.0, 1e-5));
  REQUIRE_THAT(combineTap(false, 0, 3, Combine::Mul, 0.5f), WithinAbs(3.0, 1e-5));
  REQUIRE_THAT(combineTap(false, 0, 3, Combine::Mix, 0.5f), WithinAbs(3.0, 1e-5));
}

TEST_CASE("combineTap replace/add/mul", "[tap_mod]") {
  REQUIRE_THAT(combineTap(true, 2, 3, Combine::Replace, 1), WithinAbs(3.0, 1e-5));
  REQUIRE_THAT(combineTap(true, 2, 3, Combine::Add, 1), WithinAbs(5.0, 1e-5));
  REQUIRE_THAT(combineTap(true, 2, 3, Combine::Mul, 1), WithinAbs(6.0, 1e-5));
}

TEST_CASE("combineTap mix lerps with the per-tap factor", "[tap_mod]") {
  REQUIRE_THAT(combineTap(true, 2, 3, Combine::Mix, 0.5f), WithinAbs(2.5, 1e-5));
  REQUIRE_THAT(combineTap(true, 2, 3, Combine::Mix, 1.0f), WithinAbs(3.0, 1e-5));
  REQUIRE_THAT(combineTap(true, 2, 3, Combine::Mix, 0.0f), WithinAbs(2.0, 1e-5));
}

// --- applyMagnitude — mirrors web/src/tap-mod.test.ts describe('applyMagnitude').
// MIN=0, MAX=3 (span 3, mid 1.5). isSigned: true = 'signed', false = 'unsigned'.
namespace { constexpr float MN = 0.0f, MX = 3.0f; }

TEST_CASE("applyMagnitude signed replace maps -1..1 -> min..max", "[tap_mod]") {
  REQUIRE_THAT(applyMagnitude(0, -1, true, Combine::Replace, 1, MN, MX), WithinAbs(0.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(0,  0, true, Combine::Replace, 1, MN, MX), WithinAbs(1.5, 1e-5));
  REQUIRE_THAT(applyMagnitude(0,  1, true, Combine::Replace, 1, MN, MX), WithinAbs(3.0, 1e-5));
}

TEST_CASE("applyMagnitude unsigned replace maps 0..1 -> min..max", "[tap_mod]") {
  REQUIRE_THAT(applyMagnitude(0, 0.0f, false, Combine::Replace, 1, MN, MX), WithinAbs(0.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(0, 0.5f, false, Combine::Replace, 1, MN, MX), WithinAbs(1.5, 1e-5));
  REQUIRE_THAT(applyMagnitude(0, 1.0f, false, Combine::Replace, 1, MN, MX), WithinAbs(3.0, 1e-5));
}

TEST_CASE("applyMagnitude add pushes by +/-input*span (signed == unsigned)", "[tap_mod]") {
  REQUIRE_THAT(applyMagnitude(1,  1, true,  Combine::Add, 1, MN, MX), WithinAbs( 4.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(1, -1, true,  Combine::Add, 1, MN, MX), WithinAbs(-2.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(1,  0, true,  Combine::Add, 1, MN, MX), WithinAbs( 1.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(1, 0.5f, false, Combine::Add, 1, MN, MX), WithinAbs(2.5, 1e-5));
}

TEST_CASE("applyMagnitude signed mul scales delta around the midpoint", "[tap_mod]") {
  const float ex = 2;  // mid 1.5, delta +0.5
  REQUIRE_THAT(applyMagnitude(ex,  1, true, Combine::Mul, 1, MN, MX), WithinAbs(2.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(ex,  0, true, Combine::Mul, 1, MN, MX), WithinAbs(1.5, 1e-5));
  REQUIRE_THAT(applyMagnitude(ex, -1, true, Combine::Mul, 1, MN, MX), WithinAbs(1.0, 1e-5));
}

TEST_CASE("applyMagnitude unsigned mul scales the existing value from min", "[tap_mod]") {
  const float ex = 2;
  REQUIRE_THAT(applyMagnitude(ex, 1.0f, false, Combine::Mul, 1, MN, MX), WithinAbs(2.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(ex, 0.0f, false, Combine::Mul, 1, MN, MX), WithinAbs(0.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(ex, 0.5f, false, Combine::Mul, 1, MN, MX), WithinAbs(1.0, 1e-5));
}

TEST_CASE("applyMagnitude mix blends existing toward the mapped replace value", "[tap_mod]") {
  REQUIRE_THAT(applyMagnitude(1, 1, false, Combine::Mix, 0.5f, MN, MX), WithinAbs(2.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(1, 1, false, Combine::Mix, 1.0f, MN, MX), WithinAbs(3.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(1, 1, false, Combine::Mix, 0.0f, MN, MX), WithinAbs(1.0, 1e-5));
  REQUIRE_THAT(applyMagnitude(0, 0, true,  Combine::Mix, 1.0f, MN, MX), WithinAbs(1.5, 1e-5));
}

TEST_CASE("applyMagnitude unsigned replace into 0..1 is a pass-through (== absolute)", "[tap_mod]") {
  REQUIRE_THAT(applyMagnitude(0.7f, 0.5f, false, Combine::Replace, 1, 0.0f, 1.0f), WithinAbs(0.5, 1e-5));
}
