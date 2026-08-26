// test_text_precise.cpp — the Precise (analytic outline) glyph path.
//
// MSDF is a fixed-resolution field: past a few multiples of the atlas reference
// em it rounds corners off and can punch pinholes through thin strokes. The
// Precise path evaluates the real outline per pixel instead, and Auto fades
// between the two as a glyph grows. These tests pin the three properties that
// make that safe to ship:
//
//   fidelity  — at a large size the precise raster tracks a supersampled
//               ground truth more closely than MSDF does, and never leaves a
//               hole in the middle of a stem.
//   handover  — Auto equals Smooth below the fade, equals Precise above it, and
//               lands strictly between them inside it. No pop on a size sweep.
//   scale-free — one baked record serves every size (the arena doesn't grow
//               when the same glyph is laid out again bigger).
//
// CPU-only: Engine::rasterize is the golden both GPU compositors are validated
// against, so testing it here covers the shader math by construction.

#include <catch2/catch_test_macros.hpp>

#include "runtime/text_host.h"
#include "text/text_engine.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

extern "C" int text_layout(const char* spec_json, int spec_len);

using text_engine::Engine;
using text_engine::Precision;

namespace {

constexpr int kW = 900, kH = 700;

void ensurePrimary() {
  effect_runtime::textInstallDefaultFonts(nullptr);
  REQUIRE(effect_runtime::textFontsReady());
}

std::string spec(const char* text, float sizePx, Precision p) {
  char buf[512];
  int n = std::snprintf(buf, sizeof(buf),
      "{\"text\":\"%s\",\"precision\":%d,"
      "\"runs\":[{\"size_px\":%.1f,\"rgba\":[1,1,1,1]}]}",
      text, (int)p, (double)sizePx);
  return std::string(buf, (size_t)n);
}

// Rasterize onto opaque black; the red channel IS the coverage (white text).
std::vector<uint8_t> render(const char* text, float sizePx, Precision p) {
  std::string s = spec(text, sizePx, p);
  int id = text_layout(s.c_str(), (int)s.size());
  REQUIRE(id > 0);
  std::vector<uint8_t> out((size_t)kW * kH * 4);
  REQUIRE(Engine::instance().rasterize(id, kW, kH, 20.0f, 20.0f, nullptr, out.data()));
  Engine::instance().release(id);
  return out;
}

inline float cov(const std::vector<uint8_t>& img, int x, int y) {
  return img[((size_t)y * kW + x) * 4] / 255.0f;
}

// Compare through a bool: Catch2 expands a mismatching vector<uint8_t> into
// pages of unreadable output.
bool same(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
  return a == b;
}

// Mean absolute coverage difference over the whole canvas.
double meanAbsDiff(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
  double acc = 0;
  size_t px = (size_t)kW * kH;
  for (size_t i = 0; i < px; i++) acc += std::fabs((double)a[i * 4] - (double)b[i * 4]);
  return acc / (double)px;
}

// A 4x4-supersampled reference: rendering the SAME text 4x bigger and box-
// filtering down approximates ground truth far better than either path at 1x,
// because both paths converge to the true outline as resolution rises.
std::vector<uint8_t> supersampledTruth(const char* text, float sizePx) {
  const int S = 4;
  std::string s = spec(text, sizePx * S, Precision::Precise);
  int id = text_layout(s.c_str(), (int)s.size());
  REQUIRE(id > 0);
  std::vector<uint8_t> big((size_t)kW * S * kH * S * 4);
  REQUIRE(Engine::instance().rasterize(id, kW * S, kH * S, 20.0f * S, 20.0f * S,
                                       nullptr, big.data()));
  Engine::instance().release(id);
  std::vector<uint8_t> out((size_t)kW * kH * 4, 255);
  for (int y = 0; y < kH; y++) {
    for (int x = 0; x < kW; x++) {
      int acc = 0;
      for (int j = 0; j < S; j++)
        for (int i = 0; i < S; i++)
          acc += big[(((size_t)(y * S + j) * (kW * S)) + (x * S + i)) * 4];
      uint8_t v = (uint8_t)((acc + (S * S) / 2) / (S * S));
      size_t o = ((size_t)y * kW + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
    }
  }
  return out;
}

}  // namespace

// Big text is the case the Precise path exists for: it must land closer to the
// truth than the atlas does, not merely differ from it.
TEST_CASE("precise glyphs track the true outline more closely than MSDF at large sizes") {
  ensurePrimary();
  const char* kText = "Rg";
  const float kSize = 400.0f;

  std::vector<uint8_t> truth  = supersampledTruth(kText, kSize);
  std::vector<uint8_t> smooth = render(kText, kSize, Precision::Smooth);
  std::vector<uint8_t> precise = render(kText, kSize, Precision::Precise);

  double dSmooth = meanAbsDiff(smooth, truth);
  double dPrecise = meanAbsDiff(precise, truth);
  INFO("mean |Δ| vs supersampled truth — smooth " << dSmooth << ", precise " << dPrecise);
  CHECK(dPrecise < dSmooth);
}

// The headline artifact: MSDF pinholes. Whatever else differs, the interior of
// a shape must be solid — sample a filled disc well inside a huge 'O'.
TEST_CASE("precise glyphs leave no holes in a stem interior") {
  ensurePrimary();
  std::vector<uint8_t> img = render("O", 500.0f, Precision::Precise);

  // A pixel is INTERIOR when every pixel within radius 3 is also inked — that
  // excludes the AA rind, including the near-horizontal top and bottom of a
  // round glyph where a whole row is edge. Every interior pixel must be fully
  // covered; a pinhole is precisely one that isn't.
  const int R = 3;
  auto interior = [&](int x, int y) {
    for (int j = -R; j <= R; j++)
      for (int i = -R; i <= R; i++)
        if (i * i + j * j <= R * R && cov(img, x + i, y + j) <= 0.5f) return false;
    return true;
  };
  int checked = 0;
  for (int y = R; y < kH - R; y++) {
    for (int x = R; x < kW - R; x++) {
      if (cov(img, x, y) <= 0.5f || !interior(x, y)) continue;
      INFO("interior pixel (" << x << "," << y << ") coverage " << cov(img, x, y));
      CHECK(cov(img, x, y) == 1.0f);
      checked++;
    }
  }
  REQUIRE(checked > 5000);   // the glyph really was there
}

// Auto must be a continuous ramp between the two paths, not a switch: below the
// fade it IS Smooth, above it IS Precise, and inside it sits between them.
TEST_CASE("auto precision hands over without a pop") {
  ensurePrimary();
  const char* kText = "Rg";

  SECTION("below the fade, auto is byte-identical to smooth") {
    // The fade starts at kAutoScale (3) x the Latin reference em (64) = 192 px,
    // or earlier for a glyph whose own tile stops being faithful sooner.
    CHECK(same(render(kText, 100.0f, Precision::Auto),
               render(kText, 100.0f, Precision::Smooth)));
  }
  SECTION("well above the fade, auto is byte-identical to precise") {
    CHECK(same(render(kText, 900.0f, Precision::Auto),
               render(kText, 900.0f, Precision::Precise)));
  }
  SECTION("inside the fade, auto lies between the two endpoints") {
    const float kMid = 270.0f;   // inside [192, 384] for a plain Latin glyph
    std::vector<uint8_t> a = render(kText, kMid, Precision::Auto);
    std::vector<uint8_t> s = render(kText, kMid, Precision::Smooth);
    std::vector<uint8_t> p = render(kText, kMid, Precision::Precise);
    REQUIRE(!same(a, s));
    REQUIRE(!same(a, p));
    int between = 0, outside = 0;
    for (size_t i = 0; i < (size_t)kW * kH; i++) {
      int va = a[i * 4], vs = s[i * 4], vp = p[i * 4];
      if (vs == vp) continue;                       // the two agree — nothing to blend
      int lo = vs < vp ? vs : vp, hi = vs < vp ? vp : vs;
      if (va >= lo - 1 && va <= hi + 1) between++; else outside++;
    }
    INFO("blended pixels between endpoints " << between << ", outside " << outside);
    REQUIRE(between > 0);
    CHECK(outside == 0);
  }
}

// One record per glyph serves every size — that is the whole point of keeping
// the outline in em space, and what makes an animated size sweep affordable.
TEST_CASE("outline records are baked once and reused at any size") {
  ensurePrimary();
  render("Q", 400.0f, Precision::Precise);
  int after1 = Engine::instance().outlineFloatCount();
  REQUIRE(after1 > 0);
  render("Q", 900.0f, Precision::Precise);
  CHECK(Engine::instance().outlineFloatCount() == after1);
  render("Q", 220.0f, Precision::Precise);
  CHECK(Engine::instance().outlineFloatCount() == after1);
}
