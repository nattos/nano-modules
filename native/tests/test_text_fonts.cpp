// test_text_fonts.cpp — native OS-font resolution for the text.* service.
//
// The web resolves a spec's named families through Local Font Access
// (font-access.ts); the native counterpart is Core Text: host_impls_font.mm's
// textResolveOsFamily + the spec scan in host_impls_text.cpp's text_layout.
// These tests pin the whole native chain, CPU-only (no GPU backend):
//
//   resolver:   an always-installed family (Menlo — a .ttc, so this also
//               exercises single-face sfnt extraction) yields multiple styled
//               faces FreeType accepts; an unknown family yields NOTHING
//               (Core Text's silent substitution must be rejected).
//   text_layout: a spec naming an OS family registers it on the spot and lays
//               out with it — different advance widths than the primary font —
//               and bold (weight 700) resolves to a distinct face.

#include <catch2/catch_test_macros.hpp>

#include "runtime/text_host.h"
#include "text/text_engine.h"

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

extern "C" int text_layout(const char* spec_json, int spec_len);

using text_engine::Engine;

namespace {

// The engine needs a primary face before named faces can register. Menlo tests
// then resolve against it. Idempotent across TEST_CASEs (engine is a process
// singleton; textInstallDefaultFonts installs exactly once).
void ensurePrimary() {
  effect_runtime::textInstallDefaultFonts(nullptr);   // system UI font
  REQUIRE(effect_runtime::textFontsReady());
}

std::string specFor(const char* family, int weight = 400) {
  char buf[512];
  int n;
  if (family && family[0]) {
    n = std::snprintf(buf, sizeof(buf),
        "{\"text\":\"Hamburgefonstiv\",\"runs\":[{\"family\":\"%s\",\"weight\":%d,"
        "\"italic\":false,\"size_px\":48,\"rgba\":[1,1,1,1]}]}", family, weight);
  } else {
    n = std::snprintf(buf, sizeof(buf),
        "{\"text\":\"Hamburgefonstiv\",\"runs\":[{\"size_px\":48,"
        "\"rgba\":[1,1,1,1]}]}");
  }
  return std::string(buf, (size_t)n);
}

// Laid-out content width — a cheap, deterministic fingerprint of which face
// actually shaped the text (different fonts ⇒ different advance widths).
float layoutWidth(const std::string& spec) {
  int id = text_layout(spec.c_str(), (int)spec.size());
  REQUIRE(id > 0);
  text_engine::Metrics m;
  REQUIRE(Engine::instance().measure(id, m));
  Engine::instance().release(id);
  return m.width;
}

bool validSfntMagic(const std::vector<uint8_t>& b) {
  if (b.size() < 12) return false;
  uint32_t v = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) |
               ((uint32_t)b[2] << 8) | b[3];
  return v == 0x00010000u || v == 0x4F54544Fu /*OTTO*/ || v == 0x74727565u /*true*/;
}

}  // namespace

TEST_CASE("textResolveOsFamily resolves a .ttc family into styled faces", "[fonts]") {
  auto faces = effect_runtime::textResolveOsFamily("Menlo");
  REQUIRE(faces.size() >= 2);   // regular + bold at minimum

  bool sawRegular = false, sawBold = false, sawItalic = false;
  for (const auto& f : faces) {
    CHECK(validSfntMagic(f.bytes));
    if (f.weight == 400 && !f.italic) sawRegular = true;
    if (f.weight == 700 && !f.italic) sawBold = true;
    if (f.italic) sawItalic = true;
  }
  CHECK(sawRegular);
  CHECK(sawBold);
  CHECK(sawItalic);
}

TEST_CASE("textResolveOsFamily rejects unknown families (no substitution)", "[fonts]") {
  CHECK(effect_runtime::textResolveOsFamily("Definitely Not A Font ZZZ").empty());
  CHECK(effect_runtime::textResolveOsFamily("").empty());
  CHECK(effect_runtime::textResolveOsFamily(nullptr).empty());
}

TEST_CASE("text_layout resolves + registers OS families from the spec", "[fonts]") {
  ensurePrimary();
  Engine& eng = Engine::instance();

  // Unknown before the first spec names it; registered synchronously by layout.
  const std::string key = "menlo";
  const bool preRegistered = eng.hasFontNamed(key.c_str(), (int)key.size());
  float wMenlo = layoutWidth(specFor("Menlo"));
  CHECK(eng.hasFontNamed(key.c_str(), (int)key.size()));
  (void)preRegistered;   // other TEST_CASEs may have probed it already

  // The named face actually shaped the text: Menlo (monospace) lays out at a
  // different width than the system UI primary.
  float wPrimary = layoutWidth(specFor(nullptr));
  CHECK(wMenlo != wPrimary);

  // Bold resolves to Menlo's true 700 face (registered under its styled key),
  // not a re-shape with the regular face.
  const std::string boldKey = text_engine::faceKey("Menlo", 700, false);
  CHECK(eng.hasFontNamed(boldKey.c_str(), (int)boldKey.size()));
  float wBold = layoutWidth(specFor("Menlo", 700));
  CHECK(wBold != wPrimary);

  // A CSS-style list falls through unknown names to a registered one.
  float wList = layoutWidth(specFor("Definitely Not A Font ZZZ, Menlo"));
  CHECK(wList == wMenlo);

  // An unknown family (after the probe fails) falls back to the primary font.
  float wUnknown = layoutWidth(specFor("Definitely Not A Font ZZZ"));
  CHECK(wUnknown == wPrimary);
}

namespace {

// Like specFor, but with an italic flag and an OPTIONAL family — no family key
// at all when null (the primary-font case source.text.plain emits for a blank
// Font, which still carries weight/italic).
std::string specStyled(const char* family, int weight, bool italic) {
  char buf[512];
  int n = std::snprintf(buf, sizeof(buf), "{\"text\":\"Hamburgefonstiv\",\"runs\":[{");
  if (family && family[0])
    n += std::snprintf(buf + n, sizeof(buf) - n, "\"family\":\"%s\",", family);
  n += std::snprintf(buf + n, sizeof(buf) - n,
      "\"weight\":%d,\"italic\":%s,\"size_px\":48,\"rgba\":[1,1,1,1]}]}",
      weight, italic ? "true" : "false");
  return std::string(buf, (size_t)n);
}

// Ink slant of a CPU-rasterized layout: mean lit-x of the ink's top third minus
// its bottom third — a faux-oblique shear leans glyph tops rightward.
double rasterSlant(const std::string& spec) {
  int id = text_layout(spec.c_str(), (int)spec.size());
  REQUIRE(id > 0);
  text_engine::Metrics m;
  REQUIRE(Engine::instance().measure(id, m));
  const int W = (int)m.width + 32, H = (int)m.height + 32;
  std::vector<uint8_t> px((size_t)W * H * 4, 0);
  REQUIRE(Engine::instance().rasterize(id, W, H, 16.0f, 16.0f, nullptr, px.data()));
  Engine::instance().release(id);
  // rasterize() composites onto an opaque-black background (alpha 255
  // everywhere) — ink is detected by luminance, not alpha.
  auto isInk = [&](int x, int y) { return px[((size_t)y * W + x) * 4] > 100; };
  int inkTop = H, inkBot = -1;
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++)
      if (isInk(x, y)) {
        if (y < inkTop) inkTop = y;
        if (y > inkBot) inkBot = y;
      }
  double xTop = 0, xBot = 0; long nTop = 0, nBot = 0;
  const int third = (inkBot - inkTop + 1) / 3;
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++) {
      if (!isInk(x, y)) continue;
      if (y < inkTop + third) { xTop += x; ++nTop; }
      if (y > inkBot - third) { xBot += x; ++nBot; }
    }
  return (nTop && nBot) ? xTop / nTop - xBot / nBot : 0.0;
}

}  // namespace

TEST_CASE("layout synthesizes bold/italic when no true styled face exists", "[fonts]") {
  ensurePrimary();

  // Primary font (no family in the spec — a blank Font in source.text.plain):
  // weight 700 must WIDEN the layout, because synthetic embolden also widens
  // each glyph's advance. Formerly weight/italic silently did nothing here.
  float w400 = layoutWidth(specStyled(nullptr, 400, false));
  float w700 = layoutWidth(specStyled(nullptr, 700, false));
  CHECK(w700 > w400 + 1.0f);

  // Same for a family that is not registered (falls back to the primary face).
  float u700 = layoutWidth(specStyled("Definitely Not A Font ZZZ", 700, false));
  CHECK(u700 == w700);

  // A TRUE styled face still wins with no synthesis on top: Menlo is monospace,
  // so its real bold shares advances with regular — if synthetic embolden
  // leaked in, the width would grow by 0.03 em per glyph.
  float m400 = layoutWidth(specStyled("Menlo", 400, false));
  float m700 = layoutWidth(specStyled("Menlo", 700, false));
  CHECK(m700 == m400);

  // Faux oblique on the primary font: italic must lean the ink's top rightward
  // (rasterized via the CPU golden compositor); advances stay untouched.
  double slantReg  = rasterSlant(specStyled(nullptr, 400, false));
  double slantItal = rasterSlant(specStyled(nullptr, 400, true));
  CHECK(slantItal > slantReg + 2.0);
  CHECK(layoutWidth(specStyled(nullptr, 400, true)) == w400);
}
