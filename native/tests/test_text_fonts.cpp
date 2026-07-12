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
