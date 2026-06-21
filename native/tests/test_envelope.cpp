// test_envelope.cpp — goldens for the envelope curve parse + evaluate
// (envelope.h) backing the mod.shaper.envelope shaper. Pins interpolation, the
// per-segment exponential easing, flat clamping, and the flat-array parser.

#include "sketch/envelope.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

using Catch::Matchers::WithinAbs;
using envelope::Point;

TEST_CASE("envelope evaluates a linear identity curve", "[envelope]") {
  Point pts[] = {{0, 0, 0}, {1, 1, 0}};
  CHECK_THAT(envelope::eval(pts, 2, 0.00f), WithinAbs(0.00, 1e-5));
  CHECK_THAT(envelope::eval(pts, 2, 0.25f), WithinAbs(0.25, 1e-5));
  CHECK_THAT(envelope::eval(pts, 2, 0.50f), WithinAbs(0.50, 1e-5));
  CHECK_THAT(envelope::eval(pts, 2, 1.00f), WithinAbs(1.00, 1e-5));
}

TEST_CASE("envelope clamps flat outside the point range", "[envelope]") {
  Point pts[] = {{0.25f, 0.2f, 0}, {0.75f, 0.9f, 0}};
  CHECK_THAT(envelope::eval(pts, 2, 0.0f), WithinAbs(0.2, 1e-5));   // below x0 → y0
  CHECK_THAT(envelope::eval(pts, 2, 1.0f), WithinAbs(0.9, 1e-5));   // above xn → yn
  CHECK_THAT(envelope::eval(pts, 2, 0.5f), WithinAbs(0.55, 1e-5));  // midpoint, linear
  // Empty / single point.
  CHECK(envelope::eval(pts, 0, 0.5f) == 0.0f);
  CHECK_THAT(envelope::eval(pts, 1, 0.5f), WithinAbs(0.2, 1e-5));
}

TEST_CASE("envelope easing bends the segment but keeps endpoints exact", "[envelope]") {
  // ease > 0 bulges up (output above the linear line at the midpoint).
  Point up[] = {{0, 0, 1.0f}, {1, 1, 0}};
  CHECK_THAT(envelope::eval(up, 2, 0.0f), WithinAbs(0.0, 1e-5));   // endpoint exact
  CHECK_THAT(envelope::eval(up, 2, 1.0f), WithinAbs(1.0, 1e-5));   // endpoint exact
  CHECK(envelope::eval(up, 2, 0.5f) > 0.5f + 0.05f);               // bulges above the line
  // ease < 0 bulges down (below the line at the midpoint).
  Point down[] = {{0, 0, -1.0f}, {1, 1, 0}};
  CHECK(envelope::eval(down, 2, 0.5f) < 0.5f - 0.05f);
  // ease at the midpoint: pow(0.5, 1/8) for ease=+1.
  CHECK_THAT(envelope::eval(up, 2, 0.5f),
             WithinAbs(std::pow(0.5, std::pow(2.0, -3.0)), 1e-5));
}

TEST_CASE("envelope evaluates a multi-segment curve", "[envelope]") {
  // Rise to a peak then fall: (0,0)->(0.5,1)->(1,0), linear segments.
  Point pts[] = {{0, 0, 0}, {0.5f, 1, 0}, {1, 0, 0}};
  CHECK_THAT(envelope::eval(pts, 3, 0.25f), WithinAbs(0.5, 1e-5));  // up-leg mid
  CHECK_THAT(envelope::eval(pts, 3, 0.50f), WithinAbs(1.0, 1e-5));  // peak
  CHECK_THAT(envelope::eval(pts, 3, 0.75f), WithinAbs(0.5, 1e-5));  // down-leg mid
}

TEST_CASE("envelope parses a flat JSON number array", "[envelope]") {
  Point pts[envelope::kMaxPoints];
  int n = envelope::parse("[0,0,0, 0.5,0.8,0.5, 1,1,0]", pts, envelope::kMaxPoints);
  REQUIRE(n == 3);
  CHECK_THAT(pts[0].x, WithinAbs(0.0, 1e-6));
  CHECK_THAT(pts[1].x, WithinAbs(0.5, 1e-6));
  CHECK_THAT(pts[1].y, WithinAbs(0.8, 1e-6));
  CHECK_THAT(pts[1].ease, WithinAbs(0.5, 1e-6));
  CHECK_THAT(pts[2].y, WithinAbs(1.0, 1e-6));

  // Negative easing, extra whitespace, trailing partial triple ignored.
  int n2 = envelope::parse("  0 0 -1   1 1 0   0.5,0.5 ", pts, envelope::kMaxPoints);
  CHECK(n2 == 2);
  CHECK_THAT(pts[0].ease, WithinAbs(-1.0, 1e-6));

  // Empty / garbage → 0 points.
  CHECK(envelope::parse("[]", pts, envelope::kMaxPoints) == 0);
  CHECK(envelope::parse("", pts, envelope::kMaxPoints) == 0);
}

TEST_CASE("envelope round-trips parse -> eval as an identity passthrough", "[envelope]") {
  Point pts[envelope::kMaxPoints];
  int n = envelope::parse("[0,0,0,1,1,0]", pts, envelope::kMaxPoints);
  REQUIRE(n == 2);
  CHECK_THAT(envelope::eval(pts, n, 0.3f), WithinAbs(0.3, 1e-5));
  CHECK_THAT(envelope::eval(pts, n, 0.7f), WithinAbs(0.7, 1e-5));
}
