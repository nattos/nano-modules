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

}  // namespace effect_runtime
