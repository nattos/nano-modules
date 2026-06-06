// host_impls_font.mm — native (Core Text) font provider for the text.* service.
//
// The host text engine needs font BYTES (it shapes/rasterizes with FreeType +
// msdfgen, never the OS rasterizer — that's what keeps it byte-parity with the
// web). This file resolves sfnt bytes from two sources and installs them via
// the text_host.h lock-step installers:
//
//   * a PRIMARY face — a bundled file (e.g. NanoBarrel.bundle's default.ttf, for
//     Latin pixel-parity with the web), or, if none is given, the system UI font.
//   * SYSTEM FALLBACKS — the OS's preferred faces for CJK (and anything the
//     primary lacks), found via CTFontCreateForString on sample strings. These
//     are NOT byte-parity with the web's bundled Noto CJK (the user opted for a
//     small bundle + system fallback), so CJK renders but isn't guaranteed
//     pixel-identical; Latin via the bundled primary stays parity-exact.

#import <CoreText/CoreText.h>
#import <Foundation/Foundation.h>

#include "runtime/text_host.h"

#include <cstdint>
#include <string>
#include <vector>

namespace {

std::vector<uint8_t> readFile(const std::string& path) {
  std::vector<uint8_t> out;
  if (FILE* f = std::fopen(path.c_str(), "rb")) {
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
    if (n > 0) { out.resize(n); if (std::fread(out.data(), 1, n, f) != (size_t)n) out.clear(); }
    std::fclose(f);
  }
  return out;
}

// The sfnt file backing `font` (system fonts live in readable files under
// /System/Library/Fonts). Returns "" if the URL can't be resolved.
std::string fontFilePath(CTFontRef font) {
  if (!font) return "";
  CFURLRef url = (CFURLRef)CTFontCopyAttribute(font, kCTFontURLAttribute);
  if (!url) return "";
  char buf[2048] = {0};
  std::string path;
  if (CFURLGetFileSystemRepresentation(url, true, (UInt8*)buf, sizeof(buf)))
    path = buf;
  CFRelease(url);
  return path;
}

// The OS's substitute font file for `sample` (e.g. a CJK string), starting from
// a plain Latin base font. Empty if Core Text returns no substitute.
std::string systemFallbackPath(NSString* sample) {
  CTFontRef base = CTFontCreateWithName(CFSTR("Helvetica"), 14.0, nullptr);
  if (!base) return "";
  CTFontRef sub = CTFontCreateForString(base, (CFStringRef)sample,
                                        CFRangeMake(0, (CFIndex)sample.length));
  std::string path = sub ? fontFilePath(sub) : "";
  if (sub) CFRelease(sub);
  CFRelease(base);
  return path;
}

}  // namespace

namespace effect_runtime {

// Install the OS's preferred CJK faces as the fallback chain (tagged by region
// so shared Han picks the right glyph forms). Dedups by file path — PingFang
// covers both Hans/Hant from one .ttc, so it's installed once.
void textInstallSystemFallbacks() {
  struct Probe { const char* lang; NSString* sample; };
  Probe probes[] = {
    {"ja",      @"あ日"},   // Hiragino
    {"ko",      @"한국"},   // Apple SD Gothic Neo
    {"zh-Hans", @"汉字"},   // PingFang SC
    {"zh-Hant", @"繁體"},   // PingFang TC
  };
  std::vector<std::string> seen;
  for (const auto& p : probes) {
    std::string path = systemFallbackPath(p.sample);
    if (path.empty()) continue;
    bool dup = false;
    for (const auto& s : seen) if (s == path) { dup = true; break; }
    if (dup) continue;
    std::vector<uint8_t> bytes = readFile(path);
    if (bytes.empty()) continue;
    if (textInstallFallbackFont(bytes.data(), (int)bytes.size(),
                                p.lang, (int)std::strlen(p.lang)) >= 0) {
      seen.push_back(path);
    }
  }
}

// Install the system UI font as the PRIMARY face. Used when no bundled primary
// is available (the bundled default.ttf is the preferred, parity-exact primary).
bool textInstallSystemPrimary() {
  CTFontRef sys = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, 14.0, nullptr);
  std::string path = fontFilePath(sys);
  if (sys) CFRelease(sys);
  if (path.empty()) return false;
  std::vector<uint8_t> bytes = readFile(path);
  if (bytes.empty()) return false;
  textInstallPrimaryFont(bytes.data(), (int)bytes.size());
  return true;
}

// One-shot bootstrap for an FFGL/host with no env config: install `primaryPath`
// (a bundled face) if it loads, else the system UI font, then the system CJK
// fallback chain. Safe to call once at plugin init.
void textInstallDefaultFonts(const char* primaryPath) {
  bool havePrimary = false;
  if (primaryPath && primaryPath[0]) {
    std::vector<uint8_t> bytes = readFile(primaryPath);
    if (!bytes.empty()) {
      textInstallPrimaryFont(bytes.data(), (int)bytes.size());
      havePrimary = true;
    }
  }
  if (!havePrimary) textInstallSystemPrimary();
  textInstallSystemFallbacks();
}

}  // namespace effect_runtime
