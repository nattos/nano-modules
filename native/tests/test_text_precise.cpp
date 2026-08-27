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
//   overlap   — a glyph whose outline overlaps ITSELF still fills solid. This is
//               the one that bites in practice: CJK draws each stroke as its own
//               overlapping contour and synthetic bold self-intersects, and a
//               renderer that just takes the nearest edge paints a seam down the
//               middle of solid ink, because the nearest edge there is BURIED
//               inside the shape rather than on its boundary.
//   no stray fill — no block of half-covered pixels away from any edge. Real
//               antialiasing is a one-pixel rind between solid and empty; a
//               patch of grey with neither nearby means the coverage function
//               fell through some path it shouldn't have.
//   scale-free — one baked record serves every size (the arena doesn't grow
//               when the same glyph is laid out again bigger).
//
// CPU-only: Engine::rasterize is the golden both GPU compositors are validated
// against, so testing it here covers the shader math by construction.

#include <catch2/catch_test_macros.hpp>

#include "runtime/text_host.h"
#include "text/text_engine.h"

#include <array>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

extern "C" int text_layout(const char* spec_json, int spec_len);

using text_engine::Engine;
using text_engine::Precision;

namespace {

constexpr int kW = 900, kH = 700;
// The engine's synthetic-bold strength (text_engine.cpp's kSynthEmbolden) — the
// only embolden real content ever produces.
constexpr float kSynthEmbolden = 0.03f;

void ensurePrimary() {
  effect_runtime::textInstallDefaultFonts(nullptr);
  REQUIRE(effect_runtime::textFontsReady());
}

// Register the bundled CJK face the parity harness uses, so a test can reach a
// glyph built from OVERLAPPING contours. Not committed (web/scripts/fetch_fonts.sh
// pulls it), so callers skip when it isn't there.
bool ensureCjkFallback() {
  static int state = -1;
  if (state >= 0) return state == 1;
  const char* path = TEXT_TEST_CJK_FONT;
  std::ifstream f(path, std::ios::binary);
  if (!f) { state = 0; return false; }
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                             std::istreambuf_iterator<char>());
  state = (!bytes.empty() &&
           Engine::instance().addFallbackFont(bytes.data(), (int)bytes.size(), "ja", 2) >= 0)
              ? 1 : 0;
  return state == 1;
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

// Lay out a single glyph through the PRE-SHAPED entry point, which (unlike the
// attributed-string path) lets a test dial synthetic bold up to where the
// outline definitely self-intersects.
std::vector<uint8_t> renderEmboldened(uint32_t cp, float sizePx, float embolden,
                                      Precision p) {
  text_engine::PreGlyph g{};
  g.face = 0;
  g.gid = Engine::instance().glyphIndex(0, cp);
  REQUIRE(g.gid != 0);
  g.cp = cp;
  g.x = 40.0f;
  g.y = sizePx;            // baseline
  g.size = sizePx;
  g.r = g.g = g.b = g.a = 1.0f;
  g.embolden = embolden;
  int id = Engine::instance().layoutGlyphs(&g, 1, nullptr, 0, p);
  REQUIRE(id > 0);
  std::vector<uint8_t> out((size_t)kW * kH * 4);
  REQUIRE(Engine::instance().rasterize(id, kW, kH, 0.0f, 0.0f, nullptr, out.data()));
  Engine::instance().release(id);
  return out;
}

// Pixels that are DEEP inside the ink yet not fully covered — the exact
// signature of a seam along a buried edge. Returns the count and the darkest.
struct Seams { int count; int darkest; };
Seams seamPixels(const std::vector<uint8_t>& img) {
  const int R = 3;
  auto inked = [&](int x, int y) { return img[((size_t)y * kW + x) * 4] > 128; };
  Seams out{0, 255};
  for (int y = R; y < kH - R; y++) {
    for (int x = R; x < kW - R; x++) {
      if (!inked(x, y)) continue;
      bool solid = true;
      for (int j = -R; j <= R && solid; j++)
        for (int i = -R; i <= R; i++)
          if (i * i + j * j <= R * R && !inked(x + i, y + j)) { solid = false; break; }
      int v = img[((size_t)y * kW + x) * 4];
      if (solid && v != 255) { out.count++; if (v < out.darkest) out.darkest = v; }
    }
  }
  return out;
}

// Half-covered pixels that have neither a solid nor an empty pixel nearby. On a
// real antialiased edge both are a pixel or two away; a patch of grey floating
// on its own is the coverage function returning a fallback value over an area.
int strayMidPixels(const std::vector<uint8_t>& img) {
  const int R = 2;
  auto v = [&](int x, int y) { return img[((size_t)y * kW + x) * 4]; };
  int stray = 0;
  for (int y = R; y < kH - R; y++) {
    for (int x = R; x < kW - R; x++) {
      int c = v(x, y);
      if (c < 77 || c > 179) continue;              // not mid-coverage
      bool solid = false, empty = false;
      for (int j = -R; j <= R; j++)
        for (int i = -R; i <= R; i++) {
          int n = v(x + i, y + j);
          if (n == 255) solid = true;
          if (n == 0) empty = true;
        }
      if (!solid && !empty) stray++;
    }
  }
  return stray;
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

// Guards the whole class of "the coverage function fell through a path it
// shouldn't have": an empty band, a missing record, a bad offset. Any of them
// paints an AREA of half-coverage rather than a one-pixel edge. Text with real
// gaps in it (ascenders, descenders, the space) is what puts empty bands under
// the sampler in the first place.
TEST_CASE("precise leaves no stray half-covered areas") {
  ensurePrimary();
  for (float size : {260.0f, 420.0f}) {
    INFO("size " << size);
    CHECK(strayMidPixels(render("Ag j", size, Precision::Precise)) == 0);
    CHECK(strayMidPixels(render("Ag j", size, Precision::Auto)) == 0);
  }
}

// The artifact that per-contour combining exists to kill. CJK draws each stroke
// as its own contour and they overlap freely, so a point deep inside a junction
// has a BURIED edge as its nearest — and treating that as boundary cuts a seam
// straight through solid ink. Before the contour combiner this glyph rendered 78
// such pixels, some fully black.
TEST_CASE("overlapping contours fill solid") {
  ensurePrimary();
  if (!ensureCjkFallback()) {
    SKIP("bundled CJK face absent — run web/scripts/fetch_fonts.sh");
  }
  std::vector<uint8_t> img = render("永", 420.0f, Precision::Precise);
  Seams s = seamPixels(img);
  INFO("seam pixels " << s.count << ", darkest " << s.darkest);
  CHECK(s.count == 0);
}

// KNOWN LIMITATION, pinned so it can't quietly get worse. Synthetic bold offsets
// the outline outward, which makes a SINGLE contour cross itself at inner
// corners. Combining per contour — which is what msdfgen does too — cannot see
// inside one contour, so a few pixels in those little self-overlap loops still
// take a buried edge as their nearest. At the 0.03 em the engine actually
// synthesizes, that is a handful of pixels dipping about a quarter, on a glyph
// 420 px tall: below the threshold of visibility. Fixing it properly means
// resolving self-intersections at bake time, which is a planar-boolean problem
// and not worth it for this.
TEST_CASE("synthetic bold's self-overlap stays within a bounded dip") {
  ensurePrimary();
  CHECK(seamPixels(renderEmboldened('B', 420.0f, 0.0f, Precision::Precise)).count == 0);

  Seams s = seamPixels(renderEmboldened('B', 420.0f, kSynthEmbolden, Precision::Precise));
  INFO("seam pixels " << s.count << ", darkest " << s.darkest);
  // Bounds, not exact values: how badly a font self-intersects under embolden is
  // a property of its outlines. Measured at the time of writing — bundled Noto
  // Sans 6 px / darkest 191, the macOS system UI font 33 px / darkest 135.
  CHECK(s.count <= 64);
  CHECK(s.darkest >= 120);
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

// Smooth and Precise must place the glyph at the SAME size and position: Auto
// cross-fades between them per glyph, so any registration difference shows up
// as the outline visibly growing or sliding as text is scaled through the fade.
//
// The two paths derive that placement independently — Precise reads the real
// outline in em, Smooth reads a field baked into an atlas tile — so this pins
// that the tile's em rectangle really is the rectangle the quad covers. It is
// easy to get subtly wrong: the tile is ceil()'d to whole texels, and taking
// the plane from the glyph bounds instead of the tile squeezed every MSDF glyph
// by up to one texel (5.6 px of height on a 500 px 'H', uniformly, at every
// size). Measured as sub-pixel 0.5-coverage crossings, which is where the two
// paths agree by construction if they agree anywhere.
TEST_CASE("Smooth and Precise register to the same outline", "[text][precise]") {
  ensurePrimary();
  const float kSize = 500.0f;

  // Sub-pixel positions where coverage crosses 0.5 along a row / a column.
  auto crossings = [&](const std::vector<uint8_t>& img, bool horiz, int fixed) {
    std::vector<double> out;
    int n = horiz ? kW : kH;
    for (int i = 1; i < n; i++) {
      float a = horiz ? cov(img, i - 1, fixed) : cov(img, fixed, i - 1);
      float b = horiz ? cov(img, i, fixed)     : cov(img, fixed, i);
      if ((a - 0.5f) * (b - 0.5f) < 0.0f)
        out.push_back((double)i - 1.0 + (0.5 - a) / (b - a));
    }
    return out;
  };

  for (const char* text : {"H", "O", "8"}) {
    auto sm = render(text, kSize, Precision::Smooth);
    auto pr = render(text, kSize, Precision::Precise);
    // Row/column through the middle of the ink, found on the precise raster.
    int ymin = kH, ymax = -1;
    for (int y = 0; y < kH; y++)
      for (int x = 0; x < kW; x++)
        if (cov(pr, x, y) > 0.5f) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; break; }
    REQUIRE(ymax > ymin);
    int row = (ymin + ymax) / 2;
    auto rs = crossings(pr, true, row);
    REQUIRE(rs.size() >= 2);
    // Mid-width, so the column meets the outline near-perpendicular. Probing
    // near a vertical edge instead would cross it almost tangentially, where a
    // sub-pixel horizontal difference reads as a large vertical one.
    int col = (int)((rs.front() + rs.back()) * 0.5);

    for (auto axis : {0, 1}) {
      auto a = axis ? crossings(sm, false, col) : crossings(sm, true, row);
      auto b = axis ? crossings(pr, false, col) : crossings(pr, true, row);
      INFO(text << (axis ? " vertical" : " horizontal"));
      REQUIRE(a.size() == b.size());
      REQUIRE(a.size() >= 2);
      for (size_t i = 0; i < a.size(); i++) REQUIRE(std::fabs(a[i] - b[i]) < 0.5);
      // ...and the same overall extent, which is what a scale error shows up as.
      REQUIRE(std::fabs((a.back() - a.front()) - (b.back() - b.front())) < 0.5);
    }

    // Whole-glyph check, independent of where the probes landed: the inked
    // bounding box and the inked area. A uniform scale error the probes could
    // straddle still moves both.
    auto inkBox = [&](const std::vector<uint8_t>& img) {
      int x0 = kW, y0 = kH, x1 = -1, y1 = -1; long area = 0;
      for (int y = 0; y < kH; y++)
        for (int x = 0; x < kW; x++)
          if (cov(img, x, y) > 0.5f) {
            area++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
      return std::array<long, 5>{x0, y0, x1, y1, area};
    };
    auto ba = inkBox(sm), bb = inkBox(pr);
    INFO(text << " ink box");
    for (int i = 0; i < 4; i++) REQUIRE(std::labs(ba[i] - bb[i]) <= 1);
    REQUIRE(bb[4] > 0);
    REQUIRE(std::fabs((double)(ba[4] - bb[4]) / (double)bb[4]) < 0.01);
  }
}
