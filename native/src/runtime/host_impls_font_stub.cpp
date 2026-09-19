// host_impls_font_stub.cpp — the font provider on platforms with no Core Text.
//
// host_impls_font.mm resolves SYSTEM font BYTES through Core Text: the OS CJK
// fallback chain, the UI font, and exact family-name lookup. Rasterization is
// FreeType + msdfgen either way, so what is lost here is font DISCOVERY, not
// rendering, and web/native pixel parity for BUNDLED faces is unaffected.
//
// The bundled primary IS still installed, because that is the face the parity
// tests use. Text in a bundled font renders identically; text that relies on a
// system family or CJK fallback does not resolve.
//
// The Windows implementation is DirectWrite — IDWriteFontCollection for family
// lookup, IDWriteFontFallback for the CJK chain, and
// IDWriteFontFace::TryGetFontTable to rebuild a standalone sfnt from a .ttc,
// mirroring sfntFromCTFont. Out of scope while the port is engine-only.

#include "runtime/text_host.h"

#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace effect_runtime {
namespace {

std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.good()) return {};
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)),
                              std::istreambuf_iterator<char>());
}

// It is not only *missing* families that this costs. The layout engine resolves
// its own font stack through the same provider, so without one the LINE METRICS
// differ too: "Hello Hamburg" at size 40 lays out 267.4 px wide with a 39.1 px
// first baseline on macOS and 282.3 / 34.8 here, from the same default.ttf. Ink
// therefore lands a few pixels higher and wider, which is enough to move any
// measurement taken off the ink's extents — test_effect_render's faux-oblique
// slant check is the one that notices. The GLYPHS themselves are right; the box
// they are laid into is not.
void warnOnce() {
  static bool warned = false;
  if (warned) return;
  warned = true;
  std::fprintf(stderr,
      "[text] no system font provider on this platform — bundled faces work, "
      "but OS family lookup and the CJK fallback chain do not (DirectWrite is "
      "not wired up yet)\n");
  std::fflush(stderr);
}

}  // namespace

std::vector<OsFace> textResolveOsFamily(const char* family) {
  (void)family;
  warnOnce();
  // Empty means "family not installed". That is the same answer Core Text's
  // path gives for a missing family, and callers already handle it — silent
  // substitution is rejected there too.
  return {};
}

void textInstallSystemFallbacks() { warnOnce(); }

bool textInstallSystemPrimary() {
  warnOnce();
  return false;
}

void textInstallDefaultFonts(const char* primaryPath) {
  // Same idempotence contract as the Core Text version: re-installing would
  // append a second copy of every face to Blitz while setFont only replaces
  // face 0, desyncing the lock-step face indices.
  if (textFontsReady()) return;
  if (primaryPath && primaryPath[0]) {
    std::vector<uint8_t> bytes = readFile(primaryPath);
    if (!bytes.empty()) {
      textInstallPrimaryFont(bytes.data(), (int)bytes.size());
      return;
    }
  }
  warnOnce();
}

}  // namespace effect_runtime
