#pragma once
// text_host.h — host-side bootstrap for the native `text.*` service.
//
// The six `text_*` host imports (host_impls_text.cpp) drive the shared CPU text
// engine (text_engine.h) + the Blitz HTML/CSS layout lib (text_blitz.h) and
// composite through the active GPUBackend. Before any layout call, fonts must be
// installed into BOTH the engine and the persistent Blitz session in lock-step
// (engine faceId N must equal Blitz faceId N, so GIDs agree).
//
// The FFGL plugin / CLI host calls these once at startup with font bytes it
// resolved (bundled faces for parity, or Core Text). If nothing is installed by
// the first layout call, the service lazily bootstraps from the TE_FONT /
// TE_FALLBACK environment variables (the same convention as the blitz_dump /
// blitz_metal tools), so tests and tools work with no extra wiring.

#include <cstdint>
#include <vector>

namespace effect_runtime {

// Install the PRIMARY font (engine face 0 + Blitz faceId 0). Resets the engine
// atlas/registry. Marks the font set ready (suppresses env-var bootstrap).
void textInstallPrimaryFont(const uint8_t* bytes, int len);

// Append a fallback face to BOTH the engine's fallback chain and the Blitz
// session, in lock-step. `lang` (ja/ko/zh-Hant/zh-Hans, may be null) tags its
// region for regional Han selection. Returns the faceId (>=0) or -1.
int textInstallFallbackFont(const uint8_t* bytes, int len,
                            const char* lang, int lang_len);

// Default language (system locale) for runs/specs without their own `lang`.
void textSetDefaultLang(const char* lang, int lang_len);

// True once a primary font is installed (explicitly or via env bootstrap).
bool textFontsReady();

// One installed OS face of a family: its CSS-style weight (100–900), italic
// flag, and standalone sfnt bytes (a face living in a .ttc is extracted into
// its own single-face sfnt, so FreeType/fontique open exactly the matched face).
struct OsFace {
  int weight = 400;
  bool italic = false;
  std::vector<uint8_t> bytes;
};

// --- Core Text provider (host_impls_font.mm, macOS) -------------------------
// One-shot bootstrap for a host with no env config (the FFGL plugin): install
// `primaryPath` (a bundled face, for Latin parity) if it loads, else the system
// UI font, then the OS's CJK fallback chain. Pass nullptr to skip the bundled
// primary and use the system UI font.
void textInstallDefaultFonts(const char* primaryPath);
// Install the OS's preferred CJK faces (ja/ko/zh-Hans/zh-Hant) as fallbacks.
void textInstallSystemFallbacks();
// Install the system UI font as the primary face. Returns false on failure.
bool textInstallSystemPrimary();
// Every installed face of `family` (exact family-name match, case-insensitive;
// empty if the family isn't installed — Core Text's silent substitution is
// rejected). Normal-width faces are ordered before condensed/expanded ones so
// the plain face wins a CSS-weight-bucket collision. This is the native
// counterpart of the web's Local Font Access resolution (font-access.ts).
std::vector<OsFace> textResolveOsFamily(const char* family);

}  // namespace effect_runtime
