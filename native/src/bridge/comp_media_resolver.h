// comp_media_resolver.h — installs the comp document model's media hook.
//
// `clip.source.url` is runtime-only (an object URL the web store rebuilds, and
// `serializeComposition` strips it), so a `.nano-arr` read off disk carries
// only its persistent bindings:
//   - `clip.source.file = {abs, rel?}` — where the desktop app saw the file;
//   - `clip.source.ref  = {libraryId, path[], libraryLabel?}` — the web's
//     library-relative binding.
// Without this, every video clip in such a document parses as effect-only: no
// video desc, no content stream, nothing for a pump to decode.
//
// `file.rel` (relative to the document's folder) is not tried: the executor
// is handed JSON, not a file, so there is no folder to resolve it against.
//
// The comp model can't do the lookup itself — it is dual-compiled into
// executor.wasm, which has no filesystem — so it takes a resolver from the
// host (comp::setMediaRefResolver). This is that host half, kept out of
// src/sketch/comp/ for exactly that reason.
//
// The resolver hands back an ABSOLUTE PATH, not a URL: the native pump opens
// files, it doesn't fetch. Web keeps handing the engine a blob: url and never
// installs a resolver at all.

#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "library_paths.h"
#include "../sketch/comp/comp_model.h"

namespace nano_assets {

/// The resolution itself: `file.abs` when it's there, else the library ref.
inline std::string resolveMediaSource(const nlohmann::json& source) {
  if (!source.is_object()) return std::string();
  if (source.contains("file") && source["file"].is_object()) {
    const auto& f = source["file"];
    if (f.contains("abs") && f["abs"].is_string()) {
      const std::string abs = f["abs"].get<std::string>();
      if (nano_paths::fileExists(abs)) return abs;
    }
  }
  if (source.contains("ref")) {
    auto path = LibraryPaths::instance().resolveRef(source["ref"]);
    if (path) return *path;
  }
  return std::string();
}

/**
 * Point the comp document model at resolveMediaSource. Call once at host
 * startup, before any document is parsed.
 *
 * A `ref` resolves against LibraryPaths' CURRENT roots, so a document parsed
 * before the roots arrive resolves to nothing — reload it once they land
 * (BarrelRuntime persists them to a sidecar precisely so a headless restart
 * has them up front).
 */
inline void installLibraryMediaResolver() {
  comp::setMediaRefResolver(&resolveMediaSource);
}

}  // namespace nano_assets
