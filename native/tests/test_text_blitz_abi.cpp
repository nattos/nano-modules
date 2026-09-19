// test_text_blitz_abi.cpp — does the Rust layout library actually work here?
//
// text_blitz is Stylo + Taffy + parley behind eleven C functions. It was the
// one dependency expected to block the Windows port outright, on the theory
// that Stylo on the mingw ABI would not cross-compile. It does: the staticlib
// builds for x86_64-pc-windows-gnu from macOS, given a dlltool and a linker
// under the names Rust looks for.
//
// So this test exists to prove the thing RUNS, not merely links — a Rust
// staticlib that resolves its symbols can still fall over on first call if the
// ABI or the runtime is wrong. It drives the real cascade: parse HTML, run the
// Stylo cascade, lay out with Taffy, shape with parley against OUR font bytes,
// and hand back pre-shaped glyph runs.
//
// Deliberately asserts RELATIONSHIPS, not exact advances. Shaping is
// floating-point and this runs through a translation layer under CrossOver;
// pinning byte-exact positions here would be pinning the emulator.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "text/text_blitz.h"

namespace {

std::vector<uint8_t> readFile(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  if (!f.good()) return {};
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)),
                              std::istreambuf_iterator<char>());
}

}  // namespace

TEST_CASE("text_blitz lays out HTML with our own font bytes", "[text_blitz]") {
  // NANO_TEST_FONT overrides the compiled-in path, which is a build-host path
  // and means nothing to a cross-built binary running under wine.
  const char* env = std::getenv("NANO_TEST_FONT");
  const std::vector<uint8_t> font =
      readFile(env && *env ? env : NANO_DEFAULT_FONT_PATH);
  if (font.empty()) {
    SKIP("no default.ttf staged — run web/scripts/fetch_fonts.sh");
  }

  TbSession* s = tb_create();
  REQUIRE(s != nullptr);

  const std::string family = "Nano";
  const int face = tb_add_font(s, (const unsigned char*)family.data(),
                               (int)family.size(), /*weight*/ 0, /*italic*/ 0,
                               font.data(), (int)font.size());
  REQUIRE(face >= 0);

  // Two spans at different sizes, so the result cannot be right by accident:
  // a layout that ignored CSS entirely would give both runs the same metrics.
  const std::string html =
      "<div style='font-family:Nano'>"
      "<span style='font-size:32px'>Hamburg</span>"
      "<span style='font-size:16px'>Hamburg</span>"
      "</div>";

  TbLayout* r = tb_layout(s, (const unsigned char*)html.data(),
                          (int)html.size(), 512, 256, 1.0f);
  REQUIRE(r != nullptr);

  const int n = tb_glyph_count(r);
  std::printf("[text_blitz] %d glyphs from %zu bytes of HTML\n", n,
              html.size());
  std::fflush(stdout);
  // "Hamburg" twice = 14 glyphs if nothing is dropped or ligated away.
  REQUIRE(n >= 12);

  const text_engine::PreGlyph* g = tb_glyph_ptr(r);
  REQUIRE(g != nullptr);

  // Every glyph must resolve to the one face we registered. A glyph pointing
  // at a face we never added means the lock-step face indexing between Blitz
  // and the engine has drifted, which renders as blank text rather than an
  // error.
  for (int i = 0; i < n; ++i) REQUIRE(g[i].face == face);

  // The 32px run has to be bigger than the 16px run. Compare the widest glyph
  // in each half rather than a specific advance.
  float firstMax = 0.0f, secondMax = 0.0f;
  for (int i = 0; i < n; ++i) {
    const float sz = g[i].size;
    if (i < n / 2) { if (sz > firstMax) firstMax = sz; }
    else           { if (sz > secondMax) secondMax = sz; }
  }
  std::printf("[text_blitz] max size: first run %.1f, second run %.1f\n",
              firstMax, secondMax);
  std::fflush(stdout);
  CHECK(firstMax > secondMax);

  tb_free_layout(r);
  tb_destroy(s);
}
