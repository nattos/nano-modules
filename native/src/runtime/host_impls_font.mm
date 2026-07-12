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
//   * NAMED FAMILIES — textResolveOsFamily resolves a family a text spec names
//     (the `font` param) to ALL of its installed faces, the counterpart of the
//     web's Local Font Access path (font-access.ts). Faces living in a .ttc are
//     extracted into standalone sfnts (FreeType would otherwise always open
//     collection member 0), so styled faces of collection fonts resolve too.

#import <CoreText/CoreText.h>
#import <Foundation/Foundation.h>

#include "runtime/text_host.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
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

// --- Named-family resolution (textResolveOsFamily) --------------------------

// CT weight trait (normalized, 0 = regular, 0.4 ≈ bold) → CSS weight bucket.
// Thresholds are midpoints between AppKit's NSFontWeight* constants, mirroring
// inferWeight() in web/src/font-access.ts in spirit (there: name keywords).
int cssWeightFromTrait(float t) {
  if (t <= -0.7f) return 100;
  if (t <= -0.5f) return 200;
  if (t <= -0.2f) return 300;
  if (t <  0.115f) return 400;
  if (t <  0.265f) return 500;
  if (t <  0.35f) return 600;
  if (t <  0.48f) return 700;
  if (t <  0.59f) return 800;
  return 900;
}

constexpr uint32_t kTagTtcf = 0x74746366;  // 'ttcf'
constexpr uint32_t kTagCff  = 0x43464620;  // 'CFF '
constexpr uint32_t kTagHead = 0x68656164;  // 'head'

// Big-endian uint32 checksum over `n` bytes (zero-padded to a 4-byte multiple).
uint32_t sfntChecksum(const uint8_t* p, size_t n) {
  uint32_t sum = 0;
  for (size_t i = 0; i < n; i += 4) {
    uint32_t v = 0;
    for (int b = 0; b < 4; b++) v = (v << 8) | (i + b < n ? p[i + b] : 0);
    sum += v;
  }
  return sum;
}

void putU32(std::vector<uint8_t>& v, size_t at, uint32_t x) {
  v[at] = (uint8_t)(x >> 24); v[at + 1] = (uint8_t)(x >> 16);
  v[at + 2] = (uint8_t)(x >> 8); v[at + 3] = (uint8_t)x;
}
void putU16(std::vector<uint8_t>& v, size_t at, uint16_t x) {
  v[at] = (uint8_t)(x >> 8); v[at + 1] = (uint8_t)x;
}

// Reassemble a standalone sfnt from a CTFont's tables. Used for faces inside a
// .ttc: FreeType's FT_New_Memory_Face on raw collection bytes always opens
// member 0, so e.g. bold or a non-first family in the collection would resolve
// to the wrong face. Copying the matched face's tables and rebuilding the
// header/directory (offsets, per-table checksums, head checkSumAdjustment)
// yields a single-face font both FreeType and the Blitz stack open correctly.
std::vector<uint8_t> sfntFromCTFont(CTFontRef font) {
  std::vector<uint8_t> out;
  CFArrayRef tags = CTFontCopyAvailableTables(font, kCTFontTableOptionNoOptions);
  if (!tags) return out;
  struct Table { uint32_t tag; CFDataRef data; };
  std::vector<Table> tables;
  bool cff = false;
  for (CFIndex i = 0; i < CFArrayGetCount(tags); i++) {
    // The array holds raw CTFontTableTag values, not CFNumbers.
    uint32_t tag = (uint32_t)(uintptr_t)CFArrayGetValueAtIndex(tags, i);
    CFDataRef d = CTFontCopyTable(font, tag, kCTFontTableOptionNoOptions);
    if (!d) continue;
    if (CFDataGetLength(d) == 0) { CFRelease(d); continue; }
    if (tag == kTagCff) cff = true;
    tables.push_back({tag, d});
  }
  CFRelease(tags);
  if (tables.empty()) return out;
  // Directory entries must be sorted by tag.
  std::sort(tables.begin(), tables.end(),
            [](const Table& a, const Table& b) { return a.tag < b.tag; });

  uint16_t n = (uint16_t)tables.size();
  uint16_t entrySelector = 0;
  while ((1u << (entrySelector + 1)) <= n) entrySelector++;
  uint16_t searchRange = (uint16_t)((1u << entrySelector) * 16);

  size_t total = 12 + (size_t)n * 16;
  for (const auto& t : tables) total += ((size_t)CFDataGetLength(t.data) + 3) & ~3;
  out.assign(total, 0);

  putU32(out, 0, cff ? 0x4F54544Fu /*'OTTO'*/ : 0x00010000u);
  putU16(out, 4, n);
  putU16(out, 6, searchRange);
  putU16(out, 8, entrySelector);
  putU16(out, 10, (uint16_t)(n * 16 - searchRange));

  size_t off = 12 + (size_t)n * 16, headOff = 0;
  for (size_t i = 0; i < tables.size(); i++) {
    const uint8_t* src = CFDataGetBytePtr(tables[i].data);
    size_t len = (size_t)CFDataGetLength(tables[i].data);
    std::memcpy(out.data() + off, src, len);
    // head.checkSumAdjustment must be 0 while checksums are computed.
    if (tables[i].tag == kTagHead && len >= 12) {
      headOff = off;
      putU32(out, off + 8, 0);
    }
    size_t dir = 12 + i * 16;
    putU32(out, dir + 0, tables[i].tag);
    putU32(out, dir + 4, sfntChecksum(out.data() + off, len));
    putU32(out, dir + 8, (uint32_t)off);
    putU32(out, dir + 12, (uint32_t)len);
    off += (len + 3) & ~3;
  }
  for (const auto& t : tables) CFRelease(t.data);
  if (headOff)
    putU32(out, headOff + 8, 0xB1B0AFBAu - sfntChecksum(out.data(), out.size()));
  return out;
}

// True if the file at `path` is a font collection ('ttcf' magic).
bool isCollectionFile(const std::string& path) {
  uint8_t magic[4] = {0};
  if (FILE* f = std::fopen(path.c_str(), "rb")) {
    size_t got = std::fread(magic, 1, 4, f);
    std::fclose(f);
    if (got != 4) return false;
  }
  uint32_t tag = ((uint32_t)magic[0] << 24) | ((uint32_t)magic[1] << 16) |
                 ((uint32_t)magic[2] << 8) | magic[3];
  return tag == kTagTtcf;
}

}  // namespace

namespace effect_runtime {

std::vector<OsFace> textResolveOsFamily(const char* family) {
  std::vector<OsFace> out;
  if (!family || !family[0]) return out;
  NSString* fam = [NSString stringWithUTF8String:family];
  if (!fam) return out;

  CTFontDescriptorRef want = CTFontDescriptorCreateWithAttributes(
      (CFDictionaryRef)@{(id)kCTFontFamilyNameAttribute : fam});
  if (!want) return out;
  // Mandatory family attribute: only descriptors whose family ACTUALLY matches
  // are returned — without this Core Text substitutes a default font for an
  // unknown name, and we'd register the wrong bytes under it forever.
  CFSetRef mandatory = CFSetCreate(nullptr, (const void*[]){kCTFontFamilyNameAttribute},
                                   1, &kCFTypeSetCallBacks);
  CFArrayRef matches = CTFontDescriptorCreateMatchingFontDescriptors(want, mandatory);
  CFRelease(mandatory);
  CFRelease(want);
  if (!matches) return out;

  struct Cand { int weight; bool italic, condensed; CTFontDescriptorRef desc; };
  std::vector<Cand> cands;
  constexpr CFIndex kMaxFaces = 24;  // bound memory for pathological families
  for (CFIndex i = 0; i < CFArrayGetCount(matches) && (CFIndex)cands.size() < kMaxFaces; i++) {
    auto desc = (CTFontDescriptorRef)CFArrayGetValueAtIndex(matches, i);
    int weight = 400; bool italic = false, condensed = false;
    if (CFDictionaryRef traits =
            (CFDictionaryRef)CTFontDescriptorCopyAttribute(desc, kCTFontTraitsAttribute)) {
      if (CFNumberRef w = (CFNumberRef)CFDictionaryGetValue(traits, kCTFontWeightTrait)) {
        float t = 0; CFNumberGetValue(w, kCFNumberFloatType, &t);
        weight = cssWeightFromTrait(t);
      }
      if (CFNumberRef sym = (CFNumberRef)CFDictionaryGetValue(traits, kCTFontSymbolicTrait)) {
        int32_t s = 0; CFNumberGetValue(sym, kCFNumberSInt32Type, &s);
        italic = (s & kCTFontTraitItalic) != 0;
        condensed = (s & (kCTFontTraitCondensed | kCTFontTraitExpanded)) != 0;
      }
      CFRelease(traits);
    }
    cands.push_back({weight, italic, condensed, desc});
  }
  // Normal-width faces first: faces registering into the same CSS weight bucket
  // collide on one face key, and first-registered wins (matches the web path's
  // first-wins registration) — the plain face should be that winner.
  std::stable_sort(cands.begin(), cands.end(),
                   [](const Cand& a, const Cand& b) { return !a.condensed && b.condensed; });

  for (const Cand& c : cands) {
    CTFontRef font = CTFontCreateWithFontDescriptor(c.desc, 12.0, nullptr);
    if (!font) continue;
    std::string path = fontFilePath(font);
    std::vector<uint8_t> bytes;
    if (!path.empty() && !isCollectionFile(path)) bytes = readFile(path);
    if (bytes.empty()) bytes = sfntFromCTFont(font);  // .ttc member (or odd container)
    CFRelease(font);
    if (bytes.empty()) continue;
    out.push_back({c.weight, c.italic, std::move(bytes)});
  }
  CFRelease(matches);
  return out;
}

}  // namespace effect_runtime

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
  // Idempotent: the engine and the Blitz session are process-global singletons,
  // but a host may construct several plugin instances (FFGL prototype scan +
  // each layer instance), each calling this. Re-installing would APPEND a second
  // copy of every face to Blitz (tb_add_font) while the engine's setFont only
  // REPLACES face 0 — desyncing the lock-step face indices, so e.g. bold text
  // (which resolves to a duplicate Blitz face the engine never got) shapes
  // against the wrong font and renders blank. Install exactly once per process.
  if (textFontsReady()) return;
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
